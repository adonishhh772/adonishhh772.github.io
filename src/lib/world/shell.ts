/**
 * The world shell.
 *
 * Owns the persistent side of the experience: one renderer, one scene, one
 * camera, alive for the whole session. Pages come and go around it.
 *
 * Responsibilities
 *  - build the renderer/scene once and reuse it across navigations
 *  - read the page's declared state (destination, open document) and compose
 *    a camera for it
 *  - project captions for destinations and for the objects at the current
 *    destination, skipping any that the reading surface covers
 *  - pause ambient motion while a document is open
 *  - survive client-side navigation, and tear down cleanly if asked
 *
 * Getting around is done in the world: a place caption is a button that
 * travels the camera, an object caption is a real link that opens its
 * document. Content links are ordinary anchors, so the ClientRouter
 * intercepts them, the URL updates, and Back/Forward work with no bespoke
 * history code — while the camera and the renderer stay alive throughout.
 */

import * as THREE from 'three';
import { DESTINATIONS, PLACE_INDEX, hostsObjects, type DestinationId } from '../world/destinations';
import {
  currentMode,
  isReading,
  readIndex,
  readState,
  type WorldIndex,
  type WorldState,
} from '../world/state';
import { Atmosphere } from '../observatory/lighting';
import { Materials } from '../observatory/materials';
import {
  PerformanceMonitor,
  detectTier,
  loadPreference,
  nextDown,
  nextUp,
  savePreference,
  settingsFor,
  type QualitySettings,
  type QualityTier,
} from '../observatory/quality';
import {
  currentThemeName,
  prefersReducedMotion,
  readWorldTheme,
  watchTheme,
} from '../observatory/theme';
import { ObservatoryWorld, fitDistance, type Shot } from '../observatory/world';
import { CameraRig } from '../observatory/camera';

export interface ShellHandle {
  applyState(): void;
  dispose(): void;
}

/* ── Capability ──────────────────────────────────────────────────────── */

export function webglAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    const context =
      canvas.getContext('webgl2') ??
      canvas.getContext('webgl') ??
      canvas.getContext('experimental-webgl');
    if (!context) return false;
    (context as WebGLRenderingContext).getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/* ── Compositions ────────────────────────────────────────────────────── */

const OVERVIEW_TARGET = new THREE.Vector3(0, 2.9, 0);

/** The campus overview: high enough to read every destination at once. */
function overviewShot(aspect: number): Shot {
  const portrait = aspect < 1.15;
  const radius = portrait ? 9.6 : 12.2;
  const fov = portrait ? 46 : 36;
  const distance = fitDistance(radius, fov, aspect);
  const direction = portrait
    ? new THREE.Vector3(0.4, 0.36, 0.68).normalize()
    : new THREE.Vector3(0.58, 0.44, 0.67).normalize();
  const target = OVERVIEW_TARGET.clone();
  /* A phone screen is tall: aim above the island's centre so the buildings
     fill it instead of leaving a dark band of ground underneath. */
  target.y = portrait ? 2.1 : 2.4;
  return { position: target.clone().addScaledVector(direction, distance), target, fov };
}

/**
 * Close enough to read a destination's architecture. `reach` pulls the camera
 * further out again when the visible region is a short band — a phone with a
 * document open — so the whole building stays in the strip.
 */
function placeShot(base: Shot, aspect: number, reach = 1): Shot {
  const scale = THREE.MathUtils.clamp(1.3 / Math.max(aspect, 0.4), 1, 1.7) * reach;
  const target = base.target.clone();
  return {
    position: target.clone().add(base.position.clone().sub(target).multiplyScalar(scale)),
    target,
    fov: base.fov,
  };
}

interface ViewMetrics {
  stageWidth: number;
  stageHeight: number;
  /** Region of the stage the document leaves visible. */
  free: { left: number; top: number; right: number; bottom: number };
}

/**
 * Compose a destination so the reading surface never covers it.
 *
 * The camera keeps its position and the look-at point is slid, which moves the
 * subject to the middle of the region the document leaves visible. That region
 * is a side panel on a desktop and a bottom sheet on a phone, so the shift is
 * computed on both axes rather than assuming one. The conversion from pixels
 * to world units uses the real distance and field of view, so it holds at any
 * viewport size instead of being a tuned guess.
 */
