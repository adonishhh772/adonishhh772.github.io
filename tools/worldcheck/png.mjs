/**
 * Minimal PNG statistics.
 *
 * The verification suite makes claims about how the world *looks* — that
 * night is darker than day, that the stars only come out at night — and those
 * should be measured rather than eyeballed. This decodes just enough of a PNG
 * (8-bit RGB/RGBA, non-interlaced, which is what the browser emits) to give a
 * mean luminance and a per-region breakdown.
 */

import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Decode a PNG into { width, height, channels, data } (RGBA rows, unfiltered). */
export function decodePng(path) {
  const buffer = readFileSync(path);
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');

  let offset = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      colorType = body[9];
      if (depth !== 8) throw new Error(`unsupported bit depth ${depth}`);
      if (body[12] !== 0) throw new Error('interlaced PNGs are not supported');
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset += length + 12;
  }

  const channels = CHANNELS[colorType];
  if (!channels) throw new Error(`unsupported colour type ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const previous = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    const current = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? current[x - channels] : 0;
      const b = previous ? previous[x] : 0;
      const c = previous && x >= channels ? previous[x - channels] : 0;
      const value = line[x];
      current[x] =
        filter === 0
          ? value
          : filter === 1
            ? (value + a) & 0xff
            : filter === 2
              ? (value + b) & 0xff
              : filter === 3
                ? (value + ((a + b) >> 1)) & 0xff
                : (value + paeth(a, b, c)) & 0xff;
    }
  }

  return { width, height, channels, data: out };
}

/**
 * Mean luminance (0–255) over a region, given as fractions of the image, plus
 * the standard deviation, the brightest pixel and how many pixels are above a
 * threshold. The brightest pixel is what makes "are there stars?" a measurable
 * question: a sky gradient never exceeds its own top stop, but a starfield
 * puts small pixels far above it.
 */
export function luminance(png, region = {}, brightAbove = 150) {
  const left = Math.floor((region.left ?? 0) * png.width);
  const right = Math.floor((region.right ?? 1) * png.width);
  const top = Math.floor((region.top ?? 0) * png.height);
  const bottom = Math.floor((region.bottom ?? 1) * png.height);
  let total = 0;
  let square = 0;
  let count = 0;
  let max = 0;
  let bright = 0;
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const index = (y * png.width + x) * png.channels;
      const r = png.data[index];
      const g = png.channels >= 3 ? png.data[index + 1] : r;
      const b = png.channels >= 3 ? png.data[index + 2] : r;
      const value = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      total += value;
      square += value * value;
      if (value > max) max = value;
      if (value >= brightAbove) bright++;
      count++;
    }
  }
  const mean = count ? total / count : 0;
  const variance = count ? Math.max(0, square / count - mean * mean) : 0;
  return { mean, deviation: Math.sqrt(variance), max, bright, pixels: count };
}

/** Mean luminance of a single named region, for quick one-off checks. */
export function luminanceOf(path, region) {
  return luminance(decodePng(path), region);
}
