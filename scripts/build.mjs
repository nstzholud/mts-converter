#!/usr/bin/env node
//   node scripts/build.mjs win          -> one-click .exe installer
//   node scripts/build.mjs mac          -> .dmg, dragged into Applications
//   node scripts/build.mjs mac --intel  -> the same for Intel Macs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const intel = process.argv.includes('--intel');

const TARGETS = {
  win: {
    title: 'Windows installer',
    binary: 'vendor/win/ffmpeg.exe',
    vendorCommand: 'npm run vendor:win',
    args: ['--win', '--x64', '--publish', 'never'],
    matches: (f) => f.startsWith('MTS-Converter-Setup') && f.endsWith('.exe'),
  },
  mac: {
    title: 'macOS disk image',
    binary: 'vendor/mac/ffmpeg',
    vendorCommand: 'npm run vendor:mac',
    // Must match the ffmpeg build in vendor/mac, or the app ends up with a
    // binary for the wrong architecture.
    args: ['--mac', intel || process.arch === 'x64' ? '--x64' : '--arm64', '--publish', 'never'],
    matches: (f) => f.startsWith('MTS-Converter-') && f.endsWith('.dmg'),
  },
};

const platform = process.argv[2];
const target = TARGETS[platform];

function fail(message, hint) {
  console.error(`\nBuild failed: ${message}`);
  if (hint) console.error(`Fix: ${hint}`);
  process.exit(1);
}

if (!target) fail(`unknown platform "${platform ?? ''}"`, 'pass win or mac');
if (platform === 'mac' && process.platform !== 'darwin') {
  fail('a macOS disk image can only be built on macOS');
}
if (!fs.existsSync(path.join(root, target.binary))) {
  fail(`${target.binary} is missing`, `run ${target.vendorCommand}`);
}

// Always regenerate so edits to the artwork are never lost.
execFileSync(process.execPath, [path.join(root, 'scripts', 'make-icon.mjs')], {
  cwd: root,
  stdio: 'inherit',
});

console.log(`\nBuilding ${target.title}...`);
try {
  // Run the JS entry directly. `node_modules/.bin/electron-builder` is a Unix
  // shim — execFileSync cannot launch it on Windows, so CI failed in 1s with
  // no builder output.
  execFileSync(
    process.execPath,
    [path.join(root, 'node_modules', 'electron-builder', 'cli.js'), ...target.args],
    {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
    },
  );
} catch (err) {
  fail('electron-builder did not finish', err.message || 'see its output above');
}

const produced = fs.readdirSync(path.join(root, 'dist')).find(target.matches);
if (!produced) fail('no artifact appeared in dist', 'see the electron-builder output above');

const file = path.join(root, 'dist', produced);
console.log(`\nDone: ${file} (${Math.round(fs.statSync(file).size / 1024 / 1024)} MB)`);
