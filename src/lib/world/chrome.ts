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

import type { DestinationId } from './destinations';
import { preserveDocumentState, restoreDocumentState, sceneDeclined } from './document-state';
import {
  currentTheme,
  hideWorldAlert,
  isAmbientPaused,
  pinnedSkyHour,
  requestResetView,
  requestSkyTime,
  requestTravel,
  setAmbientPaused,
  showWorldAlert,
  subscribeAmbient,
  subscribeSkyState,
  subscribeSkyTime,
  subscribeTheme,
  THEME_TRANSITION_MS,
  toggleTheme,
  watchSystemTheme,
  type PublishedSkyState,
} from './theme-state';
const BOOT_KEY = '__abdWorldChrome';
const LIVE_TIP_VISIBLE_MS = 5_500;
const LIVE_TIP_CYCLE_MS = 14_000;

let liveTipIntervalId: ReturnType<typeof setInterval> | null = null;
let liveTipHideTimeoutId: ReturnType<typeof setTimeout> | null = null;

function setLivePulse(): void {
  for (const link of document.querySelectorAll<HTMLElement>('[data-world-live]')) {
    link.dataset.livePulse = 'true';
  }
}

function showLiveTipBurst(): void {
  const tip = document.querySelector<HTMLElement>('[data-world-live-tip]');
  if (!tip) return;
  tip.hidden = false;
  tip.classList.remove('world-live-tip--open');
  void tip.offsetWidth;
  tip.classList.add('world-live-tip--open');
  if (liveTipHideTimeoutId !== null) clearTimeout(liveTipHideTimeoutId);
  liveTipHideTimeoutId = setTimeout(() => {
    liveTipHideTimeoutId = null;
    const current = document.querySelector<HTMLElement>('[data-world-live-tip]');
    if (current) {
      current.hidden = true;
      current.classList.remove('world-live-tip--open');
    }
  }, LIVE_TIP_VISIBLE_MS);
}

function campusChromeReady(): boolean {
  if (document.documentElement.dataset.worldHold === 'true') return false;
  const world = document.querySelector('[data-world]');
  const state = world?.getAttribute('data-world-state');
  return state === 'ready' || state === 'degraded';
}

function ensureLivePromoCycle(): void {
  if (!campusChromeReady()) {
    const world = document.querySelector('[data-world]');
    const state = world?.getAttribute('data-world-state');
    if (state === 'error' || state === 'idle') return;
    window.requestAnimationFrame(ensureLivePromoCycle);
    return;
  }
  setLivePulse();
  if (liveTipIntervalId !== null) return;
  showLiveTipBurst();
  liveTipIntervalId = setInterval(() => {
    showLiveTipBurst();
  }, LIVE_TIP_CYCLE_MS);
}

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

/**
 * Keep every theme control showing the state that is actually live.
 *
 * The bar's light control, the map menu's readout and the pre-paint attribute
 * all have to agree with the scene, and the scene is the thing that cannot
 * drift: the icon is the light the world is in, and the accessible name is what
 * pressing the control will do.
 */
