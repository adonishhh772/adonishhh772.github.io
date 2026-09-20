/**
 * Theme bridge.
 *
 * The DOM is the single source of truth for colour: the observatory reads
 * the `--world-*` custom properties that `global.css` already defines for
 * the day and night themes. Nothing here invents its own palette, so the
 * canvas and the page can never drift apart.
 */

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
 * Parse any CSS colour the browser understands into a linear-ready 0xRRGGBB
 * number. Uses a canvas probe so `rgb()`, hex and named colours all work.
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
  if (normalised.startsWith('#')) {
    return parseInt(normalised.slice(1), 16);
  }
  const match = normalised.match(/rgba?\(([^)]+)\)/);
  if (!match) return fallback;
  const parts = match[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return fallback;
  return (parts[0] << 16) | (parts[1] << 8) | parts[2];
}

/* ── Theme description ───────────────────────────────────────────────── */

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
  /** The warm light behind a window. Subdued by day, a lamp at night. */
  window: number;
  key: number;
  practical: number;
  signal: number;
}

export interface WorldTheme extends Palette {
  name: ThemeName;
  /**
   * 0 at night, 1 in daylight. Carried as a number rather than derived from
   * `name` so a day/night change can be blended frame by frame instead of
   * snapping at the halfway point.
   */
  dayness: number;
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
}

const NUMERICS: Record<
  ThemeName,
  Omit<WorldTheme, keyof Palette | 'name' | 'dayness'>
> = {
  dark: {
    exposure: 1.2,
    fogDensity: 0.0102,
    /*
     * A night that can still be read.
     *
     * The previous night was lit almost entirely by one directional key, so
     * every face turned away from it fell to black and the buildings read as
     * silhouettes rather than as architecture. The ambient term now carries
     * enough of the blue sky to keep surfaces legible at 1am, the key is warm
     * rather than neutral — a moonlit scene wants a little colour in it — and
     * the practical lamps carry further, which is what puts warm pools of
     * light on the paths instead of isolated bright dots.
     */
    hemi: 1.6,
    keyIntensity: 2.75,
    practicalIntensity: 2.1,
    emissive: 1.5,
    environmentIntensity: 0.7,
  },
  light: {
    exposure: 0.86,
    fogDensity: 0.0068,
    hemi: 1.2,
    keyIntensity: 2.9,
    practicalIntensity: 0.35,
    emissive: 0.5,
    environmentIntensity: 0.9,
  },
};

export const THEME_NAME_ATTRIBUTE = 'data-theme';

export function currentThemeName(): ThemeName {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function token(styles: CSSStyleDeclaration, name: string, fallback: string): number {
  return parseColor(styles.getPropertyValue(name), parseColor(fallback));
}

/** Read the live world palette from the document. */
export function readWorldTheme(name: ThemeName = currentThemeName()): WorldTheme {
  const palette: Palette = {
    skyTop: 0x030713,
    skyHorizon: 0x22386b,
    fog: 0x0c1526,
    mist: 0x1a2742,
    stone: 0x8f8878,
    stoneDeep: 0x5f5949,
    stoneAlt: 0x776f5e,
    earth: 0x5a5140,
    ceramic: 0xc6b99f,
    metal: 0x2b3859,
    grass: 0x4a6353,
    moss: 0x3d5748,
    shore: 0x6b6350,
    snow: 0xdfe6f2,
    cloudShade: 0x39496e,
    glass: 0x16233c,
    window: 0xffcb7d,
    key: 0xd5e2ff,
    practical: 0xffc478,
    signal: 0x7fe9db,
  };

  if (typeof document !== 'undefined') {
    const styles = getComputedStyle(document.documentElement);
    palette.skyTop = token(styles, '--world-sky-top', '#030713');
    palette.skyHorizon = token(styles, '--world-sky-horizon', '#22386b');
    palette.fog = token(styles, '--world-fog', '#0c1526');
    palette.mist = token(styles, '--world-mist', '#1a2742');
    palette.stone = token(styles, '--world-stone', '#8f8878');
    palette.stoneDeep = token(styles, '--world-stone-deep', '#5f5949');
    palette.stoneAlt = token(styles, '--world-stone-alt', '#776f5e');
    palette.earth = token(styles, '--world-earth', '#5a5140');
    palette.ceramic = token(styles, '--world-ceramic', '#c6b99f');
    palette.metal = token(styles, '--world-metal', '#2b3859');
    palette.grass = token(styles, '--world-grass', '#4a6353');
    palette.moss = token(styles, '--world-moss', '#3d5748');
    palette.shore = token(styles, '--world-shore', '#6b6350');
    palette.snow = token(styles, '--world-snow', '#dfe6f2');
    palette.cloudShade = token(styles, '--world-cloud-shade', '#39496e');
    palette.glass = token(styles, '--world-glass', '#16233c');
    palette.window = token(styles, '--world-window', '#ffcb7d');
    palette.key = token(styles, '--world-key', '#d5e2ff');
    palette.practical = token(styles, '--world-practical', '#ffc478');
    palette.signal = token(styles, '--world-signal', '#7fe9db');
  }

  const numeric = NUMERICS[name];
  const exposureToken =
    typeof document !== 'undefined'
      ? Number(getComputedStyle(document.documentElement).getPropertyValue('--world-exposure'))
      : NaN;

  return {
    name,
    dayness: name === 'light' ? 1 : 0,
    ...palette,
    ...numeric,
    exposure: Number.isFinite(exposureToken) && exposureToken > 0 ? exposureToken : numeric.exposure,
  };
}

/* ── Blending ────────────────────────────────────────────────────────── */

const PALETTE_KEYS: (keyof Palette)[] = [
  'skyTop',
  'skyHorizon',
  'fog',
  'mist',
  'stone',
  'stoneDeep',
  'stoneAlt',
  'earth',
  'ceramic',
  'metal',
  'grass',
  'moss',
  'shore',
  'snow',
  'cloudShade',
  'glass',
  'window',
  'key',
  'practical',
  'signal',
];

const NUMERIC_KEYS: (keyof Omit<WorldTheme, keyof Palette | 'name'>)[] = [
  'dayness',
  'exposure',
  'fogDensity',
  'hemi',
  'keyIntensity',
  'practicalIntensity',
  'emissive',
  'environmentIntensity',
];

function mixChannel(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

/** Blend two 0xRRGGBB colours channel by channel. */
export function mixColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  return (mixChannel(ar, br, t) << 16) | (mixChannel(ag, bg, t) << 8) | mixChannel(ab, bb, t);
}

/**
 * An intermediate theme. Written into `out` when one is supplied so a
 * transition allocates nothing per frame.
 */
export function blendTheme(
  from: WorldTheme,
  to: WorldTheme,
  t: number,
  out?: WorldTheme,
): WorldTheme {
  const target = out ?? ({} as WorldTheme);
  for (const key of PALETTE_KEYS) target[key] = mixColor(from[key], to[key], t);
  for (const key of NUMERIC_KEYS) target[key] = from[key] + (to[key] - from[key]) * t;
  target.name = t < 0.5 ? from.name : to.name;
  return target;
}

/**
 * Observe theme changes. `ThemeToggle` and the pre-paint script both write
 * `data-theme` on <html>, so a MutationObserver catches every route in.
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
