/**
 * The world's chrome.
 *
 * These are the controls that must be reachable whatever else is happening:
 * the map and destination menu, Home, the day/night (sun/moon) switch, and
 * the ambient-motion control. They live in an element the router persists, so
 * one set of handlers serves the whole session — no re-binding after a route
 * swap, and no possibility of duplicate listeners.
 *
 * This module deliberately does not import three.js. The interface has to
 * keep working when the renderer is the thing that failed.
 */

import { preserveDocumentState, restoreDocumentState, sceneDeclined } from './document-state';
import {
  currentTheme,
  hideWorldAlert,
  isAmbientPaused,
  setAmbientPaused,
  subscribeAmbient,
  subscribeTheme,
  toggleTheme,
  watchSystemTheme,
} from './theme-state';
const BOOT_KEY = '__abdWorldChrome';

interface BoundWindow extends Window {
  [BOOT_KEY]?: boolean;
  __worldRetry?: () => void;
}

function booted(): boolean {
  const flag = window as BoundWindow;
  if (flag[BOOT_KEY]) return true;
  flag[BOOT_KEY] = true;
  return false;
}

function mapButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('[data-world-map]');
}

function mapMenu(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-world-map-menu]');
}

/** Keep every theme control showing the state that is actually live. */
export function syncThemeControls(): void {
  const theme = currentTheme();
  for (const button of document.querySelectorAll<HTMLElement>('[data-theme-toggle]')) {
    button.setAttribute('aria-pressed', theme === 'light' ? 'true' : 'false');
    button.setAttribute(
      'aria-label',
      theme === 'light' ? 'Switch to night lighting' : 'Switch to daylight',
    );
    button.setAttribute('title', theme === 'light' ? 'Night lighting' : 'Daylight');
    const state = button.querySelector<HTMLElement>('[data-theme-state]');
    if (state) state.textContent = theme === 'light' ? 'Daylight' : 'Night';
    button.dataset.themeNow = theme;
  }
  for (const readout of document.querySelectorAll<HTMLElement>('[data-world-environment]')) {
    readout.textContent = theme === 'light' ? 'Daylight' : 'Night';
  }
}

export function syncAmbientControls(): void {
  const paused = isAmbientPaused();
  for (const button of document.querySelectorAll<HTMLElement>('[data-world-ambient]')) {
    button.setAttribute('aria-pressed', paused ? 'true' : 'false');
    button.setAttribute('aria-label', paused ? 'Resume ambient movement' : 'Pause ambient movement');
    button.setAttribute('title', paused ? 'Resume movement' : 'Pause movement');
    const label = button.querySelector<HTMLElement>('[data-ambient-state]');
    if (label) label.textContent = paused ? 'Paused' : 'Moving';
  }
}

/* ── The map menu ────────────────────────────────────────────────────── */

let menuOpen = false;

export function closeMapMenu(restoreFocus = false): void {
  const menu = mapMenu();
  const button = mapButton();
  if (!menu || !button) return;
  menuOpen = false;
  menu.hidden = true;
  button.setAttribute('aria-expanded', 'false');
  if (restoreFocus) button.focus();
}

export function openMapMenu(): void {
  const menu = mapMenu();
  const button = mapButton();
  if (!menu || !button) return;
  menuOpen = true;
  menu.hidden = false;
  button.setAttribute('aria-expanded', 'true');
  /* Move focus into the menu so the keyboard travels with it. */
  const first = menu.querySelector<HTMLElement>('a, button');
  first?.focus();
}

export function toggleMapMenu(): void {
  if (menuOpen) closeMapMenu();
  else openMapMenu();
}

/* ── Wiring ──────────────────────────────────────────────────────────── */

function onDocumentClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;

  const themeButton = target.closest('[data-theme-toggle]');
  if (themeButton) {
    toggleTheme({ animate: true });
    syncThemeControls();
    return;
  }

  const ambientButton = target.closest('[data-world-ambient]');
  if (ambientButton) {
    setAmbientPaused(!isAmbientPaused());
    syncAmbientControls();
    return;
  }

  const mapToggle = target.closest('[data-world-map]');
  if (mapToggle) {
    toggleMapMenu();
    return;
  }

  /* Selecting a destination closes the menu, so returning to it later shows
     the world rather than a stale open list. */
  if (target.closest('[data-world-map-menu] a')) {
    closeMapMenu();
    return;
  }

  if (menuOpen && !target.closest('[data-world-chrome]')) closeMapMenu();
}

function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !menuOpen) return;
  closeMapMenu(true);
}

/**
 * Start the chrome. Idempotent: the persisted element survives navigation, and
 * the guard means a second inline execution cannot bind a second set of
 * listeners.
 */
export function bootstrapChrome(): void {
  if (typeof document === 'undefined') return;
  restoreDocumentState();
  syncThemeControls();
  syncAmbientControls();

  /* If the visitor already chose to read without the 3D scene, that choice
     stands for the rest of the session: the controls still work, the failure
     screen stops asking. */
  if (sceneDeclined()) {
    const root = document.querySelector<HTMLElement>('[data-world]');
    if (root && root.dataset.worldState !== 'ready') root.dataset.worldState = 'degraded';
    hideWorldAlert();
  }

  if (booted()) return;

  /* The header's own fallback listener stands down once this is set. */
  (window as unknown as { __abdThemeDelegated?: boolean }).__abdThemeDelegated = true;

  document.addEventListener('click', onDocumentClick);
  document.addEventListener('keydown', onDocumentKeydown);

  document.addEventListener('astro:before-swap', (event) => {
    const detail = event as Event & { newDocument?: Document };
    preserveDocumentState(detail.newDocument);
    /* A panel that is being replaced must not leave the menu hanging open. */
    closeMapMenu();
  });

  subscribeTheme(() => syncThemeControls());
  subscribeAmbient(() => syncAmbientControls());
  watchSystemTheme();

  /* Reduced motion may change while the visitor is on the page. */
  if (typeof window.matchMedia === 'function') {
    try {
      const media = window.matchMedia('(prefers-reduced-motion: reduce)');
      media.addEventListener('change', () => syncAmbientControls());
    } catch {
      /* older engines: the initial value still applies */
    }
  }
}

/** Raised by the failure screen; the shell listens and rebuilds. */
export const RETRY_EVENT = 'world:retry';
