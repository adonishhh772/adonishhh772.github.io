/**
 * Content-driven world.
 *
 * Adds a temporary Markdown file, rebuilds, and proves that the new article
 * became a route, an entry in the world index, a caption on the library
 * shelf, an RSS item and a working page — then removes it again.
 *
 * Usage: node tools/worldcheck/content.mjs [baseUrl]
 */

import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { launchBrowser, Page, sleep } from './cdp.mjs';

const BASE = process.argv[2] ?? 'http://localhost:4321';
const FILE = 'src/content/writing/zz-verification-article.md';
const SLUG = 'zz-verification-article';
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

const article = `---
title: Verification Article — Does The World Pick This Up
description: A temporary article created by the verification harness.
pubDate: 2030-01-01
issue: 999
tags:
  - verification
draft: false
---

A temporary note used to prove the world is built from the content collection.

## First section

Short body.

## Second section

Still short.
`;

writeFileSync(FILE, article);

/* The collection is compiled at build time, so the new file has to be built
   before anything can be observed. Output is inherited rather than piped so
   this works in a confined shell too. */
console.log('building with the new article…');
const build = spawnSync('npm', ['run', 'build'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
});
if (build.status !== 0) {
  rmSync(FILE, { force: true });
  throw new Error(`build failed with status ${build.status}`);
}

const browser = await launchBrowser({ port: 9345 });
const page = await Page.open(browser.webSocketDebuggerUrl);

try {
  await page.setViewport(1440, 900);
  await page.navigate(`${BASE}/writing/${SLUG}/`);
  await page.waitFor(`document.querySelector('[data-world]')?.dataset.worldState === 'ready'`, {
    timeout: 30000,
  });
  await sleep(1200);

  await check('A new Markdown file gets its own route', async () => {
    const info = await page.evaluate(`(() => ({
      surface: document.body.dataset.surface,
      id: document.body.dataset.surfaceId,
      title: document.querySelector('h1')?.textContent?.trim(),
    }))()`);
    if (info.surface !== 'article') throw new Error(`surface ${info.surface}`);
    if (info.id !== SLUG) throw new Error(`surface id ${info.id}`);
    return `${info.title}`;
  });

  await check('The new article is in the world index (a book on the shelf)', async () => {
    const entry = await page.evaluate(`(() => {
      const node = document.querySelector('[data-world-index]');
      const index = JSON.parse(node.textContent);
      return index.articles.find((item) => item.id === ${JSON.stringify(SLUG)}) ?? null;
    })()`);
    if (!entry) throw new Error('not present in data-world-index');
    return `${entry.label} — ${entry.meta}`;
  });

  await check('The new article has a caption on the library shelf', async () => {
    await page.navigate(`${BASE}/writing/`);
    await page.waitFor(`document.querySelector('[data-world]')?.dataset.worldState === 'ready'`, {
      timeout: 30000,
    });
    await sleep(2000);
    const caption = await page.evaluate(`(() => {
      const node = document.querySelector('[data-world]').__worldDebug ? null : null;
      const found = [...document.querySelectorAll('.world-hotspot')]
        .find((item) => item.dataset.worldHotspot === 'object:article:${SLUG}');
      return found ? { key: found.dataset.worldHotspot, label: found.textContent.trim() } : null;
    })()`);
    if (!caption) throw new Error('no caption for the new article');
    return caption.label;
  });

  await check('The new article appears in the archive and the feed', async () => {
    const archive = await page.evaluate(
      `[...document.querySelectorAll('a[href*="${SLUG}"]')].length`,
    );
    if (archive < 1) throw new Error('not linked from the archive');
    const feed = await page.evaluate(`(async () => {
      const response = await fetch('/rss.xml');
      const text = await response.text();
      return text.includes(${JSON.stringify(SLUG)});
    })()`);
    if (!feed) throw new Error('missing from rss.xml');
    return `${archive} archive link(s), present in RSS`;
  });

  await check('The article can be read in full inside the world', async () => {
    await page.navigate(`${BASE}/writing/${SLUG}/`);
    await sleep(1500);
    const info = await page.evaluate(`(() => {
      const panel = document.querySelector('[data-surface-panel]:not([hidden])');
      return {
        headings: [...panel.querySelectorAll('h2')].map((node) => node.textContent.trim()),
        contents: [...panel.querySelectorAll('[data-case-link]')].length,
        scrollable: panel.scrollHeight > panel.clientHeight,
      };
    })()`);
    if (info.headings.length < 2) throw new Error('body did not render');
    return `sections: ${info.headings.join(' / ')}`;
  });
} finally {
  browser.close();
  rmSync(FILE, { force: true });
  /* Leave the build without the temporary article. */
  spawnSync('npm', ['run', 'build'], {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
  });
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  for (const entry of failed) console.log(` - ${entry.name}: ${entry.detail}`);
}
process.exitCode = failed.length ? 1 : 0;
