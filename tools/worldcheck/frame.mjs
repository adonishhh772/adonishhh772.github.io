/**
 * Measure where the island actually lands in the frame.
 *
 * "The island is framed well" is a claim about pixels, and the only honest way
 * to check it is to look at them. This decodes the screenshot and reports the
 * bounding box of everything that is not sky or ground haze, so the subject's
 * real position and size can be compared with the region the interface leaves
 * free — instead of being guessed at from a camera distance.
 *
 * Usage: node tools/worldcheck/frame.mjs <screenshot.png> [--out dir]
 */

import { readFileSync } from 'node:fs';
import { decodePng } from './png.mjs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node tools/worldcheck/frame.mjs <screenshot.png>');
  process.exit(2);
}

const image = decodePng(file);
const { width, height, channels, data } = image;

/*
 * The background is the sky gradient, which is smooth and varies only
 * vertically. For each row, the modal colour of the leftmost and rightmost
 * columns is the sky at that height; a pixel counts as subject when it differs
 * from that by more than a threshold.
 */
function rowSky(y) {
  const samples = [];
  for (const x of [2, 3, 4, 5, 6, 7, width - 8, width - 7, width - 6, width - 5, width - 4, width - 3]) {
    const i = (y * width + x) * 4;
    samples.push([data[i], data[i + 1], data[i + 2]]);
  }
  const mean = [0, 0, 0];
  for (const s of samples) for (let c = 0; c < 3; c++) mean[c] += s[c] / samples.length;
  return mean;
}

const THRESHOLD = 22;
let minX = width;
let maxX = -1;
let minY = height;
let maxY = -1;
let count = 0;
const rowSpan = new Array(height).fill(null);

for (let y = 0; y < height; y++) {
  const sky = rowSky(y);
  let first = -1;
  let last = -1;
  for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const d =
      Math.abs(data[i] - sky[0]) + Math.abs(data[i + 1] - sky[1]) + Math.abs(data[i + 2] - sky[2]);
    if (d > THRESHOLD) {
      if (first < 0) first = x;
      last = x;
      count++;
    }
  }
  if (first >= 0) {
    rowSpan[y] = [first, last];
    minX = Math.min(minX, first);
    maxX = Math.max(maxX, last);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
}

/*
 * The biggest contiguous run of rows that are wide enough to be the island —
 * this ignores the odd caption or the sky body, which are narrow by
 * comparison.
 */
let best = { start: 0, end: 0 };
let runStart = null;
for (let y = 0; y < height; y++) {
  const span = rowSpan[y];
  const wide = span && span[1] - span[0] > width * 0.3;
  if (wide && runStart === null) runStart = y;
  if (!wide && runStart !== null) {
    if (y - runStart > best.end - best.start) best = { start: runStart, end: y };
    runStart = null;
  }
}
if (runStart !== null && height - runStart > best.end - best.start) {
  best = { start: runStart, end: height };
}

const islandWidth = Math.max(...rowSpan.filter(Boolean).map((s) => s[1] - s[0]), 0);
const islandRows = rowSpan.filter(Boolean);
const islandBBox = islandRows.length
  ? {
      x: Math.min(...islandRows.map((s) => s[0])),
      right: Math.max(...islandRows.map((s) => s[1])),
      y: best.start,
      bottom: best.end,
    }
  : null;

console.log(
  JSON.stringify(
    {
      file,
      size: { width, height },
      subject: { minX, maxX, minY, maxY, pixels: count },
      island: islandBBox
        ? {
            x: islandBBox.x,
            right: islandBBox.right,
            y: islandBBox.y,
            bottom: islandBBox.bottom,
            width: islandBBox.right - islandBBox.x,
            height: islandBBox.bottom - islandBBox.y,
            widest: islandWidth,
          }
        : null,
      margins: islandBBox
        ? {
            top: islandBBox.y,
            bottom: height - islandBBox.bottom,
            left: islandBBox.x,
            right: width - islandBBox.right,
          }
        : null,
    },
    null,
    2,
  ),
);
