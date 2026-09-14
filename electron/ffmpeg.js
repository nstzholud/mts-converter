'use strict';

const { spawn } = require('node:child_process');
const { t } = require('../renderer/i18n');

let locale = 'ru';
function setLocale(next) {
  locale = next === 'en' ? 'en' : 'ru';
}
function tx(key, vars) {
  return t(locale, key, vars);
}
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? '.exe' : '';

// x264 preset trades encoding time for file size; quality is pinned by CRF, so
// a fast preset costs nothing but a slightly larger file.
const X264_PRESET = 'fast';

// Codecs an MP4 container can hold without re-encoding.
const MP4_VIDEO_CODECS = new Set(['h264', 'hevc', 'mpeg4', 'av1']);
const MP4_AUDIO_CODECS = new Set(['aac', 'ac3', 'eac3', 'mp3', 'alac', 'opus']);

let cachedBinaries = null;

// Bundled binaries win over system ones: resources/vendor when packaged,
// ./vendor during development.
function resolveBinaries(appPath, resourcesPath) {
  if (cachedBinaries) return cachedBinaries;

  const platformDir = IS_WIN ? 'win' : 'mac';
  const candidates = [];

  for (const base of [resourcesPath, appPath].filter(Boolean)) {
    candidates.push(path.join(base, 'vendor', platformDir));
  }
  if (IS_WIN) {
    candidates.push('C:\\ffmpeg\\bin');
  } else {
    candidates.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin');
  }

  const found = { ffmpeg: null, ffprobe: null, bundled: false };
  for (const dir of candidates) {
    const ffmpeg = path.join(dir, `ffmpeg${EXE}`);
    const ffprobe = path.join(dir, `ffprobe${EXE}`);
    if (fs.existsSync(ffmpeg) && fs.existsSync(ffprobe)) {
      found.ffmpeg = ffmpeg;
      found.ffprobe = ffprobe;
      found.bundled = dir.includes('vendor');
      break;
    }
  }

  if (!found.ffmpeg) {
    found.ffmpeg = `ffmpeg${EXE}`;
    found.ffprobe = `ffprobe${EXE}`;
  }

  cachedBinaries = found;
  return found;
}

function runCapture(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || tx('err.probeFail', { code })));
    });
  });
}

async function probe(binaries, file) {
  const json = await runCapture(binaries.ffprobe, [
    '-hide_banner',
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    file,
  ]);
  const data = JSON.parse(json);
  const video = (data.streams || []).find((s) => s.codec_type === 'video');
  const audio = (data.streams || []).find((s) => s.codec_type === 'audio');
  if (!video) throw new Error(tx('err.noVideo'));

  const sar = parseRatio(video.sample_aspect_ratio) || 1;
  const width = Number(video.width) || 0;
  const height = Number(video.height) || 0;
  const fieldOrder = video.field_order || 'unknown';
  const interlaced = ['tt', 'bb', 'tb', 'bt'].includes(fieldOrder);
  const duration = Number(data.format?.duration) || Number(video.duration) || 0;

  return {
    duration,
    size: Number(data.format?.size) || 0,
    bitRate: Number(data.format?.bit_rate) || 0,
    formatName: data.format?.format_name || '',
    video: {
      codec: video.codec_name || '',
      width,
      height,
      sar,
      interlaced,
      fieldOrder,
      pixFmt: video.pix_fmt || '',
      frameRate: parseRatio(video.avg_frame_rate) || parseRatio(video.r_frame_rate) || 0,
      fieldRate: parseRatio(video.r_frame_rate) || 0,
      displayWidth: sar !== 1 ? evenRound(width * sar) : width,
      displayHeight: height,
      colorSpace: video.color_space || '',
      colorPrimaries: video.color_primaries || '',
      colorTransfer: video.color_transfer || '',
    },
    audio: audio
      ? {
          codec: audio.codec_name || '',
          channels: Number(audio.channels) || 0,
          channelLayout: audio.channel_layout || '',
          sampleRate: Number(audio.sample_rate) || 0,
          bitRate: Number(audio.bit_rate) || 0,
        }
      : null,
    audioCount: (data.streams || []).filter((s) => s.codec_type === 'audio').length,
  };
}

