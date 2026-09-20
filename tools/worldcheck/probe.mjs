/**
 * A one-page probe: load the world, read back a named geometry, print it.
 *
 * Usage: node tools/worldcheck/probe.mjs [baseUrl] [meshName]
 */

import { launchBrowser, Page, sleep } from './cdp.mjs';

const BASE = process.argv[2] ?? 'http://localhost:4321';
const NAME = process.argv[3] ?? 'island';

const browser = await launchBrowser({ port: 9336 });
const page = await Page.open(browser.webSocketDebuggerUrl);
try {
  await page.setViewport(1200, 800, false);
  await page.navigate(`${BASE}/`);
  await page.waitFor(
    `document.querySelector('[data-world]')?.dataset.worldState === 'ready'`,
    { timeout: 40000, label: 'world ready' },
  );
  await sleep(1200);
  const welcome = await page.evaluate(
    `(() => { const el = document.querySelector('[data-world-welcome]'); return !!el && !el.hidden; })()`,
  );
  if (welcome) {
    await page.clickSelector('[data-world-enter="silent"]');
    await sleep(500);
  }
  const result = await page.evaluate(`window.__worldGeometry(${JSON.stringify(NAME)})`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  browser.close();
}
