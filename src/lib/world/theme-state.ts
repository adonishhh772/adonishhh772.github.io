/**
 * One authoritative day/night state.
 *
 * The 3D world, the reading panels and every control all read and write the
 * same thing: `data-theme` on <html>. That attribute is decided before the
 * first paint by the inline probe in BaseLayout, restored before paint after
 * every client-side navigation, remembered in localStorage once the visitor
 * has made an explicit choice, and honoured from the system preference until
 * then.
 *
 * Nothing else keeps its own copy of the theme, so the physical switch, the
 * compact sun/moon control and the observatory can never disagree.
 */

import type { ThemeName } from '../observatory/theme';
import type { DestinationId } from './destinations';

/**
 * The storage keys. `theme` is deliberately the same key the pre-paint probe
 * in BaseLayout reads: a visitor who chose a theme before this refactor keeps
 * their choice, and there is only ever one place the choice is written.
 */
export const THEME_KEY = 'theme';
export const AMBIENT_KEY = 'world:ambient';
/**
 * A pinned hour of the day, or absent while the world follows the clock.
 *
 * Absent is the default and the interesting case: a visitor who has never
 * touched the time dial sees their own sky. Only an explicit choice is written,
 * so the world does not acquire a stale hour that outlives its season.
 */
export const SKY_HOUR_KEY = 'world:sky-hour';

/** Fired on `document` whenever the shared state changes. */
export const THEME_EVENT = 'world:themechange';
export const AMBIENT_EVENT = 'world:ambientchange';
export const SKY_TIME_EVENT = 'world:skytimechange';
/**
 * The world's own reading of the clock, published back to the interface.
 *
 * The request travels one way and the answer the other, because the interface
 * must not import three.js: it asks for an hour, and it shows the hour the world
 * actually computed. The two are usually the same and are allowed not to be —
 * a request with no renderer listening is a no-op, and the dial must not claim
 * otherwise.
 */
export const SKY_STATE_EVENT = 'world:skystate';

/** What the time dial and the URL parameter ask for. */
export interface SkyTimeDetail {
  /** Local hour in `[0, 24)`, or null to follow the clock. */
  hour: number | null;
  /** Where the request came from, for the persistence rule. */
  persist?: boolean;
}

/**
 * How long the coordinated environment + interface change takes.
 *
 * 800ms: long enough that the sky, the fog, the ambient light, the key light,
 * every emissive surface and the page all read as one movement of the light
 * rather than a cut, and short enough that a visitor who came to read is not
 * waiting on it.
 */
export const THEME_TRANSITION_MS = 800;