function parseRatio(value) {
  if (!value || typeof value !== 'string') return 0;
  const [a, b] = value.split(/[:/]/).map(Number);
  if (!b) return 0;
  return a / b;
}

function evenRound(n) {
  return Math.max(2, Math.round(n / 2) * 2);
}

function analyze(info) {
  const canCopyVideo = MP4_VIDEO_CODECS.has(info.video.codec);
  const canCopyAudio = !info.audio || MP4_AUDIO_CODECS.has(info.audio.codec);
  const notes = [];

  if (!canCopyVideo) {
    notes.push({ id: 'note.videoCodec', codec: info.video.codec.toUpperCase() });
  }
  if (!canCopyAudio) {
    notes.push({ id: 'note.audioCodec', codec: info.audio.codec.toUpperCase() });
  }
  if (info.video.interlaced) {
    notes.push({ id: 'note.interlace' });
  }
  if (info.video.sar !== 1) {
    notes.push({
      id: 'note.sar',
      width: info.video.width,
      height: info.video.height,
      displayWidth: info.video.displayWidth,
      displayHeight: info.video.displayHeight,
    });
  }

  return {
    canCopy: canCopyVideo && canCopyAudio,
    canCopyVideo,
    canCopyAudio,
    recommended: canCopyVideo && canCopyAudio ? 'copy' : 'deinterlace',
    notes,
  };
}

function buildArgs({ input, output, info, settings }) {
  const analysis = analyze(info);
  const mode = analysis.canCopy ? settings.mode : 'deinterlace';
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error'];

  args.push('-fflags', '+genpts');
  args.push('-i', input);
  args.push('-map', '0:v:0');

  const audioPlan = planAudio(info, settings, analysis);
  args.push(...audioPlan.mapArgs);

  if (mode === 'copy') {
    args.push('-c:v', 'copy');
  } else {
    args.push(...buildVideoEncodeArgs(info, settings));
  }

  args.push(...audioPlan.codecArgs);

  args.push(
    '-map_metadata', '0',
    '-map_chapters', '-1',
    '-avoid_negative_ts', 'make_zero',
    '-movflags', '+faststart',
    // Output goes to a .part file, so the container cannot be inferred.
    '-f', 'mp4',
    '-y', output,
  );

  return { args, mode, audioPlan };
}

function buildVideoEncodeArgs(info, settings) {
  const filters = [];

  if (settings.deinterlace && info.video.interlaced) {
    // send_field turns every field into its own frame: 59.94 fields -> 59.94 fps.
    filters.push('bwdif=mode=send_field:parity=auto:deint=all');
  }

  if (settings.normalizePixels && info.video.sar !== 1) {
    filters.push(`scale=${info.video.displayWidth}:${info.video.displayHeight}:flags=lanczos`);
    filters.push('setsar=1');
  }

  const args = [];
  if (filters.length) args.push('-vf', filters.join(','));

  args.push(
    '-c:v', 'libx264',
    '-preset', X264_PRESET,
    '-crf', String(settings.crf ?? 16),
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'high',
  );

  // AVCHD sources are usually untagged; pick the standard matching the resolution.
  if (!info.video.colorPrimaries || info.video.colorPrimaries === 'unknown') {
    const hd = info.video.displayHeight >= 720;
    args.push(
      '-color_primaries', hd ? 'bt709' : 'smpte170m',
      '-color_trc', hd ? 'bt709' : 'smpte170m',
      '-colorspace', hd ? 'bt709' : 'smpte170m',
    );
  }

  return args;
}

