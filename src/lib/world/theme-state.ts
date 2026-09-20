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

/**
 * The storage keys. `theme` is deliberately the same key the pre-paint probe
 * in BaseLayout reads: a visitor who chose a theme before this refactor keeps
 * their choice, and there is only ever one place the choice is written.
 */
export const THEME_KEY = 'theme';
export const AMBIENT_KEY = 'world:ambient';

/** Fired on `document` whenever the shared state changes. */
export const THEME_EVENT = 'world:themechange';
export const AMBIENT_EVENT = 'world:ambientchange';

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

/**
 * Put the theme on the document, persist it when the visitor chose it, and
 * tell everyone listening. Returns the theme that is now live.
 */
export function setTheme(
  next: ThemeName,
  options: { animate?: boolean; persist?: boolean } = {},
): ThemeName {
  if (typeof document === 'undefined') return next;
  const root = document.documentElement;
  const previous = root.dataset.theme === 'light' ? 'light' : 'dark';
  const animate =
    (options.animate ?? true) && !prefersReducedMotion() && previous !== next;

  if (options.persist) {
    const store = storage();
    try {
      store?.setItem(THEME_KEY, next);
    } catch {
      /* storage unavailable — the choice lasts for this page only */
    }
  }

  root.dataset.theme = next;
  /* A marker the stylesheet uses to switch on colour transitions for exactly
     as long as the change is happening. */
  if (animate) {
    root.dataset.themeAnim = 'true';
    window.setTimeout(() => {
      if (root.dataset.theme === next) delete root.dataset.themeAnim;
    }, THEME_TRANSITION_MS + 80);
  } else {
    delete root.dataset.themeAnim;
  }

  const detail: ThemeChangeDetail = { theme: next, animate };
  document.dispatchEvent(new CustomEvent<ThemeChangeDetail>(THEME_EVENT, { detail }));
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
    setTheme(systemTheme(), { animate: true });
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