function readingShot(base: Shot, view: ViewMetrics): Shot {
  const position = base.position.clone();
  const target = base.target.clone();
  const freeCentreX = (view.free.left + view.free.right) / 2;
  const freeCentreY = (view.free.top + view.free.bottom) / 2;
  const offsetX = view.stageWidth / 2 - freeCentreX;
  const offsetY = view.stageHeight / 2 - freeCentreY;

  const distance = position.distanceTo(target);
  const worldPerPixel =
    (2 * distance * Math.tan(THREE.MathUtils.degToRad(base.fov) / 2)) /
    Math.max(view.stageHeight, 1);

  const forward = target.clone().sub(position).normalize();
  const right = new THREE.Vector3()
    .crossVectors(forward, new THREE.Vector3(0, 1, 0))
    .normalize();
  const up = new THREE.Vector3().crossVectors(right, forward).normalize();

  /* Sliding the look-at point moves the subject the opposite way on screen;
     screen Y grows downwards, hence the sign flip. */
  target
    .add(right.multiplyScalar(offsetX * worldPerPixel))
    .add(up.multiplyScalar(-offsetY * worldPerPixel));

  return { position, target, fov: base.fov };
}

/* ── Shell ───────────────────────────────────────────────────────────── */

interface Mounted {
  handle: ShellHandle;
}

const MOUNT_KEY = '__abdWorldShell';

interface WorldHost extends HTMLElement {
  [MOUNT_KEY]?: Mounted;
}

/**
 * A client-side navigation replaces the attributes on <html> with the ones
 * from the incoming document, and that document never executes its inline
 * probe. Put the two pre-paint decisions back.
 */
export function restoreDocumentState(): void {
  if (typeof document === 'undefined') return;
  const html = document.documentElement;
  if (!html.dataset.mode) {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem('world:mode');
    } catch {
      stored = null;
    }
    html.dataset.mode = stored === 'simple' ? 'simple' : 'world';
  }
  if (!html.dataset.theme) {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem('theme');
    } catch {
      stored = null;
    }
    const prefersLight =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: light)').matches;
    html.dataset.theme = stored || (prefersLight ? 'light' : 'dark');
  }
}