// copyIndex marks which output audio track is a byte copy of the source, so the
// verification step knows what it may compare. null means nothing was copied.
function planAudio(info, settings, analysis) {
  if (!info.audio) {
    return { mapArgs: [], codecArgs: ['-an'], description: tx('audio.none'), copyIndex: null };
  }

  const channels = info.audio.channels || 2;
  const aacBitrate = channels >= 6 ? '640k' : channels === 1 ? '128k' : '256k';
  const wanted = analysis.canCopyAudio ? settings.audio : 'aac';

  if (wanted === 'aac') {
    return {
      mapArgs: ['-map', '0:a'],
      codecArgs: ['-c:a', 'aac', '-b:a', aacBitrate],
      description: tx('audio.aac', { rate: aacBitrate }),
      copyIndex: null,
    };
  }

  if (wanted === 'both') {
    return {
      mapArgs: ['-map', '0:a:0', '-map', '0:a:0'],
      codecArgs: [
        '-c:a:0', 'aac', '-b:a:0', aacBitrate,
        '-metadata:s:a:0', locale === 'en' ? 'title=Compatible track (AAC)' : 'title=Совместимая дорожка (AAC)',
        '-c:a:1', 'copy',
        '-metadata:s:a:1', locale === 'en'
          ? `title=Original (${info.audio.codec.toUpperCase()})`
          : `title=Оригинал (${info.audio.codec.toUpperCase()})`,
        '-disposition:a:0', 'default',
      ],
      description: tx('audio.both', { rate: aacBitrate, codec: info.audio.codec.toUpperCase() }),
      copyIndex: 1,
    };
  }

  return {
    mapArgs: ['-map', '0:a'],
    codecArgs: ['-c:a', 'copy'],
    description: tx('audio.copy', { codec: info.audio.codec.toUpperCase() }),
    copyIndex: 0,
  };
}

function run(binaries, args, { duration, onProgress, onLog } = {}) {
  const fullArgs = ['-progress', 'pipe:1', '-nostats', ...args];
  let child;
  let cancelled = false;

  const promise = new Promise((resolve, reject) => {
    child = spawn(binaries.ffmpeg, fullArgs, { windowsHide: true });

    let stderr = '';
    let stdoutBuffer = '';

    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';
      let fraction = null;
      let speed = null;
      for (const line of lines) {
        const [key, value] = line.split('=');
        if (key === 'out_time_us' || key === 'out_time_ms') {
          const micros = key === 'out_time_us' ? Number(value) : Number(value) * 1000;
          if (Number.isFinite(micros) && duration > 0) {
            fraction = Math.max(0, Math.min(1, micros / 1e6 / duration));
          }
        } else if (key === 'speed') {
          const parsed = parseFloat(value);
          if (Number.isFinite(parsed)) speed = parsed;
        }
      }
      if ((fraction !== null || speed !== null) && onProgress) {
        onProgress({ fraction, speed });
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (stderr.length > 64_000) stderr = stderr.slice(-64_000);
      if (onLog) onLog(text);
    });

    child.on('error', (err) => reject(new Error(tx('err.ffmpegStart', { message: err.message }))));

    child.on('close', (code) => {
      if (cancelled) {
        const err = new Error(tx('err.cancelled'));
        err.cancelled = true;
        reject(err);
        return;
      }
      if (code === 0) {
        resolve({ stderr });
      } else {
        const err = new Error(cleanFfmpegError(stderr) || tx('err.probeFail', { code }));
        err.log = stderr;
        reject(err);
      }
    });
  });

  return {
    promise,
    cancel() {
      cancelled = true;
      if (!child || child.exitCode !== null) return;
      try {
        if (IS_WIN) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        // Already gone.
      }
    },
  };
}

const ERROR_HINTS = [
  [/No space left on device/i, 'err.noSpace'],
  [/Permission denied/i, 'err.denied'],
  [/Read-only file system/i, 'err.readonly'],
  [/Invalid data found when processing input/i, 'err.badInput'],
  [/moov atom not found/i, 'err.truncated'],
  [/Unknown encoder/i, 'err.encoder'],
  [/does not contain any stream/i, 'err.noStream'],
  [/Output file .* does not contain any stream/i, 'err.noOutStream'],
  [/could not find codec parameters/i, 'err.codecParams'],
];

