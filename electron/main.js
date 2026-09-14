'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const ffmpeg = require('./ffmpeg');
const { Settings } = require('./settings');
const { ConversionQueue, serializeJob } = require('./queue');

app.setName('Конвертер MTS');

const VIDEO_EXTENSIONS = new Set(['.mts', '.m2ts', '.m2t', '.ts', '.mp4', '.mov', '.avi', '.mpg', '.mpeg', '.m4v']);
const PRIMARY_EXTENSIONS = new Set(['.mts', '.m2ts', '.m2t', '.ts']);

let mainWindow = null;
let settings = null;
let binaries = null;
let queue = null;
const jobsById = new Map();
let jobCounter = 0;

function createWindow() {
  const bounds = settings.all.windowBounds || {};
  mainWindow = new BrowserWindow({
    width: bounds.width || 1120,
    height: bounds.height || 800,
    x: bounds.x,
    y: bounds.y,
    minWidth: 940,
    minHeight: 660,
    frame: false,
    backgroundColor: '#ffd9ec',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('close', () => {
    if (!mainWindow.isMaximized()) {
      settings.patch({ windowBounds: mainWindow.getBounds() });
    }
  });

  for (const event of ['maximize', 'unmaximize']) {
    mainWindow.on(event, () => {
      mainWindow.webContents.send('window:state', { maximized: mainWindow.isMaximized() });
    });
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  settings = new Settings(app.getPath('userData'));
  binaries = ffmpeg.resolveBinaries(app.getAppPath(), process.resourcesPath);
  queue = new ConversionQueue(binaries);

  queue.on('job-updated', (job) => mainWindow?.webContents.send('queue:job', job));
  queue.on('started', (payload) => mainWindow?.webContents.send('queue:started', payload));
  queue.on('finished', (summary) => mainWindow?.webContents.send('queue:finished', summary));

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((err) => {
  console.error('Startup failed:', err);
});

// Quitting with Cmd+Q skips window-all-closed, and an ffmpeg child outlives its
// parent — without this the machine would keep encoding after the app is gone.
app.on('before-quit', () => queue?.cancelAll());

app.on('window-all-closed', () => {
  queue?.cancelAll();
  app.quit();
});

// --- Settings ---

ipcMain.handle('settings:get', () => settings.all);
ipcMain.handle('settings:patch', (_event, partial) => settings.patch(partial));

// --- Environment ---

ipcMain.handle('app:info', async () => {
  let version = '';
  try {
    const out = await new Promise((resolve, reject) => {
      const { execFile } = require('node:child_process');
      execFile(binaries.ffmpeg, ['-version'], { windowsHide: true }, (err, stdout) =>
        err ? reject(err) : resolve(stdout),
      );
    });
    // Some builds append their homepage to the version, e.g. "9.0.1-https://...".
    const token = (out.split('\n')[0] || '').replace('ffmpeg version ', '').split(' ')[0];
    version = (token.match(/^[\w.]+/) || [token])[0];
  } catch {
    version = '';
  }
  return {
    appVersion: app.getVersion(),
    ffmpegVersion: version,
    ffmpegPath: binaries.ffmpeg,
    ffmpegBundled: binaries.bundled,
    platform: process.platform,
  };
});

// --- Window controls ---

ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('window:close', () => mainWindow?.close());

// --- File and folder pickers ---

ipcMain.handle('dialog:pickFiles', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Выберите видеофайлы',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Видео с камеры (MTS, M2TS, TS)', extensions: ['mts', 'm2ts', 'm2t', 'ts'] },
      { name: 'Все видеофайлы', extensions: ['mts', 'm2ts', 'm2t', 'ts', 'mp4', 'mov', 'avi', 'mpg', 'mpeg', 'm4v'] },
      { name: 'Все файлы', extensions: ['*'] },
    ],
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle('dialog:pickFolder', async (_event, { title } = {}) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: title || 'Выберите папку',
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});

// Never create a missing directory: the path of an unplugged drive would be
// recreated on the system disk and the output would silently go elsewhere.
async function checkWritableDir(dir) {
  if (!dir) return { ok: false, reason: 'Папка не выбрана' };
  try {
    const stat = await fsp.stat(dir);
    if (!stat.isDirectory()) return { ok: false, reason: 'Это не папка — выберите другую' };
    await fsp.access(dir, fs.constants.W_OK);
    return { ok: true, reason: null };
  } catch (err) {
    return {
      ok: false,
      reason: err.code === 'ENOENT'
        ? 'Папки больше нет — выберите другую'
        : 'В папку нельзя записывать — выберите другую',
    };
  }
}

ipcMain.handle('fs:checkDir', (_event, dir) => checkWritableDir(dir));

// --- Queue population ---

// Walks into AVCHD card layouts (BDMV/STREAM) as well as plain folders.
async function collectFiles(inputPath, depth = 0) {
  const found = [];
  let stat;
  try {
    stat = await fsp.stat(inputPath);
  } catch {
    return found;
  }

  if (stat.isFile()) {
    if (VIDEO_EXTENSIONS.has(path.extname(inputPath).toLowerCase())) {
      found.push(inputPath);
    }
    return found;
  }

  if (!stat.isDirectory() || depth > 8) return found;

  let entries;
  try {
    entries = await fsp.readdir(inputPath, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    found.push(...(await collectFiles(path.join(inputPath, entry.name), depth + 1)));
  }
  return found;
}

ipcMain.handle('files:add', async (event, paths) => {
  const roots = new Map();
  const collected = [];

  for (const inputPath of paths) {
    let stat;
    try {
      stat = await fs.promises.stat(inputPath);
    } catch {
      continue;
    }
    const root = stat.isDirectory() ? inputPath : path.dirname(inputPath);
    const files = await collectFiles(inputPath);
    for (const file of files) {
      if (!roots.has(file)) {
        roots.set(file, root);
        collected.push(file);
      }
    }
  }

  const existing = new Set([...jobsById.values()].map((j) => j.input));
  const fresh = collected.filter((f) => !existing.has(f)).sort((a, b) => a.localeCompare(b, 'ru'));

  const added = [];
  let index = 0;
  for (const file of fresh) {
    index += 1;
    event.sender.send('files:scanning', { current: index, total: fresh.length, name: path.basename(file) });

    let info = null;
    let error = null;
    try {
      info = await ffmpeg.probe(binaries, file);
    } catch (err) {
      error = err.message;
    }

    jobCounter += 1;
    const stat = await fsp.stat(file).catch(() => ({ size: 0 }));
    const job = {
      id: `job-${jobCounter}`,
      input: file,
      name: path.basename(file),
      rootDir: roots.get(file),
      relativePath: path.relative(roots.get(file), file),
      inputSize: stat.size,
      info,
      status: error ? 'error' : 'pending',
      error,
      progress: 0,
      output: null,
      analysis: info ? ffmpeg.analyze(info) : null,
      plannedMode: null,
    };
    jobsById.set(job.id, job);
    added.push({ ...serializeJob(job), analysis: job.analysis, isPrimary: PRIMARY_EXTENSIONS.has(path.extname(file).toLowerCase()) });
  }

  return { added, skipped: collected.length - fresh.length };
});

ipcMain.handle('files:remove', (_event, ids) => {
  for (const id of ids) jobsById.delete(id);
  return [...jobsById.keys()];
});

ipcMain.handle('files:clear', () => {
  jobsById.clear();
  return true;
});

// --- Conversion ---

function resolveOutputPath(job, outputDir) {
  const base = path.basename(job.input, path.extname(job.input));
  return path.join(outputDir, `${base}.mp4`);
}

ipcMain.handle('queue:existing', (_event, { ids }) => {
  const outputDir = settings.all.outputDir;
  if (!outputDir) return [];

  const names = [];
  for (const id of ids) {
    const job = jobsById.get(id);
    if (!job || !job.info) continue;
    const target = resolveOutputPath(job, outputDir);
    if (fs.existsSync(target)) names.push(path.basename(target));
  }
  return names;
});

ipcMain.handle('queue:start', async (_event, { ids, overwrite }) => {
  if (queue.isRunning) throw new Error('Конвертация уже идёт');

  const config = { ...settings.all, overwrite: Boolean(overwrite) };
  const outputDir = config.outputDir;
  const check = await checkWritableDir(outputDir);
  if (!check.ok) {
    throw new Error(outputDir ? check.reason : 'Сначала выберите папку для готовых видео');
  }

  const jobs = [];

  for (const id of ids) {
    const job = jobsById.get(id);
    if (!job || !job.info) continue;
    job.output = resolveOutputPath(job, outputDir);
    job.status = 'pending';
    job.progress = 0;
    job.error = null;
    job.speed = null;
    job.outputSize = 0;
    job.verification = null;
    job.log = '';
    job.plannedMode = job.analysis?.canCopy ? config.mode : 'deinterlace';
    jobs.push(job);
  }

  if (!jobs.length) throw new Error('Нечего конвертировать');

  // The queue only reports a job once it starts, so on a repeat run everything
  // still waiting would keep showing the previous result.
  for (const job of jobs) {
    mainWindow?.webContents.send('queue:job', serializeJob(job));
  }

  return queue.start([...jobsById.values()], config);
});

ipcMain.on('queue:cancel', () => queue?.cancelAll());
ipcMain.on('queue:cancelJob', (_event, id) => queue?.cancelJob(id));

// --- Shell helpers ---

ipcMain.handle('shell:revealFile', (_event, filePath) => {
  if (filePath && fs.existsSync(filePath)) shell.showItemInFolder(filePath);
});

ipcMain.handle('shell:openPath', (_event, target) => shell.openPath(target));

ipcMain.handle('shell:openFolderOf', (_event, filePath) => {
  const dir = filePath ? path.dirname(filePath) : null;
  if (dir && fs.existsSync(dir)) return shell.openPath(dir);
  return null;
});