export function mountShell(root: WorldHost): ShellHandle {
  const stage = root.querySelector<HTMLElement>('[data-world-stage]');
  const canvas = root.querySelector<HTMLCanvasElement>('[data-world-canvas]');
  const hotspotLayer = root.querySelector<HTMLElement>('[data-world-hotspots]');
  const status = root.querySelector<HTMLElement>('[data-world-status]');
  const hint = root.querySelector<HTMLElement>('[data-world-hint]');
  if (!stage || !canvas || !hotspotLayer) {
    return { applyState() {}, dispose() {} };
  }
  const stageEl: HTMLElement = stage;
  const canvasEl: HTMLCanvasElement = canvas;
  const hotspotEl: HTMLElement = hotspotLayer;

  const portraitUrl = root.dataset.portrait ?? '';
  const index: WorldIndex = readIndex();
  const reducedMotion = prefersReducedMotion();
  const storedPreference = loadPreference();
  let tier: QualityTier = storedPreference ?? detectTier();
  let ambientAllowed = !reducedMotion;
  let settings: QualitySettings = settingsFor(tier, ambientAllowed);
  let theme = readWorldTheme(currentThemeName());

  /* ── Renderer, scene, world ──────────────────────────────────────── */
  const renderer = new THREE.WebGLRenderer({
    canvas: canvasEl,
    antialias: settings.antialias,
    powerPreference: 'high-performance',
    alpha: false,
    stencil: false,
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = theme.exposure;
  renderer.shadowMap.enabled = settings.shadows;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.setClearColor(new THREE.Color(theme.fog), 1);

  const scene = new THREE.Scene();
  const materials = new Materials(theme, settings);
  const atmosphere = new Atmosphere(theme, settings, renderer);
  scene.add(atmosphere.group);
  scene.environment = atmosphere.environment;
  scene.environmentIntensity = theme.environmentIntensity;
  scene.fog = atmosphere.fog;

  const world = new ObservatoryWorld(theme, settings, materials, atmosphere, index);
  scene.add(world.group);
  world.loadPortrait(portraitUrl);

  const rig = new CameraRig(1, overviewShot(1), reducedMotion);

  /* ── State ───────────────────────────────────────────────────────── */
  let state: WorldState = readState();
  let disposed = false;
  let onScreen = true;
  let reading = false;
  let focusPlace: DestinationId = 'campus';
  let hintTimer = 0;
  let hintDone = false;

  const hotspots = new Map<string, HTMLElement>();
  const occluded = new Map<string, boolean>();
  const raycaster = new THREE.Raycaster();
  const occluders: THREE.Object3D[] = [];
  let occlusionClock = 0;
  let labelLimit = 6;
  let panelRect: { left: number; top: number; right: number; bottom: number } | null = null;

  function labelLimitFor(value: QualityTier): number {
    const width = window.innerWidth;
    const base = width < 560 ? 3 : width < 900 ? 5 : 7;
    return value === 'low' ? Math.min(base, 4) : base;
  }

  /* ── Quality and theme ───────────────────────────────────────────── */
  function applyQuality(next: QualityTier, persist: boolean): void {
    tier = next;
    settings = settingsFor(next, ambientAllowed);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, settings.maxDpr));
    renderer.shadowMap.enabled = settings.shadows;
    materials.setQuality(settings);
    atmosphere.setQuality(settings);
    world.setQuality(settings);
    labelLimit = labelLimitFor(next);
    if (persist) savePreference(next);
    const select = document.querySelector<HTMLSelectElement>('[data-world-quality]');
    if (select) select.value = persist ? next : 'auto';
  }

  /** A stored preference is the visitor's decision, so the monitor stands down. */
  const manualQuality = storedPreference !== null;

  const monitor = new PerformanceMonitor((action) => {
    if (manualQuality) return;
    if (action === 'down') {
      const lower = nextDown(tier);
      if (lower !== tier) {
        monitor.noteDowngrade(tier);
        applyQuality(lower, false);
      }
    } else if (monitor.canUpgrade) {
      const higher = nextUp(tier);
      if (higher !== tier) {
        monitor.noteUpgrade();
        applyQuality(higher, false);
      }
    }
  });

  applyQuality(tier, storedPreference !== null);

  const stopThemes = watchTheme((name) => {
    theme = readWorldTheme(name);
    materials.setTheme(theme);
    atmosphere.setTheme(theme);
    world.setTheme(theme);
    scene.environment = atmosphere.environment;
    scene.environmentIntensity = theme.environmentIntensity;
    renderer.setClearColor(new THREE.Color(theme.fog), 1);
    renderer.toneMappingExposure = theme.exposure;
    renderOnce();
  });

  /* ── Captions ────────────────────────────────────────────────────── */
  function makeHotspot(
    key: string,
    href: string,
    label: string,
    meta: string,
    kind: 'place' | 'object',
  ): HTMLElement {
    /*
     * A place caption moves the camera, so it is a button; an object caption
     * opens a document, so it is a link with a real URL. That keeps history,
     * deep links and middle-click working for content while the world itself
     * stays the way you get around.
     */
    const link: HTMLElement =
      kind === 'place' ? document.createElement('button') : document.createElement('a');
    if (kind === 'place') (link as HTMLButtonElement).type = 'button';
    else (link as HTMLAnchorElement).href = href;
    link.className = `world-hotspot world-hotspot--${kind}`;
    link.dataset.worldHotspot = key;
    link.dataset.visible = 'false';
    link.tabIndex = -1;
    link.setAttribute('aria-hidden', 'true');
    const mark = document.createElement('span');
    mark.className = 'world-hotspot-mark';
    mark.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.className = 'world-hotspot-name';
    name.textContent = label;
    link.append(mark, name);
    if (meta) {
      const aside = document.createElement('span');
      aside.className = 'world-hotspot-meta';
      aside.setAttribute('aria-hidden', 'true');
      aside.textContent = meta;
      link.append(aside);
    }
    hotspotEl.append(link);
    link.addEventListener('focus', () => {
      link.dataset.visible = 'true';
    });
    if (kind === 'place') {
      const id = key.startsWith('place:') ? (key.slice(6) as DestinationId) : 'campus';
      link.addEventListener('click', () => travelTo(id));
    }
    return link;
  }

  interface Candidate {
    key: string;
    link: HTMLElement;
    anchor: THREE.Vector3;
    priority: number;
    occluded: boolean;
  }

  /**
   * Move to a destination without changing the URL. This is what a place
   * caption does: the world is the navigation, so looking around and going
   * somewhere are not the same act as opening a document.
   */
  function travelTo(id: DestinationId, immediate = false): void {
    if (disposed) return;
    focusPlace = id;
    lastDestination = id === 'campus' ? null : id;
    root.dataset.focus = id;
    world.setPlaceState(id === 'campus' ? null : id);
    if (id !== 'campus') world.triggerSignal(id);
    rig.resetOrbit();
    rebuildHotspots();
    compose(immediate);
  }

  /** Which captions belong on screen for the current state. */
  function rebuildHotspots(): void {
    hotspotEl.replaceChildren();
    hotspots.clear();

    const place = world.places.get(focusPlace);
    const atPlace = focusPlace !== 'campus' && Boolean(place);

    if (!atPlace) {
      for (const destination of DESTINATIONS) {
        if (!world.places.has(destination.id)) continue;
        const link = makeHotspot(
          `place:${destination.id}`,
          destination.href,
          destination.label,
          destination.name,
          'place',
        );
        hotspots.set(`place:${destination.id}`, link);
      }
    } else {
      /* At a destination: name the place itself, then its objects. */
      const back = makeHotspot('place:campus', '/', 'Campus', 'Back to the overview', 'place');
      hotspots.set('place:campus', back);

      if (hostsObjects(focusPlace)) {
        /*
         * The way into the place's own index page. Without the dock this is
         * what keeps every section reachable from the world alone.
         */
        const index = PLACE_INDEX[focusPlace];
        if (index) {
          const entry = makeHotspot(
            `object:index:${focusPlace}`,
            index.href,
            index.label,
            index.meta,
            'object',
          );
          hotspots.set(`object:index:${focusPlace}`, entry);
        }

        for (const marker of world.objectMarkers.filter((m) => m.place === focusPlace)) {
          const link = makeHotspot(
            `object:${marker.kind}:${marker.id}`,
            marker.href,
            marker.label,
            marker.meta,
            'object',
          );
          hotspots.set(`object:${marker.kind}:${marker.id}`, link);
        }
      }
    }
  }

  function anchorFor(key: string): THREE.Vector3 | null {
    if (key.startsWith('place:')) {
      const id = key.slice(6) as DestinationId;
      if (id === 'campus') {
        const node = world.places.get('campus');
        return node ? node.anchor.clone().add(new THREE.Vector3(0, 3.4, 0)) : null;
      }
      const node = world.places.get(id);
      return node ? node.anchor.clone() : null;
    }
    const parts = key.split(':');
    if (parts[1] === 'index') {
      const node = world.places.get(parts[2] as DestinationId);
      /* Above the place, so it never sits on top of an object's caption. */
      return node ? node.anchor.clone().add(new THREE.Vector3(0, 2.6, 0)) : null;
    }
    const marker = world.objectMarkers.find((m) => m.kind === parts[1] && m.id === parts[2]);
    return marker ? marker.anchor.clone() : null;
  }

  function measurePanel(): void {
    const surface = document.querySelector<HTMLElement>('[data-surface-panel]');
    if (!surface || currentMode() !== 'world' || !reading) {
      panelRect = null;
      return;
    }
    const style = getComputedStyle(surface);
    if (style.display === 'none' || style.visibility === 'hidden') {
      panelRect = null;
      return;
    }
    const rect = surface.getBoundingClientRect();
    panelRect = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  }

  function updateOcclusion(delta: number): void {
    occlusionClock -= delta;
    if (occlusionClock > 0) return;
    occlusionClock = 0.15;
    occluders.length = 0;
    occluders.push(...world.occluders());
    const origin = rig.camera.position;
    for (const key of hotspots.keys()) {
      const anchor = anchorFor(key);
      if (!anchor) continue;
      const direction = anchor.clone().sub(origin);
      const distance = direction.length();
      direction.normalize();
      raycaster.set(origin, direction);
      raycaster.far = Math.max(0.1, distance - 0.8);
      const hits = raycaster.intersectObjects(occluders, false);
      occluded.set(key, hits.length > 0);
    }
  }

  function projectHotspots(): void {
    const width = stageEl.clientWidth;
    const height = stageEl.clientHeight;
    const focused = document.activeElement as HTMLElement | null;
    const projected = new THREE.Vector3();
    const placed: { x: number; y: number; w: number; h: number }[] = [];

    const candidates: Candidate[] = [];
    for (const [key, link] of hotspots) {
      const anchor = anchorFor(key);
      if (!anchor) continue;
      projected.copy(anchor).project(rig.camera);
      const x = (projected.x * 0.5 + 0.5) * width;
      const y = (-projected.y * 0.5 + 0.5) * height;
      const offscreen = projected.z > 1 || x < -40 || x > width + 40 || y < -20 || y > height + 20;
      const isFocused = focused === link;
      const isOccluded = occluded.get(key) === true && !isFocused;
      /* Skip captions the open document is sitting on top of. */
      const underPanel =
        panelRect !== null &&
        x > panelRect.left - 24 &&
        x < panelRect.right + 24 &&
        y > panelRect.top - 24 &&
        y < panelRect.bottom + 24;
      const distance = rig.camera.position.distanceTo(anchor);
      candidates.push({
        key,
        link,
        anchor,
        priority:
          (isFocused ? 500 : 0) +
          /*
           * The place's own index page is the only route to its archive, so
           * it outranks the individual objects when the label budget bites.
           */
          (key.startsWith('object:index:') ? 200 : key.startsWith('object:') ? 100 : 0) +
          Math.max(0, 60 - distance),
        occluded: isOccluded || offscreen || underPanel,
      });
    }

    candidates.sort((a, b) => b.priority - a.priority);

    for (const candidate of candidates) {
      const isFocused = focused === candidate.link;
      const w = candidate.link.offsetWidth || 120;
      const h = candidate.link.offsetHeight || 40;
      let show = !candidate.occluded;
      if (show) {
        const box = { x: 0, y: 0, w, h };
        const p = candidate.anchor.clone().project(rig.camera);
        box.x = (p.x * 0.5 + 0.5) * width - w / 2;
        box.y = (-p.y * 0.5 + 0.5) * height - h / 2;
        const overlaps = placed.some(
          (o) =>
            box.x < o.x + o.w && box.x + box.w > o.x && box.y < o.y + o.h && box.y + box.h > o.y,
        );
        if (!isFocused && (overlaps || placed.length >= labelLimit)) show = false;
        else placed.push(box);
      }

      if (show) {
        const p = candidate.anchor.clone().project(rig.camera);
        const y = (-p.y * 0.5 + 0.5) * height;
        /* Keep the whole pill on screen: its own width decides the margin. */
        const margin = 8;
        const x = THREE.MathUtils.clamp(
          (p.x * 0.5 + 0.5) * width,
          w / 2 + margin,
          Math.max(w / 2 + margin, width - w / 2 - margin),
        );
        candidate.link.dataset.visible = 'true';
        candidate.link.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
        candidate.link.setAttribute('aria-hidden', 'false');
        candidate.link.tabIndex = 0;
      } else {
        candidate.link.dataset.visible = 'false';
        const unreachable = candidate.occluded;
        candidate.link.setAttribute('aria-hidden', unreachable ? 'true' : 'false');
        candidate.link.tabIndex = unreachable ? -1 : 0;
      }
    }
  }

  /* ── Camera composition ──────────────────────────────────────────── */
  /** The region of the stage the reading surface does not cover. */
  function viewMetrics(): ViewMetrics {
    const stageWidth = stageEl.clientWidth || 1;
    const stageHeight = stageEl.clientHeight || 1;
    if (!panelRect) {
      return {
        stageWidth,
        stageHeight,
        free: { left: 0, top: 0, right: stageWidth, bottom: stageHeight },
      };
    }
    /* Clamp the panel to the stage, so an overshooting rect cannot invert
       the free region. */
    const left = Math.max(0, Math.min(panelRect.left, stageWidth));
    const top = Math.max(0, Math.min(panelRect.top, stageHeight));
    const right = Math.max(left, Math.min(panelRect.right, stageWidth));
    const bottom = Math.max(top, Math.min(panelRect.bottom, stageHeight));
    const freeWidth = stageWidth - (right - left);
    const freeHeight = stageHeight - (bottom - top);
    const whole = { left: 0, top: 0, right: stageWidth, bottom: stageHeight };

    /* The document is docked to an edge: it is a bottom sheet on a phone and
       a side panel on a desktop. Find the strip it leaves behind. */
    const touches = {
      top: top <= 2,
      bottom: bottom >= stageHeight - 2,
      left: left <= 2,
      right: right >= stageWidth - 2,
    };

    if (freeHeight >= freeWidth && freeHeight > 48) {
      if (touches.bottom && !touches.top) {
        return { stageWidth, stageHeight, free: { left: 0, top: 0, right: stageWidth, bottom: top } };
      }
      if (touches.top && !touches.bottom) {
        return {
          stageWidth,
          stageHeight,
          free: { left: 0, top: bottom, right: stageWidth, bottom: stageHeight },
        };
      }
    } else if (freeWidth > 48) {
      if (touches.right && !touches.left) {
        return { stageWidth, stageHeight, free: { left: 0, top: 0, right: left, bottom: stageHeight } };
      }
      if (touches.left && !touches.right) {
        return {
          stageWidth,
          stageHeight,
          free: { left: right, top: 0, right: stageWidth, bottom: stageHeight },
        };
      }
    }
    return { stageWidth, stageHeight, free: whole };
  }

  function shotFor(): Shot {
    const view = viewMetrics();
    /* Frame for the space that is actually visible, not the whole window. */
    const freeWidth = Math.max(view.free.right - view.free.left, 200);
    const freeHeight = Math.max(view.free.bottom - view.free.top, 200);
    const aspect = freeWidth / freeHeight;
    const overview = overviewShot(aspect);

    /* The campus *is* the overview: whatever is open there, the visitor
       should still be looking at the whole place. */
    if (focusPlace === 'campus') {
      return reading ? readingShot(overview, view) : overview;
    }
    /* A wide, short strip needs the subject smaller than a tall one. */
    const band = freeHeight < view.stageHeight * 0.5;
    const node = world.places.get(focusPlace);
    const base = node ? placeShot(node.shot, aspect, band ? 1.45 : 1) : overview;
    return reading ? readingShot(base, view) : base;
  }

  function compose(immediate: boolean): void {
    rig.goTo(shotFor(), { immediate: immediate || reducedMotion });
  }

  /* ── Apply the page's state ──────────────────────────────────────── */
  let lastDestination: DestinationId | null = null;

  function applyState(): void {
    const previous = state;
    state = readState();
    reading = isReading(state);
    /*
     * Where the camera starts for this page: the place the URL names, or the
     * campus overview. Travel from there is the visitor's to change.
     */
    focusPlace = state.destination;
    if (state.surface === 'none') focusPlace = 'campus';

    world.setPlaceState(focusPlace === 'campus' ? null : focusPlace);
    lastDestination = focusPlace === 'campus' ? null : focusPlace;
    rebuildHotspots();
    measurePanel();
    compose(
      previous.destination !== state.destination ||
        previous.surface !== state.surface ||
        previous.panel !== state.panel,
    );

    if (focusPlace !== lastDestination) {
      if (focusPlace !== 'campus') world.triggerSignal(focusPlace);
      lastDestination = focusPlace;
    }
    root.dataset.worldReading = reading ? 'true' : 'false';
    root.dataset.focus = focusPlace;

    document.querySelectorAll<HTMLElement>('[data-surface-panel]').forEach((panel) => {
      if (panel.dataset.surfacePanel === state.surface) panel.removeAttribute('hidden');
      else panel.setAttribute('hidden', '');
    });

    renderOnce();
  }

  function dismissHint(): void {
    if (hintDone || !hint) return;
    hintDone = true;
    window.clearTimeout(hintTimer);
    hint.dataset.leaving = 'true';
    window.setTimeout(() => {
      hint.hidden = true;
      hint.dataset.leaving = 'false';
    }, 460);
  }

  /* ── Controls ────────────────────────────────────────────────────── */
  const cleanups: (() => void)[] = [];

  /*
   * Interaction: the world is the interface, so dragging it and zooming it
   * are always available. One pointer orbits, two pinch to zoom, the wheel
   * zooms. Pointer capture means a drag that leaves the stage keeps working.
   */
  function wireInteraction(): void {
    if (stageEl.dataset.wired === '1') return;
    stageEl.dataset.wired = '1';

    const active = new Map<number, { x: number; y: number }>();
    let pinchDistance = 0;

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 && event.pointerType === 'mouse') return;
      active.set(event.pointerId, { x: event.clientX, y: event.clientY });
      stageEl.setPointerCapture(event.pointerId);
      stageEl.dataset.dragging = 'true';
      if (active.size === 2) pinchDistance = twoPointerDistance(active);
      dismissHint();
    };

    const onPointerMove = (event: PointerEvent) => {
      const previous = active.get(event.pointerId);
      if (!previous) return;
      const dx = event.clientX - previous.x;
      const dy = event.clientY - previous.y;
      active.set(event.pointerId, { x: event.clientX, y: event.clientY });

      if (active.size >= 2) {
        const next = twoPointerDistance(active);
        if (pinchDistance > 0 && next > 0) rig.zoomBy((next - pinchDistance) / pinchDistance);
        pinchDistance = next;
        return;
      }
      if (dx || dy) rig.orbit(dx, dy);
    };

    const endPointer = (event: PointerEvent) => {
      active.delete(event.pointerId);
      if (active.size < 2) pinchDistance = 0;
      if (active.size === 0) stageEl.dataset.dragging = 'false';
    };

    const onWheel = (event: WheelEvent) => {
      if (currentMode() !== 'world') return;
      /* Line and page deltas normalise to roughly one notch. */
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
      rig.zoomBy(THREE.MathUtils.clamp((event.deltaY * unit) / 600, -0.4, 0.4));
      dismissHint();
    };

    const onDoubleClick = () => {
      rig.resetOrbit();
    };

    stageEl.addEventListener('pointerdown', onPointerDown);
    stageEl.addEventListener('pointermove', onPointerMove);
    stageEl.addEventListener('pointerup', endPointer);
    stageEl.addEventListener('pointercancel', endPointer);
    stageEl.addEventListener('pointerleave', endPointer);
    stageEl.addEventListener('wheel', onWheel, { passive: true });
    stageEl.addEventListener('dblclick', onDoubleClick);
    cleanups.push(() => {
      stageEl.removeEventListener('pointerdown', onPointerDown);
      stageEl.removeEventListener('pointermove', onPointerMove);
      stageEl.removeEventListener('pointerup', endPointer);
      stageEl.removeEventListener('pointercancel', endPointer);
      stageEl.removeEventListener('pointerleave', endPointer);
      stageEl.removeEventListener('wheel', onWheel);
      stageEl.removeEventListener('dblclick', onDoubleClick);
    });
  }

  /** Mean separation of two active pointers, for pinch zoom. */
  function twoPointerDistance(points: Map<number, { x: number; y: number }>): number {
    const [a, b] = [...points.values()];
    if (!a || !b) return 0;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || currentMode() !== 'world') return;
    if (reading) {
      /* Escape leaves the document, exactly like the Back control. */
      window.location.href = '/';
    }
  };
  document.addEventListener('keydown', onKeydown);
  cleanups.push(() => document.removeEventListener('keydown', onKeydown));

  /* ── Loop ────────────────────────────────────────────────────────── */
  let frameHandle = 0;
  let last = 0;
  let clock = 0;
  let running = false;

  function syncLoop(): void {
    const shouldRun =
      !disposed && onScreen && currentMode() === 'world' && stageEl.clientHeight > 0;
    if (shouldRun && !running) {
      running = true;
      last = performance.now();
      frameHandle = window.requestAnimationFrame(frame);
    } else if (!shouldRun && running) {
      running = false;
      window.cancelAnimationFrame(frameHandle);
    }
  }

  function renderOnce(): void {
    if (currentMode() !== 'world') return;
    atmosphere.follow(rig.camera);
    renderer.render(scene, rig.camera);
    projectHotspots();
  }

  function frame(now: number): void {
    if (disposed) return;
    const delta = Math.min(Math.max((now - last) / 1000, 0), 0.05);
    last = now;
    /* A document on screen means the scenery should settle, not perform. */
    const animate = ambientAllowed && !reading;
    if (animate) clock += delta;
    const step = animate ? delta : 0;

    rig.update(delta);
    world.update(clock, step);
    atmosphere.follow(rig.camera);
    renderer.render(scene, rig.camera);

    updateOcclusion(delta);
    projectHotspots();
    monitor.push(delta * 1000);

    frameHandle = window.requestAnimationFrame(frame);
  }

  function resize(): void {
    const width = Math.max(1, Math.round(stageEl.clientWidth));
    const height = Math.max(1, Math.round(stageEl.clientHeight));
    if (width <= 1 || height <= 1) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, settings.maxDpr));
    renderer.setSize(width, height, false);
    rig.setAspect(width / height);
    measurePanel();
    compose(true);
  }

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(stage);

  const intersectionObserver = new IntersectionObserver(
    (entries) => {
      onScreen = entries.some((entry) => entry.isIntersecting);
      syncLoop();
    },
    { rootMargin: '60px' },
  );
  intersectionObserver.observe(stage);

  const onVisibility = () => {
    if (document.hidden) {
      running = false;
      window.cancelAnimationFrame(frameHandle);
    } else {
      syncLoop();
    }
  };
  document.addEventListener('visibilitychange', onVisibility);
  cleanups.push(() => document.removeEventListener('visibilitychange', onVisibility));

  const onScroll = () => measurePanel();
  window.addEventListener('scroll', onScroll, { passive: true });
  cleanups.push(() => window.removeEventListener('scroll', onScroll));

  /* ── Navigation events ───────────────────────────────────────────── */
  const onAfterSwap = () => {
    restoreDocumentState();
    wireInteraction();
    applyState();
    syncLoop();
  };
  const onPageLoad = () => {
    restoreDocumentState();
    wireInteraction();
    applyState();
    syncLoop();
  };
  document.addEventListener('astro:after-swap', onAfterSwap);
  document.addEventListener('astro:page-load', onPageLoad);
  cleanups.push(() => {
    document.removeEventListener('astro:after-swap', onAfterSwap);
    document.removeEventListener('astro:page-load', onPageLoad);
  });

  /* ── Ready ───────────────────────────────────────────────────────── */
  root.dataset.worldState = 'ready';
  const stats = world.stats();
  root.dataset.triangles = String(stats.triangles);
  root.dataset.drawCalls = String(stats.drawCalls);
  if (status) {
    status.dataset.state = 'ready';
    const text = status.querySelector('[data-world-status-text]');
    if (text) text.textContent = status.dataset.messageReady ?? '';
    window.setTimeout(() => {
      if (!disposed) status.hidden = true;
    }, 3200);
  }

  if (hint) {
    hintTimer = window.setTimeout(() => {
      if (disposed || reading) return;
      hint.hidden = false;
      hintTimer = window.setTimeout(dismissHint, 7000);
    }, 1400);
  }
  root.addEventListener('pointerdown', dismissHint, { once: true });

  resize();
  wireInteraction();
  applyState();
  renderOnce();
  syncLoop();

  return {
    applyState,
    dispose() {
      if (disposed) return;
      disposed = true;
      running = false;
      window.cancelAnimationFrame(frameHandle);
      window.clearTimeout(hintTimer);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      stopThemes();
      for (const cleanup of cleanups) cleanup();
      world.dispose();
      materials.dispose();
      atmosphere.dispose();
      scene.clear();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}

/**
 * Boot the shell once per page load. With the ClientRouter the world element
 * is persisted across navigations, so this must never build a second
 * renderer: it reuses the existing mount and simply re-applies state.
 */
export function bootstrapShell(): void {
  if (typeof document === 'undefined') return;
  restoreDocumentState();
  const root = document.querySelector<WorldHost>('[data-world]');
  if (!root) return;

  if (currentMode() !== 'world') return;

  const existing = root[MOUNT_KEY];
  if (existing) {
    existing.handle.applyState();
    return;
  }
  root[MOUNT_KEY] = { handle: mountShell(root) };
}

export { webglAvailable as supportsWebgl };
