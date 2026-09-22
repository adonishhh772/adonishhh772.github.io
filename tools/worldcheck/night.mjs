/**
 * The night sky and the campus lamps.
 *
 * Four things this suite exists to hold still, because all four had been wrong
 * in ways a screenshot shows and a passing suite does not:
 *
 *  1. **The moon had a square around it.** Its glow gradient was still at five
 *     percent opacity where the sprite's canvas ended, so the cut-off drew the
 *     edge of a quad onto the sky. That is a texture property, so it is asserted
 *     against the texture rather than against a frame — a frame can hide it
 *     behind the moon's own position.
 *
 *  2. **Every star was a smudge.** The field was a painted equirectangular map,
 *     so a star's size was fixed in *texels* and one star was twenty-odd pixels
 *     of grey haze. The stars are points now; this measures both the geometry
 *     (how many pixels across a star is) and the frame (how large the largest
 *     bright thing in the sky is).
 *
 *  3. **The campus was dark.** It is lit by lamp posts now, and "lit" is a claim
 *     about pixels: the island at one in the morning must be measurably brighter
 *     than the sky above it and must carry warm light on its paths.
 *
 *  4. **The light switch was a decoration.** Pressing the moon has to bring the
 *     sun up — at any hour, and without the wall clock taking it back. That is
 *     driven through the real control, in the real page, at four different hours
 *     of the day.
 *
 * Usage:  node tools/worldcheck/night.mjs [baseUrl]
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchBrowser, Page, sleep } from './cdp.mjs';
import { decodePng, luminance, luminanceOf } from './png.mjs';

const BASE = process.argv[2] ?? 'http://localhost:4321';
const OUT = '.screenshots/night';
const results = [];
const consoleErrors = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    record(name, true, typeof detail === 'string' ? detail : undefined);
  } catch (error) {
    record(name, false, error.message);
  }
}

const debug = () => `window.__worldDebug()`;

/**
 * Hold the world at an hour.
 *
 * The view is reset as well, because every frame this suite measures is of the
 * composed overview: a camera left turned by an earlier check would measure a
 * different part of the island.
 */
async function atHour(page, hour, settleMs = 1400) {
  await page.evaluate(`window.__worldSkyTime(${hour})`);
  await page.evaluate(`window.__worldResetTurn && window.__worldResetTurn()`);
  await page.waitFor(`window.__worldDebug().transitioning === false`, {
    timeout: 60000,
    interval: 200,
    label: 'the light to settle',
  });
  await sleep(settleMs);
}

/**
 * Change the page's light without pretending the visitor asked for it.
 *
 * The world reads a *visitor's* change of theme as an instruction about the time
 * of day, and moves the sky to noon or midnight. This suite needs to set up a
 * starting colour without moving the clock, so it goes through the same door the
 * operating system's own preference does.
 */
async function setLightQuiet(page, theme) {
  await page.evaluate(`(() => {
    document.documentElement.dataset.theme = ${JSON.stringify(theme)};
    try { localStorage.setItem('theme', ${JSON.stringify(theme)}); } catch (error) { /* storage off */ }
    document.dispatchEvent(new CustomEvent('world:themechange', {
      detail: { theme: ${JSON.stringify(theme)}, animate: true, source: 'system' },
    }));
  })()`);
  await page.waitFor(`window.__worldDebug().transitioning === false`, {
    timeout: 60000,
    interval: 200,
    label: 'the palette to settle',
  });
  await sleep(500);
}

/**
 * The largest connected run of bright pixels in a region.
 *
 * This is what separates a starfield from a sky of smudges. A star is a handful
 * of pixels; a blur is a couple of hundred, and no amount of counting bright
 * pixels on its own distinguishes the two — the *size of the largest one* does.
 */
