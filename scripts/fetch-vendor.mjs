#!/usr/bin/env node
// Downloads static FFmpeg builds into vendor/<platform>. Run once before the
// first build:
//   npm run vendor:win
//   npm run vendor:mac
//   npm run vendor:mac -- --intel

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const platform = process.argv.includes('--mac') ? 'mac' : 'win';
const force = process.argv.includes('--force');
const macArch = process.argv.includes('--intel') || process.arch === 'x64' ? 'amd64' : 'arm64';

const target = path.join(root, 'vendor', platform);
const probeFile = path.join(target, platform === 'win' ? 'ffmpeg.exe' : 'ffmpeg');

async function download(url, file) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`cannot download ${url}: HTTP ${response.status}`);
  fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  return fs.statSync(file).size;
}

// The gpl-shared build keeps encoders in shared DLLs, so ffmpeg and ffprobe
// together are much smaller than two static binaries.
async function fetchWindows(tmpDir) {
  const url =
    'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl-shared.zip';
  const archive = path.join(tmpDir, 'ffmpeg.zip');

  console.log('Downloading FFmpeg for Windows...');
  const size = await download(url, archive);
  console.log(`Downloaded ${(size / 1024 / 1024).toFixed(1)} MB, unpacking...`);

  execFileSync('unzip', ['-q', '-o', archive, '-d', tmpDir], { stdio: 'inherit' });

  const unpacked = fs.readdirSync(tmpDir).find((name) => name.startsWith('ffmpeg-'));
  const binDir = path.join(tmpDir, unpacked, 'bin');
  if (!fs.existsSync(binDir)) throw new Error('no bin folder inside the archive');

  // ffplay is unused and drags in extra weight.
  for (const name of fs.readdirSync(binDir)) {
    if (name.toLowerCase().startsWith('ffplay')) continue;
    fs.copyFileSync(path.join(binDir, name), path.join(target, name));
  }

  const license = path.join(tmpDir, unpacked, 'LICENSE.txt');
  if (fs.existsSync(license)) fs.copyFileSync(license, path.join(target, 'FFMPEG-LICENSE.txt'));
}

// macOS builds ship as separate self-contained binaries, not as one archive.
async function fetchMac(tmpDir) {
  console.log(`Downloading FFmpeg for macOS (${macArch})...`);

  for (const name of ['ffmpeg', 'ffprobe']) {
    const url = `https://ffmpeg.martin-riedl.de/redirect/latest/macos/${macArch}/release/${name}.zip`;
    const archive = path.join(tmpDir, `${name}.zip`);
    const size = await download(url, archive);
    console.log(`  ${name}: ${(size / 1024 / 1024).toFixed(1)} MB`);
    execFileSync('unzip', ['-q', '-o', archive, '-d', tmpDir], { stdio: 'inherit' });

    const binary = path.join(target, name);
    fs.copyFileSync(path.join(tmpDir, name), binary);
    fs.chmodSync(binary, 0o755);
  }
}

async function main() {
  if (fs.existsSync(probeFile) && !force) {
    console.log(`FFmpeg for ${platform} is already in place. Re-download with -- --force`);
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mts-vendor-'));
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });

  try {
    if (platform === 'win') await fetchWindows(tmpDir);
    else await fetchMac(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  if (platform === 'mac') {
    const encoders = execFileSync(probeFile, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
    if (!encoders.includes('libx264')) {
      throw new Error('this build has no libx264, so re-encoding would not work');
    }
  }

  const files = fs.readdirSync(target);
  const total = files.reduce((sum, f) => sum + fs.statSync(path.join(target, f)).size, 0);
  console.log(`Done: ${files.length} files, ${(total / 1024 / 1024).toFixed(0)} MB in vendor/${platform}`);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
