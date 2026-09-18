/**
 * Observatory controller.
 *
 * Owns the scene lifecycle and nothing else: renderer, loop, quality,
 * theme, interaction, hotspot projection and teardown. Geometry lives in
 * `world.ts`, lighting in `lighting.ts`, camera travel in `camera.ts`.
 *
 * The DOM is the contract. Everything the controller needs is discovered
 * from `data-obs-*` hooks, so the Astro component owns all markup and all
 * copy, and this module can be dropped into another page unchanged.
 */

import * as THREE from 'three';
import type { StationId } from '../../site.config';
import { CameraRig } from './camera';
import { Atmosphere } from './lighting';
import { Materials } from './materials';
import {
  PerformanceMonitor,
  clearPreference,
  detectTier,
  isQualityTier,
  loadPreference,
  nextDown,
  nextUp,
  savePreference,
  settingsFor,
  type QualitySettings,
  type QualityTier,
} from './quality';
import { currentThemeName, prefersReducedMotion, readWorldTheme, watchTheme } from './theme';
import { ObservatoryWorld, fitDistance, type Shot } from './world';

export interface ObservatoryHandle {
  dispose(): void;
}

/* ── Capability checks ───────────────────────────────────────────────── */

export function webglAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    const context =
      canvas.getContext('webgl2') ??
      canvas.getContext('webgl') ??
      canvas.getContext('experimental-webgl');
    if (!context) return false;
    /* Release the probe context immediately. */
    const lose = (context as WebGLRenderingContext).getExtension('WEBGL_lose_context');
    lose?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/* ── Composed viewpoints ─────────────────────────────────────────────── */

/**
 * The resting composition.
 *
 * A longer lens (32°) and a radius that deliberately crops the far rim give
 * the diorama its miniature feel: the island fills the frame, the central
 * instrument dominates, and there is just enough sky to breathe. Portrait
 * screens reframe from a higher angle rather than shrinking the desktop shot.
 */
function homeShot(aspect: number): Shot {
  const portrait = aspect < 1.15;
  const radius = portrait ? 10.6 : 11.4;
  const fov = portrait ? 44 : 34;
  const distance = fitDistance(radius, fov, aspect);
  /* A low, slightly elevated three-quarter view: high enough to read the
     plan of the island, low enough to keep the cliff and the mist beneath
     it in shot — which is what makes it read as *suspended*. */
  const direction = portrait
    ? new THREE.Vector3(0.44, 0.5, 0.64).normalize()
    : new THREE.Vector3(0.6, 0.34, 0.68).normalize();
  const target = new THREE.Vector3(0, portrait ? 2.2 : 2.9, 0);
  return {
    position: target.clone().addScaledVector(direction, distance),
    target,
    fov,
  };
}

/** The shot the camera settles from, so the world arrives rather than cuts. */
function approachShot(aspect: number): Shot {
  const home = homeShot(aspect);
  const target = home.target.clone();
  const offset = home.position.clone().sub(target).multiplyScalar(1.24);
  return {
    position: target.clone().add(offset).add(new THREE.Vector3(0, 3.4, 0)),
    target,
    fov: home.fov + 4,
  };
}

/** Station shots widened for narrow screens so nothing is cropped off. */
function stationShot(shot: Shot, aspect: number): Shot {
  const scale = THREE.MathUtils.clamp(1.28 / Math.max(aspect, 0.4), 1, 1.75);
  const target = shot.target.clone();
  return {
    position: target.clone().add(shot.position.clone().sub(target).multiplyScalar(scale)),
    target,
    fov: shot.fov,
  };
}

/* ── Mount ───────────────────────────────────────────────────────────── */

const DISCOVERY_KEY = 'observatory:discoveries';

