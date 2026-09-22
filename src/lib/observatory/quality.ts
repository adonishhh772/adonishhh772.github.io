/**
 * Quality management.
 *
 * Conservative at boot, then honest about what the device can actually do:
 * a rolling frame-time average drives at most one upgrade and any number
 * of downgrades. A manual preference is remembered across visits.
 */

export type QualityTier = 'high' | 'medium' | 'low';

export interface QualitySettings {
  tier: QualityTier;
  /** Hard cap on device pixel ratio. */
  maxDpr: number;
  antialias: boolean;
  shadows: boolean;
  shadowMapSize: number;
  /** Rings of instanced vegetation around the island edge. */
  treeRings: number;
  /**
   * Whether the grass layer is built at all.
   *
   * Grass is the one thing here whose cost is almost entirely fill rate: a
   * thousand alpha-tested cards near the camera will bring a weak GPU to its
   * knees in a way no amount of geometry reduction elsewhere compensates for.
   * It is therefore all-or-nothing at the bottom tier rather than thinned.
   */
  grassDensity: boolean;
  /** How many clumps the field is grown from. */
  grassTufts: number;
  /** Drifting mist layers under the island. */
  mistLayers: number;
  /** Travelling signal pulses along the pathway. */
  signalCount: number;
  /** Small figures cycling the ring walk (and the avenue at high quality). */
  cyclistCount: number;
  /** Small point light carried by the guide drone. */
  droneLight: boolean;
  /** Extra surface detail (railings, lattice cross-braces, rim lights). */
  detail: boolean;
  /** Allow any continuous ambient animation at all. */
  ambient: boolean;
}

export const QUALITY: Record<QualityTier, QualitySettings> = {
  high: {
    tier: 'high',
    maxDpr: 2,
    antialias: true,
    shadows: true,
    shadowMapSize: 2048,
    treeRings: 3,
    grassDensity: true,
    grassTufts: 7000,
    mistLayers: 5,
    signalCount: 5,
    cyclistCount: 3,
    droneLight: true,
    detail: true,
    ambient: true,
  },
  medium: {
    tier: 'medium',
    maxDpr: 1.75,
    antialias: true,
    shadows: true,
    shadowMapSize: 1024,
    treeRings: 2,
    grassDensity: true,
    grassTufts: 2400,
    mistLayers: 3,
    signalCount: 3,
    cyclistCount: 2,
    droneLight: false,
    detail: true,
    ambient: true,
  },
  low: {
    tier: 'low',
    maxDpr: 1.25,
    antialias: false,
    shadows: false,
    shadowMapSize: 512,
    treeRings: 1,
    grassDensity: false,
    grassTufts: 900,
    mistLayers: 2,
    signalCount: 2,
    cyclistCount: 0,
    droneLight: false,
    detail: false,
    ambient: true,
  },
};

const ORDER: QualityTier[] = ['low', 'medium', 'high'];
const STORAGE_KEY = 'observatory:quality';

export const QUALITY_LABELS: Record<QualityTier, string> = {
  low: 'Lite',
  medium: 'Balanced',
  high: 'Full',
};

export function isQualityTier(value: unknown): value is QualityTier {
  return value === 'low' || value === 'medium' || value === 'high';
}

export function loadPreference(): QualityTier | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isQualityTier(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function savePreference(tier: QualityTier): void {
  try {
    localStorage.setItem(STORAGE_KEY, tier);
  } catch {
    /* storage unavailable — the session still uses the chosen tier */
  }
}

export function clearPreference(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do */
  }
}

interface NavigatorWithHints extends Navigator {
  deviceMemory?: number;
  connection?: { saveData?: boolean; effectiveType?: string };
}

/**
 * Pick a starting tier. Deliberately pessimistic: a wrong guess costs a
 * few frames, and the monitor below can always promote.
 */
/** Touch-first phones (iOS Safari / Chrome) — used to tame sky/mist artefacts. */
export function isCoarsePhoneViewport(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(max-width: 860px) and (pointer: coarse)').matches;
}

export function detectTier(): QualityTier {
  if (typeof navigator === 'undefined') return 'medium';
  const nav = navigator as NavigatorWithHints;
  const cores = nav.hardwareConcurrency ?? 4;
  const memory = nav.deviceMemory ?? 4;
  const coarse =
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(pointer: coarse)').matches
      : false;
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const saveData = nav.connection?.saveData === true;
  const slowNetwork = /2g|slow-2g/.test(nav.connection?.effectiveType ?? '');

  if (saveData || slowNetwork) return 'low';
  if (coarse) return cores >= 6 && memory >= 6 ? 'medium' : 'low';
  if (cores >= 8 && memory >= 8 && dpr <= 2) return 'high';
  if (cores >= 4 && memory >= 4) return 'medium';
  return 'low';
}

export function settingsFor(tier: QualityTier, ambient: boolean): QualitySettings {
  const base = QUALITY[tier];
  return ambient ? base : { ...base, ambient: false };
}

export function nextDown(tier: QualityTier): QualityTier {
  const index = ORDER.indexOf(tier);
  return ORDER[Math.max(0, index - 1)];
}

export function nextUp(tier: QualityTier): QualityTier {
  const index = ORDER.indexOf(tier);
  return ORDER[Math.min(ORDER.length - 1, index + 1)];
}

export interface FrameStats {
  fps: number;
  /** Fraction of frames that took longer than the 60fps budget. */
  jank: number;
}

/**
 * Frame-time monitor with hysteresis, so a single stutter never triggers a
 * downgrade and a lucky second never triggers an upgrade.
 */
export class PerformanceMonitor {
  private samples: number[] = [];
  private readonly window = 90;
  private goodStreak = 0;
  private badStreak = 0;
  private readonly downgraded: QualityTier[] = [];
  upgraded = false;

  constructor(private readonly onDecide: (action: 'up' | 'down', stats: FrameStats) => void) {}

  reset(): void {
    this.samples.length = 0;
    this.goodStreak = 0;
    this.badStreak = 0;
  }

  noteUpgrade(): void {
    this.upgraded = true;
  }

  noteDowngrade(from: QualityTier): void {
    this.downgraded.push(from);
  }

  /** Returns true when the monitor believes a downgrade is already ruled out. */
  get canUpgrade(): boolean {
    return !this.upgraded && this.downgraded.length === 0;
  }

  push(deltaMs: number): FrameStats | null {
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) return null;
    this.samples.push(deltaMs);
    if (this.samples.length > this.window) this.samples.shift();
    if (this.samples.length < this.window) return null;

    const sorted = [...this.samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const slow = sorted.filter((d) => d > 20).length / sorted.length;
    const fps = Math.min(120, Math.round(1000 / Math.max(median, 1)));
    const stats: FrameStats = { fps, jank: slow };

    if (fps < 42 || slow > 0.34) {
      this.badStreak++;
      this.goodStreak = 0;
    } else if (fps > 56 && slow < 0.06) {
      this.goodStreak++;
      this.badStreak = 0;
    } else {
      this.goodStreak = 0;
      this.badStreak = 0;
    }

    if (this.badStreak >= 2) {
      this.badStreak = 0;
      this.samples.length = 0;
      this.onDecide('down', stats);
    } else if (this.goodStreak >= 6 && this.canUpgrade) {
      this.goodStreak = 0;
      this.samples.length = 0;
      this.onDecide('up', stats);
    }

    return stats;
  }
}
