/**
 * One frame, on demand.
 *
 * The look/verify suites each answer a fixed set of questions. This one answers
 * the question that comes up while changing how something *looks*: "let me see
 * that bit there". It pins the sky to an hour, optionally turns the camera to a
 * sky body or a bearing, optionally magnifies a crop of the frame, and writes a
 * PNG. Nothing is asserted: the eye is the assertion.
 *
 * Usage:
 *   node tools/worldcheck/shot.mjs [baseUrl] --hour 22 --look moon --out x.png
 *
 * Options:
 *   --hour <n>          Pin the sky to a local hour (omit for the real clock).
 *   --look <sun|moon|bearing,altitude>
 *   --viewport <WxH>    Default 1440x900.
 *   --crop <x,y,w,h>    Capture only this rectangle of the viewport.
 *   --scale <n>         Device scale factor — 3 gives a magnified crop.
 *   --settle <ms>       Extra settle time after the last change.
 *   --out <path>        Default .screenshots/shot.png
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { launchBrowser, Page, sleep } from './cdp.mjs';

const args = process.argv.slice(2);
const BASE = args.find((arg) => arg.startsWith('http')) ?? 'http://localhost:4321';
const value = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const hour = value('hour');
const look = value('look');
const viewport = (value('viewport', '1440x900')).split('x').map(Number);
const crop = value('crop');
const scale = Number(value('scale', '1'));
const settle = Number(value('settle', '1600'));
const out = value('out', '.screenshots/shot.png');

const main = async () => {
  mkdirSync(dirname(out), { recursive: true });
  const browser = await launchBrowser({ port: 9360, size: { width: viewport[0], height: viewport[1] } });
  const page = await Page.open(browser.webSocketDebuggerUrl);
  const errors = [];
  page.onEvent = (message) => {
    if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params.exceptionDetails?.exception?.description ?? 'exception');
    }
  };

  try {
    await page.setViewport(viewport[0], viewport[1]);
    if (scale !== 1) {
      await page.send('Emulation.setDeviceMetricsOverride', {
        width: viewport[0],
        height: viewport[1],
        deviceScaleFactor: scale,
        mobile: false,
      });
    }
    await page.navigate(`${BASE}/`);
    await page.waitFor(`document.querySelector('[data-world]')?.dataset.worldState === 'ready'`, {
      timeout: 180000,
      label: 'world ready',
    });
    await sleep(1200);

    if (hour !== null) {
      await page.evaluate(`window.__worldSkyTime(${Number(hour)})`);
      await sleep(settle);
    }

    if (look) {
      if (look === 'sun' || look === 'moon') {
        const sky = await page.evaluate(`window.__worldDebug().sky`);
        const bearing = look === 'sun' ? sky.sunAzimuth : sky.moonAzimuth;
        const altitude = look === 'sun' ? sky.sunAltitude : sky.moonAltitude;
        await page.evaluate(`window.__worldLookAt(${bearing}, ${altitude})`);
      } else {
        const [bearing, altitude] = look.split(',').map(Number);
        await page.evaluate(`window.__worldLookAt(${bearing}, ${altitude})`);
      }
      await sleep(settle);
    }

    const shot = crop
      ? { clip: (() => {
          const [x, y, w, h] = crop.split(',').map(Number);
          return { x, y, width: w, height: h, scale: 1 };
        })() }
      : {};
    const { data } = await page.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      ...shot,
    });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(out, Buffer.from(data, 'base64'));

    const info = await page.evaluate(`window.__worldDebug()`);
    console.log(
      `${out}  ${info.sky.label}  dayness ${info.sky.dayness.toFixed(2)}  ` +
        `sun ${info.sky.sunAltitude.toFixed(1)}°  moon ${info.sky.moonAltitude.toFixed(1)}° ` +
        `${(info.sky.moonIllumination * 100).toFixed(0)}%`,
    );
    console.log(
      `camera bearing ${info.rotation.bearing}° pitch ${info.rotation.pitch}° distance ${info.rotation.distance}`,
    );
    if (errors.length) console.log('ERRORS:', errors.slice(0, 3).join(' | '));
  } finally {
    browser.close();
  }
};

main().catch((error) => {
  console.error('shot failed:', error.message);
  process.exitCode = 1;
});
