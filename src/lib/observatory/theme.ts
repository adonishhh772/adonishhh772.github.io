/**
 * Theme bridge.
 *
 * Two axes meet here, and keeping them apart is the whole point of this file.
 *
 * The **page** axis is the light/dark choice the visitor makes. It is a reading
 * preference: it controls the site's own colours and nothing physical.
 *
 * The **time** axis is the world's. It comes from the real clock by way of
 * `sky.ts` and it decides what the scene physically *is* — where the light is
 * coming from, what colour it is, how much of it there is, how thick the air
 * is, and how bright the sky is above the island.
 *
 * They are composed rather than mixed. The page supplies the material palette
 * at its two extremes (the CSS `--world-*` tokens are the twelve o'clock and
 * midnight anchors); the time supplies everything atmospheric. That way the
 * visitor's reading preference still tints the buildings and the grass, while
 * the sky overhead is never anything but the real sky for the hour — which is
 * the thing a viewer would notice immediately if it were wrong.
 */

import type { SkyState } from './sky';

export type ThemeName = 'light' | 'dark';

/* ── Colour parsing ──────────────────────────────────────────────────── */

let probe: CanvasRenderingContext2D | null = null;

function context(): CanvasRenderingContext2D | null {
  if (probe) return probe;
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  probe = canvas.getContext('2d');
  return probe;
}

/**
 * Parse any CSS colour the browser understands into a 0xRRGGBB number. A canvas
 * probe is used so `rgb()`, hex and named colours all work.
 */
export function parseColor(value: string, fallback = 0x000000): number {
  const ctx = context();
  if (!ctx || !value) return fallback;
  const input = value.trim();
  if (!input) return fallback;
  ctx.fillStyle = '#000000';
  ctx.fillStyle = input;
  const normalised = ctx.fillStyle;
  if (typeof normalised !== 'string') return fallback;
  if (normalised.startsWith('#')) return parseInt(normalised.slice(1), 16);
  const match = normalised.match(/rgba?\(([^)]+)\)/);
  if (!match) return fallback;
  const parts = match[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return fallback;
  return (parts[0] << 16) | (parts[1] << 8) | parts[2];
}

/* ── Palette ─────────────────────────────────────────────────────────── */

export interface Palette {
  skyTop: number;
  skyHorizon: number;
  fog: number;
  mist: number;
  stone: number;
  stoneDeep: number;
  /** A second stone, for the patches that break up the plateau. */
  stoneAlt: number;
  /** Dry earth under the planting. */
  earth: number;
  /** Dry, bleached grass — the second tone in any real field. */
  dryGrass: number;
  ceramic: number;
  metal: number;
  grass: number;
  /** A deeper green, for the shaded shelf under the trees. */
  moss: number;
  /** The bare ring at the lip of the cliff. */
  shore: number;
  /** The cool highlight on roofs and the dome. */
  snow: number;
  /** The underside of a cloud: snow pushed toward the sky it hangs in. */
  cloudShade: number;
  /** Glazing: dark by day, reflecting the sky. */
  glass: number;
  /** Tree bark, for the trunks. */
  bark: number;
  barkDeep: number;
  /** The warm light behind a window. Subdued by day, a lamp at night. */
  window: number;
  key: number;
  practical: number;
  signal: number;
  /** The bright mineral fleck in broken rock. */
  mineral: number;

  /* ── The time axis ───────────────────────────────────────────────── */
  /** The sky overhead at midnight. */
  skyTopNight: number;
  /** The sky at the horizon at midnight. */
  skyHorizonNight: number;
  /** The glow on the horizon at sunrise and sunset. */
  sunLow: number;
  /** A high sun: pale, slightly warm. */
  sunHigh: number;
  /** The sun near the horizon: deep orange. */
  sunSet: number;
  /** The colour the moon casts by. */
  moonLight: number;
  /** The key light low in the sky: warm. */
  keyWarm: number;
  /** The key light high in the sky: neutral. */
  keyCool: number;
}

