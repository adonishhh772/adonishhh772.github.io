/**
 * The sound controls.
 *
 * Mute, unmute, volume and the interface-sound switch, wired to the one audio
 * engine the whole session shares. Like the rest of the chrome this module
 * deliberately does not import three.js: the controls have to keep working when
 * the renderer is the thing that failed, and the music is not part of the
 * renderer.
 *
 * Everything here is idempotent. The chrome element is persisted across
 * client-side navigation, so a second `watchSoundControls()` call must not
 * bind a second set of listeners — that is how a single button ends up
 * toggling the music twice and appearing to do nothing.
 */

import {
  ambient,
  armFirstGesture,
  readEffects,
  readSoundPreference,
  readVolume,
  type AudioState,
} from './audio';

const BOOT_KEY = '__abdWorldSound';
const PANEL_KEY = '__abdWorldSoundPanel';
const SOUND_GATE_KEY = 'world:sound-gate';

function soundGateDismissed(): boolean {
  try {
    return window.sessionStorage.getItem(SOUND_GATE_KEY) === '1';
  } catch {
    return false;
  }
}

function syncSoundGate(): void {
  const gate = document.querySelector<HTMLElement>('[data-world-sound-gate]');
  const world = document.querySelector<HTMLElement>('[data-world]');
  if (!gate) return;
  if (soundGateDismissed()) {
    gate.hidden = true;
    return;
  }
  gate.hidden = world?.dataset.worldState !== 'ready';
}

/** Arm the first-gesture listener once the campus is up — not only after the entry card. */
function tryArmMusic(): void {
  const world = document.querySelector<HTMLElement>('[data-world]');
  if (!world || world.dataset.worldState !== 'ready') return;
  if (readSoundPreference() === 'off') return;
  armFirstGesture();
}

function dismissSoundGate(): void {
  try {
    window.sessionStorage.setItem(SOUND_GATE_KEY, '1');
  } catch {
    /* storage unavailable */
  }
  syncSoundGate();
}

interface BoundWindow extends Window {
  [BOOT_KEY]?: boolean;
  [PANEL_KEY]?: boolean;
}

function togglePanel(open: boolean | null): void {
  const panel = document.querySelector<HTMLElement>('[data-world-sound-panel]');
  const button = document.querySelector<HTMLElement>('[data-world-sound-toggle]');
  if (!panel || !button) return;
  const next = open ?? panel.hidden;
  panel.hidden = !next;
  button.setAttribute('aria-expanded', next ? 'true' : 'false');
}

export function closeSoundPanel(restoreFocus = false): void {
  const panel = document.querySelector<HTMLElement>('[data-world-sound-panel]');
  if (!panel || panel.hidden) return;
  togglePanel(false);
  if (restoreFocus) {
    document
      .querySelector<HTMLElement>('[data-world-sound-toggle]')
      ?.focus({ preventScroll: true });
  }
}

/** Paint one state into every sound control on the page. */
function paint(state: AudioState): void {
  const toggle = document.querySelector<HTMLElement>('[data-world-sound-toggle]');
  if (toggle) {
    toggle.setAttribute('aria-pressed', state.playing ? 'true' : 'false');
    const label = state.playing
      ? 'Sound on — mute the music'
      : state.wanted && state.blocked
        ? 'Sound unavailable — the browser blocked playback'
        : 'Sound off — play the ambient music';
    toggle.setAttribute('aria-label', label);
    toggle.setAttribute('title', label);
    const text = toggle.querySelector<HTMLElement>('[data-sound-label]');
    if (text) text.textContent = state.playing ? 'Sound on' : 'Sound off';
  }

  const mute = document.querySelector<HTMLElement>('[data-world-sound-mute]');
  if (mute) {
    mute.setAttribute('aria-pressed', state.playing ? 'true' : 'false');
    const label = state.playing ? 'Pause' : 'Play';
    mute.setAttribute('aria-label', `${label} the ambient music`);
    const text = mute.querySelector<HTMLElement>('[data-sound-mute-label]');
    if (text) text.textContent = label;
  }

  const range = document.querySelector<HTMLInputElement>('[data-world-volume]');
  if (range) {
    const value = String(Math.round(state.volume * 100));
    if (range.value !== value) range.value = value;
    range.setAttribute('aria-valuetext', `${value} percent`);
  }

  const effects = document.querySelector<HTMLInputElement>('[data-world-effects]');
  if (effects) effects.checked = state.effects;

  const note = document.querySelector<HTMLElement>('[data-sound-note]');
  if (note) {
    if (state.wanted && state.blocked) {
      note.dataset.state = 'blocked';
      note.textContent =
        'Your browser blocked playback. Press play again — a press on the page is what it is waiting for.';
    } else {
      note.dataset.state = 'ready';
      note.textContent =
        'Generated in your browser — no track is downloaded. Interface sounds are separate.';
    }
  }
}