function cleanFfmpegError(stderr) {
  const text = stderr || '';
  for (const [pattern, key] of ERROR_HINTS) {
    if (pattern.test(text)) return tx(key);
  }
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^\[.*\] track \d+: codec frame size is not set/.test(l));
  return lines[lines.length - 1] || '';
}

// Compares compressed payload without decoding, so it stays fast on long files.
async function streamStats(binaries, file, selector) {
  const out = await runCapture(binaries.ffprobe, [
    '-v', 'error',
    '-select_streams', selector,
    '-show_entries', 'packet=size',
    '-of', 'csv=p=0',
    file,
  ]);
  const hash = crypto.createHash('md5');
  let packets = 0;
  let bytes = 0;
  for (const line of out.split('\n')) {
    const value = parseInt(line, 10);
    if (Number.isFinite(value)) {
      packets += 1;
      bytes += value;
      // Hashing the whole size sequence, not just the sum, also catches
      // reordering and a frame lost in the middle.
      hash.update(`${value},`);
    }
  }
  return { packets, bytes, digest: hash.digest('hex') };
}

async function verifyOutput(binaries, { input, output, mode, info, audioPlan }) {
  const problems = [];
  const details = [];

  let outInfo;
  try {
    outInfo = await probe(binaries, output);
  } catch (err) {
    return { ok: false, problems: [tx('verify.unreadable', { message: err.message })], details };
  }

  const durationDelta = Math.abs(outInfo.duration - info.duration);
  if (durationDelta > 0.5) {
    problems.push(tx('verify.durationOff', { delta: durationDelta.toFixed(2) }));
  }
  details.push(tx('verify.duration', { value: formatDuration(outInfo.duration) }));

  if (info.audio && !outInfo.audio) {
    problems.push(tx('verify.noAudio'));
  }

  if (mode === 'copy') {
    const [srcVideo, outVideo] = await Promise.all([
      streamStats(binaries, input, 'v:0'),
      streamStats(binaries, output, 'v:0'),
    ]);
    if (srcVideo.digest !== outVideo.digest) {
      problems.push(tx('verify.videoDiff', {
        srcPackets: srcVideo.packets,
        srcBytes: srcVideo.bytes,
        outPackets: outVideo.packets,
        outBytes: outVideo.bytes,
      }));
    } else {
      details.push(tx('verify.videoCopy', { n: srcVideo.packets }));
    }
  } else {
    details.push(tx('verify.videoSize', { width: outInfo.video.width, height: outInfo.video.height }));
    if (outInfo.video.frameRate) {
      details.push(tx('verify.fps', { fps: outInfo.video.frameRate.toFixed(2) }));
    }
  }

  // Only a track that was copied can be compared byte for byte; a re-encoded
  // one is expected to differ.
  if (info.audio) {
    const copyIndex = audioPlan?.copyIndex ?? null;
    if (copyIndex !== null) {
      const [srcAudio, outAudio] = await Promise.all([
        streamStats(binaries, input, 'a:0'),
        streamStats(binaries, output, `a:${copyIndex}`),
      ]);
      if (srcAudio.digest !== outAudio.digest) {
        problems.push(tx('verify.audioDiff'));
      } else {
        details.push(tx('verify.audioCopy'));
      }
    } else if (outInfo.audio) {
      details.push(tx('verify.audioAac', { codec: outInfo.audio.codec.toUpperCase() }));
    }
  }

  return { ok: problems.length === 0, problems, details };
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

module.exports = {
  setLocale,
  resolveBinaries,
  probe,
  analyze,
  buildArgs,
  run,
  verifyOutput,
  formatDuration,
  MP4_VIDEO_CODECS,
  MP4_AUDIO_CODECS,
};