const PALETTE_KEYS: (keyof Palette)[] = [
  'skyTop',
  'skyHorizon',
  'fog',
  'mist',
  'stone',
  'stoneDeep',
  'stoneAlt',
  'earth',
  'dryGrass',
  'ceramic',
  'metal',
  'grass',
  'moss',
  'shore',
  'snow',
  'cloudShade',
  'glass',
  'bark',
  'barkDeep',
  'window',
  'key',
  'practical',
  'signal',
  'mineral',
  'skyTopNight',
  'skyHorizonNight',
  'sunLow',
  'sunHigh',
  'sunSet',
  'moonLight',
  'keyWarm',
  'keyCool',
];

/* ── Theme ───────────────────────────────────────────────────────────── */

export interface WorldTheme extends Palette {
  name: ThemeName;
  /** 0 at night, 1 in full daylight. Smooth through twilight. */
  dayness: number;
  /** 1 at the darkest part of the night. */
  nightness: number;
  /** Peaks as the sun crosses the horizon. */
  twilight: number;
  /** Peaks with the sun low and warm. */
  golden: number;
  /** The deep blue after sunset and before sunrise. */
  blueHour: number;
  /** How much haze the air carries. */
  haze: number;
  /** The sun's altitude in degrees, for placing the key light. */
  sunAltitude: number;
  /** The sun's compass bearing in degrees, for placing the key light. */
  sunAzimuth: number;
  moonAltitude: number;
  moonAzimuth: number;
  /** Illuminated fraction of the moon's disc. */
  moonIllumination: number;
  /** The sun-to-moon angle in degrees; the sign says which limb is lit. */
  moonElongation: number;

  /** Overall renderer exposure. */
  exposure: number;
  /** Exponential fog density. */
  fogDensity: number;
  /** Ambient (hemisphere) light intensity. */
  hemi: number;
  /** Key light intensity. */
  keyIntensity: number;
  /** Practical (in-world lamp) intensity multiplier. */
  practicalIntensity: number;
  /** Emissive multiplier for signal strips. */
  emissive: number;
  /** How much the environment map contributes. */
  environmentIntensity: number;
  /** How brightly the sky dome itself is drawn. */
  skyIntensity: number;
  /** How strongly the stars show through. */
  starOpacity: number;
}

/**
 * The two anchor palettes, as they are read from CSS.
 *
 * These carry no time information at all; they are resolved against the sky in
 * `readWorldTheme`.
 */
export interface PaletteTheme extends Palette {
  name: ThemeName;
  dayness: number;
}

const DEFAULT_DARK: Palette = {
  skyTop: 0x030713,
  skyHorizon: 0x22386b,
  fog: 0x0c1526,
  mist: 0x1a2742,
  stone: 0x9a9284,
  stoneDeep: 0x5f5949,
  stoneAlt: 0x776f5e,
  earth: 0x5a5140,
  dryGrass: 0x9c8a5e,
  ceramic: 0xd8cdb8,
  metal: 0x2b3859,
  grass: 0x4a6353,
  moss: 0x3d5748,
  shore: 0x6b6350,
  snow: 0xdfe6f2,
  cloudShade: 0x39496e,
  glass: 0x16233c,
  bark: 0x4a3b2e,
  barkDeep: 0x2a2119,
  window: 0xffcb7d,
  key: 0xd5e2ff,
  practical: 0xffc478,
  signal: 0x7fe9db,
  mineral: 0xb9b0a0,
  skyTopNight: 0x03060f,
  skyHorizonNight: 0x101d3c,
  sunLow: 0xff7a2f,
  sunHigh: 0xfff4dc,
  sunSet: 0xff8a3c,
  moonLight: 0xa9bedd,
  keyWarm: 0xffc98d,
  keyCool: 0xd5e2ff,
};

