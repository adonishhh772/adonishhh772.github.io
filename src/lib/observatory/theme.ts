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
  ceramic: number;
  metal: number;
  grass: number;
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
    exposure: 1.05,
    fogDensity: 0.0115,
    hemi: 0.8,
    keyIntensity: 2.9,
    practicalIntensity: 1.5,
    emissive: 1.25,
    environmentIntensity: 0.5,
  },
  light: {
    exposure: 0.96,
    fogDensity: 0.008,
    hemi: 1,
    keyIntensity: 3.2,
    practicalIntensity: 0.4,
    emissive: 0.5,
    environmentIntensity: 0.85,
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
    skyTop: 0x05080f,
    skyHorizon: 0x1a2544,
    fog: 0x0d1424,
    mist: 0x17223a,
    stone: 0x8a8272,
    stoneDeep: 0x5b5548,
    ceramic: 0xc9bda4,
    metal: 0x232e4d,
    grass: 0x3f5c50,
    key: 0xcfe0ff,
    practical: 0xffbe6a,
    signal: 0x6ee7d8,
  };

  if (typeof document !== 'undefined') {
    const styles = getComputedStyle(document.documentElement);
    palette.skyTop = token(styles, '--world-sky-top', '#05080f');
    palette.skyHorizon = token(styles, '--world-sky-horizon', '#1a2544');
    palette.fog = token(styles, '--world-fog', '#0d1424');
    palette.mist = token(styles, '--world-mist', '#17223a');
    palette.stone = token(styles, '--world-stone', '#8a8272');
    palette.stoneDeep = token(styles, '--world-stone-deep', '#5b5548');
    palette.ceramic = token(styles, '--world-ceramic', '#c9bda4');
    palette.metal = token(styles, '--world-metal', '#232e4d');
    palette.grass = token(styles, '--world-grass', '#3f5c50');
    palette.key = token(styles, '--world-key', '#cfe0ff');
    palette.practical = token(styles, '--world-practical', '#ffbe6a');
    palette.signal = token(styles, '--world-signal', '#6ee7d8');
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
  'ceramic',
  'metal',
  'grass',
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
