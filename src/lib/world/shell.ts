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
 *  - blend the day/night change through the whole environment
 *  - tell a tap from a drag, and never steal a gesture from a control
 *  - settle ambient motion while a document is open
 *  - survive client-side navigation, context loss and startup failure, and
 *    tear down cleanly if asked
 *
 * Getting around is done in the world: a place caption is a button that
 * travels the camera, an object caption is a real link that opens its
 * document. Content links are ordinary anchors, so the ClientRouter
 * intercepts them, the URL updates, and Back/Forward work — while the camera
 * and the renderer stay alive throughout.
 */

import * as THREE from 'three';
import { navigate } from 'astro:transitions/client';
import {
  DESTINATIONS,
  PLACE_INDEX,
  hostsObjects,
  type DestinationId,
} from '../world/destinations';
import {
  clearReturnView,
  currentMode,
  isDocument,
  isReading,
  readIndex,
  readReturnView,
  readState,
  surfaceLabel,
  writeReturnView,
  type WorldIndex,
  type WorldState,
} from '../world/state';
import { allowScene, restoreDocumentState, sceneDeclined } from '../world/document-state';
import {
  currentTheme,
  hideWorldAlert,
  isAmbientPaused,
  prefersReducedMotion,
  showWorldAlert,
  subscribeAmbient,
  subscribeTheme,
  THEME_TRANSITION_MS,
  toggleTheme,
} from '../world/theme-state';
import { blendTheme, readWorldTheme, type WorldTheme } from '../observatory/theme';
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
import { ObservatoryWorld, fitDistance, type Shot } from '../observatory/world';
import { CameraRig } from '../observatory/camera';

export interface ShellHandle {
  applyState(): void;
  dispose(): void;
}

/** How far a pointer may travel before it counts as a drag, in CSS pixels. */
const DRAG_THRESHOLD = 6;

/**
 * Screen-space tap radius for the light switch. It is a small physical
 * control among large buildings, so it is given a fair target of its own
 * rather than competing with a whole destination's hit volume.
 */
const SWITCH_TAP_RADIUS = 26;

/** Selectors whose gestures belong to the control, never to the camera. */
const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  'label',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[role="switch"]',
  '[contenteditable="true"]',
  '[data-world-no-gesture]',
].join(',');

const RETRY_EVENT = 'world:retry';

/** True when the event started on something that handles its own pointer. */
function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  /* Anything inside an overlay — the reading surface, the chrome, a caption —
     owns its gestures: the camera must not eat a scroll, a tap or a link. */
  if (target.closest('[data-surface-panel], [data-world-chrome], .world-hotspots')) return true;
  return Boolean(target.closest(INTERACTIVE_SELECTOR));
}

/* ── Capability ──────────────────────────────────────────────────────── */