export function mountObservatory(root: HTMLElement): ObservatoryHandle {
  const stage = root.querySelector<HTMLElement>('[data-obs-stage]');
  const canvas = root.querySelector<HTMLCanvasElement>('[data-obs-canvas]');
  const hotspotLayer = root.querySelector<HTMLElement>('[data-obs-hotspots]');
  const status = root.querySelector<HTMLElement>('[data-obs-status]');
  const qualitySelect = root.querySelector<HTMLSelectElement>('[data-obs-quality]');
  const discoveryNote = root.querySelector<HTMLElement>('[data-obs-discoveries]');

  if (!stage || !canvas || !hotspotLayer) {
    return { dispose() {} };
  }

  /* ── Fallback path ─────────────────────────────────────────────────── */
  if (!webglAvailable()) {
    /* No WebGL at all: this browser will never run the world, so show the
       simple view and do not offer a retry that cannot succeed. */
    failToSimpleView(root, status, status?.dataset.messageError, false);
    return { dispose() {} };
  }

  const reducedMotion = prefersReducedMotion();
  const storedPreference = loadPreference();
  let tier: QualityTier = storedPreference ?? detectTier();
  let ambient = !reducedMotion;
  let settings: QualitySettings = settingsFor(tier, ambient);
  let theme = readWorldTheme(currentThemeName());

  /* ── Renderer ──────────────────────────────────────────────────────── */
  const renderer = new THREE.WebGLRenderer({
    canvas,
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

  const world = new ObservatoryWorld(theme, settings, materials, atmosphere);
  scene.add(world.group);

  const rig = new CameraRig(1, homeShot(1), reducedMotion);

  /* ── DOM wiring ────────────────────────────────────────────────────── */
  const hotspotButtons = new Map<StationId, HTMLButtonElement>();
  hotspotLayer.querySelectorAll<HTMLButtonElement>('[data-obs-hotspot]').forEach((button) => {
    const id = button.dataset.obsHotspot as StationId | undefined;
    if (id) hotspotButtons.set(id, button);
  });

  const menuItems = new Map<StationId, HTMLButtonElement>();
  root.querySelectorAll<HTMLButtonElement>('[data-obs-menu-item]').forEach((button) => {
    const id = button.dataset.obsMenuItem as StationId | undefined;
    if (id) menuItems.set(id, button);
  });

  const panels = new Map<string, HTMLElement>();
  root.querySelectorAll<HTMLElement>('[data-obs-panel]').forEach((panel) => {
    const key = panel.dataset.obsPanel;
    if (key) panels.set(key, panel);
  });

  const exploreButtons = root.querySelectorAll<HTMLButtonElement>('[data-obs-explore]');
  const exitButtons = root.querySelectorAll<HTMLButtonElement>('[data-obs-exit]');
  const resetButtons = root.querySelectorAll<HTMLButtonElement>('[data-obs-reset]');
  const pauseButtons = root.querySelectorAll<HTMLButtonElement>('[data-obs-pause]');
  const simpleButtons = root.querySelectorAll<HTMLButtonElement>('[data-obs-simple-toggle]');
  const worldButtons = root.querySelectorAll<HTMLButtonElement>('[data-obs-world-toggle]');
  const controls = root.querySelector<HTMLElement>('[data-obs-controls]');
  const simpleView = root.querySelector<HTMLElement>('[data-obs-simple-view]');
  const hint = root.querySelector<HTMLElement>('[data-obs-hint]');

  /* ── State ─────────────────────────────────────────────────────────── */
  let exploring = false;
  let selected: StationId | null = null;
  let disposed = false;
  /** The control to return focus to when a preview panel closes. */
  let pendingReturnFocus: HTMLElement | null = null;
  let labelLimit = 6;

  const discovered = new Set<StationId>(readDiscoveries());
  world.applyDiscoveries([...discovered]);
  updateDiscoveryNote();

  /* ── Resize ────────────────────────────────────────────────────────── */
  let homeEstablished = false;
  let labelWidths = new Map<StationId, number>();
  const labelHeight = 44;

  function measureLabels(): void {
    labelWidths = new Map();
    for (const [id, button] of hotspotButtons) {
      labelWidths.set(id, button.offsetWidth || 120);
    }
  }

  function resize(): void {
    const width = Math.max(1, Math.round(stage!.clientWidth));
    const height = Math.max(1, Math.round(stage!.clientHeight));
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, settings.maxDpr));
    renderer.setSize(width, height, false);
    const aspect = width / height;
    rig.setAspect(aspect);
    const home = homeShot(aspect);
    if (!homeEstablished) {
      homeEstablished = true;
      rig.goTo(approachShot(aspect), { immediate: true });
      /* One restrained settle, then the composition is at rest for good. */
      window.requestAnimationFrame(() => {
        if (!disposed) rig.goTo(home, { immediate: reducedMotion });
      });
    } else if (!selected) {
      rig.goTo(home, { immediate: reducedMotion });
    }
    measureLabels();
  }

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(stage);
  resize();

  /* ── Visibility: never render what nobody can see ──────────────────── */
  let onScreen = true;
  const intersectionObserver = new IntersectionObserver(
    (entries) => {
      onScreen = entries.some((entry) => entry.isIntersecting);
      syncLoop();
    },
    { rootMargin: '120px' },
  );
  intersectionObserver.observe(stage);

  /* ── Quality ───────────────────────────────────────────────────────── */
  function applyQuality(next: QualityTier, persist: boolean): void {
    tier = next;
    settings = settingsFor(next, ambient);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, settings.maxDpr));
    renderer.shadowMap.enabled = settings.shadows;
    materials.setQuality(settings);
    atmosphere.setQuality(settings);
    world.setQuality(settings);
    labelLimit = labelLimitFor(next);
    if (persist) savePreference(next);
    if (qualitySelect) qualitySelect.value = persist ? next : 'auto';
  }

  const monitor = new PerformanceMonitor((action) => {
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

  /* ── Theme ─────────────────────────────────────────────────────────── */
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

  /* ── Hotspot projection ────────────────────────────────────────────── */
  function labelLimitFor(value: QualityTier): number {
    const width = window.innerWidth;
    const base = width < 560 ? 3 : width < 900 ? 4 : 6;
    return value === 'low' ? Math.min(base, 4) : base;
  }

  const raycaster = new THREE.Raycaster();
  const occluded = new Map<StationId, boolean>();
  const occluders: THREE.Object3D[] = [];
  let occlusionClock = 0;

  const projected = new THREE.Vector3();
  interface Placed {
    x: number;
    y: number;
    width: number;
    height: number;
  }

  function updateOcclusion(delta: number): void {
    occlusionClock -= delta;
    if (occlusionClock > 0) return;
    occlusionClock = 0.14;
    occluders.length = 0;
    occluders.push(...world.occluders());
    const origin = rig.camera.position;
    for (const node of world.stations.values()) {
      const direction = node.anchor.clone().sub(origin);
      const distance = direction.length();
      direction.normalize();
      raycaster.set(origin, direction);
      raycaster.far = Math.max(0.1, distance - 0.8);
      const hits = raycaster.intersectObjects(occluders, false);
      /* A station never occludes itself. */
      occluded.set(node.id, hits.some((hit) => hit.object !== node.pick));
    }
  }

  function projectHotspots(): void {
    const width = stage!.clientWidth;
    const height = stage!.clientHeight;
    const focused = document.activeElement as HTMLElement | null;

    interface Candidate {
      id: StationId;
      button: HTMLButtonElement;
      x: number;
      y: number;
      width: number;
      height: number;
      priority: number;
      occluded: boolean;
      visible: boolean;
    }

    const candidates: Candidate[] = [];
    for (const [id, button] of hotspotButtons) {
      const node = world.stations.get(id);
      if (!node) continue;
      projected.copy(node.anchor).project(rig.camera);
      const x = (projected.x * 0.5 + 0.5) * width;
      const y = (-projected.y * 0.5 + 0.5) * height;
      const isFocused = focused === button;
      const isOccluded = occluded.get(id) === true && !isFocused;
      const offscreen =
        projected.z > 1 || x < -40 || x > width + 40 || y < -20 || y > height + 20;
      const labelW = labelWidths.get(id) ?? 130;
      const anchorWorld = node.anchor.clone();
      const distance = rig.camera.position.distanceTo(anchorWorld);
      candidates.push({
        id,
        button,
        x,
        y,
        width: labelW,
        height: labelHeight,
        priority:
          (id === selected ? 100 : 0) +
          (node.hover > 0.5 ? 50 : 0) +
          (isFocused ? 200 : 0) +
          Math.max(0, 40 - distance),
        occluded: isOccluded,
        visible: !isOccluded && !offscreen,
      });
    }

    const placed: Placed[] = [];
    candidates.sort((a, b) => b.priority - a.priority);

    for (const candidate of candidates) {
      let show = candidate.visible;
      if (show) {
        const isFocused = focused === candidate.button;
        const box: Placed = {
          x: candidate.x - candidate.width / 2,
          y: candidate.y - candidate.height / 2,
          width: candidate.width,
          height: candidate.height,
        };
        const overlaps = placed.some(
          (other) =>
            box.x < other.x + other.width &&
            box.x + box.width > other.x &&
            box.y < other.y + other.height &&
            box.y + box.height > other.y,
        );
        if (!isFocused && (overlaps || placed.length >= labelLimit)) show = false;
        else placed.push(box);
      }

      if (show) {
        candidate.button.dataset.visible = 'true';
        candidate.button.dataset.dim = candidate.occluded ? 'true' : 'false';
        candidate.button.style.transform = `translate3d(${candidate.x}px, ${candidate.y}px, 0) translate(-50%, -50%)`;
        candidate.button.setAttribute('aria-hidden', 'false');
        candidate.button.tabIndex = 0;
      } else {
        candidate.button.dataset.visible = 'false';
        /* Occluded labels leave the tab order; the station menu still
           covers every destination, so nothing becomes unreachable. */
        const unreachable = candidate.occluded || !candidate.visible;
        candidate.button.setAttribute('aria-hidden', unreachable ? 'true' : 'false');
        candidate.button.tabIndex = unreachable ? -1 : 0;
      }
    }
  }

  /* ── Selection and panels ──────────────────────────────────────────── */
  /**
   * A hidden element cannot take focus, so pick the most relevant *visible*
   * control instead of silently dropping focus on <body>.
   */
  function isFocusable(
    element: HTMLElement | null | undefined,
  ): element is HTMLElement {
    return Boolean(
      element && element.isConnected && element.offsetParent !== null && !element.hidden,
    );
  }

  function firstFocusable(...candidates: (HTMLElement | null | undefined)[]): HTMLElement | null {
    for (const candidate of candidates) {
      if (isFocusable(candidate)) return candidate;
    }
    return null;
  }

  function openPanel(key: string, returnTo?: HTMLElement | null): void {
    for (const [panelKey, panel] of panels) {
      panel.hidden = panelKey !== key;
    }
    const panel = panels.get(key);
    if (!panel) return;
    pendingReturnFocus = returnTo ?? (document.activeElement as HTMLElement | null);
    panel.hidden = false;
    const scrim = root.querySelector<HTMLElement>('[data-obs-scrim]');
    if (scrim && window.matchMedia('(max-width: 720px)').matches) scrim.hidden = false;
    const close = panel.querySelector<HTMLButtonElement>('[data-obs-panel-close]');
    window.requestAnimationFrame(() => {
      (close ?? panel).focus({ preventScroll: true });
    });
  }

  function closePanel(): void {
    const wasOpen = [...panels.values()].some((panel) => !panel.hidden);
    for (const panel of panels.values()) panel.hidden = true;
    const scrim = root.querySelector<HTMLElement>('[data-obs-scrim]');
    if (scrim) scrim.hidden = true;
    if (wasOpen) {
      const hotspot = selected ? hotspotButtons.get(selected) : null;
      const target = firstFocusable(
        pendingReturnFocus,
        hotspot,
        Array.from(exitButtons)[0],
        Array.from(exploreButtons)[0],
      );
      target?.focus({ preventScroll: true });
    }
    pendingReturnFocus = null;
  }

  function selectStation(id: StationId | null, exhibitId: string | null = null, returnTo?: HTMLElement | null): void {
    selected = id;
    dismissHint();
    world.setStationState(id);
    for (const [key, button] of menuItems) {
      const on = key === id;
      button.setAttribute('aria-current', on ? 'true' : 'false');
    }
    for (const [key, button] of hotspotButtons) {
      button.setAttribute('aria-pressed', key === id ? 'true' : 'false');
    }

    if (!id) {
      closePanel();
      rig.goTo(homeShot(rig.camera.aspect), { immediate: reducedMotion });
      return;
    }

    const node = world.stations.get(id);
    if (!node) return;
    rig.goTo(stationShot(node.shot, rig.camera.aspect), { immediate: reducedMotion });
    world.triggerSignal(id);
    openPanel(exhibitId ? `exhibit:${exhibitId}` : `station:${id}`, returnTo);
  }

  function focusExhibit(exhibitId: string, stationId: StationId, returnTo?: HTMLElement | null): void {
    const exhibit = world.exhibits.get(exhibitId);
    if (!exhibit) return;
    selected = stationId;
    const base = world.stations.get(stationId)?.shot;
    if (base) {
      /* Frame the exhibit itself, a little closer than the station shot. */
      const target = exhibit.anchor.clone();
      target.y -= 0.5;
      const offset = base.position.clone().sub(base.target).multiplyScalar(0.62);
      rig.goTo(
        stationShot({ position: target.clone().add(offset), target, fov: 32 }, rig.camera.aspect),
        { immediate: reducedMotion },
      );
    }
    openPanel(`exhibit:${exhibitId}`, returnTo);
  }

  /* ── Interaction ───────────────────────────────────────────────────── */
  const pointer = new THREE.Vector2();
  const pickRaycaster = new THREE.Raycaster();
  let pickTargets: THREE.Object3D[] = [];

  function refreshPickTargets(): void {
    pickTargets = world.pickTargets();
  }
  refreshPickTargets();

  function pickAt(clientX: number, clientY: number): { station: StationId; exhibit?: string } | null {
    const rect = canvas!.getBoundingClientRect();
    pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    pickRaycaster.setFromCamera(pointer, rig.camera);
    const hits = pickRaycaster.intersectObjects(pickTargets, false);
    for (const hit of hits) {
      const discoveryOf = hit.object.userData.discoveryOf as StationId | undefined;
      if (discoveryOf) return { station: discoveryOf };
      for (const node of world.stations.values()) {
        if (hit.object === node.pick) return { station: node.id };
        for (const exhibit of node.exhibits) {
          if (hit.object === exhibit.pick) return { station: node.id, exhibit: exhibit.id };
        }
      }
    }
    return null;
  }

  function onPointerMove(event: PointerEvent): void {
    if (event.pointerType === 'touch') return;
    if (dragState) return;
    const hit = pickAt(event.clientX, event.clientY);
    const hoverId = hit?.station ?? null;
    for (const node of world.stations.values()) {
      node.hover = node.id === hoverId ? 1 : 0;
    }
    canvas!.style.cursor = hoverId ? 'pointer' : exploring ? 'grab' : 'default';
  }

  let dragState: { x: number; y: number; pointerId: number } | null = null;

  function onPointerDown(event: PointerEvent): void {
    dismissHint();
    /* Orbit drag is exploration-only and never on touch. */
    if (!exploring || event.pointerType === 'touch' || event.button !== 0) return;
    dragState = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    canvas!.setPointerCapture(event.pointerId);
    canvas!.style.cursor = 'grabbing';
  }

  function onPointerMoveDrag(event: PointerEvent): void {
    if (!dragState || dragState.pointerId !== event.pointerId) {
      onPointerMove(event);
      return;
    }
    const dx = event.clientX - dragState.x;
    const dy = event.clientY - dragState.y;
    dragState.x = event.clientX;
    dragState.y = event.clientY;
    rig.orbit(dx, dy);
  }

  function onPointerUp(event: PointerEvent): void {
    if (!dragState) return;
    const moved =
      Math.abs(event.clientX - dragState.x) + Math.abs(event.clientY - dragState.y) > 3;
    dragState = null;
    try {
      canvas!.releasePointerCapture(event.pointerId);
    } catch {
      /* pointer already released */
    }
    canvas!.style.cursor = exploring ? 'grab' : 'default';
    if (moved) return;
    handleActivate(event.clientX, event.clientY);
  }

  function handleActivate(clientX: number, clientY: number): void {
    const hit = pickAt(clientX, clientY);
    if (!hit) {
      if (exploring) {
        selected = null;
        closePanel();
      }
      return;
    }
    const node = world.stations.get(hit.station);
    if (node?.discovery && !node.discovery.found) {
      discover(hit.station);
      return;
    }
    if (!exploring) enterExploration();
    if (hit.exhibit) focusExhibit(hit.exhibit, hit.station);
    else selectStation(hit.station);
  }

  canvas.addEventListener('pointermove', onPointerMoveDrag);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);

  /* ── Exploration mode ──────────────────────────────────────────────── */
  function enterExploration(): void {
    exploring = true;
    dismissHint();
    root.dataset.exploring = 'true';
    if (controls) controls.dataset.mode = 'explore';
    stage!.dataset.exploring = 'true';
    for (const button of exploreButtons) {
      button.setAttribute('aria-pressed', 'true');
      button.hidden = true;
    }
    for (const button of exitButtons) button.hidden = false;
    for (const button of resetButtons) button.hidden = false;
    canvas!.style.cursor = 'grab';
  }

  function exitExploration(): void {
    exploring = false;
    root.dataset.exploring = 'false';
    stage!.dataset.exploring = 'false';
    if (controls) controls.dataset.mode = 'ambient';
    for (const button of exploreButtons) {
      button.setAttribute('aria-pressed', 'false');
      button.hidden = false;
    }
    for (const button of exitButtons) button.hidden = true;
    for (const button of resetButtons) button.hidden = true;
    rig.resetOrbit();
    selectStation(null);
    canvas!.style.cursor = 'default';
  }

  function resetView(): void {
    rig.resetOrbit();
    if (selected) selectStation(selected, null, Array.from(resetButtons)[0]);
    else rig.goTo(homeShot(rig.camera.aspect), { immediate: reducedMotion });
  }

  for (const button of exploreButtons) {
    button.hidden = false;
    button.addEventListener('click', () => {
      enterExploration();
      selectStation('observatory', null, button);
    });
  }
  for (const button of exitButtons) {
    button.hidden = true;
    button.addEventListener('click', exitExploration);
  }
  for (const button of resetButtons) {
    button.hidden = true;
    button.addEventListener('click', resetView);
  }

  /* ── Hotspots and menu ─────────────────────────────────────────────── */
  const cleanups: (() => void)[] = [];

  for (const [id, button] of hotspotButtons) {
    const activate = () => {
      if (!exploring) enterExploration();
      selectStation(id, null, button);
    };
    button.addEventListener('click', activate);
    button.addEventListener('pointerenter', () => {
      const node = world.stations.get(id);
      if (node) node.hover = 1;
    });
    button.addEventListener('pointerleave', () => {
      const node = world.stations.get(id);
      if (node) node.hover = 0;
    });
    button.addEventListener('focus', () => {
      button.dataset.visible = 'true';
    });
  }

  for (const [id, button] of menuItems) {
    button.addEventListener('click', () => {
      if (!exploring) enterExploration();
      selectStation(id, null, button);
      const details = button.closest('details');
      if (details) details.open = false;
    });
  }

  root.querySelectorAll<HTMLButtonElement>('[data-obs-exhibit]').forEach((button) => {
    button.addEventListener('click', () => {
      const exhibitId = button.dataset.obsExhibit;
      if (!exhibitId) return;
      if (!exploring) enterExploration();
      focusExhibit(exhibitId, 'work', button);
    });
  });

  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-obs-panel-close]')) {
    button.addEventListener('click', closePanel);
  }
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-obs-panel-back]')) {
    button.addEventListener('click', () => {
      const target = button.dataset.obsPanelBackTo;
      if (target) openPanel(target);
    });
  }
  const scrim = root.querySelector<HTMLElement>('[data-obs-scrim]');
  scrim?.addEventListener('click', closePanel);

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      const open = [...panels.values()].some((panel) => !panel.hidden);
      if (open) {
        closePanel();
        event.stopPropagation();
      } else if (exploring) {
        exitExploration();
      }
    }
  }
  document.addEventListener('keydown', onKeydown);
  cleanups.push(() => document.removeEventListener('keydown', onKeydown));

  /* ── Pause / simple view / quality controls ────────────────────────── */
  let paused = false;
  function setPaused(next: boolean): void {
    paused = next;
    root.dataset.ambient = next ? 'paused' : 'playing';
    for (const button of pauseButtons) {
      button.setAttribute('aria-pressed', next ? 'true' : 'false');
      const label = button.querySelector('[data-obs-pause-label]');
      if (label) {
        label.textContent = next
          ? (button.dataset.labelResume ?? 'Resume motion')
          : (button.dataset.labelPause ?? 'Pause motion');
      }
    }
    syncLoop();
  }
  for (const button of pauseButtons) {
    button.addEventListener('click', () => setPaused(button.getAttribute('aria-pressed') !== 'true'));
  }

  function setSimpleView(on: boolean): void {
    dismissHint();
    root.dataset.simple = on ? 'true' : 'false';
    if (simpleView) simpleView.hidden = !on;
    for (const button of simpleButtons) button.setAttribute('aria-pressed', on ? 'true' : 'false');
    for (const button of worldButtons) button.hidden = !on;
    if (on) {
      syncLoop();
    } else {
      resize();
      renderOnce();
    }
  }
  for (const button of simpleButtons) {
    button.addEventListener('click', () => setSimpleView(root.dataset.simple !== 'true'));
  }
  for (const button of worldButtons) {
    button.hidden = true;
    button.addEventListener('click', () => setSimpleView(false));
  }

  if (qualitySelect) {
    qualitySelect.addEventListener('change', () => {
      const value = qualitySelect.value;
      if (value === 'auto') {
        clearPreference();
        monitor.reset();
        applyQuality(detectTier(), false);
      } else if (isQualityTier(value)) {
        applyQuality(value, true);
      }
    });
  }

  /* ── Discoveries ───────────────────────────────────────────────────── */
  function discover(id: StationId): void {
    if (discovered.has(id)) return;
    discovered.add(id);
    writeDiscoveries([...discovered]);
    world.applyDiscoveries([id]);
    updateDiscoveryNote();
    const node = world.stations.get(id);
    if (node?.discovery) {
      node.discovery.halo.visible = false;
      node.discovery.mesh.visible = false;
    }
    refreshPickTargets();
  }

  function updateDiscoveryNote(): void {
    if (!discoveryNote) return;
    discoveryNote.textContent = `${discovered.size} / 3`;
    discoveryNote.dataset.count = String(discovered.size);
  }

  /* ── Render loop ───────────────────────────────────────────────────── */
  let frameHandle = 0;
  let last = 0;
  /* Ambient time only advances when motion is allowed, so pausing freezes
     the world exactly where it is instead of snapping it back to zero. */
  let clock = 0;
  let running = false;

  function syncLoop(): void {
    const shouldRun = !disposed && !paused && onScreen && root.dataset.simple !== 'true';
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
    if (root.dataset.simple === 'true') return;
    atmosphere.follow(rig.camera);
    renderer.render(scene, rig.camera);
    projectHotspots();
  }

  function frame(now: number): void {
    if (disposed) return;
    /* requestAnimationFrame timestamps can predate the performance.now()
       used to seed the clock, so never let the delta go negative. */
    const delta = Math.min(Math.max((now - last) / 1000, 0), 0.05);
    last = now;

    const animate = settings.ambient && !paused;
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

  function onVisibility(): void {
    if (document.hidden) {
      running = false;
      window.cancelAnimationFrame(frameHandle);
    } else {
      syncLoop();
    }
  }
  document.addEventListener('visibilitychange', onVisibility);
  cleanups.push(() => document.removeEventListener('visibilitychange', onVisibility));

  const onContextLost = (event: Event) => {
    event.preventDefault();
    /* The context can sometimes be recovered by reloading, so offer that. */
    failToSimpleView(root, status, status?.dataset.messageLost, true);
    running = false;
    window.cancelAnimationFrame(frameHandle);
    root.dataset.world = 'failed';
  };
  canvas.addEventListener('webglcontextlost', onContextLost);
  cleanups.push(() => canvas.removeEventListener('webglcontextlost', onContextLost));

  /* ── Ready ─────────────────────────────────────────────────────────── */
  root.dataset.world = 'ready';
  /* Surface real scene complexity on the element, so it can be measured
     rather than guessed at. */
  const stats = world.stats();
  root.dataset.triangles = String(stats.triangles);
  root.dataset.drawCalls = String(stats.drawCalls);
  setStatus(status, 'ready', status?.dataset.messageReady ?? '');
  window.setTimeout(() => {
    if (!disposed && status) status.hidden = true;
  }, 3600);

  /**
   * Show the in-scene affordance after the camera has settled, then retire
   * it: on any interaction, or after a few seconds on its own. It exists to
   * answer "what is this and what can I do", once.
   */
  let hintTimer = 0;
  let hintHidden = false;
  function dismissHint(): void {
    if (hintHidden || !hint) return;
    hintHidden = true;
    window.clearTimeout(hintTimer);
    hint.dataset.leaving = 'true';
    window.setTimeout(() => {
      hint.hidden = true;
      hint.dataset.leaving = 'false';
    }, 460);
  }
  if (hint) {
    hintTimer = window.setTimeout(() => {
      if (!disposed) {
        hint.hidden = false;
        hintTimer = window.setTimeout(dismissHint, 7000);
      }
    }, 900);
  }

  renderOnce();
  syncLoop();
  measureLabels();

  /* ── Teardown ──────────────────────────────────────────────────────── */
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      running = false;
      window.cancelAnimationFrame(frameHandle);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      stopThemes();
      for (const cleanup of cleanups) cleanup();
      canvas.removeEventListener('pointermove', onPointerMoveDrag);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      world.dispose();
      materials.dispose();
      atmosphere.dispose();
      scene.clear();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}