function largestBrightBlob(png, region, threshold = 140) {
  const left = Math.floor((region.left ?? 0) * png.width);
  const right = Math.floor((region.right ?? 1) * png.width);
  const top = Math.floor((region.top ?? 0) * png.height);
  const bottom = Math.floor((region.bottom ?? 1) * png.height);
  const width = right - left;
  const height = bottom - top;
  const lit = new Uint8Array(width * height);
  let total = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = ((y + top) * png.width + (x + left)) * png.channels;
      const r = png.data[index];
      const g = png.channels >= 3 ? png.data[index + 1] : r;
      const b = png.channels >= 3 ? png.data[index + 2] : r;
      if (0.2126 * r + 0.7152 * g + 0.0722 * b >= threshold) {
        lit[y * width + x] = 1;
        total++;
      }
    }
  }
  const seen = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let largest = 0;
  let blobs = 0;
  for (let start = 0; start < lit.length; start++) {
    if (!lit[start] || seen[start]) continue;
    blobs++;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    let size = 0;
    while (head < tail) {
      const index = queue[head++];
      size++;
      const x = index % width;
      const y = (index - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const next = ny * width + nx;
          if (!lit[next] || seen[next]) continue;
          seen[next] = 1;
          queue[tail++] = next;
        }
      }
    }
    if (size > largest) largest = size;
  }
  return { largest, blobs, total, pixels: lit.length };
}