const DEFAULT_LIGHT: Palette = {
  ...DEFAULT_DARK,
  skyTop: 0x2a63b8,
  skyHorizon: 0xbcd6ef,
  fog: 0xc3d6ea,
  mist: 0xcddcec,
  stone: 0xb0a796,
  stoneDeep: 0x6f6857,
  stoneAlt: 0x8a8271,
  earth: 0x6d6250,
  dryGrass: 0xbaa672,
  ceramic: 0xe4dac6,
  metal: 0x37456a,
  grass: 0x5d7a62,
  moss: 0x476355,
  shore: 0x847a63,
  snow: 0xf2f5fb,
  cloudShade: 0x9fb0cc,
  glass: 0x2c3f5f,
  bark: 0x564636,
  barkDeep: 0x33291f,
  window: 0xffd79a,
  key: 0xfff0d8,
  practical: 0xffce8a,
  signal: 0x4fc7bb,
  mineral: 0xcac2b2,
  skyTopNight: 0x061024,
  skyHorizonNight: 0x1d3059,
  sunLow: 0xff8a44,
  sunHigh: 0xfff8e8,
  sunSet: 0xff9a52,
  moonLight: 0x9fb4d4,
  keyWarm: 0xffd3a0,
  keyCool: 0xfff2e0,
};

/* ── The anchors, read from the document ─────────────────────────────── */

function token(styles: CSSStyleDeclaration, name: string, fallback: number): number {
  return parseColor(styles.getPropertyValue(name), fallback);
}

function stylesheetReading(fallback: Palette): Palette | null {
  if (typeof document === 'undefined') return null;
  const styles = getComputedStyle(document.documentElement);
  const read = (name: string, key: keyof Palette) => token(styles, name, fallback[key]);
  return {
    skyTop: read('--world-sky-top', 'skyTop'),
    skyHorizon: read('--world-sky-horizon', 'skyHorizon'),
    fog: read('--world-fog', 'fog'),
    mist: read('--world-mist', 'mist'),
    stone: read('--world-stone', 'stone'),
    stoneDeep: read('--world-stone-deep', 'stoneDeep'),
    stoneAlt: read('--world-stone-alt', 'stoneAlt'),
    earth: read('--world-earth', 'earth'),
    dryGrass: read('--world-dry-grass', 'dryGrass'),
    ceramic: read('--world-ceramic', 'ceramic'),
    metal: read('--world-metal', 'metal'),
    grass: read('--world-grass', 'grass'),
    moss: read('--world-moss', 'moss'),
    shore: read('--world-shore', 'shore'),
    snow: read('--world-snow', 'snow'),
    cloudShade: read('--world-cloud-shade', 'cloudShade'),
    glass: read('--world-glass', 'glass'),
    bark: read('--world-bark', 'bark'),
    barkDeep: read('--world-bark-deep', 'barkDeep'),
    window: read('--world-window', 'window'),
    key: read('--world-key', 'key'),
    practical: read('--world-practical', 'practical'),
    signal: read('--world-signal', 'signal'),
    mineral: read('--world-mineral', 'mineral'),
    skyTopNight: read('--world-sky-top-night', 'skyTopNight'),
    skyHorizonNight: read('--world-sky-horizon-night', 'skyHorizonNight'),
    sunLow: read('--world-sun-low', 'sunLow'),
    sunHigh: read('--world-sun-high', 'sunHigh'),
    sunSet: read('--world-sun-set', 'sunSet'),
    moonLight: read('--world-moon-light', 'moonLight'),
    keyWarm: read('--world-key-warm', 'keyWarm'),
    keyCool: read('--world-key-cool', 'keyCool'),
  };
}

export const THEME_NAME_ATTRIBUTE = 'data-theme';

