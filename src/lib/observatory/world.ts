/**
 * The observatory world.
 *
 * One compact, art-directed island: a central instrument with a moving
 * orbital mechanism, a work pavilion with three exhibits, a knowledge
 * graph garden, a signal tower, a personal studio and a contact beacon —
 * joined by lit walkways, patrolled by a small guide drone, and hiding
 * three light markers that switch the observatory's lanterns on.
 *
 * Everything is procedural. No external models, no texture downloads.
 */

import * as THREE from 'three';
import type { StationId } from '../../site.config';
import type { Materials } from './materials';
import {
  buildDroneGeometry,
  coniferGeometry,
  crystalGeometry,
  curveFrom,
  distantHills,
  graphLayout,
  instancedMesh,
  lathe,
  latticeMast,
  mulberry32,
  offsetPoints,
  radialFalloffTexture,
  ribbon,
  ribGeometry,
  ribbedDome,
  rimRing,
  roundedBox,
  sculptIsland,
  spanMatrix,
  terrace,
  tubeAlong,
  unitCylinder,
} from './parts';
import type { Atmosphere } from './lighting';
import type { QualitySettings } from './quality';
import type { WorldTheme } from './theme';

/** Height of the island's flat plateau. */
const GROUND = 1;

interface StationLayout {
  x: number;
  z: number;
  pad: number;
  padHeight: number;
  /** Rotation that turns the station's local +Z toward the island centre. */
  yaw: number;
}

/** Radius of the ring of outer stations. */
const RING_RADIUS = 8.6;

/**
 * Station placement is an art-direction decision, not an arbitrary one:
 * the default camera looks in from roughly 44� east of north, so the Work
 * pavilion, the Contact beacon and the Signal tower all sit inside that
 * view cone and are readable the moment the world appears.
 */
function layoutAt(degrees: number, radius: number, pad: number, padHeight: number): StationLayout {
  const angle = (degrees * Math.PI) / 180;
  const x = Math.sin(angle) * radius;
  const z = Math.cos(angle) * radius;
  return { x, z, pad, padHeight, yaw: radius === 0 ? 0 : Math.atan2(-x, -z) };
}

const LAYOUT: Record<StationId, StationLayout> = {
  observatory: layoutAt(0, 0, 4.3, 0.9),
  work: layoutAt(-20, RING_RADIUS, 3.1, 0.55),
  contact: layoutAt(40, RING_RADIUS, 2.5, 0.45),
  writing: layoutAt(100, RING_RADIUS, 2.3, 0.45),
  knowledge: layoutAt(160, RING_RADIUS, 3, 0.4),
  studio: layoutAt(250, RING_RADIUS, 2.6, 0.5),
};

/** Walkway order � the ring, sorted by angle around the island. */
const RING_ORDER: StationId[] = ['work', 'contact', 'writing', 'knowledge', 'studio'];

export interface Shot {
  position: THREE.Vector3;
  target: THREE.Vector3;
  fov: number;
}

export interface ExhibitNode {
  id: string;
  station: StationId;
  index: number;
  anchor: THREE.Vector3;
  pick: THREE.Mesh;
  glow: THREE.MeshStandardMaterial;
}

export interface DiscoveryNode {
  station: StationId;
  label: string;
  mesh: THREE.Mesh;
  halo: THREE.Mesh;
  found: boolean;
  position: THREE.Vector3;
}

export interface StationNode {
  id: StationId;
  group: THREE.Group;
  /** Where the DOM hotspot label attaches. */
  anchor: THREE.Vector3;
  /** Camera look-at when the station is framed. */
  target: THREE.Vector3;
  shot: Shot;
  pick: THREE.Mesh;
  /** Accent material brightened on hover / selection. */
  glow: THREE.MeshStandardMaterial;
  exhibits: ExhibitNode[];
  discovery?: DiscoveryNode;
  hover: number;
  active: number;
}

export interface WorldStats {
  triangles: number;
  drawCalls: number;
}

/** Distance at which a sphere of `radius` fits the current viewport. */
export function fitDistance(radius: number, fovDeg: number, aspect: number): number {
  const vFov = THREE.MathUtils.degToRad(fovDeg);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * Math.max(aspect, 0.35));
  return radius / Math.sin(Math.min(vFov, hFov) / 2);
}

export class ObservatoryWorld {
  readonly group = new THREE.Group();
  readonly stations = new Map<StationId, StationNode>();
  readonly exhibits = new Map<string, ExhibitNode>();

  private readonly materials: Materials;
  private readonly atmosphere: Atmosphere;
  private quality: QualitySettings;
  private theme: WorldTheme;

  /** Materials whose emissive intensity is animated per station. */
  private readonly glowMaterials = new Map<StationId, THREE.MeshStandardMaterial>();

  /* Animated pieces */
  private armillary = new THREE.Group();
  private graphPulse!: THREE.Mesh;
  private graphPath: THREE.Vector3[] = [];
  private searchlight = new THREE.Group();
  private searchlightMaterial: THREE.MeshBasicMaterial | null = null;
  private hills: THREE.InstancedMesh | null = null;
  private hillFade: number[] = [];
  private beaconCore!: THREE.Mesh;
  private beaconLantern!: THREE.Mesh;
  private islandLanterns: THREE.Mesh[] = [];
  private mistGroup = new THREE.Group();
  private mistLayers: THREE.Mesh[] = [];
  private drone = new THREE.Group();
  private rotorGroup = new THREE.Group();

  /* Signals along the pathways */
  private signals: { mesh: THREE.Mesh; t: number; speed: number; curve: THREE.CatmullRomCurve3 }[] = [];
  private flight: { mesh: THREE.Mesh; curve: THREE.CatmullRomCurve3; t: number } | null = null;
  private spurCurves = new Map<StationId, THREE.CatmullRomCurve3>();
  private ringCurve!: THREE.CatmullRomCurve3;
  private droneTarget = new THREE.Vector3();
  private dronePosition = new THREE.Vector3(0, 9, 12);

