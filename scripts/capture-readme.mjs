import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 9333);
const shotPath = path.join(root, 'docs/screenshots/01-start.png');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForPage(timeoutMs = 25000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // Electron is still coming up.
    }
    await wait(400);
  }
  throw new Error('Chrome DevTools endpoint did not appear');
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout: ${label}`)), ms)),
  ]);
}

async function connect(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) pending.get(message.id)(message);
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('WebSocket failed'));
  });

  const send = (method, params) =>
    new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send('Page.enable');
  await send('Runtime.enable');

  return {
    async evalJs(expression) {
      const reply = await withTimeout(
        send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
        20000,
        'eval',
      );
      if (reply.result?.exceptionDetails) {
        throw new Error(reply.result.exceptionDetails.text || 'eval failed');
      }
      return reply.result.result.value;
    },
    async shot(file) {
      let reply;
      try {
        reply = await withTimeout(
          send('Page.captureScreenshot', { format: 'png', fromSurface: false }),
          20000,
          'shot',
        );
      } catch {
        reply = await withTimeout(
          send('Page.captureScreenshot', { format: 'png', fromSurface: true }),
          15000,
          'shot-surface',
        );
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(reply.result.data, 'base64'));
      return file;
    },
    close() {
      ws.close();
    },
  };
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn('npx', ['electron', '.', `--remote-debugging-port=${PORT}`], {
  cwd: root,
  env,
  stdio: 'ignore',
});

let session;
try {
  const page = await waitForPage();
  session = await connect(page);
  await wait(1200);
  const title = await session.evalJs(`(async () => {
    await window.api.settings.patch({
      outputDir: null,
      mode: 'copy',
      audio: 'copy',
      crf: 16,
      onboarded: true,
      locale: 'en',
    });
    state.settings = await window.api.settings.get();
    applySettingsToUI();
    await refreshOutputDir();
    applyLocale();
    showScreen('main');
    const advanced = document.querySelector('#advanced');
    if (advanced) advanced.open = false;
    const tip = document.querySelector('.tip');
    if (tip) tip.hidden = true;
    return document.querySelector('.titlebar__title')?.textContent || '';
  })()`);
  console.log('title:', title);
  await wait(600);
  console.log('shot:', await session.shot(shotPath));
  await session.evalJs(`(async () => {
    await window.api.settings.patch({ locale: 'ru' });
    return 'restored';
  })()`);
} finally {
  session?.close();
  child.kill('SIGTERM');
  await wait(800);
  if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
}
