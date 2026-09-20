/**
 * A focused instrument for looking at the world while it is being changed.
 *
 * This is not the acceptance suite — `run.mjs` is. This one answers the
 * questions that come up while building: where is the camera, is it above the
 * ground, which captions are on screen and do any of them collide, what does
 * the frame measure, and does the music start when it is asked to.
 *
 * Usage:
 *   node tools/worldcheck/inspect.mjs [baseUrl] [--out dir] [--theme dark|light]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchBrowser, Page, sleep } from './cdp.mjs';
import { luminanceOf } from './png.mjs';

const args = process.argv.slice(2);
const BASE = args.find((arg) => arg.startsWith('http')) ?? 'http://localhost:4321';
const outIndex = args.indexOf('--out');
const OUT = outIndex >= 0 ? args[outIndex + 1] : '.screenshots/inspect';
const only = args.indexOf('--only') >= 0 ? args[args.indexOf('--only') + 1] : null;

mkdirSync(OUT, { recursive: true });

const report = {
  url: BASE,
  when: new Date().toISOString(),
  world: null,
  layout: null,
  camera: null,
  captions: null,
  screenshots: [],
  audio: null,
  errors: [],
};

async function ready(page) {
  await page.waitFor(
    `document.querySelector('[data-world]')?.dataset.worldState === 'ready'`,
    { timeout: 40000, label: 'world ready' },
  );
  await page.waitFor(`document.querySelector('[data-world] canvas')?.width > 10`, {
    timeout: 20000,
    label: 'canvas sized',
  });
  await sleep(900);
}

async function dismissWelcome(page) {
  const present = await page.evaluate(
    `(() => { const el = document.querySelector('[data-world-welcome]'); return !!el && !el.hidden; })()`,
  );
  if (!present) return false;
  await page.clickSelector('[data-world-enter="silent"]');
  await sleep(600);
  return true;
}

async function settleTheme(page) {
  await page.waitFor(
    `!!window.__worldDebug && window.__worldDebug().transitioning === false`,
    { timeout: 40000, label: 'theme settled' },
  );
  await sleep(500);
}

/** Everything the harness can read about the live scene. */
const probe = `(() => {
  const world = document.querySelector('[data-world]');
  const debug = window.__worldDebug ? window.__worldDebug() : null;
  const stage = document.querySelector('[data-world-stage]');
  const captions = [...document.querySelectorAll('.world-hotspot')]
    .filter((node) => node.dataset.visible === 'true')
    .map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        key: node.dataset.worldHotspot,
        compact: node.dataset.compact === 'true',
        label: (node.querySelector('.world-hotspot-name') || {}).textContent || '',
        rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      };
    });
  const overlaps = [];
  for (let i = 0; i < captions.length; i++) {
    for (let j = i + 1; j < captions.length; j++) {
      const a = captions[i].rect;
      const b = captions[j].rect;
      if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) {
        overlaps.push(captions[i].key + ' x ' + captions[j].key);
      }
    }
  }
  const card = document.querySelector('.world-identity');
  const cardRect = card ? card.getBoundingClientRect() : null;
  const cardClashes = cardRect
    ? captions
        .filter((c) =>
          c.rect.x < cardRect.right && c.rect.x + c.rect.w > cardRect.left &&
          c.rect.y < cardRect.bottom && c.rect.y + c.rect.h > cardRect.top)
        .map((c) => c.key)
    : [];
  const bar = document.querySelector('[data-world-chrome] .world-chrome-bar');
  const barRect = bar ? bar.getBoundingClientRect() : null;
  const barClashes = barRect
    ? captions
        .filter((c) =>
          c.rect.x < barRect.right && c.rect.x + c.rect.w > barRect.left &&
          c.rect.y < barRect.bottom && c.rect.y + c.rect.h > barRect.top)
        .map((c) => c.key)
    : [];
  return {
    debug,
    stage: stage ? { w: stage.clientWidth, h: stage.clientHeight } : null,
    captions,
    overlaps,
    cardClashes,
    barClashes,
    card: cardRect ? { x: cardRect.x, y: cardRect.y, w: cardRect.width, h: cardRect.height } : null,
    panel: (() => {
      const node = document.querySelector('[data-surface-panel]:not([hidden])');
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
    })(),
  };
})()`;