  private readonly occluderList: THREE.Object3D[] = [];
  private pickMaterial = new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: false,
  });
  private readonly disposables: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = [];

  constructor(
    theme: WorldTheme,
    quality: QualitySettings,
    materials: Materials,
    atmosphere: Atmosphere,
  ) {
    this.theme = theme;
    this.quality = quality;
    this.materials = materials;
    this.atmosphere = atmosphere;
    this.group.name = 'observatory-world';

    this.buildIsland();
    this.buildLandscape();
    this.buildPathways();
    this.buildObservatory();
    this.buildWorkPavilion();
    this.buildKnowledgeGarden();
    this.buildSignalTower();
    this.buildStudio();
    this.buildContactBeacon();
    this.buildDrone();
    this.buildSignals();
    this.wirePracticalLights();

    this.setTheme(theme);
    this.setQuality(quality);
  }

  /**
   * Place the three practical lamps that give the night scene its warm
   * pools of light: the studio window, the signal-tower beacon and the
   * contact beacon's lantern.
   */
  private wirePracticalLights(): void {
    const studio = this.stationLayout('studio');
    const tower = this.stationLayout('writing');
    const contact = this.stationLayout('contact');
    this.atmosphere.setPractical(
      0,
      new THREE.Vector3(studio.origin.x + 0.4, studio.surface + 1, studio.origin.z + 1),
      6.5,
      this.theme.practical,
    );
    this.atmosphere.setPractical(
      1,
      new THREE.Vector3(tower.origin.x, tower.surface + 8.1, tower.origin.z),
      4.5,
      this.theme.signal,
    );
    this.atmosphere.setPractical(
      2,
      new THREE.Vector3(contact.origin.x, contact.surface + 2.3, contact.origin.z),
      5,
      this.theme.practical,
    );
  }

  /* ── Registration helpers ──────────────────────────────────────────── */

  private track<T extends THREE.BufferGeometry | THREE.Material | THREE.Texture>(item: T): T {
    this.disposables.push(item);
    return item;
  }

  private mesh(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    parent: THREE.Object3D,
    name: string,
    options: {
      cast?: boolean;
      receive?: boolean;
      position?: THREE.Vector3;
      /** Counts as a real occluder when projecting station labels. */
      occluder?: boolean;
    } = {},
  ): THREE.Mesh {
    this.track(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.castShadow = options.cast ?? true;
    mesh.receiveShadow = options.receive ?? true;
    if (options.occluder) mesh.userData.occluder = true;
    if (options.position) mesh.position.copy(options.position);
    parent.add(mesh);
    return mesh;
  }

  private accentMaterial(station: StationId, color: number): THREE.MeshStandardMaterial {
    const material = this.track(
      new THREE.MeshStandardMaterial({
        color: 0x0a1018,
        roughness: 0.35,
        metalness: 0.1,
        emissive: new THREE.Color(color),
        emissiveIntensity: 0.35,
      }),
    );
    this.glowMaterials.set(station, material);
    return material;
  }

  private stationLayout(id: StationId): { layout: StationLayout; surface: number; origin: THREE.Vector3 } {
    const layout = LAYOUT[id];
    const surface = GROUND - 0.05 + layout.padHeight;
    return { layout, surface, origin: new THREE.Vector3(layout.x, surface, layout.z) };
  }

  /** Camera shot that frames a station from outside the island. */
  private shotFor(id: StationId, accentHeight = 1.4): Shot {
    const { layout, surface } = this.stationLayout(id);
    const outward = new THREE.Vector3(layout.x, 0, layout.z);
    if (outward.lengthSq() < 0.001) {
      return {
        position: new THREE.Vector3(13.5, 9, 17),
        target: new THREE.Vector3(0, 3.4, 0),
        fov: 40,
      };
    }
    outward.normalize();
    const distance = 7.6 + layout.pad * 0.6;
    const position = new THREE.Vector3(
      layout.x + outward.x * distance,
      surface + 4.4,
      layout.z + outward.z * distance,
    );
    const target = new THREE.Vector3(layout.x, surface + accentHeight, layout.z);
    return { position, target, fov: 36 };
  }

  private registerStation(
    id: StationId,
    build: (context: {
      group: THREE.Group;
      surface: number;
      origin: THREE.Vector3;
      glow: THREE.MeshStandardMaterial;
    }) => {
      anchorY?: number;
      pickRadius?: number;
      pickHeight?: number;
      targetY?: number;
      exhibits?: ExhibitNode[];
    },
  ): StationNode {
    const { layout, surface, origin } = this.stationLayout(id);
    const group = new THREE.Group();
    group.name = `station-${id}`;
    group.position.set(layout.x, 0, layout.z);
    group.rotation.y = layout.yaw;
    this.group.add(group);

    const glow = this.accentMaterial(id, this.accentFor(id));
    const result = build({ group, surface, origin, glow });

    /* A generous, invisible hit volume makes station selection forgiving. */
    const pickRadius = result.pickRadius ?? layout.pad + 0.4;
    const pickHeight = result.pickHeight ?? 3.2;
    const pickGeometry = this.track(
      new THREE.CylinderGeometry(pickRadius, pickRadius, pickHeight, 10, 1, false),
    );
    const pick = new THREE.Mesh(pickGeometry, this.pickMaterial);
    pick.name = `pick-${id}`;
    pick.position.set(layout.x, surface + pickHeight / 2 - 0.2, layout.z);
    this.group.add(pick);

    const node: StationNode = {
      id,
      group,
      anchor: new THREE.Vector3(layout.x, surface + (result.anchorY ?? 2.6), layout.z),
      target: new THREE.Vector3(layout.x, surface + (result.targetY ?? 1.4), layout.z),
      shot: this.shotFor(id),
      pick,
      glow,
      exhibits: result.exhibits ?? [],
      hover: 0,
      active: 0,
    };

    for (const exhibit of node.exhibits) this.exhibits.set(exhibit.id, exhibit);
    this.stations.set(id, node);
    return node;
  }

  private accentFor(id: StationId): number {
    switch (id) {
      case 'writing':
      case 'studio':
      case 'contact':
        return this.theme.practical;
      default:
        return this.theme.signal;
    }
  }

  /* ── Island ────────────────────────────────────────────────────────── */

  private buildIsland(): void {
    const geometry = lathe(
      [
        [0, GROUND],
        [3.6, GROUND],
        [8, GROUND - 0.002],
        [11.2, GROUND - 0.012],
        [12.5, GROUND - 0.1],
        [13.2, GROUND - 0.38],
        [13.6, GROUND - 0.8],
        [13.7, GROUND - 1.5],
        [13.3, -2.6],
        [11.9, -4],
        [9.9, -5.5],
        [7.4, -7],
        [4.6, -8.2],
        [2.2, -9],
        [0.5, -9.5],
        [0, -9.6],
      ],
      64,
    );
    sculptIsland(geometry, { flatAbove: GROUND - 0.4, strength: 0.42, seed: 11 });
    const island = this.mesh(geometry, this.materials.stone, this.group, 'island', {
      cast: false,
      receive: true,
      occluder: true,
    });
    island.frustumCulled = false;

    /* Faceted rock along the cliff ? strata, not rubble. */
    if (this.quality.detail) {
      const random = mulberry32(31);
      const matrices: THREE.Matrix4[] = [];
      const matrix = new THREE.Matrix4();
      for (let i = 0; i < 22; i++) {
        const angle = random() * Math.PI * 2;
        const depth = random();
        const radius = 10.2 + depth * 2.2;
        const y = GROUND - 1.6 - depth * 4.6;
        const scale = 0.45 + random() * 0.6;
        matrix.compose(
          new THREE.Vector3(Math.cos(angle) * radius, y, Math.sin(angle) * radius),
          new THREE.Quaternion().setFromEuler(
            new THREE.Euler(random() * 3, random() * 3, random() * 3),
          ),
          new THREE.Vector3(scale, scale * 0.8, scale),
        );
        matrices.push(matrix.clone());
      }
      const rockGeometry = this.track(new THREE.DodecahedronGeometry(0.8, 0));
      this.group.add(instancedMesh(rockGeometry, this.materials.rock, matrices, 'cliff-rocks'));
    }

    /* Grass and planting, arranged in rings from the rim inward. */
    const random = mulberry32(5);
    const rings = this.quality.treeRings;
    const conifer = coniferGeometry();
    this.track(conifer.trunk);
    this.track(conifer.lower);
    this.track(conifer.upper);

    const trunks: THREE.Matrix4[] = [];
    const lowers: THREE.Matrix4[] = [];
    const uppers: THREE.Matrix4[] = [];
    const matrix = new THREE.Matrix4();
    for (let ring = 0; ring < rings; ring++) {
      const radius = 12.4 - ring * 1.6;
      const count = 18 - ring * 3;
      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2 + random() * 0.28 + ring;
        const jitter = 0.85 + random() * 0.4;
        const x = Math.cos(angle) * radius * jitter;
        const z = Math.sin(angle) * radius * jitter;
        /* Keep the built terraces clear of planting. */
        if (this.nearStation(x, z, 4.4)) continue;
        const scale = 0.5 + random() * 0.6;
        const yaw = random() * Math.PI;
        const quaternion = new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(0, 1, 0),
          yaw,
        );
        const base = new THREE.Vector3(x, GROUND - 0.06, z);
        matrix.compose(base, quaternion, new THREE.Vector3(scale, scale, scale));
        trunks.push(matrix.clone());
        lowers.push(matrix.clone());
        uppers.push(matrix.clone());
      }
    }
    if (trunks.length) {
      const treeTrunk = instancedMesh(conifer.trunk, this.materials.rock, trunks, 'tree-trunks');
      const treeLower = instancedMesh(conifer.lower, this.materials.foliage, lowers, 'tree-lower');
      const treeUpper = instancedMesh(conifer.upper, this.materials.foliage, uppers, 'tree-upper');
      for (const mesh of [treeTrunk, treeLower, treeUpper]) {
        mesh.castShadow = this.quality.shadows;
        mesh.receiveShadow = true;
        this.group.add(mesh);
      }
    }

    /* Restrained shrubs close to the architecture. */
    const shrubGeometry = this.track(new THREE.IcosahedronGeometry(0.34, 0));
    shrubGeometry.scale(1, 0.66, 1);
    const shrubs: THREE.Matrix4[] = [];
    for (let i = 0; i < 34; i++) {
      const angle = random() * Math.PI * 2;
      const radius = 4.6 + random() * 5.6;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      if (this.nearStation(x, z, 3.4)) continue;
      const scale = 0.6 + random() * 0.7;
      matrix.compose(
        new THREE.Vector3(x, GROUND - 0.05, z),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), random() * Math.PI),
        new THREE.Vector3(scale, scale, scale),
      );
      shrubs.push(matrix.clone());
    }
    if (shrubs.length) {
      const shrubsMesh = instancedMesh(shrubGeometry, this.materials.foliage, shrubs, 'shrubs');
      shrubsMesh.castShadow = this.quality.shadows;
      this.group.add(shrubsMesh);
    }
  }

  /**
   * Colour the distant hills. They are never lit, so the whole atmospheric
   * perspective is baked in: nearer ridges sit closer to the upper sky, far
   * ones dissolve toward the haze. That keeps them as soft ridges instead of
   * flat black shapes pasted behind the island.
   */
  private setHillColors(
    scratch: THREE.Color,
    haze: THREE.Color,
    sky: THREE.Color,
    fade: number[],
    hills: THREE.InstancedMesh,
  ): void {
    haze.setHex(this.theme.fog);
    sky.setHex(this.theme.skyTop);
    for (let i = 0; i < fade.length; i++) {
      const factor = THREE.MathUtils.lerp(0.45, 0.95, 1 - fade[i]);
      scratch.copy(sky).lerp(haze, factor);
      hills.setColorAt(i, scratch);
    }
    if (hills.instanceColor) hills.instanceColor.needsUpdate = true;
  }

  private nearStation(x: number, z: number, margin: number): boolean {
    for (const layout of Object.values(LAYOUT)) {
      const distance = Math.hypot(x - layout.x, z - layout.z);
      if (distance < layout.pad + margin) return true;
    }
    return false;
  }

  /* ── Landscape below ───────────────────────────────────────────────── */

  private buildLandscape(): void {
    /* Distant hills: one instanced mesh, painted darker than the sky so they
       read as silhouettes against the horizon glow. Fog is disabled and the
       atmospheric fade is baked into the per-instance colour instead, which
       keeps them dark instead of dissolving into the fog colour. */
    const { matrices, colors } = distantHills(17, 34, 420);
    const hillGeometry = this.track(new THREE.ConeGeometry(1, 1, 5, 1));
    hillGeometry.translate(0, 0.5, 0);
    const hills = instancedMesh(hillGeometry, this.materials.hill, matrices, 'hills');
    const hillColor = new THREE.Color();
    const haze = new THREE.Color();
    const sky = new THREE.Color();
    this.setHillColors(hillColor, haze, sky, colors, hills);
    hills.castShadow = false;
    hills.receiveShadow = false;
    this.hills = hills;
    this.hillFade = colors;
    this.group.add(hills);

    /* Drifting mist under the island. The planes are large enough that their
       soft falloff never meets the frustum edge — otherwise the cut shows up
       as a hard ellipse under the island. */
    const texture = this.track(radialFalloffTexture(128));
    const mistGeometry = this.track(new THREE.PlaneGeometry(1, 1));
    mistGeometry.rotateX(-Math.PI / 2);
    const random = mulberry32(23);
    for (let i = 0; i < 6; i++) {
      const material = this.track(
        new THREE.MeshBasicMaterial({
          color: this.theme.mist,
          map: texture,
          transparent: true,
          opacity: 0.3,
          depthWrite: false,
          side: THREE.DoubleSide,
          fog: false,
        }),
      );
      const layer = new THREE.Mesh(mistGeometry, material);
      const size = 150 + random() * 90;
      layer.scale.set(size, 1, size);
      layer.position.set(
        (random() - 0.5) * 14,
        -4 - i * 3.4 - random() * 1.5,
        (random() - 0.5) * 14,
      );
      layer.rotation.y = random() * Math.PI;
      layer.renderOrder = 2;
      layer.userData.drift = 0.008 + random() * 0.014;
      layer.userData.bob = random() * Math.PI * 2;
      this.mistLayers.push(layer);
      this.mistGroup.add(layer);
    }
    this.group.add(this.mistGroup);
  }

  /* ── Pathways ──────────────────────────────────────────────────────── */

  private buildPathways(): void {
    const order: StationId[] = RING_ORDER;
    const ringPoints = order.map((id) => {
      const { origin } = this.stationLayout(id);
      return new THREE.Vector3(origin.x * 1.02, origin.y + 0.02, origin.z * 1.02);
    });
    this.ringCurve = curveFrom(ringPoints, true, 0.5);

    const ringSurface = ribbon(this.ringCurve, 1.15, 200, 0.02);
    const walkMaterial = this.track(
      new THREE.MeshStandardMaterial({
        color: this.theme.stoneDeep,
        roughness: 0.9,
        metalness: 0.02,
        side: THREE.DoubleSide,
      }),
    );
    const ringMesh = this.mesh(
      ringSurface,
      walkMaterial,
      this.group,
      'ring-walk',
      { cast: false, receive: true },
    );
    ringMesh.frustumCulled = false;

    /* A recessed light guide down the middle of every walkway. */
    const guideGeometry = ribbon(this.ringCurve, 0.1, 200, 0.035);
    const guide = this.mesh(guideGeometry, this.materials.signal, this.group, 'ring-guide', {
      cast: false,
      receive: false,
    });
    guide.frustumCulled = false;

    if (this.quality.detail) {
      const outer = offsetPoints(this.ringCurve, 0.85, 90);
      const railGeometry = tubeAlong(outer, 0.035);
      this.mesh(railGeometry, this.materials.metal, this.group, 'ring-rail', {
        cast: false,
        receive: true,
      });
      const balusters: THREE.Matrix4[] = [];
      const postGeometry = this.track(new THREE.CylinderGeometry(0.03, 0.035, 0.58, 5));
      postGeometry.translate(0, 0.29, 0);
      for (let i = 0; i < outer.length - 1; i += 2) {
        const point = outer[i];
        const matrix = new THREE.Matrix4().makeTranslation(point.x, point.y + 0.02, point.z);
        balusters.push(matrix);
      }
      if (balusters.length) {
        const posts = instancedMesh(postGeometry, this.materials.metalDark, balusters, 'ring-posts');
        posts.castShadow = false;
        this.group.add(posts);
      }
    }

    /* The entrance avenue: the observatory terrace out to the beacon. */
    const { origin: observatory } = this.stationLayout('observatory');
    const { origin: contact } = this.stationLayout('contact');
    const outward = new THREE.Vector3(contact.x, 0, contact.z).normalize();
    const avenue = curveFrom(
      [
        new THREE.Vector3(outward.x * 3.8, observatory.y + 0.02, outward.z * 3.8),
        new THREE.Vector3(outward.x * 4.8, observatory.y + 0.04, outward.z * 4.8),
        new THREE.Vector3(outward.x * 5.8, contact.y + 0.04, outward.z * 5.8),
        new THREE.Vector3(outward.x * 6.6, contact.y + 0.02, outward.z * 6.6),
      ],
      false,
      0.4,
    );
    const avenueSurface = ribbon(avenue, 1.4, 90, 0.02);
    const avenueMesh = this.mesh(avenueSurface, walkMaterial, this.group, 'avenue-walk', {
      cast: false,
      receive: true,
    });
    avenueMesh.frustumCulled = false;
    const avenueGuide = ribbon(avenue, 0.1, 90, 0.035);
    this.mesh(avenueGuide, this.materials.signal, this.group, 'avenue-guide', {
      cast: false,
      receive: false,
    }).frustumCulled = false;

    if (this.quality.detail) {
      for (const side of [0.9, -0.9]) {
        const points = offsetPoints(avenue, side, 60);
        const rail = tubeAlong(points, 0.035, false);
        this.mesh(rail, this.materials.metal, this.group, `avenue-rail-${side}`, {
          cast: false,
          receive: true,
        });
      }
    }

    /* A dedicated spur per station, used by the travelling signals. */
    const observatoryEdge = new THREE.Vector3(observatory.x, observatory.y + 0.4, observatory.z);
    for (const id of Object.keys(LAYOUT) as StationId[]) {
      const { origin } = this.stationLayout(id);
      const start = observatoryEdge.clone();
      const end = new THREE.Vector3(origin.x, origin.y + 0.35, origin.z);
      const mid = start.clone().lerp(end, 0.5);
      mid.y += 1.6 + start.distanceTo(end) * 0.09;
      this.spurCurves.set(id, curveFrom([start, mid, end], false, 0.5));
    }
  }

  /* ── Station: central observatory ──────────────────────────────────── */

  private buildObservatory(): void {
    const node = this.registerStation('observatory', ({ group, surface, glow }) => {
      const baseY = GROUND - 0.05;
      this.mesh(terrace(4, 0.9, 0.18), this.materials.stone, group, 'obs-terrace', {
        position: new THREE.Vector3(0, baseY, 0),
        cast: true,
      });
      this.mesh(rimRing(3.86, 0.05, 56), this.materials.stoneDark, group, 'obs-rim', {
        position: new THREE.Vector3(0, surface - 0.06, 0),
      });
      /* Recessed rim light — one of the few emissive details. */
      this.mesh(rimRing(3.6, 0.026, 56), glow, group, 'obs-rimlight', {
        position: new THREE.Vector3(0, surface - 0.02, 0),
        cast: false,
        receive: false,
      });

      /* Stepped base, then the colonnade that carries the drum. */
      this.mesh(terrace(3, 0.3, 0.1), this.materials.ceramic, group, 'obs-step', {
        position: new THREE.Vector3(0, surface, 0),
      });

      const columns = 10;
      const columnGeometry = this.track(new THREE.CylinderGeometry(0.085, 0.1, 1.25, 8));
      const columnMatrices: THREE.Matrix4[] = [];
      for (let i = 0; i < columns; i++) {
        const angle = (i / columns) * Math.PI * 2 + 0.2;
        columnMatrices.push(
          new THREE.Matrix4().makeTranslation(
            Math.cos(angle) * 2.68,
            surface + 0.3 + 0.63,
            Math.sin(angle) * 2.68,
          ),
        );
      }
      const columnsMesh = instancedMesh(
        columnGeometry,
        this.materials.ceramic,
        columnMatrices,
        'obs-columns',
      );
      columnsMesh.castShadow = this.quality.shadows;
      group.add(columnsMesh);

      /* Entablature, drum, then a dark reveal — the reveal is what makes the
         dome read as a separate sculpted volume instead of one pale bell. */
      this.mesh(rimRing(2.68, 0.14, 48), this.materials.ceramic, group, 'obs-entablature', {
        position: new THREE.Vector3(0, surface + 1.58, 0),
      });
      const drumBase = surface + 1.58;
      this.mesh(
        new THREE.CylinderGeometry(2.32, 2.44, 1.5, 36, 1, false),
        this.materials.ceramic,
        group,
        'obs-drum',
        { position: new THREE.Vector3(0, drumBase + 0.75, 0), occluder: true },
      );
      this.mesh(
        new THREE.CylinderGeometry(2.24, 2.29, 0.2, 36, 1, false),
        this.materials.metalDark,
        group,
        'obs-reveal',
        { position: new THREE.Vector3(0, drumBase + 1.56, 0) },
      );

      /* Ribbed dome with a recessed observation slit. */
      const dome = ribbedDome(2.24, 10);
      const domeBase = drumBase + 1.62;
      const shell = this.mesh(dome.shell, this.materials.ceramic, group, 'obs-dome', {
        position: new THREE.Vector3(0, domeBase, 0),
        occluder: true,
      });
      shell.castShadow = this.quality.shadows;
      const rib = this.track(ribGeometry(2.26, 0.042));
      const ribs = instancedMesh(rib, this.materials.metal, dome.ribMatrices, 'obs-ribs');
      ribs.position.set(0, domeBase, 0);
      ribs.castShadow = false;
      group.add(ribs);

      this.mesh(dome.slit, this.materials.metalDark, group, 'obs-slit', {
        position: new THREE.Vector3(0, domeBase, 0),
        cast: false,
      });
      const slitLight = this.mesh(
        new THREE.BoxGeometry(0.5, 0.06, 1.3),
        glow,
        group,
        'obs-slit-light',
        { position: new THREE.Vector3(0, domeBase + 1, 0), cast: false, receive: false },
      );
      slitLight.rotation.y = Math.PI * 0.25;

      /* The slowly turning orbital mechanism. */
      this.armillary = new THREE.Group();
      this.armillary.name = 'obs-armillary';
      this.armillary.position.set(0, domeBase + 1.5, 0);
      group.add(this.armillary);
      this.mesh(
        new THREE.CylinderGeometry(0.05, 0.07, 3.4, 8),
        this.materials.metal,
        this.armillary,
        'obs-spindle',
        { cast: false },
      );
      const ringSpecs = [
        { radius: 1.25, tilt: 0.42, color: glow },
        { radius: 1.7, tilt: -0.3, color: this.materials.signal },
        { radius: 2.15, tilt: 1.15, color: glow },
      ];
      ringSpecs.forEach((spec, index) => {
        const ringGeometry = this.track(new THREE.TorusGeometry(spec.radius, 0.028, 6, 44));
        const ring = this.mesh(ringGeometry, spec.color, this.armillary, `obs-ring-${index}`, {
          cast: false,
          receive: false,
        });
        ring.rotation.x = Math.PI / 2 + spec.tilt;
        ring.rotation.z = index * 0.7;
      });
      /* Three small instruments riding the outer ring. */
      for (let i = 0; i < 3; i++) {
        const angle = (i / 3) * Math.PI * 2;
        const satellite = this.mesh(
          new THREE.IcosahedronGeometry(0.08, 0),
          this.materials.signal,
          this.armillary,
          `obs-satellite-${i}`,
          { cast: false, receive: false },
        );
        satellite.position.set(
          Math.cos(angle) * 2.15,
          Math.sin(angle) * 0.5,
          Math.sin(angle) * 1.7,
        );
        satellite.userData.angle = angle;
      }
      const core = this.mesh(
        new THREE.IcosahedronGeometry(0.2, 1),
        glow,
        this.armillary,
        'obs-core',
        { position: new THREE.Vector3(0, 1.65, 0), cast: false, receive: false },
      );
      core.userData.spin = true;

      /* Three lanterns that light up as the markers are discovered. */
      this.islandLanterns = [];
      for (let i = 0; i < 3; i++) {
        const angle = (i / 3) * Math.PI * 2 + 0.5;
        const lanternMaterial = this.track(
          new THREE.MeshStandardMaterial({
            color: 0x1a1206,
            roughness: 0.35,
            metalness: 0.2,
            emissive: new THREE.Color(this.theme.practical),
            emissiveIntensity: 0,
          }),
        );
        const post = this.mesh(
          new THREE.CylinderGeometry(0.05, 0.07, 0.9, 6),
          this.materials.metal,
          group,
          `obs-lantern-post-${i}`,
          {
            position: new THREE.Vector3(
              Math.cos(angle) * 3.5,
              surface + 0.45,
              Math.sin(angle) * 3.5,
            ),
          },
        );
        post.castShadow = false;
        const lantern = this.mesh(
          new THREE.OctahedronGeometry(0.18, 0),
          lanternMaterial,
          group,
          `obs-lantern-${i}`,
          {
            position: new THREE.Vector3(
              Math.cos(angle) * 3.5,
              surface + 1.02,
              Math.sin(angle) * 3.5,
            ),
            cast: false,
            receive: false,
          },
        );
        this.islandLanterns.push(lantern);
      }

      return { anchorY: 5.2, pickRadius: 4.3, pickHeight: 9, targetY: 3.6 };
    });

    /* The hidden marker for this station, tucked behind the colonnade. */
    this.attachDiscovery(node, new THREE.Vector3(3.3, GROUND + 1.2, 2.5));
  }

  /* ── Station: work pavilion ────────────────────────────────────────── */

  private buildWorkPavilion(): void {
    const accents = [this.theme.signal, this.theme.practical, 0x9db4ff];
    const node = this.registerStation('work', ({ group, surface, glow }) => {
      const exhibits: ExhibitNode[] = [];
      this.mesh(terrace(3.1, 0.55, 0.14), this.materials.stone, group, 'work-terrace', {
        position: new THREE.Vector3(0, GROUND - 0.05, 0),
      });
      this.mesh(rimRing(2.98, 0.045, 44), this.materials.stoneDark, group, 'work-rim', {
        position: new THREE.Vector3(0, surface - 0.05, 0),
      });
      this.mesh(rimRing(2.7, 0.024, 44), glow, group, 'work-rimlight', {
        position: new THREE.Vector3(0, surface - 0.01, 0),
        cast: false,
        receive: false,
      });

      /* Three exhibits on an arc, all facing the island centre. */
      const arcs = [-0.62, 0, 0.62];
      arcs.forEach((angle, index) => {
        const radius = 1.72;
        const x = Math.sin(angle) * radius;
        const z = Math.cos(angle) * radius + 0.35;
        const accent = accents[index];
        const exhibitGlow = this.track(
          new THREE.MeshStandardMaterial({
            color: 0x0a1018,
            roughness: 0.3,
            metalness: 0.1,
            emissive: new THREE.Color(accent),
            emissiveIntensity: 0.5,
          }),
        );
        this.mesh(terrace(0.56, 0.66, 0.08), this.materials.ceramic, group, `work-plinth-${index}`, {
          position: new THREE.Vector3(x, surface, z),
        });
        const vitrine = this.mesh(
          roundedBox(0.72, 0.86, 0.72, 0.05),
          this.materials.glass,
          group,
          `work-vitrine-${index}`,
          { position: new THREE.Vector3(x, surface + 0.66 + 0.43, z), cast: false },
        );
        vitrine.renderOrder = 1;

        /* A distinct emissive core per project, so the exhibits differ. */
        const coreY = surface + 1.12;
        if (index === 0) {
          this.mesh(
            new THREE.IcosahedronGeometry(0.17, 0),
            exhibitGlow,
            group,
            'work-core-kai',
            { position: new THREE.Vector3(x, coreY, z), cast: false, receive: false },
          );
        } else if (index === 1) {
          /* A miniature node graph — the GraphRAG platform. */
          const cluster = new THREE.Group();
          cluster.position.set(x, coreY, z);
          group.add(cluster);
          const ring = 0.14;
          for (let n = 0; n < 4; n++) {
            const a = (n / 4) * Math.PI * 2;
            this.mesh(
              new THREE.SphereGeometry(0.062, 10, 8),
              exhibitGlow,
              cluster,
              `work-core-graph-${n}`,
              {
                position: new THREE.Vector3(
                  Math.cos(a) * ring,
                  Math.sin(a * 2) * 0.09,
                  Math.sin(a) * ring,
                ),
                cast: false,
                receive: false,
              },
            );
          }
          for (let n = 0; n < 4; n++) {
            const a = (n / 4) * Math.PI * 2;
            const b = ((n + 1) / 4) * Math.PI * 2;
            const from = new THREE.Vector3(Math.cos(a) * ring, Math.sin(a * 2) * 0.09, Math.sin(a) * ring);
            const to = new THREE.Vector3(Math.cos(b) * ring, Math.sin(b * 2) * 0.09, Math.sin(b) * ring);
            const edge = this.mesh(
              this.track(unitCylinder(0.012, 5)),
              exhibitGlow,
              cluster,
              `work-core-edge-${n}`,
              { cast: false, receive: false },
            );
            spanMatrix(from, to, edge.matrix);
            edge.matrixAutoUpdate = false;
          }
        } else {
          /* A tuning ring — the RAN optimisation agent. */
          const ringCore = this.mesh(
            this.track(new THREE.TorusGeometry(0.16, 0.028, 6, 22)),
            exhibitGlow,
            group,
            'work-core-hyperran',
            { position: new THREE.Vector3(x, coreY, z), cast: false, receive: false },
          );
          ringCore.rotation.x = Math.PI / 2.6;
        }

        exhibits.push({
          id: ['kai', 'education-platform', 'hyperran'][index],
          station: 'work',
          index,
          anchor: new THREE.Vector3(
            LAYOUT.work.x + Math.cos(LAYOUT.work.yaw) * x + Math.sin(LAYOUT.work.yaw) * z,
            surface + 1.7,
            LAYOUT.work.z - Math.sin(LAYOUT.work.yaw) * x + Math.cos(LAYOUT.work.yaw) * z,
          ),
          pick: vitrine,
          glow: exhibitGlow,
        });
      });

      /* Curved canopy on slender columns. */
      const canopyGeometry = (
        new THREE.CylinderGeometry(3.45, 3.45, 0.12, 40, 1, true, -1.15, 2.3)
      );
      canopyGeometry.rotateZ(Math.PI / 2);
      canopyGeometry.rotateY(-Math.PI / 2);
      const canopy = this.mesh(canopyGeometry, this.materials.ceramic, group, 'work-canopy', {
        position: new THREE.Vector3(0, surface + 2.85, 0.35),
      });
      canopy.material = this.track(
        new THREE.MeshStandardMaterial({
          color: this.theme.stone,
          roughness: 0.7,
          metalness: 0.04,
          side: THREE.DoubleSide,
        }),
      );
      canopy.castShadow = this.quality.shadows;
      canopy.userData.occluder = true;

      const pillarGeometry = this.track(new THREE.CylinderGeometry(0.075, 0.085, 2.85, 8));
      const pillars: THREE.Matrix4[] = [];
      for (const angle of [-0.95, 0, 0.95]) {
        const radius = 3.15;
        pillars.push(
          new THREE.Matrix4().makeTranslation(
            Math.sin(angle) * radius,
            surface + 1.42,
            Math.cos(angle) * radius + 0.35,
          ),
        );
      }
      const pillarMesh = instancedMesh(pillarGeometry, this.materials.metal, pillars, 'work-pillars');
      pillarMesh.castShadow = this.quality.shadows;
      group.add(pillarMesh);

      /* A low bench, so the pavilion reads as a place to sit. */
      this.mesh(roundedBox(1.5, 0.1, 0.42, 0.04), this.materials.ceramic, group, 'work-bench', {
        position: new THREE.Vector3(-1.6, surface + 0.42, -1.5),
      });

      return { anchorY: 3.4, pickRadius: 3.4, pickHeight: 4.2, exhibits };
    });

    this.attachDiscovery(node, new THREE.Vector3(-2.7, GROUND + 0.75, 2.1));
  }

  /* ── Station: knowledge garden ─────────────────────────────────────── */

  private buildKnowledgeGarden(): void {
    const node = this.registerStation('knowledge', ({ group, surface, glow }) => {
      this.mesh(terrace(3, 0.4, 0.12), this.materials.stone, group, 'garden-terrace', {
        position: new THREE.Vector3(0, GROUND - 0.05, 0),
      });
      this.mesh(rimRing(2.88, 0.04, 40), this.materials.stoneDark, group, 'garden-rim', {
        position: new THREE.Vector3(0, surface - 0.04, 0),
      });

      const { nodes, edges } = graphLayout(97, 17, 2.35, 2.3);
      const nodeGeometry = this.track(new THREE.IcosahedronGeometry(0.085, 0));
      const nodeMesh = instancedMesh(nodeGeometry, glow, nodes.map(() => new THREE.Matrix4()), 'graph-nodes');
      const nodeColor = new THREE.Color();
      const dim = new THREE.Color(0x22303f);
      const bright = new THREE.Color(this.theme.signal);
      nodes.forEach((point, index) => {
        const matrix = new THREE.Matrix4();
        const isHub = index % 5 === 0;
        const scale = isHub ? 1.9 : 1;
        matrix.compose(
          new THREE.Vector3(point.x, surface + point.y * 0.42 + 0.35, point.z),
          new THREE.Quaternion(),
          new THREE.Vector3(scale, scale, scale),
        );
        nodeMesh.setMatrixAt(index, matrix);
        nodeColor.copy(dim).lerp(bright, isHub ? 1 : 0.45);
        nodeMesh.setColorAt(index, nodeColor);
      });
      nodeMesh.instanceMatrix.needsUpdate = true;
      if (nodeMesh.instanceColor) nodeMesh.instanceColor.needsUpdate = true;
      nodeMesh.castShadow = false;
      group.add(nodeMesh);

      const edgeGeometry = this.track(unitCylinder(0.011, 5));
      const edgeMatrices = edges.map(([a, b]) => {
        const from = new THREE.Vector3(nodes[a].x, surface + nodes[a].y * 0.42 + 0.35, nodes[a].z);
        const to = new THREE.Vector3(nodes[b].x, surface + nodes[b].y * 0.42 + 0.35, nodes[b].z);
        return spanMatrix(from, to, new THREE.Matrix4());
      });
      const edgeMesh = instancedMesh(edgeGeometry, this.materials.signal, edgeMatrices, 'graph-edges');
      edgeMesh.castShadow = false;
      group.add(edgeMesh);

      /* A pulse that walks a chain of nodes — retrieval, made visible. */
      const chain = nodes
        .slice(0, 8)
        .map((point) => new THREE.Vector3(point.x, surface + point.y * 0.42 + 0.35, point.z));
      this.graphPath = chain;
      this.graphPulse = this.mesh(
        new THREE.SphereGeometry(0.075, 10, 8),
        this.materials.signal,
        group,
        'graph-pulse',
        { cast: false, receive: false },
      );
      this.graphPulse.position.copy(chain[0] ?? new THREE.Vector3(0, surface + 0.6, 0));

      /* Planters and a small reading bench. */
      const planterGeometry = this.track(new THREE.CylinderGeometry(0.36, 0.3, 0.36, 10));
      const planters: THREE.Matrix4[] = [];
      for (let i = 0; i < 5; i++) {
        const angle = (i / 5) * Math.PI * 2 + 0.6;
        planters.push(
          new THREE.Matrix4().makeTranslation(
            Math.cos(angle) * 2.45,
            surface + 0.18,
            Math.sin(angle) * 2.45,
          ),
        );
      }
      group.add(instancedMesh(planterGeometry, this.materials.ceramic, planters, 'garden-planters'));
      const plants = coniferGeometry();
      this.track(plants.lower);
      const plantMatrices = planters.map((matrix) => {
        const position = new THREE.Vector3().setFromMatrixPosition(matrix);
        return new THREE.Matrix4().compose(
          position.clone().setY(position.y + 0.2),
          new THREE.Quaternion(),
          new THREE.Vector3(0.42, 0.5, 0.42),
        );
      });
      group.add(instancedMesh(plants.lower, this.materials.foliage, plantMatrices, 'garden-planting'));

      return { anchorY: 3.1, pickRadius: 3.3, pickHeight: 3.6 };
    });

    this.attachDiscovery(node, new THREE.Vector3(2.3, GROUND + 0.6, -1.9));
  }

  /* ── Station: signal tower ─────────────────────────────────────────── */

  private buildSignalTower(): void {
    this.registerStation('writing', ({ group, surface }) => {
      this.mesh(terrace(2.3, 0.45, 0.12), this.materials.stone, group, 'tower-terrace', {
        position: new THREE.Vector3(0, GROUND - 0.05, 0),
      });
      this.mesh(rimRing(2.2, 0.04, 36), this.materials.stoneDark, group, 'tower-rim', {
        position: new THREE.Vector3(0, surface - 0.04, 0),
      });
      this.mesh(
        new THREE.CylinderGeometry(1.05, 1.25, 0.5, 24),
        this.materials.ceramic,
        group,
        'tower-base',
        { position: new THREE.Vector3(0, surface + 0.25, 0) },
      );

      const mast = latticeMast({
        height: 7,
        baseRadius: 0.78,
        topRadius: 0.2,
        levels: 6,
        detailed: this.quality.detail,
      });
      const strutGeometry = this.track(unitCylinder(0.035, 5));
      const struts = instancedMesh(strutGeometry, this.materials.metal, mast.struts, 'tower-lattice');
      struts.position.set(0, surface + 0.5, 0);
      struts.castShadow = this.quality.shadows;
      group.add(struts);

      /* Parabolic dish with a lit feed. */
      const dish = this.mesh(
        new THREE.SphereGeometry(0.78, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2.7),
        this.track(
          new THREE.MeshStandardMaterial({
            color: this.theme.stone,
            roughness: 0.4,
            metalness: 0.25,
            side: THREE.DoubleSide,
          }),
        ),
        group,
        'tower-dish',
        { position: new THREE.Vector3(0.62, surface + 4.5, 0.2) },
      );
      dish.rotation.set(Math.PI * 0.78, 0, -0.5);
      const feed = this.mesh(
        new THREE.SphereGeometry(0.06, 10, 8),
        this.materials.signal,
        group,
        'tower-feed',
        { position: new THREE.Vector3(0.86, surface + 4.9, 0.42), cast: false, receive: false },
      );
      feed.userData.pulse = true;

      /* The beacon: lens, core and a slow sweeping light. */
      this.mesh(
        new THREE.CylinderGeometry(0.24, 0.3, 0.34, 12),
        this.materials.metal,
        group,
        'tower-lens',
        { position: new THREE.Vector3(0, surface + 7.85, 0) },
      );
      this.beaconCore = this.mesh(
        new THREE.SphereGeometry(0.2, 14, 10),
        this.materials.signal,
        group,
        'tower-core',
        { position: new THREE.Vector3(0, surface + 8.12, 0), cast: false, receive: false },
      );
      const beaconRing = this.mesh(
        new THREE.TorusGeometry(0.44, 0.03, 5, 28),
        this.materials.signal,
        group,
        'tower-ring',
        { position: new THREE.Vector3(0, surface + 7.7, 0), cast: false, receive: false },
      );
      beaconRing.rotation.x = Math.PI / 2;
      this.mesh(
        new THREE.CylinderGeometry(0.015, 0.015, 0.9, 6),
        this.materials.metal,
        group,
        'tower-spire',
        { position: new THREE.Vector3(0, surface + 8.6, 0), cast: false },
      );

      this.searchlight = new THREE.Group();
      this.searchlight.position.set(0, surface + 8.05, 0);
      group.add(this.searchlight);
      const coneGeometry = this.track(new THREE.ConeGeometry(1.5, 3.4, 18, 1, true));
      coneGeometry.translate(0, -1.7, 0);
      const coneMaterial = this.track(
        new THREE.MeshBasicMaterial({
          color: this.theme.signal,
          transparent: true,
          opacity: 0.08,
          depthWrite: false,
          side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending,
          fog: true,
        }),
      );
      const cone = new THREE.Mesh(coneGeometry, coneMaterial);
      cone.rotation.z = 0.62;
      cone.renderOrder = 3;
      this.searchlight.add(cone);

      /* Guy wires anchor the mast to the terrace. */
      if (this.quality.detail) {
        const wireGeometry = this.track(unitCylinder(0.012, 4));
        const wires: THREE.Matrix4[] = [];
        for (let i = 0; i < 3; i++) {
          const angle = (i / 3) * Math.PI * 2 + 0.4;
          wires.push(
            spanMatrix(
              new THREE.Vector3(0, surface + 6.4, 0),
              new THREE.Vector3(Math.cos(angle) * 1.9, surface + 0.1, Math.sin(angle) * 1.9),
              new THREE.Matrix4(),
            ),
          );
        }
        group.add(instancedMesh(wireGeometry, this.materials.metalDark, wires, 'tower-wires'));
      }

      return { anchorY: 9.4, pickRadius: 2.1, pickHeight: 10 };
    });
  }

  /* ── Station: personal studio ──────────────────────────────────────── */

  private buildStudio(): void {
    this.registerStation('studio', ({ group, surface }) => {
      this.mesh(terrace(2.6, 0.5, 0.12), this.materials.stone, group, 'studio-terrace', {
        position: new THREE.Vector3(0, GROUND - 0.05, 0),
      });
      this.mesh(rimRing(2.5, 0.04, 36), this.materials.stoneDark, group, 'studio-rim', {
        position: new THREE.Vector3(0, surface - 0.04, 0),
      });

      const room = roundedBox(2.7, 1.55, 2.05, 0.1);
      this.mesh(room, this.materials.ceramic, group, 'studio-room', {
        position: new THREE.Vector3(0, surface + 0.78, -0.15),
        occluder: true,
      });
      /* Shed roof, tilted toward the island. */
      const roof = this.mesh(
        roundedBox(3.05, 0.14, 2.4, 0.05),
        this.materials.metalDark,
        group,
        'studio-roof',
        { position: new THREE.Vector3(0, surface + 1.63, -0.15) },
      );
      roof.rotation.x = -0.1;
      /* A second, taller roof plane makes the silhouette read as a workshop. */
      const lantern = this.mesh(
        roundedBox(1.1, 0.34, 0.9, 0.04),
        this.materials.ceramic,
        group,
        'studio-lantern',
        { position: new THREE.Vector3(-0.65, surface + 1.87, -0.15) },
      );
      lantern.rotation.x = -0.1;

      /* The window, with a warm interior behind it. */
      const windowGlow = this.track(
        new THREE.MeshStandardMaterial({
          color: 0x1a1206,
          roughness: 0.6,
          emissive: new THREE.Color(this.theme.practical),
          emissiveIntensity: 1.5,
        }),
      );
      this.mesh(
        new THREE.BoxGeometry(1.12, 0.78, 0.04),
        windowGlow,
        group,
        'studio-window-glow',
        { position: new THREE.Vector3(0.35, surface + 0.86, 0.9), cast: false, receive: false },
      );
      this.mesh(
        roundedBox(1.24, 0.9, 0.07, 0.03),
        this.materials.glass,
        group,
        'studio-window',
        { position: new THREE.Vector3(0.35, surface + 0.86, 0.92), cast: false },
      );
      this.mesh(
        roundedBox(0.52, 0.98, 0.07, 0.03),
        this.materials.metalDark,
        group,
        'studio-door',
        { position: new THREE.Vector3(-0.72, surface + 0.5, 0.92) },
      );
      /* A bench and a lamp by the door. */
      this.mesh(roundedBox(1.1, 0.09, 0.36, 0.03), this.materials.ceramic, group, 'studio-bench', {
        position: new THREE.Vector3(1.35, surface + 0.4, 1.35),
      });
      const lampMaterial = this.track(
        new THREE.MeshStandardMaterial({
          color: 0x1a1206,
          roughness: 0.4,
          emissive: new THREE.Color(this.theme.practical),
          emissiveIntensity: 1.6,
        }),
      );
      this.mesh(
        new THREE.CylinderGeometry(0.035, 0.045, 1.1, 6),
        this.materials.metalDark,
        group,
        'studio-lamp-post',
        { position: new THREE.Vector3(-1.55, surface + 0.55, 1.1) },
      );
      this.mesh(
        new THREE.SphereGeometry(0.13, 12, 8),
        lampMaterial,
        group,
        'studio-lamp',
        { position: new THREE.Vector3(-1.55, surface + 1.18, 1.1), cast: false, receive: false },
      );

      return { anchorY: 2.9, pickRadius: 2.4, pickHeight: 3.2 };
    });
  }

  /* ── Station: contact beacon ───────────────────────────────────────── */

  private buildContactBeacon(): void {
    this.registerStation('contact', ({ group, surface, glow }) => {
      this.mesh(terrace(2.5, 0.45, 0.12), this.materials.stone, group, 'beacon-terrace', {
        position: new THREE.Vector3(0, GROUND - 0.05, 0),
      });
      this.mesh(rimRing(2.4, 0.04, 36), this.materials.stoneDark, group, 'beacon-rim', {
        position: new THREE.Vector3(0, surface - 0.04, 0),
      });
      this.beaconLantern = this.mesh(
        rimRing(1.95, 0.045, 44),
        glow,
        group,
        'beacon-ringlight',
        { position: new THREE.Vector3(0, surface + 0.01, 0), cast: false, receive: false },
      );

      /* The beacon column and its breathing lantern. */
      this.mesh(
        new THREE.CylinderGeometry(0.26, 0.34, 1.9, 14),
        this.materials.ceramic,
        group,
        'beacon-column',
        { position: new THREE.Vector3(0, surface + 0.95, 0) },
      );
      const lanternMaterial = this.track(
        new THREE.MeshStandardMaterial({
          color: 0x1a1206,
          roughness: 0.28,
          metalness: 0.1,
          emissive: new THREE.Color(this.theme.practical),
          emissiveIntensity: 1.6,
          transparent: true,
          opacity: 0.94,
        }),
      );
      this.mesh(
        new THREE.OctahedronGeometry(0.3, 0),
        lanternMaterial,
        group,
        'beacon-lantern',
        { position: new THREE.Vector3(0, surface + 2.28, 0), cast: false, receive: false },
      );
      this.mesh(
        new THREE.CylinderGeometry(0.06, 0.09, 0.34, 8),
        this.materials.metal,
        group,
        'beacon-cap',
        { position: new THREE.Vector3(0, surface + 2.58, 0) },
      );

      /* A gateway canopy facing the avenue. */
      const arch = this.mesh(
        new THREE.TorusGeometry(1.35, 0.07, 6, 24, Math.PI),
        this.materials.ceramic,
        group,
        'beacon-arch',
        { position: new THREE.Vector3(0, surface + 2.2, -1.15) },
      );
      arch.rotation.y = Math.PI / 2;
      arch.castShadow = this.quality.shadows;
      const postGeometry = this.track(new THREE.CylinderGeometry(0.07, 0.08, 2.2, 8));
      const posts: THREE.Matrix4[] = [];
      for (const z of [-1.15, 1.15]) {
        posts.push(new THREE.Matrix4().makeTranslation(-1.35, surface + 1.1, z));
      }
      group.add(instancedMesh(postGeometry, this.materials.ceramic, posts, 'beacon-posts'));

      return { anchorY: 3.3, pickRadius: 2.5, pickHeight: 3.6 };
    });
  }

  /* ── Discovery markers ─────────────────────────────────────────────── */

  private attachDiscovery(node: StationNode, position: THREE.Vector3): void {
    const geometry = this.track(crystalGeometry());
    const material = this.track(
      new THREE.MeshStandardMaterial({
        color: 0x2a1b06,
        roughness: 0.24,
        metalness: 0.2,
        emissive: new THREE.Color(this.theme.practical),
        emissiveIntensity: 0.9,
        transparent: true,
        opacity: 0.92,
      }),
    );
    const mesh = this.mesh(geometry, material, node.group, `discovery-${node.id}`, {
      position,
      cast: false,
      receive: false,
    });
    const haloMaterial = this.track(
      new THREE.MeshBasicMaterial({
        color: this.theme.practical,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      }),
    );
    const halo = this.mesh(
      new THREE.SphereGeometry(0.42, 12, 8),
      haloMaterial,
      node.group,
      `discovery-halo-${node.id}`,
      { position: position.clone(), cast: false, receive: false },
    );

    const world = position.clone();
    node.group.updateMatrixWorld(true);
    world.applyMatrix4(node.group.matrixWorld);

    node.discovery = {
      station: node.id,
      label: node.id,
      mesh,
      halo,
      found: false,
      position: world,
    };
    /* Discovery markers are pickable, in addition to their station proxy. */
    mesh.userData.discoveryOf = node.id;
  }

  /* ── Guide drone ───────────────────────────────────────────────────── */

  private buildDrone(): void {
    const parts = buildDroneGeometry();
    this.track(parts.body);
    this.track(parts.shell);
    this.track(parts.arm);
    this.track(parts.rotor);
    this.track(parts.eye);

    this.drone.name = 'guide-drone';
    this.drone.position.copy(this.dronePosition);
    const bodyMaterial = this.track(
      new THREE.MeshStandardMaterial({
        color: this.theme.stone,
        roughness: 0.35,
        metalness: 0.25,
      }),
    );
    const shellMaterial = this.track(
      new THREE.MeshStandardMaterial({
        color: this.theme.metal,
        roughness: 0.3,
        metalness: 0.6,
      }),
    );
    const details = new THREE.Group();
    this.drone.add(details);

    const body = new THREE.Mesh(parts.body, bodyMaterial);
    body.castShadow = this.quality.shadows;
    details.add(body);
    const shell = new THREE.Mesh(parts.shell, shellMaterial);
    shell.castShadow = false;
    details.add(shell);

    this.rotorGroup = new THREE.Group();
    details.add(this.rotorGroup);
    const armMaterial = shellMaterial;
    for (const [dx, dz] of [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ]) {
      const arm = new THREE.Mesh(parts.arm, armMaterial);
      arm.position.set(dx * 0.19, 0.02, dz * 0.19);
      arm.rotation.y = Math.atan2(dz, dx);
      this.rotorGroup.add(arm);
      const rotor = new THREE.Mesh(parts.rotor, this.materials.signal);
      rotor.position.set(dx * 0.36, 0.03, dz * 0.36);
      rotor.userData.spin = dx * dz;
      this.rotorGroup.add(rotor);
    }
    const eye = new THREE.Mesh(parts.eye, this.materials.signal);
    eye.position.set(0, 0.02, 0.17);
    details.add(eye);
    const eyeHalo = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 10, 8),
      this.track(
        new THREE.MeshBasicMaterial({
          color: this.theme.signal,
          transparent: true,
          opacity: 0.3,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          fog: false,
        }),
      ),
    );
    eyeHalo.position.copy(eye.position);
    details.add(eyeHalo);

    this.group.add(this.drone);

    /* The drone's light is only worth a shadow-less point light at full quality. */
    if (this.quality.droneLight) {
      const light = new THREE.PointLight(this.theme.signal, 1.1, 6, 2);
      light.position.set(0, -0.1, 0);
      this.drone.add(light);
    }
  }

  /* ── Travelling signals ────────────────────────────────────────────── */

  private buildSignals(): void {
    const geometry = this.track(new THREE.SphereGeometry(0.06, 8, 6));
    for (let i = 0; i < this.quality.signalCount; i++) {
      const mesh = new THREE.Mesh(geometry, this.materials.signal);
      mesh.name = `signal-${i}`;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.renderOrder = 2;
      this.group.add(mesh);
      this.signals.push({
        mesh,
        t: i / this.quality.signalCount,
        speed: 0.035 + (i % 3) * 0.008,
        curve: this.ringCurve,
      });
    }
  }

  /** Send a light pulse from the observatory to a station. */
  triggerSignal(id: StationId): void {
    const curve = this.spurCurves.get(id);
    if (!curve) return;
    if (!this.flight) {
      const geometry = this.track(new THREE.SphereGeometry(0.1, 10, 8));
      const mesh = new THREE.Mesh(geometry, this.materials.signal);
      mesh.renderOrder = 3;
      mesh.castShadow = false;
      this.group.add(mesh);
      this.flight = { mesh, curve, t: 0 };
    }
    this.flight.curve = curve;
    this.flight.t = 0;
    this.flight.mesh.visible = true;
    /* Move the drone toward the new destination too. */
    const target = this.stations.get(id);
    if (target) {
      this.droneTarget.copy(target.anchor).add(new THREE.Vector3(0, 1.9, 0));
    }
  }

  /* ── Theming and quality ───────────────────────────────────────────── */

  setTheme(theme: WorldTheme): void {
    this.theme = theme;
    for (const [id, material] of this.glowMaterials) {
      material.emissive.setHex(this.accentFor(id));
    }
    for (const lantern of this.islandLanterns) {
      const material = lantern.material as THREE.MeshStandardMaterial;
      material.emissive.setHex(theme.practical);
    }
    for (const exhibit of this.exhibits.values()) {
      /* Vitrine accents keep their identity across themes. */
      exhibit.glow.emissiveIntensity = theme.emissive * 0.4;
    }
    if (this.beaconCore) {
      (this.beaconCore.material as THREE.MeshStandardMaterial).emissive.setHex(theme.signal);
    }

    /* Atmosphere-adjacent pieces that are painted rather than lit. */
    for (const layer of this.mistLayers) {
      const material = layer.material as THREE.MeshBasicMaterial;
      material.color.setHex(theme.mist);
      material.opacity = theme.name === 'light' ? 0.34 : 0.18;
    }
    if (this.hills) {
      this.setHillColors(new THREE.Color(), new THREE.Color(), new THREE.Color(), this.hillFade, this.hills);
    }
    if (this.searchlightMaterial) {
      this.searchlightMaterial.color.setHex(theme.signal);
      this.searchlightMaterial.opacity = theme.name === 'light' ? 0.05 : 0.09;
    }
    if (this.flight) {
      (this.flight.mesh.material as THREE.MeshStandardMaterial).emissive.setHex(theme.signal);
    }
  }

  setQuality(quality: QualitySettings): void {
    this.quality = quality;
    this.mistLayers.forEach((layer, index) => {
      layer.visible = index < quality.mistLayers;
    });
    this.signals.forEach((signal, index) => {
      signal.mesh.visible = index < quality.signalCount;
    });
    this.searchlight.visible = quality.detail;
  }

  /** Switch on a lantern for each discovery found. */
  applyDiscoveries(found: StationId[]): void {
    found.forEach((id, index) => {
      const node = this.stations.get(id);
      if (!node?.discovery) return;
      node.discovery.found = true;
      node.discovery.mesh.visible = false;
      node.discovery.halo.visible = false;
      const lantern = this.islandLanterns[index];
      if (lantern) {
        (lantern.material as THREE.MeshStandardMaterial).emissiveIntensity = 2.2;
      }
    });
  }

  /* ── Animation ─────────────────────────────────────────────────────── */

  update(t: number, delta: number): void {
    const step = delta;

    /* Orbital instrument: slow, deliberate, never a spin. */
    if (this.armillary) {
      this.armillary.rotation.y = t * 0.085;
      this.armillary.children.forEach((child) => {
        if (child.userData.spin) {
          child.rotation.y = t * 0.35;
          child.rotation.x = t * 0.22;
        }
      });
    }

    /* Practical lamps breathe very slightly, so the world is never dead. */
    if (this.beaconCore) {
      const pulse = 0.85 + Math.sin(t * 1.1) * 0.15;
      (this.beaconCore.material as THREE.MeshStandardMaterial).emissiveIntensity =
        this.theme.emissive * pulse * 1.4;
    }
    if (this.beaconLantern) {
      (this.beaconLantern.material as THREE.MeshStandardMaterial).emissiveIntensity =
        this.theme.emissive * (0.7 + Math.sin(t * 1.1) * 0.25);
    }
    if (this.searchlight.visible) {
      this.searchlight.rotation.y = t * 0.16;
    }

    /* Knowledge garden pulse walking the graph. */
    if (this.graphPath.length > 1) {
      const span = this.graphPath.length - 1;
      const cycle = 7;
      /* Normalise into [0, cycle) so any clock value stays in range. */
      const progress = (((t % cycle) + cycle) % cycle) / cycle;
      const scaled = progress * span;
      const index = Math.min(Math.max(Math.floor(scaled), 0), span - 1);
      this.graphPulse.position.lerpVectors(
        this.graphPath[index],
        this.graphPath[index + 1],
        scaled - index,
      );
    }

    /* Mist drifts, and never leaves the island's shadow. */
    for (const layer of this.mistLayers) {
      if (!layer.visible) continue;
      layer.rotation.y += (layer.userData.drift as number) * step * 6;
      layer.position.y += Math.sin(t * 0.25 + (layer.userData.bob as number)) * 0.004;
    }

    /* Signals travelling the pathways. */
    for (const signal of this.signals) {
      if (!signal.mesh.visible) continue;
      signal.t = (signal.t + signal.speed * step) % 1;
      const point = signal.curve.getPointAt(signal.t);
      signal.mesh.position.copy(point);
      signal.mesh.position.y += 0.09;
    }

    /* The one-off pulse when a destination is chosen. */
    if (this.flight) {
      this.flight.t += step * 0.85;
      if (this.flight.t >= 1) {
        this.flight.mesh.visible = false;
        this.flight = null;
      } else {
        const point = this.flight.curve.getPointAt(this.flight.t);
        this.flight.mesh.position.copy(point);
        const material = this.flight.mesh.material as THREE.MeshStandardMaterial;
        material.emissiveIntensity = this.theme.emissive * (1 - this.flight.t) * 2;
        this.flight.mesh.scale.setScalar(1 + this.flight.t * 0.6);
      }
    }

    /* Guide drone: eases toward its destination and banks into the turn. */
    const droneAnchor = this.droneTarget.lengthSq() > 0 ? this.droneTarget : this.idleDronePoint(t);
    const previous = this.dronePosition.clone();
    this.dronePosition.lerp(droneAnchor, Math.min(1, step * 0.9));
    this.dronePosition.y += Math.sin(t * 1.6) * 0.006;
    this.drone.position.copy(this.dronePosition);
    this.drone.lookAt(droneAnchor.x, droneAnchor.y + 1.2, droneAnchor.z);
    const velocity = this.dronePosition.clone().sub(previous);
    this.drone.rotation.z = THREE.MathUtils.clamp(-velocity.x * 0.25, -0.28, 0.28);
    this.drone.rotation.x = THREE.MathUtils.clamp(velocity.z * 0.22, -0.24, 0.24);
    if (this.rotorGroup) {
      this.rotorGroup.children.forEach((child) => {
        if (child.userData.spin) child.rotation.y = t * 22 * (child.userData.spin as number);
      });
    }

    /* Station accents ease toward their hover / active state. */
    for (const node of this.stations.values()) {
      const target = node.active > 0.5 ? 2.4 : node.hover > 0.5 ? 1.4 : 0.35;
      node.glow.emissiveIntensity = THREE.MathUtils.damp(
        node.glow.emissiveIntensity,
        target * this.theme.emissive,
        6,
        delta,
      );
    }

    /* Discovery markers turn slowly so they catch the light. */
    for (const node of this.stations.values()) {
      const discovery = node.discovery;
      if (!discovery || discovery.found) continue;
      discovery.mesh.rotation.y = t * 0.6;
      discovery.mesh.rotation.x = Math.sin(t * 0.4) * 0.2;
      const halo = discovery.halo.material as THREE.MeshBasicMaterial;
      halo.opacity = 0.1 + Math.sin(t * 1.4 + discovery.mesh.position.x) * 0.06;
    }
  }

  private idleDronePoint(t: number): THREE.Vector3 {
    const angle = t * 0.12;
    return new THREE.Vector3(Math.cos(angle) * 6.5, GROUND + 7.4, Math.sin(angle) * 6.5);
  }

  /** Mark a station as the active destination. Hover is owned by the pointer
   *  and hotspot handlers, so the two never fight over the same property. */
  setStationState(id: StationId | null): void {
    for (const node of this.stations.values()) {
      node.active = node.id === id ? 1 : 0;
    }
  }

  /** All objects the pointer may hit: station volumes plus discovery markers. */
  pickTargets(): THREE.Object3D[] {
    const targets: THREE.Object3D[] = [];
    for (const node of this.stations.values()) {
      targets.push(node.pick);
      if (node.discovery && !node.discovery.found) targets.push(node.discovery.mesh);
      for (const exhibit of node.exhibits) targets.push(exhibit.pick);
    }
    return targets;
  }

  /**
   * Objects that can plausibly hide a station label: the island, the
   * observatory's own mass and the studio's roof volume. Deliberately tight
   * — the generous station hit-volumes are *not* used here, because they
   * hid labels for stations that were plainly visible.
   */
  occluders(): THREE.Object3D[] {
    if (this.occluderList.length === 0) {
      this.group.traverse((object) => {
        if (object.userData.occluder === true) this.occluderList.push(object);
      });
    }
    return this.occluderList;
  }

  stats(): WorldStats {
    let triangles = 0;
    let drawCalls = 0;
    this.group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || !mesh.visible) return;
      drawCalls++;
      const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
      if (!geometry?.index && !geometry?.attributes.position) return;
      const count = geometry.index
        ? geometry.index.count
        : (geometry.attributes.position?.count ?? 0);
      const instances = (mesh as THREE.InstancedMesh).isInstancedMesh
        ? (mesh as THREE.InstancedMesh).count
        : 1;
      triangles += (count / 3) * instances;
    });
    return { triangles: Math.round(triangles), drawCalls };
  }

  dispose(): void {
    this.group.traverse((object) => {
      const geometry = (object as Partial<THREE.Mesh>).geometry;
      geometry?.dispose();
    });
    for (const item of this.disposables) item.dispose();
    this.disposables.length = 0;
    this.pickMaterial.dispose();
    this.group.clear();
  }
}