export interface ThemeChangeDetail {
  theme: ThemeName;
  /** False on the first application, and for reduced motion. */
  animate: boolean;
  /**
   * Who asked for the change.
   *
   * `visitor` — a press on a control, and by default anything that does not say
   * otherwise. `system` — the operating system's own colour preference
   * arriving while the visitor is on the page. The distinction matters to the
   * world, which treats a visitor's press as an instruction about the *time of
   * day* and follows it to noon or midnight, while a system preference is only
   * ever a statement about colours.
   */
  source?: 'visitor' | 'system';
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The visitor's explicit choice, or null while they have not made one. */
export function readStoredTheme(): ThemeName | null {
  const store = storage();
  if (!store) return null;
  try {
    const value = store.getItem(THEME_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

/** The operating system's preference. Honoured until an explicit choice. */
export function systemTheme(): ThemeName {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'dark';
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

/** What the theme should be right now: explicit choice first, system second. */
export function resolveTheme(): ThemeName {
  return readStoredTheme() ?? systemTheme();
}

/** The live state, read from the one place that owns it. */
export function currentTheme(): ThemeName {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

let themeCommitId = 0;

function publishTheme(
  root: HTMLElement,
  next: ThemeName,
  animate: boolean,
  source: 'visitor' | 'system',
): void {
  root.dataset.theme = next;
  const detail: ThemeChangeDetail = { theme: next, animate, source };
  document.dispatchEvent(new CustomEvent<ThemeChangeDetail>(THEME_EVENT, { detail }));
}

/**
 * Put the theme on the document, persist it when the visitor chose it, and
 * tell everyone listening. Returns the theme that is now live.
 *
 * The colour transition has to be armed a frame before the theme attribute
 * flips. Setting both in one turn makes the page jump to the new colours
 * while the island is still blending.
 */
export function setTheme(
  next: ThemeName,
  options: { animate?: boolean; persist?: boolean; source?: 'visitor' | 'system' } = {},
): ThemeName {
  if (typeof document === 'undefined') return next;
  const root = document.documentElement;
  const previous = root.dataset.theme === 'light' ? 'light' : 'dark';
  const animate =
    (options.animate ?? true) && !prefersReducedMotion() && previous !== next;
  const source = options.source ?? 'visitor';

  if (options.persist) {
    const store = storage();
    try {
      store?.setItem(THEME_KEY, next);
    } catch {
      /* storage unavailable — the choice lasts for this page only */
    }
  }

  themeCommitId += 1;
  const commitId = themeCommitId;

  if (!animate) {
    delete root.dataset.themeAnim;
    publishTheme(root, next, false, source);
    return next;
  }

  root.dataset.themeAnim = 'true';
  window.requestAnimationFrame(() => {
    if (commitId !== themeCommitId) return;
    publishTheme(root, next, true, source);
    window.setTimeout(() => {
      if (commitId !== themeCommitId) return;
      if (root.dataset.theme === next) delete root.dataset.themeAnim;
    }, THEME_TRANSITION_MS + 80);
  });
  return next;
}

export function toggleTheme(options: { animate?: boolean } = {}): ThemeName {
  return setTheme(currentTheme() === 'light' ? 'dark' : 'light', {
    animate: options.animate,
    persist: true,
  });
}

/** Follow the system preference while, and only while, no choice is stored. */
export function watchSystemTheme(): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  let media: MediaQueryList;
  try {
    media = window.matchMedia('(prefers-color-scheme: light)');
  } catch {
    return () => {};
  }
  const onChange = () => {
    if (readStoredTheme()) return;
    setTheme(systemTheme(), { animate: true, source: 'system' });
  };
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

/* ── Ambient motion ──────────────────────────────────────────────────── */

export function readStoredAmbient(): boolean | null {
  const store = storage();
  if (!store) return null;
  try {
    const value = store.getItem(AMBIENT_KEY);
    return value === 'paused' ? true : value === 'running' ? false : null;
  } catch {
    return null;
  }
}

/** True when the visitor asked the world to hold still. */
export function isAmbientPaused(): boolean {
  if (typeof document === 'undefined') return false;
  const stored = readStoredAmbient();
  if (stored !== null) return stored;
  return document.documentElement.dataset.ambient === 'paused';
}

export function setAmbientPaused(paused: boolean, options: { persist?: boolean } = {}): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.ambient = paused ? 'paused' : 'running';
  if (options.persist !== false) {
    const store = storage();
    try {
      store?.setItem(AMBIENT_KEY, paused ? 'paused' : 'running');
    } catch {
      /* storage unavailable — the choice lasts for this page only */
    }
  }
  document.dispatchEvent(
    new CustomEvent(AMBIENT_EVENT, { detail: { paused } }),
  );
}

/**
 * Everyone who needs the theme keeps listening through this, so there is a
 * single dispatch point in the whole application.
 */
export function subscribeTheme(onChange: (detail: ThemeChangeDetail) => void): () => void {
  if (typeof document === 'undefined') return () => {};
  const listener = (event: Event) => {
    onChange((event as CustomEvent<ThemeChangeDetail>).detail);
  };
  document.addEventListener(THEME_EVENT, listener);
  return () => document.removeEventListener(THEME_EVENT, listener);
}

export function subscribeAmbient(onChange: (paused: boolean) => void): () => void {
  if (typeof document === 'undefined') return () => {};
  const listener = (event: Event) => {
    onChange(Boolean((event as CustomEvent<{ paused: boolean }>).detail?.paused));
  };
  document.addEventListener(AMBIENT_EVENT, listener);
  return () => document.removeEventListener(AMBIENT_EVENT, listener);
}

/* ── The time of day ─────────────────────────────────────────────────── */

/**
 * The pinned hour, or null while the world follows the visitor's clock.
 *
 * Read once at boot so a pinned hour survives a reload. It is deliberately a
 * *nullable* value rather than a number with a "now" sentinel: following the
 * clock and standing at one hour are different states, and the second one has
 * to be something the visitor can leave.
 */
export function pinnedSkyHour(): number | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(SKY_HOUR_KEY);
    if (raw === null || raw === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) ? ((value % 24) + 24) % 24 : null;
  } catch {
    return null;
  }
}

/**
 * The world's own clock reading, published back to the interface.
 *
 * It carries the astronomy as well as the label because the interface has other
 * readers than the dial: the sky body's caption names the phase, and a support
 * question of the form "why is it dark at lunchtime?" is answered by the numbers
 * rather than by the words.
 */
export interface PublishedSkyState {
  label: string;
  hours: number;
  overridden: boolean;
  dayness: number;
  sunAltitude: number;
  moonAltitude: number;
  moonPhase: string;
}

/**
 * Ask the world for a particular hour.
 *
 * Raised as a request rather than applied directly, for the same reason the
 * camera reset is: this module must not import three.js, so the chrome states
 * what it wants and the shell, which owns the clock, answers.
 */
export function requestSkyTime(hour: number | null, options: { persist?: boolean } = {}): void {
  if (typeof document === 'undefined') return;
  const store = storage();
  if (options.persist !== false) {
    try {
      if (hour === null) store?.removeItem(SKY_HOUR_KEY);
      else store?.setItem(SKY_HOUR_KEY, String(hour));
    } catch {
      /* storage unavailable — the choice lasts for this page only */
    }
  }
  document.dispatchEvent(
    new CustomEvent(SKY_TIME_EVENT, { detail: { hour, persist: options.persist } }),
  );
}

export function subscribeSkyTime(
  onChange: (detail: SkyTimeDetail) => void,
): () => void {
  if (typeof document === 'undefined') return () => {};
  const listener = (event: Event) => {
    onChange((event as CustomEvent<SkyTimeDetail>).detail);
  };
  document.addEventListener(SKY_TIME_EVENT, listener);
  return () => document.removeEventListener(SKY_TIME_EVENT, listener);
}

/** Announced by the shell once its clock has moved. */
export function announceSkyState(state: PublishedSkyState): void {
  if (typeof document === 'undefined') return;
  document.dispatchEvent(new CustomEvent(SKY_STATE_EVENT, { detail: state }));
}

export function subscribeSkyState(
  onChange: (state: PublishedSkyState) => void,
): () => void {
  if (typeof document === 'undefined') return () => {};
  const listener = (event: Event) => {
    onChange((event as CustomEvent<PublishedSkyState>).detail);
  };
  document.addEventListener(SKY_STATE_EVENT, listener);
  return () => document.removeEventListener(SKY_STATE_EVENT, listener);
}

/**
 * A tiny shared bridge for the failure screen. The alert markup lives inside a
 * persisted element and must be reachable even when the world module itself
 * failed to download, so the helper is installed by plain inline script and
 * discovered here.
 */
export interface WorldAlertBridge {
  (message?: string): void;
  hide?: () => void;
}

/* ── Requests that belong to the renderer ────────────────────────────── */

/**
 * Asking for the camera to go back to its composed view.
 *
 * This module deliberately does not import three.js — the interface has to
 * keep working when the renderer is the thing that failed — so the chrome
 * raises a request and the shell, which owns the camera, answers it. A request
 * with no renderer listening is simply a no-op, which is the honest behaviour
 * for a control that has nothing to move.
 */
export const RESET_VIEW_EVENT = 'world:resetview';

export function requestResetView(): void {
  if (typeof document === 'undefined') return;
  document.dispatchEvent(new CustomEvent(RESET_VIEW_EVENT));
}

/** Ask the shell to travel to a campus destination without changing the URL. */
export const TRAVEL_EVENT = 'world:travel';

export interface TravelDetail {
  destination: DestinationId;
}

export function requestTravel(destination: DestinationId): void {
  if (typeof document === 'undefined') return;
  document.dispatchEvent(new CustomEvent<TravelDetail>(TRAVEL_EVENT, { detail: { destination } }));
}

export function showWorldAlert(message?: string): void {
  if (typeof window === 'undefined') return;
  const bridge = (window as unknown as { __worldAlert?: WorldAlertBridge }).__worldAlert;
  if (typeof bridge === 'function') bridge(message);
}

export function hideWorldAlert(): void {
  if (typeof window === 'undefined') return;
  const bridge = (window as unknown as { __worldAlert?: WorldAlertBridge }).__worldAlert;
  if (typeof bridge?.hide === 'function') bridge.hide();
}