const main = async () => {
  const browser = await launchBrowser({ port: 9334 });
  const page = await Page.open(browser.webSocketDebuggerUrl);
  page.onEvent = (message) => {
    if (message.method === 'Runtime.exceptionThrown') {
      report.errors.push(
        message.params.exceptionDetails?.exception?.description ??
          message.params.exceptionDetails?.text ??
          'exception',
      );
    }
  };

  const shoot = async (name, options = {}) => {
    const path = join(OUT, `${name}.png`);
    await page.screenshot(path);
    const stats = luminanceOf(path, options.band);
    report.screenshots.push({ name, path, mean: Number(stats.mean.toFixed(1)), max: stats.max });
    return path;
  };

  try {
    await page.setViewport(1440, 900, false);
    await page.navigate(`${BASE}/`);
    await ready(page);
    const welcomed = await dismissWelcome(page);
    report.world = { welcomed };
    await settleTheme(page);

    report.layout = await page.evaluate(probe);
    report.camera = report.layout.debug.camera;
    report.captions = {
      visible: report.layout.captions.length,
      overlaps: report.layout.overlaps,
      cardClashes: report.layout.cardClashes,
      barClashes: report.layout.barClashes,
    };

    if (only === 'camera') {
      report.cameraSweep = await sweepCamera(page);
    }

    await shoot('01-campus-night');

    if (!only || only === 'all') {
      /* Day. */
      await page.clickSelector('[data-world-chrome] [data-theme-toggle]');
      await settleTheme(page);
      await shoot('02-campus-day');

      /* Studio with the CV open. */
      await page.navigate(`${BASE}/cv/`);
      await ready(page);
      await settleTheme(page);
      await shoot('03-cv-day');
      await page.screenshot(join(OUT, '03-cv-day.png'));
      report.cv = await page.evaluate(`(() => {
        const panel = document.querySelector('[data-surface-panel]:not([hidden])');
        return {
          title: panel?.querySelector('h1')?.textContent?.trim(),
          scrollable: panel ? panel.scrollHeight > panel.clientHeight : false,
          download: !!document.querySelector('[data-print], a[download]'),
          progress: getComputedStyle(panel).getPropertyValue('--read-progress').trim(),
        };
      })()`);

      /* Night with the CV open — the theme must not disturb the camera. */
      const beforeCamera = (await page.evaluate(probe)).debug.camera;
      await page.clickSelector('[data-world-chrome] [data-theme-toggle]');
      await settleTheme(page);
      const afterCamera = (await page.evaluate(probe)).debug.camera;
      report.themeKeepsCamera = {
        before: beforeCamera,
        after: afterCamera,
        moved:
          Math.hypot(
            afterCamera.position[0] - beforeCamera.position[0],
            afterCamera.position[1] - beforeCamera.position[1],
            afterCamera.position[2] - beforeCamera.position[2],
          ) > 0.35,
      };
      await shoot('04-cv-night');

      /* Writing. */
      await page.navigate(`${BASE}/writing/from-demo-to-dependable/`);
      await ready(page);
      await settleTheme(page);
      await shoot('05-article-night');

      /* Contact. */
      await page.navigate(`${BASE}/contact/`);
      await ready(page);
      await settleTheme(page);
      await shoot('06-contact-night');

      /* Workshop. */
      await page.navigate(`${BASE}/work/`);
      await ready(page);
      await settleTheme(page);
      await shoot('07-workshop-night');

      /* Mobile. */
      await page.setViewport(390, 844, true);
      await page.navigate(`${BASE}/`);
      await ready(page);
      await settleTheme(page);
      report.mobile = await page.evaluate(probe);
      await shoot('08-mobile-night');
      await page.clickSelector('[data-world-chrome] [data-theme-toggle]');
      await settleTheme(page);
      await shoot('09-mobile-day');

      await page.setViewport(1440, 900, false);
    }

    /* ── Audio ─────────────────────────────────────────────────────── */
    await page.navigate(`${BASE}/`);
    await ready(page);
    const audio = await page.evaluate(`(async () => {
      const state = window.__worldAudio ? window.__worldAudio() : null;
      const toggle = document.querySelector('[data-world-sound-toggle]');
      if (!toggle) return { missing: true };
      toggle.click();
      await new Promise((r) => setTimeout(r, 300));
      const mute = document.querySelector('[data-world-sound-mute]');
      mute.click();
      await new Promise((r) => setTimeout(r, 1800));
      const afterPlay = window.__worldAudio();
      const range = document.querySelector('[data-world-volume]');
      range.value = '65';
      range.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      const afterVolume = window.__worldAudio();
      mute.click();
      await new Promise((r) => setTimeout(r, 900));
      const afterPause = window.__worldAudio();
      return { state, afterPlay, afterVolume, afterPause };
    })()`);
    report.audio = audio;

    await shoot('10-chrome-open');
  } catch (error) {
    report.errors.push(String(error && error.stack ? error.stack : error));
  } finally {
    browser.close();
  }

  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
};

