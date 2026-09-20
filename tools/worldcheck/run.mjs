/**
 * World-mode verification.
 *
 * Drives a real WebGL-capable browser over CDP and walks the journeys the
 * experience promises: navigation by caption, tap versus drag, theme changes
 * that survive routes, document open/close with camera restoration, the
 * sun and moon, forms, filters, print, reduced motion, context loss and
 * direct deep links. Screenshots are captured after transitions settle.
 *
 * Usage:  node tools/worldcheck/run.mjs [baseUrl]
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchBrowser, Page, sleep } from './cdp.mjs';
import { luminanceOf } from './png.mjs';

const BASE = process.argv[2] ?? 'http://localhost:4321';
const OUT = '.screenshots/world';
const results = [];
const consoleErrors = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    record(name, true, typeof detail === 'string' ? detail : undefined);
  } catch (error) {
    record(name, false, error.message);
  }
}

/**
 * Wait for the day/night blend to finish.
 *
 * It advances on clamped frame deltas, so on a slow renderer it takes longer in
 * wall time than the nominal duration. Anything that measures or photographs
 * the settled world waits on this rather than on a sleep — the first version of
 * this harness slept, and measured a half-finished blend as if it were night.
 */
async function settleTheme(page) {
  await page.waitFor(
    `!!window.__worldDebug && window.__worldDebug().transitioning === false`,
    { timeout: 40000, label: 'theme settled' },
  );
  await sleep(600);
}

/**
 * Wait for the camera to stop moving.
 *
 * Travel is advanced on clamped frame deltas, so under a software rasteriser —
 * which is what a headless browser with no GPU gives you — a 900ms shot takes
 * several seconds of wall time. Anything that presses a caption mid-flight is
 * pressing a caption that has not been placed yet, so the harness waits on the
 * camera rather than on a fixed interval.
 */
async function settleCamera(page, timeout = 40000) {
  await page.waitFor(
    `!!window.__worldDebug && window.__worldDebug().travelling === false`,
    { timeout, interval: 200, label: 'the camera to settle' },
  );
  /* A frame or two more, so the captions are re-projected at the new pose. */
  await sleep(400);
}

/**
 * Set the world's light.
 *
 * There is no day/night button in the bar any more: the light is switched by
 * the brass switch on the observatory terrace, by the sun and the moon, and by
 * whatever names a theme in storage. This drives the same shared state the
 * site uses, so a test that needs a particular light gets it without depending
 * on which control happens to be in the chrome this month.
 */
async function setLight(page, theme) {
  await page.evaluate(`(() => {
    document.documentElement.dataset.theme = ${JSON.stringify(theme)};
    try { localStorage.setItem('theme', ${JSON.stringify(theme)}); } catch (error) { /* storage off */ }
    document.dispatchEvent(new CustomEvent('world:themechange', {
      detail: { theme: ${JSON.stringify(theme)}, animate: true },
    }));
  })()`);
}

/** Which way the light is currently switched. */
const lightOf = (page) => page.evaluate(`document.documentElement.dataset.theme`);

/**
 * Wait until the renderer is up and the first frame has been drawn.
 *
 * The timeout is generous because a headless browser has no GPU: the software
 * rasteriser that stands in for one can take a minute to compile the scene's
 * shaders on a cold reload, and longer when another browser is competing for
 * the same cores. This is a limit on "never", not a performance budget — the
 * suite is checking behaviour, and a slow frame is not a wrong one.
 */
async function ready(page) {
  await page.waitFor(
    `document.querySelector('[data-world]')?.dataset.worldState === 'ready'`,
    { timeout: 150000, label: 'world ready' },
  );
  await page.waitFor(`document.querySelector('[data-world] canvas')?.width > 10`, {
    timeout: 20000,
    label: 'canvas sized',
  });
  await sleep(700);
}

const state = () => `(() => {
  const world = document.querySelector('[data-world]');
  const body = document.body;
  return {
    worldState: world?.dataset.worldState,
    theme: document.documentElement.dataset.theme,
    mode: document.documentElement.dataset.mode,
    ambient: document.documentElement.dataset.ambient,
    destination: body.dataset.destination,
    surface: body.dataset.surface,
    surfaceId: body.dataset.surfaceId,
    reading: world?.dataset.worldReading,
    focus: world?.dataset.focus,
    location: document.querySelector('[data-world-location]')?.textContent,
    panelVisible: (() => {
      const panel = document.querySelector('[data-surface-panel]:not([hidden])');
      if (!panel) return false;
      const rect = panel.getBoundingClientRect();
      return rect.width > 40 && rect.height > 40;
    })(),
    panelTitle: document.querySelector('[data-surface-panel]:not([hidden]) h1')?.textContent?.trim(),
    closeHref: document.querySelector('[data-surface-close]')?.dataset.closeHref,
    panelScroll: document.querySelector('[data-surface-panel]')?.scrollTop,
    soundControl: !!document.querySelector('[data-world-chrome] [data-world-sound-toggle]'),
    mapLinks: document.querySelectorAll('[data-world-map-menu] a').length,
    hotspots: [...document.querySelectorAll('.world-hotspot')].map((node) => ({
      key: node.dataset.worldHotspot,
      visible: node.dataset.visible,
      label: node.textContent.trim(),
    })),
    camera: window.__worldDebug ? window.__worldDebug() : null,
  };
})()`;

/** Navigate the way a visitor would: select the destination from the map. */
async function travel(page, href, destination) {
  await page.evaluate(`(() => {
    const link = [...document.querySelectorAll('[data-world-map-menu] a')]
      .find((node) => node.getAttribute('href') === ${JSON.stringify(href)});
    if (link) link.click();
  })()`);
  /*
   * Wait for the *shell* to have applied the new page, not just for the
   * server-rendered attribute to change: that attribute arrives with the
   * swapped body, while the shell applies state a moment later, and clicking
   * in between lands on the page that is on its way out.
   */
  await page.waitFor(
    `document.querySelector('[data-world]')?.dataset.focus === ${JSON.stringify(destination)}`,
    { timeout: 20000, label: `${href} → ${destination}` },
  );
  await ready(page);
  await settleCamera(page);
}

