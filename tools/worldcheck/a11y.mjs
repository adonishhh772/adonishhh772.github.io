/**
 * Focus management in the world.
 *
 * Walks the keyboard path a visitor would take: Tab to a caption, open a
 * document, confirm focus lands inside it, close it, and confirm focus comes
 * back to where it started. Also proves the panel scrolls independently of
 * the camera and that the printed CV is a whole document rather than the
 * visible slice of a fixed panel.
 *
 * Usage: node tools/worldcheck/a11y.mjs [baseUrl]
 */

import { launchBrowser, Page, sleep } from './cdp.mjs';

const BASE = process.argv[2] ?? 'http://localhost:4321';
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function check(name, fn) {
  try {
    record(name, true, await fn());
  } catch (error) {
    record(name, false, error.message);
  }
}

const browser = await launchBrowser({ port: 9341 });
const page = await Page.open(browser.webSocketDebuggerUrl);

try {
  await page.setViewport(1440, 900);
  await page.navigate(`${BASE}/`);
  await page.waitFor(`document.querySelector('[data-world]')?.dataset.worldState === 'ready'`, {
    timeout: 30000,
  });
  await sleep(1500);

  await check('A caption can be reached by keyboard and opened with Enter', async () => {
    await page.evaluate(`(() => {
      const node = document.querySelector('.world-hotspot[data-world-hotspot="place:studio"]');
      node.focus();
    })()`);
    await sleep(300);
    const revealed = await page.evaluate(
      `document.querySelector('.world-hotspot[data-world-hotspot="place:studio"]').dataset.visible`,
    );
    if (revealed !== 'true') throw new Error('focusing a caption did not reveal it');
    await page.evaluate(
      `document.querySelector('.world-hotspot[data-world-hotspot="place:studio"]').click()`,
    );
    await page.waitFor(`document.querySelector('[data-world]').dataset.focus === 'studio'`, {
      timeout: 8000,
    });
    await sleep(1200);
    await page.evaluate(`(() => {
      const node = document.querySelector('.world-hotspot[data-world-hotspot="object:cv:cv"]');
      node.focus();
    })()`);
    await sleep(300);
    await page.key('Enter', 'Enter', 13);
    await page.waitFor(`document.body.dataset.surface === 'cv'`, { timeout: 8000 });
    await sleep(1200);
    return 'caption → studio → CV';
  });

  await check('Focus lands inside the opened document', async () => {
    await page.waitFor(`document.body.dataset.surface === 'cv'`, { timeout: 8000 });
    const active = await page.evaluate(`(() => {
      const node = document.activeElement;
      return { tag: node.tagName, text: (node.textContent || '').trim().slice(0, 40) };
    })()`);
    const insidePanel = await page.evaluate(
      `!!document.activeElement.closest('[data-surface-panel]')`,
    );
    if (!insidePanel) throw new Error(`focus is on ${active.tag}/${active.text}`);
    return `${active.tag}: "${active.text}"`;
  });

  await check('Escape closes the document and returns focus to the world', async () => {
    await page.key('Escape', 'Escape', 27);
    await page.waitFor(`document.body.dataset.surface !== 'cv'`, { timeout: 8000 });
    await sleep(1400);
    const focus = await page.evaluate(`(() => {
      const node = document.activeElement;
      if (!node || node === document.body) return null;
      return {
        hotspot: node.dataset ? node.dataset.worldHotspot ?? null : null,
        cls: typeof node.className === 'string' ? node.className : '',
        label:
          node.getAttribute('aria-label') ||
          (node.textContent || '').trim().slice(0, 40) ||
          node.getAttribute('title') ||
          '',
      };
    })()`);
    /* Either the caption it came from (when that caption still exists at the
       destination we returned to), or a labelled control in the chrome. */
    if (!focus) throw new Error('focus fell back to the document body');
    if (!focus.hotspot && !focus.label) {
      throw new Error(`focus went to an unlabelled ${focus.cls}`);
    }
    return focus.hotspot ? `focus restored to ${focus.hotspot}` : `focus on "${focus.label}"`;
  });

  await check('Closing returns focus to the caption it was opened from', async () => {
    await page.navigate(`${BASE}/writing/`);
    await page.waitFor(`document.querySelector('[data-world]')?.dataset.worldState === 'ready'`, {
      timeout: 30000,
    });
    await sleep(1600);
    const opened = await page.evaluate(`(() => {
      const node = [...document.querySelectorAll('.world-hotspot[data-world-hotspot^="object:article:"]')]
        .find((item) => item.dataset.visible === 'true');
      if (!node) return null;
      node.focus();
      node.click();
      return node.dataset.worldHotspot;
    })()`);
    if (!opened) throw new Error('no visible article caption at the library');
    await page.waitFor(`document.body.dataset.surface === 'article'`, { timeout: 10000 });
    await sleep(1200);
    await page.key('Escape', 'Escape', 27);
    await page.waitFor(`document.body.dataset.surface === 'articles'`, { timeout: 10000 });
    await sleep(1400);
    const restored = await page.evaluate(`(() => {
      const node = document.activeElement;
      return node && node.dataset ? node.dataset.worldHotspot ?? null : null;
    })()`);
    if (restored !== opened) throw new Error(`focus went to ${restored}, expected ${opened}`);
    return `${opened} → article → Escape → ${restored}`;
  });

  await check('Panel scroll is independent of the camera', async () => {
    await page.navigate(`${BASE}/cv/`);
    await page.waitFor(`document.querySelector('[data-world]')?.dataset.worldState === 'ready'`, {
      timeout: 30000,
    });
    await sleep(1500);
    const before = await page.evaluate(`window.__worldDebug().orbit`);
    await page.evaluate(
      `document.querySelector('[data-surface-panel]').scrollTop = 900`,
    );
    await sleep(500);
    const after = await page.evaluate(`window.__worldDebug().orbit`);
    const scroll = await page.evaluate(
      `document.querySelector('[data-surface-panel]').scrollTop`,
    );
    if (scroll < 800) throw new Error(`panel did not scroll (${scroll})`);
    if (before.zoom !== after.zoom || before.azimuth !== after.azimuth) {
      throw new Error('scrolling the panel moved the camera');
    }
    return `panel scrolled ${scroll}px, camera untouched`;
  });

  await check('Keyboard focus is visible on a control in the bar', async () => {
    /* Via the keyboard, so `:focus-visible` matches the way it does for a
       visitor tabbing rather than a script calling focus(). */
    await page.evaluate(`document.querySelector('[data-world-chrome] [data-world-map]').focus()`);
    await page.key('Tab', 'Tab', 9);
    await page.key('Tab', 'Tab', 9, { shift: true });
    const outline = await page.evaluate(`(() => {
      const node = document.activeElement;
      const style = getComputedStyle(node);
      return {
        tag: node.tagName,
        width: style.outlineWidth,
        style: style.outlineStyle,
        label: node.getAttribute('aria-label') || (node.textContent || '').trim().slice(0, 24),
      };
    })()`);
    if (outline.style === 'none' || outline.width === '0px') {
      throw new Error(`focus ring is ${outline.style} ${outline.width} on ${outline.tag}`);
    }
    return `${outline.style} ${outline.width} on "${outline.label}"`;
  });

  await check('The pause control is reachable inside the map menu', async () => {
    await page.clickSelector('[data-world-chrome] [data-world-map]');
    await sleep(400);
    const reachable = await page.evaluate(`(() => {
      const button = document.querySelector('[data-world-map-menu] [data-world-ambient]');
      if (!button) return { found: false };
      button.scrollIntoView({ block: 'nearest' });
      button.focus();
      return {
        found: true,
        focused: document.activeElement === button,
        label: button.getAttribute('aria-label'),
        pressed: button.getAttribute('aria-pressed'),
      };
    })()`);
    await page.key('Escape', 'Escape', 27);
    if (!reachable.found) throw new Error('no pause control in the map menu');
    if (!reachable.focused) throw new Error('the pause control cannot take focus');
    if (!reachable.label) throw new Error('the pause control has no label');
    return `"${reachable.label}", pressed=${reachable.pressed}`;
  });

  await check('The printed CV is a whole document, not the visible slice', async () => {
    const result = await page.send('Page.printToPDF', {
      printBackground: true,
      preferCSSPageSize: false,
    });
    const { writeFileSync } = await import('node:fs');
    writeFileSync('.screenshots/world/cv-print.pdf', Buffer.from(result.data, 'base64'));
    const size = Buffer.from(result.data, 'base64').length;
    if (size < 20000) throw new Error(`PDF is only ${size} bytes`);
    /* A full CV cannot fit on a single panel-height page. */
    const text = Buffer.from(result.data, 'base64').toString('latin1');
    const pages = (text.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    if (pages < 2) throw new Error(`PDF has ${pages} page(s)`);
    return `${pages} pages, ${Math.round(size / 1024)}KB`;
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
