import { launchBrowser, Page, sleep } from './cdp.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4331';
const browser = await launchBrowser({ port: 9352, size: { width: 1440, height: 900 } });
const page = await Page.open(browser.webSocketDebuggerUrl);
try {
  await page.setViewport(1440, 900, false);
  await page.navigate(`${BASE}/`);
  await sleep(9000);
  const info = await page.evaluate(`(() => {
    const world = document.querySelector('[data-world]');
    const alert = document.querySelector('[data-world-alert]');
    return {
      mode: document.documentElement.dataset.mode,
      webgl: document.documentElement.dataset.webgl,
      state: world ? world.dataset.worldState : 'no-world',
      alertHidden: alert ? alert.hidden : null,
      reason: document.querySelector('[data-world-alert-reason]')?.textContent?.trim() ?? '',
      canvases: document.querySelectorAll('canvas').length,
      title: document.title,
      bodyText: document.body.innerText.slice(0, 240),
    };
  })()`);
  console.log(JSON.stringify(info, null, 2));
  console.log('logs:', JSON.stringify(page.logs.slice(0, 12), null, 2));
} finally {
  browser.close();
}
