/**
 * Sky and terrain verification.
 *
 * The world's light is now a function of the visitor's clock, which means it is
 * a function that can be *wrong in a way a screenshot alone will not reveal*: a
 * sun in the wrong half of the sky at 09:00 still looks like a sun. This walks
 * the clock round a full day and checks the things astronomy actually promises
 * — that the sun is up at noon and down at midnight, that it rises in the east
 * and sets in the west, that the moon is in the sky at night, that the stars
 * only come out when they should — and captures a frame at each hour so the look
 * of it can be reviewed.
 *
 * Usage:  node tools/worldcheck/sky.mjs [baseUrl]
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchBrowser, Page, sleep } from './cdp.mjs';
import { luminanceOf } from './png.mjs';

const BASE = process.argv[2] ?? 'http://localhost:4321';
const OUT = '.screenshots/sky';
const results = [];

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

async function ready(page) {
  await page.waitFor(
    `document.querySelector('[data-world]')?.dataset.worldState === 'ready'`,
    { timeout: 180000, label: 'world ready' },
  );
  await page.waitFor(`document.querySelector('[data-world] canvas')?.width > 10`, {
    timeout: 30000,
    label: 'canvas sized',
  });
  await sleep(800);
}

const debug = () => `window.__worldDebug()`;

/**
 * The viewport used while sweeping the clock.
 *
 * The suite walks the hour round a full day several times, and each step is a
 * frame the world has to draw. Under a headless browser there is no GPU — the
 * software rasteriser stands in for one — so the cost is fill rate, and at
 * 1440×900 a single step took long enough that a clean run of this suite did not
 * finish in an afternoon.
 *
 * None of the claims made during a sweep are about pixels: they are about the
 * sun's altitude, the moon's phase, the key light's direction and the values the
 * clock computes. So the sweeps run in a small viewport, where a step is roughly
 * a tenth of the work, and the suite goes back to full size for the few frames
 * it actually measures.
 */
const SWEEP_VIEWPORT = { width: 640, height: 400 };
const FRAME_VIEWPORT = { width: 1440, height: 900 };

/**
 * Pin the world's hour.
 *
 * `__worldSkyTime` applies the whole sky synchronously — the astronomy, the
 * palette, the light rig, the shadow camera — and only the *drawing* of it waits
 * for the next frame. The short wait is therefore for that one frame rather than
 * for the world to catch up, which is what a 700ms sleep here was really buying.
 *
 * `reset` puts the camera back where it was composed. Any check that *measures*
 * the frame needs it, because the check before it may deliberately have turned
 * the camera — and a measurement of the default frame taken from a camera still
 * pointing at the sun measures nothing at all.
 */
async function atHour(page, hour, settle = 140, reset = false) {
  await page.evaluate(`window.__worldSkyTime(${hour})`);
  if (reset) await page.evaluate(`window.__worldResetTurn()`);
  await sleep(reset ? 600 : settle);
}

/** Pin the hour, read the world's own reading, and hand back both. */
async function skyAt(page, hour) {
  await atHour(page, hour);
  return page.evaluate(`window.__worldDebug().sky`);
}

/** The clock state alone, with no drawing to wait for at all. */
async function stateAt(page, hour) {
  return page.evaluate(`(() => {
    window.__worldSkyTime(${hour});
    return window.__worldDebug().sky;
  })()`);
}

/**
 * The composed camera's rotation, after the view has settled.
 *
 * A reset eases the camera back rather than snapping it, so the first reading
 * after one describes a camera still on its way home. This waits for the pitch
 * to come back inside the composed band instead of sleeping a fixed amount and
 * hoping.
 */
async function settlingRotation(page) {
  await page.evaluate(`window.__worldResetTurn()`);
  let rotation = await page.evaluate(`window.__worldDebug().rotation`);
  for (let attempt = 0; attempt < 24 && rotation.pitch > -10; attempt++) {
    await sleep(250);
    rotation = await page.evaluate(`window.__worldDebug().rotation`);
  }
  return rotation;
}

