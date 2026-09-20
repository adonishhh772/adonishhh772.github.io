/**
 * The loading experience's channel.
 *
 * The boot script owns the loader's DOM and defines the reporter on `window`;
 * the shell — which is the only thing that knows when the scene is really
 * built — reports through it. Keeping the two apart is what lets `shell.ts`
 * stay free of the interface it is being loaded behind, and the reporter is
 * optional at every call site: a missing loader is not an error, it is just a
 * page that is not showing one.
 */

export type ProgressReport = (value: number, label?: string) => void;

interface ProgressWindow extends Window {
  __worldProgress?: ProgressReport;
}

/** Report a real milestone: 0–100, plus what the visitor is waiting for. */
export function reportProgress(value: number, label?: string): void {
  if (typeof window === 'undefined') return;
  (window as ProgressWindow).__worldProgress?.(value, label);
}

/**
 * The world's own state, mirrored onto `<html>`.
 *
 * `[data-world]` carries the state the shell works from; the document element
 * carries the same value so the interface can be styled from one attribute.
 * The loading experience uses it to own the screen until the campus is
 * actually there — and, just as importantly, to hand it back in the states
 * where the visitor needs the controls: ready, reading without the scene, or
 * looking at the failure screen.
 */
export function mirrorWorldState(state: string): void {
  if (typeof document === 'undefined') return;
  const html = document.documentElement;
  html.dataset.worldState = state;
  const usable = state === 'ready' || state === 'degraded' || state === 'error';
  if (usable) html.dataset.worldReady = 'true';
  else delete html.dataset.worldReady;
}
