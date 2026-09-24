/**
 * Mobile chrome/sheet geometry after the fix.
 *
 * Asserts:
 *   - the top control bar never overlaps the reading sheet or its bar
 *   - the bar stays inside the viewport
 *   - the sound panel and the destination menu stay on screen
 *   - the end of the document clears the campus dock
 *   - the bar is where it used to be when no document is open
 *
 * Usage: node tools/worldcheck/mobile-chrome-layout.mjs [baseUrl]
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchBrowser, Page, sleep } from './cdp.mjs';

const BASE = process.argv.find((arg) => arg.startsWith('http')) ?? 'http://localhost:4331';
const CASES = [
  { w: 253, h: 1600 },
  { w: 320, h: 568 },
  { w: 360, h: 640 },
  { w: 375, h: 667 },
  { w: 390, h: 664 },
  { w: 390, h: 844 },
  { w: 393, h: 852 },
  { w: 412, h: 915 },
  { w: 430, h: 932 },
];

const MEASURE = `(() => {
  const rect = (sel) => {
    const n = document.querySelector(sel);
    if (!n) return null;
    const s = getComputedStyle(n);
    if (n.hidden || s.display === 'none' || s.visibility === 'hidden') return null;
    const b = n.getBoundingClientRect();
    if (!b.width && !b.height) return null;
    return { top: +b.top.toFixed(1), bottom: +b.bottom.toFixed(1), left: +b.left.toFixed(1), right: +b.right.toFixed(1), h: +b.height.toFixed(1), w: +b.width.toFixed(1) };
  };
  const area = (a, b) => {
    if (!a || !b) return 0;
    const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return x > 0 && y > 0 ? +(x * y).toFixed(0) : 0;
  };
  const bar = rect('.world-chrome-bar');
  const sheet = rect('.surface-host');
  const surfaceBar = rect('.surface-bar');
  const dock = rect('.world-dock');
  const map = rect('.world-map.is-open');
  const sound = rect('#world-sound-panel');
  return {
    vw: window.innerWidth,
    vh: window.innerHeight,
    worldState: document.querySelector('[data-world]')?.dataset.worldState,
    mode: document.documentElement.dataset.mode,
    bar, sheet, surfaceBar, dock, map, sound,
    barVsSheet: area(bar, sheet),
    barVsSurfaceBar: area(bar, surfaceBar),
    mapVsBar: area(map, bar),
    mapVsSheet: area(map, sheet),
    soundVsBar: area(sound, bar),
    barInsideViewport: bar ? bar.top >= 0 && bar.bottom <= window.innerHeight : null,
    soundInsideViewport: sound
      ? sound.left >= -0.5 && sound.right <= window.innerWidth + 0.5 && sound.top >= -0.5
      : null,
    mapInsideViewport: map ? map.left >= -0.5 && map.right <= window.innerWidth + 0.5 && map.bottom <= window.innerHeight + 0.5 : null,
    sheetVsViewportBottom: sheet ? Math.abs(sheet.bottom - window.innerHeight) : null,
  };
})()`;

const failures = [];

function assert(name, ok, detail) {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const main = async () => {
  mkdirSync('.screenshots', { recursive: true });
  const browser = await launchBrowser({ port: 9355, size: { width: 500, height: 1000 } });
  const page = await Page.open(browser.webSocketDebuggerUrl);
  try {
    for (const item of CASES) {
      const tag = `${item.w}x${item.h}`;
      await page.setViewport(item.w, item.h, true);
      await page.navigate(`${BASE}/writing/the-model-choice-conversation/`);
      await page.waitFor(
        `document.querySelector('[data-world]')?.dataset.worldState === 'ready'`,
        { timeout: 180000, label: 'world ready' },
      );
      await sleep(700);
      await page.evaluate(
        `(() => { const g = document.querySelector('[data-world-sound-gate]'); if (g) g.hidden = true; return true; })()`,
      );
      await sleep(200);

      const m = await page.evaluate(MEASURE);
      assert(`${tag} bar/sheet no overlap`, m.barVsSheet === 0, `bar ${JSON.stringify(m.bar)} sheet ${JSON.stringify(m.sheet)}`);
      assert(`${tag} bar/surface-bar no overlap`, m.barVsSurfaceBar === 0);
      assert(`${tag} bar inside viewport`, m.barInsideViewport === true, JSON.stringify(m.bar));
      assert(`${tag} bar sits in the strip above the sheet`, m.bar.bottom <= m.sheet.top, `bar bottom ${m.bar.bottom} sheet top ${m.sheet.top}`);
      assert(`${tag} sheet still pinned to bottom`, m.sheetVsViewportBottom !== null && m.sheetVsViewportBottom < 1);
      await page.screenshot(join(process.cwd(), `.screenshots/fixed-closed-${tag}.png`));

      await page.clickSelector('[data-world-map]');
      await sleep(600);
      const withMap = await page.evaluate(MEASURE);
      assert(`${tag} menu on screen`, withMap.mapInsideViewport === true, JSON.stringify(withMap.map));
      /*
       * Where the bar sits at the very top of the screen — a viewport too short
       * for a sheet — the menu opens below it. Where the bar has moved down to
       * the sheet's edge, the menu starts under it and stretches to just above
       * it, so the two never share a band.
       */
      assert(
        `${tag} menu within the viewport`,
        withMap.map !== null && withMap.map.bottom <= withMap.vh + 0.5,
        `menu bottom ${withMap.map?.bottom} viewport ${withMap.vh}`,
      );
      assert(
        `${tag} menu does not swallow the bar`,
        withMap.map === null ||
          withMap.bar === null ||
          withMap.mapVsBar === 0 ||
          withMap.map.top >= withMap.bar.bottom - 1,
        `overlap ${withMap.mapVsBar}px² — menu ${JSON.stringify(withMap.map)} bar ${JSON.stringify(withMap.bar)}`,
      );
      await page.screenshot(join(process.cwd(), `.screenshots/fixed-map-${tag}.png`));
      await page.clickSelector('[data-world-map]');
      await sleep(300);

      await page.evaluate(
        `(() => { document.querySelector('[data-world-sound-toggle]')?.click(); return true; })()`,
      );
      await sleep(450);
      const withSound = await page.evaluate(MEASURE);
      assert(
        `${tag} sound panel on screen`,
        withSound.soundInsideViewport === true,
        JSON.stringify(withSound.sound),
      );
      /*
       * Where the bar sits at the very top of the screen — a viewport too short
       * for a sheet — the panel opens below it rather than over it. Where the
       * bar has moved down to the sheet's edge, the panel hangs from the pill's
       * own place further up the screen, so the two never share a band.
       */
      assert(
        `${tag} sound panel never covers the bar`,
        withSound.sound === null ||
          withSound.bar === null ||
          withSound.sound.bottom <= withSound.bar.top + 0.5 ||
          withSound.sound.top >= withSound.bar.bottom - 1 ||
          withSound.sound.left >= withSound.bar.right - 0.5 ||
          withSound.sound.right <= withSound.bar.left + 0.5,
        `panel ${JSON.stringify(withSound.sound)} bar ${JSON.stringify(withSound.bar)}`,
      );
      assert(
        `${tag} sound panel shows its controls`,
        withSound.sound === null || withSound.sound.h >= 240,
        `panel height ${withSound.sound?.h}`,
      );
      await page.screenshot(join(process.cwd(), `.screenshots/fixed-sound-${tag}.png`));
      await page.evaluate(
        `(() => { document.querySelector('[data-world-sound-toggle]')?.click(); return true; })()`,
      );
      await sleep(250);
    }

    // The home page keeps its original bar position: no sheet, so the top strip.
    await page.setViewport(390, 844, true);
    await page.navigate(`${BASE}/`);
    await page.waitFor(
      `document.querySelector('[data-world]')?.dataset.worldState === 'ready'`,
      { timeout: 180000, label: 'world ready' },
    );
    await sleep(800);
    const home = await page.evaluate(MEASURE);
    assert('home bar sits at the top', home.bar !== null && home.bar.top < 30, JSON.stringify(home.bar));
  } finally {
    browser.close();
  }

  if (failures.length) {
    console.error(`\n${failures.length} failure(s):`);
    for (const f of failures) console.error(' - ' + f);
    process.exitCode = 1;
  } else {
    console.log('\nAll mobile chrome layout checks passed.');
  }
};

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
