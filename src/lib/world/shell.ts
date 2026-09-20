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
  RESET_VIEW_EVENT,
  showWorldAlert,
  subscribeAmbient,
  subscribeTheme,
  THEME_TRANSITION_MS,
  toggleTheme,
} from '../world/theme-state';
import { blendTheme, mixColor, readWorldTheme, type WorldTheme } from '../observatory/theme';
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
import { ObservatoryWorld, type Shot } from '../observatory/world';
import { CameraRig } from '../observatory/camera';

export interface ShellHandle {
  applyState(): void;
  dispose(): void;
}

/** How far a pointer may travel before it counts as a drag, in CSS pixels. */
const DRAG_THRESHOLD = 6;

/**
 * Screen-space tap radius for the sun. It is a small object among large
 * buildings, so it is given a fair target of its own rather than competing
 * with a whole destination's hit volume.
 */
const CELESTIAL_TAP_RADIUS = 34;

/**
 * The clear space two caption boxes must leave between them, in pixels.
 *
 * Captions are placed against boxes measured *before* each one is nudged back
 * inside the frame, so two that just touch end up overlapping on screen. A
 * small, explicit gap absorbs that nudge and is what keeps the campus map
 * readable when six names are competing for the same corner of the island.
 */
const CAPTION_GAP = 10;

/** The caption key for the in-world sun/moon control. */
const CELESTIAL_KEY = 'celestial:sun';

/**
 * The caption key for the physical light switch on the observatory terrace.
 *
 * It is icon-only, like the sun: the object it names is visible and is itself
 * the control, so a word beside it would be a label on a lamp. It exists
 * because a small brass post standing among buildings is not obviously
 * pressable at first glance, and because a visitor who never hovers should
 * still be able to find it.
 */
const LIGHT_SWITCH_KEY = 'switch:lights';

/**
 * The campus turns itself, slowly.
 *
 * This is the default view: the world is already moving when the visitor
 * arrives, so the first thing they learn is that it is a place they can look
 * around rather than a picture they have to work out. The rate is deliberately
 * under a degree a second — a full turn takes about five minutes — so it reads
 * as the scene breathing rather than as a carousel.
 *
 * It is also the one motion on the site the visitor cannot stop by waiting, so
 * it yields for good the moment they touch the world: see `takeControl`.
 */
const AUTO_TURN_RATE = 0.021;
/** How long the world settles before the turn eases in for the first time. */
const AUTO_TURN_RESUME_MS = 3500;

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

/**
 * The island's own extent.
 *
 * It is a disc, not a ball: `horizontal` is the rocky rim and `vertical` runs
 * from the foot of the keel to the top of the dome. The overview is composed
 * to fit *both*, so the frame is decided by the thing the visitor came to see
 * rather than by a distance somebody liked the look of.
 */
const CAMPUS_EXTENT = { horizontal: 14.7, vertical: 11.5 };
/**
 * What the overview camera aims at.
 *
 * Above the island's own centre of mass on purpose: the camera looks down at
 * the campus, so aiming a little high lifts the island up the frame — and the
 * band the identity card occupies is at the bottom, where the keel would
 * otherwise be behind it. It also leaves the keel in view: the underside is
 * part of the model, and hiding it would make the island a flat cut-out again.
 */
const CAMPUS_CENTRE = new THREE.Vector3(0, 3.4, 0);

/**
 * The campus overview.
 *
 * The camera sits at a fixed bearing and is set back far enough that the
 * island fits inside the region the interface leaves free, on both axes.
 *
 * Getting this wrong is not subtle. The previous version sized the shot from a
 * single "radius that fits" figure and then aimed it with a look-at shift: a
 * sphere that fits vertically can still be far wider than a wide screen, and a
 * frame that is three times wider than it is tall fits very different amounts
 * on each axis. The result was an island running off the left and right edges
 * with the top of the dome cut off. Here each axis is fitted on its own and
 * the further constraint wins.
 */
