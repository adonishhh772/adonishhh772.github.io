/**
 * The observatory campus.
 *
 * One compact, art-directed island holding every destination of the site: a
 * central instrument with a moving orbital mechanism, a personal studio with
 * a working desk, a project workshop, a reading library, an open-source
 * workbench and a contact station — joined by lit walkways, patrolled by a
 * small guide drone, and hiding three light markers that switch the
 * observatory's lanterns on.
 *
 * Everything is procedural. No external models, no texture downloads.
 */

import * as THREE from 'three';
import type { DestinationId } from '../world/destinations';
import type { WorldIndex } from '../world/state';
import type { Materials } from './materials';
import {
  boulderGeometry,
  broadleafGeometry,
  buildDroneGeometry,
  cloudGeometry,
  coniferGeometry,
  crystalGeometry,
  curveFrom,
  distantRidges,
  instancedMesh,
  islandEnvelopeAt,
  islandGeometry,
  latticeMast,
  mulberry32,
  offsetPoints,
  paintCloud,
  paintIsland,
  radialFalloffTexture,
  ribbon,
  ribGeometry,
  ribbedDome,
  ridgeGeometry,
  rimRing,
  roundedBox,
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

/**
 * How high the camera may sit above the plateau before a caption stops being
 * worth projecting — the ceiling of the volume the visitor is allowed to fly
 * through. Shared with the camera rig's clearance tests.
 */
export const CAMERA_CEILING = 34;

/**
 * The horizontal radius of the island at a given height.
 *
 * Kept in step with the lathe profile the island is actually built from, so
 * the boulders bedded into the cliff and the camera's own clearance test agree
 * with the mesh rather than with a second, drifting copy of the numbers.
 */
function cliffRadiusAt(y: number): number {
  return islandEnvelopeAt(y);
}

/** The radius of the plateau at the height a prop is bedded into it. */
function plateauRadius(): number {
  return islandEnvelopeAt(GROUND - 0.05) - 0.02;
}

interface PlaceLayout {
  x: number;
  z: number;
  pad: number;
  padHeight: number;
  /** Rotation that turns the place's local +Z toward the island centre. */
  yaw: number;
}

/** Radius of the ring of destinations around the campus landmark. */
const RING_RADIUS = 9.2;

/**
 * Where the ring is rotated to.
 *
 * The campus is a ring, so the bearing the camera starts from decides which of
 * the five destinations are in front of the observatory and which are behind
 * it. Only side-to-side position decides visibility from a high angle like
 * this, so the bearings are projected onto the camera's own left-right axis
 * and the ring is turned until their mean is zero — the arrangement in which
 * the five are spread as evenly as a ring allows across the frame, and none of
 * them is hidden by the landmark at the centre.
 *
 * Before this, the workbench sat directly behind the observatory from the
 * overview: it was on the map, its caption was projected, and its building
 * could not be seen at all without dragging the camera round the island.
 */
const RING_ROTATION = 22;

/**
 * Placement is an art-direction decision, not an arbitrary one. The overview
 * camera looks in from roughly 44 degrees east of north, so the studio, the
 * workshop, the library and the contact station all sit inside that view
 * cone and read the moment the world appears; the workbench sits behind the
 * landmark and is reached from the dock.
 */
function layoutAt(degrees: number, radius: number, pad: number, padHeight: number): PlaceLayout {
  const angle = (degrees * Math.PI) / 180;
  const x = Math.sin(angle) * radius;
  const z = Math.cos(angle) * radius;
  return { x, z, pad, padHeight, yaw: radius === 0 ? 0 : Math.atan2(-x, -z) };
}

/** Convert a place-local point into campus space. */
function localToWorld(layout: PlaceLayout, x: number, y: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(
    layout.x + Math.cos(layout.yaw) * x + Math.sin(layout.yaw) * z,
    y,
    layout.z - Math.sin(layout.yaw) * x + Math.cos(layout.yaw) * z,
  );
}

const LAYOUT: Record<DestinationId, PlaceLayout> = {
  campus: layoutAt(0, 0, 4.3, 0.9),
  studio: layoutAt(-45 + RING_ROTATION, RING_RADIUS, 3, 0.5),
  workshop: layoutAt(0 + RING_ROTATION, RING_RADIUS, 3.2, 0.55),
  library: layoutAt(50 + RING_ROTATION, RING_RADIUS, 3, 0.45),
  contact: layoutAt(115 + RING_ROTATION, RING_RADIUS, 2.4, 0.45),
  workbench: layoutAt(212 + RING_ROTATION, RING_RADIUS, 3.1, 0.4),
};

/** Walkway order — the ring, sorted by angle around the island. */
const RING_ORDER: DestinationId[] = ['studio', 'workshop', 'library', 'contact', 'workbench'];
export interface Shot {
  position: THREE.Vector3;
  target: THREE.Vector3;
  fov: number;
}

/**
 * Content objects that are not articles, projects or repositories: the
 * subscribe handbill beside the library and the message hatch at the contact
 * station. Both are ordinary documents of the site, reached as objects in the
 * world.
 */
export interface ObjectMarker {
  id: string;
  kind: 'article' | 'project' | 'repo' | 'cv' | 'about' | 'newsletter' | 'contact';
  place: DestinationId;
  label: string;
  meta: string;
  href: string;
  /** World position for the DOM caption. */
  anchor: THREE.Vector3;
  /** Raycast target. */
  pick: THREE.Mesh;
}

export interface ExhibitNode {
  id: string;
  place: DestinationId;
  index: number;
  anchor: THREE.Vector3;
  pick: THREE.Mesh;
  glow: THREE.MeshStandardMaterial;
}

export interface DiscoveryNode {
  place: DestinationId;
  label: string;
  mesh: THREE.Mesh;
  halo: THREE.Mesh;
  found: boolean;
  position: THREE.Vector3;
}

export interface PlaceNode {
  id: DestinationId;
  group: THREE.Group;
  /** Where the DOM hotspot label attaches. */
  anchor: THREE.Vector3;
  /** Camera look-at when the place is framed. */
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
  readonly places = new Map<DestinationId, PlaceNode>();
  readonly exhibits = new Map<string, ExhibitNode>();
  /** Pickable objects for articles, repositories and projects. */
  readonly objectMarkers: ObjectMarker[] = [];

  private readonly materials: Materials;
  private readonly atmosphere: Atmosphere;
  private quality: QualitySettings;
  private theme: WorldTheme;
  private readonly index: WorldIndex;

  /** Materials whose emissive intensity is animated per place. */
  private readonly glowMaterials = new Map<DestinationId, THREE.MeshStandardMaterial>();

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
  private billMaterial: THREE.MeshStandardMaterial | null = null;
  private mistGroup = new THREE.Group();
  private mistLayers: THREE.Mesh[] = [];
  /** Soft stylised clouds, drifting above the island. */
  private cloudGroup = new THREE.Group();
  private clouds: THREE.Mesh[] = [];
  private drone = new THREE.Group();
  private rotorGroup = new THREE.Group();

  /* Signals along the pathways */
  private signals: { mesh: THREE.Mesh; t: number; speed: number; curve: THREE.CatmullRomCurve3 }[] = [];
  private flight: { mesh: THREE.Mesh; curve: THREE.CatmullRomCurve3; t: number } | null = null;
  private spurCurves = new Map<DestinationId, THREE.CatmullRomCurve3>();
  private ringCurve!: THREE.CatmullRomCurve3;
  private droneTarget = new THREE.Vector3();
  private dronePosition = new THREE.Vector3(0, 9, 12);

  private readonly occluderList: THREE.Object3D[] = [];
  /** The island's mesh and geometry, kept so the bands can be repainted. */
  private islandGeometry: THREE.BufferGeometry | null = null;
  /** The light switch standing on the observatory terrace. */
  private switchPick: THREE.Mesh | null = null;
  private switchLever: THREE.Mesh | null = null;
  /** Solid volumes the camera must keep out of, in world space. */
  private readonly solids: {
    x: number;
    z: number;
    radius: number;
    top: number;
  }[] = [];
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
    index: WorldIndex = { articles: [], projects: [], repos: [] },
  ) {
    this.theme = theme;
    this.index = index;
    this.quality = quality;
    this.materials = materials;
    this.atmosphere = atmosphere;
    this.group.name = 'observatory-world';

    this.buildIsland();
    this.buildLandscape();
    this.buildPathways();
    this.buildCampusLandmark();
    this.buildStudio();
    this.buildWorkshop();
    this.buildLibrary();
    this.buildWorkbench();
    this.buildContactStation();
    this.buildSubscribePost();
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
    const studio = this.placeLayout('studio');
    const library = this.placeLayout('library');
    const contact = this.placeLayout('contact');
    /* In front of the studio's open face, so the room reads as lit from the
       angle the camera actually approaches it. */
    const studioOut = new THREE.Vector3(studio.origin.x, 0, studio.origin.z).normalize();
    this.atmosphere.setPractical(
      0,
      new THREE.Vector3(
        studio.origin.x + studioOut.x * 2.4,
        studio.surface + 1.05,
        studio.origin.z + studioOut.z * 2.4,
      ),
      16,
      this.theme.practical,
    );
    const libraryOut = new THREE.Vector3(library.origin.x, 0, library.origin.z).normalize();
    this.atmosphere.setPractical(
      1,
      new THREE.Vector3(
        library.origin.x + libraryOut.x * 2.3,
        library.surface + 1.2,
        library.origin.z + libraryOut.z * 2.3,
      ),
      13,
      this.theme.practical,
    );
    this.atmosphere.setPractical(
      2,
      new THREE.Vector3(contact.origin.x, contact.surface + 2.3, contact.origin.z),
      7,
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
      /** Counts as a real occluder when projecting place labels. */
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

  private accentMaterial(place: DestinationId, color: number): THREE.MeshStandardMaterial {
    const material = this.track(
      new THREE.MeshStandardMaterial({
        color: 0x0a1018,
        roughness: 0.35,
        metalness: 0.1,
        emissive: new THREE.Color(color),
        emissiveIntensity: 0.35,
      }),
    );
    this.glowMaterials.set(place, material);
    return material;
  }

  private placeLayout(id: DestinationId): { layout: PlaceLayout; surface: number; origin: THREE.Vector3 } {
    const layout = LAYOUT[id];
    const surface = GROUND - 0.05 + layout.padHeight;
    return { layout, surface, origin: new THREE.Vector3(layout.x, surface, layout.z) };
  }

  /** Camera shot that frames a place from outside the island. */
  private shotFor(id: DestinationId, accentHeight = 1.4): Shot {
    const { layout, surface } = this.placeLayout(id);
    const outward = new THREE.Vector3(layout.x, 0, layout.z);
    if (outward.lengthSq() < 0.001) {
      return {
        position: new THREE.Vector3(13.5, 9, 17),
        target: new THREE.Vector3(0, 3.4, 0),
        fov: 40,
      };
    }
    outward.normalize();
    /*
     * Approach from a three-quarter angle rather than radially: looking
     * straight in from outside would put the campus landmark directly behind
     * every destination, and the subject would read as part of it.
     */
    const swing = Math.PI * 0.21;
    const view = new THREE.Vector3(
      outward.x * Math.cos(swing) - outward.z * Math.sin(swing),
      0,
      outward.x * Math.sin(swing) + outward.z * Math.cos(swing),
    );
    const distance = 8.4 + layout.pad * 0.7;
    const position = new THREE.Vector3(
      layout.x + view.x * distance,
      surface + 3.4,
      layout.z + view.z * distance,
    );
    const target = new THREE.Vector3(layout.x, surface + accentHeight, layout.z);
    return { position, target, fov: 36 };
  }

  private registerPlace(
    id: DestinationId,
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
  ): PlaceNode {
    const { layout, surface, origin } = this.placeLayout(id);
    const group = new THREE.Group();
    group.name = `place-${id}`;
    group.position.set(layout.x, 0, layout.z);
    group.rotation.y = layout.yaw;
    this.group.add(group);

    const glow = this.accentMaterial(id, this.accentFor(id));
    const result = build({ group, surface, origin, glow });

    /* A generous, invisible hit volume makes place selection forgiving. */
    const pickRadius = result.pickRadius ?? layout.pad + 0.4;
    const pickHeight = result.pickHeight ?? 3.2;
    const pickGeometry = this.track(
      new THREE.CylinderGeometry(pickRadius, pickRadius, pickHeight, 10, 1, false),
    );
    const pick = new THREE.Mesh(pickGeometry, this.pickMaterial);
    pick.name = `pick-${id}`;
    pick.position.set(layout.x, surface + pickHeight / 2 - 0.2, layout.z);
    this.group.add(pick);

    const node: PlaceNode = {
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
    this.places.set(id, node);
    return node;
  }

  /** Distinct accent per workshop installation, cycling the palette. */
  private exhibitAccent(index: number): number {
    const palette = [this.theme.signal, this.theme.practical, 0x9db4ff, 0x7fd6a8];
    return palette[index % palette.length];
  }

  private accentFor(id: DestinationId): number {
    switch (id) {
      case 'studio':
      case 'library':
      case 'contact':
        return this.theme.practical;
      default:
        return this.theme.signal;
    }
  }

  /**
   * A row of lit windows set into a wall.
   *
   * Windows are what tell a visitor at night that a building is a building and
   * not a rock: they give it a scale, a floor line and a reason to be lit.
   * Separate panes rather than one painted stripe, because the gaps between
   * them are what make the row read as a wall with windows in it — and they
   * use the shared window material, so they come on and go off with every
   * other window in the world as the light changes.
   *
   * `axis` is the wall's normal: 'z' faces the side a place is approached from,
   * 'x' the perpendicular one.
   */
  private windowBand(
    parent: THREE.Object3D,
    name: string,
    options: {
      axis: 'x' | 'z';
      /** Centre of the row, at the wall's surface. */
      at: THREE.Vector3;
      /** Total length of the row and how many panes share it. */
      length: number;
      count: number;
      height: number;
      /** How far the panes stand proud of the wall. */
      offset: number;
      /** Which way along the wall's normal the row faces. */
      reverse?: boolean;
    },
  ): THREE.Group {
    const { axis, at, length, count, height, offset } = options;
    const group = new THREE.Group();
    group.name = name;
    parent.add(group);

    const step = count > 1 ? length / count : length;
    const paneWidth = Math.max(0.12, step * 0.56);
    const geometry = this.track(
      axis === 'z'
        ? new THREE.BoxGeometry(paneWidth, height, 0.05)
        : new THREE.BoxGeometry(0.05, height, paneWidth),
    );
    const shift = offset * (options.reverse ? -1 : 1);

    for (let i = 0; i < count; i++) {
      const along = count > 1 ? (i + 0.5) * step - length / 2 : 0;
      const position = at.clone();
      if (axis === 'z') {
        position.x += along;
        position.z += shift;
      } else {
        position.z += along;
        position.x += shift;
      }
      this.mesh(geometry, this.materials.window, group, `${name}-${i}`, {
        position,
        cast: false,
        receive: false,
      });
    }
    return group;
  }

  /* ── Island ────────────────────────────────────────────────────────── */

  /**
   * The island.
   *
   * One closed body: a single lathe profile traced out along the plateau,
   * round the cliff lip, down the face and back in under the keel, so the top,
   * the sides, the underside and both caps are the same watertight surface.
   * The previous build lathed the plateau and the keel as two separate open
   * shells with a hole through the middle of the ground; from a low camera the
   * hole was visible straight through the island, which is what "seeing below
   * the ground plane" actually was.
   *
   * The band colours are baked into a vertex attribute and repainted whenever
   * the light changes, so grass, bare stone, the dry lip and the dark keel all
   * move with the theme while remaining one draw call.
   */
  private buildIsland(): void {
    const geometry = islandGeometry({ seed: 11, sectors: 11, strength: 0.038, segments: 128 });
    this.track(geometry);
    paintIsland(geometry, this.islandPalette(this.theme));
    this.islandGeometry = geometry;
    const terrain = this.mesh(geometry, this.materials.terrain, this.group, 'island', {
      cast: false,
      receive: true,
      occluder: true,
    });
    terrain.frustumCulled = false;

    /*
     * Broken stone along the lip of the cliff.
     *
     * One band, at the rim, bedded *in* so the boulders emerge from the face
     * rather than hanging beneath it — the deeper bands of the first version
     * drifted out of the narrowing silhouette and read as mushrooms floating
     * under the island. Only the vertical axis is turned, which keeps every
     * stone tangent to the rim.
     */
    if (this.quality.detail) {
      const random = mulberry32(31);
      const matrix = new THREE.Matrix4();
      const outward = new THREE.Vector3();
      const bands = [
        { count: 20, geometry: boulderGeometry(7, 0.62), y: -1.0, scale: [0.55, 0.9] },
        { count: 16, geometry: boulderGeometry(19, 0.58), y: -1.9, scale: [0.8, 1.25] },
      ];
      for (const band of bands) {
        const matrices: THREE.Matrix4[] = [];
        const radius = cliffRadiusAt(band.y);
        if (radius <= 0.5) continue;
        for (let i = 0; i < band.count; i++) {
          const angle = (i / band.count) * Math.PI * 2 + random() * 0.5;
          const scale = THREE.MathUtils.lerp(band.scale[0], band.scale[1], random());
          outward.set(Math.cos(angle), 0, Math.sin(angle));
          /* Bedded in: the centre sits deeper than the face, so the stone
             emerges from it instead of resting against it. */
          const radial = Math.max(0.6, radius - scale * 0.6);
          matrix.compose(
            new THREE.Vector3(
              outward.x * radial,
              band.y + (random() - 0.5) * 0.25,
              outward.z * radial,
            ),
            new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -angle),
            new THREE.Vector3(scale * 1.2, scale * 0.8, scale),
          );
          matrices.push(matrix.clone());
        }
        const mesh = instancedMesh(band.geometry, this.materials.rock, matrices, 'cliff-ledges');
        mesh.castShadow = false;
        mesh.receiveShadow = true;
        this.group.add(mesh);
        this.track(band.geometry);
      }
    }

    /*
     * Outcrops on the plateau.
     *
     * Stone occurs in clusters, and it sits *in* the ground: these are turned
     * only about the vertical axis — no tilt, which is what made the earlier
     * ones read as plates leaning on the surface — stretched wider than they
     * are tall, and sunk by two thirds of their height.
     */
    {
      const random = mulberry32(77);
      const geometry = this.track(boulderGeometry(53, 0.62));
      const matrices: THREE.Matrix4[] = [];
      const matrix = new THREE.Matrix4();
      const rim = plateauRadius();
      const clusters = 11;
      for (let cluster = 0; cluster < clusters; cluster++) {
        const angle = (cluster / clusters) * Math.PI * 2 + random() * 0.8;
        const radius = (rim - 5) + random() * 3.2;
        const anchorX = Math.cos(angle) * radius;
        const anchorZ = Math.sin(angle) * radius;
        const stones = 1 + Math.floor(random() * 3);
        for (let stone = 0; stone < stones; stone++) {
          const x = anchorX + (random() - 0.5) * 1.8;
          const z = anchorZ + (random() - 0.5) * 1.8;
          if (this.nearStation(x, z, 2.4)) continue;
          const scale = 0.5 + random() * 0.6;
          matrix.compose(
            new THREE.Vector3(x, GROUND - 0.06 - scale * 0.66, z),
            new THREE.Quaternion().setFromAxisAngle(
              new THREE.Vector3(0, 1, 0),
              random() * Math.PI * 2,
            ),
            new THREE.Vector3(scale * 1.3, scale * 0.72, scale),
          );
          matrices.push(matrix.clone());
        }
      }
      const outcrops = instancedMesh(geometry, this.materials.rock, matrices, 'outcrops');
      outcrops.castShadow = this.quality.shadows;
      outcrops.receiveShadow = true;
      this.group.add(outcrops);

      /*
       * A scatter of single stones through the open ground, so the shelf reads
       * as broken rock rather than as lawn. They are kept clear of the
       * walkways and the terraces and kept flat: a stone stood on its edge is
       * a stone that looks placed.
       */
      const scatter: THREE.Matrix4[] = [];
      for (let i = 0; i < 46; i++) {
        const angle = random() * Math.PI * 2;
        const radius = 4.2 + random() * (rim - 5.4);
        const x = Math.cos(angle) * radius;
        const z = Math.sin(angle) * radius;
        if (this.nearStation(x, z, 1.6)) continue;
        const scale = 0.22 + random() * 0.4;
        matrix.compose(
          new THREE.Vector3(x, GROUND - 0.05 - scale * 0.62, z),
          new THREE.Quaternion().setFromAxisAngle(
            new THREE.Vector3(0, 1, 0),
            random() * Math.PI * 2,
          ),
          new THREE.Vector3(scale * 1.35, scale * 0.7, scale),
        );
        scatter.push(matrix.clone());
      }
      if (scatter.length) {
        const stones = instancedMesh(geometry, this.materials.rock, scatter, 'scattered-stone');
        stones.castShadow = this.quality.shadows;
        stones.receiveShadow = true;
        this.group.add(stones);
      }
    }

    /*
     * Planting: two species, arranged in rings from the rim inward, each
     * turned and scaled on its own so the treeline reads as a wood rather
     * than one repeated silhouette.
     */
    const random = mulberry32(5);
    const rings = this.quality.treeRings;
    const conifer = coniferGeometry();
    const broadleaf = broadleafGeometry();
    this.track(conifer.trunk);
    for (const tier of conifer.tiers) this.track(tier);
    this.track(broadleaf.trunk);
    this.track(broadleaf.canopy);

    const coniferMatrices: THREE.Matrix4[][] = conifer.tiers.map(() => []);
    const coniferTrunks: THREE.Matrix4[] = [];
    const broadleafTrunks: THREE.Matrix4[] = [];
    const broadleafCanopies: THREE.Matrix4[] = [];
    const matrix = new THREE.Matrix4();
    const lean = new THREE.Quaternion();
    const yawOnly = new THREE.Quaternion();
    const rim = plateauRadius();
    for (let ring = 0; ring < rings; ring++) {
      const radius = (rim - 1.4) - ring * 1.5;
      const count = 32 - ring * 5;
      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2 + random() * 0.3 + ring * 0.9;
        const jitter = 0.86 + random() * 0.2;
        const x = Math.cos(angle) * radius * jitter;
        const z = Math.sin(angle) * radius * jitter;
        /* Keep the built terraces clear of planting. */
        if (this.nearStation(x, z, 4.2)) continue;
        /*
         * Trees are sized against the architecture, not against the ground:
         * at island scale anything smaller than a third of a building reads
         * as a shrub, which is what the earlier treeline looked like.
         */
        const scale = 0.78 + random() * 0.72;
        yawOnly.setFromAxisAngle(new THREE.Vector3(0, 1, 0), random() * Math.PI * 2);
        /* A slight lean, so the treeline is not a row of plumb lines. */
        lean.setFromAxisAngle(
          new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle)),
          (random() - 0.5) * 0.14,
        );
        const quaternion = lean.clone().multiply(yawOnly);
        const base = new THREE.Vector3(x, GROUND - 0.08, z);
        const uniform = new THREE.Vector3(scale, scale * (0.92 + random() * 0.24), scale);
        matrix.compose(base, quaternion, uniform);

        /* Roughly one tree in three is the rounded species. */
        if (random() < 0.34) {
          broadleafTrunks.push(matrix.clone());
          broadleafCanopies.push(matrix.clone());
          continue;
        }
        coniferTrunks.push(matrix.clone());
        for (const band of coniferMatrices) band.push(matrix.clone());
      }
    }

    const addTree = (
      mesh: THREE.InstancedMesh,
      shadows: boolean,
    ): THREE.InstancedMesh => {
      mesh.castShadow = shadows;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      return mesh;
    };

    if (coniferTrunks.length) {
      addTree(
        instancedMesh(conifer.trunk, this.materials.rock, coniferTrunks, 'conifer-trunks'),
        this.quality.shadows,
      );
      coniferMatrices.forEach((band, index) => {
        addTree(
          instancedMesh(conifer.tiers[index], this.materials.foliage, band, `conifer-tier-${index}`),
          this.quality.shadows,
        );
      });
    }
    if (broadleafTrunks.length) {
      addTree(
        instancedMesh(broadleaf.trunk, this.materials.rock, broadleafTrunks, 'broadleaf-trunks'),
        this.quality.shadows,
      );
      addTree(
        instancedMesh(
          broadleaf.canopy,
          this.materials.foliageLight,
          broadleafCanopies,
          'broadleaf-canopies',
        ),
        this.quality.shadows,
      );
    }

    /* Restrained shrubs close to the architecture. */
    const shrubGeometry = this.track(new THREE.IcosahedronGeometry(0.34, 0));
    shrubGeometry.scale(1, 0.66, 1);
    const shrubs: THREE.Matrix4[] = [];
    for (let i = 0; i < 110; i++) {
      const angle = random() * Math.PI * 2;
      const radius = 3.6 + random() * 7.4;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      if (this.nearStation(x, z, 3.2)) continue;
      const scale = 0.5 + random() * 0.85;
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

  /** The four band colours of the island, read from the live theme. */
  private islandPalette(theme: WorldTheme): {
    surface: number;
    surfaceAlt: number;
    rim: number;
    cliff: number;
    keel: number;
    bare: number;
  } {
    return {
      surface: theme.grass,
      surfaceAlt: theme.earth,
      rim: theme.shore,
      bare: theme.stoneAlt,
      cliff: theme.stoneDeep,
      keel: new THREE.Color(theme.stoneDeep).lerp(new THREE.Color(0x080d18), 0.5).getHex(),
    };
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
    sky.setHex(this.theme.skyHorizon);
    for (let i = 0; i < fade.length; i++) {
      /*
       * Nearer ridges keep a little of the sky's own colour; far ones dissolve
       * into the haze. The range is compressed hard toward the haze end on
       * purpose: a distant ridge should be a change of tone behind the island,
       * never a dark band across the frame.
       */
      const factor = THREE.MathUtils.lerp(0.8, 0.98, 1 - fade[i]);
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

  /* ── Landscape: distance, mist and cloud ───────────────────────────── */

  private buildLandscape(): void {
    /*
     * Distant ridges.
     *
     * They exist to give the horizon depth and nothing else, so they are
     * painted rather than lit and pushed a long way down. What made the
     * earlier ones read as flat black shapes pasted behind the island was that
     * they were tall, angular, close to the island and out of the fog's reach
     * all at once. Now they are low, rounded, far below, and inside the fog,
     * and their per-instance colour is an atmospheric blend between the sky at
     * the horizon and the haze — so distance is expressed by the colour of the
     * air rather than by a hard silhouette.
     */
    const { matrices, colors } = distantRidges(17, 16, 430);
    const hillGeometry = this.track(ridgeGeometry(41, 5));
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
      layer.userData.baseY = layer.position.y;
      this.mistLayers.push(layer);
      this.mistGroup.add(layer);
    }
    this.group.add(this.mistGroup);

    /*
     * Clouds.
     *
     * Soft, stylised and few. Each is a low-poly blob whose own light and
     * shade is baked into a vertex attribute and drawn on an unlit material,
     * so it never turns into a grey polygon when it passes between the key
     * light and the camera, and never costs a shadow. They sit high above the
     * island and drift slowly enough that a visitor notices them only if they
     * stop to look.
     */
    const cloudRandom = mulberry32(97);
    const count = this.quality.detail ? 5 : this.quality.mistLayers >= 3 ? 3 : 2;
    for (let i = 0; i < count; i++) {
      const geometry = this.track(cloudGeometry(300 + i * 17, 6 + Math.floor(cloudRandom() * 3)));
      paintCloud(geometry, this.theme.snow, this.theme.cloudShade);
      const material = this.materials.cloud;
      const cloud = new THREE.Mesh(geometry, material);
      cloud.name = `cloud-${i}`;
      const angle = (i / count) * Math.PI * 2 + cloudRandom() * 0.7;
      /*
       * Well outside anything the camera can reach, and well above the island.
       * A cloud inside the orbit's reach is a cloud that fills half the frame
       * when the visitor zooms out, which is what a nearer ring of them did.
       */
      const radius = 62 + cloudRandom() * 30;
      const scale = 4.2 + cloudRandom() * 2.2;
      cloud.position.set(
        Math.cos(angle) * radius,
        24 + cloudRandom() * 7,
        Math.sin(angle) * radius,
      );
      cloud.scale.setScalar(scale);
      cloud.rotation.y = cloudRandom() * Math.PI;
      cloud.renderOrder = 1;
      cloud.userData.angle = angle;
      cloud.userData.radius = radius;
      cloud.userData.speed = 0.008 + cloudRandom() * 0.008;
      cloud.userData.bob = cloudRandom() * Math.PI * 2;
      cloud.userData.baseY = cloud.position.y;
      this.clouds.push(cloud);
      this.cloudGroup.add(cloud);
    }
    this.group.add(this.cloudGroup);
  }

  /* ── Pathways ──────────────────────────────────────────────────────── */

  private buildPathways(): void {
    const order: DestinationId[] = RING_ORDER;
    const ringPoints = order.map((id) => {
      const { origin } = this.placeLayout(id);
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
    const { origin: landmark } = this.placeLayout('campus');
    const { origin: contact } = this.placeLayout('contact');
    const outward = new THREE.Vector3(contact.x, 0, contact.z).normalize();
    const avenue = curveFrom(
      [
        new THREE.Vector3(outward.x * 3.8, landmark.y + 0.02, outward.z * 3.8),
        new THREE.Vector3(outward.x * 4.8, landmark.y + 0.04, outward.z * 4.8),
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

    /* A dedicated spur per place, used by the travelling signals. */
    const landmarkEdge = new THREE.Vector3(landmark.x, landmark.y + 0.4, landmark.z);
    for (const id of Object.keys(LAYOUT) as DestinationId[]) {
      const { origin } = this.placeLayout(id);
      const start = landmarkEdge.clone();
      const end = new THREE.Vector3(origin.x, origin.y + 0.35, origin.z);
      const mid = start.clone().lerp(end, 0.5);
      mid.y += 1.6 + start.distanceTo(end) * 0.09;
      this.spurCurves.set(id, curveFrom([start, mid, end], false, 0.5));
    }
  }

  /* ── Station: central observatory ──────────────────────────────────── */

  private buildCampusLandmark(): void {
    const node = this.registerPlace('campus', ({ group, surface, glow }) => {
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

    /* The hidden marker for this place, tucked behind the colonnade. */
    this.attachDiscovery(node, new THREE.Vector3(3.3, GROUND + 1.2, 2.5));

    this.buildLightSwitch();
    this.registerSolids();
  }

  /**
   * The light switch.
   *
   * A real control standing on the observatory terrace: a brass pillar with a
   * glazed lamp on top and a lever beside it. Selecting it turns the world's
   * lights over — the same shared state the labelled control in the chrome
   * drives — so "switching the light" is something a visitor can do to the
   * scene itself rather than only to a button.
   *
   * It is given its own screen-space tap radius in the shell, because it is a
   * small object standing inside the observatory's very forgiving hit volume.
   */
  private buildLightSwitch(): void {
    const { surface } = this.placeLayout('campus');
    const group = new THREE.Group();
    group.name = 'light-switch';
    group.position.set(2.35, surface, 2.45);
    group.rotation.y = Math.PI * 0.25;
    this.group.add(group);

    /* Base and pillar. */
    this.mesh(terrace(0.34, 0.14, 0.06), this.materials.stoneDark, group, 'switch-base', {
      position: new THREE.Vector3(0, 0.02, 0),
    });
    this.mesh(new THREE.CylinderGeometry(0.07, 0.1, 1.15, 10), this.materials.ceramic, group, 'switch-pillar', {
      position: new THREE.Vector3(0, 0.62, 0),
    });

    /* The lamp: a glazed box with a lit core, so the switch itself shows
       whether the observatory's lamps are on. */
    const core = this.materials.windowPanel(this.theme.window, 1.6);
    this.mesh(roundedBox(0.34, 0.34, 0.34, 0.04), core, group, 'switch-lamp', {
      position: new THREE.Vector3(0, 1.3, 0),
      cast: false,
      receive: false,
    });
    const cage = this.mesh(
      new THREE.TorusGeometry(0.24, 0.022, 5, 20),
      this.materials.metal,
      group,
      'switch-cage',
      { position: new THREE.Vector3(0, 1.3, 0), cast: false },
    );
    cage.rotation.x = Math.PI / 2;

    /* The lever. It tilts with the state, which is what makes the object read
       as a switch rather than as a lamp on a post. */
    const lever = this.mesh(roundedBox(0.05, 0.34, 0.05, 0.015), this.materials.metal, group, 'switch-lever', {
      position: new THREE.Vector3(0.2, 0.95, 0),
    });
    lever.rotation.z = 0.4;
    this.switchLever = lever;
    this.mesh(new THREE.SphereGeometry(0.05, 10, 8), this.materials.signal, group, 'switch-knob', {
      position: new THREE.Vector3(0.26, 1.09, 0),
      cast: false,
      receive: false,
    });

    /*
     * The hit volume. Generous — 0.85 of a unit — because this is a control
     * that has to be pressable from the overview camera, and the shell checks
     * it in screen space before any building's own volume.
     */
    const pick = new THREE.Mesh(
      this.track(new THREE.CylinderGeometry(0.85, 0.85, 1.8, 8, 1, false)),
      this.pickMaterial,
    );
    pick.name = 'pick-light-switch';
    pick.position.set(0, 0.9, 0);
    group.add(pick);
    this.switchPick = pick;
  }

  /**
   * Tell the camera where the buildings are.
   *
   * One cylinder per destination terrace, sized from the pad the place was
   * laid out with and lofted above the tallest thing standing on it. The rig
   * keeps the camera outside all of them, which is what stops a zoom or a
   * shallow orbit from ending up inside the dome.
   */
  private registerSolids(): void {
    const heights: Record<DestinationId, number> = {
      campus: 11.5,
      studio: 3.4,
      workshop: 4.6,
      library: 3.6,
      workbench: 6.4,
      contact: 4.2,
    };
    for (const [id, layout] of Object.entries(LAYOUT) as [DestinationId, PlaceLayout][]) {
      const { surface } = this.placeLayout(id);
      this.solids.push({
        x: layout.x,
        z: layout.z,
        radius: layout.pad + 0.9,
        top: surface + heights[id],
      });
    }
    /* The switch is small, but the camera should not stand inside it either. */
    this.solids.push({ x: 2.35, z: 2.45, radius: 1.1, top: GROUND + 2.4 });
  }

  /** Solid volumes for the camera rig. */
  cameraSolids(): { x: number; z: number; radius: number; top: number }[] {
    return this.solids;
  }

  /** True when a ray hits the light switch. Used for the direct tap, which is
   *  resolved before the place volumes so a visitor aiming at a visible switch
   *  gets the switch. */
  switchTarget(): THREE.Object3D | null {
    return this.switchPick;
  }

  /** Where the switch's caption hangs: just above the lamp. */
  lightSwitchAnchor(): THREE.Vector3 {
    return new THREE.Vector3(2.35, this.placeLayout('campus').surface + 2.15, 2.45);
  }

  /**
   * Tilt the switch's lever to match the state of the world's lights.
   *
   * The lamp on the post needs no special handling: it is a registered window
   * panel, so it fades with every other window in the world as the blend runs.
   */
  setSwitchState(night: boolean): void {
    if (!this.switchLever) return;
    this.switchLever.rotation.z = night ? -0.4 : 0.4;
  }

  /* ── Station: work pavilion ────────────────────────────────────────── */

  /* ── Destination: personal studio (CV + biography) ─────────────────── */
  private buildStudio(): void {
    const node = this.registerPlace(
      'studio',
      ({ group, surface, glow }) => {
        const baseY = GROUND - 0.05;
        this.mesh(terrace(3, 0.5, 0.12), this.materials.stone, group, 'studio-terrace', {
          position: new THREE.Vector3(0, baseY, 0),
        });
        this.mesh(rimRing(2.9, 0.04, 40), this.materials.stoneDark, group, 'studio-rim', {
          position: new THREE.Vector3(0, surface - 0.04, 0),
        });
        this.mesh(rimRing(2.62, 0.022, 40), glow, group, 'studio-rimlight', {
          position: new THREE.Vector3(0, surface - 0.005, 0),
          cast: false,
          receive: false,
        });

        /* The room. Its open face is local -Z, which is the side the camera
           approaches from, so the desk and the portrait read immediately. */
        this.mesh(roundedBox(3.2, 1.6, 1.9, 0.1), this.materials.stone, group, 'studio-shell', {
          position: new THREE.Vector3(0, surface + 0.8, 0.55),
          occluder: true,
        });
        this.mesh(roundedBox(3.6, 0.14, 2.3, 0.05), this.materials.metalDark, group, 'studio-roof', {
          position: new THREE.Vector3(0, surface + 1.68, 0.5),
        }).rotation.x = -0.09;
        /* A clerestory box on the roof, so the silhouette is not a plain box. */
        this.mesh(roundedBox(1.2, 0.4, 0.9, 0.04), this.materials.ceramic, group, 'studio-lantern', {
          position: new THREE.Vector3(-0.85, surface + 1.95, 0.5),
        }).rotation.x = -0.09;

        /* Interior: floor, back wall, and a warm ceiling wash. */
        this.mesh(roundedBox(3.0, 0.06, 1.7, 0.03), this.materials.stoneDark, group, 'studio-floor', {
          position: new THREE.Vector3(0, surface + 0.05, 0.55),
          cast: false,
        });
        const warmPanel = this.track(
          new THREE.MeshStandardMaterial({
            color: 0x1a1206,
            roughness: 0.55,
            emissive: new THREE.Color(this.theme.practical),
            emissiveIntensity: 1.4,
          }),
        );
        this.mesh(new THREE.BoxGeometry(2.6, 0.5, 0.04), warmPanel, group, 'studio-backlight', {
          position: new THREE.Vector3(0, surface + 1.2, 1.44),
          cast: false,
          receive: false,
        });

        /* The desk: the object the CV belongs to. */
        this.mesh(roundedBox(2.1, 0.09, 0.8, 0.03), this.materials.ceramic, group, 'studio-desk', {
          position: new THREE.Vector3(0.1, surface + 0.72, 0.75),
        });
        const legGeometry = this.track(new THREE.CylinderGeometry(0.045, 0.045, 0.7, 6));
        const legs: THREE.Matrix4[] = [];
        for (const [dx, dz] of [
          [-0.9, 0.38],
          [1.1, 0.38],
          [-0.9, 1.12],
          [1.1, 1.12],
        ]) {
          legs.push(new THREE.Matrix4().makeTranslation(0.1 + dx * 0.5, surface + 0.36, dz));
        }
        group.add(instancedMesh(legGeometry, this.materials.metalDark, legs, 'studio-desk-legs'));

        /* Monitor, keyboard, mug — small props that make it a real desk. */
        this.mesh(roundedBox(0.62, 0.4, 0.05, 0.02), this.materials.metalDark, group, 'studio-screen', {
          position: new THREE.Vector3(-0.35, surface + 1.02, 0.62),
        });
        this.mesh(new THREE.BoxGeometry(0.56, 0.32, 0.02), glow, group, 'studio-screen-glow', {
          position: new THREE.Vector3(-0.35, surface + 1.02, 0.6),
          cast: false,
          receive: false,
        });
        this.mesh(roundedBox(0.52, 0.03, 0.18, 0.01), this.materials.ceramic, group, 'studio-keyboard', {
          position: new THREE.Vector3(-0.3, surface + 0.78, 0.95),
        });
        this.mesh(new THREE.CylinderGeometry(0.06, 0.05, 0.12, 10), this.materials.ceramic, group, 'studio-mug', {
          position: new THREE.Vector3(0.75, surface + 0.83, 0.8),
        });
        /* Chair. */
        this.mesh(roundedBox(0.5, 0.07, 0.5, 0.02), this.materials.metalDark, group, 'studio-chair', {
          position: new THREE.Vector3(0.1, surface + 0.5, 1.5),
        });
        this.mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.5, 6), this.materials.metalDark, group, 'studio-chair-stem', {
          position: new THREE.Vector3(0.1, surface + 0.25, 1.5),
        });

        /* A lit band across the open face, so the studio reads as a building
           rather than a silhouette from across the island. */
        const facade = this.track(
          new THREE.MeshStandardMaterial({
            color: 0x1a1206,
            roughness: 0.6,
            emissive: new THREE.Color(this.theme.practical),
            emissiveIntensity: 1.15,
          }),
        );
        this.mesh(new THREE.BoxGeometry(2.4, 0.12, 0.04), facade, group, 'studio-eaves-light', {
          position: new THREE.Vector3(0, surface + 1.48, -0.38),
          cast: false,
          receive: false,
        });

        /* Two rows of windows on the flanks, so the studio is a lit building
           from across the island and not only from the front. */
        for (const side of [-1, 1]) {
          this.windowBand(group, `studio-windows-${side > 0 ? 'a' : 'b'}`, {
            axis: 'x',
            at: new THREE.Vector3(side * 1.64, surface + 0.95, 0.55),
            length: 1.5,
            count: 2,
            height: 0.5,
            offset: 0.02,
          });
          this.windowBand(group, `studio-windows-${side > 0 ? 'c' : 'd'}`, {
            axis: 'x',
            at: new THREE.Vector3(side * 1.64, surface + 1.35, 0.55),
            length: 1.5,
            count: 1,
            height: 0.26,
            offset: 0.02,
          });
        }

        /* The portrait: the real photograph, framed on the back wall. */
        const portrait = this.mesh(
          new THREE.PlaneGeometry(0.62, 0.62),
          this.materials.portrait,
          group,
          'studio-portrait',
          { position: new THREE.Vector3(0.95, surface + 1.28, 1.42), cast: false, receive: false },
        );
        portrait.userData.objectId = 'about';
        this.mesh(roundedBox(0.74, 0.74, 0.05, 0.02), this.materials.metal, group, 'studio-portrait-frame', {
          position: new THREE.Vector3(0.95, surface + 1.28, 1.45),
          cast: false,
        });

        /* The CV itself: a lectern holding a lit document, beside the desk. */
        this.mesh(roundedBox(0.86, 0.08, 0.6, 0.03), this.materials.ceramic, group, 'studio-lectern', {
          position: new THREE.Vector3(-1.15, surface + 1.02, -0.15),
        }).rotation.x = 0.38;
        this.mesh(new THREE.CylinderGeometry(0.07, 0.09, 1, 8), this.materials.metalDark, group, 'studio-lectern-stem', {
          position: new THREE.Vector3(-1.15, surface + 0.5, -0.02),
        });
        const cvPage = this.mesh(new THREE.PlaneGeometry(0.7, 0.46), this.materials.paper, group, 'studio-cv-page', {
          position: new THREE.Vector3(-1.15, surface + 1.07, -0.13),
          cast: false,
          receive: false,
        });
        cvPage.rotation.x = -Math.PI / 2 + 0.38;
        cvPage.userData.objectId = 'cv';
        this.objectMarkers.push({
          id: 'cv',
          kind: 'cv',
          place: 'studio',
          label: 'Curriculum vitae',
          meta: 'Experience · skills · education',
          href: '/cv/',
          anchor: localToWorld(LAYOUT.studio, 1.28, surface + 1.62, 1.05),
          pick: cvPage,
        });
        this.objectMarkers.push({
          id: 'about',
          kind: 'about',
          place: 'studio',
          label: 'About',
          meta: 'Biography',
          href: '/about/',
          anchor: localToWorld(LAYOUT.studio, -0.3, surface + 1.86, 1.52),
          pick: portrait,
        });

        /* A floor lamp so the studio glows warm at night. */
        this.mesh(new THREE.CylinderGeometry(0.035, 0.045, 1.3, 6), this.materials.metalDark, group, 'studio-lamp-post', {
          position: new THREE.Vector3(1.5, surface + 0.65, 0.1),
        });
        const lamp = this.track(
          new THREE.MeshStandardMaterial({
            color: 0x1a1206,
            roughness: 0.4,
            emissive: new THREE.Color(this.theme.practical),
            emissiveIntensity: 1.7,
          }),
        );
        this.mesh(new THREE.SphereGeometry(0.14, 12, 8), lamp, group, 'studio-lamp', {
          position: new THREE.Vector3(1.5, surface + 1.34, 0.1),
          cast: false,
          receive: false,
        });

        return { anchorY: 2.5, pickRadius: 2.7, pickHeight: 3, targetY: 1.5 };
      },
    );

    this.attachDiscovery(node, new THREE.Vector3(2.1, GROUND + 0.6, -1.6));
  }

  /**
   * The subscription point.
   *
   * The newsletter is content, so it stands in the world beside the library
   * as a handbill post: a lit sheet on a stem, with its own caption. Selecting
   * it opens the subscribe document in the reading surface — no leaving the
   * world, and no hunting for a form in a page footer.
   */
  private buildSubscribePost(): void {
    const node = this.places.get('library');
    if (!node) return;
    const y = this.placeLayout('library').surface;

    const post = this.mesh(
      new THREE.CylinderGeometry(0.045, 0.06, 1.05, 8),
      this.materials.metalDark,
      node.group,
      'subscribe-post',
      { position: new THREE.Vector3(1.85, y + 0.52, 1.5) },
    );
    post.castShadow = this.quality.shadows;

    /* A lit handbill, angled toward the camera side of the terrace. */
    this.billMaterial ??= this.track(
      new THREE.MeshStandardMaterial({
        color: 0x1a1206,
        roughness: 0.5,
        metalness: 0.05,
        emissive: new THREE.Color(this.theme.signal),
        emissiveIntensity: 1.1,
      }),
    );
    const sheet = this.mesh(
      roundedBox(0.5, 0.34, 0.03, 0.015),
      this.billMaterial,
      node.group,
      'subscribe-sheet',
      { position: new THREE.Vector3(1.85, y + 1.16, 1.52), cast: false, receive: false },
    );
    sheet.rotation.x = -0.38;
    sheet.userData.objectId = 'subscribe';

    this.objectMarkers.push({
      id: 'subscribe',
      kind: 'newsletter',
      place: 'library',
      label: 'Subscribe',
      meta: 'Reliable AI · every issue',
      href: '/subscribe/',
      anchor: localToWorld(LAYOUT.library, 1.85, y + 1.72, 1.52),
      pick: sheet,
    });
  }

  /* ── Destination: project workshop ─────────────────────────────────── */

  private buildWorkshop(): void {
    const node = this.registerPlace(
      'workshop',
      ({ group, surface, glow }) => {
        const exhibits: ExhibitNode[] = [];
        this.mesh(terrace(3.2, 0.55, 0.14), this.materials.stone, group, 'workshop-terrace', {
          position: new THREE.Vector3(0, GROUND - 0.05, 0),
        });
        this.mesh(rimRing(3.08, 0.045, 44), this.materials.stoneDark, group, 'workshop-rim', {
          position: new THREE.Vector3(0, surface - 0.05, 0),
        });
        this.mesh(rimRing(2.8, 0.024, 44), glow, group, 'workshop-rimlight', {
          position: new THREE.Vector3(0, surface - 0.01, 0),
          cast: false,
          receive: false,
        });

        /* One installation per real project, arranged on an arc that faces
           the approaching camera (local -Z). */
        const projects = this.index.projects;
        const columns = Math.min(Math.max(projects.length, 1), 4);

        projects.forEach((project, index) => {
          const row = Math.floor(index / columns);
          const column = index % columns;
          const spread = columns === 1 ? 0 : 1;
          const x = spread
            ? (column / (columns - 1) - 0.5) * 2 * (1.15 + 0.25 * columns)
            : 0;
          const z = -0.65 - row * 1.35;
          const accent = this.exhibitAccent(index);

          const exhibitGlow = this.track(
            new THREE.MeshStandardMaterial({
              color: 0x0a1018,
              roughness: 0.3,
              metalness: 0.1,
              emissive: new THREE.Color(accent),
              emissiveIntensity: 0.5,
            }),
          );
          this.mesh(terrace(0.6, 0.7, 0.08), this.materials.ceramic, group, `workshop-plinth-${index}`, {
            position: new THREE.Vector3(x, surface, z),
          });
          const vitrine = this.mesh(
            roundedBox(0.76, 0.9, 0.76, 0.05),
            this.materials.glass,
            group,
            `workshop-vitrine-${index}`,
            { position: new THREE.Vector3(x, surface + 0.7 + 0.45, z), cast: false },
          );
          vitrine.renderOrder = 1;
          vitrine.userData.objectId = project.id;

          /* Three core shapes cycle, so neighbouring installations differ. */
          const coreY = surface + 1.18;
          if (index % 3 === 0) {
            this.mesh(new THREE.IcosahedronGeometry(0.18, 0), exhibitGlow, group, `workshop-core-a-${index}`, {
              position: new THREE.Vector3(x, coreY, z),
              cast: false,
              receive: false,
            });
          } else if (index % 3 === 1) {
            const cluster = new THREE.Group();
            cluster.position.set(x, coreY, z);
            group.add(cluster);
            const ring = 0.15;
            for (let n = 0; n < 4; n++) {
              const a = (n / 4) * Math.PI * 2;
              this.mesh(new THREE.SphereGeometry(0.062, 10, 8), exhibitGlow, cluster, `workshop-node-${index}-${n}`, {
                position: new THREE.Vector3(Math.cos(a) * ring, Math.sin(a * 2) * 0.09, Math.sin(a) * ring),
                cast: false,
                receive: false,
              });
            }
            for (let n = 0; n < 4; n++) {
              const a = (n / 4) * Math.PI * 2;
              const b = ((n + 1) / 4) * Math.PI * 2;
              const edge = this.mesh(
                this.track(unitCylinder(0.012, 5)),
                exhibitGlow,
                cluster,
                `workshop-edge-${index}-${n}`,
                { cast: false, receive: false },
              );
              spanMatrix(
                new THREE.Vector3(Math.cos(a) * ring, Math.sin(a * 2) * 0.09, Math.sin(a) * ring),
                new THREE.Vector3(Math.cos(b) * ring, Math.sin(b * 2) * 0.09, Math.sin(b) * ring),
                edge.matrix,
              );
              edge.matrixAutoUpdate = false;
            }
          } else {
            this.mesh(
              this.track(new THREE.TorusGeometry(0.17, 0.03, 6, 22)),
              exhibitGlow,
              group,
              `workshop-core-c-${index}`,
              { position: new THREE.Vector3(x, coreY, z), cast: false, receive: false },
            ).rotation.x = Math.PI / 2.6;
          }

          /* A small engraved plate carries the project's name up close. */
          const plate = this.mesh(
            roundedBox(0.66, 0.16, 0.03, 0.015),
            this.materials.paper,
            group,
            `workshop-plate-${index}`,
            { position: new THREE.Vector3(x, surface + 0.34, z - 0.42), cast: false, receive: false },
          );
          plate.userData.objectId = project.id;

          exhibits.push({
            id: project.id,
            place: 'workshop',
            index,
            anchor: localToWorld(LAYOUT.workshop, x, surface + 1.75, z),
            pick: vitrine,
            glow: exhibitGlow,
          });
          this.objectMarkers.push({
            id: project.id,
            kind: 'project',
            place: 'workshop',
            label: project.label,
            meta: project.meta,
            href: project.href,
            anchor: localToWorld(LAYOUT.workshop, x, surface + 1.95, z),
            pick: vitrine,
          });
        });

        /* Sawtooth canopy on slender masts, so the silhouette is industrial. */
        const canopy = this.mesh(
          roundedBox(Math.min(6.4, 2 + columns * 1.5), 0.14, 2.1, 0.05),
          this.materials.ceramic,
          group,
          'workshop-canopy',
          { position: new THREE.Vector3(0, surface + 2.9, -0.4) },
        );
        canopy.userData.occluder = true;
        this.mesh(roundedBox(2.2, 0.3, 1.6, 0.04), this.materials.metalDark, group, 'workshop-sawtooth', {
          position: new THREE.Vector3(-1.1, surface + 3.12, -0.5),
        }).rotation.z = 0.34;
        this.mesh(roundedBox(2.2, 0.3, 1.6, 0.04), this.materials.metalDark, group, 'workshop-sawtooth-2', {
          position: new THREE.Vector3(1.1, surface + 3.12, -0.5),
        }).rotation.z = 0.34;

        const mastGeometry = this.track(new THREE.CylinderGeometry(0.075, 0.09, 2.9, 8));
        const masts: THREE.Matrix4[] = [];
        for (const dx of [-2.3, 0, 2.3]) {
          masts.push(new THREE.Matrix4().makeTranslation(dx, surface + 1.45, -1.35));
        }
        const mastMesh = instancedMesh(mastGeometry, this.materials.metal, masts, 'workshop-masts');
        mastMesh.castShadow = this.quality.shadows;
        group.add(mastMesh);

        /* A workbench and a parts trolley keep the yard feeling used. */
        this.mesh(roundedBox(1.5, 0.1, 0.5, 0.03), this.materials.ceramic, group, 'workshop-bench', {
          position: new THREE.Vector3(-1.9, surface + 0.5, 1.3),
        });
        this.mesh(roundedBox(0.9, 0.7, 0.5, 0.03), this.materials.metalDark, group, 'workshop-trolley', {
          position: new THREE.Vector3(1.9, surface + 0.35, 1.3),
        });

        /*
         * The workshop's own light comes from its vitrines, which are already
         * lit objects with their own colours. A workshop that is a canopy over
         * an open yard has no wall to put a window in, so it does not pretend
         * to have one.
         */

        return {
          anchorY: 3.5,
          pickRadius: 3.6,
          pickHeight: 4.4,
          exhibits,
        };
      },
    );

    this.attachDiscovery(node, new THREE.Vector3(-2.8, GROUND + 0.75, 2.2));
  }

  /* ── Destination: Reliable AI library ──────────────────────────────── */

  private buildLibrary(): void {
    const node = this.registerPlace(
      'library',
      ({ group, surface, glow }) => {
        this.mesh(terrace(3, 0.45, 0.12), this.materials.stone, group, 'library-terrace', {
          position: new THREE.Vector3(0, GROUND - 0.05, 0),
        });
        this.mesh(rimRing(2.88, 0.04, 44), this.materials.stoneDark, group, 'library-rim', {
          position: new THREE.Vector3(0, surface - 0.04, 0),
        });
        this.mesh(rimRing(2.6, 0.022, 44), glow, group, 'library-rimlight', {
          position: new THREE.Vector3(0, surface - 0.005, 0),
          cast: false,
          receive: false,
        });

        /* A long reading hall under a barrel vault: horizontal mass, curved
           roof — deliberately unlike every other silhouette on the island. */
        const width = 4.6;
        this.mesh(roundedBox(width, 1.5, 1.9, 0.08), this.materials.ceramic, group, 'library-hall', {
          position: new THREE.Vector3(0, surface + 0.75, 0.6),
          occluder: true,
        });
        const vault = this.track(
          new THREE.CylinderGeometry(0.98, 0.98, width, 22, 1, false, 0, Math.PI),
        );
        vault.rotateZ(Math.PI / 2);
        this.mesh(vault, this.materials.ceramic, group, 'library-vault', {
          position: new THREE.Vector3(0, surface + 1.5, 0.6),
        });

        /* A colonnade of mullions across the open face. */
        const mullions: THREE.Matrix4[] = [];
        const mullionGeometry = this.track(new THREE.BoxGeometry(0.07, 1.2, 0.09));
        for (let i = 0; i < 6; i++) {
          mullions.push(
            new THREE.Matrix4().makeTranslation(
              -width / 2 + 0.35 + (i * (width - 0.7)) / 5,
              surface + 0.72,
              -0.36,
            ),
          );
        }
        group.add(instancedMesh(mullionGeometry, this.materials.metal, mullions, 'library-mullions'));

        /* Smoked-glass front and the warm interior behind it. */
        this.mesh(new THREE.BoxGeometry(width - 0.5, 1.15, 0.03), this.materials.glass, group, 'library-glass', {
          position: new THREE.Vector3(0, surface + 0.72, -0.35),
          cast: false,
        });
        const interior = this.track(
          new THREE.MeshStandardMaterial({
            color: 0x1a1206,
            roughness: 0.6,
            emissive: new THREE.Color(this.theme.practical),
            emissiveIntensity: 1.1,
          }),
        );
        this.mesh(new THREE.BoxGeometry(width - 0.8, 1, 0.04), interior, group, 'library-interior', {
          position: new THREE.Vector3(0, surface + 0.85, 0.7),
          cast: false,
          receive: false,
        });

        /* Shelf rows visible through the glass. */
        const shelfGeometry = this.track(new THREE.BoxGeometry(width - 0.9, 0.05, 0.34));
        for (let i = 0; i < 3; i++) {
          this.mesh(shelfGeometry, this.materials.stoneDark, group, `library-shelf-${i}`, {
            position: new THREE.Vector3(0, surface + 0.5 + i * 0.36, 1.1),
            cast: false,
          });
        }

        /* The editorial display: one object per published article, laid out
           in a grid so the scene follows the content, not a fixed six. */
        const articles = this.index.articles;
        const columns = Math.min(Math.max(articles.length, 1), 4);
        const rows = Math.ceil(articles.length / columns);
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        void rows;

        articles.forEach((article, index) => {
          const column = index % columns;
          const row = Math.floor(index / columns);
          const spread = columns === 1 ? 0 : 1;
          const x = spread ? (column / (columns - 1) - 0.5) * (width - 1.1) : 0;
          const y = surface + 0.62 + row * 0.44;
          const z = -0.9 - row * 0.02;

          /* A book: a spine block with a lit edge. */
          const book = this.mesh(
            roundedBox(0.16, 0.34, 0.24, 0.02),
            this.materials.paper,
            group,
            `library-book-${index}`,
            { position: new THREE.Vector3(x, y, z), cast: false, receive: false },
          );
          book.rotation.z = index % 2 === 0 ? 0.05 : -0.06;
          book.userData.objectId = article.id;

          const spine = this.mesh(
            new THREE.BoxGeometry(0.18, 0.05, 0.02),
            this.materials.signal,
            group,
            `library-spine-${index}`,
            { position: new THREE.Vector3(x, y + 0.1, z - 0.12), cast: false, receive: false },
          );
          spine.userData.objectId = article.id;

          this.objectMarkers.push({
            id: article.id,
            kind: 'article',
            place: 'library',
            label: article.label,
            meta: article.meta,
            href: article.href,
            anchor: localToWorld(LAYOUT.library, x, y + 0.42, z - 0.1),
            pick: book,
          });
        });

        /* A reading table and two chairs in front of the display. */
        this.mesh(roundedBox(1.7, 0.08, 0.7, 0.03), this.materials.ceramic, group, 'library-table', {
          position: new THREE.Vector3(0, surface + 0.62, -1.55),
        });
        for (const dx of [-0.55, 0.55]) {
          this.mesh(roundedBox(0.34, 0.06, 0.34, 0.02), this.materials.metalDark, group, `library-chair-${dx}`, {
            position: new THREE.Vector3(dx, surface + 0.42, -2.05),
          });
        }
        /* A reading lamp on the table. */
        const lamp = this.track(
          new THREE.MeshStandardMaterial({
            color: 0x1a1206,
            roughness: 0.4,
            emissive: new THREE.Color(this.theme.practical),
            emissiveIntensity: 1.6,
          }),
        );
        this.mesh(new THREE.CylinderGeometry(0.03, 0.04, 0.4, 6), this.materials.metalDark, group, 'library-lamp-stem', {
          position: new THREE.Vector3(0.6, surface + 0.85, -1.55),
        });
        this.mesh(new THREE.SphereGeometry(0.1, 12, 8), lamp, group, 'library-lamp', {
          position: new THREE.Vector3(0.6, surface + 1.08, -1.55),
          cast: false,
          receive: false,
        });

        /* A lit lintel under the vault, matching the studio's eaves light. */
        const lintel = this.track(
          new THREE.MeshStandardMaterial({
            color: 0x1a1206,
            roughness: 0.6,
            emissive: new THREE.Color(this.theme.practical),
            emissiveIntensity: 1.1,
          }),
        );
        this.mesh(new THREE.BoxGeometry(2.6, 0.1, 0.04), lintel, group, 'library-lintel-light', {
          position: new THREE.Vector3(0, surface + 1.44, -0.39),
          cast: false,
          receive: false,
        });

        /* A sign over the door. */
        this.mesh(roundedBox(1.1, 0.22, 0.04, 0.02), this.materials.metalDark, group, 'library-sign', {
          position: new THREE.Vector3(0, surface + 1.62, -0.42),
        });

        /*
         * A clerestory along the vault's shoulder, and windows in the end
         * walls. A reading hall at night is lit from inside and along the top,
         * which is also what gives the barrel its shape in the dark.
         */
        for (const side of [-1, 1]) {
          this.windowBand(group, `library-windows-${side > 0 ? 'a' : 'b'}`, {
            axis: 'z',
            at: new THREE.Vector3(side * 1.85, surface + 1.02, -0.02),
            length: 1.2,
            count: 2,
            height: 0.58,
            offset: 0,
          });
        }
        this.windowBand(group, 'library-clerestory', {
          axis: 'x',
          at: new THREE.Vector3(0, surface + 2.28, 0.6),
          length: width - 0.9,
          count: 5,
          height: 0.2,
          offset: 0,
        });

        return { anchorY: 3.2, pickRadius: 3.3, pickHeight: 3.6, targetY: 1.3 };
      },
    );

    this.attachDiscovery(node, new THREE.Vector3(2.6, GROUND + 0.55, 1.9));
  }

  /* ── Destination: open-source workbench ────────────────────────────── */

  private buildWorkbench(): void {
    const node = this.registerPlace(
      'workbench',
      ({ group, surface, glow }) => {
        this.mesh(terrace(3.1, 0.4, 0.12), this.materials.stone, group, 'workbench-yard', {
          position: new THREE.Vector3(0, GROUND - 0.05, 0),
        });
        this.mesh(rimRing(2.98, 0.04, 40), this.materials.stoneDark, group, 'workbench-rim', {
          position: new THREE.Vector3(0, surface - 0.04, 0),
        });
        this.mesh(rimRing(2.7, 0.022, 40), glow, group, 'workbench-rimlight', {
          position: new THREE.Vector3(0, surface - 0.005, 0),
          cast: false,
          receive: false,
        });

        /* An open yard under a gantry: skeletal, no solid mass, so it reads
           as a workshop from across the island. */
        const gantryHeight = 4.4;
        const posts = latticeMast({
          height: gantryHeight,
          baseRadius: 0.5,
          topRadius: 0.34,
          levels: 3,
          legs: 3,
          detailed: this.quality.detail,
        });
        const strutGeometry = this.track(unitCylinder(0.032, 5));
        for (const dx of [-2.1, 2.1]) {
          const post = instancedMesh(strutGeometry, this.materials.metal, posts.struts, `workbench-gantry-${dx}`);
          post.position.set(dx, surface, -1.5);
          post.castShadow = this.quality.shadows;
          group.add(post);
        }
        this.mesh(roundedBox(4.6, 0.22, 0.28, 0.05), this.materials.metal, group, 'workbench-beam', {
          position: new THREE.Vector3(0, surface + gantryHeight, -1.5),
        });
        /* A hoist line and hook hanging from the beam. */
        this.mesh(new THREE.CylinderGeometry(0.012, 0.012, 1.5, 4), this.materials.metalDark, group, 'workbench-hoist', {
          position: new THREE.Vector3(0.6, surface + gantryHeight - 0.85, -1.5),
          cast: false,
        });
        this.mesh(new THREE.TorusGeometry(0.09, 0.02, 5, 12), this.materials.metal, group, 'workbench-hook', {
          position: new THREE.Vector3(0.6, surface + gantryHeight - 1.65, -1.5),
          cast: false,
        });

        /* The bench itself, with a vice and scattered tools. */
        this.mesh(roundedBox(3.4, 0.12, 0.8, 0.03), this.materials.ceramic, group, 'workbench-bench', {
          position: new THREE.Vector3(0, surface + 0.86, 0.9),
        });
        const benchLegs: THREE.Matrix4[] = [];
        const legGeometry = this.track(new THREE.BoxGeometry(0.1, 0.84, 0.1));
        for (const dx of [-1.5, 1.5]) {
          for (const dz of [0.6, 1.2]) {
            benchLegs.push(new THREE.Matrix4().makeTranslation(dx, surface + 0.42, dz));
          }
        }
        group.add(instancedMesh(legGeometry, this.materials.metalDark, benchLegs, 'workbench-legs'));
        this.mesh(roundedBox(0.24, 0.22, 0.3, 0.03), this.materials.metal, group, 'workbench-vice', {
          position: new THREE.Vector3(-1.35, surface + 1.03, 0.9),
        });

        /* A pegboard of repository plaques: one per curated repo. */
        const repos = this.index.repos;
        const columns = Math.min(Math.max(repos.length, 1), 5);
        const rows = Math.ceil(repos.length / columns);
        const boardWidth = Math.min(4.4, 0.6 + columns * 0.78);
        const boardHeight = 0.5 + rows * 0.5;
        this.mesh(
          roundedBox(boardWidth, boardHeight, 0.08, 0.03),
          this.materials.metalDark,
          group,
          'workbench-board',
          { position: new THREE.Vector3(0, surface + 1.4 + boardHeight / 2, -0.55), occluder: true },
        );

        repos.forEach((repo, index) => {
          const column = index % columns;
          const row = Math.floor(index / columns);
          const spread = columns === 1 ? 0 : 1;
          const x = spread
            ? (column / (columns - 1) - 0.5) * (boardWidth - 0.55)
            : 0;
          const y = surface + 1.4 + boardHeight - 0.42 - row * 0.5;

          const plaque = this.mesh(
            roundedBox(0.5, 0.3, 0.04, 0.02),
            this.materials.paper,
            group,
            `workbench-plaque-${index}`,
            { position: new THREE.Vector3(x, y, -0.48), cast: false, receive: false },
          );
          plaque.userData.objectId = repo.id;
          this.mesh(new THREE.BoxGeometry(0.34, 0.03, 0.02), glow, group, `workbench-plaque-line-${index}`, {
            position: new THREE.Vector3(x, y - 0.07, -0.455),
            cast: false,
            receive: false,
          }).userData.objectId = repo.id;

          this.objectMarkers.push({
            id: repo.id,
            kind: 'repo',
            place: 'workbench',
            label: repo.label,
            meta: repo.meta,
            href: repo.href,
            anchor: localToWorld(LAYOUT.workbench, x, y + 0.44, -0.45),
            pick: plaque,
          });
        });

        /* Storage: crates and a parts rack. */
        const crateGeometry = this.track(new THREE.BoxGeometry(0.6, 0.5, 0.6));
        const crates: THREE.Matrix4[] = [];
        const crateSpots: [number, number, number][] = [
          [1.9, 0.25, 1.6],
          [2.3, 0.25, 1.75],
          [1.9, 0.75, 1.62],
          [-2.2, 0.25, 1.5],
        ];
        for (const [x, y, z] of crateSpots) {
          crates.push(new THREE.Matrix4().makeTranslation(x, surface + y, z));
        }
        const crateMesh = instancedMesh(crateGeometry, this.materials.stoneDark, crates, 'workbench-crates');
        crateMesh.castShadow = this.quality.shadows;
        group.add(crateMesh);

        return { anchorY: 4.8, pickRadius: 3.4, pickHeight: 5.4, targetY: 2.2 };
      },
    );

    this.attachDiscovery(node, new THREE.Vector3(-2.4, GROUND + 0.6, -1.9));
  }

  private buildContactStation(): void {
    this.registerPlace('contact', ({ group, surface, glow }) => {      this.mesh(terrace(2.5, 0.45, 0.12), this.materials.stone, group, 'beacon-terrace', {
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

      /*
       * The message hatch: a slot in a brass pillar beside the gateway, which
       * is what "contact" looks like as an object rather than as a place. It
       * opens the contact document — form, email, social and booking — in the
       * reading surface.
       */
      const hatchPost = this.mesh(
        new THREE.CylinderGeometry(0.16, 0.2, 1.15, 10),
        this.materials.ceramic,
        group,
        'contact-hatch-post',
        { position: new THREE.Vector3(1.65, surface + 0.57, 0.85) },
      );
      hatchPost.castShadow = this.quality.shadows;
      const hatch = this.mesh(
        roundedBox(0.34, 0.4, 0.16, 0.03),
        this.materials.metalDark,
        group,
        'contact-hatch',
        { position: new THREE.Vector3(1.65, surface + 1.32, 0.85) },
      );
      /* The slot itself, dark against the brass. */
      this.mesh(
        new THREE.BoxGeometry(0.22, 0.045, 0.04),
        this.materials.metalDark,
        group,
        'contact-slot',
        { position: new THREE.Vector3(1.65, surface + 1.4, 0.94), cast: false },
      );
      hatch.userData.objectId = 'contact';
      this.objectMarkers.push({
        id: 'contact',
        kind: 'contact',
        place: 'contact',
        label: 'Send a message',
        meta: 'Form · email · booking',
        href: '/contact/',
        anchor: localToWorld(LAYOUT.contact, 1.65, surface + 1.95, 0.85),
        pick: hatch,
      });

      return { anchorY: 3.3, pickRadius: 2.5, pickHeight: 3.6 };
    });
  }

  /* ── Discovery markers ─────────────────────────────────────────────── */

  private attachDiscovery(node: PlaceNode, position: THREE.Vector3): void {
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
      place: node.id,
      label: node.id,
      mesh,
      halo,
      found: false,
      position: world,
    };
    /* Discovery markers are pickable, in addition to their place proxy. */
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

  /** Load the studio's portrait photograph from a base-aware URL. */
  loadPortrait(url: string): void {
    this.materials.loadPortrait(url);
  }

  /** Send a light pulse from the observatory to a place. */
  triggerSignal(id: DestinationId): void {
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
    const target = this.places.get(id);
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

    /*
     * The ground is repainted rather than filtered. Its four bands — grass,
     * dry earth, the bare lip and the dark keel — are the same four tokens the
     * page uses, so the island changes colour with the sky instead of going
     * muddy under a global tint.
     */
    if (this.islandGeometry) {
      paintIsland(this.islandGeometry, this.islandPalette(theme));
      const colors = this.islandGeometry.attributes.color as THREE.BufferAttribute | undefined;
      if (colors) colors.needsUpdate = true;
    }

    /* Clouds carry their own light and shade, so a theme change repaints them
       rather than recolouring a material. */
    for (const cloud of this.clouds) {
      paintCloud(cloud.geometry, theme.snow, theme.cloudShade);
      const colors = cloud.geometry.attributes.color as THREE.BufferAttribute | undefined;
      if (colors) colors.needsUpdate = true;
    }

    /* Atmosphere-adjacent pieces that are painted rather than lit. */
    for (const layer of this.mistLayers) {
      const material = layer.material as THREE.MeshBasicMaterial;
      material.color.setHex(theme.mist);
      material.opacity = 0.18 + theme.dayness * 0.16;
    }
    if (this.hills) {
      this.setHillColors(new THREE.Color(), new THREE.Color(), new THREE.Color(), this.hillFade, this.hills);
    }
    if (this.searchlightMaterial) {
      this.searchlightMaterial.color.setHex(theme.signal);
      this.searchlightMaterial.opacity = 0.09 - theme.dayness * 0.05;
    }
    if (this.billMaterial) {
      /* A lit handbill is a lamp: on at night, subdued by day. */
      this.billMaterial.emissive.setHex(theme.signal);
      this.billMaterial.emissiveIntensity = 1.35 - theme.dayness * 0.95;
    }
    if (this.flight) {
      (this.flight.mesh.material as THREE.MeshStandardMaterial).emissive.setHex(theme.signal);
    }

    /* The switch's lever points at whichever way the world's lights are. */
    this.setSwitchState(theme.dayness < 0.5);
  }

  setQuality(quality: QualitySettings): void {
    this.quality = quality;
    this.mistLayers.forEach((layer, index) => {
      layer.visible = index < quality.mistLayers;
    });
    this.signals.forEach((signal, index) => {
      signal.mesh.visible = index < quality.signalCount;
    });
    this.clouds.forEach((cloud, index) => {
      cloud.visible = index < (quality.detail ? 5 : quality.mistLayers >= 3 ? 3 : 2);
    });
    this.cloudGroup.visible = this.clouds.some((cloud) => cloud.visible);
    this.searchlight.visible = quality.detail;
  }

  /** Switch on a lantern for each discovery found. */
  applyDiscoveries(found: DestinationId[]): void {
    found.forEach((id, index) => {
      const node = this.places.get(id);
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
      /* Absolute, not an increment: an accumulating bob kept the mist moving
         even when the scene was meant to be frozen. */
      layer.position.y =
        (layer.userData.baseY as number) +
        Math.sin(t * 0.25 + (layer.userData.bob as number)) * 0.14;
    }

    /* Clouds drift on a slow orbit of their own, so the sky is never static
       but never draws attention either. */
    for (const cloud of this.clouds) {
      if (!cloud.visible) continue;
      const angle = (cloud.userData.angle as number) + t * (cloud.userData.speed as number);
      const radius = cloud.userData.radius as number;
      cloud.position.x = Math.cos(angle) * radius;
      cloud.position.z = Math.sin(angle) * radius;
      cloud.position.y =
        (cloud.userData.baseY as number) +
        Math.sin(t * 0.08 + (cloud.userData.bob as number)) * 0.6;
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
    for (const node of this.places.values()) {
      const target = node.active > 0.5 ? 2.4 : node.hover > 0.5 ? 1.4 : 0.35;
      node.glow.emissiveIntensity = THREE.MathUtils.damp(
        node.glow.emissiveIntensity,
        target * this.theme.emissive,
        6,
        delta,
      );
    }

    /* Discovery markers turn slowly so they catch the light. */
    for (const node of this.places.values()) {
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

  /** Mark a place as the active destination. Hover is owned by the pointer
   *  and hotspot handlers, so the two never fight over the same property. */
  setPlaceState(id: DestinationId | null): void {
    for (const node of this.places.values()) {
      node.active = node.id === id ? 1 : 0;
    }
  }

  /** All objects the pointer may hit: place volumes plus discovery markers. */
  pickTargets(): THREE.Object3D[] {
    const targets: THREE.Object3D[] = [];
    for (const node of this.places.values()) {
      targets.push(node.pick);
      if (node.discovery && !node.discovery.found) targets.push(node.discovery.mesh);
      for (const exhibit of node.exhibits) targets.push(exhibit.pick);
    }
    for (const marker of this.objectMarkers) targets.push(marker.pick);
    return targets;
  }

  /** Objects a ray may hit to find the in-scene light switch. */
  switchTargets(): THREE.Object3D[] {
    return this.switchPick ? [this.switchPick] : [];
  }

  /**
   * Objects that can plausibly hide a place label: the island, the
   * observatory's own mass and the studio's roof volume. Deliberately tight
   * — the generous place hit-volumes are *not* used here, because they
   * hid labels for places that were plainly visible.
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
