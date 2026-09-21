/**
 * Crop and magnify a PNG, without a dependency.
 *
 * Screenshots are the only honest way to judge how this world looks, and a
 * browser screenshot of a 1440×900 frame is rendered into this conversation
 * downscaled to the point where a star and a smudge are the same grey dot. This
 * takes a region and enlarges it with nearest-neighbour sampling, which is what
 * you want for judging *rendering* — a smooth filter would invent the softness
 * the crop exists to test for.
 *
 * Usage:
 *   node tools/worldcheck/crop.mjs <in.png> <out.png> <x,y,w,h> [scale]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { decodePng } from './png.mjs';

const [input, output, region, scaleArg] = process.argv.slice(2);
if (!input || !output || !region) {
  console.error('usage: node tools/worldcheck/crop.mjs <in.png> <out.png> <x,y,w,h> [scale]');
  process.exit(2);
}
const [x, y, w, h] = region.split(',').map(Number);
const scale = Number(scaleArg ?? 2);

const png = decodePng(input);
const width = Math.min(w, png.width - x);
const height = Math.min(h, png.height - y);
const outWidth = width * scale;
const outHeight = height * scale;

/* A raw RGBA scanline buffer, filtered with type 0 (none) on every row. */
const raw = Buffer.alloc(outHeight * (outWidth * 4 + 1));
for (let oy = 0; oy < outHeight; oy++) {
  const rowStart = oy * (outWidth * 4 + 1);
  raw[rowStart] = 0;
  const sy = y + Math.floor(oy / scale);
  for (let ox = 0; ox < outWidth; ox++) {
    const sx = x + Math.floor(ox / scale);
    const source = (sy * png.width + sx) * png.channels;
    const target = rowStart + 1 + ox * 4;
    raw[target] = png.data[source];
    raw[target + 1] = png.channels >= 3 ? png.data[source + 1] : png.data[source];
    raw[target + 2] = png.channels >= 3 ? png.data[source + 2] : png.data[source];
    raw[target + 3] = png.channels === 4 ? png.data[source + 3] : 255;
  }
}

function chunk(type, body) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed) >>> 0, 0);
  return Buffer.concat([length, typed, crc]);
}

let table = null;
function crc32(buffer) {
  if (!table) {
    table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let value = i;
      for (let bit = 0; bit < 8; bit++) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      table[i] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(outWidth, 0);
ihdr.writeUInt32BE(outHeight, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
writeFileSync(
  output,
  Buffer.concat([
    header,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]),
);
console.log(`${output}  ${width}×${height} at ${scale}×  (from ${input})`);
