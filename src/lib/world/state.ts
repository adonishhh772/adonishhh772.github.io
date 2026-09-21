/**
 * World state: the contract between a server-rendered page and the client
 * shell.
 *
 * Every page declares where it is and what it is reading:
 *
 *   <body data-destination="library" data-surface="article" data-surface-id="from-demo">
 *
 * The shell reads those attributes on boot and again after every client-side
 * navigation, so a direct URL, a refresh and a Back button all land in the
 * same place.
 *
 * `data-mode` is decided before first paint: `world` when JavaScript and
 * WebGL are both available, `simple` otherwise. It is intentionally absent
 * from the served HTML so that a browser with no JavaScript at all renders
 * the conventional, readable pages.
 */

import {
  isDestinationId,
  isSurfaceKind,
  type DestinationId,
  type SurfaceKind,
} from './destinations';

export type WorldMode = 'world' | 'simple';

export interface WorldState {
  destination: DestinationId;
  surface: SurfaceKind;
  /** Slug of the open document, when the surface has one. */
  surfaceId: string;
  /** Panel side for this page's destination. */
  panel: 'left' | 'right';
}

const MODE_KEY = 'world:mode';

/** Read the state a page declared about itself. */
export function readState(root: ParentNode = document): WorldState {
  const body = root.querySelector('body') ?? (root as Element);
  const element = body as HTMLElement;
  const destination = element?.dataset?.destination;
  const surface = element?.dataset?.surface;
  const surfaceId = element?.dataset?.surfaceId ?? '';
  const panel = element?.dataset?.panel;
  return {
    destination: isDestinationId(destination) ? destination : 'campus',
    surface: isSurfaceKind(surface) && surface ? (surface as SurfaceKind) : 'none',
    surfaceId,
    panel: panel === 'right' ? 'right' : 'left',
  };
}

/**
 * Surfaces that are index views: a place's list of its own objects. They are
 * places rather than documents, so opening and closing one is travel.
 */
const INDEX_SURFACES: ReadonlySet<SurfaceKind> = new Set<SurfaceKind>([
  'projects',
  'articles',
  'repos',
]);

/**
 * True when a reading surface is open and therefore covers part of the world:
 * the scene settles and the camera composes for the space left over.
 */
export function isReading(state: WorldState): boolean {
  return state.surface !== 'none';
}

/** Index listings (projects, articles, repos) are travel, not document reading. */
export function isPlaceIndex(state: WorldState): boolean {
  return INDEX_SURFACES.has(state.surface);
}

/**
 * True when the camera should use full-scene framing rather than a document strip.
 */
export function isImmersiveWorld(state: WorldState): boolean {
  return !isReading(state) || isPlaceIndex(state);
}

/**
 * True when a specific document is open — the CV, the biography, one article,
 * one case study, the contact card. Those are what "close" returns from, so
 * they are what the return view is captured for.
 */
export function isDocument(state: WorldState): boolean {
  return state.surface !== 'none' && !INDEX_SURFACES.has(state.surface);
}

/* ── The return view ─────────────────────────────────────────────────── */

const RETURN_KEY = 'world:return';

/** Where the visitor was when they opened a document, and how they were looking. */
export interface ReturnView {
  /** Path they came from, so the close control can point at it. */
  href: string;
  destination: DestinationId;
  surface: SurfaceKind;
  focusPlace: DestinationId;
  azimuth: number;
  polar: number;
  zoom: number;
}

export function readReturnView(): ReturnView | null {
  try {
    const raw = sessionStorage.getItem(RETURN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ReturnView>;
    if (typeof parsed?.href !== 'string') return null;
    return {
      href: parsed.href,
      destination: isDestinationId(parsed.destination) ? parsed.destination : 'campus',
      surface: isSurfaceKind(parsed.surface) ? (parsed.surface as SurfaceKind) : 'none',
      focusPlace: isDestinationId(parsed.focusPlace) ? parsed.focusPlace : 'campus',
      azimuth: Number(parsed.azimuth) || 0,
      polar: Number(parsed.polar) || 0,
      zoom: Number(parsed.zoom) || 1,
    };
  } catch {
    return null;
  }
}

export function writeReturnView(view: ReturnView): void {
  try {
    sessionStorage.setItem(RETURN_KEY, JSON.stringify(view));
  } catch {
    /* storage unavailable — close falls back to the archive link */
  }
}

export function clearReturnView(): void {
  try {
    sessionStorage.removeItem(RETURN_KEY);
  } catch {
    /* nothing to do */
  }
}

/** Human-readable label for the location readout. */

export function readModePreference(): WorldMode | null {
  try {
    const stored = localStorage.getItem(MODE_KEY);
    return stored === 'simple' || stored === 'world' ? stored : null;
  } catch {
    return null;
  }
}

export function storeModePreference(mode: WorldMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* storage unavailable — the choice lasts for this page only */
  }
}

export function currentMode(): WorldMode {
  if (typeof document === 'undefined') return 'simple';
  return document.documentElement.dataset.mode === 'world' ? 'world' : 'simple';
}

export function setMode(mode: WorldMode): void {
  document.documentElement.dataset.mode = mode;
}

/**
 * The index of objects the world can show captions for. Pages embed this as
 * JSON so the scene is built from the real content collections rather than a
 * hard-coded list.
 */
export interface WorldIndexEntry {
  id: string;
  label: string;
  href: string;
  /** Shown as secondary text under the caption. */
  meta: string;
}

export interface WorldIndex {
  articles: WorldIndexEntry[];
  projects: WorldIndexEntry[];
  repos: WorldIndexEntry[];
}

export const EMPTY_INDEX: WorldIndex = { articles: [], projects: [], repos: [] };

export function readIndex(root: ParentNode = document): WorldIndex {
  const node = root.querySelector<HTMLScriptElement>('[data-world-index]');
  if (!node?.textContent) return EMPTY_INDEX;
  try {
    const parsed = JSON.parse(node.textContent) as Partial<WorldIndex>;
    return {
      articles: parsed.articles ?? [],
      projects: parsed.projects ?? [],
      repos: parsed.repos ?? [],
    };
  } catch {
    return EMPTY_INDEX;
  }
}

/** Human-readable label for the location readout. */
export function surfaceLabel(surface: SurfaceKind): string {
  switch (surface) {
    case 'cv':
      return 'Curriculum vitae';
    case 'about':
      return 'Biography';
    case 'projects':
      return 'Case studies';
    case 'project':
      return 'Case study';
    case 'articles':
      return 'All issues';
    case 'article':
      return 'Issue';
    case 'newsletter':
      return 'Subscribe';
    case 'repos':
      return 'Public repositories';
    case 'contact':
      return 'Contact options';
    case 'thanks':
      return 'Message sent';
    case 'welcome':
      return 'Welcome';
    case 'missing':
      return 'Not found';
    default:
      return 'Campus overview';
  }
}
