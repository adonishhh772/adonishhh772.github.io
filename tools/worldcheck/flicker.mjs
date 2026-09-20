/**
 * Caption flicker probe.
 *
 * Records, frame by frame, what the world's caption layer actually does at the
 * campus overview and at a destination: which captions change visibility, which
 * change weight, and which move — and by how much. Built to answer "it is
 * flickering" with a measurement rather than another guess.
 *
 * Usage: node tools/worldcheck/flicker.mjs [baseUrl]
 */

import { launchBrowser, Page, sleep } from './cdp.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4331';

const MONITOR = (ms) => `(() => {
  const log = [];
  const last = new Map();
  let frames = 0;
  const start = performance.now();
  window.__flickerLog = log;
  window.__flickerFrames = 0;
  const tick = () => {
    frames++;
    window.__flickerFrames = frames;
    const t = performance.now() - start;
    for (const node of document.querySelectorAll('.world-hotspot')) {
      const key = node.dataset.worldHotspot;
      const rect = node.getBoundingClientRect();
      const state = {
        v: node.dataset.visible,
        c: node.dataset.compact,
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        w: Math.round(rect.width),
        o: Number(getComputedStyle(node).opacity).toFixed(2),
      };
      const prev = last.get(key);
      if (prev) {
        const moved = Math.abs(state.x - prev.x) > 1 || Math.abs(state.y - prev.y) > 1;
        const resized = Math.abs(state.w - prev.w) > 1;
        const faded = state.o !== prev.o;
        if (state.v !== prev.v || state.c !== prev.c || moved || resized || faded) {
          log.push({ key, t: Math.round(t), from: prev, to: state, moved, resized, faded });
        }
      }
      last.set(key, state);
    }
    if (t < ${ms}) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return true;
})()`;

const SUMMARY = `(() => {
  const log = window.__flickerLog ?? [];
  const by = {};
  for (const e of log) {
    const b = (by[e.key] ??= { changes: 0, visibility: 0, weight: 0, moved: 0, resized: 0, faded: 0, samples: [] });
    b.changes++;
    if (e.from.v !== e.to.v) b.visibility++;
    if (e.from.c !== e.to.c) b.weight++;
    if (e.moved) b.moved++;
    if (e.resized) b.resized++;
    if (e.faded) b.faded++;
    if (b.samples.length < 5) b.samples.push(e);
  }
  return { frames: window.__flickerFrames, total: log.length, by };
})()`;

const browser = await launchBrowser({ port: 9351, size: { width: 1440, height: 900 } });
const page = await Page.open(browser.webSocketDebuggerUrl);

const ready = async () => {
  await page.waitFor(`document.querySelector('[data-world]')?.dataset.worldState === 'ready'`, {
    timeout: 60000,
    label: 'world ready',
  });
  await sleep(1200);
};

const report = (label, summary) => {
  console.log(`\n=== ${label} === frames=${summary.frames} changes=${summary.total}`);
  const entries = Object.entries(summary.by).sort((a, b) => b[1].changes - a[1].changes);
  for (const [key, b] of entries) {
    const bits = [];
    if (b.visibility) bits.push(`visibility×${b.visibility}`);
    if (b.weight) bits.push(`weight×${b.weight}`);
    if (b.moved) bits.push(`moved×${b.moved}`);
    if (b.resized) bits.push(`resized×${b.resized}`);
    if (b.faded) bits.push(`faded×${b.faded}`);
    console.log(`  ${key.padEnd(26)} ${String(b.changes).padStart(4)} changes  ${bits.join(' ')}`);
  }
  const busiest = entries[0];
  if (busiest) {
    console.log(`  --- first transitions for ${busiest[0]}`);
    for (const s of busiest[1].samples) {
      console.log(
        `      t=${s.t}ms  ${JSON.stringify(s.from)} -> ${JSON.stringify(s.to)}`,
      );
    }
  }
};

try {
  await page.setViewport(1440, 900, false);
  await page.navigate(`${BASE}/`);
  await ready();

  /* Phase A: the campus overview, left alone. */
  await page.evaluate(MONITOR(6000));
  await sleep(6800);
  report('campus overview, untouched', await page.evaluate(SUMMARY));

  /* Phase B: the same, with the pointer resting on Open source. */
  const target = await page.evaluate(`(() => {
    const node = document.querySelector('.world-hotspot[data-world-hotspot="place:workbench"]');
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`);
  if (target) {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y });
    await sleep(300);
    await page.evaluate(MONITOR(4000));
    await sleep(4800);
    report('campus overview, pointer on Open source', await page.evaluate(SUMMARY));
  } else {
    console.log('\n=== no place:workbench caption found ===');
  }

  /* Phase C: the destination, panel open. */
  await page.navigate(`${BASE}/open-source/`);
  await ready();
  await page.evaluate(MONITOR(4000));
  await sleep(4800);
  report('open-source destination', await page.evaluate(SUMMARY));
} catch (error) {
  console.log(`FAILED: ${error.message}`);
} finally {
  browser.close();
}