export function currentThemeName(): ThemeName {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

/** Read the page's own palette, without applying the time of day. */
export function readPaletteTheme(
  name: ThemeName = currentThemeName(),
  styles?: CSSStyleDeclaration,
): PaletteTheme {
  const fallback = name === 'light' ? DEFAULT_LIGHT : DEFAULT_DARK;
  let palette = fallback;
  if (styles) {
    const read = (tokenName: string, key: keyof Palette) => token(styles, tokenName, fallback[key]);
    palette = {
      ...fallback,
      skyTop: read('--world-sky-top', 'skyTop'),
      skyHorizon: read('--world-sky-horizon', 'skyHorizon'),
      fog: read('--world-fog', 'fog'),
      mist: read('--world-mist', 'mist'),
      stone: read('--world-stone', 'stone'),
      stoneDeep: read('--world-stone-deep', 'stoneDeep'),
      stoneAlt: read('--world-stone-alt', 'stoneAlt'),
      earth: read('--world-earth', 'earth'),
    };
  } else {
    palette = stylesheetReading(fallback) ?? fallback;
  }
  return { ...palette, name, dayness: name === 'light' ? 1 : 0 };
}

/* ── The sky's own anchors ───────────────────────────────────────────── */

/**
 * What the sky is made of, independent of the page.
 *
 * These are the colours a real sky has at the three moments that matter, and
 * they are deliberately *not* the CSS tokens. The tokens are a reading
 * preference; the sky is not. A visitor in dark mode at noon should see a blue
 * midday sky over a dimmed campus, and one in light mode at midnight should see
 * a black sky over a pale one — anything else is a sky that changes colour when
 * a preference is toggled, which is a thing skies do not do.
 */
const SKY_ZENITH_NIGHT = 0x04070f;
const SKY_ZENITH_DAY = 0x2f6fc4;
const SKY_HORIZON_NIGHT = 0x141f3d;
const SKY_HORIZON_DAY = 0xc2d8ec;
const SKY_GROUND_NIGHT = 0x0a1120;
const SKY_GROUND_DAY = 0x9db6cd;
/** The sun's disc: white, because a sun that is yellow cannot read as bright. */
const SUN_HIGH = 0xfff8ec;

/* ── Blending ────────────────────────────────────────────────────────── */

function mixChannel(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

/** Blend two packed 0xRRGGBB colours channel by channel. */
export function mixColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  return (mixChannel(ar, br, t) << 16) | (mixChannel(ag, bg, t) << 8) | mixChannel(ab, bb, t);
}

const NUMERIC_KEYS: (keyof Omit<WorldTheme, keyof Palette | 'name' | 'dayness'>)[] = [
  'nightness',
  'twilight',
  'golden',
  'blueHour',
  'haze',
  'sunAltitude',
  'sunAzimuth',
  'moonAltitude',
  'moonAzimuth',
  'moonIllumination',
  'moonElongation',
  'exposure',
  'fogDensity',
  'hemi',
  'keyIntensity',
  'practicalIntensity',
  'emissive',
  'environmentIntensity',
  'skyIntensity',
  'starOpacity',
];

/**
 * A theme resolved for a moment in time.
 *
 * The atmospheric palette is composed in stages, and the staging is the whole
 * argument for doing this rather than cross-fading between two pictures:
 *
 *  1. **Day/night** walks the horizon and material colours from the midnight
 *     anchors to the noon anchors, driven by the sun's altitude rather than by
 *     the hour, so a winter afternoon is dark early and a summer evening is not.
 *  2. **The blue hour** lifts the sky's *mid* tones without touching the zenith,
 *     which is what the sky after sunset actually does: it goes deep blue from
 *     the top down rather than uniformly dimming.
 *  3. **The golden hour and twilight** warm the horizon and the sun's own
 *     colour, and they are applied last so that a sunset's orange is not
 *     subsequently washed out by the day/night walk.
 */
export function readWorldTheme(
  name: ThemeName = currentThemeName(),
  state?: SkyState,
  out?: WorldTheme,
): WorldTheme {
  const palette = readPaletteTheme(name);
  const day = state ? state.dayness : name === 'light' ? 1 : 0;
  const night = 1 - day;
  const twilight = state?.twilight ?? 0;
  const golden = state?.golden ?? 0;
  const blueHour = state?.blueHour ?? 0;
  const haze = state?.haze ?? 0.2;

  /*
   * ── The sky ────────────────────────────────────────────────────────
   *
   * Physical, not a reading preference. The sky over the island is the sky for
   * that hour and it does not care what colour the page's text is — which is the
   * mistake this started with: tying the sky to the `--world-sky-*` tokens meant
   * that a visitor reading in dark mode was shown the midnight sky at noon, and
   * the whole point of putting the sun where it really is was lost.
   *
   * So the sky has its own three anchors — midnight, the sun on the horizon, and
   * full day — and it walks between them on the sun's altitude. The page's tokens
   * still decide the sunrise and sunset *tints*, because a warm sunset is partly
   * a matter of taste, but the sky itself is not negotiable.
   */
  const zenith = mixColor(SKY_ZENITH_NIGHT, SKY_ZENITH_DAY, day);
  let horizon = mixColor(SKY_HORIZON_NIGHT, SKY_HORIZON_DAY, day);
  /* The blue hour deepens the sky below the horizon band, from the top down. */
  horizon = mixColor(horizon, SKY_ZENITH_NIGHT, blueHour * 0.25);
  /*
   * The warm band. Applied last and on both ends of the day, because a sunrise
   * and a sunset are the same physics: the sun is low and lighting the air from
   * beneath. The palette only chooses the *hue* of that warmth.
   */
  const warmWeight = Math.max(golden, twilight * 0.85);
  horizon = mixColor(horizon, palette.sunLow, warmWeight * 0.75);
  const zenithWarm = mixColor(zenith, palette.sunLow, warmWeight * 0.18);

  /* The sun's disc: white when high, warming as it reaches the horizon. */
  const sunColor = mixColor(
    mixColor(SUN_HIGH, palette.sunLow, 1 - day),
    palette.sunSet,
    twilight * 0.7,
  );
  /* The air below the horizon, which is what reads as haze under the island. */
  const fog = mixColor(SKY_GROUND_NIGHT, SKY_GROUND_DAY, day);
  const mist = mixColor(mixColor(fog, palette.mist, 0.3), palette.sunLow, warmWeight * 0.2);

  const theme = (out ?? ({} as WorldTheme)) as WorldTheme;
  /*
   * The material palette, carried straight across. It is the page's own, and
   * nothing about the hour changes it — the light does that, in the shaders.
   */
  for (const key of PALETTE_KEYS) theme[key] = palette[key];
  /*
   * Then the atmospheric colours that *do* move with the light. The zenith and
   * the horizon are written here too, so anything reading `theme.skyTop` sees
   * the sky the dome is actually drawing rather than the raw page token.
   */
  theme.skyTop = zenithWarm;
  theme.skyHorizon = horizon;
  theme.skyTopNight = palette.skyTopNight;
  theme.skyHorizonNight = palette.skyHorizonNight;
  theme.sunHigh = palette.sunHigh;
  theme.sunSet = palette.sunSet;
  theme.moonLight = palette.moonLight;
  theme.keyWarm = palette.keyWarm;
  theme.keyCool = palette.keyCool;
  theme.mineral = palette.mineral;
  theme.dryGrass = palette.dryGrass;
  theme.bark = palette.bark;
  theme.barkDeep = palette.barkDeep;

  /*
   * Fog and mist carry the light: warm at dusk, blue at night. The fog is the
   * sky's own below-horizon colour rather than the page's, so the distant ridges
   * dissolve into the air the sky is actually made of.
   */
  theme.fog = mixColor(fog, palette.fog, 0.35);
  theme.mist = mist;

  theme.name = name;
  theme.dayness = day;
  theme.nightness = night;
  theme.twilight = twilight;
  theme.golden = golden;
  theme.blueHour = blueHour;
  theme.haze = haze;
  theme.sunAltitude = state?.sun.altitude ?? (day > 0.5 ? 45 : -35);
  theme.sunAzimuth = state?.sun.azimuth ?? (day > 0.5 ? 150 : 330);
  theme.moonAltitude = state?.moon.altitude ?? -30;
  theme.moonAzimuth = state?.moon.azimuth ?? 40;
  theme.moonIllumination = state?.moon.illumination ?? 0.5;
  theme.moonElongation = state?.moon.elongation ?? 0;

  /*
   * Exposure, fog and the light rig.
   *
   * Exposure is the one number with a hard constraint on it: the verification
   * suite measures the rendered frame, and a night that is merely a dimmed day
   * reads as a washed-out failure. It is therefore driven by the *sun's height*
   * rather than by a taste curve, with an extra pull down at midwinter night.
   */
  const daylight = smoothstep(-9, 6, theme.sunAltitude);
  theme.exposure = 0.48 + daylight * 0.82 + golden * 0.08;
  theme.fogDensity = 0.0092 - daylight * 0.0038 + haze * 0.0028;
  /*
   * The night floor is deliberately not near zero.
   *
   * A physically honest night is black, and a black campus is a scene with
   * nothing in it: the island is lit by its own lamps, by a moon at whatever
   * phase it happens to be at, and by the sky above it, and all three of those
   * have to leave the ground and the buildings *readable* rather than merely
   * present. The floor is what carries that, and it is why the night values here
   * are brighter than the noon values divided by anything.
   */
  theme.hemi = 0.92 + daylight * 1.42;
  theme.keyIntensity = 0.72 + daylight * 2.95;
  theme.practicalIntensity = 2.6 - daylight * 2.3;
  theme.emissive = 1.75 - daylight * 1.05;
  theme.environmentIntensity = 0.6 + daylight * 0.4;
  theme.skyIntensity = 0.34 + daylight * 0.72 + twilight * 0.16;
  theme.starOpacity = clamp01(1 - smoothstep(-13, -3, theme.sunAltitude)) * 0.95;

  return theme;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * Blend two resolved themes, for the animated transition when the visitor
 * switches the page's light.
 *
 * The palette is interpolated and the derived numbers are taken from the
 * destination, because they are functions of the time of day and both ends of a
 * page-theme transition describe the *same* time. Interpolating them would
 * dim the world on the way across, which is exactly the artefact a cross-fade
 * of this kind produces if it is done without thinking.
 */
export function blendTheme(
  from: WorldTheme,
  to: WorldTheme,
  t: number,
  out?: WorldTheme,
): WorldTheme {
  const target = (out ?? ({} as WorldTheme)) as WorldTheme;
  for (const key of PALETTE_KEYS) target[key] = mixColor(from[key], to[key], t);
  for (const key of NUMERIC_KEYS) target[key] = from[key] + (to[key] - from[key]) * t;
  target.dayness = from.dayness + (to.dayness - from.dayness) * t;
  /* The time of day is not what is changing; take it from the destination. */
  target.sunAltitude = to.sunAltitude;
  target.sunAzimuth = to.sunAzimuth;
  target.moonAltitude = to.moonAltitude;
  target.moonAzimuth = to.moonAzimuth;
  target.moonIllumination = to.moonIllumination;
  target.moonElongation = to.moonElongation;
  target.haze = to.haze;
  target.twilight = to.twilight;
  target.golden = to.golden;
  target.blueHour = to.blueHour;
  target.exposure = from.exposure + (to.exposure - from.exposure) * t;
  target.skyIntensity = from.skyIntensity + (to.skyIntensity - from.skyIntensity) * t;
  target.starOpacity = from.starOpacity + (to.starOpacity - from.starOpacity) * t;
  target.name = t < 0.5 ? from.name : to.name;
  return target;
}

/**
 * Observe page-theme changes. `ThemeToggle` and the pre-paint script both write
 * `data-theme` on `<html>`, so a MutationObserver catches every route in.
 */
export function watchTheme(onChange: (name: ThemeName) => void): () => void {
  if (typeof document === 'undefined') return () => {};
  let last = currentThemeName();
  const observer = new MutationObserver(() => {
    const next = currentThemeName();
    if (next === last) return;
    last = next;
    onChange(next);
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [THEME_NAME_ATTRIBUTE],
  });
  return () => observer.disconnect();
}

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