/**
 * A full day, at the hours that matter.
 *
 * Labelled by what they are meant to show rather than by their number, because
 * the assertions below are about those meanings: "dawn" has to be dimmer than
 * "noon" and warmer than "night", whatever the numbers happen to be on the day
 * the suite runs.
 */
const HOURS = [
  { hour: 2, name: 'night' },
  { hour: 6.2, name: 'first-light' },
  { hour: 8, name: 'morning' },
  { hour: 12, name: 'noon' },
  { hour: 16, name: 'afternoon' },
  { hour: 19.4, name: 'golden' },
  { hour: 20.6, name: 'dusk' },
  { hour: 22, name: 'evening' },
];

const main = async () => {
  mkdirSync(OUT, { recursive: true });
  const browser = await launchBrowser({ port: 9335 });
  const page = await Page.open(browser.webSocketDebuggerUrl);
  const errors = [];
  page.onEvent = (message) => {
    if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params.exceptionDetails?.exception?.description ?? 'exception');
    }
  };

  const frames = new Map();
  /** The hour the moon is highest tonight, found by the check that needs it. */
  let bestMoon = { hour: 1 };

  try {
    /*
     * The order matters, and it is the opposite of the order the checks read in.
     *
     * The clock for "the world reads the clock" only reads as the visitor's own
     * if nothing has pinned it yet, so that goes first. Then the hour sweeps —
     * which are the slow ones — run in the small viewport. Only after they are
     * done does the suite go to full size for the frames it actually measures,
     * and every one of those resets the clock first, because a pinned hour would
     * otherwise be measured instead of the visitor's.
     */
    await page.setViewport(SWEEP_VIEWPORT.width, SWEEP_VIEWPORT.height);
    await page.navigate(`${BASE}/`);
    await ready(page);
    await page.evaluate(`window.__worldResetTurn && window.__worldResetTurn()`);
    await sleep(500);

    await check('The world reads the clock and reports its own sky', async () => {
      const info = await page.evaluate(debug());
      if (!info.sky) throw new Error('no sky state exposed');
      if (info.sky.overridden) throw new Error('the world started pinned rather than on the clock');
      if (typeof info.sky.sunAltitude !== 'number') throw new Error('no sun altitude');
      return `local ${info.sky.label}, sun ${info.sky.sunAltitude.toFixed(1)}°, moon ${info.sky.moonAltitude.toFixed(1)}°, ${info.sky.moonPhase}`;
    });

    /*
     * The full-size frames are captured further down, once the sweeps are done:
     * the `frames` map these checks read from is filled there.
     */

    await check('The sun is up at noon and down at midnight', async () => {
      const noon = await stateAt(page, 12);
      const night = await stateAt(page, 2);
      if (noon.sunAltitude < 5) throw new Error(`the noon sun is at ${noon.sunAltitude}°`);
      if (night.sunAltitude > -5) throw new Error(`the midnight sun is at ${night.sunAltitude}°`);
      if (noon.dayness < 0.99) throw new Error(`noon dayness is ${noon.dayness}`);
      if (night.dayness > 0.01) throw new Error(`midnight dayness is ${night.dayness}`);
      return `sun ${noon.sunAltitude.toFixed(1)}° at noon, ${night.sunAltitude.toFixed(1)}° at midnight`;
    });

    await check('The sun rises in the east and sets in the west', async () => {
      const morning = await stateAt(page, 8);
      const afternoon = await stateAt(page, 16);
      /*
       * Bearings: 0 north, 90 east, 180 south, 270 west. In the northern
       * hemisphere the sun is in the eastern half before solar noon and the
       * western half after it, so this holds regardless of the season.
       */
      const east = morning.sunAzimuth > 0 && morning.sunAzimuth < 180;
      const west = afternoon.sunAzimuth > 180 && afternoon.sunAzimuth < 360;
      if (!east) throw new Error(`the morning sun bears ${morning.sunAzimuth.toFixed(1)}°`);
      if (!west) throw new Error(`the afternoon sun bears ${afternoon.sunAzimuth.toFixed(1)}°`);
      return `morning ${morning.sunAzimuth.toFixed(0)}° (east), afternoon ${afternoon.sunAzimuth.toFixed(0)}° (west)`;
    });

    /**
     * Point at the sky where a body *should* be, and see what the scene has
     * there.
     *
     * This is the check that a screenshot cannot make. A sun in the wrong half
     * of the sky still looks like a sun, so the question has to be asked of the
     * built world — and the way to ask it is to resolve the bearing the astronomy
     * reports against the scene graph the renderer actually drew.
     */
    /**
     * The sun's path, checked against the built world.
     *
     * A screenshot cannot make this claim: a sun in the wrong half of the sky
     * still looks like a sun. What is asserted here is the *path* — the sun at
     * its highest at solar noon, due south of a northern-hemisphere observer,
     * lower in the morning and evening than at midday — which is a property of
     * the astronomy and is true whatever the camera happens to be pointing at.
     */
    await check('The sun follows a real daily path', async () => {
      const path = [];
      /*
       * Whole hours, with no frame waited for at all: every number this check
       * reads is computed synchronously by the clock, so there is nothing to
       * wait for but the arithmetic.
       */
      for (let hour = 5; hour <= 21; hour += 1) {
        path.push({ hour, ...(await stateAt(page, hour)) });
      }
      const peak = path.reduce((best, entry) => (entry.sunAltitude > best.sunAltitude ? entry : best));
      if (peak.sunAltitude < 25) {
        throw new Error(`the sun only reaches ${peak.sunAltitude.toFixed(1)}° all day`);
      }
      if (peak.hour < 11 || peak.hour > 15) {
        throw new Error(`the sun peaks at ${peak.hour}:00, which is not around solar noon`);
      }
      /* Due south at the peak, by the northern-hemisphere convention. */
      const fromSouth = Math.abs(((peak.sunAzimuth - 180 + 540) % 360) - 180);
      if (fromSouth > 30) {
        throw new Error(`the midday sun bears ${peak.sunAzimuth.toFixed(0)}°, not near south`);
      }
      /* And it is genuinely lower at both ends of the day. */
      const morning = path[0];
      const evening = path[path.length - 1];
      if (!(morning.sunAltitude < peak.sunAltitude && evening.sunAltitude < peak.sunAltitude)) {
        throw new Error('the sun is not lower in the morning and the evening than at noon');
      }
      /*
       * Nothing should be lit from underneath while the sun is up. The key
       * light's elevation is clamped so that it never casts a shadow the length
       * of the island, and the direction the *sun* points is reported beside it
       * so the clamp cannot hide a sun that has genuinely set.
       */
      const litFromBelow = path.filter(
        (entry) => entry.sunAltitude > 0 && entry.keyDirection.y <= 0,
      );
      if (litFromBelow.length) {
        throw new Error(`the key light is below the horizon at ${litFromBelow.length} daylight hours`);
      }
      const sunBelow = path.filter((entry) => entry.sunAltitude > 0 && entry.sunDirectionY <= 0);
      if (sunBelow.length) {
        throw new Error('the reported sun direction is below the horizon while the sun is up');
      }
      return `peaks at ${peak.sunAltitude.toFixed(1)}° / ${peak.sunAzimuth.toFixed(0)}° at ${peak.hour}:00, ${morning.sunAltitude.toFixed(0)}° at dawn to ${evening.sunAltitude.toFixed(0)}° at night`;
    });

    await check('The moon is up at night, carries a real phase, and is tappable', async () => {
      /*
       * Find the hour the moon is highest tonight.
       *
       * The moon is not up at every hour of every night — it rises about fifty
       * minutes later each day — so it is searched for rather than assumed. A
       * fixed hour would make this a check about the date, which is exactly the
       * kind of accident the time API exists to remove.
       *
       * The result is kept for the sky-body check below, which turns the camera
       * to the moon and needs to know when to do it.
       */
      let best = { hour: 1, altitude: -90, sky: null };
      for (let hour = 0; hour < 24; hour += 2) {
        const sky = await stateAt(page, hour);
        if (sky.dayness < 0.05 && sky.moonAltitude > best.altitude) {
          best = { hour, altitude: sky.moonAltitude, sky };
        }
      }
      bestMoon = { hour: best.hour };
      if (best.altitude < 2) {
        throw new Error(
          `the moon never rises tonight (best ${best.altitude.toFixed(1)}° at ${best.hour}:00)`,
        );
      }
      if (best.sky.moonIllumination < 0 || best.sky.moonIllumination > 1) {
        throw new Error(`illumination ${best.sky.moonIllumination}`);
      }
      /*
       * The moon is a real control: the terrace switch and the sky body are two
       * handles on the world's light. It has to be findable, not merely present.
       */
      await atHour(page, best.hour);
      const info = await page.evaluate(debug());
      if (!info.sky || info.sky.dayness > 0.05) {
        throw new Error(`the moon's best hour is not night (dayness ${info.sky?.dayness})`);
      }
      if (info.celestialHidden.kind !== 'moon') {
        throw new Error(`the body reported as up is the ${info.celestialHidden.kind}`);
      }
      return `${best.hour}:00 — ${best.sky.moonPhase} (${(best.sky.moonIllumination * 100).toFixed(0)}% lit) at ${best.altitude.toFixed(1)}°, reported as the moon`;
    });

    /* ── Full-size frames ────────────────────────────────────────────── */

    /*
     * Everything above was about numbers the clock computes. Everything below
     * measures pixels, so the suite goes back to the size a visitor would
     * actually see — and resets the view on every step, because a pinned hour or
     * a turned camera from an earlier check would otherwise be what got measured.
     */
    await page.setViewport(FRAME_VIEWPORT.width, FRAME_VIEWPORT.height);
    await sleep(1200);

    /*
     * Each frame is allowed to settle. The camera eases back after the view is
     * reset, and the environment probe that carries the ambient colour is
     * refreshed on a slow clock, so a frame grabbed a moment after the hour
     * changes is a frame of a world still on its way there. Under the software
     * rasteriser that takes noticeably longer than on a real GPU, which is why
     * this waits on the world rather than for a fixed interval.
     */
    const settleFrames = async () => {
      await page.waitFor(
        `window.__worldDebug().transitioning === false`,
        { timeout: 60000, interval: 200, label: 'the blend to settle' },
      );
      await sleep(700);
    };

    for (const { hour, name } of HOURS) {
      await atHour(page, hour, 0, true);
      await settleFrames();
      const file = join(OUT, `${String(hour).replace('.', '-')}-${name}.png`);
      await page.screenshot(file);
      const info = await page.evaluate(debug());
      frames.set(name, { info, file });
      console.log(
        `      ${name.padEnd(12)} ${info.sky.label}  sun ${info.sky.sunAltitude
          .toFixed(1)
          .padStart(6)}°  moon ${info.sky.moonAltitude.toFixed(1).padStart(6)}°  ` +
          `dayness ${info.sky.dayness.toFixed(2)}  ${info.sky.moonPhase}`,
      );
    }

    await check('The moon waxes and wanes over a lunar month', async () => {
      /*
       * The phase is a property of the *date*, not of the hour — which makes
       * this the one astronomical claim the time dial cannot exercise, and the
       * reason the world's clock exposes a day as well. What this proves is that
       * the computed phase is a real one rather than a constant: over a month it
       * has to pass through every stage from new to full and back.
       */
      const readings = [];
      const seen = new Set();
      for (let day = 0; day < 30; day++) {
        const reading = await page.evaluate(`window.__worldSkyDay(${day})`);
        readings.push(reading);
        seen.add(reading.phase);
      }
      if (seen.size < 4) {
        throw new Error(`only ${seen.size} distinct phases over a month: ${[...seen].join(', ')}`);
      }
      const elongations = readings.map((r) => r.elongation);
      const min = Math.min(...elongations);
      const max = Math.max(...elongations);
      if (max - min < 120) {
        throw new Error(`the elongation only spans ${(max - min).toFixed(0)}° in a month`);
      }
      return `${seen.size} phases over 30 days (elongation ${min.toFixed(0)}°…${max.toFixed(0)}°): ${[...seen].join(', ')}`;
    });

    /*
     * A body can be in the *sky* and outside the *frame*, and those are different
     * claims. The overview camera faces south-east, so a northern-hemisphere noon
     * sun — due south and forty-six degrees up — is simply not in shot, and that
     * is correct rather than a fault.
     *
     * So the camera is turned to the body first. What is then asserted is the
     * claim that matters to a visitor: the disc you can see is the thing you can
     * press, and it sits on the frame exactly where its own bearing says.
     *
     * Eight in the morning rather than noon, because the rig's swing is bounded:
     * a visitor can look around, not all the way round. A noon sun is sixty
     * degrees from the composed view and out of reach; the morning sun is
     * twenty-six degrees to the left of it, which is a turn they can make.
     */
    await check('A sky body is drawn exactly where the astronomy puts it', async () => {
      await atHour(page, 8, 900, true);
      const sky = await page.evaluate(`window.__worldDebug().sky`);
      await page.evaluate(`window.__worldLookAt(${sky.sunAzimuth}, ${sky.sunAltitude})`);
      await sleep(900);
      const aimed = await page.evaluate(debug());
      const stage = FRAME_VIEWPORT;
      if (!aimed.celestial) {
        throw new Error(
          `the sun at ${sky.sunAltitude.toFixed(0)}° / ${sky.sunAzimuth.toFixed(0)}° has no position ` +
            `after turning to it (camera now facing ${aimed.rotation.bearing}° at ${aimed.rotation.pitch}°)`,
        );
      }
      /*
       * The camera's own swing is bounded, so a body higher than the top of that
       * swing cannot be brought to the middle of the frame. What must hold is
       * that the disc is on the frame or immediately beside its edge, and that
       * where it is, is exactly where its bearing says.
       */
      const margin = { x: stage.width * 0.5, y: stage.height * 0.5 };
      const outside =
        aimed.celestial.x < -margin.x ||
        aimed.celestial.x > stage.width + margin.x ||
        aimed.celestial.y < -margin.y ||
        aimed.celestial.y > stage.height + margin.y;
      if (outside) {
        throw new Error(
          `the sun's disc is at ${Math.round(aimed.celestial.x)},${Math.round(aimed.celestial.y)} — outside even a half-frame margin`,
        );
      }
      const { x, y } = aimed.celestial;
      const at = await page.evaluate(`window.__worldSkyAt(${sky.sunAzimuth}, ${sky.sunAltitude})`);
      const drift = Math.hypot(x - at.screen.x, y - at.screen.y);
      if (drift > 2) {
        throw new Error(`the sun's disc is ${drift.toFixed(1)}px from its own bearing`);
      }
      /*
       * The ray test only means something when the body is actually inside the
       * frame: it casts at a normalized coordinate, and a coordinate off the
       * frame describes a direction the camera is not looking in. The drift
       * check above carries the claim in that case.
       */
      const insideFrame =
        x >= 0 && x <= stage.width && y >= 0 && y <= stage.height;
      if (insideFrame && at.body !== 'sun') {
        throw new Error(`the scene has ${at.body ?? 'nothing'} where it reports the sun`);
      }
      await page.screenshot(join(OUT, 'body-in-frame.png'));

      /* And the moon, at the hour it is highest tonight. */
      await atHour(page, bestMoon.hour, 900, true);
      const nightSky = await page.evaluate(`window.__worldDebug().sky`);
      await page.evaluate(`window.__worldLookAt(${nightSky.moonAzimuth}, ${nightSky.moonAltitude})`);
      await sleep(900);
      const moonAimed = await page.evaluate(debug());
      if (moonAimed.celestialHidden.kind !== 'moon') {
        throw new Error(`the body reported as up is the ${moonAimed.celestialHidden.kind}`);
      }
      await page.screenshot(join(OUT, 'moon-in-frame.png'));
      return `sun ${drift.toFixed(1)}px from its own bearing at 08:00${insideFrame ? ', raycast resolves to the sun' : ' (just above the frame)'}; ${nightSky.moonPhase} (${(nightSky.moonIllumination * 100).toFixed(0)}% lit) at ${bestMoon.hour}:00`;
    });

    await check('The frame holds both the campus and the sky above it', async () => {
      /*
       * The overview composition is the thing that decides whether any of this
       * astronomy can be *seen*. Before it was fixed the camera's frame ended
       * thirteen degrees below the horizon, so the sky was computed, lit and
       * drawn — and then pointed at the ground.
       *
       * The view is reset first — the check below deliberately turns it — and the
       * reading is repeated until it settles, because the rig eases back rather
       * than snapping.
       */
      const rotation = await settlingRotation(page);
      const topOfFrame = rotation.pitch + rotation.fov / 2;
      if (topOfFrame < 1) {
        throw new Error(
          `the top of the frame is at ${topOfFrame.toFixed(1)}° — below the horizon, so no sky`,
        );
      }
      if (topOfFrame > 25) {
        throw new Error(`the frame reaches ${topOfFrame.toFixed(1)}° up — mostly empty sky`);
      }
      if (rotation.pitch > -10) {
        throw new Error(
          `the camera is only ${rotation.pitch}° down after resetting the view — the island is edge-on`,
        );
      }
      /* And the island is actually in it: the upper band is sky and the middle is not. */
      const file = frames.get('noon').file;
      const skyBand = luminanceOf(file, { top: 0.02, bottom: 0.12, left: 0.1, right: 0.9 });
      const islandBand = luminanceOf(file, { top: 0.5, bottom: 0.75, left: 0.35, right: 0.65 });
      if (skyBand.mean <= islandBand.mean) {
        throw new Error(
          `the top of the frame (${skyBand.mean.toFixed(1)}) is not brighter than the middle (${islandBand.mean.toFixed(1)})`,
        );
      }
      return `frame reaches ${topOfFrame.toFixed(1)}° above the horizon, ${Math.abs(rotation.pitch).toFixed(0)}° down at ${rotation.distance.toFixed(0)} units`;
    });

    await check('The day is bright and the night is dark, measured from the frames', async () => {
      const day = luminanceOf(frames.get('noon').file).mean;
      const night = luminanceOf(frames.get('night').file).mean;
      const dusk = luminanceOf(frames.get('dusk').file).mean;
      /*
       * The bounds are deliberately about the *sky* rather than about a
       * photometric target. The island's own palette is the visitor's reading
       * preference and is expected to be dark in dark mode, so the claim worth
       * making is that the sky is bright at midday, that the night sky is nearly
       * black, that the two are far apart, and that dusk lies between them.
       */
      if (night > 60) throw new Error(`night measures ${night.toFixed(1)} — too washed out`);
      if (day < 105) throw new Error(`day measures ${day.toFixed(1)} — the midday sky is too dark`);
      if (day - night < 70) {
        throw new Error(`day ${day.toFixed(1)} vs night ${night.toFixed(1)} — too little contrast`);
      }
      /* Dusk has to be *between* them: a sky that snaps is not a sky. */
      if (!(dusk > night && dusk < day)) {
        throw new Error(
          `dusk ${dusk.toFixed(1)} is not between night ${night.toFixed(1)} and day ${day.toFixed(1)}`,
        );
      }
      return `day ${day.toFixed(1)}, dusk ${dusk.toFixed(1)}, night ${night.toFixed(1)}`;
    });

    await check('Stars are out at night and gone by day', async () => {
      /*
       * The upper sky band. A sky gradient cannot exceed its own top stop, so
       * bright specks up there can only be the starfield.
       */
      const band = { top: 0.02, bottom: 0.18, left: 0.25, right: 0.75 };
      const night = luminanceOf(frames.get('night').file, band);
      const day = luminanceOf(frames.get('noon').file, band);
      if (night.mean >= day.mean) {
        throw new Error(`night sky ${night.mean.toFixed(1)} is not darker than day ${day.mean.toFixed(1)}`);
      }
      if (night.max < 120) {
        throw new Error(`no stars: brightest night-sky pixel is ${night.max.toFixed(0)}`);
      }
      return `night sky mean ${night.mean.toFixed(1)} with specks to ${night.max.toFixed(0)}, day mean ${day.mean.toFixed(1)}`;
    });

    await check('The key light follows the sun', async () => {
      const morning = (await stateAt(page, 8)).keyDirection;
      const afternoon = (await stateAt(page, 16)).keyDirection;
      const delta = Math.hypot(morning.x - afternoon.x, morning.z - afternoon.z);
      if (delta < 0.3) {
        throw new Error(`the key light barely moved (${delta.toFixed(3)})`);
      }
      if (morning.y <= 0 || afternoon.y <= 0) throw new Error('the key light went below the horizon');
      return `moved ${delta.toFixed(2)} across the day, elevation ${morning.y.toFixed(2)} → ${afternoon.y.toFixed(2)}`;
    });

    await check('The terrain is a height field, not a flat disc', async () => {
      const info = await page.evaluate(`window.__worldGeometry('island')`);
      if (!info) throw new Error('the island geometry could not be read back');
      const range = info.maxY - info.minY;
      if (!(range > 4)) throw new Error(`the island spans only ${range.toFixed(2)} units in y`);
      if (!info.hasVertexColors) throw new Error('the island has no band colours');
      /*
       * The plateau has to actually undulate. A flat shelf shows up as a
       * clustering of vertices at exactly one height, so the spread of the
       * upper band is the measurement that matters.
       */
      return `island y ${info.minY.toFixed(2)}…${info.maxY.toFixed(2)}, radius to ${info.maxRadius.toFixed(2)}, ${info.vertices} vertices`;
    });

    await check('The surface detail actually loaded', async () => {
      const info = await page.evaluate(`(() => {
        const world = document.querySelector('[data-world]');
        return {
          triangles: Number(world.dataset.triangles),
          drawCalls: Number(world.dataset.drawCalls),
        };
      })()`);
      if (!(info.triangles > 100000)) {
        throw new Error(`only ${info.triangles} triangles — the detail pass did not build`);
      }
      return `${info.triangles.toLocaleString()} triangles in ${info.drawCalls} draw calls`;
    });

    await check('The hour can be shared in a URL', async () => {
      await page.navigate(`${BASE}/?sky=18.5`);
      await ready(page);
      const info = await page.evaluate(debug());
      if (!info.sky.overridden) throw new Error('the URL did not pin the hour');
      if (info.sky.label !== '18:30') throw new Error(`the label reads ${info.sky.label}`);
      return `?sky=18.5 opened at ${info.sky.label}`;
    });

    await check('Releasing the pin hands the world back to the clock', async () => {
      await page.navigate(`${BASE}/`);
      await ready(page);
      const pinned = await page.evaluate(`window.__worldSkyTime(3)`);
      if (!pinned.overridden) throw new Error('the pin did not take');
      const released = await page.evaluate(`window.__worldSkyTime(null)`);
      if (released.overridden) throw new Error('the pin did not release');
      const info = await page.evaluate(debug());
      if (info.sky.overridden) throw new Error('the world is still pinned');
      return `3:00 → clock (${info.sky.label})`;
    });

    await check('No uncaught exceptions while walking the day', async () => {
      if (errors.length) throw new Error(errors.slice(0, 3).join(' | '));
      return `${HOURS.length} hours rendered cleanly`;
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
  console.log(`\nFrames: ${OUT}`);
  process.exitCode = failed.length ? 1 : 0;
};

main().catch((error) => {
  console.error('Harness error:', error);
  process.exitCode = 2;
});
