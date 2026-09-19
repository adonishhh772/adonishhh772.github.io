/**
 * Screenshot gallery.
 *
 * Captures each destination, each kind of reading surface, the loading and
 * failure states, and the phone layouts — always after the camera and the
 * light have settled, so the images show the real thing rather than a frame
 * in the middle of a transition.
 *
 * Usage: node tools/worldcheck/gallery.mjs [baseUrl]
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchBrowser, Page, sleep } from './cdp.mjs';

const BASE = process.argv[2] ?? 'http://localhost:4321';
const OUT = '.screenshots/world';

mkdirSync(OUT, { recursive: true });
const browser = await launchBrowser({ port: 9346 });
const page = await Page.open(browser.webSocketDebuggerUrl);

async function ready() {
  await page.waitFor(`document.querySelector('[data-world]')?.dataset.worldState === 'ready'`, {
    timeout: 30000,
  });
  await sleep(1800);
}

/** Choosing a destination from the map is how a visitor travels. */
async function travel(href, destination) {
  await page.evaluate(`(() => {
    const link = [...document.querySelectorAll('[data-world-map-menu] a')]
      .find((node) => node.getAttribute('href') === ${JSON.stringify(href)});
    if (link) link.click();
  })()`);
  await page.waitFor(`document.body.dataset.destination === ${JSON.stringify(destination)}`, {
    timeout: 20000,
  });
  await ready();
}

try {
  await page.setViewport(1440, 900);
  await page.navigate(`${BASE}/`);
  await ready();

  /* A first visit: the poster and the status pill while the world builds. */
  await page.evaluate(`document.querySelector('[data-world]').dataset.worldState = 'loading'`);
  await sleep(400);
  await page.screenshot(join(OUT, '20-loading.png'));
  await page.evaluate(`document.querySelector('[data-world]').dataset.worldState = 'ready'`);
  await sleep(600);

  /* Night overview, then daylight. */
  await page.evaluate(`(() => {
    const root = document.documentElement;
    if (root.dataset.theme !== 'dark') {
      root.dataset.theme = 'dark';
      document.dispatchEvent(new CustomEvent('world:themechange', { detail: { theme: 'dark', animate: true } }));
    }
  })()`);
  await sleep(1200);
  await page.screenshot(join(OUT, '01-overview-night.png'));

  await page.clickSelector('[data-world-chrome] [data-theme-toggle]');
  await sleep(1400);
  await page.screenshot(join(OUT, '02-overview-day.png'));

  /* Every destination, in daylight. */
  const destinations = [
    ['/cv/', 'studio', '03-studio'],
    ['/work/', 'workshop', '21-workshop'],
    ['/writing/', 'library', '22-library'],
    ['/open-source/', 'workbench', '23-workbench'],
    ['/contact/', 'contact', '11-contact'],
  ];
  for (const [href, destination, name] of destinations) {
    await travel(href, destination);
    await page.screenshot(join(OUT, `${name}.png`));
  }

  /* Night, one destination at a time, to show the practical lights. */
  await page.clickSelector('[data-world-chrome] [data-theme-toggle]');
  await sleep(1400);
  await travel('/writing/', 'library');
  await page.screenshot(join(OUT, '24-library-night.png'));
  await travel('/contact/', 'contact');
  await page.screenshot(join(OUT, '25-contact-night.png'));
  await page.clickSelector('[data-world-chrome] [data-theme-toggle]');
  await sleep(1400);

  /* Reading surfaces: the CV, the archive, a full article, a case study. */
  await page.navigate(`${BASE}/cv/`);
  await ready();
  await page.screenshot(join(OUT, '04-cv-open.png'));

  await travel('/writing/', 'library');
  await page.screenshot(join(OUT, '26-article-archive.png'));

  await page.navigate(`${BASE}/writing/from-demo-to-dependable/`);
  await ready();
  await page.screenshot(join(OUT, '09-article.png'));

  await page.navigate(`${BASE}/work/kai/`);
  await ready();
  await page.screenshot(join(OUT, '10-case-study.png'));

  await page.navigate(`${BASE}/writing/voice-ai-cascade-elevenlabs-direct/`);
  await ready();
  await page.evaluate(`(() => {
    const panel = document.querySelector('[data-surface-panel]:not([hidden])');
    panel.scrollTop = panel.scrollHeight - panel.clientHeight - 120;
  })()`);
  await sleep(700);
  await page.screenshot(join(OUT, '27-newsletter.png'));

  /* The map menu. */
  await page.navigate(`${BASE}/`);
  await ready();
  await page.clickSelector('[data-world-chrome] [data-world-map]');
  await sleep(500);
  await page.screenshot(join(OUT, '07-map-menu.png'));
  await page.key('Escape', 'Escape', 27);
  await sleep(300);

  /* Phones. */
  await page.clickSelector('[data-world-chrome] [data-theme-toggle]');
  await sleep(1400);
  await page.navigate(`${BASE}/`);
  await ready();
  await page.setViewport(390, 844, true);
  await page.navigate(`${BASE}/`);
  await ready();
  await page.screenshot(join(OUT, '14-mobile-night.png'));

  await page.clickSelector('[data-world-chrome] [data-theme-toggle]');
  await sleep(1400);
  await page.screenshot(join(OUT, '16-mobile-day.png'));

  await page.evaluate(`(() => {
    const link = [...document.querySelectorAll('[data-world-map-menu] a')]
      .find((node) => node.getAttribute('href') === '/work/');
    if (link) link.click();
  })()`);
  await page.waitFor(`document.body.dataset.destination === 'workshop'`, { timeout: 20000 });
  await ready();
  await page.screenshot(join(OUT, '15-mobile-day-sheet.png'));

  await page.setViewport(768, 1024, true);
  await page.navigate(`${BASE}/cv/`);
  await ready();
  await page.screenshot(join(OUT, '28-tablet-cv.png'));

  console.log('gallery captured');
} finally {
  browser.close();
}
