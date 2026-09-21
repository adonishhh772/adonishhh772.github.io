/**
 * Evaluate an expression in the running world.
 *
 * A one-line REPL against a real page: navigates, waits for the world to be
 * ready, then evaluates whatever was passed and prints the result. Useful for
 * questions a screenshot cannot answer — "how high is the ground here?", "what
 * does the theme think the sun is doing?" — without writing a whole suite.
 *
 * Usage:
 *   node tools/worldcheck/eval.mjs [baseUrl] "expression"
 *   node tools/worldcheck/eval.mjs http://localhost:4321 "window.__worldDebug().sky"
 *   node tools/worldcheck/eval.mjs http://localhost:4321 --hour 22 "document.title"
 */

import { launchBrowser, Page, sleep } from './cdp.mjs';

const args = process.argv.slice(2);
const BASE = args.find((arg) => arg.startsWith('http')) ?? 'http://localhost:4321';
const hourIndex = args.indexOf('--hour');
const hour = hourIndex >= 0 ? Number(args[hourIndex + 1]) : null;
const expression = args.filter((arg, index) => {
  if (arg.startsWith('http')) return false;
  if (arg === '--hour' || index === hourIndex + 1) return false;
  return true;
}).join(' ');

const main = async () => {
  const browser = await launchBrowser({ port: 9370 });
  const page = await Page.open(browser.webSocketDebuggerUrl);
  try {
    await page.setViewport(1200, 800);
    await page.navigate(`${BASE}/`);
    await page.waitFor(`document.querySelector('[data-world]')?.dataset.worldState === 'ready'`, {
      timeout: 180000,
      label: 'world ready',
    });
    await sleep(800);
    if (hour !== null) {
      await page.evaluate(`window.__worldSkyTime(${hour})`);
      await sleep(1400);
    }
    const value = await page.evaluate(`(async () => (${expression}))()`);
    console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  } finally {
    browser.close();
  }
};

main().catch((error) => {
  console.error('eval failed:', error.message);
  process.exitCode = 1;
});