export function webglAvailable(): boolean {
  if (typeof window === 'undefined') return false;
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

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/* ── Mount bookkeeping ───────────────────────────────────────────────── */

const MOUNT_KEY = '__abdWorldShell';

interface WorldHost extends HTMLElement {
  [MOUNT_KEY]?: Mounted;
}

interface Mounted {
  handle: ShellHandle;
  /** Set when the renderer has lost its context and needs a rebuild. */
  lost: boolean;
}

/** Report a startup problem honestly, with a retry, and never a silent swap. */
export function failStartup(reason: string): void {
  hideWorldAlert();
  showWorldAlert(reason);
}

/* ── Shell ───────────────────────────────────────────────────────────── */

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
  const reducedMotionQuery = prefersReducedMotion();
  const storedPreference = loadPreference();
  let tier: QualityTier = storedPreference ?? detectTier();
  let reducedMotion = reducedMotionQuery;
  let ambientAllowed = !reducedMotionQuery && !isAmbientPaused();
  let settings: QualitySettings = settingsFor(tier, ambientAllowed);
  let theme: WorldTheme = readWorldTheme(currentTheme());

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
  const clearColor = new THREE.Color(theme.fog);
  renderer.setClearColor(clearColor, 1);

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
  let announced: DestinationId = 'campus';
  let hintTimer = 0;
  let hintDone = false;
  let currentHref = typeof location === 'undefined' ? '/' : location.pathname;
  let contextLost = false;
  /** The caption that opened the open document, so focus can go back to it. */
  let lastOpenedKey: string | null = null;
  let openedByKeyboard = false;

  const hotspots = new Map<string, HTMLElement>();
  const occluded = new Map<string, boolean>();
  const raycaster = new THREE.Raycaster();
  const occluders: THREE.Object3D[] = [];
  let occlusionClock = 0;
  let labelLimit = 6;
  let panelRect: { left: number; top: number; right: number; bottom: number } | null = null;

  function labelLimitFor(value: QualityTier): number {
    const width = window.innerWidth;
    /* Phones get a small budget on purpose — but enough that the campus still
       reads as a set of destinations rather than one label at a time. */
    const base = width < 560 ? 4 : width < 900 ? 5 : 7;
    return value === 'low' ? Math.min(base, 5) : base;
  }

  /* ── Quality ─────────────────────────────────────────────────────── */
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

  /* ── Theme: one state, blended through the whole environment ─────── */

  let liveTheme: WorldTheme = theme;
  let themeFrom: WorldTheme | null = null;
  let themeTo: WorldTheme | null = null;
  let themeT = 0;
  let envClock = 0;
  const themeScratch = {} as WorldTheme;

  /**
   * Push a theme into every part of the environment. `environment` refreshes
   * the image-based probe: during a blend that is throttled, because the probe
   * is a render pass and the blend only needs a handful of them.
   */
  function applyTheme(next: WorldTheme, environment: boolean): void {
    theme = next;
    materials.setTheme(next);
    atmosphere.setTheme(next, { environment });
    world.setTheme(next);
    scene.environment = atmosphere.environment;
    scene.environmentIntensity = next.environmentIntensity;
    clearColor.setHex(next.fog);
    renderer.setClearColor(clearColor, 1);
    renderer.toneMappingExposure = next.exposure;
  }

  function startThemeTransition(next: WorldTheme, animate: boolean): void {
    if (!animate || reducedMotion) {
      themeFrom = null;
      themeTo = null;
      liveTheme = next;
      applyTheme(next, true);
      if (!running) renderOnce();
      return;
    }
    themeFrom = { ...liveTheme };
    themeTo = next;
    themeT = 0;
    envClock = 0;
  }

  /** Step the blend. Returns true while a transition is in flight. */
  function advanceTheme(delta: number): boolean {
    if (!themeFrom || !themeTo) return false;
    themeT = Math.min(1, themeT + (delta * 1000) / THEME_TRANSITION_MS);
    blendTheme(themeFrom, themeTo, easeInOut(themeT), themeScratch);
    envClock += delta * 1000;
    const environment = envClock >= 120 || themeT >= 1;
    if (environment) envClock = 0;
    liveTheme = { ...themeScratch };
    applyTheme(themeScratch, environment);
    if (themeT >= 1) {
      const settled = themeTo;
      themeFrom = null;
      themeTo = null;
      liveTheme = settled;
      applyTheme(settled, true);
    }
    return true;
  }

  const stopThemes = subscribeTheme((detail) => {
    startThemeTransition(readWorldTheme(detail.theme), detail.animate);
    updateSwitchHotspot();
    if (!running) renderOnce();
  });

  const stopAmbient = subscribeAmbient((paused) => {
    ambientAllowed = !paused && !reducedMotion;
    settings = settingsFor(tier, ambientAllowed);
    materials.setQuality(settings);
    atmosphere.setQuality(settings);
    world.setQuality(settings);
  });

  /* ── Captions ────────────────────────────────────────────────────── */
  function makeHotspot(
    key: string,
    href: string,
    label: string,
    meta: string,
    kind: 'place' | 'object' | 'switch',
  ): HTMLElement {
    /*
     * A place caption moves the camera, so it is a button; an object caption
     * opens a document, so it is a link with a real URL; the light switch is
     * a button that throws the same shared state as the interface control.
     * That keeps history, deep links and middle-click working for content
     * while the world itself stays the way you get around.
     */
    const link: HTMLElement =
      kind === 'object' ? document.createElement('a') : document.createElement('button');
    if (kind === 'object') (link as HTMLAnchorElement).href = href;
    else (link as HTMLButtonElement).type = 'button';
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
    } else if (kind === 'switch') {
      link.addEventListener('click', () => toggleTheme({ animate: true }));
      link.setAttribute('role', 'switch');
    } else {
      /* Remembered so closing the document can hand focus back to the caption
         the visitor opened it from. */
      link.addEventListener('click', () => {
        lastOpenedKey = key;
        openedByKeyboard = link.matches(':focus-visible');
      });
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
    root.dataset.focus = id;
    world.setPlaceState(id === 'campus' ? null : id);
    if (id !== 'campus' && id !== announced) world.triggerSignal(id);
    announced = id;
    rig.resetOrbit();
    rebuildHotspots();
    compose(immediate);
    syncChromeLocation();
  }

  /** Which captions belong on screen for the current state. */
  function rebuildHotspots(): void {
    /*
     * Replacing the captions must not drop the keyboard onto the body. A
     * caption that survives the rebuild keeps focus, which is what makes
     * travelling between places usable without a pointer.
     */
    const active = document.activeElement;
    const activeKey =
      active instanceof HTMLElement ? active.dataset.worldHotspot ?? null : null;

    hotspotEl.replaceChildren();
    hotspots.clear();

    const place = world.places.get(focusPlace);
    const atPlace = focusPlace !== 'campus' && Boolean(place);

    /* The light switch belongs to the campus, but it stays a live caption
       whenever it is on screen: it is how the environment is controlled. */
    const lightSwitch = makeHotspot('switch:lights', '#', 'Light switch', '', 'switch');
    hotspots.set('switch:lights', lightSwitch);

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
         * The way into the place's own index page. Without the map menu this
         * is what keeps every section reachable from the world alone.
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

    updateSwitchHotspot();

    if (activeKey) {
      hotspots.get(activeKey)?.focus({ preventScroll: true });
    }
  }

  /** Keep the physical switch's caption showing the live environment. */
  function updateSwitchHotspot(): void {
    const link = hotspots.get('switch:lights');
    if (!link) return;
    const day = currentTheme() === 'light';
    link.setAttribute('aria-pressed', day ? 'true' : 'false');
    link.setAttribute('aria-label', `Day and night light switch — currently ${day ? 'daylight' : 'night'}`);
    const meta = link.querySelector<HTMLElement>('.world-hotspot-meta');
    if (meta) meta.textContent = day ? 'Daylight' : 'Night';
  }

  function anchorFor(key: string): THREE.Vector3 | null {
    if (key === 'switch:lights') {
      return world.lightSwitch ? world.lightSwitch.anchor.clone() : null;
    }
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
    const surface = document.querySelector<HTMLElement>('[data-surface-panel]:not([hidden])');
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
           * it outranks the individual objects when the label budget bites;
           * destinations outrank the light switch, which is also in the
           * interface and always reachable there.
           */
          (key.startsWith('object:index:') ? 300 : 0) +
          (key.startsWith('object:') ? 200 : 0) +
          (key.startsWith('place:') ? 150 : 0) +
          (key === 'switch:lights' ? 40 : 0) +
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

  /* ── Chrome sync ─────────────────────────────────────────────────── */

  function syncChromeLocation(): void {
    const readout = document.querySelector<HTMLElement>('[data-world-location]');
    if (readout) {
      const place = state.destination;
      const name =
        DESTINATIONS.find((d) => d.id === place)?.name ?? 'The observatory campus';
      const label = state.surface === 'none' ? 'Campus overview' : surfaceLabel(state.surface);
      readout.textContent = state.surface === 'none' ? name : `${name} · ${label}`;
    }
    for (const link of document.querySelectorAll<HTMLElement>('[data-world-dest]')) {
      const id = link.dataset.worldDest;
      const active =
        id === state.destination ||
        (id === 'studio' && state.destination === 'studio' && state.surface === 'cv');
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
  }

  /** Point the close control at where the visitor actually came from. */
  function syncCloseControl(): void {
    const close = document.querySelector<HTMLElement>('[data-surface-close]');
    if (!close) return;
    const returned = readReturnView();
    const back = document.querySelector<HTMLAnchorElement>('[data-surface-back]');
    const fallback = back?.getAttribute('href') ?? '/';
    const target = nowDocument ? returned?.href || fallback : fallback;
    close.dataset.closeHref = target;
    close.setAttribute('aria-label', `Close and return to ${describeHref(target)}`);
  }

  function describeHref(href: string): string {
    if (href === '/' || href === '') return 'the campus overview';
    if (href.startsWith('/writing')) return 'the article archive';
    if (href.startsWith('/work')) return 'the project list';
    if (href.startsWith('/open-source')) return 'the repository list';
    if (href.startsWith('/about')) return 'the biography';
    if (href.startsWith('/cv')) return 'the CV';
    if (href.startsWith('/contact')) return 'the contact station';
    return 'the previous view';
  }

  /* ── Apply the page's state ──────────────────────────────────────── */
  let nowDocument = false;

  function applyState(): void {
    const previous = state;
    state = readState();
    const wasReading = isReading(previous);
    const wasDocument = isDocument(previous);
    nowDocument = isDocument(state);
    reading = isReading(state);

    /*
     * Opening a document remembers where the visitor was standing, so closing
     * it puts them back exactly there rather than at some default view.
     */
    if (nowDocument && !wasDocument) {
      writeReturnView({
        href: currentHref || '/',
        destination: previous.destination,
        surface: previous.surface,
        focusPlace,
        ...rig.orbitState,
      });
    } else if (!reading && wasReading) {
      const returned = readReturnView();
      if (returned) rig.setOrbitState(returned);
      clearReturnView();
    }
    /*
     * Where the camera starts for this page: the place the URL names, or the
     * campus overview.
     */
    focusPlace = state.destination;
    if (state.surface === 'none') focusPlace = 'campus';

    world.setPlaceState(focusPlace === 'campus' ? null : focusPlace);
    rebuildHotspots();
    measurePanel();
    compose(
      previous.destination !== state.destination ||
        previous.surface !== state.surface ||
        previous.panel !== state.panel,
    );

    if (focusPlace !== announced) {
      if (focusPlace !== 'campus') world.triggerSignal(focusPlace);
      announced = focusPlace;
    }
    root.dataset.worldReading = reading ? 'true' : 'false';
    root.dataset.focus = focusPlace;

    document.querySelectorAll<HTMLElement>('[data-surface-panel]').forEach((panel) => {
      if (panel.dataset.surfacePanel === state.surface) panel.removeAttribute('hidden');
      else panel.setAttribute('hidden', '');
    });

    /* The panel was just swapped in: re-measure before composing the shot. */
    if (reading) measurePanel();
    syncChromeLocation();
    syncCloseControl();
    projectHotspots();

    /*
     * Keyboard focus follows the document. Opening one moves focus onto its
     * heading — so a screen reader announces the new content and Tab starts
     * inside it — and closing hands focus back to the caption it came from,
     * which is what makes the world navigable without a pointer. When that
     * caption no longer exists (the document was opened from a place we have
     * left), focus goes to the map control rather than being dropped on the
     * body.
     */
    const openedDocument = nowDocument && !wasDocument;
    const closedDocument = wasDocument && !nowDocument;

    if (openedDocument) {
      const panel = document.querySelector<HTMLElement>('[data-surface-panel]:not([hidden])');
      const heading = panel?.querySelector<HTMLElement>('h1');
      if (panel) panel.scrollTop = 0;
      if (heading) {
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
      } else {
        document.querySelector<HTMLElement>('[data-surface-close]')?.focus({ preventScroll: true });
      }
      openedByKeyboard = false;
    } else if (closedDocument) {
      const caption = lastOpenedKey ? hotspots.get(lastOpenedKey) : null;
      if (caption) caption.focus({ preventScroll: true });
      else {
        document
          .querySelector<HTMLElement>('[data-world-chrome] [data-world-map]')
          ?.focus({ preventScroll: true });
      }
      openedByKeyboard = false;
    }

    currentHref = typeof location === 'undefined' ? '/' : location.pathname;
    renderOnce();
  }

  /* ── Closing a document ──────────────────────────────────────────── */

  /**
   * Close the open document and return to the view the visitor came from.
   * This is a client-side navigation, so the renderer, the scene and the
   * camera all survive it.
   */
  function closeDocument(): void {
    const close = document.querySelector<HTMLElement>('[data-surface-close]');
    const target = close?.dataset.closeHref || '/';
    const here = typeof location === 'undefined' ? '/' : location.pathname;
    if (target && target !== here) {
      void navigate(target);
      return;
    }
    /* Landing directly on a document: the archive is the honest destination. */
    const back = document.querySelector<HTMLAnchorElement>('[data-surface-back]');
    const href = back?.getAttribute('href');
    if (href) void navigate(href);
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

  /* ── Interaction ─────────────────────────────────────────────────── */

  const cleanups: (() => void)[] = [];

  interface Gesture {
    id: number;
    x: number;
    y: number;
    startX: number;
    startY: number;
    moved: boolean;
    captured: boolean;
    type: string;
  }

  /*
   * Gestures belong to the canvas, not to the whole stage: a press that
   * starts on a caption, a link, a form field or the reading surface is that
   * control's business. A press becomes a drag only once it has travelled far
   * enough to be unambiguous, and only then is the pointer captured — so a
   * tap can never be mistaken for a drag, and a drag that leaves the canvas
   * keeps working.
   */
  function wireInteraction(): void {
    if (canvasEl.dataset.wired === '1') return;
    canvasEl.dataset.wired = '1';

    const pointers = new Map<number, Gesture>();
    let pinchDistance = 0;
    let suppressClick = false;

    const capture = (gesture: Gesture, element: HTMLElement) => {
      if (gesture.captured) return;
      try {
        element.setPointerCapture(gesture.id);
        gesture.captured = true;
      } catch {
        /* The pointer is already gone; the gesture simply ends with it. */
      }
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      if (isInteractiveTarget(event.target)) return;
      if (currentMode() !== 'world') return;

      pointers.set(event.pointerId, {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
        captured: false,
        type: event.pointerType,
      });

      if (pointers.size >= 2) {
        /* A second finger is a pinch from the outset. */
        for (const gesture of pointers.values()) {
          gesture.moved = true;
          capture(gesture, canvasEl);
        }
        canvasEl.dataset.dragging = 'true';
        pinchDistance = twoPointerDistance(pointers);
      }
      dismissHint();
    };

    const onPointerMove = (event: PointerEvent) => {
      const gesture = pointers.get(event.pointerId);
      if (!gesture) return;
      const dx = event.clientX - gesture.x;
      const dy = event.clientY - gesture.y;
      gesture.x = event.clientX;
      gesture.y = event.clientY;

      if (!gesture.moved) {
        const travelled = Math.hypot(
          event.clientX - gesture.startX,
          event.clientY - gesture.startY,
        );
        if (travelled < DRAG_THRESHOLD) return;
        gesture.moved = true;
        capture(gesture, canvasEl);
        canvasEl.dataset.dragging = 'true';
      }

      if (pointers.size >= 2) {
        const next = twoPointerDistance(pointers);
        if (pinchDistance > 0 && next > 0) rig.zoomBy((next - pinchDistance) / pinchDistance);
        pinchDistance = next;
        return;
      }
      if (dx || dy) rig.orbit(dx, dy);
    };

    const endPointer = (event: PointerEvent) => {
      const gesture = pointers.get(event.pointerId);
      if (!gesture) return;
      pointers.delete(event.pointerId);
      if (gesture.captured) {
        try {
          canvasEl.releasePointerCapture(event.pointerId);
        } catch {
          /* already released */
        }
      }
      if (pointers.size < 2) pinchDistance = 0;
      if (pointers.size === 0) canvasEl.dataset.dragging = 'false';

      if (gesture.moved) {
        /*
         * A real drag: the click the browser is about to synthesise is not a
         * selection, so it is swallowed once.
         */
        suppressClick = true;
        window.setTimeout(() => {
          suppressClick = false;
        }, 0);
        return;
      }
      if (event.type === 'pointerup' && pointers.size === 0) {
        handleTap(event.clientX, event.clientY);
      }
    };

    const onClickCapture = (event: MouseEvent) => {
      if (!suppressClick) return;
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
    };

    const onWheel = (event: WheelEvent) => {
      if (currentMode() !== 'world') return;
      if (isInteractiveTarget(event.target)) return;
      /* Line and page deltas normalise to roughly one notch. */
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
      rig.zoomBy(THREE.MathUtils.clamp((event.deltaY * unit) / 600, -0.4, 0.4));
      dismissHint();
    };

    const onDoubleClick = (event: MouseEvent) => {
      if (isInteractiveTarget(event.target)) return;
      rig.resetOrbit();
    };

    canvasEl.addEventListener('pointerdown', onPointerDown);
    canvasEl.addEventListener('pointermove', onPointerMove);
    canvasEl.addEventListener('pointerup', endPointer);
    canvasEl.addEventListener('pointercancel', endPointer);
    canvasEl.addEventListener('lostpointercapture', endPointer);
    canvasEl.addEventListener('click', onClickCapture, true);
    canvasEl.addEventListener('wheel', onWheel, { passive: true });
    canvasEl.addEventListener('dblclick', onDoubleClick);
    cleanups.push(() => {
      canvasEl.removeEventListener('pointerdown', onPointerDown);
      canvasEl.removeEventListener('pointermove', onPointerMove);
      canvasEl.removeEventListener('pointerup', endPointer);
      canvasEl.removeEventListener('pointercancel', endPointer);
      canvasEl.removeEventListener('lostpointercapture', endPointer);
      canvasEl.removeEventListener('click', onClickCapture, true);
      canvasEl.removeEventListener('wheel', onWheel);
      canvasEl.removeEventListener('dblclick', onDoubleClick);
      delete canvasEl.dataset.wired;
    });
  }

  /** Mean separation of two active pointers, for pinch zoom. */
  function twoPointerDistance(points: Map<number, Gesture>): number {
    const [a, b] = [...points.values()];
    if (!a || !b) return 0;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  /** The visible caption under a point, if any. */
  function hotspotAt(x: number, y: number): HTMLElement | null {
    for (const link of hotspots.values()) {
      if (link.dataset.visible !== 'true') continue;
      const rect = link.getBoundingClientRect();
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return link;
    }
    return null;
  }

  /** What the world object under a point stands for. */
  function pickAt(x: number, y: number): THREE.Object3D | null {
    const rect = canvasEl.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const ndc = new THREE.Vector2(
      ((x - rect.left) / rect.width) * 2 - 1,
      -((y - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, rig.camera);
    raycaster.far = Infinity;
    const hits = raycaster.intersectObjects(world.pickTargets(), false);
    return hits[0]?.object ?? null;
  }

  /**
   * A tap that never became a drag. What the visitor can see wins: a caption
   * under the finger is activated exactly as if it had been pressed, and
   * otherwise the scene itself answers.
   *
   * The light switch is checked first, in screen space. It is a small object
   * standing among much larger destination hit-volumes, and a ray through it
   * can legitimately pass through a building's forgiving pick cylinder first —
   * a visitor aiming at a visible switch should get the switch.
   */
  function handleTap(x: number, y: number): void {
    if (currentMode() !== 'world') return;

    if (world.lightSwitch && occluded.get('switch:lights') !== true) {
      const projected = world.lightSwitch.pick.position.clone().project(rig.camera);
      if (projected.z < 1) {
        const width = stageEl.clientWidth;
        const height = stageEl.clientHeight;
        const sx = (projected.x * 0.5 + 0.5) * width;
        const sy = (-projected.y * 0.5 + 0.5) * height;
        if (Math.hypot(x - sx, y - sy) <= SWITCH_TAP_RADIUS) {
          toggleTheme({ animate: true });
          return;
        }
      }
    }

    const caption = hotspotAt(x, y);
    if (caption) {
      caption.click();
      return;
    }
    const hit = pickAt(x, y);
    if (!hit) return;

    if (world.lightSwitch && hit === world.lightSwitch.pick) {
      toggleTheme({ animate: true });
      return;
    }
    for (const [id, node] of world.places) {
      if (hit !== node.pick) continue;
      if (id !== focusPlace) travelTo(id);
      return;
    }
    for (const marker of world.objectMarkers) {
      if (hit !== marker.pick) continue;
      const link = hotspots.get(`object:${marker.kind}:${marker.id}`);
      link?.click();
      return;
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    if (currentMode() !== 'world') return;
    if (event.key !== 'Escape') return;
    if (!reading) return;
    /* Escape leaves the document exactly like the close control: no reload. */
    event.preventDefault();
    closeDocument();
  }

  function onCloseClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (!target.closest('[data-surface-close]')) return;
    event.preventDefault();
    closeDocument();
  }

  document.addEventListener('keydown', onKeydown);
  document.addEventListener('click', onCloseClick);
  cleanups.push(() => {
    document.removeEventListener('keydown', onKeydown);
    document.removeEventListener('click', onCloseClick);
  });

  /* ── Loop ────────────────────────────────────────────────────────── */
  let frameHandle = 0;
  let last = 0;
  let clock = 0;
  let running = false;

  function syncLoop(): void {
    const shouldRun =
      !disposed && onScreen && !contextLost && currentMode() === 'world' && stageEl.clientHeight > 0;
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
    if (currentMode() !== 'world' || contextLost) return;
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
    /* The day/night blend runs on real time, so it finishes while reading. */
    advanceTheme(delta);
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

  /* Motion preference can change mid-session. */
  let stopMotionQuery: () => void = () => {};
  if (typeof window.matchMedia === 'function') {
    try {
      const media = window.matchMedia('(prefers-reduced-motion: reduce)');
      const onChange = () => {
        reducedMotion = media.matches;
        ambientAllowed = !reducedMotion && !isAmbientPaused();
        rig.setReducedMotion(reducedMotion);
        settings = settingsFor(tier, ambientAllowed);
        materials.setQuality(settings);
        atmosphere.setQuality(settings);
        world.setQuality(settings);
      };
      media.addEventListener('change', onChange);
      stopMotionQuery = () => media.removeEventListener('change', onChange);
    } catch {
      /* older engines: the boot value stands */
    }
  }
  cleanups.push(() => stopMotionQuery());

  /* ── Navigation events ───────────────────────────────────────────── */
  const onAfterSwap = () => {
    restoreDocumentState();
    applyState();
    syncLoop();
  };
  const onPageLoad = () => {
    restoreDocumentState();
    applyState();
    syncLoop();
  };
  document.addEventListener('astro:after-swap', onAfterSwap);
  document.addEventListener('astro:page-load', onPageLoad);
  cleanups.push(() => {
    document.removeEventListener('astro:after-swap', onAfterSwap);
    document.removeEventListener('astro:page-load', onPageLoad);
  });

  /* ── Context loss ────────────────────────────────────────────────── */
  /*
   * three.js handles a lost-and-restored context itself: on restore it
   * re-initialises its GL state and re-uploads resources lazily, so the
   * correct recovery is to stop drawing, say what happened, and resume the
   * same renderer. Rebuilding would mean a second renderer and a second
   * scene, which is exactly what must not happen.
   */
  const onContextLost = (event: Event) => {
    if (disposed || contextLost) return;
    /* Allowing the default is what keeps the context restorable. */
    event.preventDefault();
    contextLost = true;
    running = false;
    window.cancelAnimationFrame(frameHandle);
    root.dataset.worldState = 'error';
    failStartup(
      'The graphics context was lost — this usually happens when the device reclaims GPU memory. It will recover on its own if the browser restores it, or you can try again.',
    );
  };
  const onContextRestored = () => {
    if (disposed) return;
    contextLost = false;
    root.dataset.worldState = 'ready';
    hideWorldAlert();
    /* Give the restored context a moment before the first frame. */
    window.setTimeout(() => {
      if (disposed || contextLost) return;
      last = performance.now();
      syncLoop();
      renderOnce();
    }, 60);
  };
  canvasEl.addEventListener('webglcontextlost', onContextLost, false);
  canvasEl.addEventListener('webglcontextrestored', onContextRestored, false);
  cleanups.push(() => {
    canvasEl.removeEventListener('webglcontextlost', onContextLost);
    canvasEl.removeEventListener('webglcontextrestored', onContextRestored);
  });

  /* ── Ready ───────────────────────────────────────────────────────── */
  /*
   * A small, read-only view of the live world. It exists for verification and
   * for support ("where is the camera?"), and it never mutates anything.
   */
  (window as unknown as { __worldDebug?: () => unknown }).__worldDebug = () => {
    const anchor = world.lightSwitch?.anchor;
    const pick = world.lightSwitch?.pick;
    const projected = anchor ? anchor.clone().project(rig.camera) : null;
    const pickProjected = pick ? pick.position.clone().project(rig.camera) : null;
    const width = stageEl.clientWidth;
    const height = stageEl.clientHeight;
    const toScreen = (point: THREE.Vector3 | null) =>
      point
        ? {
            x: (point.x * 0.5 + 0.5) * width,
            y: (-point.y * 0.5 + 0.5) * height,
            onScreen: point.z < 1,
          }
        : null;
    return {
      destination: focusPlace,
      surface: state.surface,
      reading,
      theme: theme.name,
      ambient: ambientAllowed,
      orbit: rig.orbitState,
      /** Which caption opened the current document, if any. */
      openedFrom: lastOpenedKey,
      /** Where the switch's caption sits. */
      switchScreen: toScreen(projected),
      /** Where the switch's body is — the point a tap resolves against. */
      switchPick: toScreen(pickProjected),
    };
  };

  /* The same resolution a tap uses, exposed for diagnostics. */
  (window as unknown as { __worldProbe?: (x: number, y: number) => string | null }).__worldProbe = (
    x: number,
    y: number,
  ) => {
    const hit = pickAt(x, y);
    if (!hit) return null;
    if (world.lightSwitch && hit === world.lightSwitch.pick) return 'light-switch';
    for (const [id, node] of world.places) if (hit === node.pick) return `place:${id}`;
    for (const marker of world.objectMarkers) {
      if (hit === marker.pick) return `object:${marker.kind}:${marker.id}`;
    }
    return hit.name || hit.type;
  };

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
  stageEl.addEventListener('pointerdown', dismissHint, { once: true, passive: true });

  resize();
  wireInteraction();
  applyState();
  renderOnce();
  syncLoop();

  const handle: ShellHandle = {
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
      stopAmbient();
      for (const cleanup of cleanups) cleanup();
      world.dispose();
      materials.dispose();
      atmosphere.dispose();
      scene.clear();
      renderer.dispose();
      /* The context is already gone when this runs after a loss event. */
      if (!contextLost) renderer.forceContextLoss();
    },
  };

  return handle;
}

/**
 * Dispose the current mount and build a fresh one.
 *
 * The canvas is replaced rather than reused: a canvas only ever hands back the
 * context it already has, and after an explicit teardown that context is gone.
 * A new canvas is the only reliable way to get a new one, and it keeps the
 * "one renderer" rule true — the old one is disposed before the new one
 * exists.
 */
function rebuild(): void {
  const root = document.querySelector<WorldHost>('[data-world]');
  if (!root) return;
  const existing = root[MOUNT_KEY];
  if (existing) {
    existing.handle.dispose();
    delete root[MOUNT_KEY];
  }
  const canvas = root.querySelector<HTMLCanvasElement>('[data-world-canvas]');
  if (canvas) {
    const fresh = document.createElement('canvas');
    fresh.className = canvas.className;
    fresh.width = canvas.width;
    fresh.height = canvas.height;
    for (const name of ['role', 'aria-label']) {
      const value = canvas.getAttribute(name);
      if (value) fresh.setAttribute(name, value);
    }
    fresh.setAttribute('data-world-canvas', '');
    canvas.replaceWith(fresh);
  }
  bootstrapShell();
}

/* ── Boot ────────────────────────────────────────────────────────────── */

let retryBound = false;

/**
 * Boot the shell once per page load. With the ClientRouter the world element
 * is persisted across navigations, so this must never build a second
 * renderer: it reuses the existing mount and simply re-applies state.
 */
export function bootstrapShell(): void {
  if (typeof document === 'undefined') return;
  restoreDocumentState();

  if (!retryBound) {
    retryBound = true;
    document.addEventListener(RETRY_EVENT, () => {
      /* Retry is an explicit act and a request for the world back: dispose
         the failed attempt, including its canvas, and build a fresh one. */
      allowScene();
      rebuild();
    });
  }

  const root = document.querySelector<WorldHost>('[data-world]');
  if (!root) return;

  /* Script is running, so the world is the presentation — including its
     failure screen. Only a browser with no script at all falls back to the
     ordinary pages. */
  document.documentElement.dataset.mode = 'world';

  /* The visitor answered the failure screen already: keep their choice. */
  if (sceneDeclined() && root.dataset.worldState !== 'ready') {
    root.dataset.worldState = 'degraded';
    hideWorldAlert();
    return;
  }

  const existing = root[MOUNT_KEY];
  if (existing && !existing.lost) {
    existing.handle.applyState();
    return;
  }
  if (existing) {
    existing.handle.dispose();
    delete root[MOUNT_KEY];
  }

  if (!webglAvailable()) {
    root.dataset.worldState = 'error';
    failStartup(
      'This browser cannot create a WebGL context, which the interactive world needs.',
    );
    return;
  }

  root.dataset.worldState = 'loading';
  try {
    const handle = mountShell(root);
    root[MOUNT_KEY] = { handle, lost: false };
    hideWorldAlert();
  } catch (error) {
    root.dataset.worldState = 'error';
    const message = error instanceof Error ? error.message : String(error);
    failStartup(`The renderer could not start (${message}).`);
  }
}

export { webglAvailable as supportsWebgl };