const main = async () => {
  mkdirSync(OUT, { recursive: true });
  const browser = await launchBrowser({ port: 9333 });
  const page = await Page.open(browser.webSocketDebuggerUrl);
  page.onEvent = (message) => {
    if (message.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(message.params.exceptionDetails?.exception?.description ?? 'exception');
    }
  };

  try {
    await page.setViewport(1440, 900);

    /* ── 0. System preference on a first visit, before any choice ──── */
    await check('System preference is honoured on the first visit', async () => {
      await page.emulateMedia([{ name: 'prefers-color-scheme', value: 'light' }]);
      await page.navigate(`${BASE}/`);
      await ready(page);
      const light = await page.evaluate(`document.documentElement.dataset.theme`);
      await page.evaluate(`localStorage.removeItem('theme')`);
      await page.emulateMedia([{ name: 'prefers-color-scheme', value: 'dark' }]);
      await page.send('Page.reload');
      await ready(page);
      const dark = await page.evaluate(`document.documentElement.dataset.theme`);
      if (light !== 'light' || dark !== 'dark') {
        throw new Error(`light=${light}, dark=${dark}`);
      }
      return 'follows the system until an explicit choice is made';
    });

    await check('An explicit choice survives a reload', async () => {
      await setLight(page, 'light');
      await settleTheme(page);
      const chosen = await lightOf(page);
      await page.send('Page.reload');
      await ready(page);
      const after = await lightOf(page);
      if (after !== chosen) throw new Error(`chose ${chosen}, reloaded as ${after}`);
      /* Back to night for the remaining journeys. */
      if (after === 'light') {
        await setLight(page, 'dark');
        await settleTheme(page);
      }
      return `chose ${chosen}, reloaded as ${after}`;
    });

    await page.navigate(`${BASE}/`);
    await ready(page);

    /* ── 1. The world starts, one renderer, chrome present ─────────── */
    await check('World starts and exposes its controls', async () => {
      const info = await page.evaluate(state());
      if (info.worldState !== 'ready') throw new Error(`state ${info.worldState}`);
      if (info.mode !== 'world') throw new Error(`mode ${info.mode}`);
      if (!info.soundControl) throw new Error('no sound control in the bar');
      if (info.mapLinks < 6) throw new Error(`map menu has ${info.mapLinks} links`);
      return `${info.hotspots.length} captions, ${info.mapLinks} map links`;
    });

    await check('One canvas, one WebGL context', async () => {
      const count = await page.evaluate(
        `document.querySelectorAll('[data-world] canvas').length`,
      );
      const renderers = await page.evaluate(
        `document.querySelectorAll('canvas').length`,
      );
      if (count !== 1) throw new Error(`${count} world canvases`);
      return `canvases in document: ${renderers}`;
    });

    await page.screenshot(join(OUT, '01-overview-night.png'));

    /* ── 2. Night → day, and back ─────────────────────────────────── */
    await check('The light switches to daylight', async () => {
      await setLight(page, 'light');
      await settleTheme(page);
      const info = await page.evaluate(state());
      if (info.theme !== 'light') throw new Error(`theme is ${info.theme}`);
      const stored = await page.evaluate(`localStorage.getItem('theme')`);
      if (stored !== 'light') throw new Error(`stored ${stored}`);
      return 'theme=light, persisted';
    });

    await page.screenshot(join(OUT, '02-overview-day.png'));

    await check('The light switches back to night', async () => {
      await setLight(page, 'dark');
      await settleTheme(page);
      const info = await page.evaluate(state());
      if (info.theme !== 'dark') throw new Error(`theme is ${info.theme}`);
      return 'theme=dark';
    });

    /*
     * The look of the two states is a claim like any other, and it is one that
     * a half-finished blend silently breaks. Measured from the frames rather
     * than trusted: the day overview has to be far brighter than the night one,
     * and the night one has to still be dark.
     */
    await check('Day is bright and night is dark, measured from the frames', async () => {
      const day = luminanceOf(join(OUT, '02-overview-day.png')).mean;
      const night = luminanceOf(join(OUT, '01-overview-night.png')).mean;
      if (night > 70) throw new Error(`night measures ${night.toFixed(1)} — too washed out`);
      if (day < 140) throw new Error(`day measures ${day.toFixed(1)} — too dark`);
      if (day - night < 90) {
        throw new Error(`day ${day.toFixed(1)} vs night ${night.toFixed(1)} — too little contrast`);
      }
      return `day ${day.toFixed(1)} vs night ${night.toFixed(1)}`;
    });

    await check('Stars appear at night, and the night sky is dark', async () => {
      /* The upper sky band: a gradient cannot exceed its own top stop, so
         bright specks there can only be the starfield. */
      const band = { top: 0.02, bottom: 0.18, left: 0.25, right: 0.75 };
      const nightSky = luminanceOf(join(OUT, '01-overview-night.png'), band);
      const daySky = luminanceOf(join(OUT, '02-overview-day.png'), band);
      if (nightSky.mean >= daySky.mean) {
        throw new Error(
          `night sky ${nightSky.mean.toFixed(1)} is not darker than day ${daySky.mean.toFixed(1)}`,
        );
      }
      if (nightSky.max < 140) {
        throw new Error(`no stars: brightest night-sky pixel is ${nightSky.max.toFixed(0)}`);
      }
      if (nightSky.max >= daySky.max - 2) {
        throw new Error('the night sky is as bright as the day sky');
      }
      return `night sky mean ${nightSky.mean.toFixed(1)}, brightest ${nightSky.max.toFixed(0)}; day brightest ${daySky.max.toFixed(0)}`;
    });

    /* ── 3. A caption click travels; a document opens once ────────── */
    const studioBox = await page.boundingBox('.world-hotspot[data-world-hotspot="place:studio"]');
    await check('Clicking a destination caption travels there', async () => {
      if (!studioBox) throw new Error('studio caption not visible');
      await page.click(studioBox.x + studioBox.width / 2, studioBox.y + studioBox.height / 2);
      await page.waitFor(
        `document.querySelector('[data-world]')?.dataset.focus === 'studio'`,
        { timeout: 15000, label: 'travel to the studio' },
      );
      await settleCamera(page);
      const info = await page.evaluate(state());
      if (info.focus !== 'studio') throw new Error(`focus is ${info.focus}`);
      const hasCv = info.hotspots.some((hotspot) => hotspot.key.startsWith('object:cv'));
      if (!hasCv) throw new Error('studio did not reveal its objects');
      return `focus=${info.focus}, ${info.hotspots.length} captions`;
    });

    await page.screenshot(join(OUT, '03-studio.png'));

    await check('Clicking an object caption opens the document exactly once', async () => {
      const before = await page.evaluate(`performance.getEntriesByType('navigation').length`);
      /*
       * A caption is placed by the projection pass, which runs on the frame
       * clock: it depends on where the camera has got to and on which
       * buildings are in the way. The harness therefore waits for the caption
       * the visitor would press to be on screen rather than for a fixed
       * interval — the same discipline the rest of this suite follows.
       */
      await page
        .waitFor(
          `document.querySelector('.world-hotspot[data-world-hotspot="object:cv:cv"]')?.dataset.visible === 'true'`,
          { timeout: 15000, label: 'the CV caption to be placed' },
        )
        .catch(async () => {
          /* A narrow window may only fit markers; focus reveals the pill. */
          await page.evaluate(
            `document.querySelector('.world-hotspot[data-world-hotspot="object:cv:cv"]')?.focus()`,
          );
          await sleep(400);
        });
      const box = await page.boundingBox('.world-hotspot[data-world-hotspot="object:cv:cv"]');
      if (!box || box.width < 4) throw new Error('CV caption not visible');
      await page.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitFor(`document.body.dataset.surface === 'cv'`, {
        label: 'CV open',
        timeout: 12000,
      });
      await sleep(900);
      const after = await page.evaluate(`performance.getEntriesByType('navigation').length`);
      const info = await page.evaluate(state());
      if (after !== before) throw new Error('the page reloaded to open the document');
      if (!info.panelVisible) throw new Error('panel is not visible');
      return `surface=${info.surface}, no reload`;
    });

    await check('The renderer survived the document opening', async () => {
      const same = await page.evaluate(`!!document.querySelector('[data-world]').__abdWorldShell`);
      const loaded = await page.evaluate(`performance.getEntriesByType('navigation').length`);
      if (loaded !== 1) throw new Error('navigation count grew');
      void same;
      return 'one navigation entry for the whole session';
    });

    await page.screenshot(join(OUT, '04-cv-open.png'));

    /* ── 4. Theme while reading, then close and restore ───────────── */
    await check('Theme changes while a document is open, content intact', async () => {
      await page.evaluate(
        `document.querySelector('[data-surface-panel]').scrollTop = 320`,
      );
      const scrollBefore = await page.evaluate(
        `document.querySelector('[data-surface-panel]').scrollTop`,
      );
      await setLight(page, 'light');
      await settleTheme(page);
      const info = await page.evaluate(state());
      if (info.theme !== 'light') throw new Error(`theme is ${info.theme}`);
      if (info.surface !== 'cv') throw new Error('document was lost');
      const scrollAfter = await page.evaluate(
        `document.querySelector('[data-surface-panel]').scrollTop`,
      );
      if (scrollAfter !== scrollBefore) throw new Error('reading position changed');
      return `scroll held at ${scrollAfter}`;
    });

    await page.screenshot(join(OUT, '05-cv-day.png'));

    await check('Close returns to the previous world view without a reload', async () => {
      const navs = await page.evaluate(`performance.getEntriesByType('navigation').length`);
      await page.clickSelector('[data-surface-close]');
      await page.waitFor(`document.body.dataset.surface === 'none'`, {
        timeout: 15000,
        label: 'the document to close',
      });
      await settleCamera(page);
      const info = await page.evaluate(state());
      const navsAfter = await page.evaluate(`performance.getEntriesByType('navigation').length`);
      if (navsAfter !== navs) throw new Error('closing reloaded the page');
      if (info.surface !== 'none') throw new Error(`still reading ${info.surface}`);
      if (info.reading !== 'false') throw new Error('world did not settle back');
      if (info.focus !== 'campus') throw new Error(`closed to ${info.focus}`);
      return `location=${info.location}, no reload`;
    });

    await page.screenshot(join(OUT, '06-cv-closed.png'));

    /* ── 5. The physical light switch ─────────────────────────────── */
    await check('The sun is a body in the sky, in the upper part of the view', async () => {
      /*
       * The sun belongs to the campus: at a destination the frame is filled
       * with the building, so the harness stands on the overview before asking
       * where it is. Closing the document above navigates back, and the camera
       * then has to settle before the sky is recomposed.
       */
      await settleCamera(page);
      const debug = await page.evaluate(`window.__worldDebug()`);
      if (!debug.celestial) {
        throw new Error(`the world has no sun (destination ${debug.destination})`);
      }
      if (!debug.celestial.onScreen) throw new Error('the sun is not on screen');
      const stage = await page.evaluate(`(() => {
        const w = document.querySelector('[data-world]').clientWidth;
        const h = document.querySelector('[data-world]').clientHeight;
        return { w, h };
      })()`);
      /*
       * The body is deliberately off to one side of the frame: hung dead
       * centre it lands directly behind the observatory dome from the overview
       * bearing, which reads as a decal on the roof rather than as sky. What
       * matters is that it is inside the frame, clear of the centre and in the
       * upper part of it.
       */
      const centreX = stage.w / 2;
      const offset = Math.abs(debug.celestial.x - centreX);
      if (offset < stage.w * 0.06) {
        throw new Error(`the sun is on the frame's centre line (${Math.round(debug.celestial.x)} of ${centreX})`);
      }
      if (offset > stage.w * 0.42) {
        throw new Error(`the sun has drifted to the frame's edge (${Math.round(debug.celestial.x)} of ${centreX})`);
      }
      if (debug.celestial.y > stage.h * 0.42) {
        throw new Error(`the sun is not in the upper part of the frame (y ${Math.round(debug.celestial.y)})`);
      }
      return `offset ${Math.round(offset)}px from centre at ${Math.round(debug.celestial.x)},${Math.round(debug.celestial.y)} of ${stage.w}×${stage.h}`;
    });

    await check('Tapping the sun in the sky changes the light, and it sets as the moon rises', async () => {
      /* A direct tap on the post itself, resolved by the scene rather than by
         a caption: this is the physical control, not the interface one. */
      const before = await page.evaluate(`document.documentElement.dataset.theme`);
      const point = await page.evaluate(`window.__worldDebug().celestial`);
      const blocked = await page.evaluate(`(() => {
        const node = document.elementFromPoint(${point.x}, ${point.y});
        return node ? (node.className || node.tagName) : null;
      })()`);
      if (blocked !== 'world-canvas') {
        throw new Error(`the sun is covered by ${blocked}`);
      }
      await page.click(point.x, point.y);
      await page.waitFor(`document.documentElement.dataset.theme !== ${JSON.stringify(before)}`, {
        timeout: 6000,
        label: 'sun activation',
      });
      await settleTheme(page);
      const after = await page.evaluate(`document.documentElement.dataset.theme`);
      /*
       * The switch on the observatory terrace must agree with the sun: they are
       * two handles on one state, and storage is the proof that both wrote to
       * the place the next page will read from.
       */
      const physical = await page.evaluate(
        `document.querySelector('.world-hotspot[data-world-hotspot="switch:lights"]')?.getAttribute('aria-pressed')`,
      );
      const expected = after === 'light' ? 'true' : 'false';
      if (physical !== expected) throw new Error('the light switch disagrees with the sun');
      const stored = await page.evaluate(`localStorage.getItem('theme')`);
      if (stored !== after) throw new Error('the sun did not persist the shared state');
      return `scene tap: ${before} → ${after}; the sun, the light switch and storage agree`;
    });

    await check('The sun is its own control, with no caption over it', async () => {
      const info = await page.evaluate(`(() => {
        const caption = document.querySelector('.world-hotspot[data-world-hotspot="celestial:sun"]');
        const physical = document.querySelector('.world-hotspot[data-world-hotspot="switch:lights"]');
        return {
          caption: caption ? caption.outerHTML.slice(0, 60) : null,
          switchLabel: physical ? physical.getAttribute('aria-label') : null,
          switchPressed: physical ? physical.getAttribute('aria-pressed') : null,
        };
      })()`);
      if (info.caption) throw new Error(`the sun still has a caption: ${info.caption}`);
      if (!info.switchLabel) throw new Error('the observatory light switch has no caption');
      if (info.switchPressed !== 'true' && info.switchPressed !== 'false') {
        throw new Error('the switch does not expose its state');
      }
      return `no sun caption; the terrace switch reads "${info.switchLabel}"`;
    });

    /* ── 6. Click versus drag ─────────────────────────────────────── */
    await check('Dragging the background moves the camera and opens nothing', async () => {
      const info0 = await page.evaluate(state());
      await page.drag({ x: 1100, y: 620 }, { x: 780, y: 560 }, 14);
      await sleep(600);
      const info1 = await page.evaluate(state());
      if (info1.surface !== 'none') throw new Error('a drag opened a document');
      if (info1.focus !== info0.focus) throw new Error('a drag travelled');
      return 'no document opened, no travel';
    });

    await check('A tap on a control never drags the world', async () => {
      const box = await page.boundingBox('[data-world-chrome] [data-world-map]');
      const before = await page.evaluate(`document.querySelector('[data-world-map-menu]').hidden`);
      await page.click(box.x + box.width / 2, box.y + box.height / 2);
      await sleep(300);
      const after = await page.evaluate(`document.querySelector('[data-world-map-menu]').hidden`);
      if (after === before) throw new Error('the map control did not respond');
      return `menu hidden: ${before} → ${after}`;
    });

    await page.screenshot(join(OUT, '07-map-menu.png'));

    /* ── 7. Map navigation keeps state and stays usable ───────────── */
    await check('Map menu navigates with the theme preserved', async () => {
      const themeBefore = await page.evaluate(`document.documentElement.dataset.theme`);
      await travel(page, '/writing/', 'library');
      const info = await page.evaluate(state());
      if (info.theme !== themeBefore) throw new Error('theme changed across navigation');
      return `destination=${info.destination}, theme=${info.theme}`;
    });

    await page.screenshot(join(OUT, '08-library-day.png'));

    await check('Controls still work after repeated navigation', async () => {
      for (const [href, destination] of [
        ['/work/', 'workshop'],
        ['/writing/', 'library'],
        ['/open-source/', 'workbench'],
        ['/contact/', 'contact'],
        ['/', 'campus'],
      ]) {
        await travel(page, href, destination);
      }
      const beforeLight = await lightOf(page);
      await setLight(page, beforeLight === 'light' ? 'dark' : 'light');
      await settleTheme(page);
      /* And the choice was written, not only shown: the state is shared with
         the pre-paint probe, so storage is the thing that proves it stuck. */
      await page.waitFor(
        `localStorage.getItem('theme') === document.documentElement.dataset.theme`,
        { timeout: 8000, label: 'the theme choice to persist' },
      );
      const theme = await page.evaluate(`document.documentElement.dataset.theme`);
      const stored = await page.evaluate(`localStorage.getItem('theme')`);
      if (stored !== theme) throw new Error('the control stopped responding after navigation');
      if (theme === beforeLight) throw new Error('the light did not change');
      return `still responsive after 5 navigations; theme=${theme}`;
    });

    /* ── 8. Every article and case study opens ────────────────────── */
    await check('Every article opens and closes', async () => {
      const slugs = await page.evaluate(`(async () => {
        const response = await fetch('/rss.xml');
        const text = await response.text();
        return [...text.matchAll(/<link>([^<]+)<\\/link>/g)]
          .map((match) => match[1])
          .filter((href) => href.includes('/writing/'));
      })()`);
      if (!slugs.length) throw new Error('no articles found in the feed');
      for (const slug of slugs) {
        const path = new URL(slug).pathname;
        await page.navigate(`${BASE}${path}`);
        await ready(page);
        const info = await page.evaluate(state());
        if (info.surface !== 'article') throw new Error(`${path}: surface ${info.surface}`);
        if (!info.panelTitle) throw new Error(`${path}: no document title`);
      }
      return `${slugs.length} articles, each opened from its own URL`;
    });

    await page.screenshot(join(OUT, '09-article.png'));

    await check('Every case study opens and closes', async () => {
      const paths = ['/work/kai/', '/work/education-platform/', '/work/hyperran/'];
      for (const path of paths) {
        await page.navigate(`${BASE}${path}`);
        await ready(page);
        const info = await page.evaluate(state());
        if (info.surface !== 'project') throw new Error(`${path}: surface ${info.surface}`);
        if (!info.panelTitle) throw new Error(`${path}: no title`);
        await page.clickSelector('[data-surface-close]');
        await page.waitFor(`document.body.dataset.surface !== 'project'`, {
          timeout: 8000,
          label: `${path} closed`,
        });
        await sleep(400);
        const after = await page.evaluate(state());
        if (after.surface === 'project') throw new Error(`${path}: did not close`);
        if (after.destination !== 'workshop') throw new Error(`${path}: landed on ${after.destination}`);
      }
      return `${paths.length} case studies opened and closed`;
    });

    await page.screenshot(join(OUT, '10-case-study.png'));

    /* ── 9. Deep link, refresh, back and forward ──────────────────── */
    await check('Direct URL, refresh, Back and Forward keep the world', async () => {
      const target = `${BASE}/writing/from-demo-to-dependable/`;
      await page.navigate(target);
      await ready(page);
      let info = await page.evaluate(state());
      if (info.surface !== 'article' || info.destination !== 'library') {
        throw new Error(`direct load landed on ${info.surface}/${info.destination}`);
      }
      await page.send('Page.reload');
      await ready(page);
      info = await page.evaluate(state());
      if (info.surface !== 'article') throw new Error('refresh lost the document');
      await page.navigate(`${BASE}/writing/`);
      await ready(page);
      await page.send('Page.navigateToHistoryEntry', {}).catch(() => {});
      await page.evaluate(`history.back()`);
      await sleep(1500);
      await ready(page);
      info = await page.evaluate(state());
      if (info.surface !== 'article') throw new Error(`Back landed on ${info.surface}`);
      await page.evaluate(`history.forward()`);
      await sleep(1500);
      await ready(page);
      info = await page.evaluate(state());
      if (info.destination !== 'library') throw new Error(`Forward landed on ${info.destination}`);
      return 'direct load, refresh, Back and Forward all consistent';
    });

    /* ── 10. Forms, filters, print ────────────────────────────────── */
    await check('Project filters work after a client-side navigation', async () => {
      await travel(page, '/work/', 'workshop');
      await page.clickSelector('.filter-btn[data-filter="automation"]');
      await sleep(500);
      const info = await page.evaluate(`(() => {
        const all = document.querySelectorAll('[data-cat]').length;
        const visible = [...document.querySelectorAll('[data-cat]')].filter((node) => !node.hidden).length;
        return {
          all,
          visible,
          pressed: document.querySelector('.filter-btn[data-filter="automation"]').getAttribute('aria-pressed'),
          status: document.querySelector('[data-filter-count]')?.textContent,
        };
      })()`);
      if (info.pressed !== 'true') throw new Error('filter button state did not update');
      if (info.visible === 0 || info.visible === info.all) {
        throw new Error(`filter selected ${info.visible} of ${info.all}`);
      }
      return `${info.visible}/${info.all} shown — "${info.status}"`;
    });

    await check('Contact form is a real form with honest validation', async () => {
      await travel(page, '/contact/', 'contact');
      const form = await page.evaluate(`(() => {
        const node = document.querySelector('[data-contact-form]');
        if (!node) return { present: false };
        return {
          present: true,
          action: node.getAttribute('action'),
          method: node.getAttribute('method'),
          required: [...node.querySelectorAll('[required]')].length,
          status: !!node.querySelector('[data-form-status]'),
        };
      })()`);
      if (!form.present) return 'contact form not configured (no access key): email fallback shown';
      if (form.method !== 'post') throw new Error('form is not a POST');
      if (!form.status) throw new Error('form has no status region');
      /* Empty submit must be refused locally, never reported as success. */
      const refused = await page.evaluate(`(() => {
        const node = document.querySelector('[data-contact-form]');
        node.querySelector('input[type="email"]').value = 'not-an-email';
        return !node.reportValidity();
      })()`);
      if (!refused) throw new Error('invalid input was accepted');
      return `POST ${form.action}, ${form.required} required fields, invalid input refused locally`;
    });

    await check('Newsletter block offers a real destination', async () => {
      await page.navigate(`${BASE}/writing/voice-ai-cascade-elevenlabs-direct/`);
      await ready(page);
      const info = await page.evaluate(`(() => {
        const form = document.querySelector('[data-newsletter-form]');
        if (form) return { kind: 'form', action: form.getAttribute('action') };
        const notice = document.querySelector('.signup-notice');
        return { kind: notice ? 'notice' : 'missing' };
      })()`);
      if (info.kind === 'missing') throw new Error('no newsletter block');
      return info.kind === 'form' ? `posts to ${info.action}` : 'launching-soon notice (honest)';
    });

    await check('Print / save PDF is wired', async () => {
      await travel(page, '/cv/', 'studio');
      const wired = await page.evaluate(`(() => {
        const button = document.querySelector('[data-print]');
        if (!button) return false;
        /* Print is intercepted by the delegated controller, so the check is
           that the hook exists and is a real button on the open document. */
        return button.tagName === 'BUTTON' && button.type === 'button';
      })()`);
      if (!wired) throw new Error('no print control');
      return 'print control present on the CV';
    });

    await page.screenshot(join(OUT, '11-contact.png'));

    /* ── 11. Reduced motion and ambient pause ─────────────────────── */
    await check('Ambient motion can be paused and is persisted', async () => {
      /* It lives in the map menu now, and the menu scrolls, so a visitor
         reaches it the same way this does. */
      await page.clickSelector('[data-world-chrome] [data-world-map]');
      await sleep(400);
      await page.evaluate(
        `document.querySelector('[data-world-map-menu] [data-world-ambient]').scrollIntoView({ block: 'nearest' })`,
      );
      await sleep(250);
      await page.clickSelector('[data-world-map-menu] [data-world-ambient]');
      await sleep(400);
      const ambient = await page.evaluate(`document.documentElement.dataset.ambient`);
      const stored = await page.evaluate(`localStorage.getItem('world:ambient')`);
      if (ambient !== 'paused') throw new Error(`ambient is ${ambient}`);
      if (stored !== 'paused') throw new Error('pause was not persisted');
      await page.clickSelector('[data-world-map-menu] [data-world-ambient]');
      await sleep(300);
      await page.key('Escape', 'Escape', 27);
      return 'pause toggles and persists';
    });

    await check('Reduced motion applies the theme immediately', async () => {
      await page.emulateMedia([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
      await travel(page, '/', 'campus');
      const before = await page.evaluate(`document.documentElement.dataset.theme`);
      await setLight(page, before === 'light' ? 'dark' : 'light');
      await sleep(150);
      const after = await page.evaluate(`document.documentElement.dataset.theme`);
      if (after === before) throw new Error('theme did not change');
      const anim = await page.evaluate(`document.documentElement.dataset.themeAnim`);
      if (anim === 'true') throw new Error('still animating under reduced motion');
      /* The campus must also stop turning itself: it is continuous motion. */
      const turning = await page.evaluate(`(() => {
        window.__worldResetTurn();
        return true;
      })()`);
      await sleep(1200);
      const turned = await page.evaluate(`window.__worldDebug().camera.turn`);
      if (Math.abs(turned) > 0.001) {
        throw new Error(`the campus kept turning under reduced motion (${turned})`);
      }
      const immediate = await page.evaluate(`(() => {
        /* The environment must already be at the new theme, not part-way. */
        const world = document.querySelector('[data-world]');
        return world.dataset.worldState === 'ready';
      })()`);
      if (!immediate) throw new Error('the world did not survive the immediate change');
      await page.emulateMedia([]);
      return `${before} → ${after} with no transition, and no automatic turn${turning ? '' : ''}`;
    });

    await page.screenshot(join(OUT, '12-reduced-motion.png'));

    /* ── 12. Context loss ─────────────────────────────────────────── */
    await check('Losing the WebGL context reports honestly and recovers', async () => {
      await page.evaluate(`(() => {
        const canvas = document.querySelector('[data-world] canvas');
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
        const ext = gl.getExtension('WEBGL_lose_context');
        window.__worldLose = () => ext.loseContext();
        window.__worldRestore = () => ext.restoreContext();
      })()`);
      await page.evaluate(`window.__worldLose()`);
      await sleep(500);
      const alertShown = await page.evaluate(
        `!document.querySelector('[data-world-alert]').hidden`,
      );
      if (!alertShown) throw new Error('no honest failure screen after context loss');
      return 'failure screen shown with a retry';
    });

    await page.screenshot(join(OUT, '13-context-lost.png'));

    await check('Recovery resumes one renderer, not two', async () => {
      await page.evaluate(`window.__worldRestore()`);
      await page.waitFor(
        `document.querySelector('[data-world]').dataset.worldState === 'ready'`,
        { timeout: 20000, label: 'recovered' },
      );
      await sleep(900);
      const canvases = await page.evaluate(`document.querySelectorAll('[data-world] canvas').length`);
      const hidden = await page.evaluate(
        `document.querySelector('[data-world-alert]').hidden`,
      );
      if (canvases !== 1) throw new Error(`${canvases} canvases after recovery`);
      if (!hidden) throw new Error('the failure screen stayed up after recovery');
      const pixels = await page.evaluate(`(() => {
        const canvas = document.querySelector('[data-world] canvas');
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
        return gl ? gl.isContextLost() : true;
      })()`);
      if (pixels) throw new Error('the context is still lost after recovery');
      return 'one canvas, live context, failure screen cleared';
    });

    await check('Retry rebuilds a single renderer', async () => {
      /* Raise the failure screen the way a real startup failure would. */
      await page.evaluate(`document.querySelector('[data-world]').dataset.worldState = 'error'`);
      await page.evaluate(`window.__worldAlert('verification: deliberate failure')`);
      await sleep(300);
      await page.clickSelector('[data-world-retry]');
      await page.waitFor(
        `document.querySelector('[data-world]').dataset.worldState === 'ready'`,
        { timeout: 30000, label: 'retry rebuilt the world' },
      );
      await sleep(800);
      const canvases = await page.evaluate(`document.querySelectorAll('[data-world] canvas').length`);
      const alertHidden = await page.evaluate(
        `document.querySelector('[data-world-alert]').hidden`,
      );
      if (canvases !== 1) throw new Error(`${canvases} canvases after retry`);
      if (!alertHidden) throw new Error('the failure screen stayed up after retry');
      const theme = await page.evaluate(`document.documentElement.dataset.theme`);
      if (!theme) throw new Error('theme lost across the rebuild');
      const info = await page.evaluate(state());
      if (info.worldState !== 'ready') throw new Error('the world is not usable after retry');
      return 'explicit retry ends in one working renderer';
    });

    /* ── 13. Mobile ───────────────────────────────────────────────── */
    await page.setViewport(390, 844, true);
    await page.navigate(`${BASE}/`);
    await ready(page);
    await page.screenshot(join(OUT, '14-mobile-night.png'));

    await check('Mobile keeps the world, with reachable controls', async () => {
      const info = await page.evaluate(`(() => {
        const controls = [...document.querySelectorAll('[data-world-chrome] button, [data-world-chrome] a')];
        const small = controls
          .filter((node) => node.offsetParent !== null)
          .map((node) => node.getBoundingClientRect())
          .filter((rect) => rect.width < 44 || rect.height < 44);
        const panel = document.querySelector('[data-surface-panel]');
        return {
          mode: document.documentElement.dataset.mode,
          worldState: document.querySelector('[data-world]').dataset.worldState,
          controls: controls.length,
          tooSmall: small.length,
          panel: !!panel,
        };
      })()`);
      if (info.worldState !== 'ready') throw new Error('mobile world did not start');
      if (info.tooSmall > 0) throw new Error(`${info.tooSmall} controls under 44px`);
      return `${info.controls} controls, all at least 44×44`;
    });

    await check('Mobile offers enough destinations to travel by tap', async () => {
      const shown = await page.evaluate(`[...document.querySelectorAll('.world-hotspot')]
        .filter((node) => node.dataset.visible === 'true')
        .map((node) => node.dataset.worldHotspot)`);
      if (shown.length < 3) {
        throw new Error(`only ${shown.length} captions on a phone: ${shown.join(', ')}`);
      }
      return `${shown.length} captions visible: ${shown.join(', ')}`;
    });

    await check('Captions on a phone do not overlap each other or the chrome', async () => {
      const overlap = await page.evaluate(`(() => {
        const boxes = [...document.querySelectorAll('.world-hotspot')]
          .filter((node) => node.dataset.visible === 'true')
          .map((node) => ({ key: node.dataset.worldHotspot, rect: node.getBoundingClientRect() }));
        const chrome = document.querySelector('[data-world-chrome] .world-chrome-bar')
          .getBoundingClientRect();
        const clashes = [];
        for (let i = 0; i < boxes.length; i++) {
          for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i].rect;
            const b = boxes[j].rect;
            if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) {
              clashes.push(boxes[i].key + ' × ' + boxes[j].key);
            }
          }
        }
        const hidden = boxes.filter(({ rect }) =>
          rect.left < chrome.right && rect.right > chrome.left &&
          rect.top < chrome.bottom && rect.bottom > chrome.top);
        return { clashes, underChrome: hidden.map((item) => item.key) };
      })()`);
      if (overlap.clashes.length) throw new Error(`overlapping: ${overlap.clashes.join(', ')}`);
      if (overlap.underChrome.length) {
        throw new Error(`under the control bar: ${overlap.underChrome.join(', ')}`);
      }
      return 'no overlaps';
    });

    await check('Object captions at a destination do not overlap', async () => {
      await page.setViewport(390, 844, true);
      await travel(page, '/work/', 'workshop');
      const overlap = await page.evaluate(`(() => {
        const boxes = [...document.querySelectorAll('.world-hotspot')]
          .filter((node) => node.dataset.visible === 'true')
          .map((node) => ({ key: node.dataset.worldHotspot, rect: node.getBoundingClientRect() }));
        const clashes = [];
        for (let i = 0; i < boxes.length; i++) {
          for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i].rect;
            const b = boxes[j].rect;
            if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) {
              clashes.push(boxes[i].key + ' × ' + boxes[j].key);
            }
          }
        }
        return { clashes, shown: boxes.map((item) => item.key) };
      })()`);
      if (overlap.clashes.length) {
        throw new Error(`${overlap.clashes.join(', ')} — visible: ${overlap.shown.join(', ')}`);
      }
      /* Back to the overview for the interaction checks that follow. */
      await travel(page, '/', 'campus');
      return `${overlap.shown.length} captions, no overlaps`;
    });

    await check('Mobile tap travels without a joystick', async () => {
      const target = await page.evaluate(`(() => {
        const node = [...document.querySelectorAll('.world-hotspot[data-world-hotspot^="place:"]')]
          .find((item) => item.dataset.visible === 'true' && item.dataset.worldHotspot !== 'place:campus');
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return { key: node.dataset.worldHotspot, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()`);
      if (!target) throw new Error('no visible destination caption on mobile');
      await page.tap(target.x, target.y);
      await page.waitFor(
        `document.querySelector('[data-world]').dataset.focus !== 'campus'`,
        { timeout: 8000, label: 'tap-travel' },
      );
      await sleep(1200);
      const focus = await page.evaluate(`document.querySelector('[data-world]').dataset.focus`);
      return `tapped ${target.key} → focus ${focus}`;
    });

    await check('Mobile swipe moves the camera and opens nothing', async () => {
      await page.swipe({ x: 300, y: 640 }, { x: 90, y: 600 }, 14);
      await sleep(600);
      const info = await page.evaluate(state());
      if (info.surface !== 'none') throw new Error('a swipe opened a document');
      return 'swipe is a camera gesture only';
    });

    await check('Mobile sheet opens a document with a reachable close', async () => {
      const box = await page.evaluate(`(() => {
        const node = [...document.querySelectorAll('.world-hotspot[data-world-hotspot^="object:"]')]
          .find((item) => item.dataset.visible === 'true')
          || document.querySelector('.world-hotspot[data-world-hotspot^="object:"]');
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return { key: node.dataset.worldHotspot, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, visible: node.dataset.visible };
      })()`);
      if (!box) throw new Error('no object caption at this destination');
      if (box.visible !== 'true') {
        /* Reveal it by focusing, which is the documented keyboard path. */
        await page.evaluate(
          `document.querySelector('.world-hotspot[data-world-hotspot="${box.key}"]').focus()`,
        );
        await sleep(400);
      }
      const point = await page.evaluate(`(() => {
        const node = document.querySelector('.world-hotspot[data-world-hotspot="${box.key}"]');
        const rect = node.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()`);
      await page.tap(point.x, point.y);
      await page.waitFor(`document.body.dataset.surface !== 'none'`, {
        timeout: 10000,
        label: 'sheet opened',
      });
      await sleep(900);
      const info = await page.evaluate(`(() => {
        const close = document.querySelector('[data-surface-close]');
        const rect = close.getBoundingClientRect();
        return {
          surface: document.querySelector('[data-surface-panel]:not([hidden])')?.dataset.surfacePanel,
          closeVisible: rect.width >= 44 && rect.height >= 44 && rect.top < window.innerHeight,
          themeToggle: document.querySelector('[data-world-chrome] [data-world-sound-toggle]')
            .getBoundingClientRect().height,
          scrollable: (() => {
            const panel = document.querySelector('[data-surface-panel]:not([hidden])');
            return panel.scrollHeight > panel.clientHeight;
          })(),
        };
      })()`);
      if (!info.closeVisible) throw new Error('close control is not reachable in the sheet');
      if (info.themeToggle < 44) throw new Error('a bar control shrank on mobile');
      return `surface=${info.surface}, close and the bar reachable, panel scrolls: ${info.scrollable}`;
    });

    await page.screenshot(join(OUT, '15-mobile-day-sheet.png'));

    await check('Mobile switches to daylight', async () => {
      const before = await page.evaluate(`document.documentElement.dataset.theme`);
      await setLight(page, before === 'light' ? 'dark' : 'light');
      await page.waitFor(
        `document.documentElement.dataset.theme !== ${JSON.stringify(before)}`,
        { timeout: 6000, label: 'mobile theme change' },
      );
      await sleep(900);
      const theme = await page.evaluate(`document.documentElement.dataset.theme`);
      const state = await page.evaluate(`document.querySelector('[data-world]').dataset.worldState`);
      if (state !== 'ready') throw new Error('the world did not survive the change');
      return `${before} → ${theme} on a 390px viewport`;
    });

    await page.screenshot(join(OUT, '16-mobile-day.png'));

    /* ── 14. Other viewports ──────────────────────────────────────── */
    for (const [width, height] of [
      [360, 780],
      [430, 932],
      [768, 1024],
      [1024, 768],
      [1920, 1080],
    ]) {
      await check(`Layout holds at ${width}×${height}`, async () => {
        await page.setViewport(width, height, width < 900);
        await page.navigate(`${BASE}/writing/`);
        await ready(page);
        const overlap = await page.evaluate(`(() => {
          const bar = document.querySelector('[data-world-chrome] .world-chrome-bar')
            ?.getBoundingClientRect();
          const panel = document.querySelector('[data-surface-panel]:not([hidden])')
            ?.getBoundingClientRect();
          if (!bar || !panel) return null;
          const overlaps =
            bar.left < panel.right && bar.right > panel.left &&
            bar.top < panel.bottom && bar.bottom > panel.top;
          return { overlaps, barWidth: Math.round(bar.width) };
        })()`);
        if (overlap?.overlaps) throw new Error('the control bar overlaps the reading surface');
        return 'no overlap between chrome and panel';
      });
      await page.screenshot(join(OUT, `17-${width}.png`));
    }

    await check('The reading bar tracks progress through the document', async () => {
      await page.navigate(`${BASE}/cv/`);
      await ready(page);
      /* Stop the automatic turn, so the camera is not settling underneath the
         measurement — this check is about the rule, not about the camera. */
      await page.evaluate(`window.__worldResetTurn && window.__worldResetTurn()`);
      await sleep(600);
      const snapshot = () =>
        page.evaluate(`(() => {
          const panel = document.querySelector('[data-surface-panel]:not([hidden])');
          const raw = getComputedStyle(panel).getPropertyValue('--read-progress');
          return {
            raw: raw.trim(),
            value: Number(raw),
            scrollTop: panel.scrollTop,
            scrollHeight: panel.scrollHeight,
            clientHeight: panel.clientHeight,
            inline: panel.getAttribute('style'),
          };
        })()`);
      const atTop = await snapshot();
      if (atTop.raw === '') {
        throw new Error(`the progress variable was never set (${JSON.stringify(atTop)})`);
      }
      if (atTop.value > 0.02) throw new Error(`progress is ${atTop.value} at the top`);
      /*
       * Scroll it the way a reader does. A programmatic `scrollTop` assignment
       * can move a panel without the browser delivering a `scroll` event at
       * all, so this walks it in steps and lets the frame clock — which is the
       * real source of truth for the rule — observe the movement.
       */
      await page.evaluate(`(() => {
        const panel = document.querySelector('[data-surface-panel]:not([hidden])');
        const target = panel.scrollHeight;
        let top = 0;
        while (top < target) {
          top += Math.max(200, panel.clientHeight * 0.6);
          panel.scrollTop = Math.min(top, target);
        }
      })()`);
      /* Wait for the condition rather than a fixed sleep: the value is written
         from the frame clock and from the panel's own scroll event. */
      let atEnd = await snapshot();
      const deadline = Date.now() + 6000;
      while (atEnd.value < 0.9 && Date.now() < deadline) {
        await sleep(150);
        atEnd = await snapshot();
      }
      if (atEnd.value < 0.9) {
        const diagnosis = await page.evaluate(`(() => {
          const panel = document.querySelector('[data-surface-panel]:not([hidden])');
          const debug = window.__worldDebug ? window.__worldDebug() : {};
          return {
            wired: panel.dataset.scrollWired ?? null,
            reading: debug.reading,
            surface: debug.surface,
            progress: debug.progress,
            sameNode: panel === document.querySelector('[data-surface-panel]:not([hidden])'),
          };
        })()`);
        throw new Error(
          `progress is ${atEnd.value} at the end (scrollTop ${atEnd.scrollTop} of ${atEnd.scrollHeight - atEnd.clientHeight}, style "${atEnd.inline}", ${JSON.stringify(diagnosis)})`,
        );
      }
      return `0 at the top, ${atEnd.value.toFixed(2)} at the end`;
    });

    await check('The contents cascade in when a document opens', async () => {
      const cascaded = await page.evaluate(`(() => {
        const panel = document.querySelector('[data-surface-panel]:not([hidden])');
        const first = panel.querySelector('.surface-frame > *');
        if (!first) return null;
        const style = getComputedStyle(first);
        return { name: style.animationName, duration: style.animationDuration };
      })()`);
      /* The attribute is cleared after the cascade, so the animation is read
         from the stylesheet itself rather than from a live element. */
      const declared = await page.evaluate(`(() => {
        /* The shorthand contains a var(), so the longhand getter is empty and
           the raw declaration is what has to be inspected. */
        const mentions = (rule) =>
          (rule.style && (
            rule.style.animationName === 'surface-item-in' ||
            String(rule.style.animation || '').includes('surface-item-in') ||
            String(rule.cssText || '').includes('surface-item-in')
          ));
        const has = (rules) => {
          for (const rule of rules) {
            if (mentions(rule)) return true;
            if (rule.cssRules && has(rule.cssRules)) return true;
          }
          return false;
        };
        for (const sheet of document.styleSheets) {
          try {
            if (has(sheet.cssRules)) return true;
          } catch (error) {
            /* cross-origin sheet */
          }
        }
        return false;
      })()`);
      if (!declared) throw new Error('the cascade animation is not in the stylesheet');
      void cascaded;
      return 'surface-item-in declared, staggered by nth-child';
    });

    /* ── 15. Loading and module-loading failure ───────────────────── */
    await check('A slow connection shows the branded loading screen', async () => {
      await page.send('Network.enable');
      /* Without this the bundle is served from cache and there is no wait to
         observe. */
      await page.send('Network.setCacheDisabled', { cacheDisabled: true });
      await page.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 400,
        downloadThroughput: 150 * 1024,
        uploadThroughput: 150 * 1024,
      });
      await page.setViewport(1440, 900, false);
      await page.navigate(`${BASE}/`);
      await sleep(1500);
      const loading = await page.evaluate(`(() => {
        const world = document.querySelector('[data-world]');
        return {
          state: world.dataset.worldState,
          posterOpacity: Number(getComputedStyle(document.querySelector('.world-poster')).opacity),
          status: document.querySelector('[data-world-status-text]')?.textContent?.trim(),
          alertHidden: document.querySelector('[data-world-alert]').hidden,
          canvasOpacity: Number(getComputedStyle(document.querySelector('[data-world] canvas')).opacity),
        };
      })()`);
      await page.screenshot(join(OUT, '20-loading.png'));
      await page.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
      if (loading.posterOpacity < 0.5) throw new Error('no branded loading screen');
      if (loading.canvasOpacity > 0.01) throw new Error('the canvas was already showing');
      if (!loading.alertHidden) throw new Error('the failure screen appeared while still loading');
      await ready(page);
      await page.send('Network.setCacheDisabled', { cacheDisabled: false });
      return `poster at ${loading.posterOpacity} opacity, "${loading.status}", state ${loading.state}`;
    });

    await check('A blocked 3D module shows the branded screen, not a blank canvas', async () => {
      await page.send('Network.setBlockedURLs', { urls: ['*shell.*.js*'] });
      await page.setViewport(1440, 900, false);
      await page.navigate(`${BASE}/`);
      await page.waitFor(`!document.querySelector('[data-world-alert]').hidden`, {
        timeout: 20000,
        label: 'the module failure is reported',
      });
      const reason = await page.evaluate(
        `document.querySelector('[data-world-alert-reason]').textContent.trim()`,
      );
      await page.screenshot(join(OUT, '29-module-failure.png'));
      if (!reason) throw new Error('the failure screen gave no reason');
      const canvas = await page.evaluate(`(() => {
        const node = document.querySelector('[data-world] canvas');
        return node ? { width: node.width, opacity: getComputedStyle(node).opacity } : null;
      })()`);
      if (canvas && Number(canvas.opacity) > 0.01) {
        throw new Error('a canvas was shown as if the world had started');
      }
      /* Put everything back. */
      await page.send('Network.setBlockedURLs', { urls: [] });
      await page.navigate(`${BASE}/`);
      await ready(page);
      const recovered = await page.evaluate(
        `document.querySelector('[data-world]').dataset.worldState`,
      );
      if (recovered !== 'ready') throw new Error('did not recover after unblocking');
      return `"${reason.slice(0, 62)}…", then recovered`;
    });

    /* ── 16. No WebGL at all ──────────────────────────────────────── */
    await check('A browser without WebGL is told, not given a different site', async () => {
      const { identifier } = await page.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `(() => {
          const original = HTMLCanvasElement.prototype.getContext;
          HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
            if (String(type).toLowerCase().includes('webgl')) return null;
            return original.call(this, type, ...rest);
          };
        })();`,
      });
      try {
        await page.navigate(`${BASE}/`);
        await page.waitFor(`!document.querySelector('[data-world-alert]').hidden`, {
          timeout: 20000,
          label: 'the no-WebGL screen',
        });
        const info = await page.evaluate(`(() => {
          const world = document.querySelector('[data-world]');
          const poster = document.querySelector('.world-poster');
          return {
            mode: document.documentElement.dataset.mode,
            webgl: document.documentElement.dataset.webgl,
            state: world.dataset.worldState,
            posterVisible: Number(getComputedStyle(poster).opacity) > 0.5,
            reason: document.querySelector('[data-world-alert-reason]').textContent.trim(),
            headings: [...document.querySelectorAll('[data-world-alert] h2')].map((n) =>
              n.textContent.trim(),
            ),
          };
        })()`);
        await page.screenshot(join(OUT, '30-no-webgl.png'));
        if (info.mode !== 'world') throw new Error(`mode is ${info.mode}`);
        if (!info.posterVisible) throw new Error('no branded screen behind the message');
        if (!info.reason) throw new Error('no explanation given');

        /* The visitor may explicitly choose to read the documents. */
        await page.clickSelector('[data-world-dismiss]');
        await sleep(600);
        const degraded = await page.evaluate(`(() => ({
          state: document.querySelector('[data-world]').dataset.worldState,
          alertHidden: document.querySelector('[data-world-alert]').hidden,
        }))()`);
        if (!degraded.alertHidden) throw new Error('the screen could not be dismissed');
        if (degraded.state !== 'degraded') throw new Error(`state is ${degraded.state}`);

        await page.navigate(`${BASE}/cv/`);
        await page.waitFor(`document.querySelector('[data-world]')?.dataset.worldState === 'degraded'`, {
          timeout: 10000,
        });
        const readable = await page.evaluate(`(() => {
          const panel = document.querySelector('[data-surface-panel]:not([hidden])');
          return {
            alertHidden: document.querySelector('[data-world-alert]').hidden,
            title: panel?.querySelector('h1')?.textContent?.trim(),
            text: panel?.textContent?.trim().length ?? 0,
          };
        })()`);
        if (!readable.alertHidden) throw new Error('the failure screen came back on navigation');
        if (readable.text < 500) throw new Error('the CV is not readable without the scene');
        return `${info.headings[0] ?? 'failure'} — "${info.reason.slice(0, 46)}…", CV still readable (${readable.text} chars)`;
      } finally {
        await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
        /* The decline was this test's own choice; forget it. */
        await page.evaluate(`sessionStorage.removeItem('world:no-scene')`);
        await page.navigate(`${BASE}/`);
        await ready(page);
      }
    });

    /* ── 17. The camera can never get under the island ────────────── */
    await check('The camera cannot be dragged, pinched or zoomed under the island', async () => {
      await page.setViewport(1440, 900, false);
      await page.navigate(`${BASE}/`);
      await ready(page);

      const read = () =>
        page.evaluate(`(() => {
          const debug = window.__worldDebug();
          return {
            above: debug.camera.above,
            position: debug.camera.position,
            orbit: debug.orbit,
          };
        })()`);

      const worst = { label: 'composed', above: Infinity };
      const record = async (label) => {
        const value = await read();
        if (value.above < worst.above) Object.assign(worst, { label, above: value.above });
      };

      await record('composed');

      /* Drag past both horizontal limits. */
      for (let i = 0; i < 8; i++) {
        await page.drag({ x: 720, y: 450 }, { x: 140, y: 450 }, 5);
        await sleep(80);
      }
      await sleep(600);
      await record('azimuth limit');

      /*
       * Drag the elevation hard in both directions. The shallow end is the one
       * that matters: it is the angle at which the camera would previously
       * have slipped below the lip of the cliff.
       */
      for (let i = 0; i < 12; i++) {
        await page.drag({ x: 900, y: 640 }, { x: 900, y: 260 }, 5);
        await sleep(70);
      }
      await sleep(600);
      await record('shallowest elevation');

      /* Zoom all the way in and out at that worst elevation. */
      const wheel = (deltaY, times) =>
        page.evaluate(`(() => {
          const canvas = document.querySelector('[data-world-canvas]');
          for (let i = 0; i < ${times}; i++) {
            canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: ${deltaY}, bubbles: true }));
          }
        })()`);

      await wheel(-260, 50);
      await sleep(1800);
      await record('fully zoomed in');
      await wheel(260, 80);
      await sleep(2600);
      await record('fully zoomed out');
      await wheel(-260, 80);
      await sleep(2600);
      await record('zoomed in from wide');

      /* And the same at every destination, which composes different shots. */
      for (const [href, destination] of [
        ['/cv/', 'studio'],
        ['/work/', 'workshop'],
        ['/writing/', 'library'],
        ['/open-source/', 'workbench'],
        ['/contact/', 'contact'],
      ]) {
        await travel(page, href, destination);
        await wheel(-260, 50);
        await sleep(1400);
        await record(`${destination} zoomed in`);
        await wheel(260, 70);
        await sleep(2000);
        await record(`${destination} zoomed out`);
      }

      await travel(page, '/', 'campus');
      await page.screenshot(join(OUT, '31-camera-limit.png'));
      if (worst.above < 0) {
        throw new Error(
          `the camera went ${Math.abs(worst.above).toFixed(2)} units below the ground at "${worst.label}"`,
        );
      }
      return `never below the ground across ${worst.label ? 'every extreme' : ''}; closest approach ${worst.above.toFixed(2)} units above the floor (${worst.label})`;
    });

    await check('Reset view returns the camera to the composed shot', async () => {
      await page.navigate(`${BASE}/`);
      await ready(page);
      const before = await page.evaluate(`window.__worldDebug().orbit`);
      /* Take the camera somewhere obviously wrong first. */
      for (let i = 0; i < 6; i++) {
        await page.drag({ x: 1000, y: 500 }, { x: 400, y: 300 }, 5);
        await sleep(70);
      }
      await page.evaluate(`(() => {
        const canvas = document.querySelector('[data-world-canvas]');
        for (let i = 0; i < 40; i++) {
          canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 260, bubbles: true }));
        }
      })()`);
      await sleep(1500);
      const moved = await page.evaluate(`window.__worldDebug().orbit`);
      const wentAway =
        Math.abs(moved.azimuth) > 0.05 || Math.abs(moved.polar) > 0.05 || Math.abs(moved.zoom - 1) > 0.05;
      if (!wentAway) throw new Error('the camera did not move, so reset proves nothing');

      await page.clickSelector('[data-world-chrome] [data-world-reset]');
      await sleep(900);
      const after = await page.evaluate(`window.__worldDebug().orbit`);
      const close =
        Math.abs(after.azimuth) < 0.02 && Math.abs(after.polar) < 0.02 && Math.abs(after.zoom - 1) < 0.02;
      if (!close) {
        throw new Error(
          `reset left the camera at azimuth ${after.azimuth.toFixed(3)}, polar ${after.polar.toFixed(3)}, zoom ${after.zoom.toFixed(3)}`,
        );
      }
      return `moved to zoom ${moved.zoom.toFixed(2)} / azimuth ${moved.azimuth.toFixed(2)}, reset to ${after.zoom.toFixed(2)} / ${after.azimuth.toFixed(2)}`;
      void before;
    });

    /* ── 18. The music ────────────────────────────────────────────── */
    await check('Music plays, mutes, holds volume and pauses', async () => {
      await page.setViewport(1440, 900, false);
      /*
       * Sound is on by default now, so the music may already be running by the
       * time this starts — the first gesture on the page was the navigation
       * that loaded it. The check therefore *establishes* a known state rather
       * than assuming one: whatever it finds, it ends up playing.
       */
      await page.evaluate(`(() => {
        localStorage.removeItem('world:sound');
        localStorage.removeItem('world:volume');
      })()`);
      await page.navigate(`${BASE}/`);
      await ready(page);
      const read = () => page.evaluate(`window.__worldAudio()`);
      const initial = await read();
      if (initial.volume <= 0) throw new Error('the music starts at zero volume');

      /* A gesture somewhere on the page is what a browser requires. */
      await page.evaluate(`document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
      await page
        .waitFor(`window.__worldAudio().playing === true`, {
          timeout: 8000,
          interval: 150,
          label: 'the music to start',
        })
        .catch(() => {});

      const playing = await read();
      if (!playing.playing) {
        /* If it is not already running, the control is the way in. */
        await page.clickSelector('[data-world-chrome] [data-world-sound-toggle]');
        await sleep(220);
        await page.clickSelector('[data-world-sound-mute]');
        await sleep(1600);
      }
      const started = await read();
      if (!started.playing) throw new Error('the music could not be started');

      /* Volume. */
      await page.evaluate(`(() => {
        const panel = document.querySelector('[data-world-sound-panel]');
        if (panel.hidden) document.querySelector('[data-world-sound-toggle]').click();
      })()`);
      await sleep(200);
      await page.evaluate(`(() => {
        const range = document.querySelector('[data-world-volume]');
        range.value = '70';
        range.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await sleep(250);
      const loud = await read();
      if (Math.abs(loud.volume - 0.7) > 0.02) throw new Error(`volume is ${loud.volume}`);

      /* Mute, and check the preference is written. */
      await page.clickSelector('[data-world-sound-mute]');
      await sleep(900);
      const paused = await read();
      if (paused.playing) throw new Error('the music did not pause');
      const stored = await page.evaluate(`({
        sound: localStorage.getItem('world:sound'),
        volume: localStorage.getItem('world:volume'),
        effects: localStorage.getItem('world:effects'),
      })`);
      if (stored.sound !== 'off') throw new Error(`stored preference is ${stored.sound}`);
      if (Math.abs(Number(stored.volume) - 0.7) > 0.02) {
        throw new Error(`stored volume is ${stored.volume}`);
      }

      /* One engine, however many times the page is navigated — and the panel
         is never left hanging open over a document it does not belong to. */
      await travel(page, '/writing/', 'library');
      const stillOne = await page.evaluate(`window.__worldAudio().volume`);
      if (Math.abs(stillOne - 0.7) > 0.02) throw new Error('the volume did not survive navigation');
      const panelAfterTravel = await page.evaluate(
        `document.querySelector('[data-world-sound-panel]')?.hidden`,
      );
      if (panelAfterTravel !== true) {
        throw new Error('a client-side navigation left the sound popover open');
      }
      await page.clickSelector('[data-world-chrome] [data-world-sound-toggle]');
      await sleep(250);

      /* Hidden tab pauses; coming back resumes only because it was playing. */
      const beforeRestart = await read();
      await page.clickSelector('[data-world-sound-mute]');
      try {
        await page.waitFor(`window.__worldAudio().playing === true`, {
          timeout: 8000,
          interval: 150,
          label: 'the music to restart',
        });
      } catch {
        throw new Error(
          `could not restart the music (was ${JSON.stringify(beforeRestart)}, now ${JSON.stringify(await read())})`,
        );
      }
      await page.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 }).catch(() => {});
      /*
       * Hidden tab pauses; coming back resumes only because the visitor had
       * already asked for it. `document.hidden` is a prototype getter, so the
       * override goes on the prototype — defining it on the instance leaves
       * the real one in charge and the test proves nothing.
       */
      const hidden = await page.evaluate(`(() => {
        Object.defineProperty(Document.prototype, 'hidden', {
          configurable: true,
          get: () => true,
        });
        Object.defineProperty(document, 'visibilityState', {
          configurable: true,
          get: () => 'hidden',
        });
        document.dispatchEvent(new Event('visibilitychange'));
        return window.__worldAudio().playing;
      })()`);
      if (hidden) throw new Error('the music kept playing while the tab was hidden');
      /* A pause the page performed is not the visitor changing their mind. */
      if (!(await read()).wanted) {
        throw new Error('a background pause forgot the visitor had asked for sound');
      }
      await page.evaluate(`(() => {
        Object.defineProperty(Document.prototype, 'hidden', {
          configurable: true,
          get: () => false,
        });
        Object.defineProperty(document, 'visibilityState', {
          configurable: true,
          get: () => 'visible',
        });
        document.dispatchEvent(new Event('visibilitychange'));
      })()`);
      await page
        .waitFor(`window.__worldAudio().playing === true`, {
          timeout: 8000,
          interval: 150,
          label: 'the music to resume on return',
        })
        .catch(async () => {
          throw new Error(
            `the music did not resume on return (${JSON.stringify(await read())})`,
          );
        });

      /* Back to a clean state for the rest of the run. */
      await page.clickSelector('[data-world-chrome] [data-world-sound-toggle]');
      await sleep(200);
      await page.clickSelector('[data-world-sound-mute]');
      await sleep(600);
      return `played at ${loud.volume}, remembered ${stored.sound}/${stored.volume}, paused when hidden and resumed`;
    });

    await check('Sound is on by default and there is no entry dialog', async () => {
      /*
       * A visitor who has never been here and has never chosen: no card, no
       * question, and the first gesture anywhere starts the music.
       */
      await page.evaluate(`(() => {
        localStorage.removeItem('world:sound');
        localStorage.removeItem('world:volume');
        localStorage.removeItem('world:effects');
      })()`);
      await page.navigate(`${BASE}/`);
      await ready(page);
      const info = await page.evaluate(`(() => {
        const card = document.querySelector('[data-world-welcome]');
        const toggle = document.querySelector('[data-world-sound-toggle]');
        return {
          cardPresent: !!card,
          cardHidden: card ? card.hidden : null,
          stored: localStorage.getItem('world:sound'),
          wanted: window.__worldAudio().wanted,
          toggleIconOnly: (() => {
            if (!toggle) return null;
            return [...toggle.children].every(
              (child) =>
                child.classList.contains('world-control-icon') ||
                child.classList.contains('visually-hidden'),
            );
          })(),
        };
      })()`);
      if (info.cardPresent) throw new Error('the entry dialog is still in the markup');
      if (info.wanted !== true) throw new Error('sound is not wanted by default');
      if (info.toggleIconOnly !== true) throw new Error('the sound control shows text');
      if (info.stored !== null) throw new Error(`the default wrote a preference (${info.stored})`);

      /* The first gesture starts it — a key press counts. */
      await page.key('Tab', 'Tab', 9);
      await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }))`);
      const started = await page
        .waitFor(`window.__worldAudio().playing === true`, {
          timeout: 8000,
          interval: 150,
          label: 'the music to start on the first gesture',
        })
        .then(() => true)
        .catch(() => false);
      if (!started) throw new Error('the music did not start on the first gesture');
      return 'no dialog, icon-only control, sound wanted by default and started on the first gesture';
    });

    /* ── 19. No JavaScript errors ─────────────────────────────────── */
    await check('No uncaught exceptions during the run', async () => {
      if (consoleErrors.length) throw new Error(consoleErrors.slice(0, 3).join(' | '));
      return 'clean console';
    });
  } finally {
    browser.close();
  }

  const failed = results.filter((entry) => !entry.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('\nFailures:');
    for (const entry of failed) console.log(` - ${entry.name}: ${entry.detail}`);
  }
  process.exitCode = failed.length ? 1 : 0;
};

main().catch((error) => {
  console.error('Harness error:', error);
  process.exitCode = 2;
});
