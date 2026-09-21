/**
 * Look at the world.
 *
 * One browser, one page load, a handful of screenshots at chosen hours. The
 * verification suites are for proving claims; this is for answering the question
 * a suite cannot — "does it actually look right?" — in a few seconds rather than
 * a few minutes.
 *
 * Usage:  node tools/worldcheck/look.mjs [baseUrl] [hour ...]
 *         node tools/worldcheck/look.mjs http://localhost:4321 8 12 19 1
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchBrowser, Page, sleep } from './cdp.mjs';

const BASE = process.argv[2] ?? 'http://localhost:4321';
const hours = process.argv.slice(3).map(Number).filter(Number.isFinite);
const HOURS = hours.length ? hours : [12, 8, 19.3, 21];
const OUT = '.screenshots/look';

const main = async () => {
  mkdirSync(OUT, { recursive: true });
  const browser = await launchBrowser({ port: 9350 });
  const page = await Page.open(browser.webSocketDebuggerUrl);
  const errors = [];
  page.onEvent = (message) => {
    if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params.exceptionDetails?.exception?.description ?? 'exception');
    }
  };

  try {
    await page.setViewport(1600, 1000);
    await page.navigate(`${BASE}/`);
    await page.waitFor(
      `document.querySelector('[data-world]')?.dataset.worldState === 'ready'`,
      { timeout: 180000, label: 'world ready' },
    );
    await sleep(1500);
    await page.evaluate(`window.__worldResetTurn && window.__worldResetTurn()`);

    for (const hour of HOURS) {
      await page.evaluate(`window.__worldSkyTime(${hour})`);
      await page.evaluate(`window.__worldResetTurn && window.__worldResetTurn()`);
      await sleep(1600);
      const file = join(OUT, `h${String(hour).replace('.', '-')}.png`);
      await page.screenshot(file);
      const info = await page.evaluate(`window.__worldDebug()`);
      const sky = info.sky;
      console.log(
        `${file}  ${sky.label}  sun ${sky.sunAltitude.toFixed(1)}°/${sky.sunAzimuth.toFixed(0)}°  ` +
          `moon ${sky.moonAltitude.toFixed(1)}°  ${(sky.moonIllumination * 100).toFixed(0)}% ${sky.moonPhase}  ` +
          `frameTop ${(info.rotation.pitch + info.rotation.fov / 2).toFixed(1)}°`,
      );
    }

    /* And one frame with the camera turned to the sun, to see the disc itself. */
    await page.evaluate(`window.__worldSkyTime(8)`);
    await sleep(900);
    const sky = await page.evaluate(`window.__worldDebug().sky`);
    await page.evaluate(`window.__worldLookAt(${sky.sunAzimuth}, ${sky.sunAltitude})`);
    await sleep(1800);
    await page.screenshot(join(OUT, 'sun-disc.png'));
    console.log(`${join(OUT, 'sun-disc.png')}  turned toward the sun`);

    if (errors.length) console.log('ERRORS:', errors.slice(0, 3).join(' | '));
    else console.log('no exceptions');
  } finally {
    browser.close();
  }
};

main().catch((error) => {
  console.error('look failed:', error.message);
  process.exitCode = 1;
});