/* ── Small helpers ───────────────────────────────────────────────────── */

/**
 * Degrade to the simple view. Used for both permanent failures (no WebGL)
 * and recoverable ones (context loss), where a reload is offered because it
 * is the only honest way to try again.
 */
function failToSimpleView(
  root: HTMLElement,
  status: HTMLElement | null,
  message: string | undefined,
  offerReload: boolean,
): void {
  root.dataset.world = 'failed';
  root.dataset.simple = 'true';
  const simple = root.querySelector<HTMLElement>('[data-obs-simple-view]');
  if (simple) simple.hidden = false;
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-obs-world-toggle]')) {
    button.hidden = !offerReload;
    button.addEventListener('click', () => window.location.reload());
  }
  for (const panel of root.querySelectorAll<HTMLElement>('[data-obs-panel]')) {
    panel.hidden = true;
  }
  setStatus(status, 'error', message ?? 'Interactive view unavailable');
}

function setStatus(element: HTMLElement | null, state: string, message: string): void {
  if (!element) return;
  element.dataset.state = state;
  const text = element.querySelector('[data-obs-status-text]');
  if (text && message) text.textContent = message;
  element.hidden = false;
}

function readDiscoveries(): StationId[] {
  try {
    const raw = localStorage.getItem(DISCOVERY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StationId[]).slice(0, 3) : [];
  } catch {
    return [];
  }
}

function writeDiscoveries(ids: StationId[]): void {
  try {
    localStorage.setItem(DISCOVERY_KEY, JSON.stringify(ids));
  } catch {
    /* storage unavailable — discoveries last for this session only */
  }
}