function overviewShot(usable: { aspect: number }): Shot {
  const portrait = usable.aspect < 1.15;
  const fov = portrait ? 44 : 38;
  const vFov = THREE.MathUtils.degToRad(fov);
  const halfV = Math.tan(vFov / 2);
  const halfH = halfV * Math.max(usable.aspect, 0.35);

  /* How much of the free region the island is allowed to fill. */
  const widthFraction = portrait ? 0.92 : 0.84;
  const heightFraction = 0.86;
  const distanceForWidth = CAMPUS_EXTENT.horizontal / widthFraction / halfH;
  const distanceForHeight = CAMPUS_EXTENT.vertical / heightFraction / halfV;
  const distance = Math.max(distanceForWidth, distanceForHeight);

  /*
   * The bearing. Portrait gets its own: a phone is so much narrower than it is
   * tall that the island, seen from the desktop's three-quarter angle, runs off
   * the right edge while leaving a wide band of empty sky on the left. Turning
   * the camera round the island swings it back into the middle without moving
   * it any further away.
   */
  const direction = portrait
    ? new THREE.Vector3(0.4, 0.36, 0.68).normalize().applyAxisAngle(
        new THREE.Vector3(0, 1, 0),
        0.6,
      )
    : new THREE.Vector3(0.58, 0.44, 0.67).normalize();
  const target = CAMPUS_CENTRE.clone();
  /*
   * A portrait frame is tall and narrow, and the island is a wide disc: the
   * width is what limits it, which leaves a band of empty sky above and below,
   * with the identity card and the control bar already claiming the top. On a
   * phone the aim is therefore lifted a little, so that empty band sits above
   * the campus where the card is rather than below it.
   */
  if (portrait) target.y += 2.6;
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

/**
 * A rectangle of the stage, in CSS pixels, that the composition must keep a
 * subject out of. The reading surface is one; so is the identity card that
 * stands in the corner of the campus overview.
 */
interface Reserved {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface ViewMetrics {
  stageWidth: number;
  stageHeight: number;
  /** Region of the stage the document leaves visible. */
  free: { left: number; top: number; right: number; bottom: number };
  /** Other interface regions the subject must also stay clear of. */
  reserved: Reserved[];
}

/**
 * Compose a shot so the interfaces never cover the subject.
 *
 * The camera keeps its position, and the look-at point is slid so the subject
 * lands at `screen` instead of wherever it happened to be. The conversion from
 * pixels to world units uses the real distance and field of view, so the shift
 * holds at any viewport size rather than being a tuned guess.
 */
function readingShot(
  base: Shot,
  view: ViewMetrics,
  screen: { x: number; y: number },
): Shot {
  const position = base.position.clone();
  const target = base.target.clone();
  const offsetX = view.stageWidth / 2 - screen.x;
  const offsetY = view.stageHeight / 2 - screen.y;

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
  /*
   * A paper-thin bright shell around everything.
   *
   * The moon hangs off to one side of the frame, so the buildings' far edges
   * face away from it and had no light at all — which is what turned the
   * night silhouettes into flat black cut-outs. A shell with the moon's own
   * direction is one of the cheapest lights there is (no falloff, no shadow
   * pass, no distance limit) and it rims exactly those edges without lifting
   * the surfaces the key already lights.
   */
  const rim = new THREE.Group();
  rim.name = 'rim-light';
  scene.add(rim);
  const rimDirectional = new THREE.DirectionalLight(theme.key, 0.5);
  rimDirectional.name = 'rim';
  /*
   * The moon hangs off to one side of the frame, so the buildings' far edges
   * face away from it. A shell from that side is the cheapest light there is —
   * no falloff, no shadow pass, no distance limit — and it rims exactly those
   * edges without lifting the surfaces the key already lights.
   */
  rimDirectional.position.set(-16, 10, -19);
  rim.add(rimDirectional, rimDirectional.target);  const atmosphere = new Atmosphere(theme, settings, renderer);
  scene.add(atmosphere.group);
  scene.environment = atmosphere.environment;
  scene.environmentIntensity = theme.environmentIntensity;
  scene.fog = atmosphere.fog;

  const world = new ObservatoryWorld(theme, settings, materials, atmosphere, index);
  scene.add(world.group);
  world.loadPortrait(portraitUrl);

  const rig = new CameraRig(1, overviewShot({ aspect: 1 }), reducedMotion);
  /*
   * Tell the rig what it must not fly through. The world knows where its own
   * buildings are, so the camera's clearance volumes come from the same layout
   * the geometry was placed with — there is no second map of the campus to
   * drift out of step.
   */
  rig.setSolids(world.cameraSolids());

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
  /** The caption currently shown in full despite having been placed compact. */
  let revealedKey: string | null = null;
  /**
   * When the visitor last did something to the camera. The automatic turn
   * waits a moment after this before picking up, so the world settles into
   * motion on arrival instead of jerking into it.
   */
  let lastInteraction = typeof performance === 'undefined' ? 0 : performance.now();
  /**
   * Whether the campus may still turn itself.
   *
   * The turn is the default and it is the one motion here that nobody can
   * stop by waiting, so it stops for good the first time the visitor takes
   * hold of the world — a press anywhere on the stage, a wheel, or travelling
   * to a place. Coming back a few seconds later, once the hand that stopped it
   * has gone still, is a scene fighting for the controls; nothing the visitor
   * did asked for it to start again. Only the Reset view control turns it
   * back on, because putting the view back the way it was composed is the one
   * act that means "put it back the way it was".
   */
  let autoTurnAllowed = true;

  /**
   * The visitor has touched the world: it stops performing for them.
   *
   * Called from a press anywhere on the stage — the canvas, a caption, the
   * sun — and from the wheel, which arrives without a press of its own.
   */
  function takeControl(): void {
    autoTurnAllowed = false;
    lastInteraction = performance.now();
  }

  const hotspots = new Map<string, HTMLElement>();
  const occluded = new Map<string, boolean>();
  const raycaster = new THREE.Raycaster();
  const occluders: THREE.Object3D[] = [];
  let occlusionClock = 0;
  let labelLimit = 6;
  let panelRect: { left: number; top: number; right: number; bottom: number } | null = null;

  function labelLimitFor(value: QualityTier): number {
    const width = window.innerWidth;
    /*
     * Phones get a small budget on purpose: a 40px marker is a tenth of a
     * portrait screen's width, so a handful of them is already a crowd. The
     * aim is that the campus still reads as a set of destinations — the map
     * menu is the guaranteed route to every one of them.
     */
    const base = width < 560 ? 3 : width < 900 ? 5 : 6;
    return value === 'low' ? Math.min(base, 4) : base;
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
  let themeBlending = false;
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

    /*
     * The rim follows whichever body is up: warm sun by day, cool moon by
     * night. It is driven from the day/night blend rather than from the sky
     * body's own position, so it is authored rather than emergent — the rim
     * should land on the silhouette edges the visitor is looking at.
     */
    const day = THREE.MathUtils.clamp(next.dayness, 0, 1);
    rimDirectional.color.setHex(day > 0.5 ? next.key : mixColor(next.key, next.skyHorizon, 0.35));
    rimDirectional.intensity = 0.34 + (1 - day) * 0.36;
  }

  function startThemeTransition(next: WorldTheme, animate: boolean): void {
    if (!animate || reducedMotion) {
      themeFrom = null;
      themeTo = null;
      themeBlending = false;
      liveTheme = next;
      applyTheme(next, true);
      if (!running) renderOnce();
      return;
    }
    themeFrom = { ...liveTheme };
    themeTo = next;
    themeT = 0;
    themeBlending = true;
    envClock = 0;
  }

  /**
   * Step the blend. Returns true while a transition is in flight.
   *
   * Note that this advances on the frame delta, which is clamped for stability,
   * so on a slow renderer the blend takes longer in wall-clock time than the
   * nominal duration. That is deliberate — the alternative is a jump — but it
   * is why anything measuring the settled world waits on `themeBlending`
   * rather than on a timer.
   */
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
      themeBlending = false;
      liveTheme = settled;
      applyTheme(settled, true);
    }
    return true;
  }

  const stopThemes = subscribeTheme((detail) => {
    startThemeTransition(readWorldTheme(detail.theme), detail.animate);
    updateCelestialHotspot();
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

  /**
   * The icon that belongs in a caption's circle.
   *
   * The shapes are rendered once by the server into `<template>` elements and
   * cloned here, so the world's captions and the pages use one icon set
   * instead of two that drift.
   */
  function iconFor(key: string): string {
    if (key === CELESTIAL_KEY) return currentTheme() === 'light' ? 'sun' : 'moon';
    if (key === LIGHT_SWITCH_KEY) return currentTheme() === 'light' ? 'sun' : 'moon';
    if (key.startsWith('place:')) {
      const id = key.slice(6);
      if (id === 'campus') return 'compass';
      if (id === 'studio') return 'document';
      if (id === 'workshop') return 'grid';
      if (id === 'library') return 'graph';
      if (id === 'workbench') return 'github';
      if (id === 'contact') return 'mail';
      return 'compass';
    }
    const parts = key.split(':');
    if (parts[0] === 'object') {
      if (parts[1] === 'index') return iconFor(`place:${parts[2]}`);
      if (parts[1] === 'article') return 'document';
      if (parts[1] === 'project') return 'grid';
      if (parts[1] === 'repo') return 'github';
      if (parts[1] === 'cv') return 'document';
      if (parts[1] === 'about') return 'user';
      if (parts[1] === 'newsletter') return 'rss';
      if (parts[1] === 'contact') return 'mail';
    }
    return 'compass';
  }

  /** The server-rendered SVG for a name, ready to place inside a mark. */
  function iconTemplate(name: string): SVGElement | null {
    const template = document.querySelector<HTMLTemplateElement>(
      `template[data-world-icon="${name}"]`,
    );
    const node = template?.content?.firstElementChild;
    return node instanceof SVGElement ? (node.cloneNode(true) as SVGElement) : null;
  }

  function paintMark(mark: HTMLElement, name: string): void {
    const icon = iconTemplate(name);
    mark.replaceChildren();
    if (icon) mark.append(icon);
    mark.dataset.worldIcon = name;
  }

  /** A link to somewhere outside the site is a link to a new tab. */
  function isExternal(href: string): boolean {
    if (!href || href.startsWith('#')) return false;
    try {
      return new URL(href, location.href).origin !== location.origin;
    } catch {
      return false;
    }
  }

  function makeHotspot(
    key: string,
    href: string,
    label: string,
    meta: string,
    kind: 'place' | 'object' | 'celestial',
  ): HTMLElement {
    /*
     * A place caption moves the camera, so it is a button; an object caption
     * opens a document, so it is a link with a real URL; the sun is a button
     * that drives the same shared state as the interface control. That keeps
     * history, deep links and middle-click working for content while the world
     * itself stays the way you get around.
     */
    const link: HTMLElement =
      kind === 'object' ? document.createElement('a') : document.createElement('button');
    if (kind === 'object') {
      const anchor = link as HTMLAnchorElement;
      anchor.href = href;
      /* GitHub, LinkedIn and any other off-site destination opens separately;
         everything inside the portfolio stays inside the world. */
      if (isExternal(href)) {
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        link.dataset.worldExternal = 'true';
      }
    } else (link as HTMLButtonElement).type = 'button';
    link.className = `world-hotspot world-hotspot--${kind}`;
    link.dataset.worldHotspot = key;
    link.dataset.visible = 'false';
    link.tabIndex = -1;
    link.setAttribute('aria-hidden', 'true');
    const mark = document.createElement('span');
    mark.className = 'world-hotspot-mark';
    mark.setAttribute('aria-hidden', 'true');
    paintMark(mark, iconFor(key));
    link.append(mark);
    /* An icon-only caption (the sun, the light switch) has no label to show. */
    if (label) {
      const name = document.createElement('span');
      name.className = 'world-hotspot-name';
      name.textContent = label;
      link.append(name);
    }
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
      revealedKey = key;
    });
    link.addEventListener('blur', () => {
      if (revealedKey === key) revealedKey = null;
    });
    /*
     * A pointer that hovers reveals a compact caption; a finger cannot hover,
     * so a tap on a marker reveals it instead. The first tap opens the marker
     * into its full name, and the caption is then a normal target — a phone
     * therefore never has to guess what a circle stands for, and never has to
     * open a document to find out.
     */
    link.addEventListener('pointerenter', () => {
      revealedKey = key;
    });
    link.addEventListener('pointerleave', () => {
      if (revealedKey === key) revealedKey = null;
    });
    /*
     * Touch has no hover, so a finger reveals a compact marker on the way
     * down — before the click it is about to produce. A marker therefore
     * always shows its name to the visitor who is about to open it, whether
     * they are using a mouse, a finger or the keyboard.
     */
    link.addEventListener('pointerdown', () => {
      revealedKey = key;
    });
    if (kind === 'place') {
      const id = key.startsWith('place:') ? (key.slice(6) as DestinationId) : 'campus';
      link.addEventListener('click', () => travelTo(id));
    } else if (kind === 'celestial') {
      link.addEventListener('click', () => toggleTheme({ animate: true }));
    } else {
      /* Remembered so closing the document can hand focus back to the caption
         the visitor opened it from. */
      link.addEventListener('click', () => {
        lastOpenedKey = key;
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
    takeControl();
    focusPlace = id;
    root.dataset.focus = id;
    world.setPlaceState(id === 'campus' ? null : id);
    /* The sun and moon belong to the overview, not to every destination. */
    atmosphere.setCelestialEnabled(id === 'campus');
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

    /*
     * The sun is not captioned. Its own body is the control — large, at the
     * top of the view, and clickable directly — and a second icon floating
     * beneath it only competed with it. The labelled switch in the chrome is
     * the discoverable route for anybody who does not try clicking the sky.
     */

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

    /*
     * The light switch stands on the observatory terrace, so its caption
     * belongs to the campus. It is a button that drives the same shared state
     * as the labelled control in the chrome — the in-scene control and the
     * interface control are two handles on one switch.
     */
    if (!atPlace) {
      const lightSwitch = makeHotspot(LIGHT_SWITCH_KEY, '', '', '', 'celestial');
      hotspots.set(LIGHT_SWITCH_KEY, lightSwitch);
    }

    updateCelestialHotspot();

    if (activeKey) {
      hotspots.get(activeKey)?.focus({ preventScroll: true });
    }
  }

  /**
   * The sun's caption is icon-only: the body it names is already plain, so it
   * carries an accessible label and a title instead of a visible word, and the
   * icon inside the circle is the whole control.
   */
  function updateCelestialHotspot(): void {
    const link = hotspots.get(CELESTIAL_KEY);
    if (link) {
      const day = currentTheme() === 'light';
      const label = day ? 'Sun — switch to night lighting' : 'Moon — switch to daylight';
      link.setAttribute('aria-pressed', day ? 'true' : 'false');
      link.setAttribute('aria-label', label);
      link.setAttribute('title', label);
      const mark = link.querySelector<HTMLElement>('.world-hotspot-mark');
      if (mark) paintMark(mark, day ? 'sun' : 'moon');
    }
    const physical = hotspots.get(LIGHT_SWITCH_KEY);
    if (physical) {
      const day = currentTheme() === 'light';
      const label = day
        ? 'The observatory light switch — turn the lamps on'
        : 'The observatory light switch — turn the lamps off';
      physical.setAttribute('aria-pressed', day ? 'true' : 'false');
      physical.setAttribute('aria-label', label);
      physical.setAttribute('title', label);
      const mark = physical.querySelector<HTMLElement>('.world-hotspot-mark');
      if (mark) paintMark(mark, 'switch');
    }
  }

  function anchorFor(key: string): THREE.Vector3 | null {
    if (key === CELESTIAL_KEY) {
      /* The sun and moon live in the sky, so their caption follows whichever
         of the two is currently above the horizon — and hangs below it, clear
         of the disc. */
      return atmosphere.activeCelestialCaptionPosition();
    }
    if (key === LIGHT_SWITCH_KEY) {
      /* A little above the lamp on the post, so the marker clears the object
         it names rather than sitting on the control. */
      return world.lightSwitchAnchor();
    }
    if (key.startsWith('place:')) {
      const id = key.slice(6) as DestinationId;
      if (id === 'campus') {
        /* Above the dome, but not so far above it that the label is pushed
           off the top of the frame on a wide, short view. */
        const node = world.places.get('campus');
        return node ? node.anchor.clone().add(new THREE.Vector3(0, 2.5, 0)) : null;
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
    updateReadProgress(surface);
  }

  /**
   * How far through the document the visitor has read, for the rule under the
   * reading header.
   *
   * Written from the frame clock rather than only from a scroll listener:
   * `scroll` does not propagate, momentum scrolling fires it in bursts, and —
   * measured while verifying this — a programmatic `scrollTop` assignment can
   * move a panel without any `scroll` event being delivered at all. A
   * progress rule that only listens for an event is therefore one burst of
   * momentum away from being wrong, so the frame clock is the source of truth
   * and the scroll listener is only an optimisation that makes it immediate.
   *
   * Two guards, because a progress rule that is one document out of date is
   * worse than none: the value is only written when it has actually moved, and
   * the measurement it was derived from is remembered alongside it. A panel
   * that has just been replaced has the same scroll fraction as the one before
   * it — both are at the top, or both at the end — so comparing fractions
   * alone silently kept the previous document's reading position.
   */
  let lastProgress = -1;
  let lastProgressShape = '';
  function updateReadProgress(surface: HTMLElement): void {
    const scrollable = surface.scrollHeight - surface.clientHeight;
    const progress = scrollable > 8 ? THREE.MathUtils.clamp(surface.scrollTop / scrollable, 0, 1) : 0;
    const shape = `${Math.round(scrollable)}:${surface.clientHeight}`;
    if (shape !== lastProgressShape) {
      lastProgressShape = shape;
      lastProgress = -1;
    }
    if (Math.abs(progress - lastProgress) < 0.004) return;
    lastProgress = progress;
    surface.style.setProperty('--read-progress', progress.toFixed(4));
  }

  /** Forget the last reading position, so a new document reports its own. */
  function resetReadProgress(): void {
    lastProgress = -1;
    lastProgressShape = '';
  }

  /**
   * Cascade the blocks of a freshly opened document in.
   *
   * The attribute is set, then cleared once the animation has run, so the same
   * document re-animates the next time it is opened rather than only once per
   * session.
   */
  let enterTimer = 0;
  function markPanelEntered(): void {
    const surface = document.querySelector<HTMLElement>('[data-surface-panel]:not([hidden])');
    if (!surface) return;
    window.clearTimeout(enterTimer);
    surface.dataset.entered = 'true';
    enterTimer = window.setTimeout(() => {
      if (!disposed) delete surface.dataset.entered;
    }, 900);
  }

  function updateOcclusion(delta: number): void {
    occlusionClock -= delta;
    if (occlusionClock > 0) return;
    occlusionClock = 0.15;
    /* The reading rule is refreshed on the same slow clock as the occlusion
       pass, so a frame never costs an extra layout read. */
    if (reading) {
      const surface = document.querySelector<HTMLElement>('[data-surface-panel]:not([hidden])');
      if (surface) updateReadProgress(surface);
    }
    occluders.length = 0;
    occluders.push(...world.occluders());
    const origin = rig.camera.position;
    for (const key of hotspots.keys()) {
      /*
       * The sun and moon are a sky layer, not world geometry: there is nothing
       * between the camera and them that could hide them, and raycasting the
       * island's meshes against a point 220 units away would only ever report
       * a false occlusion.
       */
      if (key === CELESTIAL_KEY) {
        occluded.set(key, false);
        continue;
      }
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
    /** The markers among them, which are allowed to crowd each other. */
    const markers: { x: number; y: number; w: number; h: number }[] = [];
    /*
     * The identity card and the open document. A caption that lands under
     * either is not a caption any more, it is part of the furniture — so
     * both are treated as solid for placement, not merely as things the
     * subject has to avoid.
     */
    const blocked: { x: number; y: number; w: number; h: number }[] = [];
    const card = identityReserved();
    if (card) {
      blocked.push({ x: card.left, y: card.top, w: card.right - card.left, h: card.bottom - card.top });
    }

    /*
     * The campus overview is the menu.
     *
     * Its destination captions are the site's navigation, and the automatic
     * turn swings them around the island: which of them the observatory is
     * standing in front of, and how much room each one has, changes from moment
     * to moment. A caption that drops out under those conditions takes the
     * destination with it, which is what made the campus read as a menu with
     * pieces missing. On the overview every destination is therefore placed
     * whatever happens — never hidden for being behind something, never dropped
     * for want of a slot, and moved rather than lost when it would collide. The
     * circle still carries the name on hover, on tap and on focus, and the
     * caption steps back rather than away while the island is in front of it.
     */
    const menu = focusPlace === 'campus' && !reading;
    /** Named pills placed so far — the label budget counts words, not icons. */
    let placedLabels = 0;

    /*
     * What the overview's own menu has to keep off: the identity card, and the
     * control bar above it. The bar is kept out of `blocked` so that captions
     * which are not part of the menu — the sun, an object at a destination —
     * keep exactly the placement they had; a destination moved out of the
     * bar's way is one a visitor can still press.
     */
    const menuBlocked = [...blocked];
    const bar = document.querySelector<HTMLElement>('[data-world-chrome] .world-chrome-bar');
    if (bar) {
      const rect = bar.getBoundingClientRect();
      if (rect.width > 8 && rect.height > 8) {
        menuBlocked.push({ x: rect.left, y: rect.top, w: rect.width, h: rect.height });
      }
    }

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
      /* Read by the caption itself: a destination the island is standing in
         front of stays up and steps back, rather than vanishing. */
      link.dataset.behind = occluded.get(key) === true ? 'true' : 'false';
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
           * destinations outrank the sun, which is also in the interface and
           * always reachable there.
           */
          (key.startsWith('object:index:') ? 300 : 0) +
          (key.startsWith('object:') ? 200 : 0) +
          (key.startsWith('place:') ? 150 : 0) +
          (key === CELESTIAL_KEY ? 360 : 0) +
          (key === LIGHT_SWITCH_KEY ? 330 : 0) +
          Math.max(0, 60 - distance),
        occluded: isOccluded || offscreen || underPanel,
      });
    }

    candidates.sort((a, b) => b.priority - a.priority);

    /** Where a caption would sit at its current size, in stage pixels. */
    const boxFor = (link: HTMLElement) => {
      const anchor = candidateAnchor(link);
      if (!anchor) return null;
      const p = anchor.clone().project(rig.camera);
      const w = link.offsetWidth || 44;
      const h = link.offsetHeight || 44;
      return {
        x: (p.x * 0.5 + 0.5) * width - w / 2,
        y: (-p.y * 0.5 + 0.5) * height - h / 2,
        w,
        h,
      };
    };

    const overlapsAny = (box: { x: number; y: number; w: number; h: number }, list: typeof placed) =>
      list.some(
        (o) =>
          box.x < o.x + o.w + CAPTION_GAP &&
          box.x + box.w + CAPTION_GAP > o.x &&
          box.y < o.y + o.h + CAPTION_GAP &&
          box.y + box.h + CAPTION_GAP > o.y,
      );

    /*
     * The sun's core, which a pill must keep off: the body is the control, and
     * a caption sitting on it means pressing a label while aiming at the sun.
     * A pill that would cover it is placed as its marker instead — markers are
     * centred on their own anchor, so they clear it.
     */
    const sunCore: { x: number; y: number; w: number; h: number }[] = [];
    const celestial = atmosphere.activeCelestialPosition();
    if (celestial) {
      const p = celestial.clone().project(rig.camera);
      if (p.z < 1) {
        const size = Math.max(52, atmosphere.activeCelestialRadius(rig.camera) * height * 1.2);
        sunCore.push({
          x: (p.x * 0.5 + 0.5) * width - size / 2,
          y: (-p.y * 0.5 + 0.5) * height - size / 2,
          w: size,
          h: size,
        });
      }
    }

    /**
     * A caption that has to be shown is moved, not dropped.
     *
     * The search walks outwards from the anchor — a little above, a little
     * below, then further — and takes the first position that clears the named
     * pills, the sun's core and the interface. Markers are allowed to share
     * space with each other, so the caller decides which of the two lists they
     * must also avoid.
     */
    const clearSpot = (
      box: { x: number; y: number; w: number; h: number },
      solid: typeof placed,
      marked: typeof placed,
      avoid: typeof placed,
    ): { x: number; y: number; w: number; h: number } | null => {
      for (const dy of [0, -18, 18, -36, 36, -56, 56, -78, 78]) {
        const moved = { ...box, y: box.y + dy };
        if (
          !overlapsAny(moved, solid) &&
          !overlapsAny(moved, marked) &&
          !overlapsAny(moved, sunCore) &&
          !overlapsAny(moved, avoid)
        ) {
          return moved;
        }
      }
      return null;
    };

    for (const candidate of candidates) {
      const link = candidate.link;
      const isFocused = focused === link;
      /* A caption the visitor is on shows its name, even where a pill would
         not fit — that is what makes a marker a label on hover or focus. */
      const isRevealed = revealedKey === candidate.key;
      /*
       * A destination caption on the campus overview belongs to the menu, so
       * it is placed even when the island is standing in front of it. Every
       * other caption keeps the old rule: behind something is not on screen.
       */
      const guaranteed = menu && candidate.key.startsWith('place:');
      /* The sun and the light switch are icon-only: they are placed like
         captions but they are not words, so they do not spend the budget. */
      const named = candidate.key !== CELESTIAL_KEY && candidate.key !== LIGHT_SWITCH_KEY;
      link.dataset.compact = 'false';

      if (candidate.occluded && !isFocused && !isRevealed && !guaranteed) {
        link.dataset.visible = 'false';
        link.setAttribute('aria-hidden', 'true');
        link.tabIndex = -1;
        continue;
      }

      /*
       * Captions are placed in two weights.
       *
       * A full pill has to have room — it must not touch another pill, another
       * marker, the sun, the identity card or the open document — and it has
       * to be within the label budget. When it cannot, the caption falls back
       * to its marker: a 40px circle centred on the same anchor. Markers keep
       * off pills but may crowd each other, so zooming out turns the view into
       * a map of markers instead of quietly losing destinations.
       *
       * The budget is deliberately small. A caption is a key to the map, not
       * the map: six names at once over the island covered more of the view
       * than the buildings they were naming. A destination on the overview is
       * the exception: it is the menu, so it is nudged into the first clear
       * space rather than dropped when the slot it wants is taken.
       */
      const compactAll = rig.zoomLevel > 1.24;
      let compact = false;
      let box = isFocused || isRevealed ? boxFor(link) : null;

      if (!isFocused && !isRevealed) {
        const full = compactAll ? null : boxFor(link);
        /* A menu caption answers to the bar as well as to the card. */
        const solid = guaranteed ? menuBlocked : blocked;
        const fitsFull =
          full !== null &&
          !overlapsAny(full, placed) &&
          !overlapsAny(full, markers) &&
          !overlapsAny(full, sunCore) &&
          !overlapsAny(full, solid) &&
          (guaranteed || placedLabels < labelLimit);
        if (fitsFull) {
          box = full;
        } else if (guaranteed) {
          /* The name if it can be moved clear, its marker if it cannot. */
          const moved = full ? clearSpot(full, placed, markers, solid) : null;
          if (moved) {
            box = moved;
          } else {
            compact = true;
            const marker = boxFor(link);
            box = marker ? clearSpot(marker, placed, [], solid) ?? marker : null;
          }
        } else if (placed.length + markers.length < labelLimit + 4) {
          compact = true;
          const marker = boxFor(link);
          /*
           * A marker may share space with another marker — two circles that
           * overlap still read as two circles — but never with a named pill
           * or with the interface.
           */
          box =
            marker && !overlapsAny(marker, placed) && !overlapsAny(marker, blocked)
              ? marker
              : null;
        } else {
          box = null;
        }
      }
      link.dataset.compact = compact ? 'true' : 'false';

      if (!box) {
        link.dataset.visible = 'false';
        link.setAttribute('aria-hidden', 'false');
        link.tabIndex = 0;
        continue;
      }

      placed.push(box);
      if (compact) markers.push(box);
      if (!compact && named) placedLabels += 1;
      /*
       * Keep the whole caption on screen, on both axes. Its own width decides
       * the horizontal margin, and the vertical clamp is what stops a caption
       * anchored high on the island — the workbench gantry, or the observatory
       * itself — from being pushed off the top of the frame and becoming
       * unreachable.
       */
      const margin = 8;
      const halfW = box.w / 2;
      const halfH = box.h / 2;
      const x = THREE.MathUtils.clamp(
        box.x + halfW,
        halfW + margin,
        Math.max(halfW + margin, width - halfW - margin),
      );
      const y = THREE.MathUtils.clamp(
        box.y + halfH,
        halfH + margin,
        Math.max(halfH + margin, height - halfH - margin),
      );
      link.dataset.visible = 'true';
      link.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
      link.setAttribute('aria-hidden', 'false');
      link.tabIndex = 0;
    }
  }

  /** The projected anchor a caption belongs to. */
  function candidateAnchor(link: HTMLElement): THREE.Vector3 | null {
    const key = link.dataset.worldHotspot;
    if (!key) return null;
    return anchorFor(key);
  }

  /* ── Camera composition ──────────────────────────────────────────── */

  /**
   * The identity card's own rectangle.
   *
   * The card stands in the corner of the campus overview and carries the one
   * piece of standing text on the site, so it is measured rather than assumed:
   * its width is a clamp and its height depends on how the headline wraps.
   * Only the campus reserves it — at a destination the frame belongs to the
   * building, and the card is hidden anyway.
   */
  function identityReserved(): Reserved | null {
    if (focusPlace !== 'campus' || reading) return null;
    const card = document.querySelector<HTMLElement>('.world-identity');
    if (!card) return null;
    const style = getComputedStyle(card);
    if (style.display === 'none' || style.visibility === 'hidden') return null;
    const rect = card.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return null;
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  }

  /** The region of the stage the interfaces do not cover. */
  function viewMetrics(): ViewMetrics {
    const stageWidth = stageEl.clientWidth || 1;
    const stageHeight = stageEl.clientHeight || 1;
    const reserved: Reserved[] = [];
    const card = identityReserved();
    if (card) reserved.push(card);
    const whole = { left: 0, top: 0, right: stageWidth, bottom: stageHeight };
    if (!panelRect) {
      return { stageWidth, stageHeight, free: whole, reserved };
    }
    /* Clamp the panel to the stage, so an overshooting rect cannot invert
       the free region. */
    const left = Math.max(0, Math.min(panelRect.left, stageWidth));
    const top = Math.max(0, Math.min(panelRect.top, stageHeight));
    const right = Math.max(left, Math.min(panelRect.right, stageWidth));
    const bottom = Math.max(top, Math.min(panelRect.bottom, stageHeight));
    const freeWidth = stageWidth - (right - left);
    const freeHeight = stageHeight - (bottom - top);

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
        return {
          stageWidth,
          stageHeight,
          free: { left: 0, top: 0, right: stageWidth, bottom: top },
          reserved,
        };
      }
      if (touches.top && !touches.bottom) {
        return {
          stageWidth,
          stageHeight,
          free: { left: 0, top: bottom, right: stageWidth, bottom: stageHeight },
          reserved,
        };
      }
    } else if (freeWidth > 48) {
      if (touches.right && !touches.left) {
        return {
          stageWidth,
          stageHeight,
          free: { left: 0, top: 0, right: left, bottom: stageHeight },
          reserved,
        };
      }
      if (touches.left && !touches.right) {
        return {
          stageWidth,
          stageHeight,
          free: { left: right, top: 0, right: stageWidth, bottom: stageHeight },
          reserved,
        };
      }
    }
    return { stageWidth, stageHeight, free: whole, reserved };
  }

  /**
   * Shrink a free region until it no longer overlaps a reserved rectangle.
   *
   * Only the axis that can afford to give ground is cut: a card in the bottom
   * corner of a wide frame costs the frame some height, not half its width, so
   * the free strip stays as large as the interface genuinely allows.
   */
  function carveFree(free: Reserved, reserved: Reserved[]): Reserved {
    let box = { ...free };
    for (const block of reserved) {
      const overlaps =
        box.left < block.right &&
        box.right > block.left &&
        box.top < block.bottom &&
        box.bottom > block.top;
      if (!overlaps) continue;
      /* How much each side would have to give up to clear the block. */
      const cutLeft = block.right - box.left;
      const cutRight = box.right - block.left;
      const cutTop = block.bottom - box.top;
      const cutBottom = box.bottom - block.top;
      const horizontal = Math.min(cutLeft, cutRight);
      const vertical = Math.min(cutTop, cutBottom);
      /*
       * Give up the cheaper edge on the axis with more room to spare, so a
       * short, wide card eats height and a tall panel eats width. Never let
       * the region collapse below a usable band.
       */
      if (vertical <= horizontal) {
        if (box.bottom - box.top - vertical < 90) continue;
        if (cutTop < cutBottom) box.top = block.bottom;
        else box.bottom = block.top;
      } else {
        if (box.right - box.left - horizontal < 120) continue;
        if (cutLeft < cutRight) box.left = block.right;
        else box.right = block.left;
      }
    }
    return box;
  }

  function shotFor(): Shot {
    const view = viewMetrics();
    const free = carveFree(view.free, view.reserved);
    const freeWidth = Math.max(free.right - free.left, 200);
    const freeHeight = Math.max(free.bottom - free.top, 200);
    const aspect = freeWidth / freeHeight;
    const overview = overviewShot({ aspect });
    /* Where the subject should end up: the middle of what is not covered. */
    const screen = {
      x: (free.left + free.right) / 2,
      y: (free.top + free.bottom) / 2,
    };

    /* The campus *is* the overview: whatever is open there, the visitor
       should still be looking at the whole place. */
    if (focusPlace === 'campus') {
      return readingShot(overview, view, screen);
    }
    /*
     * A destination is framed close, from its own composed shot. The reach is
     * lengthened when the visible region is a short band — a phone with a
     * document open — so the whole building stays in the strip.
     */
    const band = freeHeight < view.stageHeight * 0.5;
    const node = world.places.get(focusPlace);
    if (!node) return readingShot(overview, view, screen);
    const base = placeShot(node.shot, aspect, band ? 1.45 : 1);
    return readingShot(base, view, screen);
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
  function syncCloseControl(): void {    const close = document.querySelector<HTMLElement>('[data-surface-close]');
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
    if (href.startsWith('/subscribe')) return 'the subscribe page';
    if (href.startsWith('/work')) return 'the project list';
    if (href.startsWith('/open-source')) return 'the repository list';
    if (href.startsWith('/about')) return 'the biography';
    if (href.startsWith('/cv')) return 'the CV';
    if (href.startsWith('/contact')) return 'the contact station';
    return 'the previous view';
  }

  /* ── Apply the page's state ──────────────────────────────────────── */
  let nowDocument = false;
  /** False until the first state has been applied, so boot does not travel. */
  let ready = false;

  function applyState(): void {
    const previous = state;
    state = readState();
    const wasReading = isReading(previous);
    const wasDocument = isDocument(previous);
    nowDocument = isDocument(state);
    reading = isReading(state);
    /*
     * A new document starts its own reading position. The cache behind the
     * progress rule is keyed on the panel that produced it, and a panel that
     * has just been swapped in is not the one the cache describes.
     */
    if (previous.surface !== state.surface || previous.surfaceId !== state.surfaceId) {
      resetReadProgress();
    }

    /*
     * Opening a document remembers where the visitor was standing, so closing
     * it puts them back exactly there rather than at some default view.
     *
     * The record is a request, not an instruction: the orbit is restored after
     * the shot for the current place has been composed, because composing
     * clamps the orbit to what that shot allows and applying it first would
     * only be overwritten. `pendingRestore` carries it across the compose.
     */
    let pendingRestore: ReturnType<typeof readReturnView> = null;
    if (nowDocument && !wasDocument) {
      writeReturnView({
        href: currentHref || '/',
        destination: previous.destination,
        surface: previous.surface,
        focusPlace,
        ...rig.orbitState,
      });
    } else if (!reading && wasReading) {
      pendingRestore = readReturnView();
      clearReturnView();
    }
    /*
     * Where the camera starts for this page: the place the URL names, or the
     * campus overview.
     */
    focusPlace = state.destination;
    if (state.surface === 'none') focusPlace = 'campus';

    world.setPlaceState(focusPlace === 'campus' ? null : focusPlace);
    /* The sun and moon belong to the overview, not to every destination. */
    atmosphere.setCelestialEnabled(focusPlace === 'campus');
    rebuildHotspots();
    measurePanel();
    compose(
      !ready ||
        previous.destination !== state.destination ||
        previous.surface !== state.surface ||
        previous.panel !== state.panel,
    );
    ready = true;
    if (pendingRestore) rig.setOrbitState(pendingRestore);

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

    /*
     * The panel was just swapped in: wire its own scroll (it is a scrolling
     * box of its own) and re-measure before composing the shot.
     */
    wirePanelScroll();
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
      markPanelEntered();
    } else if (closedDocument) {
      const caption = lastOpenedKey ? hotspots.get(lastOpenedKey) : null;
      if (caption) caption.focus({ preventScroll: true });
      else {
        document
          .querySelector<HTMLElement>('[data-world-chrome] [data-world-map]')
          ?.focus({ preventScroll: true });
      }
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
      takeControl();

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
      /*
       * Over the sun or moon, the cursor says it can be pressed: the body is
       * the control, and nothing else in the sky is clickable.
       */
      if (!pointers.has(event.pointerId) && event.pointerType === 'mouse') {
        const body = atmosphere.activeCelestialPosition();
        let over = false;
        if (body) {
          const p = body.clone().project(rig.camera);
          if (p.z < 1) {
            const rect = canvasEl.getBoundingClientRect();
            const sx = (p.x * 0.5 + 0.5) * rect.width + rect.left;
            const sy = (-p.y * 0.5 + 0.5) * rect.height + rect.top;
            const reach = Math.max(
              CELESTIAL_TAP_RADIUS,
              atmosphere.activeCelestialRadius(rig.camera) * rect.height,
            );
            over = Math.hypot(event.clientX - sx, event.clientY - sy) <= reach;
          }
        }
        canvasEl.style.cursor = over ? 'pointer' : '';
      }

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
      lastInteraction = performance.now();

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
      takeControl();
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
    /*
     * Everything inside the stage is the world, so a press anywhere in it is
     * the visitor taking hold — including the press that starts on a caption,
     * which the canvas handler deliberately leaves to the control. The
     * interface around the stage (the chrome, the identity card, an open
     * document) is not the world, and pressing it says nothing about the
     * camera.
     */
    stageEl.addEventListener('pointerdown', takeControl, { passive: true });
    cleanups.push(() => {
      stageEl.removeEventListener('pointerdown', takeControl);
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
    const hit = rayAt(x, y, world.pickTargets());
    return hit;
  }

  /** Cast a ray from a screen point at a specific set of objects. */
  function rayAt(x: number, y: number, targets: THREE.Object3D[]): THREE.Object3D | null {
    const rect = canvasEl.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const ndc = new THREE.Vector2(
      ((x - rect.left) / rect.width) * 2 - 1,
      -((y - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, rig.camera);
    raycaster.far = Infinity;
    const hits = raycaster.intersectObjects(targets, false);
    return hits[0]?.object ?? null;
  }

  /**
   * A tap that never became a drag. What the visitor can see wins: a caption
   * under the finger is activated exactly as if it had been pressed, and
   * otherwise the scene itself answers.
   *
   * The world's light switch is checked first, in screen space. It is a small
   * object standing inside the observatory's much larger hit volume, so a ray
   * aimed at it can legitimately reach the building first — a visitor aiming
   * at a visible switch should get the switch.
   */
  function handleTap(x: number, y: number): void {
    if (currentMode() !== 'world') return;

    if (rayAt(x, y, world.switchTargets())) {
      toggleTheme({ animate: true });
      return;
    }

    if (atmosphere.activeCelestialPosition()) {
      const projected = atmosphere.activeCelestialPosition()!.clone().project(rig.camera);
      if (projected.z < 1) {
        const width = stageEl.clientWidth;
        const height = stageEl.clientHeight;
        const sx = (projected.x * 0.5 + 0.5) * width;
        const sy = (-projected.y * 0.5 + 0.5) * height;
        /* The body is large, so its own on-screen size sets the target. */
        const reach = Math.max(CELESTIAL_TAP_RADIUS, atmosphere.activeCelestialRadius(rig.camera) * height);
        if (Math.hypot(x - sx, y - sy) <= reach) {
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

  /*
   * Reset view.
   *
   * The chrome raises this rather than reaching into the rig, so there is one
   * owner of the camera and the control cannot drift out of step with it. It
   * puts the composition back exactly where the current place composed it:
   * orbit, zoom and any panning at once, without travelling anywhere.
   *
   * It is also the one press that starts the automatic turn again. It is the
   * only control whose whole meaning is "put the view back the way it was",
   * and the way it was is the world turning itself — so a visitor who wants
   * the motion back has a way to ask for it, and the turn still waits out the
   * same settling pause before it eases in.
   */
  const onResetView = () => {
    if (disposed) return;
    autoTurnAllowed = true;
    lastInteraction = performance.now();
    rig.resetOrbit();
    compose(true);
    renderOnce();
  };
  document.addEventListener(RESET_VIEW_EVENT, onResetView);
  cleanups.push(() => document.removeEventListener(RESET_VIEW_EVENT, onResetView));

  /* ── Loop ────────────────────────────────────────────────────────── */
  let frameHandle = 0;
  let last = 0;
  let clock = 0;
  let running = false;
  /** Frames drawn since the renderer started, for the diagnostics. */
  let frameCount = 0;

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
    atmosphere.follow(rig.camera, rig.focus);
    renderer.render(scene, rig.camera);
    projectHotspots();
  }

  function frame(now: number): void {
    if (disposed) return;
    frameCount++;
    /*
     * Two deltas, on purpose.
     *
     * The simulation uses one clamped to 50ms, because a frame that took a
     * second must not teleport the world. The automatic turn uses the real
     * elapsed time, because it is wall-clock motion: on a slow renderer the
     * clamped value would have the campus crawling, which is exactly the bug
     * this split fixes.
     */
    const realDelta = Math.max((now - last) / 1000, 0);
    const delta = Math.min(Math.max(realDelta, 0), 0.05);
    last = now;
    /* A document on screen means the scenery should settle, not perform. */
    const animate = ambientAllowed && !reading;
    if (animate) clock += delta;
    const step = animate ? delta : 0;

    /*
     * The campus turns itself while the visitor is only looking. It yields the
     * moment they take the camera — a press on the scene, a wheel, or any
     * travel — and stays stopped: see `autoTurnAllowed`.
     */
    const idling = performance.now() - lastInteraction > AUTO_TURN_RESUME_MS;
    rig.setAutoTurn(animate && autoTurnAllowed && idling ? AUTO_TURN_RATE : 0);

    rig.update(delta, realDelta);
    world.update(clock, step);
    /* The day/night blend runs on real time, so it finishes while reading. */
    advanceTheme(delta);
    atmosphere.follow(rig.camera, rig.focus);
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

  /*
   * The reading surface is its own scrolling box, and `scroll` does not
   * propagate at all — not even through the capture phase — so the listener
   * has to sit on the panel itself. Each navigation brings a fresh panel, so
   * the wiring is keyed on the element and the old one goes with its page.
   *
   * The listener is an optimisation, not the source of truth: the frame clock
   * reads the same measurement, and a panel that has been laid out — a font
   * that swapped in, an image that finished loading, a transition that ended —
   * reports its position through a `ResizeObserver` as well. Between the three
   * there is no state in which the rule is left showing the wrong position.
   */
  const panelSizeObserver =
    typeof ResizeObserver === 'function' ? new ResizeObserver(() => measurePanel()) : null;

  function wirePanelScroll(): void {
    document.querySelectorAll<HTMLElement>('[data-surface-panel]').forEach((panel) => {
      panelSizeObserver?.observe(panel);
      if (panel.dataset.scrollWired === '1') return;
      panel.dataset.scrollWired = '1';
      panel.addEventListener('scroll', measurePanel, { passive: true });
    });
  }
  cleanups.push(() => {
    panelSizeObserver?.disconnect();
    document.querySelectorAll<HTMLElement>('[data-surface-panel]').forEach((panel) => {
      panel.removeEventListener('scroll', measurePanel);
      delete panel.dataset.scrollWired;
    });
  });

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
    const celestial = atmosphere.activeCelestialPosition();
    const projected = celestial ? celestial.clone().project(rig.camera) : null;
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
      /**
       * True while the day/night blend is still running. The blend advances on
       * clamped frame deltas, so on a slow device it takes longer in wall time
       * than the nominal duration — anything measuring the settled world has
       * to wait for this rather than for a timeout.
       */
      transitioning: themeBlending,
      themeProgress: themeT,
      ambient: ambientAllowed,
      orbit: rig.orbitState,
      /** Which caption opened the current document, if any. */
      openedFrom: lastOpenedKey,
      /**
       * Where the camera actually is, and how far it is above the floor the
       * rig enforces. `above` is never negative by construction; it exists so
       * a verification run can prove that rather than trust it.
       */
      camera: rig.debug(),
      /** The solid volumes the camera's clearance rule tests against. */
      solids: world.cameraSolids().map((solid) => ({ ...solid })),
      /**
       * Whether the campus may still turn itself. False from the first press
       * on the world onwards, and true again only after the Reset view
       * control — so a verification run can tell "stopped" from "between
       * frames".
       */
      autoTurn: autoTurnAllowed,
      /** True while the camera is still travelling between composed shots. */
      travelling: rig.travelling,
      /**
       * The sky body that is currently up — the sun by day, the moon by night
       * — as a screen point and the tap radius it deserves.
       */
      celestial: toScreen(projected),
      celestialRadius: atmosphere.activeCelestialRadius(rig.camera) * height,
      /** Why the body may be missing: it is only ever a blend or a distance. */
      celestialHidden: atmosphere.celestialDiagnostics(),
      /** Every caption the shell is currently projecting, with its placement. */
      captions: [...hotspots.entries()].map(([key, link]) => ({
        key,
        visible: link.dataset.visible === 'true',
        compact: link.dataset.compact === 'true',
        occluded: occluded.get(key) === true,
        label: link.textContent?.trim() ?? '',
      })),
      /** The reading-progress rule's own state, so a stall is diagnosable. */
      progress: {
        value: lastProgress,
        shape: lastProgressShape,
        frames: frameCount,
        running,
        panel: panelRect
          ? {
              x: Math.round(panelRect.left),
              y: Math.round(panelRect.top),
              w: Math.round(panelRect.right - panelRect.left),
              h: Math.round(panelRect.bottom - panelRect.top),
            }
          : null,
      },
    };
  };

  /* The same resolution a tap uses, exposed for diagnostics. */
  (window as unknown as { __worldProbe?: (x: number, y: number) => string | null }).__worldProbe = (
    x: number,
    y: number,
  ) => {
    const hit = pickAt(x, y);
    if (!hit) return null;
    for (const [id, node] of world.places) if (hit === node.pick) return `place:${id}`;
    for (const marker of world.objectMarkers) {
      if (hit === marker.pick) return `object:${marker.kind}:${marker.id}`;
    }
    return hit.name || hit.type;
  };

  /**
   * Put the campus back to the pose it was composed in.
   *
   * The world turns itself by default, so a screenshot taken a few seconds
   * after load has already drifted. This is for photography and for the
   * verification suite: it poses the campus exactly as the Reset view control
   * does, and holds it there — the automatic turn stays off until the control
   * itself is used. A hook for measuring things has to leave the scene still,
   * which is the one difference from the control it mirrors.
   */
  (window as unknown as { __worldResetTurn?: () => void }).__worldResetTurn = () => {
    autoTurnAllowed = false;
    rig.resetOrbit();
    lastInteraction = performance.now();
    compose(true);
    renderOnce();
  };

  /**
   * Geometry diagnostics.
   *
   * The island's shading is the one thing that cannot be checked from a
   * screenshot alone: a surface that is lit from behind looks exactly like a
   * surface that is too dark. This reads the built geometry back — face
   * normals, up/down split, band colours, bounds — so a normals mistake is
   * provable rather than guessed at.
   */
  (window as unknown as { __worldGeometry?: (name: string) => unknown }).__worldGeometry = (
    name: string,
  ) => {
    let found: THREE.Mesh | null = null;
    world.group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!found && mesh.isMesh && mesh.name === name) found = mesh;
    });
    const mesh = found as THREE.Mesh | null;
    if (!mesh) return null;
    const geometry = mesh.geometry as THREE.BufferGeometry;
    const position = geometry.attributes.position as THREE.BufferAttribute;
    const normal = geometry.attributes.normal as THREE.BufferAttribute | undefined;
    const color = geometry.attributes.color as THREE.BufferAttribute | undefined;
    const index = geometry.index;
    const triangles = index ? index.count / 3 : position.count / 3;
    let up = 0;
    let down = 0;
    let sideways = 0;
    let minY = Infinity;
    let maxY = -Infinity;
    let minR = Infinity;
    let maxR = 0;
    let normalSumY = 0;
    let downwardFaces = 0;
    const faceCount = Math.min(triangles, 40000);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const ab = new THREE.Vector3();
    const ac = new THREE.Vector3();
    const face = new THREE.Vector3();
    for (let t = 0; t < faceCount; t++) {
      const i0 = index ? index.getX(t * 3) : t * 3;
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      a.fromBufferAttribute(position, i0);
      b.fromBufferAttribute(position, i1);
      c.fromBufferAttribute(position, i2);
      ab.subVectors(b, a);
      ac.subVectors(c, a);
      face.crossVectors(ab, ac).normalize();
      if (face.y > 0.35) up++;
      else if (face.y < -0.35) {
        down++;
        /* A face that winds downward while sitting on the plateau is a wound
           or a displaced vertex, not a legal piece of an island. */
        if ((a.y + b.y + c.y) / 3 > 0.55) downwardFaces++;
      } else sideways++;
      for (const point of [a, b, c]) {
        minY = Math.min(minY, point.y);
        maxY = Math.max(maxY, point.y);
        const radial = Math.hypot(point.x, point.z);
        minR = Math.min(minR, radial);
        maxR = Math.max(maxR, radial);
      }
    }
    if (normal && position.count < 40000) {
      for (let i = 0; i < position.count; i++) normalSumY += normal.getY(i);
    }
    return {
      name,
      triangles,
      vertices: position.count,
      indexed: Boolean(index),
      up,
      down,
      sideways,
      downwardFacesOnPlateau: downwardFaces,
      meanNormalY: position.count < 40000 ? normalSumY / position.count : null,
      minY,
      maxY,
      minRadius: minR,
      maxRadius: maxR,
      hasVertexColors: Boolean(color),
      boundingSphere: geometry.boundingSphere
        ? { radius: geometry.boundingSphere.radius, center: geometry.boundingSphere.center.toArray() }
        : null,
    };
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