const main = async () => {
  mkdirSync(OUT, { recursive: true });
  const browser = await launchBrowser({ port: 9340 });
  const page = await Page.open(browser.webSocketDebuggerUrl);
  page.onEvent = (message) => {
    if (message.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(message.params.exceptionDetails?.exception?.description ?? 'exception');
    }
  };

  try {
    await page.setViewport(1440, 900);
    await page.navigate(`${BASE}/`);
    await page.waitFor(`document.querySelector('[data-world]')?.dataset.worldState === 'ready'`, {
      timeout: 180000,
      label: 'world ready',
    });
    await sleep(900);

    /* ── 1. The moon's sprite ────────────────────────────────────────── */

    await check('The moon has no square around it', async () => {
      /*
       * Asserted against the texture itself, read back from the live object.
       *
       * The sprite is a square quad with a radial glow drawn on it; if that glow
       * is still visible where the canvas ends, the quad's edge is drawn on the
       * sky — and looking at a frame cannot prove it is not, because the edge is
       * faint and the moon spends most of its time near other bright things.
       *
       * The check is made at a full moon, on purpose. A new moon is a dark disc
       * by construction, so a suite that happened to run on one would report
       * "the moon is not opaque" and be right about the phase and wrong about
       * the sprite. The date is moved to the brightest night of the month and
       * then put back.
       */
      let best = { day: 0, illumination: -1 };
      for (let day = 0; day < 30; day++) {
        const reading = await page.evaluate(`window.__worldSkyDay(${day})`);
        if (reading.illumination > best.illumination) {
          best = { day, illumination: reading.illumination };
        }
      }
      const full = await page.evaluate(`window.__worldSkyDay(${best.day})`);
      await sleep(700);

      const craft = await page.evaluate(`window.__worldDebug().skyCraft`);
      await page.evaluate(`window.__worldSkyDay(0)`);
      await sleep(500);
      if (!craft?.moon) throw new Error('the world reports nothing about the moon');
      const moon = craft.moon;
      if (moon.edge > 2) {
        throw new Error(
          `the sprite's edge is still drawn (alpha ${moon.edge}/255 at the boundary of the quad)`,
        );
      }
      if (moon.centre < 200) {
        throw new Error(`the moon's disc is not opaque at its centre (alpha ${moon.centre}/255)`);
      }
      if (moon.disc < 200) {
        throw new Error(
          `the moon's disc does not reach its own radius (alpha ${moon.disc}/255 there)`,
        );
      }
      return `${full.phase} (${(full.illumination * 100).toFixed(0)}% lit): edge alpha ${moon.edge}/255 on a ${moon.size}px sprite, centre ${moon.centre}/255`;
    });

    /* ── 2. The stars ────────────────────────────────────────────────── */

    await check('A star is a point on screen, not a smudge', async () => {
      const craft = await page.evaluate(`window.__worldDebug().skyCraft`);
      if (!craft?.stars) throw new Error('the world reports nothing about its stars');
      const stars = craft.stars;
      if (stars.count < 2000) throw new Error(`only ${stars.count} stars`);
      if (stars.median > 3) {
        throw new Error(`the median star is ${stars.median}px across`);
      }
      if (stars.largest > 6) {
        throw new Error(`stars reach ${stars.largest}px across`);
      }
      if (stars.flares < 40) {
        throw new Error(`only ${stars.flares} stars carry a flare`);
      }
      return `${stars.count} points, median ${stars.median}px, largest ${stars.largest}px, ${stars.flares} with a flare`;
    });

    await check('The night sky is a field of small bright points', async () => {
      /*
       * One in the morning: the sun is far below the horizon and the moon has
       * not risen, so nothing in the sky but stars and the faint cloud — which
       * is what makes this a measurement of the starfield rather than of
       * whatever else happens to be up.
       */
      await atHour(page, 1);
      const file = join(OUT, '01-stars.png');
      await page.screenshot(file);
      /*
       * The measurement band starts below the control bar. The bar's pills are
       * white, opaque and inside any band that reaches the top of the frame —
       * so a band that includes them reports the brightest thing in the sky as
       * a 1300-pixel blob, which is the button, not a star.
       */
      const band = { top: 0.09, bottom: 0.24, left: 0.1, right: 0.9 };
      const sky = luminanceOf(file, band);
      const blobs = largestBrightBlob(decodePng(file), band, 110);
      if (sky.max < 150) {
        throw new Error(`no stars: the brightest sky pixel is ${sky.max.toFixed(0)}`);
      }
      if (blobs.blobs < 25) {
        throw new Error(`only ${blobs.blobs} bright points in the sky`);
      }
      if (blobs.largest > 60) {
        throw new Error(
          `the largest bright thing in the sky covers ${blobs.largest}px — that is a smudge, not a star`,
        );
      }
      const info = await page.evaluate(debug());
      return `${blobs.blobs} points, largest ${blobs.largest}px, brightest ${sky.max.toFixed(0)}, star opacity ${info.sky ? info.celestialHidden.opacity.toFixed(2) : '?'}`;
    });

    /* ── 3. The lamps ────────────────────────────────────────────────── */

    await check('The campus carries lamps, and they are lit at night', async () => {
      await atHour(page, 1);
      const info = await page.evaluate(debug());
      const lamps = info.lamps;
      if (!lamps) throw new Error('the world reports nothing about its lamps');
      if (lamps.posts < 8) throw new Error(`only ${lamps.posts} lamp posts`);
      if (lamps.pools < 8) throw new Error(`only ${lamps.pools} light pools`);
      if (lamps.lit < 4) throw new Error(`only ${lamps.lit} lamps have a real light`);
      if (lamps.litIntensity < 5) throw new Error(`the lamp lights are at ${lamps.litIntensity}`);
      if (lamps.poolOpacity < 0.3) throw new Error(`the pools are at ${lamps.poolOpacity} opacity`);
      if (lamps.glowOpacity < 0.3) throw new Error(`the lanterns are at ${lamps.glowOpacity} opacity`);
      return `${lamps.posts} posts, ${lamps.lit} lit, pool ${lamps.poolOpacity}, glow ${lamps.glowOpacity}`;
    });

    await check('The island is measurably lit while the sky above it is not', async () => {
      const file = join(OUT, '01-stars.png');
      const png = decodePng(file);
      const island = luminance(png, { top: 0.62, bottom: 0.95, left: 0.3, right: 0.72 });
      const sky = luminance(png, { top: 0.1, bottom: 0.24, left: 0.3, right: 0.72 });
      if (island.mean < 12) {
        throw new Error(`the island measures ${island.mean.toFixed(1)} — that is an unlit campus`);
      }
      if (island.mean < sky.mean * 1.8) {
        throw new Error(
          `the island (${island.mean.toFixed(1)}) is not clearly brighter than the sky (${sky.mean.toFixed(1)})`,
        );
      }
      /*
       * Warm light on the paths. The lamps are the only warm source on the
       * island at one in the morning — the sun is down and the moon has not
       * risen — so a red-dominant pixel is a lamp's, and counting them is the
       * difference between "the campus is not black" and "the campus is lit".
       */
      let warm = 0;
      const left = Math.floor(0.28 * png.width);
      const right = Math.floor(0.74 * png.width);
      const top = Math.floor(0.6 * png.height);
      const bottom = Math.floor(0.96 * png.height);
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          const index = (y * png.width + x) * png.channels;
          const r = png.data[index];
          const b = png.channels >= 3 ? png.data[index + 2] : r;
          if (r > 42 && r - b > 16) warm++;
        }
      }
      if (warm < 400) {
        throw new Error(`only ${warm} warm pixels on the campus — the lamps are not lighting it`);
      }
      return `island mean ${island.mean.toFixed(1)} vs sky ${sky.mean.toFixed(1)}, ${warm} warm pixels`;
    });

    /* ── 4. The light switch ─────────────────────────────────────────── */

    /*
     * The claim: pressing a sky body is a switch between the two times of day,
     * and it holds whatever the visitor's clock says. Four starting hours, two
     * of them in the middle of the night and two in the middle of the day, and
     * the *same* result from each — noon from the moon, one in the morning from
     * the sun.
     *
     * The body itself is the control: the sun and the moon are drawn as sprites
     * and the world raycasts the drawn sprite, so the press is aimed at the
     * screen position the world reports for it rather than at any element.
     */
    const pressBody = async (page) => {
      const before = await page.evaluate(debug());
      const kind = before.celestialHidden.kind;
      if (!kind) throw new Error('no sky body is up');
      /*
       * Turn to it first. The overview camera faces south-east and the rig's
       * swing is bounded, so a body on the far side of the sky cannot be
       * brought into shot at all — and a body that is out of frame is a body
       * the visitor cannot press either.
       */
      const bearing = kind === 'sun' ? before.sky.sunAzimuth : before.sky.moonAzimuth;
      const altitude = kind === 'sun' ? before.sky.sunAltitude : before.sky.moonAltitude;
      await page.evaluate(`window.__worldLookAt(${bearing}, ${altitude})`);
      await sleep(1400);

      const aimed = await page.evaluate(debug());
      const target = aimed.celestial;
      if (!target || !target.onScreen) {
        throw new Error(
          `the ${kind} is not on the frame after turning to it (camera facing ${aimed.rotation.bearing}°)`,
        );
      }
      const stage = await page.evaluate(`(() => {
        const rect = document.querySelector('[data-world-stage]').getBoundingClientRect();
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      })()`);
      if (target.x < 4 || target.y < 4 || target.x > stage.width - 4 || target.y > stage.height - 4) {
        throw new Error(
          `the ${kind} sits at ${Math.round(target.x)},${Math.round(target.y)} — too close to the edge of the frame to press`,
        );
      }
      /* The press has to reach the world: a body drawn under the control bar is
         a body the visitor cannot press either, and saying so is more useful
         than a click that silently does nothing. */
      const covered = await page.evaluate(`(() => {
        const node = document.elementFromPoint(${stage.left + target.x}, ${stage.top + target.y});
        return node ? node.tagName.toLowerCase() : null;
      })()`);
      if (covered !== 'canvas') {
        throw new Error(`the ${kind} is drawn under a <${covered ?? 'nothing'}> rather than the canvas`);
      }
      await page.click(stage.left + target.x, stage.top + target.y);
      return kind;
    };

    const switched = async (page, expect) => {
      await page.waitFor(`document.documentElement.dataset.theme === ${JSON.stringify(expect.theme)}`, {
        timeout: 15000,
        label: 'the light to answer the press',
      });
      await page.waitFor(`window.__worldDebug().transitioning === false`, {
        timeout: 60000,
        interval: 200,
        label: 'the light to settle',
      });
      await sleep(600);
      const after = await page.evaluate(debug());
      if (after.theme !== expect.theme) throw new Error(`the page light is ${after.theme}`);
      if (!after.sky.overridden) {
        throw new Error('the sky is still following the clock after the switch was pressed');
      }
      if (Math.abs(after.sky.hours - expect.hours) > 0.25) {
        throw new Error(
          `the sky is at ${after.sky.hours.toFixed(2)}:00 rather than ${expect.hours}:00`,
        );
      }
      if (expect.sunUp && after.sky.sunAltitude < 5) {
        throw new Error(`the sun is at ${after.sky.sunAltitude.toFixed(1)}° — it did not come up`);
      }
      if (!expect.sunUp && after.sky.sunAltitude > -1) {
        throw new Error(`the sun is still up at ${after.sky.sunAltitude.toFixed(1)}°`);
      }
      return after;
    };

    const release = async (page) => {
      await page.evaluate(`window.__worldSkyTime(null)`);
      await page.evaluate(`localStorage.removeItem('world:sky-hour')`);
      await sleep(500);
    };

    await check('Pressing the moon brings the sun up, whatever the clock says', async () => {
      const readings = [];
      for (const hour of [21, 23]) {
        await atHour(page, hour);
        await setLightQuiet(page, 'dark');
        const kind = await pressBody(page);
        const after = await switched(page, { theme: 'light', hours: 12, sunUp: true });
        const stored = await page.evaluate(`localStorage.getItem('world:sky-hour')`);
        if (stored === null || Math.abs(Number(stored) - 12) > 0.25) {
          throw new Error(`the pin was not remembered (stored ${stored})`);
        }
        readings.push(`${hour}:00 → ${after.sky.hours.toFixed(2)}:00 (from the ${kind})`);
        await release(page);
      }
      return readings.join(', ');
    });

    await check('The bar light control does not change the sky — only the sun and moon do', async () => {
      await atHour(page, 3);
      await setLightQuiet(page, 'dark');
      const before = await page.evaluate(debug());
      if (before.celestialHidden.kind !== null) {
        throw new Error(`a sky body is up at 03:00 (${before.celestialHidden.kind})`);
      }
      const control = await page.boundingBox('[data-world-chrome] [data-theme-toggle]');
      if (control) {
        await page.click(control.x + control.width / 2, control.y + control.height / 2);
        await sleep(400);
      }
      const headerToggle = await page.boundingBox('[data-theme-toggle]');
      if (headerToggle) {
        await page.click(headerToggle.x + headerToggle.width / 2, headerToggle.y + headerToggle.height / 2);
        await sleep(400);
      }
      const after = await page.evaluate(debug());
      if (after.theme !== 'dark') {
        throw new Error('a chrome theme control changed the light while in the world');
      }
      return '03:00 with nothing in the sky — chrome controls left night as-is';
    });

    await check('The switch works in the other direction, and from the other end of the day', async () => {
      const readings = [];
      for (const hour of [9, 15]) {
        await atHour(page, hour);
        await setLightQuiet(page, 'light');
        const kind = await pressBody(page);
        const after = await switched(page, { theme: 'dark', hours: 1, sunUp: false });
        readings.push(`${hour}:00 → ${after.sky.hours.toFixed(2)}:00 (from the ${kind})`);
        await release(page);
      }
      return readings.join(', ');
    });

    await check('The clock cannot take the switched light back, even across a reload', async () => {
      /*
       * This is the whole point of pinning rather than nudging. The world's
       * light is a function of the visitor's clock by default — which is right —
       * but a switch that reverts to the wall clock a minute later is not a
       * switch. The pin survives the page, and it survives the next one.
       */
      await atHour(page, 22);
      await setLightQuiet(page, 'dark');
      await pressBody(page);
      const pinned = await switched(page, { theme: 'light', hours: 12, sunUp: true });

      await page.send('Page.reload');
      await page.waitFor(`document.querySelector('[data-world]')?.dataset.worldState === 'ready'`, {
        timeout: 180000,
        label: 'the world after a reload',
      });
      await sleep(1500);
      const after = await page.evaluate(debug());
      if (Math.abs(after.sky.hours - pinned.sky.hours) > 0.25) {
        throw new Error(
          `the reload moved the sky from ${pinned.sky.hours.toFixed(2)} to ${after.sky.hours.toFixed(2)}`,
        );
      }
      if (!after.sky.overridden) {
        throw new Error('the sky went back to following the clock after a reload');
      }
      const follow = await page.evaluate(`localStorage.getItem('world:sky-hour')`);
      if (follow === null) throw new Error('nothing was remembered to follow');
      await release(page);
      return `pinned to ${after.sky.hours.toFixed(2)}:00 and still there after a reload`;
    });

    /* ── Frames for the eye ──────────────────────────────────────────── */

    await page.evaluate(`window.__worldSkyTime(null)`);
    await page.evaluate(`localStorage.removeItem('world:sky-hour')`);
    await setLightQuiet(page, 'dark');
    for (const [hour, name] of [[1, 'night'], [22, 'moonlit'], [12, 'noon']]) {
      await atHour(page, hour);
      await page.screenshot(join(OUT, `10-${name}.png`));
    }

    if (consoleErrors.length) {
      record('No runtime exceptions', false, consoleErrors.slice(0, 2).join(' | '));
    } else {
      record('No runtime exceptions', true, undefined);
    }
  } finally {
    browser.close();
  }

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exitCode = 1;
};

main().catch((error) => {
  console.error('the night suite failed to run:', error.message);
  process.exitCode = 1;
});