export function syncThemeControls(): void {
  const theme = currentTheme();
  for (const button of document.querySelectorAll<HTMLElement>('[data-theme-toggle]')) {
    button.setAttribute('aria-pressed', theme === 'light' ? 'true' : 'false');
    button.setAttribute(
      'aria-label',
      theme === 'light' ? 'Switch to night lighting' : 'Switch to daylight',
    );
    button.setAttribute('title', theme === 'light' ? 'Night lighting' : 'Daylight');
    button.dataset.themeNow = theme;
  }
  for (const readout of document.querySelectorAll<HTMLElement>('[data-world-environment]')) {
    readout.textContent = theme === 'light' ? 'Daylight' : 'Night';
  }
  for (const state of document.querySelectorAll<HTMLElement>('[data-world-theme-state]')) {
    state.textContent = theme === 'light' ? 'Daylight' : 'Night';
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

/**
 * The time dial.
 *
 * Its state lives in two places by necessity. The *dial position* is the
 * visitor's or the world's current hour, which the world publishes; the
 * *pressed* state is whether they have pinned one at all. Reading the second
 * from storage rather than from the slider matters: a slider always has a
 * position, so a slider alone cannot say "I am following the clock".
 */
export function syncSkyTimeControls(state?: PublishedSkyState): void {
  const pinned = pinnedSkyHour();
  const published = state ?? readPublishedSky();

  for (const range of document.querySelectorAll<HTMLInputElement>('[data-world-sky-hour]')) {
    const hours = published ? published.hours : minutesFromClock();
    const minutes = Math.round(((hours % 24) + 24) % 24 * 60);
    range.value = String(((minutes % 1440) + 1440) % 1440);
    range.setAttribute('aria-valuetext', published ? published.label : clockLabel(hours));
  }
  for (const button of document.querySelectorAll<HTMLElement>('[data-world-sky-follow]')) {
    /* Following the clock and standing at one hour are different states, and
       only storage can tell them apart: a slider always has a position. */
    button.setAttribute('aria-pressed', pinned === null ? 'true' : 'false');
  }
  for (const label of document.querySelectorAll<HTMLElement>('[data-world-sky-state]')) {
    if (published) {
      label.textContent = published.overridden
        ? `${published.label} — pinned`
        : `${published.label} — following your clock`;
    } else {
      label.textContent = pinned === null ? 'Following your clock' : `Pinned to ${clockLabel(pinned)}`;
    }
  }
}

/** The world's own reading, as it publishes it onto the stage element. */
export function readPublishedSky(): PublishedSkyState | null {
  const raw = document.querySelector<HTMLElement>('[data-world-stage]')?.dataset.skyState;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PublishedSkyState;
  } catch {
    return null;
  }
}

function minutesFromClock(): number {
  const now = new Date();
  return now.getHours() + now.getMinutes() / 60;
}

/** `18:42` from fractional hours. */
function clockLabel(hours: number): string {
  const wrapped = ((hours % 24) + 24) % 24;
  const h = Math.floor(wrapped);
  const m = Math.floor((wrapped - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/* ── The map menu ────────────────────────────────────────────────────── */

let menuOpen = false;

export function closeMapMenu(restoreFocus = false): void {
  const menu = mapMenu();
  const button = mapButton();
  if (!menu || !button) return;
  menuOpen = false;
  menu.classList.remove('is-open', 'is-opening');
  menu.setAttribute('hidden', '');
  button.setAttribute('aria-expanded', 'false');
  if (restoreFocus) button.focus();
}

export function openMapMenu(): void {
  const menu = mapMenu();
  const button = mapButton();
  if (!menu || !button) return;
  menuOpen = true;
  button.setAttribute('aria-expanded', 'true');
  menu.classList.remove('is-open');
  menu.classList.add('is-opening');
  menu.removeAttribute('hidden');
  /*
   * The play/pause and other controls must not paint a frame ahead of the
   * panel chrome. Two frames guarantees layout + background, then the whole
   * menu appears together; focus stays on the panel, not the first link.
   */
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      menu.classList.remove('is-opening');
      menu.classList.add('is-open');
      menu.focus({ preventScroll: true });
    });
  });
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

  /*
   * Handing the world back to the visitor's own clock. The dial's own movement
   * is handled on `input`, which fires continuously while a pointer is down —
   * this is the way *out* of a pinned hour, and it is a separate control
   * precisely because dragging a slider to "now" would be a coincidence rather
   * than a request.
   */
  if (target.closest('[data-world-sky-follow]')) {
    requestSkyTime(null);
    return;
  }

  /*
   * Reset view. The shell owns the camera, so this is a request rather than a
   * command: the chrome does not import three.js and keeps working when the
   * renderer is the thing that failed.
   */
  if (target.closest('[data-world-reset]')) {
    requestResetView();
    return;
  }

  const dockButton = target.closest<HTMLElement>('[data-world-dock]');
  if (dockButton?.dataset.worldDock) {
    requestTravel(dockButton.dataset.worldDock as DestinationId);
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
 * The time dial, moved.
 *
 * Dragging fires a great many `input` events, and each one is a full sky
 * recomputation: the astronomy, the palette, the light rig and the environment
 * probe. That is cheap enough to do per event — the trigonometry is a few
 * hundred flops — but the *probe* is a render pass, so it is throttled inside
 * the shell rather than here. What this handler must not do is persist on every
 * event: a drag across the dial would write a hundred times to storage, so the
 * value is written when the gesture ends instead.
 */
function onDocumentInput(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  if (!target.matches('[data-world-sky-hour]')) return;
  const minutes = Number(target.value);
  if (!Number.isFinite(minutes)) return;
  const hour = (minutes / 60) % 24;
  requestSkyTime(hour, { persist: false });
  /* The label follows the handle, so the dial reads while it is being dragged. */
  for (const label of document.querySelectorAll<HTMLElement>('[data-world-sky-state]')) {
    label.textContent = `${clockLabel(hour)} — pinned`;
  }
}

/** Committing the drag: this is the write that outlives the page. */
function onDocumentChange(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  if (!target.matches('[data-world-sky-hour]')) return;
  const minutes = Number(target.value);
  if (!Number.isFinite(minutes)) return;
  requestSkyTime((minutes / 60) % 24, { persist: true });
}

/**
 * Start the chrome. Idempotent: the persisted element survives navigation, and
 * the guard means a second inline execution cannot bind a second set of
 * listeners.
 */
function syncLiveBuildTip(): void {
  if (!document.querySelector('[data-world-live-tip]')) return;
  ensureLivePromoCycle();
}

export function bootstrapChrome(): void {
  if (typeof document === 'undefined') return;
  restoreDocumentState();
  syncThemeControls();
  syncAmbientControls();
  syncSkyTimeControls();
  syncLiveBuildTip();

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
  document.addEventListener('input', onDocumentInput);
  document.addEventListener('change', onDocumentChange);

  /*
   * The dial shows the world's own reading, not the last thing that was asked
   * for. The request travels one way and the answer the other, so a request with
   * no renderer listening leaves the dial honest about it rather than showing an
   * hour that never happened.
   */
  subscribeSkyState((state) => syncSkyTimeControls(state));

  document.addEventListener('astro:before-swap', (event) => {
    const detail = event as Event & { newDocument?: Document };
    preserveDocumentState(detail.newDocument);
    /* A panel that is being replaced must not leave the menu hanging open. */
    closeMapMenu();
  });

  document.addEventListener('astro:page-load', () => {
    syncLiveBuildTip();
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
