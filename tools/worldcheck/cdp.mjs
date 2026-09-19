/**
 * A very small Chrome DevTools Protocol client.
 *
 * No dependencies: Node's global `fetch` finds the browser endpoint and its
 * global `WebSocket` speaks to it, so the verification harness runs anywhere
 * the site's own toolchain does.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

export function findBrowser() {
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Launch a headless browser with a software WebGL backend and a debug port. */
export async function launchBrowser({ port = 9333, size = { width: 1440, height: 900 } } = {}) {
  const binary = findBrowser();
  if (!binary) throw new Error('No Chrome/Edge binary found for verification');

  const profile = mkdtempSync(join(tmpdir(), 'worldcheck-'));
  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${profile}`,
    `--window-size=${size.width},${size.height}`,
    /* Headless has no GPU: allow the software rasteriser so WebGL exists at
       all. This is slower than a real device and is noted as such. */
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--mute-audio',
    'about:blank',
  ];

  const child = spawn(binary, args, { stdio: 'ignore', windowsHide: true });

  const deadline = Date.now() + 30000;
  let version = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        version = await response.json();
        break;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!version) {
    child.kill();
    throw new Error('Browser did not expose a debugging port in time');
  }

  return {
    process: child,
    webSocketDebuggerUrl: version.webSocketDebuggerUrl,
    close() {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
}

/** One page target, driven over a flattened CDP session. */
export class Page {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.sessionId = null;
    this.events = [];
    this.logs = [];
    this.onEvent = null;

    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`));
        else entry.resolve(message.result);
        return;
      }
      if (message.method === 'Runtime.consoleAPICalled') {
        this.logs.push({
          level: message.params.type,
          text: (message.params.args ?? [])
            .map((arg) => arg.value ?? arg.description ?? arg.type)
            .join(' '),
        });
      }
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails;
        this.logs.push({
          level: 'exception',
          text: details.exception?.description ?? details.text ?? 'unknown exception',
        });
      }
      this.events.push(message.method);
      this.onEvent?.(message);
    });
  }

  static async open(webSocketDebuggerUrl, url = 'about:blank') {
    const socket = new WebSocket(webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('CDP socket failed')), {
        once: true,
      });
    });
    const page = new Page(socket);
    const { targetId } = await page.send('Target.createTarget', { url });
    const { sessionId } = await page.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    page.sessionId = sessionId;
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Log.enable').catch(() => {});
    return page;
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    const message = { id, method, params };
    if (this.sessionId) message.sessionId = this.sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.socket.send(JSON.stringify(message));
    });
  }

  async setViewport(width, height, mobile = false) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile,
    });
    /* Real touch input, so tap and swipe are tested as a phone delivers them
       rather than as synthesised DOM events. */
    await this.send('Emulation.setTouchEmulationEnabled', {
      enabled: mobile,
      maxTouchPoints: mobile ? 5 : 1,
    });
  }

  async emulateMedia(features) {
    await this.send('Emulation.setEmulatedMedia', { features });
  }

  async navigate(url) {
    const loaded = new Promise((resolve) => {
      this.onEvent = (message) => {
        if (message.method === 'Page.loadEventFired') {
          this.onEvent = null;
          resolve();
        }
      };
    });
    await this.send('Page.navigate', { url });
    await loaded;
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
      );
    }
    return result.result.value;
  }

  async waitFor(expression, { timeout = 15000, interval = 120, label = expression } = {}) {
    const deadline = Date.now() + timeout;
    let last = null;
    while (Date.now() < deadline) {
      try {
        last = await this.evaluate(expression);
        if (last) return last;
      } catch (error) {
        last = String(error);
      }
      await sleep(interval);
    }
    throw new Error(`Timed out waiting for ${label} (last value: ${JSON.stringify(last)})`);
  }

  async click(x, y, { button = 'left', clickCount = 1 } = {}) {
    const base = { x, y, button, clickCount, buttons: 1 };
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...base,
      buttons: 0,
    });
  }

  async clickSelector(selector, { index = 0 } = {}) {
    const box = await this.boundingBox(selector, index);
    if (!box) throw new Error(`No box for ${selector}`);
    await this.click(box.x + box.width / 2, box.y + box.height / 2);
    return box;
  }

  async boundingBox(selector, index = 0) {
    return this.evaluate(`(() => {
      const nodes = document.querySelectorAll(${JSON.stringify(selector)});
      const node = nodes[${index}];
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    })()`);
  }

  async drag(from, to, steps = 12) {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: from.x,
      y: from.y,
      button: 'none',
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: from.x,
      y: from.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      await this.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
        button: 'left',
        buttons: 1,
      });
    }
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: to.x,
      y: to.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
  }

  async tap(x, y) {
    const point = [{ x, y, radiusX: 12, radiusY: 12, force: 1 }];
    await this.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point });
    await sleep(30);
    await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }

  async swipe(from, to, steps = 12) {
    const at = (point) => [{ x: point.x, y: point.y, radiusX: 12, radiusY: 12, force: 1 }];
    await this.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: at(from),
    });
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      await this.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: at({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }),
      });
    }
    await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }

  async key(key, code, keyCode) {
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
    });
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
    });
  }

  async screenshot(path) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    writeFileSync(path, Buffer.from(data, 'base64'));
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
