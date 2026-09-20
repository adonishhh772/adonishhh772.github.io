/**
 * A focused check of the music journey, on its own.
 *
 * The acceptance suite covers this inside a much longer run; this one exists
 * so that a change to the audio engine or its controls can be checked in
 * seconds rather than minutes, and so a failure says which step failed.
 *
 * Usage: node tools/worldcheck/music.mjs [baseUrl]
 */

import { launchBrowser, Page, sleep } from './cdp.mjs';

const BASE = process.argv[2] ?? 'http://localhost:4321';
const browser = await launchBrowser({ port: 9352 });
const page = await Page.open(browser.webSocketDebuggerUrl);

const read = () =>
  page.evaluate(`(() => ({
    audio: window.__worldAudio(),
    panelHidden: document.querySelector('[data-world-sound-panel]')?.hidden ?? null,
    mutePressed: document.querySelector('[data-world-sound-mute]')?.getAttribute('aria-pressed') ?? null,
    label: document.querySelector('[data-sound-label]')?.textContent ?? null,
    destination: document.querySelector('[data-world]')?.dataset.focus,
  }))()`);

const steps = [];
function record(name, value) {
  steps.push({ name, value });
  console.log(`${name.padEnd(22)} ${JSON.stringify(value)}`);
}

async function openPanel() {
  const hidden = await page.evaluate(
    `document.querySelector('[data-world-sound-panel]')?.hidden`,
  );
  if (!hidden) return;
  /*
   * Activate it the way a control is activated, rather than at a coordinate:
   * a click dispatched on the element runs its real listener, and the point of
   * this tool is the audio journey rather than hit-testing — `chrome-hit`
   * covered that, and `run.mjs` presses the real controls with real events.
   */
  await page.evaluate(`document.querySelector('[data-world-sound-toggle]').click()`);
  await page.waitFor(`document.querySelector('[data-world-sound-panel]')?.hidden === false`, {
    timeout: 4000,
    interval: 80,
    label: 'the sound panel to open',
  });
  await sleep(200);
}

try {
  await page.setViewport(1440, 900, false);
  await page.navigate(`${BASE}/`);
  await page.waitFor(
    `document.querySelector('[data-world]')?.dataset.worldState === 'ready'`,
    { timeout: 40000 },
  );
  await sleep(800);
  const welcome = await page.evaluate(
    `(() => { const el = document.querySelector('[data-world-welcome]'); return !!el && !el.hidden; })()`,
  );
  if (welcome) {
    await page.clickSelector('[data-world-enter="silent"]');
    await sleep(500);
  }

  record('initial', await read());

  await openPanel();
  await page.clickSelector('[data-world-sound-mute]');
  await sleep(1500);
  record('after play', await read());

  await page.evaluate(`(() => {
    const range = document.querySelector('[data-world-volume]');
    range.value = '70';
    range.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(300);
  record('after volume', await read());

  await page.clickSelector('[data-world-sound-mute]');
  await sleep(900);
  record('after pause', await read());

  /* Navigate the way a visitor would, and check the engine is the same one. */
  await page.evaluate(`(() => {
    const link = [...document.querySelectorAll('[data-world-map-menu] a')]
      .find((node) => node.getAttribute('href') === '/writing/');
    if (link) link.click();
  })()`);
  await page.waitFor(`document.querySelector('[data-world]')?.dataset.focus === 'library'`, {
    timeout: 20000,
  });
  await sleep(1000);
  record('after navigation', await read());

  await openPanel();
  /*
   * Activated on the element rather than at a coordinate. This tool is about
   * the audio journey; hit-testing the chrome is covered by `run.mjs`, which
   * presses the real controls with real pointer events.
   */
  await page.evaluate(`document.querySelector('[data-world-sound-mute]').click()`);
  await sleep(1400);
  record('after restart', await read());

  /* Hidden tab: pause, then resume because the visitor had asked for it. */
  await page.evaluate(`(() => {
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  })()`);
  await sleep(700);
  record('while hidden', await read());
  await page.evaluate(`(() => {
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  })()`);
  await page.waitFor(`window.__worldAudio().playing === true`, {
    timeout: 8000,
    interval: 150,
    label: 'the music to resume on return',
  });
  record('after return', await read());

  const stored = await page.evaluate(`({
    sound: localStorage.getItem('world:sound'),
    volume: localStorage.getItem('world:volume'),
  })`);
  record('stored', stored);

  const failures = [];
  const byName = (name) => steps.find((step) => step.name === name).value;
  if (byName('initial').audio.volume <= 0) failures.push('starts at zero volume');
  if (!byName('after play').audio.playing) failures.push('did not play on a press');
  if (Math.abs(byName('after volume').audio.volume - 0.7) > 0.02) failures.push('volume did not take');
  if (byName('after pause').audio.playing) failures.push('did not pause');
  if (Math.abs(byName('after navigation').audio.volume - 0.7) > 0.02) {
    failures.push('volume lost across navigation');
  }
  if (byName('after navigation').panelHidden !== true) {
    failures.push('popover left open across navigation');
  }
  if (!byName('after restart').audio.playing) failures.push('did not restart');
  if (byName('while hidden').audio.playing) failures.push('kept playing while hidden');
  /* A pause the page performed must not count as the visitor changing their
     mind — that is why `wanted` survives it. */
  if (!byName('while hidden').audio.wanted) failures.push('a background pause forgot the request');
  if (!byName('after return').audio.playing) failures.push('did not resume on return');
  if (stored.volume !== '0.7') failures.push(`volume not stored (${stored.volume})`);
  if (failures.length) {
    console.log(`\nFAILED: ${failures.join('; ')}`);
    process.exitCode = 1;
  } else {
    console.log('\nAll music steps passed.');
  }
} finally {
  browser.close();
}