/**
 * Drive the camera to its extremes and check it is never below the ground.
 *
 * The claim "you can never get underneath the island" is only worth making if
 * it survives being abused: this drags far past the azimuth limit, drags down
 * as hard as the control allows, zooms all the way in and all the way out at
 * both extremes, and reads the camera's own height above the floor each time.
 */
async function sweepCamera(page) {
  const read = async () =>
    page.evaluate(`(() => {
      const debug = window.__worldDebug();
      return { above: debug.camera.above, position: debug.camera.position, orbit: debug.orbit };
    })()`);

  const samples = [];
  const record = async (label) => {
    const value = await read();
    samples.push({ label, ...value });
  };

  await record('composed');

  /* Drag as far left as the control permits. */
  for (let i = 0; i < 6; i++) {
    await page.drag({ x: 720, y: 450 }, { x: 200, y: 450 }, 6);
    await sleep(120);
  }
  await sleep(700);
  await record('azimuth-far');

  /* Now drag the elevation past both limits. */
  for (let i = 0; i < 10; i++) {
    await page.drag({ x: 720, y: 700 }, { x: 720, y: 200 }, 6);
    await sleep(90);
  }
  await sleep(700);
  await record('polar-down');

  for (let i = 0; i < 10; i++) {
    await page.drag({ x: 720, y: 200 }, { x: 720, y: 700 }, 6);
    await sleep(90);
  }
  await sleep(700);
  await record('polar-levelled');

  /* Zoom all the way in, then all the way out, at this worst elevation. */
  await page.evaluate(`(() => {
    const canvas = document.querySelector('[data-world-canvas]');
    for (let i = 0; i < 40; i++) {
      canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -260, bubbles: true }));
    }
  })()`);
  await sleep(1400);
  await record('zoomed-in');

  await page.evaluate(`(() => {
    const canvas = document.querySelector('[data-world-canvas]');
    for (let i = 0; i < 60; i++) {
      canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 260, bubbles: true }));
    }
  })()`);
  await sleep(2200);
  await record('zoomed-out');

  /* And a full pinch-style zoom-in from the widest shot. */
  await page.evaluate(`(() => {
    const canvas = document.querySelector('[data-world-canvas]');
    for (let i = 0; i < 60; i++) {
      canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -260, bubbles: true }));
    }
  })()`);
  await sleep(2200);
  await record('zoomed-in-from-wide');

  const worst = samples.reduce((min, item) => (item.above < min.above ? item : min), samples[0]);
  return { samples, worst, safe: samples.every((item) => item.above >= 0) };
}

main();
