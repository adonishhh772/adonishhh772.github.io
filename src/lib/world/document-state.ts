/**
 * Pre-paint document state.
 *
 * `data-mode` and `data-theme` are decided by an inline probe in the document
 * head so that nothing paints in the wrong theme. Astro's client router
 * replaces <html>'s attributes with the incoming document's, and that
 * document never runs its own inline probe — so the decisions have to be
 * carried across the swap deliberately.
 *
 * `preserveDocumentState` runs on `astro:before-swap` and writes the live
 * values onto the incoming document, and `restoreDocumentState` runs after
 * the swap as a safety net. Between them there is no frame in which the
 * attribute is missing.
 */

export const MODE_ATTRIBUTE = 'data-mode';
export const THEME_ATTRIBUTE = 'data-theme';
export const AMBIENT_ATTRIBUTE = 'data-ambient';

/**
 * Set when the visitor explicitly asks to read the documents without the 3D
 * scene. It is a decision they made, so it is remembered for the session and
 * the failure screen stops asking.
 */
const SCENE_KEY = 'world:no-scene';

function session(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function sceneDeclined(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return session()?.getItem(SCENE_KEY) === '1';
  } catch {
    return false;
  }
}

export function declineScene(): void {
  try {
    session()?.setItem(SCENE_KEY, '1');
  } catch {
    /* storage unavailable — the choice lasts for this page only */
  }
}

export function allowScene(): void {
  try {
    session()?.removeItem(SCENE_KEY);
  } catch {
    /* nothing to do */
  }
}

/** Attributes that describe the visitor's environment, not the page. */
const CARRIED: string[] = [
  MODE_ATTRIBUTE,
  'data-webgl',
  THEME_ATTRIBUTE,
  AMBIENT_ATTRIBUTE,
  'data-theme-anim',
];

export function probeWebgl(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    const context =
      canvas.getContext('webgl2') ??
      canvas.getContext('webgl') ??
      (canvas.getContext('experimental-webgl') as WebGLRenderingContext | null);
    if (!context) return false;
    (context as WebGLRenderingContext).getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

function stored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function prefersLight(): boolean {
  if (typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches;
  } catch {
    return false;
  }
}

/**
 * Put the two capability/theme decisions back on <html> if the swap dropped
 * them. Existing values always win: they are the live state.
 *
 * The mode is `world` whenever script is running at all. A browser without
 * WebGL is a failure the visitor is told about, not a silent downgrade to a
 * different site.
 */
export function restoreDocumentState(): void {
  if (typeof document === 'undefined') return;
  const html = document.documentElement;
  if (!html.dataset.mode) {
    html.dataset.mode = 'world';
    html.dataset.webgl = probeWebgl() ? 'yes' : 'no';
  }
  if (!html.dataset.theme) {
    /* An explicit choice first, then the system preference — the same order
       the head probe uses, so a reload and a route swap agree. */
    html.dataset.theme = stored('theme') || (prefersLight() ? 'light' : 'dark');
  }
  if (!html.dataset.ambient) {
    html.dataset.ambient = stored('world:ambient') === 'paused' ? 'paused' : 'running';
  }
}

/**
 * Carry the live environment attributes onto the document that is about to
 * replace this one, before the swap happens.
 */
export function preserveDocumentState(newDocument: Document | null | undefined): void {
  if (!newDocument || typeof document === 'undefined') return;
  const source = document.documentElement;
  const target = newDocument.documentElement;
  if (!source || !target) return;
  for (const name of CARRIED) {
    const value = source.getAttribute(name);
    if (value !== null) target.setAttribute(name, value);
    else target.removeAttribute(name);
  }
}
