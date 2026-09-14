#!/usr/bin/env node
// Draws the app icon: the same cat that lives in the footer. The 16x16 grid is
// scaled by whole multiples only, so pixels stay square at every size.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'build');

// K outline, P pink, D dark pink, W eye white
const ART = [
  '................',
  '.KK..........KK.',
  '.KPK........KPK.',
  '.KPPK......KPPK.',
  '.KPPPK....KPPPK.',
  '.KPPPPKKKKPPPPK.',
  '.KPPPPPPPPPPPPK.',
  '.KPWWPPPPPPWWPK.',
  '.KPWKPPPPPPKWPK.',
  '.KPPPPPDDPPPPPK.',
  '.KPPPPKPPKPPPPK.',
  '.KPPPPPKKPPPPPK.',
  '.KPPPPPPPPPPPPK.',
  '..KPPPPPPPPPPK..',
  '...KKKKKKKKKK...',
  '................',
];

const PALETTE = {
  K: [92, 42, 99, 255],
  P: [255, 95, 162, 255],
  D: [214, 61, 128, 255],
  W: [255, 246, 251, 255],
  '.': [0, 0, 0, 0],
};

const SIZES = [16, 32, 48, 64, 128, 256];

// --- PNG -------------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
}

function encodePng(size) {
  const scale = size / ART.length;
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);

  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter None: this artwork compresses well anyway
    const artRow = ART[Math.floor(y / scale)];
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = PALETTE[artRow[Math.floor(x / scale)]];
      const at = rowStart + 1 + x * 4;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
      raw[at + 3] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bits per channel
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- ICO -------------------------------------------------------------------

function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;

  images.forEach(({ size, png }, i) => {
    const at = i * 16;
    directory[at] = size === 256 ? 0 : size; // 256 is encoded as zero
    directory[at + 1] = size === 256 ? 0 : size;
    directory[at + 2] = 0; // no palette
    directory[at + 3] = 0;
    directory.writeUInt16LE(1, at + 4); // planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });

  return Buffer.concat([header, directory, ...images.map((i) => i.png)]);
}

// --- Run ---

fs.mkdirSync(outDir, { recursive: true });

const images = SIZES.map((size) => ({ size, png: encodePng(size) }));
const ico = path.join(outDir, 'icon.ico');
const png = path.join(outDir, 'icon.png');

fs.writeFileSync(ico, encodeIco(images));
fs.writeFileSync(png, images.at(-1).png);

console.log(`Icon written: ${SIZES.join(', ')} px`);
console.log(`  ${ico}`);
console.log(`  ${png}`);

// Also build .icns on macOS so local test runs show the real icon in the Dock.
if (process.platform === 'darwin') {
  const iconset = path.join(outDir, 'icon.iconset');
  fs.rmSync(iconset, { recursive: true, force: true });
  fs.mkdirSync(iconset);

  for (const base of [16, 32, 128, 256, 512]) {
    fs.writeFileSync(path.join(iconset, `icon_${base}x${base}.png`), encodePng(base));
    fs.writeFileSync(path.join(iconset, `icon_${base}x${base}@2x.png`), encodePng(base * 2));
  }

  const icns = path.join(outDir, 'icon.icns');
  try {
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', icns], { stdio: 'pipe' });
    console.log(`  ${icns}`);
  } catch (err) {
    console.warn(`  .icns skipped: ${err.message}`);
  }
  fs.rmSync(iconset, { recursive: true, force: true });
}