/**
 * Start watching, once.
 *
 * Also where the music is armed: the first gesture anywhere on the page starts
 * it, because sound is the default and a browser will not allow anything
 * earlier than that. There is no card and no question — the visitor's first
 * press is the answer.
 */
export function watchSoundControls(): void {
  if (typeof document === 'undefined') return;
  const host = window as BoundWindow;

  const engine = ambient();
  engine.subscribe(paint);
  paint({
    playing: false,
    wanted: readSoundPreference() !== 'off',
    volume: readVolume(),
    effects: readEffects(),
    blocked: false,
  });

  /*
   * A read-only view of the music, in the same spirit as the world's own
   * diagnostics: it exists so a verification run can prove that sound starts,
   * stops and is remembered without anybody having to hear it.
   */
  window.__worldAudio = () => engine.state;

  if (host[BOOT_KEY]) return;
  host[BOOT_KEY] = true;

  /*
   * The popover goes away when the page under it does. The chrome element
   * survives a route swap, so without this it would hang open over the new
   * document — and the state it is showing belongs to the page that was
   * there when it was opened.
   */
  document.addEventListener('astro:before-swap', () => closeSoundPanel());

  const onVolume = (event: Event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    if (!input.matches('[data-world-volume]')) return;
    engine.setVolume(Number(input.value) / 100);
  };
  document.addEventListener('input', onVolume);
  document.addEventListener('change', onVolume);

  document.addEventListener('change', (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    if (!input.matches('[data-world-effects]')) return;
    engine.setEffects(input.checked);
  });

  /*
   * Every press in the interface answers with a small sound, as long as the
   * engine is running and the visitor has not switched interface sounds off.
   * It is delegated from the document rather than bound to each control, so a
   * control that arrives with a new page is covered without re-wiring.
   */
  document.addEventListener(
    'pointerdown',
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      if (target.closest('[data-world-enter-sound]')) {
        dismissSoundGate();
        engine.playFromGesture({ fadeMs: 1200 });
        return;
      }

      if (target.closest('[data-world-sound-mute]')) {
        engine.toggle();
        return;
      }

      if (target.closest('[data-world-sound-toggle]')) {
        engine.unlockFromUserGesture();
      }

      const control = target.closest('button, a[href], [role="button"], input[type="range"]');
      if (!control) return;
      engine.click('tap');
    },
    true,
  );

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    if (target.closest('[data-world-sound-toggle]')) {
      const panel = document.querySelector<HTMLElement>('[data-world-sound-panel]');
      togglePanel(panel?.hidden ?? true);
      return;
    }

    if (target.closest('[data-world-sound-mute]')) {
      return;
    }

    if (target.closest('[data-world-enter-sound]')) {
      return;
    }

    if (target.closest('[data-world-enter-silent]')) {
      try {
        window.sessionStorage.setItem(SOUND_GATE_KEY, '1');
      } catch {
        /* storage unavailable */
      }
      engine.pause({ forget: true });
      syncSoundGate();
      return;
    }

    /*
     * A press outside closes the popover — but only a press on the world.
     * Closing it for *any* click used to mean that opening the map menu, or
     * pressing a destination in it, also threw the sound controls away, which
     * made the panel look like it had failed to survive navigation.
     */
    if (target.closest('[data-world-chrome]')) return;
    if (target.closest('[data-surface-panel]')) return;
    closeSoundPanel();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    closeSoundPanel(true);
  });

  /*
   * The music is on unless the visitor turned it off. The first press, scroll,
   * key or touch anywhere on the page starts it once the campus is ready — the
   * entry card is optional and does not block arming.
   */
  tryArmMusic();

  syncSoundGate();
  const worldRoot = document.querySelector<HTMLElement>('[data-world]');
  if (worldRoot) {
    const observer = new MutationObserver(() => {
      syncSoundGate();
      tryArmMusic();
    });
    observer.observe(worldRoot, { attributes: true, attributeFilter: ['data-world-state'] });
  }

  document.addEventListener('visibilitychange', () => {
    engine.handleVisibility(document.hidden);
  });
}
