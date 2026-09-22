/**
 * Quick local check: mobile identity caption vs top chrome (no overlap / clipped eyebrow).
 *
 * Usage: node tools/worldcheck/mobile-identity.mjs [baseUrl]
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchBrowser, Page, sleep } from './cdp.mjs';

const BASE = process.argv.find((arg) => arg.startsWith('http')) ?? 'http://localhost:4321';
const OUT = '.screenshots/mobile-identity-check.png';

async function ready(page) {
  await page.waitFor(
    `document.querySelector('[data-world]')?.dataset.worldState === 'ready'`,
    { timeout: 180000, label: 'world ready' },
  );
  await sleep(1200);
}

const main = async () => {
  mkdirSync('.screenshots', { recursive: true });
  const browser = await launchBrowser({ port: 9337, size: { width: 390, height: 844 } });
  const page = await Page.open(browser.webSocketDebuggerUrl);

  try {
    await page.setViewport(390, 844, true);
    await page.navigate(`${BASE}/`);
    await ready(page);

    const layout = await page.evaluate(`(() => {
      const identity = document.querySelector('.world-identity');
      const bar = document.querySelector('.world-chrome-bar');
      const name = document.querySelector('.identity-name');
      const eyebrow = document.querySelector('.identity-eyebrow-role');
      const headline = document.querySelector('.identity-headline');
      const tip = document.querySelector('.world-live-tip');
      const ir = identity?.getBoundingClientRect();
      const br = bar?.getBoundingClientRect();
      const nr = name?.getBoundingClientRect();
      const er = eyebrow?.getBoundingClientRect();
      const hr = headline?.getBoundingClientRect();
      const tr = tip?.getBoundingClientRect();
      const intersects = (a, b) =>
        a && b &&
        a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      const eyebrowStyle = eyebrow ? getComputedStyle(eyebrow) : null;
      const loc = document.querySelector('.identity-eyebrow-location');
      const locStyle = loc ? getComputedStyle(loc) : null;
      return {
        mode: document.documentElement.dataset.mode,
        nameText: name?.textContent?.trim(),
        eyebrowText: eyebrow?.textContent?.trim(),
        headlineDisplay: hr ? getComputedStyle(headline).display : null,
        locationDisplay: locStyle?.display ?? null,
        identityBarOverlap: intersects(ir, br),
        nameBarOverlap: intersects(nr, br),
        eyebrowBarOverlap: intersects(er, br),
        nameTipOverlap: intersects(nr, tr),
        eyebrowRight: er?.right ?? null,
        barLeft: br?.left ?? null,
        paddingRight: identity ? getComputedStyle(identity).paddingRight : null,
      };
    })()`);

    await page.screenshot(join(process.cwd(), OUT));

    console.log('Mobile identity layout @', BASE);
    console.log(JSON.stringify(layout, null, 2));
    console.log('Screenshot:', OUT);

    const failures = [];
    if (layout.mode !== 'world') failures.push(`expected data-mode=world, got ${layout.mode}`);
    if (layout.headlineDisplay !== 'none') failures.push(`headline should be hidden on mobile, got ${layout.headlineDisplay}`);
    if (layout.locationDisplay !== 'none') failures.push(`location should be hidden on mobile, got ${layout.locationDisplay}`);
    if (layout.identityBarOverlap) failures.push('identity block overlaps chrome bar');
    if (layout.nameBarOverlap) failures.push('name overlaps chrome bar');
    if (layout.eyebrowBarOverlap) failures.push('eyebrow overlaps chrome bar');
    if (layout.nameTipOverlap) failures.push('name overlaps Gather tip');
    const identityTop = await page.evaluate(
      `document.querySelector('.world-identity')?.getBoundingClientRect().top`,
    );
    const barBottom = await page.evaluate(
      `document.querySelector('.world-chrome-bar')?.getBoundingClientRect().bottom`,
    );
    if (identityTop != null && barBottom != null && identityTop < barBottom - 2) {
      failures.push(`identity sits under chrome bar (identity top ${identityTop}, bar bottom ${barBottom})`);
    }

    const barCenter = await page.evaluate(`(() => {
      const bar = document.querySelector('.world-chrome-bar');
      if (!bar) return null;
      const rect = bar.getBoundingClientRect();
      return rect.left + rect.width / 2;
    })()`);
    const viewportCenter = 390 / 2;
    if (barCenter != null && Math.abs(barCenter - viewportCenter) > 24) {
      failures.push(`chrome bar not centered (bar center ${barCenter}, viewport ${viewportCenter})`);
    }

    if (failures.length) {
      console.error('FAILED:', failures.join('; '));
      process.exitCode = 1;
    } else {
      console.log('OK: mobile identity clears chrome and tip.');
    }
  } finally {
    browser.close();
  }
};

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
