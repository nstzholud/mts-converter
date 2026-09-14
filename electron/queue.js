'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const ffmpeg = require('./ffmpeg');

const CORES = os.cpus().length || 4;

// Writes to a temporary file and renames only after verification passes.
class ConversionQueue extends EventEmitter {
  constructor(binaries) {
    super();
    this.binaries = binaries;
    this.jobs = [];
    this.running = new Map(); // id -> { cancel }
    this.active = false;
    this.stopRequested = false;
    this.settings = null;
    this.logLines = [];
  }

  get isRunning() {
    return this.active;
  }

  async start(jobs, settings) {
    if (this.active) throw new Error('Конвертация уже идёт');

    this.jobs = jobs;
    this.settings = settings;
    this.active = true;
    this.stopRequested = false;
    this.logLines = [`Run started ${new Date().toISOString()}`, ''];

    const pending = jobs.filter((j) => j.status === 'pending');
    const concurrency = this._concurrencyFor(pending);
    this.emit('started', { total: pending.length, concurrency });

    const queue = [...pending];
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, () =>
      this._worker(queue),
    );
    await Promise.all(workers);

    this.active = false;
    const summary = {
      done: this.jobs.filter((j) => j.status === 'done').length,
      failed: this.jobs.filter((j) => j.status === 'error').length,
      skipped: this.jobs.filter((j) => j.status === 'skipped').length,
      cancelled: this.jobs.filter((j) => j.status === 'cancelled').length,
      total: pending.length,
    };
    await this._writeLog();
    this.emit('finished', summary);
    return summary;
  }

  // Copying is disk-bound so several files can run at once, while encoding
  // already saturates every core and more than two jobs only slows things down.
  _concurrencyFor(jobs) {
    const anyEncode = jobs.some((job) => job.plannedMode !== 'copy');
    return anyEncode
      ? Math.max(1, Math.min(2, Math.floor(CORES / 4)))
      : Math.max(2, Math.min(4, CORES));
  }

  async _worker(queue) {
    while (queue.length) {
      if (this.stopRequested) {
        for (const job of queue.splice(0)) {
          this._update(job, { status: 'cancelled' });
        }
        return;
      }
      const job = queue.shift();
      await this._process(job);
    }
  }

  async _process(job) {
    const settings = this.settings;
    this._update(job, { status: 'running', progress: 0, speed: null, stage: 'Конвертация' });

    const tempPath = `${job.output}.part`;
    try {
      await fsp.mkdir(path.dirname(job.output), { recursive: true });
      await fsp.rm(tempPath, { force: true });

      const { args, mode, audioPlan } = ffmpeg.buildArgs({
        input: job.input,
        output: tempPath,
        info: job.info,
        settings,
      });
      job.plannedMode = mode;
      job.audioDescription = audioPlan.description;
      job.command = args.join(' ');

      const task = ffmpeg.run(this.binaries, args, {
        duration: job.info.duration,
        onProgress: ({ fraction, speed }) => {
          const patch = {};
          if (fraction !== null) patch.progress = fraction;
          if (speed !== null) patch.speed = speed;
          this._update(job, patch);
        },
        onLog: (text) => {
          job.log = `${job.log || ''}${text}`.slice(-16_000);
        },
      });

      this.running.set(job.id, task);
      await task.promise;
      this.running.delete(job.id);

      this._update(job, { progress: 1, stage: 'Проверка' });

      const result = await ffmpeg.verifyOutput(this.binaries, {
        input: job.input,
        output: tempPath,
        mode,
        info: job.info,
        audioPlan,
      });
      job.verification = result;
      if (!result.ok) {
        throw new Error(`Проверка не прошла: ${result.problems.join('; ')}`);
      }

      const finalPath = await this._commit(tempPath, job.output, settings.overwrite);
      job.output = finalPath;
      await this._copyFileDate(job.input, finalPath);

      const stat = await fsp.stat(finalPath);
      this._update(job, {
        status: 'done',
        stage: null,
        outputSize: stat.size,
        progress: 1,
      });
      this._log(`OK     ${job.input} -> ${finalPath}`);
    } catch (err) {
      this.running.delete(job.id);
      await fsp.rm(tempPath, { force: true }).catch(() => {});
      if (err.cancelled || this.stopRequested) {
        this._update(job, { status: 'cancelled', stage: null });
        this._log(`CANCEL ${job.input}`);
      } else {
        this._update(job, { status: 'error', stage: null, error: err.message });
        this._log(`FAILED ${job.input}: ${err.message}`);
      }
    }
  }

  async _commit(tempPath, desiredPath, overwrite) {
    if (overwrite) {
      try {
        await fsp.rename(tempPath, desiredPath);
        return desiredPath;
      } catch {
        // The old file can be locked by a player; fall back to a new name
        // rather than lose the freshly converted one.
      }
    }

    const target = fs.existsSync(desiredPath) ? uniquePath(desiredPath) : desiredPath;
    await fsp.rename(tempPath, target);
    return target;
  }

  async _copyFileDate(source, target) {
    try {
      const stat = await fsp.stat(source);
      await fsp.utimes(target, stat.atime, stat.mtime);
    } catch {
      // Keeping the original date is a nice touch, not a requirement.
    }
  }

  cancelAll() {
    this.stopRequested = true;
    for (const task of this.running.values()) task.cancel();
  }

  cancelJob(id) {
    const task = this.running.get(id);
    if (task) task.cancel();
    const job = this.jobs.find((j) => j.id === id);
    if (job && job.status === 'pending') this._update(job, { status: 'cancelled' });
  }

  _update(job, patch) {
    Object.assign(job, patch);
    this.emit('job-updated', serializeJob(job));
  }

  _log(line) {
    this.logLines.push(line);
  }

  async _writeLog() {
    const dirs = new Set(this.jobs.filter((j) => j.output).map((j) => path.dirname(j.output)));
    const dir = dirs.values().next().value;
    if (!dir) return;
    const file = path.join(dir, 'conversion-log.txt');
    try {
      await fsp.appendFile(file, `${this.logLines.join('\n')}\n\n`, 'utf8');
    } catch {
      // If the folder is not writable the log is simply skipped.
    }
  }
}

function uniquePath(target) {
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  let i = 2;
  let candidate = path.join(dir, `${base} (${i})${ext}`);
  while (fs.existsSync(candidate)) {
    i += 1;
    candidate = path.join(dir, `${base} (${i})${ext}`);
  }
  return candidate;
}

function serializeJob(job) {
  return {
    id: job.id,
    input: job.input,
    output: job.output,
    name: job.name,
    relativePath: job.relativePath,
    status: job.status,
    stage: job.stage || null,
    progress: job.progress || 0,
    speed: job.speed || null,
    error: job.error || null,
    log: job.log || null,
    inputSize: job.inputSize || 0,
    outputSize: job.outputSize || 0,
    plannedMode: job.plannedMode || null,
    audioDescription: job.audioDescription || null,
    verification: job.verification || null,
    info: job.info
      ? {
          duration: job.info.duration,
          width: job.info.video.width,
          height: job.info.video.height,
          displayWidth: job.info.video.displayWidth,
          displayHeight: job.info.video.displayHeight,
          codec: job.info.video.codec,
          interlaced: job.info.video.interlaced,
          audioCodec: job.info.audio?.codec || null,
          audioChannels: job.info.audio?.channels || 0,
        }
      : null,
  };
}

module.exports = { ConversionQueue, serializeJob, uniquePath };
