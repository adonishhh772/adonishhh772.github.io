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
  destinationMeta,
  PLACE_INDEX,
  hostsObjects,
  placeIndexSurface,
  type DestinationId,
} from '../world/destinations';
import {
  clearReturnView,
  currentMode,
  isDocument,
  isImmersiveWorld,
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
import { mirrorWorldState, reportProgress } from '../world/progress';
import {
  currentTheme,
  announceSkyState,
  hideWorldAlert,
  isAmbientPaused,
  pinnedSkyHour,
  prefersReducedMotion,
  RESET_VIEW_EVENT,
  SKY_HOUR_KEY,
  showWorldAlert,
  setTheme,
  subscribeAmbient,
  subscribeSkyTime,
  subscribeTheme,
  THEME_TRANSITION_MS,
  toggleTheme,
  TRAVEL_EVENT,
  type PublishedSkyState,
  type TravelDetail,
} from '../world/theme-state';
import {
  blendTheme,
  mixColor,
  readWorldTheme,
  type ThemeName,
  type WorldTheme,
} from '../observatory/theme';
import { SkyClock, phaseName, siderealTime, type SkyState } from '../observatory/sky';
import { buildTextures, type TextureLibrary } from '../observatory/textures';
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

/**
 * The two hours the light switch moves the world to.
 *
 * Not "now, but the other way round": a switch that lands on a time is a switch
 * whose result depends on when it was pressed, and pressing the moon at four in
 * the afternoon should not put the sun on the horizon. Noon and one in the
 * morning are the two unambiguous states, and they are the same two the
 * verification harness pins when it wants to talk about day and night.
 */
const DAY_HOUR = 12;
const NIGHT_HOUR = 1;

export interface ShellHandle {
  applyState(): void;
  dispose(): void;
  /**
   * Pin the world's sky to a local hour, or release it back to the clock.
   *
   * This is the world's one time control. The verification harness drives it to
   * get a deterministic noon or midnight instead of depending on when the suite
   * happens to run, and it is the hook a "see this world at dawn" affordance
   * would call. It never changes the date, so the season stays real.
   */
  setSkyTime(hour: number | null): void;
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

/**
 * How long a caption has to want to leave the screen before it may.
 *
 * The occlusion ray is cast from a camera that is itself moving, and the frame
 * a caption is measured in changes every few frames, so a caption beside
 * something — the observatory, a caption it nearly touched — flips its answer
 * constantly. A decision that flips is not information, it is flicker, so
 * leaving is something a caption has to mean for a moment. Appearing is
 * immediate: a caption arriving is never the thing that looked broken.
 */
const CAPTION_HIDE_DELAY = 260;

/**
 * How much of an overlap a caption will tolerate before it moves.
 *
 * `CAPTION_GAP` is the clearance a caption asks for when it is being *placed*:
 * it should not come to rest touching anything. Once it is there, though, the
 * standard has to be looser, or the smallest drift in a neighbour — the moon's
 * core box a pixel wider, another caption leaning in by two — evicts it, the
 * search finds it a new home, the neighbour moves back, and it returns. That
 * trade is what a menu hopping between positions looks like, so a caption
 * already on screen is asked only to avoid a *real* overlap before it is moved.
 */
const CAPTION_STAY = 2;

/**
 * The box a caption's marker occupies, in CSS pixels.
 *
 * The stylesheet fixes it: a compact caption is a 44px circle with no padding
 * and no gap whatever its name is. Naming it here means the placement can ask
 * for the marker's box without measuring the element — which, while the
 * caption is showing its name, would answer with the name's size instead.
 */
const MARKER_SIZE = 44;
/** Minimum screen gap between overview destination markers when projected close. */
const OVERVIEW_MARKER_GAP = 54;
/** Same idea at a destination: project vitrines can sit near each other. */
const DESTINATION_MARKER_GAP = 50;

/**
 * The order the campus menu is placed in — Home first, then the ring.
 *
 * It is deliberately not the captions' distance from the camera. Distance is a
 * function of where the island has turned to, so a placement order built on it
 * changes while the visitor is only looking, and two captions that clash end up
 * trading places frame by frame. A fixed order gives the menu a fixed head and
 * a stable queue behind it: whoever cannot have the spot yields, and always the
 * same one does.
 */
const PLACE_RANK: Record<string, number> = {
  'place:campus': 0,
  'place:studio': 1,
  'place:workshop': 2,
  'place:library': 3,
  'place:workbench': 4,
  'place:contact': 5,
};
const PLACE_RANK_SPAN = 5;
/** Kept inside the band the old distance bonus used, so nothing else moves. */
const PLACE_RANK_WEIGHT = 4;

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
const CAMPUS_EXTENT = { horizontal: 17.2, vertical: 13.2 };
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
/**
 * The overview's field of view, and how high above the island's centre of mass
 * it aims.
 *
 * These two numbers are a single decision and were arrived at together, because
 * the frame has to hold two things at once: the campus, and the sky the campus
 * stands under.
 *
 * The original 38° was chosen to fill the frame with the island, and it did —
 * but a 38° frame is 19° either side of where it points, and the island is close
 * enough and small enough that the fitted shot aimed 32° down at it. The top of
 * that frame was therefore thirteen degrees *below* the horizon: a composition
 * with no sky in it at all. Every sunrise, every phase of the moon and every
 * hour of the night sky were being computed correctly and then aimed at the
 * ground, which is why the world's light could only ever be seen as a change of
 * colour on the terrain.
 *
 * Widening the lens is what fixes it, and the amount is set by the *sun* rather
 * than by taste. A northern-hemisphere sun spends the day between the horizon and
 * about 46°, so holding its whole arc needs the frame to reach roughly 35° above
 * the horizon; with the camera aimed about 35° down at the island, that is a
 * field of view of about 72°. Anything narrower shows a sky with nothing in it:
 * at 50° the top of the frame reached 6°, and since a low sun below 6° is behind
 * the island's own horizon and a high one is above the frame, there was no hour
 * of any day at which a visitor could see the sun they were controlling.
 *
 * A 72° lens is wide — the island sits in the middle distance rather than filling
 * the frame — and that is the honest trade: a world whose light comes from the
 * sky has to show the sky.
 */
const OVERVIEW_FOV_LANDSCAPE = 72;
const OVERVIEW_FOV_PORTRAIT = 76;
/**
 * How much higher than the island's centre of mass the camera aims.
 *
 * This is the camera's *height*, and so the angle it looks down at, and it is
 * the number that decides how much sky the frame holds. At 3 the camera sits
 * about nineteen units above the island's centre at a distance of thirty-four,
 * which is a thirty-degree depression: with the wide lens above, the frame spans
 * from about 6° above the horizon down to well past the keel, so the island sits
 * in the lower half and the sky above it holds both a low sun and a rising moon.
 *
 * Both of its neighbours are wrong in instructive ways. At zero the camera comes
 * down to the horizon's own level and the island is seen edge-on, with its
 * underside hidden and the campus flattened into a strip. At 8.6 it sits
 * twenty-seven units up and looks down at 35°, which pushes the horizon out of
 * the top of the frame entirely — the island ends up small and low with nothing
 * above it but empty air.
 */
const OVERVIEW_LIFT = 3.6;

function overviewShot(usable: { aspect: number }): Shot {
  const portrait = usable.aspect < 1.15;
  const fov = portrait ? OVERVIEW_FOV_PORTRAIT : OVERVIEW_FOV_LANDSCAPE;
  const vFov = THREE.MathUtils.degToRad(fov);
  const halfV = Math.tan(vFov / 2);
  const halfH = halfV * Math.max(usable.aspect, 0.35);

  /* How much of the frame the island is allowed to fill. */
  const widthFraction = portrait ? 0.93 : 0.82;
  const heightFraction = portrait ? 0.88 : 0.76;
  const distanceForWidth = CAMPUS_EXTENT.horizontal / widthFraction / halfH;
  const distanceForHeight = CAMPUS_EXTENT.vertical / heightFraction / halfV;
  const distance = Math.max(distanceForWidth, distanceForHeight);

  /*
   * The bearing.
   *
   * Two things constrain it, and they pull in the same direction. A phone is so
   * much narrower than it is tall that the island, seen from the desktop's
   * three-quarter angle, runs off the right edge while leaving a wide band of
   * empty sky on the left — so portrait gets its own three-quarter angle.
   *
   * And the camera has to face the part of the sky the sun actually crosses. The
   * bearing below was a north-east one, which pointed the camera at 41° while
   * the sun sweeps the *southern* half of the sky: the two never met, so no hour
   * of any day had the sun in frame and the whole time-of-day system showed up
   * only as a change of light on the ground.
   *
   * Getting this right is a question of arithmetic, not taste. At this latitude
   * the sun rises in the east, is due south at noon and sets in the west — a
   * sweep of roughly 90° to 290° — and the moon covers a similar arc. A frame
   * 72° wide cannot hold all of that, so the camera is aimed at the middle of it:
   * about 225°, which puts the whole of the sun's afternoon and the whole of the
   * moon's evening rise inside the frame, with the noon sun just off its left
   * edge.
   *
   * Every narrower answer was tried and each one failed the same way. At 139° the
   * moon that rises at 180° and climbs to twenty degrees sat forty degrees off
   * centre, just outside the frame; at 105° the evening moon was not merely
   * outside it but *behind* the camera, which is why pressing it did nothing. A
   * sky you cannot see is a sky you cannot press, and the sun and the moon are
   * the controls for the world's light.
   *
  /*
   * The camera is composed from a fixed *facing*, and the offset that produces
   * it is `(-sin facing, ·, -cos facing)` — the opposite end of the line — turned
   * about the island's vertical axis until the shot reads as a three-quarter
   * view. The turn is a separate, explicit number rather than being folded into
   * the facing, because the two got confused twice while this was being written:
   * the offset bearing and the view bearing differ by 180°, and rotating the
   * offset by +θ turns the view by −θ.
   */
  /*
   * The offset that puts the camera where it should stand.
   *
   * `OFFSET_BEARING` is the compass bearing from the *island out to the camera*,
   * which is not the direction the camera looks: the camera looks back down that
   * line at the island, so the two differ by 180°. The view it produces is
   * checked rather than derived — the diagnostics report the bearing the camera
   * actually faces, and `225°` there is the number this constant has to produce.
   *
   * That check is not ceremony. This constant was wrong three times while it was
   * being written, every time by 180°, and each wrong value put the camera in
   * front of a different quarter of the sky: at 45° the sun set behind it, and
   * the moon — the world's only night-time light control — was unreachable for
   * the whole of the evening.
   */
  const OFFSET_BEARING = 135;
  const offset = THREE.MathUtils.degToRad(OFFSET_BEARING);
  const elevation = portrait ? 0.44 : 0.5;
  const direction = new THREE.Vector3(Math.sin(offset), elevation, Math.cos(offset)).normalize();
  const target = CAMPUS_CENTRE.clone();
  target.y += portrait ? OVERVIEW_LIFT * 0.9 : OVERVIEW_LIFT;
  /*
   * A portrait frame is tall and narrow, and the island is a wide disc: the
   * width is what limits it, which leaves a band of empty sky above and below,
   * with the identity card and the control bar already claiming the top. On a
   * phone the aim is lifted a little further, so that empty band sits above the
   * campus where the card is rather than below it — but not so much that the sun
   * sits on the top edge; a slightly shallower depression keeps the sky lower
   * in the frame.
   */
  if (portrait) target.y += 1.45;
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

  /*
   * Sliding the look-at point moves the subject the opposite way on screen.
   *
   * The Y term carries a sign that is easy to get backwards, and getting it
   * backwards is not a small error: the subject is placed on the wrong side of
   * its target, so a frame composed to centre the island in the space the
   * interface leaves free centres it *below* that space instead. That reads as a
   * large empty sky above a small island low in the frame, and it is what pushed
   * the horizon out of view even after the field of view had been widened enough
   * to hold it.
   *
   * The two axes genuinely differ. Screen X grows to the right, so moving the
   * target right moves the subject left — a positive X offset is subtracted.
   * Screen Y grows *downwards* while the camera's up axis points up, so the same
   * reasoning flips: a subject that must sit below the frame's centre needs the
   * target raised, not lowered.
   */
  target
    .add(right.multiplyScalar(-offsetX * worldPerPixel))
    .add(up.multiplyScalar(offsetY * worldPerPixel));

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
  if (!stage || !canvas || !hotspotLayer) {
    return { applyState() {}, dispose() {}, setSkyTime() {} };
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

  /*
   * ── The clock ─────────────────────────────────────────────────────
   *
   * The world's light comes from the visitor's own clock, read once here and
   * then re-read as the minute turns. Nothing below this line invents a time:
   * `skyClock.current` is the only source, and `readWorldTheme` turns it into
   * the palette and the light rig.
   */
  const skyClock = new SkyClock();
  let skyState: SkyState = skyClock.current;
  /*
   * A pinned hour from a previous visit. The world follows the clock by default
   * and only departs from it when the visitor has said so, so this is read once
   * and applied once — anything else would need a way to tell a pin from a
   * coincidence, and there is no such way.
   */
  const rememberedHour = pinnedSkyHour();
  if (rememberedHour !== null) {
    skyClock.setOverride({ hour: rememberedHour }, { hour: rememberedHour });
  } else {
    const hour = currentTheme() === 'light' ? DAY_HOUR : NIGHT_HOUR;
    skyClock.setOverride({ hour }, { hour });
  }
  skyState = skyClock.current;
  let theme: WorldTheme = readWorldTheme(currentTheme(), skyState);
  /**
   * How far the star field has turned, in degrees.
   *
   * The sky turns once per *sidereal* day — 366.25 turns a year rather than
   * 365.25, the extra one being the turn the Earth makes beneath the sun. Taken
   * from the local sidereal time so the stars stay in step with the moon and the
   * sun, instead of drifting against them by four minutes a day.
   */
  let siderealAngle = siderealTime(skyState.jd, skyState.longitude);

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
   * The generated surface maps.
   *
   * Built once, before the world, because the world's materials want them at
   * construction and its grass wants them immediately afterwards. They are the
   * most expensive thing at boot — a few dozen milliseconds of canvas work — and
   * the one thing that turns a coloured mesh into a *surface*.
   */
  let textures: TextureLibrary | null = null;
  try {
    textures = buildTextures({
      grass: theme.grass,
      dry: theme.dryGrass,
      soil: theme.earth,
      stoneAlt: theme.stoneAlt,
      moss: theme.moss,
      stoneDeep: theme.stoneDeep,
      stone: theme.stone,
      mineral: theme.mineral,
      bark: theme.bark,
      barkDeep: theme.barkDeep,
      leafLight: theme.snow,
      leafMid: theme.grass,
      leafDark: theme.moss,
      grassBase: theme.moss,
      grassMid: theme.grass,
      grassTip: theme.dryGrass,
    });
    materials.setTextures(textures);
  } catch (error) {
    /*
     * A canvas that will not give up a 2D context is a real possibility on a
     * locked-down browser. The world is entirely able to run without the maps —
     * flat-shaded, but running — so a failure here degrades instead of stopping
     * the scene. (In practice a 2D context is unavailable only where WebGL is
     * too, so this is belt and braces.)
     */
    void error;
    textures = null;
  }
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
  if (textures) world.setTextures(textures);
  atmosphere.setSiderealAngle(siderealAngle);
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
  /**
   * The last decision made about each caption.
   *
   * Captions are re-placed every frame against a camera that never sits still,
   * and without a memory of what was decided a moment ago they hop between
   * positions and blink in and out as the island turns — which is exactly the
   * visual noise that makes a scene feel broken rather than alive. These are
   * that memory: where each caption was put, whether it was on screen, and
   * since when it has been asking to leave.
   */
  const lastSpot = new Map<string, { dy: number; compact: boolean }>();
  const wasVisible = new Map<string, boolean>();
  const hideWanted = new Map<string, number>();
  /**
   * The measured size of each caption's name-pill.
   *
   * `offsetWidth` on a caption answers for the weight it is showing right now,
   * and a marker is 44px wide whatever its name is — so the pill's size has to
   * be asked for separately and remembered, or a marker tested for growth is
   * measured against its own marker box, decides it fits, grows into a pill
   * that does not, shrinks, and repeats. That is the flicker.
   */
  const pillSizes = new Map<string, { w: number; h: number }>();
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
  let themeTargetName: ThemeName | null = null;
  let skyHourBlending = false;
  let skyHourFrom = 0;
  let skyHourTo = 0;
  let envClock = 0;
  let skyEnvClock = 0;
  const themeScratch = {} as WorldTheme;
  const themeMovingEnd = {} as WorldTheme;

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

  function startThemeTransition(next: WorldTheme, animate: boolean, skyBlend = false): void {
    if (!animate || reducedMotion) {
      themeFrom = null;
      themeTo = null;
      themeBlending = false;
      skyHourBlending = false;
      themeTargetName = null;
      liveTheme = next;
      applyTheme(next, true);
      if (!running) renderOnce();
      return;
    }
    themeFrom = { ...liveTheme };
    themeTo = skyBlend ? null : next;
    skyHourBlending = skyBlend;
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
    if (!themeFrom || (!themeTo && !skyHourBlending)) return false;
    themeT = Math.min(1, themeT + (delta * 1000) / THEME_TRANSITION_MS);
    const eased = easeInOut(themeT);

    if (skyHourBlending && themeTargetName) {
      const hour = skyHourFrom + (skyHourTo - skyHourFrom) * eased;
      skyState = skyClock.setOverride({ hour }, { hour });
      siderealAngle = siderealTime(skyState.jd, skyState.longitude);
      atmosphere.setSiderealAngle(siderealAngle);
      readWorldTheme(themeTargetName, skyState, themeMovingEnd);
      blendTheme(themeFrom, themeMovingEnd, eased, themeScratch);
      updateCelestialHotspot();
      publishSkyState();
    } else if (themeTo) {
      blendTheme(themeFrom, themeTo, eased, themeScratch);
    }

    envClock += delta * 1000;
    const environment = envClock >= 120 || themeT >= 1;
    if (environment) envClock = 0;
    liveTheme = { ...themeScratch };
    applyTheme(themeScratch, environment);
    if (themeT >= 1) {
      const settled = skyHourBlending && themeTargetName
        ? readWorldTheme(themeTargetName, skyState, themeMovingEnd)
        : themeTo!;
      themeFrom = null;
      themeTo = null;
      themeBlending = false;
      skyHourBlending = false;
      themeTargetName = null;
      liveTheme = { ...settled };
      applyTheme(liveTheme, true);
    }
    return true;
  }

  const stopThemes = subscribeTheme((detail) => {
    let nextSky = skyState;
    let skyBlend = false;

    if (detail.source !== 'system') {
      const targetHour = detail.theme === 'light' ? DAY_HOUR : NIGHT_HOUR;
      try {
        localStorage.setItem(SKY_HOUR_KEY, String(targetHour));
      } catch {
        /* storage unavailable */
      }

      if (detail.animate && !reducedMotion) {
        skyHourFrom = skyState.hours;
        skyHourTo = targetHour;
        themeTargetName = detail.theme;
        skyBlend = true;
      } else {
        themeTargetName = null;
        nextSky = skyClock.setOverride({ hour: targetHour }, { hour: targetHour });
        skyState = nextSky;
        siderealAngle = siderealTime(nextSky.jd, nextSky.longitude);
        atmosphere.setSiderealAngle(siderealAngle);
      }
    } else {
      themeTargetName = null;
    }

    startThemeTransition(readWorldTheme(detail.theme, nextSky), detail.animate, skyBlend);
    updateCelestialHotspot();
    publishSkyState();
    if (!running) renderOnce();
  });

  /**
   * Adopt a new reading of the clock.
   *
   * The sky moves on its own — it is not something the visitor asked for — so
   * it is applied immediately rather than through the page-theme transition. A
   * slow blend of a minute's worth of change would be invisible anyway, and
   * blending it through `themeFrom`/`themeTo` would collide with a page-theme
   * transition that happened to be in flight.
   */
  function applySkyState(next: SkyState, environment: boolean): void {
    skyState = next;
    siderealAngle = siderealTime(next.jd, next.longitude);
    atmosphere.setSiderealAngle(siderealAngle);
    liveTheme = readWorldTheme(currentTheme(), next, themeScratch);
    applyTheme(liveTheme, environment);
    themeFrom = null;
    themeTo = null;
    themeBlending = false;
    updateCelestialHotspot();
    publishSkyState();
    if (!running) renderOnce();
  }

  /**
   * Publish the world's clock for the chrome.
   *
   * The interface must not import three.js, so the shell writes its reading onto
   * the stage element as data and the chrome reads it. That keeps the two in
   * step without a second clock: the dial shows what the world is actually
   * computing, not what the last request happened to ask for.
   */
  function publishSkyState(): void {
    stageEl.dataset.skyState = JSON.stringify({
      label: skyState.label,
      hours: skyState.hours,
      overridden: skyState.overridden,
      dayness: skyState.dayness,
      sunAltitude: skyState.sun.altitude,
      moonAltitude: skyState.moon.altitude,
      moonPhase: phaseName(skyState.moon.elongation),
    } satisfies PublishedSkyState & Record<string, unknown>);
    for (const readout of document.querySelectorAll<HTMLElement>('[data-world-sky-readout]')) {
      readout.textContent = skyState.label;
    }
    announceSkyState({
      label: skyState.label,
      hours: skyState.hours,
      overridden: skyState.overridden,
      dayness: skyState.dayness,
      sunAltitude: skyState.sun.altitude,
      moonAltitude: skyState.moon.altitude,
      moonPhase: phaseName(skyState.moon.elongation),
    });
  }

  /**
   * Pin the world to an hour, or hand it back to the clock.
   *
   * `hour` is a local hour in `[0, 24)`; `null` releases the override. This is
   * the world's public time control: it backs the debug hook the verification
   * harness drives, and it is what a "look at this world at dawn" affordance
   * would call. The date is never replaced, so the season stays real.
   */
  function setSkyTime(hour: number | null, date?: Date): SkyState {
    const next = skyClock.setOverride(
      hour === null ? null : { hour },
      hour === null ? { hour: 0 } : { hour, date },
      date,
    );
    applySkyState(next, true);
    return next;
  }

  /**
   * Switch the world's light — and move the sky to match.
   *
   * The sun and the moon are the world's light switch, and a switch has to mean
   * something. Two earlier versions of this got it wrong in opposite directions:
   * the first did nothing but recolour the page, so at six in the evening the
   * visitor pressed the moon and watched the sun go on setting; the second held
   * the sky at whatever hour it happened to be, which is a switch that changes
   * the furniture but not the light.
   *
   * What the visitor is asking for when they press a sky body is *the other time
   * of day*, so that is what this does: the page theme changes and the sky goes
   * to the hour that belongs to it — noon for daylight, the small hours for
   * night — whatever the visitor's own clock says. The choice is pinned *and*
   * persisted, so it overrides the clock now, on the next page and on the next
   * visit, until they hand the world back with the time dial's "follow my clock"
   * control. A switch that quietly reverts to the wall clock is not a switch.
   */
  const stopAmbient = subscribeAmbient((paused) => {
    ambientAllowed = !paused && !reducedMotion;
    settings = settingsFor(tier, ambientAllowed);
    materials.setQuality(settings);
    atmosphere.setQuality(settings);
    world.setQuality(settings);
  });

  /*
   * The time dial. The chrome raises a request and the shell, which owns the
   * clock, answers it — the same arrangement as the camera reset, and for the
   * same reason.
   */
  const stopSkyTime = subscribeSkyTime((detail) => {
    if (disposed) return;
    setSkyTime(detail.hour ?? null);
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
      link.setAttribute('aria-label', meta ? `${label} — ${meta}` : label);
      link.setAttribute('title', label);
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
    link.addEventListener('pointerleave', (event) => {
      const related = event.relatedTarget;
      if (related instanceof Node && hotspotEl.contains(related)) return;
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
    /* The camera may have moved in the same frame: ask the new view what it
       hides before the captions are placed in it. */
    castOcclusion();
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
    /*
     * A new set of captions, and nothing is known about any of them yet. This
     * is what makes a travel calm: the captions of the place being arrived at
     * are new, so they are not placed until the camera is still, and then they
     * fade in once instead of strobing through the flight.
     */
    lastSpot.clear();
    wasVisible.clear();
    hideWanted.clear();
    /* Captions are new elements with their own labels: nothing measured about
       the last set of them applies to this one. */
    pillSizes.clear();

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
        if (destination.id === 'campus') continue;
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
        const indexListingOpen = placeIndexSurface(focusPlace) === state.surface;
        if (index && !indexListingOpen) {
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
   * The sky body's caption.
   *
   * Icon-only: the body it names is already plain, so it carries an accessible
   * label and a title instead of a visible word, and the icon inside the circle
   * is the whole control.
   *
   * The label names what is actually up — the sun by day, and at night the moon
   * *with its phase*, because "waning crescent" is a fact about the sky the
   * visitor is looking at and a rendering that gets the phase right has earned
   * the right to say so.
   */
  function updateCelestialHotspot(): void {
    const link = hotspots.get(CELESTIAL_KEY);
    if (link) {
      const day = liveTheme.dayness > 0.5;
      const phase = phaseName(skyState.moon.elongation);
      const label = day
        ? `The sun — up at ${skyState.label}, ${Math.round(skyState.sun.altitude)}° above the horizon`
        : `The moon — ${phase}, up at ${skyState.label}`;
      link.setAttribute('aria-pressed', day ? 'true' : 'false');
      link.setAttribute('aria-label', label);
      link.setAttribute('title', label);
      const mark = link.querySelector<HTMLElement>('.world-hotspot-mark');
      if (mark) paintMark(mark, day ? 'sun' : 'moon');
    }
    const physical = hotspots.get(LIGHT_SWITCH_KEY);
    if (physical) {
      /* The switch drives the world's lamps, which the hour decides. */
      const lampsOn = liveTheme.practicalIntensity > 1;
      const label = lampsOn
        ? 'The observatory light switch — turn the lamps off'
        : 'The observatory light switch — turn the lamps on';
      physical.setAttribute('aria-pressed', lampsOn ? 'true' : 'false');
      physical.setAttribute('aria-label', label);
      physical.setAttribute('title', label);
      const mark = physical.querySelector<HTMLElement>('.world-hotspot-mark');
      if (mark) paintMark(mark, 'switch');
    }
  }

  function islandAnchor(local: THREE.Vector3): THREE.Vector3 {
    return world.turnPoint(local);
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
      return islandAnchor(world.lightSwitchAnchor());
    }
    if (key.startsWith('place:')) {
      const id = key.slice(6) as DestinationId;
      if (id === 'campus') {
        /* Above the dome, but not so far above it that the label is pushed
           off the top of the frame on a wide, short view. */
        const node = world.places.get('campus');
        return node
          ? islandAnchor(node.anchor.clone().add(new THREE.Vector3(0, 2.5, 0)))
          : null;
      }
      const node = world.places.get(id);
      return node ? islandAnchor(node.anchor) : null;
    }
    const parts = key.split(':');
    if (parts[1] === 'index') {
      const node = world.places.get(parts[2] as DestinationId);
      /* Above the place, so it never sits on top of an object's caption. */
      return node
        ? islandAnchor(node.anchor.clone().add(new THREE.Vector3(0, 2.6, 0)))
        : null;
    }
    const marker = world.objectMarkers.find((m) => m.kind === parts[1] && m.id === parts[2]);
    return marker ? islandAnchor(marker.anchor) : null;
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
    castOcclusion();
  }

  /**
   * Cast the occlusion ray for every caption.
   *
   * This is the expensive half of the pass, so it runs on the slow clock while
   * the camera is drifting — but it is also run on demand whenever the camera
   * has just been *put* somewhere. An immediate cut to a destination otherwise
   * places its captions against the occlusion of the view we just left, so
   * they appear for a moment and then vanish when the truth catches up: a
   * flicker on exactly the navigation the visitor asked for.
   */
  function castOcclusion(): void {
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
    occlusionClock = 0.15;
  }

  function projectHotspots(): void {
    const width = stageEl.clientWidth;
    const height = stageEl.clientHeight;
    const now = performance.now();
    const focused = document.activeElement as HTMLElement | null;
    const projected = new THREE.Vector3();
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    /** The markers among them, which are allowed to crowd each other. */
    const markers: { x: number; y: number; w: number; h: number }[] = [];
    const stableMarkerCenters: { x: number; y: number }[] = [];
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
    /**
     * The foot of Home's caption, which is the head of the campus menu.
     *
     * The workbench stands at the back of the island — from the overview it is
     * almost exactly opposite the camera, behind the observatory — so its
     * anchor projects to the very top of the frame, above the landmark it is
     * named after and above Home itself. The menu is read from Home downwards,
     * so no other destination caption is allowed above it: it is lifted to sit
     * under Home, and the rest of the ring follows in `PLACE_RANK` order.
     */
    let menuHeadBottom: number | null = null;

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
    const dock = document.querySelector<HTMLElement>('.world-dock');
    if (dock) {
      const rect = dock.getBoundingClientRect();
      if (rect.width > 8 && rect.height > 8) {
        blocked.push({ x: rect.left, y: rect.top, w: rect.width, h: rect.height });
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
      /* Skip captions the open document is sitting on top of. */
      const underPanel =
        panelRect !== null &&
        x > panelRect.left - 24 &&
        x < panelRect.right + 24 &&
        y > panelRect.top - 24 &&
        y < panelRect.bottom + 24;
      const distance = rig.camera.position.distanceTo(anchor);
      /*
       * Places are placed in a fixed order, not by how far away they happen to
       * be this frame.
       *
       * Distance changes as the island turns, and a priority that drifts with
       * it means two captions which clash can swap places from one frame to the
       * next — one takes the spot, the other moves aside, and then they trade.
       * That trading is the shuffling. Home is placed first, so the menu has a
       * fixed head, and the rest follow the campus ring from it; a caption that
       * cannot have its own spot now yields *downwards* (see `clearSpot`),
       * which is what keeps Open source under Home rather than over it.
       */
      const rank = PLACE_RANK[key];
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
          (rank === undefined
            ? Math.max(0, 60 - distance)
            : (PLACE_RANK_SPAN - rank) * PLACE_RANK_WEIGHT),
        occluded: isOccluded || offscreen || underPanel,
      });
    }

    candidates.sort((a, b) => b.priority - a.priority);

    /**
     * The size of a caption's name-pill, measured once and remembered.
     *
     * Asking the element is the only way to know, and it has to be asked for
     * the pill's weight explicitly: see `pillSizes`.
     */
    const pillSize = (key: string, link: HTMLElement) => {
      const cached = pillSizes.get(key);
      if (cached) return cached;
      const previous = link.dataset.compact;
      link.dataset.compact = 'false';
      const size = { w: link.offsetWidth || 44, h: link.offsetHeight || 44 };
      if (previous === undefined) delete link.dataset.compact;
      else link.dataset.compact = previous;
      pillSizes.set(key, size);
      return size;
    };

    /** Where a caption of a given size would sit, projected. */
    const boxOfSize = (anchor: THREE.Vector3, w: number, h: number) => {
      const p = anchor.clone().project(rig.camera);
      return {
        x: (p.x * 0.5 + 0.5) * width - w / 2,
        y: (-p.y * 0.5 + 0.5) * height - h / 2,
        w,
        h,
      };
    };

    /** The box the caption's name-pill occupies. */
    const pillBoxFor = (key: string, link: HTMLElement) => {
      const anchor = candidateAnchor(link);
      if (!anchor) return null;
      const size = pillSize(key, link);
      return boxOfSize(anchor, size.w, size.h);
    };

    /**
     * The box the caption's marker occupies.
     *
     * A marker is a 44px circle by construction — the stylesheet says so — so
     * this needs no measurement, and, unlike a measurement, it is right even
     * while the caption is showing its name.
     */
    const markerBoxFor = (link: HTMLElement) => {
      const anchor = candidateAnchor(link);
      if (!anchor) return null;
      return boxOfSize(anchor, MARKER_SIZE, MARKER_SIZE);
    };

    const overlapsAny = (
      box: { x: number; y: number; w: number; h: number },
      list: typeof placed,
      gap = CAPTION_GAP,
    ) =>
      list.some(
        (o) =>
          box.x < o.x + o.w + gap &&
          box.x + box.w + gap > o.x &&
          box.y < o.y + o.h + gap &&
          box.y + box.h + gap > o.y,
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
     * The search walks outwards from the anchor and takes the first position
     * that clears the named pills, the sun's core and the interface. It walks
     * *downwards* first, and that is not arbitrary: a caption that has to give
     * way should give way towards the foot of the frame, where the labels are
     * spread out and the identity card already keeps them off, rather than
     * upwards into the head of the menu — pushing Open source above Home is
     * exactly what it used to do. The position the caption held last frame is
     * tried before either, so a caption that still fits where it is stays put.
     */
    const clearSpot = (
      box: { x: number; y: number; w: number; h: number },
      solid: typeof placed,
      marked: typeof placed,
      avoid: typeof placed,
      preferred = 0,
      least: number | null = null,
    ): { x: number; y: number; w: number; h: number } | null => {
      for (const dy of [preferred, 0, 18, -18, 36, -36, 56, -56, 78, -78]) {
        const moved = { ...box, y: box.y + dy };
        /* The floor is a floor: a caption may not be nudged back above it. */
        if (least !== null && moved.y < least) continue;
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
      const before = lastSpot.get(candidate.key);
      const visibleBefore = wasVisible.get(candidate.key) === true;
      const flying = rig.travelling;
      const isOverviewPlace =
        menu && candidate.key.startsWith('place:') && candidate.key !== 'place:campus';
      /*
       * Project and article markers at a destination (e.g. HyperRAN and the
       * education platform in the workshop) sit close in screen space. The
       * pill-placement pass swaps them frame to frame when one is hovered or
       * focused — pin them like the campus overview instead.
       */
      const isStableObject =
        !menu &&
        focusPlace !== 'campus' &&
        candidate.key.startsWith('object:') &&
        !candidate.key.startsWith('object:index:');

      if (isOverviewPlace || isStableObject) {
        if (
          flying &&
          !visibleBefore &&
          !isFocused &&
          !isRevealed &&
          !isStableObject
        ) {
          link.dataset.visible = 'false';
          link.setAttribute('aria-hidden', 'true');
          link.tabIndex = -1;
          wasVisible.set(candidate.key, false);
          continue;
        }
        if (isStableObject && candidate.occluded && !isFocused && !isRevealed) {
          link.dataset.visible = 'false';
          link.setAttribute('aria-hidden', 'true');
          link.tabIndex = -1;
          wasVisible.set(candidate.key, false);
          continue;
        }
        const markerAnchor = markerBoxFor(link);
        if (!markerAnchor) {
          link.dataset.visible = 'false';
          wasVisible.set(candidate.key, false);
          continue;
        }
        const expanded = isFocused || isRevealed;
        link.dataset.compact = 'true';
        link.dataset.expanded = expanded ? 'true' : 'false';
        const margin = 8;
        const halfW = MARKER_SIZE / 2;
        const halfH = MARKER_SIZE / 2;
        const isWorkbenchRepo =
          focusPlace === 'workbench' && candidate.key.startsWith('object:repo:');
        let x = markerAnchor.x + markerAnchor.w / 2;
        let y = markerAnchor.y + markerAnchor.h / 2;
        if (!isWorkbenchRepo) {
          const minGap = isStableObject ? DESTINATION_MARKER_GAP : OVERVIEW_MARKER_GAP;
          x = markerAnchor.x + halfW;
          y = markerAnchor.y + halfH;
          for (let pass = 0; pass < 5; pass++) {
            for (const other of stableMarkerCenters) {
              const dx = x - other.x;
              const dy = y - other.y;
              const dist = Math.hypot(dx, dy);
              if (dist >= minGap) continue;
              const push = dist > 0.5 ? (minGap - dist) * 0.6 : minGap;
              const nx = dist > 0.5 ? dx / dist : 0;
              const ny = dist > 0.5 ? dy / dist : -1;
              x += nx * push;
              y += ny * push;
            }
            x = THREE.MathUtils.clamp(
              x,
              halfW + margin,
              Math.max(halfW + margin, width - halfW - margin),
            );
            y = THREE.MathUtils.clamp(
              y,
              halfH + margin,
              Math.max(halfH + margin, height - halfH - margin),
            );
          }
        } else {
          x = THREE.MathUtils.clamp(
            x,
            halfW + margin,
            Math.max(halfW + margin, width - halfW - margin),
          );
          y = THREE.MathUtils.clamp(
            y,
            halfH + margin,
            Math.max(halfH + margin, height - halfH - margin),
          );
        }
        link.dataset.visible = 'true';
        link.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
        link.setAttribute('aria-hidden', 'false');
        link.tabIndex = 0;
        wasVisible.set(candidate.key, true);
        lastSpot.delete(candidate.key);
        if (!isWorkbenchRepo) stableMarkerCenters.push({ x, y });
        markers.push(markerAnchor);
        continue;
      }

      /*
       * A destination caption on the campus overview belongs to the menu, so
       * it is placed even when the island is standing in front of it. Every
       * other caption keeps the old rule: behind something is not on screen.
       */
      const isHead = candidate.key === 'place:campus';
      const guaranteed = menu && candidate.key.startsWith('place:');
      /* The sun and the light switch are icon-only: they are placed like
         captions but they are not words, so they do not spend the budget. */
      const named = candidate.key !== CELESTIAL_KEY && candidate.key !== LIGHT_SWITCH_KEY;
      /* Nothing in the menu sits above Home. */
      const floor: number | null =
        menuHeadBottom !== null && guaranteed && !isHead
          ? menuHeadBottom + CAPTION_GAP + 4
          : null;
      const lift = (
        b: { x: number; y: number; w: number; h: number } | null,
      ): { x: number; y: number; w: number; h: number } | null =>
        b && floor !== null && b.y < floor ? { ...b, y: floor } : b;

      /*
       * Nothing is decided while the camera is flying between shots.
       *
       * A travel changes the ray, the frame and the reading panel every few
       * frames, so every caption in turn finds itself occluded, clashing or
       * past the budget — which is what made selecting a destination flicker.
       * In flight the screen therefore keeps the captions it already had, and
       * the place being arrived at brings its own when the camera is still,
       * where they fade in once instead of strobing all the way there.
       */
      const wantsOut =
        !isFocused && !isRevealed && !guaranteed && (flying ? !visibleBefore : candidate.occluded);
      let leaving = false;
      if (wantsOut) {
        const since = hideWanted.get(candidate.key);
        if (since === undefined) hideWanted.set(candidate.key, now);
        else leaving = now - since >= CAPTION_HIDE_DELAY;
      } else {
        hideWanted.delete(candidate.key);
      }

      if (leaving) {
        link.dataset.compact = 'false';
        link.dataset.visible = 'false';
        link.setAttribute('aria-hidden', 'true');
        link.tabIndex = -1;
        wasVisible.set(candidate.key, false);
        lastSpot.delete(candidate.key);
        continue;
      }

      /*
       * A caption that is part of the menu, or that was on screen a frame ago,
       * is placed whatever the rules below think of it. It is moved out of the
       * way, or held where it is, before it is ever lost.
       */
      const mustPlace = guaranteed || (visibleBefore && !isFocused && !isRevealed);

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
      /* How far the chosen position sits from the caption's own anchor, so the
         next frame can offer it the same place first. */
      let spotDy = 0;
      /*
       * Where the caption sits as a name-pill, and where it sits as a marker —
       * both lifted to the menu floor (see above). Asking for the right box
       * for the weight being considered is the whole point: that answer is
       * what decides whether it fits.
       */
      const pillAnchor = lift(pillBoxFor(candidate.key, link));
      const markerAnchor = lift(markerBoxFor(link));
      /* Where it stood last frame, in the weight it stood there as. */
      const heldBase = before?.compact ? markerAnchor : pillAnchor;
      const heldBox =
        before && heldBase ? lift({ ...heldBase, y: heldBase.y + before.dy }) : null;
      /*
       * A caption the visitor is on shows its name — and stays where it is.
       *
       * Putting it back onto its anchor while it is hovered, focused or held
       * under a finger is what made this flicker: the pointer that revealed it
       * is on the caption, the caption jumps out from under the pointer, the
       * pointer leaves, the caption comes back — for as long as the visitor
       * holds still. It is worst exactly where the two positions are furthest
       * apart, which is the menu: a destination that has been lifted under
       * Home would leap back to its building and back again.
       */
      let box: { x: number; y: number; w: number; h: number } | null =
        isFocused || isRevealed ? heldBox ?? pillAnchor : null;

      if (!isFocused && !isRevealed) {
        const full = compactAll ? null : pillAnchor;
        /* A menu caption answers to the bar as well as to the card. */
        const solid = guaranteed ? menuBlocked : blocked;
        /*
         * Where it stood last frame.
         *
         * This is the first candidate for this frame, and the reason the menu
         * holds still: a caption that was a name a moment ago, and whose name
         * still fits where it was — offset and all — is left exactly there.
         * Without it a caption that had stepped aside snaps back to its anchor
         * the moment the anchor is clear again and steps aside again the next
         * frame, which is a flicker at the frame rate of the island's turn.
         */
        const held = heldBox;
        const heldFits =
          held !== null &&
          !overlapsAny(held, placed, CAPTION_STAY) &&
          !overlapsAny(held, markers, CAPTION_STAY) &&
          !overlapsAny(held, sunCore, CAPTION_STAY) &&
          !overlapsAny(held, solid, CAPTION_STAY);
        /*
         * Growing back from a marker is the one decision worth asking for more
         * room than it needs: a pill that only just fits this frame will not
         * fit the next, and the caption would flicker between the two weights
         * at exactly the moment the island is turning.
         */
        const probe =
          full && before?.compact
            ? { x: full.x - 4, y: full.y - 4, w: full.w + 8, h: full.h + 8 }
            : full;
        const fitsFull =
          probe !== null &&
          !overlapsAny(probe, placed) &&
          !overlapsAny(probe, markers) &&
          !overlapsAny(probe, sunCore) &&
          !overlapsAny(probe, solid) &&
          (mustPlace || placedLabels < labelLimit);

        if (before && !before.compact && heldFits) {
          box = held;
          spotDy = before.dy;
        } else if (fitsFull) {
          box = full;
        } else if (before?.compact && heldFits) {
          compact = true;
          box = held;
          spotDy = before.dy;
        } else if (mustPlace) {
          /* The name if it can be moved clear, its marker if it cannot. */
          const kept = before?.dy ?? 0;
          const moved: { x: number; y: number; w: number; h: number } | null = full
            ? clearSpot(full, placed, markers, solid, kept, floor)
            : null;
          if (moved && full) {
            box = moved;
            spotDy = moved.y - full.y;
          } else {
            compact = true;
            const marker = markerAnchor;
            const keptMarker: { x: number; y: number; w: number; h: number } | null = marker
              ? clearSpot(marker, placed, [], solid, kept, floor) ?? marker
              : null;
            box = keptMarker;
            spotDy = marker && keptMarker ? keptMarker.y - marker.y : 0;
          }
        } else if (placed.length + markers.length < labelLimit + 4) {
          compact = true;
          const marker = markerAnchor;
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
        wasVisible.set(candidate.key, false);
        lastSpot.delete(candidate.key);
        continue;
      }

      /* Remembered, so the next frame can prefer the answer given here. */
      lastSpot.set(candidate.key, { dy: spotDy, compact });
      wasVisible.set(candidate.key, true);

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
      const halfW: number = box.w / 2;
      const halfH: number = box.h / 2;
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
      /*
       * Where the menu starts. Home is placed first (`PLACE_RANK`), so its
       * foot is known before any other destination is placed and the floor
       * above can be applied to them.
       */
      if (menu && isHead) menuHeadBottom = y + halfH;
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

  function dockReserved(): Reserved | null {
    if (focusPlace !== 'campus' || reading) return null;
    const dock = document.querySelector<HTMLElement>('.world-dock');
    if (!dock) return null;
    const style = getComputedStyle(dock);
    if (style.display === 'none' || style.visibility === 'hidden') return null;
    const rect = dock.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return null;
    const pad = 12;
    return {
      left: rect.left - pad,
      top: rect.top - pad,
      right: rect.right + pad,
      bottom: rect.bottom + pad,
    };
  }

  /** The region of the stage the interfaces do not cover. */
  function viewMetrics(): ViewMetrics {
    const stageWidth = stageEl.clientWidth || 1;
    const stageHeight = stageEl.clientHeight || 1;
    const reserved: Reserved[] = [];
    /*
     * The identity card is a translucent overlay: it sits on top of the scenery
     * rather than beside it, so the campus stays centred on the stage. Hotspot
     * placement still treats the card as blocked; only the camera ignores it.
     */
    const dock = dockReserved();
    if (dock) reserved.push(dock);
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
    /*
     * The overview is fitted to the *stage's* shape, not to the free strip's.
     *
     * The distinction decides how big the island is. The free strip is what the
     * reading surface leaves over — a wide, short band — and its aspect is much
     * wider than the screen's, so fitting the island to it computes a distance
     * for a frame that does not exist and then stands the camera far enough back
     * to fill a letterbox nobody is looking through. Measured, that shrank the
     * island to about two fifths of the frame's width with the rest given over to
     * empty sky.
     *
     * Fitting the real frame and then *sliding* the subject into the free strip is
     * what `readingShot` is for, so the two jobs are now separated: the overview
     * decides how big, and the framing decides where.
     */
    const stageAspect = Math.max(view.stageWidth / Math.max(view.stageHeight, 1), 0.35);
    const overview = overviewShot({ aspect: stageAspect });
    /*
     * Where the subject should end up: the middle of what is not covered.
     *
     * Note that this is the middle of the *free* region, not of the frame — on a
     * phone with a document open the free region is a strip, and the subject
     * belongs in the middle of the strip. `readingShot` is what puts it there.
     */
    let subject = {
      x: (free.left + free.right) / 2,
      y: (free.top + free.bottom) / 2,
    };

    /* The campus *is* the overview: centre the island on the stage, not in a
       strip carved for the identity card. Only the top chrome and bottom dock
       shift the vertical aim. */
    const immersive = isImmersiveWorld(state);
    if (focusPlace === 'campus' && immersive) {
      const dock = dockReserved();
      const phone = view.stageWidth <= 860;
      const bandTop = view.stageHeight * (phone ? 0.11 : 0.07);
      const dockClearance = phone ? 20 : 48;
      const bandBottom = dock ? dock.top - dockClearance : view.stageHeight * 0.84;
      const bandHeight = Math.max(bandBottom - bandTop, 120);
      /*
       * Larger `bandCentre` raises the island on screen — `readingShot` shifts
       * the look-at opposite to the requested pixel, so shrinking this value
       * (as in earlier attempts) pushed the campus toward the dock.
       */
      const bandCentre = phone ? 0.44 : 0.42;
      subject = {
        x: view.stageWidth * 0.5,
        y: bandTop + bandHeight * bandCentre,
      };
      return readingShot(overview, view, subject);
    }
    /*
     * A destination is framed close, from its own composed shot. The reach is
     * lengthened when the visible region is a short band — a phone with a
     * document open — so the whole building stays in the strip.
     */
    const band = !immersive && freeHeight < view.stageHeight * 0.5;
    const node = world.places.get(focusPlace);
    if (!node) return readingShot(overview, view, subject);
    if (focusPlace === 'workbench' && immersive) {
      const dock = dockReserved();
      const topInset = view.stageHeight * 0.07;
      const bottomInset = dock ? dock.top - 28 : view.stageHeight * 0.84;
      const bandHeight = Math.max(bottomInset - topInset, 120);
      subject = {
        x: view.stageWidth * 0.5,
        y: topInset + bandHeight * 0.4,
      };
    }
    const reach =
      focusPlace === 'workbench' && immersive ? 1.22 : band ? 1.45 : 1;
    const base = placeShot(node.shot, aspect, reach);
    return readingShot(base, view, subject);
  }

  function compose(immediate: boolean): void {
    rig.goTo(shotFor(), { immediate: immediate || reducedMotion });
  }

  /* ── Chrome sync ─────────────────────────────────────────────────── */

  function syncChromeLocation(): void {
    for (const link of document.querySelectorAll<HTMLElement>('[data-world-dest]')) {
      const id = link.dataset.worldDest;
      const active =
        id === state.destination ||
        (id === 'studio' && state.destination === 'studio' && state.surface === 'cv');
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    for (const button of document.querySelectorAll<HTMLElement>('[data-world-dock]')) {
      const id = button.dataset.worldDock;
      const active =
        id === focusPlace ||
        (id === 'campus' && focusPlace === 'campus' && state.surface === 'none');
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
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
    /*
     * The document element's copy of the world's state is re-asserted here,
     * after every swap. The router brings the incoming page's attributes with
     * it and a page has no state of its own, so the copy can otherwise be
     * wiped by the first client-side navigation and take the controls with it.
     */
    mirrorWorldState(root.dataset.worldState ?? 'ready');

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
    /* Same as a travel: an immediate cut needs the new view's occlusion before
       its captions are placed, or they appear and then vanish. */
    castOcclusion();
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
    };

    const onPointerMove = (event: PointerEvent) => {
      /*
       * Over the sun or moon, the cursor says it can be pressed: the body is
       * the control, and nothing else in the sky is clickable.
       */
      if (!pointers.has(event.pointerId) && event.pointerType === 'mouse') {
        canvasEl.style.cursor = pickCelestialAt(event.clientX, event.clientY) ? 'pointer' : '';
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

  function pointerNdc(x: number, y: number): { ndcX: number; ndcY: number; rect: DOMRect } | null {
    const rect = canvasEl.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      ndcX: ((x - rect.left) / rect.width) * 2 - 1,
      ndcY: -((y - rect.top) / rect.height) * 2 + 1,
      rect,
    };
  }

  /**
   * The sun or moon under a screen point. Raycast first, then a generous
   * screen-radius fallback so the bodies stay easy to press.
   */
  function pickCelestialAt(x: number, y: number): 'sun' | 'moon' | null {
    if (focusPlace !== 'campus' || !atmosphere.celestialDiagnostics().enabled) return null;
    const pointer = pointerNdc(x, y);
    if (!pointer) return null;
    refreshCamera();
    atmosphere.follow(rig.camera, rig.focus);
    const hit = atmosphere.probeBody(pointer.ndcX, pointer.ndcY, rig.camera);
    if (hit) return hit;
    const height = pointer.rect.height;
    const diag = atmosphere.celestialDiagnostics();
    const kinds: ('sun' | 'moon')[] =
      diag.moonVisible && !diag.sunVisible
        ? ['moon', 'sun']
        : diag.sunVisible && !diag.moonVisible
          ? ['sun', 'moon']
          : ['sun', 'moon'];
    for (const kind of kinds) {
      const ndc = atmosphere.projectBody(kind, rig.camera);
      if (!ndc) continue;
      const screenX = pointer.rect.left + (ndc.x * 0.5 + 0.5) * pointer.rect.width;
      const screenY = pointer.rect.top + (-ndc.y * 0.5 + 0.5) * pointer.rect.height;
      const reach = Math.max(
        CELESTIAL_TAP_RADIUS,
        atmosphere.celestialBodyRadius(kind, rig.camera) * height,
      );
      if (Math.hypot(x - screenX, y - screenY) <= reach) return kind;
    }
    return null;
  }

  function applyCelestialLighting(_kind: 'sun' | 'moon'): void {
    const next: ThemeName = currentTheme() === 'light' ? 'dark' : 'light';
    setTheme(next, { animate: true, persist: true, source: 'visitor' });
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

    /*
     * The sky body, resolved by casting a ray at the sprites themselves.
     *
     * The obvious way is to project the body to a screen point and compare that
     * with the tap, which is what this used to do — and it does not survive a
     * moving camera. The campus turns itself on arrival, so between the frame the
     * visitor aimed at and the frame their finger came down on, the sun has slid
     * across the sky; measured, the tap landed forty-two pixels from where the
     * handler thought the body was, against a thirty-four pixel target. The thing
     * the visitor pressed was where the moon was *drawn*, and only a raycast
     * against the drawn sprites answers that.
     */
    const celestial = pickCelestialAt(x, y);
    if (celestial) {
      applyCelestialLighting(celestial);
      return;
    }

    if (rayAt(x, y, world.switchTargets())) {
      toggleTheme({ animate: true });
      return;
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
    /* The island goes back to the bearing it was composed at as well: the turn
       is the world's now, not the camera's, so a reset has to undo both. */
    world.setTurn(0);
    rig.setSolids(world.turnedSolids());
    compose(true);
    renderOnce();
  };
  document.addEventListener(RESET_VIEW_EVENT, onResetView);
  cleanups.push(() => document.removeEventListener(RESET_VIEW_EVENT, onResetView));

  const onTravel = (event: Event) => {
    if (disposed) return;
    const detail = (event as CustomEvent<TravelDetail>).detail;
    if (!detail?.destination) return;
    const destination = detail.destination;
    travelTo(destination);
    /*
     * Dock travel also opens the place's page when it is not already showing,
     * so Contact (and the other destinations) are readable without a second
     * hunt for a hatch or caption.
     */
    if (destination === 'campus') return;
    const target = destinationMeta(destination).href;
    const here = typeof location === 'undefined' ? '/' : location.pathname;
    const normalizedHere = here.endsWith('/') ? here : `${here}/`;
    const normalizedTarget = target.endsWith('/') ? target : `${target}/`;
    if (normalizedHere !== normalizedTarget) void navigate(target);
  };
  document.addEventListener(TRAVEL_EVENT, onTravel);
  cleanups.push(() => document.removeEventListener(TRAVEL_EVENT, onTravel));

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
     *
     * The turn is applied to the *island*, not to the camera. Orbiting the camera
     * achieved the same thing on screen and had one consequence that made the
     * whole sky feel wrong: the camera swung through the sky, so the sun slid
     * out towards the edge of the frame while the island sat still — a turning
     * world seen from a moving seat rather than a world turning in place. With
     * the island doing the turning, the camera holds its bearing, the horizon
     * stays put, and the sun stays where it was put.
     */
    const idling = performance.now() - lastInteraction > AUTO_TURN_RESUME_MS;
    const turning = animate && autoTurnAllowed && idling;
    world.setTurn(turning ? world.turn + AUTO_TURN_RATE * realDelta : world.turn);
    /* The camera's clearance volumes go round with the buildings, so a swung
       camera is still kept out of the walls it can see. */
    rig.setSolids(world.turnedSolids());

    rig.update(delta, realDelta);
    world.update(clock, step);
    /* The day/night blend runs on real time, so it finishes while reading. */
    advanceTheme(delta);

    /*
     * The sky. Re-read on the minute, and applied at once — see `applySkyState`
     * for why this does not go through the page-theme blend.
     *
     * The image-based probe is the one part of this that is too expensive to
     * refresh on every change: it is a cube render plus a prefilter. It is
     * therefore refreshed on its own much slower clock, which is invisible
     * because the probe only carries the *ambient* colour and that changes far
     * more slowly than the sun's position does.
     */
    skyEnvClock += realDelta;
    const next = skyClock.poll();
    if (next) {
      const environment = skyEnvClock >= 240;
      skyEnvClock = 0;
      applySkyState(next, environment);
    }

    atmosphere.follow(rig.camera, rig.focus);
    renderer.render(scene, rig.camera);
    scene.updateMatrixWorld(true);

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
    setWorldState(root, 'error');
    failStartup(
      'The graphics context was lost — this usually happens when the device reclaims GPU memory. It will recover on its own if the browser restores it, or you can try again.',
    );
  };
  const onContextRestored = () => {
    if (disposed) return;
    contextLost = false;
    setWorldState(root, 'ready');
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
  /**
   * Bring the camera's own matrices up to date.
   *
   * The renderer is what normally does this, so a question asked between frames
   * is otherwise answered against the previous pose — and, worse, against a
   * projection matrix from before the last resize. That matters because every
   * sky diagnostic projects a world direction through the camera: a stale
   * projection answers with a scale that is simply wrong, which is exactly the
   * kind of wrong that looks like a bug in the astronomy.
   */
  function refreshCamera(): void {
    rig.camera.updateMatrix();
    rig.camera.updateMatrixWorld();
    rig.camera.updateProjectionMatrix();
  }

  /**
   * Where the sky body that is up can be pressed, in CSS pixels of the stage, or
   * null when there is nothing to press.
   *
   * One function, used by the tap handler, the hover cursor and the diagnostics,
   * because getting this wrong is invisible in every one of them separately. Two
   * things had to be right and both were wrong when it was written out by hand at
   * each call site:
   *
   *  - The camera's own matrices have to be refreshed first. The renderer is what
   *    normally updates them, so a projection taken between frames used the
   *    previous pose — and the pose is precisely what a visitor has just changed
   *    by dragging, which is exactly when they go to press the sun. The disc was
   *    drawn in one place and tested for in another.
   *  - A point behind the camera still projects to a plausible x and y, because
   *    the perspective divide flips it through the origin. `projectBody` handles
   *    that with a view-space depth test; `z < 1` does not, and would have made a
   *    body at the camera's back pressable.
   */
  function celestialTarget(): { x: number; y: number; reach: number; kind: 'sun' | 'moon' } | null {
    const kind = atmosphere.celestialKind();
    if (!kind) return null;
    refreshCamera();
    const ndc = atmosphere.projectBody(kind, rig.camera);
    if (!ndc) return null;
    const width = stageEl.clientWidth;
    const height = stageEl.clientHeight;
    /* The body is large, so its own on-screen size sets the target. */
    const reach = Math.max(
      CELESTIAL_TAP_RADIUS,
      atmosphere.activeCelestialRadius(rig.camera) * height,
    );
    return {
      x: (ndc.x * 0.5 + 0.5) * width,
      y: (-ndc.y * 0.5 + 0.5) * height,
      reach,
      kind,
    };
  }

  /* A small, read-only view of the live world. It exists for verification and
   * for support ("where is the camera?"), and it never mutates anything. */
  (window as unknown as { __worldDebug?: () => unknown }).__worldDebug = () => {
    const celestial = atmosphere.activeCelestialPosition();
    const kind = atmosphere.celestialKind();
    const ndc = celestial && kind ? atmosphere.projectBody(kind, rig.camera) : null;
    const width = stageEl.clientWidth;
    const height = stageEl.clientHeight;
    const toScreen = (point: { x: number; y: number } | null) =>
      point
        ? {
            x: (point.x * 0.5 + 0.5) * width,
            y: (-point.y * 0.5 + 0.5) * height,
            onScreen: Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1,
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
      /**
       * How far the island has turned. The turn belongs to the world now — the
       * camera holds its bearing so the sky does not slide past — so this is the
       * number a check about "is the campus turning?" has to read.
       */
      islandTurn: Number(world.turn.toFixed(4)),      /**
       * Where the camera is actually pointing.
       *
       * Both matrices are brought up to date first. `refreshCamera` is the same
       * call the sky probes make, and it exists because the renderer is what
       * normally updates them: a question asked between frames would otherwise
       * be answered against the previous pose, or against a projection matrix
       * from before the last resize.
       */
      rotation: (() => {
        refreshCamera();
        const forward = rig.camera.getWorldDirection(new THREE.Vector3());
        const bearing = ((Math.atan2(forward.x, -forward.z) * 180) / Math.PI + 360) % 360;
        return {
          bearing: Math.round(bearing),
          pitch: Math.round((Math.asin(THREE.MathUtils.clamp(forward.y, -1, 1)) * 180) / Math.PI),
          fov: rig.camera.fov,
          aspect: Number(rig.camera.aspect.toFixed(3)),
          distance: Number(rig.camera.position.distanceTo(rig.focus).toFixed(2)),
        };
      })(),
      /** The solid volumes the camera's clearance rule tests against. */
      solids: world.cameraSolids().map((solid) => ({ ...solid })),
      /** The campus lamps: posts, pools, glows and how many are really lit. */
      lamps: world.lampDiagnostics(),
      skyFauna: world.skyFaunaDiagnostics(),
      /** The moon's sprite and the star field, read back from the live objects. */
      skyCraft: atmosphere.craftDiagnostics(),
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
      celestial: toScreen(ndc),
      celestialRadius: atmosphere.activeCelestialRadius(rig.camera) * height,
      /** Why the body may be missing: it is only ever a blend or a distance. */
      celestialHidden: atmosphere.celestialDiagnostics(),
      /**
       * The sky, as the world currently believes it to be.
       *
       * Everything here is read from the same `SkyState` the light and the sky
       * dome were built from, so a verification run can assert against the
       * world's own reading rather than against a second calculation that might
       * disagree with it.
       */
      sky: {
        label: skyState.label,
        hours: skyState.hours,
        overridden: skyState.overridden,
        sunAltitude: skyState.sun.altitude,
        sunAzimuth: skyState.sun.azimuth,
        moonAltitude: skyState.moon.altitude,
        moonAzimuth: skyState.moon.azimuth,
        moonIllumination: skyState.moon.illumination,
        moonElongation: skyState.moon.elongation,
        moonPhase: phaseName(skyState.moon.elongation),
        dayness: skyState.dayness,
        twilight: skyState.twilight,
        golden: skyState.golden,
        blueHour: skyState.blueHour,
        exposure: liveTheme.exposure,
        fogDensity: liveTheme.fogDensity,
        keyDirection: {
          x: atmosphere.keyDirectionX,
          y: atmosphere.keyDirectionY,
          z: atmosphere.keyDirectionZ,
        },
        /**
         * The sun's own direction, unclamped.
         *
         * The key light's elevation is clamped to keep its shadows sane, so it
         * is not a report of where the sun is; this is.
         */
        sunDirectionY: atmosphere.sunDirectionY,
        siderealAngle,
      },
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

  /**
   * Turn the camera to look at a point in the sky.
   *
   * This is the world's public "look there" control, and the sky suite needs it
   * for a reason that is worth stating: a body can be in the *sky* and outside
   * the *frame*, and those are different claims. The overview camera faces
   * south-east, so a noon sun due south and forty-six degrees up is simply not
   * in shot — correctly. Rather than weaken the verification to "the numbers are
   * right", the suite can point the camera at the body and check that the disc
   * lands exactly where the bearing says it should, which is the claim that
   * matters to a visitor: the thing you can see is the thing you can press.
   *
   * `bearing` is compass degrees and `altitude` is degrees above the horizon,
   * both the same convention `__worldDebug().sky` reports.
   */
  (window as unknown as {
    __worldLookAt?: (bearing: number, altitude: number) => unknown;
  }).__worldLookAt = (bearing: number, altitude: number) => {
    if (disposed) return null;
    refreshCamera();
    const forward = rig.camera.getWorldDirection(new THREE.Vector3());
    const currentBearing = ((Math.atan2(forward.x, -forward.z) * 180) / Math.PI + 360) % 360;
    /* Signed shortest turn from where the camera looks to where the body is. */
    let turnDegrees = ((bearing - currentBearing + 540) % 360) - 180;
    /*
     * The rig swings by moving its offset *around* the subject, so turning the
     * view right means turning the offset left — hence the sign. Six degrees of
     * vertical swing per ten of horizontal is the rig's own ratio, converted
     * here rather than passed through as pixels.
     */
    turnDegrees = THREE.MathUtils.clamp(turnDegrees, -105, 105);
    /*
     * Asked for as a *change* to the look-around, not as an absolute orbit, so
     * the turn is measured from where the camera actually is — which is what
     * makes this usable on a view the visitor has already dragged.
     *
     * The two signs are not the same, and both were derived from the rig's own
     * arithmetic rather than guessed. Turning the view clockwise means turning
     * the offset anticlockwise, so the azimuth delta is the negative of the
     * turn. Vertically it is the *positive*: the rig measures its polar angle
     * from straight up, and it adds that to the camera's own offset, so a larger
     * polar angle lifts the camera and tips the view down toward the subject —
     * which is to say that looking *up* at a body takes a positive delta.
     */
    const azimuthDelta = -(turnDegrees * (Math.PI / 180));
    /*
     * A few degrees of overshoot, so the body ends up near the top of the frame
     * rather than exactly on its edge. The rig's vertical swing is bounded — it
     * is a look-around, not a neck brace — so a body that is barely inside the
     * frame is one a viewer would describe as outside it.
     *
     * Note that the swing is also *clamped* at the top by the rig, at about
     * twenty-five degrees above the composed aim. A body higher than that cannot
     * be brought into the centre of the frame by turning, which is honest: the
     * visitor's own look-around is limited in exactly the same way.
     */
    const polarDelta = (altitude + 4) * (Math.PI / 180);
    const current = rig.orbitState;
    rig.setOrbitState({
      azimuth: current.azimuth + azimuthDelta,
      polar: current.polar + polarDelta,
    });
    if (!running) renderOnce();
    refreshCamera();
    const rotated = rig.camera.getWorldDirection(new THREE.Vector3());
    return {
      bearing: Number((((Math.atan2(rotated.x, -rotated.z) * 180) / Math.PI + 360) % 360).toFixed(1)),
      pitch: Number(((Math.asin(THREE.MathUtils.clamp(rotated.y, -1, 1)) * 180) / Math.PI).toFixed(1)),
      requested: { bearing, altitude },
    };
  };

  /* The same resolution a tap uses, exposed for diagnostics. */
  (window as unknown as { __worldSky?: () => unknown }).__worldSky = () =>
    atmosphere.skyDiagnostics();

  /**
   * What is in the sky at a given compass bearing and altitude.
   *
   * The verification suite's question — "is the sun where the astronomy says it
   * is?" — cannot be answered from a screenshot, because a sun in the wrong half
   * of the sky still looks like a sun. This resolves the bearing against the
   * scene itself and reports which body is there, so the answer is a fact about
   * the built world rather than about a picture of it.
   *
   * `bearing` is degrees from north, clockwise; `altitude` is degrees above the
   * horizon. Both are the same convention `__worldDebug().sky` reports.
   */
  (window as unknown as {
    __worldSkyAt?: (bearing: number, altitude: number) => unknown;
  }).__worldSkyAt = (bearing: number, altitude: number) => {
    if (disposed) return null;
    refreshCamera();
    /*
     * A bearing and an altitude, as a direction. The same convention the sky
     * itself uses: north is `-Z`, and a bearing increases toward the east.
     */
    const alt = (altitude * Math.PI) / 180;
    const az = (bearing * Math.PI) / 180;
    const direction = new THREE.Vector3(
      Math.cos(alt) * Math.sin(az),
      Math.sin(alt),
      -Math.cos(alt) * Math.cos(az),
    );
    const point = rig.camera.position.clone().addScaledVector(direction, 380);
    /*
     * Whether the point is in front of the camera, tested on the view-space
     * depth. A point behind the camera still projects to a plausible x and y —
     * the perspective divide flips it through the origin — so testing the
     * normalized depth is how a body at the camera's back gets reported as on
     * screen.
     *
     * The matrix is refreshed first: the renderer is what normally updates it,
     * so between frames the camera's pose would otherwise be one frame stale.
     */
    rig.camera.updateMatrixWorld();
    const forward = rig.camera.getWorldDirection(new THREE.Vector3());
    const inFront = direction.dot(forward) > 0.01;
    const ndc = point.project(rig.camera);
    const onScreen = inFront && Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1;
    return {
      bearing,
      altitude,
      onScreen,
      ndc: { x: ndc.x, y: ndc.y, z: ndc.z },
      camera: {
        position: rig.camera.position.toArray().map((n) => Number(n.toFixed(2))),
        forward: forward.toArray().map((n) => Number(n.toFixed(3))),
        direction: direction.toArray().map((n) => Number(n.toFixed(3))),
        dot: direction.dot(forward),
      },
      // Where that bearing lands on the frame, in CSS pixels.
      screen: {
        x: (ndc.x * 0.5 + 0.5) * stageEl.clientWidth,
        y: (-ndc.y * 0.5 + 0.5) * stageEl.clientHeight,
      },
      // And which body the scene actually has there.
      body: onScreen ? atmosphere.probeBody(ndc.x, ndc.y, rig.camera) : null,
      sunAltitude: skyState.sun.altitude,
      sunAzimuth: skyState.sun.azimuth,
      moonAltitude: skyState.moon.altitude,
      moonAzimuth: skyState.moon.azimuth,
    };
  };

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
    world.setTurn(0);
    rig.setSolids(world.turnedSolids());
    lastInteraction = performance.now();
    compose(true);
    renderOnce();
  };

  /**
   * Set the world's hour, or hand it back to the clock.
   *
   * `__worldSkyTime(18.5)` pins the sky to half past six in the evening;
   * `__worldSkyTime(null)` releases it. Everything downstream — the sun's and
   * the moon's positions, the palette, the exposure, the fog, the key light's
   * direction, the stars — follows from the `SkyState` this produces, so a
   * harness that sets the hour has set the whole sky rather than one part of it.
   *
   * The date is never replaced: only the hour moves, so the season stays real.
   */
  (window as unknown as { __worldSkyTime?: (hour: number | null) => unknown }).__worldSkyTime = (
    hour: number | null,
  ) => {
    if (disposed) return null;
    const next = setSkyTime(hour === null || !Number.isFinite(hour) ? null : hour);
    return { label: next.label, overridden: next.overridden, dayness: next.dayness };
  };

  /**
   * Move the world's *date*, keeping the hour.
   *
   * The moon's phase is a property of the day and not of the hour, so this is
   * the only lever that can answer "does the phase really change?" — and it is
   * the reason the override carries a date at all. Nothing in the visitor's own
   * interface moves the date: the world is always today.
   */
  (window as unknown as { __worldSkyDay?: (dayOffset: number) => unknown }).__worldSkyDay = (
    dayOffset: number,
  ) => {
    if (disposed) return null;
    const when = new Date();
    when.setDate(when.getDate() + Math.round(dayOffset));
    const hour = skyClock.pinned?.hour ?? skyState.hours;
    const next = setSkyTime(hour, when);
    return {
      label: next.label,
      phase: phaseName(next.moon.elongation),
      elongation: next.moon.elongation,
      illumination: next.moon.illumination,
    };
  };

  /*
   * A time in the URL, for photography and for sharing a particular light.
   *
   * `?sky=18.5` opens the world at half past six in the evening, and
   * `?sky=now` is the clock. Deep-linking a *look* is the point: a sunset this
   * specific is not something a visitor can otherwise ask for, and a link that
   * reproduces one exactly is worth more than a slider.
   */
  if (typeof location !== 'undefined') {
    const requested = new URLSearchParams(location.search).get('sky');
    if (requested && requested !== 'now') {
      const hour = Number(requested);
      if (Number.isFinite(hour)) setSkyTime(((hour % 24) + 24) % 24);
    }
  }

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

  setWorldState(root, 'ready');
  /*
   * The one thing that can honestly take the rule to 100%: the scene is built,
   * the first frame is about to be drawn and the canvas is about to cross-fade
   * in. Everything before this was a milestone on the way here.
   */
  reportProgress(100);
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

  resize();
  wireInteraction();
  applyState();
  /* Publish the clock before the first frame, so the dial opens on the right
     hour rather than on whatever the markup was authored with. */
  publishSkyState();
  renderOnce();
  syncLoop();

  const handle: ShellHandle = {
    applyState,
    setSkyTime(hour: number | null) {
      if (disposed) return;
      setSkyTime(hour);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      running = false;
      window.cancelAnimationFrame(frameHandle);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      stopThemes();
      stopAmbient();
      stopSkyTime();
      textures?.dispose();
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
 * Set the world's state in the two places that need it: the element that owns
 * it, and the document — so the interface around the world, including the
 * loading experience, can be styled from one attribute.
 */
function setWorldState(root: HTMLElement, state: string): void {
  root.dataset.worldState = state;
  mirrorWorldState(state);
}

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
    setWorldState(root, 'degraded');
    hideWorldAlert();
    return;
  }

  const existing = root[MOUNT_KEY];
  if (existing && !existing.lost) {
    setWorldState(root, 'ready');
    reportProgress(100);
    existing.handle.applyState();
    return;
  }
  if (existing) {
    existing.handle.dispose();
    delete root[MOUNT_KEY];
  }

  if (!webglAvailable()) {
    setWorldState(root, 'error');
    failStartup(
      'This browser cannot create a WebGL context, which the interactive world needs.',
    );
    return;
  }

  setWorldState(root, 'loading');
  try {
    const handle = mountShell(root);
    root[MOUNT_KEY] = { handle, lost: false };
    hideWorldAlert();
  } catch (error) {
    setWorldState(root, 'error');
    const message = error instanceof Error ? error.message : String(error);
    failStartup(`The renderer could not start (${message}).`);
  }
}

export { webglAvailable as supportsWebgl };
