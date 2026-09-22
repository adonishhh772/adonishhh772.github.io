/**
 * Procedural geometry for the observatory.
 *
 * Everything here is generated at runtime: no external models, no texture
 * downloads, no paid asset services. Builders return plain geometries or
 * instance matrices so the world can share a small number of draw calls.
 */

import * as THREE from 'three';
import { PLATEAU_RADIUS, heightAt, isOnPlateau, radialNormal, ridged } from './terrain';

/** Shorthand for the world's up axis, used all over the path builders. */
const UP = new THREE.Vector3(0, 1, 0);

/* ── Deterministic randomness ────────────────────────────────────────── */

/** Small, fast, seedable PRNG — the same island every visit. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ── Core solids ─────────────────────────────────────────────────────── */

export function lathe(points: [number, number][], segments = 48): THREE.LatheGeometry {
  return new THREE.LatheGeometry(
    points.map(([x, y]) => new THREE.Vector2(Math.max(x, 0.0001), y)),
    segments,
  );
}

/**
 * Push a lathe sideways so the island reads as sculpted rock rather than a
 * turned table leg. The plateau stays flat: only material below `flatBelow`
 * moves, and it moves more the deeper it goes.
 */
/**
 * Cut the island's cliff.
 *
 * The first version displaced the silhouette with a sum of sines, which is
 * smooth everywhere and therefore reads as a bulge with no authored form —
 * and, worse, it wobbled the radius by a quarter of its value, so the rim
 * looked soft from every angle. This cuts instead: the perimeter is divided
 * into sectors and each sector is pushed out or in by one flat amount, which
 * produces the long straight edges and hard corners of split stone. The
 * plateau above `flatAbove` is left exactly flat, and the underside tapers
 * into a single symmetrical keel rather than a lopsided swirl.
 */
export function sculptIsland(
  geometry: THREE.BufferGeometry,
  options: { flatAbove?: number; strength?: number; seed?: number; sectors?: number } = {},
): void {
  const { flatAbove = 0.4, strength = 0.5, seed = 7, sectors = 11 } = options;
  const random = mulberry32(seed);
  const offsets = new Float32Array(sectors);
  for (let i = 0; i < sectors; i++) offsets[i] = random() * 2 - 1;

  const position = geometry.attributes.position as THREE.BufferAttribute;
  const vector = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    vector.fromBufferAttribute(position, i);
    const radius = Math.hypot(vector.x, vector.z);
    if (radius < 0.001 || vector.y > flatAbove) continue;
    const angle = Math.atan2(vector.z, vector.x);
    const depth = Math.min(1, Math.max(0, (flatAbove - vector.y) / 5));
    /* Ease the facet in over the top of the cliff, so the rim stays level. */
    const bite = depth * depth;
    const sector = Math.min(
      sectors - 1,
      Math.max(0, Math.floor(((angle + Math.PI) / (Math.PI * 2)) * sectors)),
    );
    const scale = 1 + offsets[sector] * strength * bite;
    vector.x *= scale;
    vector.z *= scale;
    /* One symmetrical keel under the island. */
    vector.y -= bite * 0.55;
    position.setXYZ(i, vector.x, vector.y, vector.z);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
}

/* ── Island ──────────────────────────────────────────────────────────── */

/**
 * The island's full vertical profile, as one closed outline.
 *
 * The outline starts on the axis under the keel, runs out to the cliff's foot,
 * climbs the face, crosses the lip and comes back along the plateau to the
 * axis at the top, so the lathe closes itself: there is a cap under the keel
 * and a cap over the middle of the plateau, and no hole anywhere. The previous
 * build cut the plateau at radius 3.6 and left the centre open and the
 * underside uncapped, which is what a low camera was seeing straight through.
 *
 * The order of these points decides which way the generated faces point.
 * `LatheGeometry` winds its quads from the direction of travel, so an outline
 * traced *up* the outside — as this one is — produces a surface whose normals
 * face up and out, which is the direction the visitor looks from. Tracing it
 * downward instead turns the entire island inside out: it renders as a black
 * shape because every face is lit from behind, and only the sliver where the
 * surface doubles back catches any light. That is not a theory; it was
 * measured on the built geometry, and it is why this order is documented here
 * rather than tuned by eye.
 */
export const ISLAND_PROFILE: [number, number][] = [
  /* Keel cap. */
  [0, -9.4],
  [0.7, -9.3],
  [1.8, -9.0],
  [3.4, -8.5],
  [5.2, -7.8],
  [7.1, -6.9],
  [9.0, -5.9],
  [10.7, -4.9],
  [12.1, -3.8],
  [13.1, -2.7],
  [13.6, -1.6],
  /* Cliff face, opening out as it climbs. */
  [14.0, -0.4],
  [14.05, 0.2],
  /* The lip: the rock stops and the ground starts. */
  [13.9, 0.6],
  [13.55, 0.84],
  [13.0, 0.93],
  [12.2, 0.97],
  [10.8, 0.99],
  [9.2, 1.0],
  [7.2, 1.01],
  [5.4, 1.03],
  [3.6, 1.06],
  [2.1, 1.1],
  [0.9, 1.13],
  /* Plateau cap: a very slight crown at the middle. */
  [0, 1.14],
];

/** One segment of the profile, with the two indices at its ends. */
export interface IslandBand {
  name: 'surface' | 'rim' | 'cliff' | 'keel';
  from: [number, number];
  to: [number, number];
}

/**
 * The named bands of the profile, so the colours a band carries can be set
 * from the theme without any of the world's builders hard-coding a height.
 */
export const ISLAND_BANDS: IslandBand[] = [
  { name: 'surface', from: [0, 1.14], to: [12.2, 0.97] },
  { name: 'rim', from: [12.2, 0.97], to: [14.05, 0.2] },
  { name: 'cliff', from: [14.0, -0.4], to: [3.4, -8.5] },
  { name: 'keel', from: [3.4, -8.5], to: [0, -9.4] },
];

/**
 * How far the island reaches at a given height, for camera clearance.
 *
 * The profile runs from the foot of the keel up to the crown of the plateau,
 * so it exists only between those two heights and each segment rises in `y`.
 * Reading either end the other way round — as this did — makes the answer zero
 * for every height, which is not a visible failure of its own: nothing draws
 * from it. What it silently switches off is the camera's floor, so the rig
 * stops treating the island as ground and a shot whose look-at point was slid
 * below the plateau collapses into the rock; it also takes the plateau and
 * cliff radii with it, which is what the treeline and the cliff stone are
 * placed from.
 */
export function islandEnvelopeAt(y: number): number {
  const profile = ISLAND_PROFILE;
  const foot = profile[0][1];
  const crown = profile[profile.length - 1][1];
  if (y <= foot || y >= crown) return 0;
  for (let i = 0; i < profile.length - 1; i++) {
    const [r0, y0] = profile[i];
    const [r1, y1] = profile[i + 1];
    if (y >= y0 && y <= y1) {
      const t = y1 === y0 ? 0 : (y - y0) / (y1 - y0);
      return r0 + (r1 - r0) * t;
    }
  }
  return 0;
}

/**
 * The island as one closed, solid body.
 *
 * Built from a single outline traced round the axis, so the top, the cliff, the
 * underside and both caps are the same watertight surface. Three things then
 * happen to it, in order:
 *
 *  1. **The outline is densified.** The profile in `ISLAND_PROFILE` has the
 *     points a *shape* needs, not the points a *surface* needs: a lathe only
 *     has vertices where its outline does, so the plateau above the lip would
 *     otherwise be a dozen flat rings and no amount of vertex colour can hide
 *     it. The plateau is resampled to roughly a third of a unit.
 *  2. **The ground is displaced by the terrain height field.** This is the same
 *     function the stones, the trees and the grass are placed with, so the
 *     island is not a backdrop the props sit on — it is the surface they are
 *     standing on, and the two cannot disagree.
 *  3. **Normals are averaged on the indexed mesh**, before it is flattened for
 *     the band colours, so the plateau shades as ground rather than as a mosaic
 *     of its own triangles.
 *
 * The band colours are recomputed from the live theme, so the same geometry
 * carries the day and the night palette without a second build.
 */
export function islandGeometry(
  options: {
    seed?: number;
    sectors?: number;
    strength?: number;
    /** Radial segments around the axis. */
    segments?: number;
    /** Whether to displace the plateau with the terrain height field. */
    detailed?: boolean;
  } = {},
): THREE.BufferGeometry {
  const { seed = 11, sectors = 11, strength = 0.03, segments = 192, detailed = true } = options;
  const outline = densifyProfile(ISLAND_PROFILE, 2.2, 0.34);
  const geometry = new THREE.LatheGeometry(
    outline.map(([x, y]) => new THREE.Vector2(Math.max(x, 0.0001), y)),
    segments,
  );

  const random = mulberry32(seed);
  const offsets = new Float32Array(sectors);
  for (let i = 0; i < sectors; i++) offsets[i] = random() * 2 - 1;

  const position = geometry.attributes.position as THREE.BufferAttribute;
  const vector = new THREE.Vector3();
  const scratchNormal = new THREE.Vector3();
  geometry.computeVertexNormals();
  const normals = geometry.attributes.normal as THREE.BufferAttribute;

  for (let i = 0; i < position.count; i++) {
    vector.fromBufferAttribute(position, i);
    const radius = Math.hypot(vector.x, vector.z);
    if (radius < 0.05) {
      /* The axis: a single point per cap, already on the centre line. */
      continue;
    }
    scratchNormal.fromBufferAttribute(normals, i);

    /*
     * The ground. Only the upward-facing plateau is displaced, and only inside
     * the shelf: the cliff is a wall and has to keep its sharp lip, or the
     * island loses its silhouette.
     */
    if (detailed && scratchNormal.y > 0.35 && radius < PLATEAU_RADIUS) {
      vector.y = heightAt(vector.x, vector.z);
      position.setXYZ(i, vector.x, vector.y, vector.z);
      continue;
    }

    /*
     * The cliff. Only the outward-facing shell is bitten. The caps are
     * horizontal, so a vertical normal means "cap" and a sideways one means
     * "wall"; using the normal instead of a raw height test keeps the flat
     * plateau perfectly flat while still cutting the cliff.
     */
    const wall = 1 - Math.min(1, Math.abs(scratchNormal.y));
    if (wall < 0.06) continue;
    const angle = Math.atan2(vector.z, vector.x);
    const sector = Math.min(
      sectors - 1,
      Math.max(0, Math.floor(((angle + Math.PI) / (Math.PI * 2)) * sectors)),
    );
    /* Deeper cuts bite a little harder, so the base is not a turned bowl. */
    const depth = Math.min(1, Math.max(0, (1.1 - vector.y) / 9));
    /*
     * A second, high-frequency term on top of the per-sector facets. Split
     * stone has a broken face, not a faceted one, and the difference between
     * the two at a distance is entirely this term.
     */
    const fracture =
      1 + ridged(vector.x * 0.34 + 5.1, vector.z * 0.34 - 2.7, 3) * 0.09 * wall - 0.05;
    const scale = (1 + offsets[sector] * strength * wall * (0.45 + depth * 0.9)) * fracture;
    vector.x *= scale;
    vector.z *= scale;
    /* Sink the very bottom, so the keel is a point rather than a disc. */
    if (vector.y < -6) vector.y -= (1 - radius / 6) * 0.4;
    position.setXYZ(i, vector.x, vector.y, vector.z);
  }
  position.needsUpdate = true;
  applyIslandUv(geometry);

  /*
   * Normals are averaged on the indexed mesh — where the lathe's seam vertices
   * are still shared — and only then is the geometry flattened into the
   * non-indexed form the band colours want. Computing them afterwards would
   * average nothing: every triangle would be its own island and the plateau
   * would shade as a mosaic.
   */
  geometry.computeVertexNormals();
  if (detailed) applyGroundNormals(geometry);
  const flat = geometry.toNonIndexed();
  geometry.dispose();
  flat.computeBoundingSphere();
  return flat;
}

/**
 * Replace the plateau's normals with the height field's own.
 *
 * `computeVertexNormals` answers a different question from the one the ground
 * needs. It averages the normals of the triangles that meet at a vertex, which
 * on a lathe means the answer depends on how the mesh happens to be divided —
 * producing the faint concentric banding that gives a radial mesh away, and
 * making the shading disagree with the height field the props are placed on.
 *
 * The height field's own gradient is continuous and has no preferred direction,
 * so the ground shades as a *surface* rather than as a mesh. Two blends keep it
 * honest: the analytic normal is used in proportion to how level the ground is
 * (a cliff face has no meaningful gradient normal), and it is mixed toward the
 * geometry's own normal near the lip, so the silhouette and the shading meet
 * without a seam.
 */
function applyGroundNormals(geometry: THREE.BufferGeometry): void {
  const position = geometry.attributes.position as THREE.BufferAttribute;
  const normal = geometry.attributes.normal as THREE.BufferAttribute;
  const outward = new THREE.Vector3();
  const analytic = new THREE.Vector3();
  const existing = new THREE.Vector3();

  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const radius = Math.hypot(x, z);
    if (radius >= PLATEAU_RADIUS - 1.2 || radius < 0.05) continue;

    outward.set(x / radius, 0, z / radius);
    radialNormal(radius, Math.atan2(z, x), outward, analytic);
    existing.fromBufferAttribute(normal, i);

    /* The height field is what the ground *is*, so it wins where the ground is
       level enough for the question to mean anything. */
    const flatness = THREE.MathUtils.clamp((analytic.y - 0.45) / 0.5, 0, 1);
    if (flatness <= 0) continue;

    existing.lerp(analytic, flatness).normalize();
    normal.setXYZ(i, existing.x, existing.y, existing.z);
    void y;
  }
  normal.needsUpdate = true;
}

/**
 * Resample an outline so no segment is longer than `maxStep` and no two points
 * are closer than `minStep`.
 *
 * The two bounds do different jobs: `maxStep` adds the density the surface
 * needs, and `minStep` avoids piling up dozens of degenerate rings where the
 * profile's own points already crowd together — at the lip, where the shape
 * turns through ninety degrees in under a unit, and at the keel's tip.
 */
export function densifyProfile(
  profile: [number, number][],
  maxStep: number,
  minStep: number,
): [number, number][] {
  const out: [number, number][] = [profile[0]];
  for (let i = 0; i < profile.length - 1; i++) {
    const [r0, y0] = profile[i];
    const [r1, y1] = profile[i + 1];
    const length = Math.hypot(r1 - r0, y1 - y0);
    const divisions = Math.max(1, Math.ceil(length / maxStep));
    for (let step = 1; step <= divisions; step++) {
      const t = step / divisions;
      const r = r0 + (r1 - r0) * t;
      const y = y0 + (y1 - y0) * t;
      const previous = out[out.length - 1];
      if (step < divisions && Math.hypot(r - previous[0], y - previous[1]) < minStep) continue;
      out.push([r, y]);
    }
  }
  return out;
}

/**
 * Write texture coordinates onto the island.
 *
 * Two regimes, because the island's surface has two characters and a single
 * projection cannot serve both. The plateau is projected from above, in world
 * units, so a ground texture tiles at a fixed physical scale across the whole
 * shelf whatever the mesh's own topology is. The cliff and the keel are mapped
 * by (angle, height), which is the lathe's own parameterisation: around the
 * face and up it, with no stretching at the lip where the two regimes meet —
 * which is why the seam is invisible, and why it is invisible *by
 * construction* rather than by tuning.
 */
function applyIslandUv(geometry: THREE.BufferGeometry, groundTile = 7, faceTile = 6): void {
  const position = geometry.attributes.position as THREE.BufferAttribute;
  const count = position.count;
  const uv = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const radius = Math.hypot(x, z);
    if (isOnPlateau(x, z)) {
      uv[i * 2] = x / groundTile;
      uv[i * 2 + 1] = z / groundTile;
    } else {
      uv[i * 2] = (Math.atan2(z, x) / (Math.PI * 2)) * ((radius * 2 * Math.PI) / faceTile);
      uv[i * 2 + 1] = y / faceTile;
    }
  }
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
}

/**
 * Paint the island's four bands onto the geometry from the live theme, so the
 * rock, the grass shelf, the bare rim and the dark keel all move together when
 * the light changes.
 *
 * Two notes on how this is shaped, because a naive per-vertex blend reads as a
 * pie chart rather than as ground:
 *
 *  - The patchiness is keyed on angle *and* radius, sampled from a small
 *    deterministic field, so bare stone appears in irregular outcrops instead
 *    of a ring of identical wedges.
 *  - The plateau is almost entirely ground. Stone shows through in a few
 *    places and along the rim where the soil would have gone; anything more
 *    and the island reads as a car park.
 */
export function paintIsland(
  geometry: THREE.BufferGeometry,
  palette: {
    surface: number;
    surfaceAlt: number;
    rim: number;
    cliff: number;
    keel: number;
    bare: number;
  },
  seed = 21,
): void {
  const position = geometry.attributes.position as THREE.BufferAttribute;
  const count = position.count;
  const random = mulberry32(seed);

  /*
   * A coarse value-noise field. It has to be sampled by position rather than
   * by vertex index, because the geometry is non-indexed: the three corners of
   * a triangle carry the same coordinates but different indices, and per-index
   * noise would speckle every face.
   */
  const size = 24;
  const field = new Float32Array(size * size);
  for (let i = 0; i < field.length; i++) field[i] = random();
  const sample = (u: number, v: number): number => {
    /* Wrap into the grid, then bilinear between the four corners. */
    const x = ((u % 1) + 1) % 1 * (size - 1);
    const y = ((v % 1) + 1) % 1 * (size - 1);
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = (x0 + 1) % size;
    const y1 = (y0 + 1) % size;
    const fx = x - x0;
    const fy = y - y0;
    const a = field[y0 * size + x0];
    const b = field[y0 * size + x1];
    const c = field[y1 * size + x0];
    const d = field[y1 * size + x1];
    return (
      a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy
    );
  };

  const surface = new THREE.Color(palette.surface);
  const surfaceAlt = new THREE.Color(palette.surfaceAlt);
  const rim = new THREE.Color(palette.rim);
  const bare = new THREE.Color(palette.bare);
  const cliff = new THREE.Color(palette.cliff);
  const keel = new THREE.Color(palette.keel);
  const scratch = new THREE.Color();
  const colors = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const radius = Math.hypot(x, z);
    const angle = Math.atan2(z, x);
    /* Two octaves a long way apart, so patches have both a body and a fringe. */
    const coarse = sample(angle / (Math.PI * 2) + 0.13, radius / 30 + 0.41);
    const fine = sample(angle / (Math.PI * 2) * 3.1 + 0.77, radius / 9 + 0.19);
    const patch = coarse * 0.68 + fine * 0.32;

    if (y >= 0.5) {
      /* The shelf: ground, opening to soil where the noise peaks and to bare
         stone only at the very top of the range. */
      const soil = THREE.MathUtils.smoothstep(patch, 0.42, 0.78);
      const stone = THREE.MathUtils.smoothstep(patch, 0.78, 0.97);
      scratch.copy(surface).lerp(surfaceAlt, soil * 0.85).lerp(bare, stone * 0.75);
      /* And a touch of bare ground as the shelf reaches the lip. */
      const toLip = THREE.MathUtils.smoothstep(radius, 12.0, 13.6);
      scratch.lerp(bare, toLip * (0.22 + stone * 0.3));
    } else if (y >= -0.7) {
      /* The lip: soil giving way to rock over a short, sharp band. */
      const t = THREE.MathUtils.clamp((0.5 - y) / 1.2, 0, 1);
      scratch
        .copy(surfaceAlt)
        .lerp(bare, 0.35 + patch * 0.4)
        .lerp(rim, THREE.MathUtils.smoothstep(t, 0.05, 0.9));
    } else if (y >= -8.6) {
      const t = THREE.MathUtils.clamp((-0.7 - y) / 8, 0, 1);
      scratch.copy(rim).lerp(cliff, t * 0.7 + patch * 0.25);
    } else {
      scratch.copy(cliff).lerp(keel, THREE.MathUtils.clamp((-8.6 - y) / 1.2, 0, 1));
    }
    colors[i * 3] = scratch.r;
    colors[i * 3 + 1] = scratch.g;
    colors[i * 3 + 2] = scratch.b;
  }

  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
}

/* ── Clouds ──────────────────────────────────────────────────────────── */

/**
 * A stylised cloud: a flat, softly-lit blob rather than a lit solid.
 *
 * A cloud built from lit geometry in a scene with one shadow-casting key light
 * becomes a grey polygon the moment it is between the light and the camera,
 * and a stack of them reads as flat black shapes pasted across the sky. This
 * is drawn instead — a dome of low-poly lobes with a light-and-shade gradient
 * baked into a vertex attribute, on an unlit material — so it holds its shape
 * at any hour and never costs a shadow pass.
 *
 * The gradient runs from a bright top-left to a cooler, slightly darker base,
 * which is what makes it read as a body with a lit side rather than a decal.
 */
export function cloudGeometry(seed: number, lobes = 7): THREE.BufferGeometry {
  const random = mulberry32(seed);
  const parts: THREE.BufferGeometry[] = [];
  /*
   * Wider than it is tall, and the lobes are spread far enough apart that they
   * only partly merge. The first version packed seven of them into a span of
   * 1.7, which fused into a single smooth ellipsoid — an egg, which is what
   * every cloud in the sky was. A cloud reads as a cloud because its silhouette
   * is *lumpy*, so the lumps have to survive the merge.
   */
  const span = 2.35;
  for (let i = 0; i < lobes; i++) {
    const t = lobes === 1 ? 0.5 : i / (lobes - 1);
    const x = (t - 0.5) * span * (0.88 + random() * 0.3);
    const radius = 0.32 + Math.sin(Math.PI * t) * 0.42 + random() * 0.2;
    const lobe = new THREE.IcosahedronGeometry(radius, 1);
    /* A wide, flat footprint: a cloud is much broader than it is tall, and its
       base is flatter than its crown. */
    lobe.scale(1.3, 0.5 + random() * 0.22, 1.05);
    lobe.translate(
      x,
      0.08 + Math.sin(Math.PI * t) * random() * 0.2,
      (random() - 0.5) * 0.4,
    );
    parts.push(lobe);
  }
  const merged = mergePositions(parts);
  for (const part of parts) part.dispose();
  merged.computeVertexNormals();
  merged.computeBoundingSphere();
  return merged;
}

/** Merge geometries that share one position layout into a flat position list. */
function mergePositions(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const push = (geometry: THREE.BufferGeometry, index: number) => {
    const position = geometry.attributes.position as THREE.BufferAttribute;
    positions.push(position.getX(index), position.getY(index), position.getZ(index));
  };
  for (const geometry of parts) {
    const index = geometry.index;
    if (index) {
      const array = index.array as ArrayLike<number>;
      for (let i = 0; i < array.length; i++) push(geometry, array[i]);
    } else {
      for (let i = 0; i < geometry.attributes.position.count; i++) push(geometry, i);
    }
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return merged;
}


/**
 * Bake the cloud's own shading into a vertex colour attribute: bright on the
 * upper-left of every lobe, cooler and dimmer underneath, and *fading out* at
 * the base and the fringe.
 *
 * The alpha is the part that matters. A cloud drawn as an opaque solid has a
 * silhouette, and a silhouette in a scene made of soft light reads as a paper
 * cut-out — which is exactly what these were: flat white eggs with a hard rim.
 * Dissolving the underside and the outer edge into the sky is what turns the
 * same geometry into vapour.
 *
 * `dim` is how much light the cloud is carrying — the theme's own `dayness`.
 * A cloud is not white: at midnight it is a dark blue-grey darker than the sky
 * behind it, and one that keeps a noon brightness after dark is the single most
 * conspicuous thing in a night scene.
 */
export function paintCloud(
  geometry: THREE.BufferGeometry,
  light: number,
  shade: number,
  dim = 1,
): void {
  const position = geometry.attributes.position as THREE.BufferAttribute;
  const normal = geometry.attributes.normal as THREE.BufferAttribute;
  const scale = 0.16 + 0.84 * THREE.MathUtils.clamp(dim, 0, 1);
  const bright = new THREE.Color(light).multiplyScalar(scale);
  const dark = new THREE.Color(shade).multiplyScalar(scale * 0.82);
  const scratch = new THREE.Color();

  let minY = Infinity;
  let maxY = -Infinity;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const height = Math.max(maxY - minY, 0.001);
  const centreX = (minX + maxX) / 2;
  const centreZ = (minZ + maxZ) / 2;
  const radiusX = Math.max((maxX - minX) / 2, 0.001);
  const radiusZ = Math.max((maxZ - minZ) / 2, 0.001);

  const colors = new Float32Array(position.count * 4);
  for (let i = 0; i < position.count; i++) {
    /* A fixed direction rather than the scene's key light: the cloud reads the
       same at every hour, which is what keeps it from turning grey at night. */
    const facing = normal.getX(i) * 0.4 + normal.getY(i) * 0.8 + normal.getZ(i) * 0.2;
    const t = THREE.MathUtils.clamp(facing * 0.5 + 0.5, 0, 1);
    scratch.copy(dark).lerp(bright, Math.pow(t, 0.8));
    colors[i * 4] = scratch.r;
    colors[i * 4 + 1] = scratch.g;
    colors[i * 4 + 2] = scratch.b;

    /*
     * The soft edge, in three parts.
     *
     * A cloud drawn as a solid has a silhouette, and a silhouette in a scene
     * made of soft light reads as a paper cut-out — which is exactly what these
     * were: pale eggs with a hard rim. So the base dissolves into the sky, the
     * underside of every lobe is thinner than its top, and the whole body fades
     * out toward its own edges. What is left opaque is the crown, which is the
     * part that has to hold the shape.
     */
    const up = (position.getY(i) - minY) / height;
    const base = 0.18 + 0.82 * smoothstep01(up / 0.42);
    const crown = 0.45 + 0.55 * smoothstep01((normal.getY(i) + 0.75) / 1.1);
    const fromCentre = Math.hypot(
      (position.getX(i) - centreX) / radiusX,
      (position.getZ(i) - centreZ) / radiusZ,
    );
    const rim = 1 - smoothstep01((fromCentre - 0.52) / 0.46);
    colors[i * 4 + 3] = THREE.MathUtils.clamp(base * crown * rim, 0, 1);
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4));
}

/** A local smoothstep, so this module stays free of shader-side helpers. */
function smoothstep01(value: number): number {
  const t = value < 0 ? 0 : value > 1 ? 1 : value;
  return t * t * (3 - 2 * t);
}

/** A box with softened edges — the tactile vocabulary of the small props. */
export function roundedBox(
  width: number,
  height: number,
  depth: number,
  radius = 0.08,
): THREE.ExtrudeGeometry {
  const r = Math.min(radius, width / 2 - 0.001, height / 2 - 0.001);
  const x = -width / 2;
  const y = -height / 2;
  const shape = new THREE.Shape();
  shape.moveTo(x + r, y);
  shape.lineTo(x + width - r, y);
  shape.quadraticCurveTo(x + width, y, x + width, y + r);
  shape.lineTo(x + width, y + height - r);
  shape.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  shape.lineTo(x + r, y + height);
  shape.quadraticCurveTo(x, y + height, x, y + height - r);
  shape.lineTo(x, y + r);
  shape.quadraticCurveTo(x, y, x + r, y);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelSize: r * 0.4,
    bevelThickness: r * 0.4,
    bevelSegments: 2,
    curveSegments: 4,
  });
  geometry.translate(0, 0, -depth / 2);
  geometry.computeVertexNormals();
  return geometry;
}

/** Tapered circular terrace: a low chamfered disc, the world's unit of floor. */
export function terrace(radius: number, height: number, chamfer = 0.14): THREE.LatheGeometry {
  const top = radius - chamfer;
  return lathe(
    [
      [0, 0],
      [top * 0.4, height],
      [top, height],
      [radius, height - chamfer],
      [radius * 0.98, 0],
      [radius * 0.92, -0.12],
      [0, -0.12],
    ],
    44,
  );
}

export function rimRing(radius: number, tube: number, segments = 48): THREE.TorusGeometry {
  const geometry = new THREE.TorusGeometry(radius, tube, 6, segments);
  geometry.rotateX(Math.PI / 2);
  return geometry;
}

export function unitCylinder(radius: number, sides = 6): THREE.CylinderGeometry {
  return new THREE.CylinderGeometry(radius, radius, 1, sides, 1, false);
}

/* ── Paths ───────────────────────────────────────────────────────────── */

export function curveFrom(
  points: THREE.Vector3[],
  closed = true,
  tension = 0.5,
): THREE.CatmullRomCurve3 {
  return new THREE.CatmullRomCurve3(points, closed, 'catmullrom', tension);
}

/** Sample a curve's centre line offset sideways — used for rails and rims. */
export function offsetPoints(
  curve: THREE.CatmullRomCurve3,
  distance: number,
  samples: number,
): THREE.Vector3[] {
  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = (i % samples) / samples;
    const point = curve.getPointAt(t);
    const tangent = curve.getTangentAt(t).normalize();
    const side = new THREE.Vector3().crossVectors(tangent, UP).normalize().multiplyScalar(distance);
    points.push(point.clone().add(side));
  }
  return points;
}

/**
 * A flat ribbon that follows a curve — the walkways. Double-sided so the
 * winding never matters, and UVs run along the length for future texturing.
 */
export function ribbon(
  curve: THREE.CatmullRomCurve3,
  width: number,
  samples = 160,
  lift = 0,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const half = width / 2;

  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const point = curve.getPointAt(t % 1);
    const tangent = curve.getTangentAt(t % 1).normalize();
    const side = new THREE.Vector3().crossVectors(tangent, UP).normalize().multiplyScalar(half);
    const a = point.clone().add(side);
    const b = point.clone().sub(side);
    positions.push(a.x, a.y + lift, a.z, b.x, b.y + lift, b.z);
    normals.push(0, 1, 0, 0, 1, 0);
    uvs.push(0, t, 1, t);
    if (i < samples) {
      const k = i * 2;
      indices.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

export function tubeAlong(points: THREE.Vector3[], radius: number, closed = true): THREE.TubeGeometry {
  const curve = curveFrom(points, closed);
  return new THREE.TubeGeometry(curve, Math.max(24, points.length * 4), radius, 5, closed);
}

/* ── Instancing helpers ──────────────────────────────────────────────── */

/** Scale/rotate/translate a unit-height cylinder so it spans `from` → `to`. */
export function spanMatrix(
  from: THREE.Vector3,
  to: THREE.Vector3,
  target: THREE.Matrix4,
  radiusScale = 1,
): THREE.Matrix4 {
  const direction = new THREE.Vector3().subVectors(to, from);
  const length = Math.max(direction.length(), 0.0001);
  const midpoint = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5);
  const quaternion = new THREE.Quaternion().setFromUnitVectors(UP, direction.normalize());
  target.compose(
    midpoint,
    quaternion,
    new THREE.Vector3(radiusScale, length, radiusScale),
  );
  return target;
}

export function instancedMesh(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  matrices: THREE.Matrix4[],
  name: string,
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, Math.max(matrices.length, 1));
  mesh.name = name;
  for (let i = 0; i < matrices.length; i++) mesh.setMatrixAt(i, matrices[i]);
  mesh.count = matrices.length;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = true;
  return mesh;
}

/* ── Instrument pieces ───────────────────────────────────────────────── */

/** A ribbed hemisphere: the dome that gives the observatory its silhouette. */
export function ribbedDome(radius: number, ribs = 8): {
  shell: THREE.SphereGeometry;
  ribMatrices: THREE.Matrix4[];
  slit: THREE.BufferGeometry;
} {
  const shell = new THREE.SphereGeometry(radius, 30, 14, 0, Math.PI * 2, 0, Math.PI / 2.08);
  const ribMatrices: THREE.Matrix4[] = [];
  for (let i = 0; i < ribs; i++) {
    const angle = (i / ribs) * Math.PI * 2;
    const matrix = new THREE.Matrix4();
    matrix.makeRotationY(angle);
    ribMatrices.push(matrix);
  }
  /* A narrow observation slit, not a slab: it should read as an opening in
     the shell rather than a stripe painted across it. */
  const slit = new THREE.BoxGeometry(radius * 0.34, radius * 0.58, radius * 2.04);
  slit.translate(0, radius * 0.2, 0);
  return { shell, ribMatrices, slit };
}

/** Shared geometry for one dome rib: a half-torus standing on the drum. */
export function ribGeometry(radius: number, tube: number): THREE.TorusGeometry {
  return new THREE.TorusGeometry(radius, tube, 5, 22, Math.PI);
}

/** A lattice mast: legs, ring braces and diagonals, all as instance matrices. */
export function latticeMast(options: {
  height: number;
  baseRadius: number;
  topRadius: number;
  levels: number;
  legs?: number;
  detailed?: boolean;
}): { struts: THREE.Matrix4[]; nodes: THREE.Vector3[] } {
  const { height, baseRadius, topRadius, levels, legs = 4, detailed = true } = options;
  const struts: THREE.Matrix4[] = [];
  const nodes: THREE.Vector3[] = [];
  const matrix = new THREE.Matrix4();

  const at = (leg: number, level: number) => {
    const t = level / levels;
    const radius = THREE.MathUtils.lerp(baseRadius, topRadius, t);
    const angle = (leg / legs) * Math.PI * 2;
    return new THREE.Vector3(Math.cos(angle) * radius, t * height, Math.sin(angle) * radius);
  };

  for (let leg = 0; leg < legs; leg++) {
    for (let level = 0; level < levels; level++) {
      struts.push(spanMatrix(at(leg, level), at(leg, level + 1), matrix.clone()));
      /* Ring brace at each level. */
      const next = at((leg + 1) % legs, level);
      struts.push(spanMatrix(at(leg, level), next, matrix.clone(), 0.7));
      if (detailed) {
        struts.push(spanMatrix(at(leg, level), at((leg + 1) % legs, level + 1), matrix.clone(), 0.55));
      }
    }
    /* Cap the leg with a point so the mast ends in a spire. */
    const last = at(leg, levels);
    struts.push(spanMatrix(last, new THREE.Vector3(0, height + 0.5, 0), matrix.clone(), 0.6));
  }

  for (let level = 0; level <= levels; level++) {
    const t = level / levels;
    nodes.push(new THREE.Vector3(0, t * height, 0));
  }

  return { struts, nodes };
}

/** A knowledge graph: clustered nodes joined to their nearest neighbours. */
export function graphLayout(
  seed: number,
  count: number,
  radius: number,
  height: number,
): { nodes: THREE.Vector3[]; edges: [number, number][] } {
  const random = mulberry32(seed);
  const nodes: THREE.Vector3[] = [];
  /* Three loose clusters, so the graph reads as structured, not scattered. */
  const clusters = 3;
  const centres = Array.from({ length: clusters }, (_, i) => {
    const angle = (i / clusters) * Math.PI * 2 + 0.4;
    return new THREE.Vector3(
      Math.cos(angle) * radius * 0.45,
      0,
      Math.sin(angle) * radius * 0.45,
    );
  });

  for (let i = 0; i < count; i++) {
    const centre = centres[i % clusters];
    const angle = random() * Math.PI * 2;
    const spread = Math.pow(random(), 0.6) * radius * 0.52;
    nodes.push(
      new THREE.Vector3(
        centre.x + Math.cos(angle) * spread,
        height * (0.35 + random() * 0.95),
        centre.z + Math.sin(angle) * spread,
      ),
    );
  }

  const edges: [number, number][] = [];
  const seen = new Set<string>();
  for (let i = 0; i < nodes.length; i++) {
    const neighbours = nodes
      .map((node, index) => ({ index, distance: node.distanceTo(nodes[i]) }))
      .filter((entry) => entry.index !== i)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 2);
    for (const neighbour of neighbours) {
      const key = i < neighbour.index ? `${i}:${neighbour.index}` : `${neighbour.index}:${i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push([i, neighbour.index]);
    }
  }

  return { nodes, edges };
}

/** A guide drone: small, friendly, and unmistakably not a weapon. */
export function buildDroneGeometry(): {
  body: THREE.BufferGeometry;
  shell: THREE.BufferGeometry;
  arm: THREE.BufferGeometry;
  rotor: THREE.BufferGeometry;
  eye: THREE.BufferGeometry;
} {
  const body = new THREE.SphereGeometry(0.17, 16, 12);
  body.scale(1.25, 0.82, 1.25);
  const shell = new THREE.SphereGeometry(0.2, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2);
  shell.scale(1.15, 0.7, 1.15);
  shell.translate(0, 0.03, 0);
  const arm = new THREE.BoxGeometry(0.42, 0.022, 0.05);
  const rotor = new THREE.TorusGeometry(0.075, 0.012, 4, 12);
  rotor.rotateX(Math.PI / 2);
  const eye = new THREE.SphereGeometry(0.045, 10, 8);
  return { body, shell, arm, rotor, eye };
}

/** A stealthy discovery marker: a small faceted crystal. */
export function crystalGeometry(): THREE.OctahedronGeometry {
  const geometry = new THREE.OctahedronGeometry(0.16, 0);
  geometry.scale(0.72, 1.5, 0.72);
  return geometry;
}

/* ── Landscape ───────────────────────────────────────────────────────── */

/**
 * A low ridge line far below and far away, for the horizon's depth.
 *
 * Ridges rather than cones. A cone is a spike: scaled to a ridge's proportions
 * it becomes a leaning wedge, and a ring of them reads as flat dark polygons
 * pasted behind the island rather than as distance. This builds each ridge from
 * overlapping rounded humps along the tangent, which silhouettes as a soft,
 * irregular hill and stays that shape whatever the light is doing.
 *
 * The returned `colors` are a per-instance atmospheric fade, 0 for the ridge
 * nearest the camera and 1 for the furthest.
 */
export function distantRidges(
  seed: number,
  count: number,
  ringRadius: number,
): { matrices: THREE.Matrix4[]; colors: number[] } {
  const random = mulberry32(seed);
  const matrices: THREE.Matrix4[] = [];
  const colors: number[] = [];
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + (random() - 0.5) * 0.32;
    const distance = ringRadius * (0.55 + random() * 0.5);
    const height = 9 + random() * 7;
    const width = 22 + random() * 16;
    const matrix = new THREE.Matrix4();
    matrix.compose(
      /*
       * Far below the island: these are the ground the island has risen from,
       * not mountains crowding it, so the top of a ridge sits a long way under
       * the keel at every bearing. A ridge that reaches the island's own
       * horizon stops being distance and becomes a dark band across the sky.
       */
      new THREE.Vector3(
        Math.cos(angle) * distance,
        -168 - height * 0.3 - random() * 22,
        Math.sin(angle) * distance,
      ),
      new THREE.Quaternion().setFromAxisAngle(up, -angle + random() * 0.5),
      new THREE.Vector3(width, height, width * (0.45 + random() * 0.3)),
    );
    matrices.push(matrix);
    colors.push(THREE.MathUtils.clamp(1 - (distance - ringRadius) / (ringRadius * 0.9), 0.1, 1));
  }
  return { matrices, colors };
}

/** One ridge: a handful of overlapping humps, flattened and widened. */
export function ridgeGeometry(seed: number, humps = 5): THREE.BufferGeometry {
  const random = mulberry32(seed);
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < humps; i++) {
    const t = humps === 1 ? 0.5 : i / (humps - 1);
    const hump = new THREE.SphereGeometry(1, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2);
    const radius = 0.4 + Math.sin(Math.PI * (0.35 + t * 0.65)) * 0.6;
    hump.scale(radius * (1.5 + random() * 0.7), radius * (0.85 + random() * 0.4), 1.4);
    hump.translate((t - 0.5) * 2.1, 0, (random() - 0.5) * 0.5);
    parts.push(hump);
  }
  const merged = mergePositions(parts);
  for (const part of parts) part.dispose();
  merged.computeVertexNormals();
  merged.computeBoundingSphere();
  return merged;
}

/* ── UV mapping ──────────────────────────────────────────────────────── */

/**
 * Wrap texture coordinates round an object about the vertical axis.
 *
 * Cylindrical mapping, expressed in *world units* rather than in the geometry's
 * own normalised space: a trunk two units around and four tall receives UVs
 * from 0 to 2 across and 0 to 4 up, so a bark texture tiles at the same
 * physical size on a sapling and on a mature tree. Normalised UVs would stretch
 * the bark on whichever trunk happened to be a different size, which is the
 * commonest way procedural trees give themselves away.
 */
function wrapCylindrical<T extends THREE.BufferGeometry>(
  geometry: T,
  uScale: number,
  vScale: number,
): T {
  const position = geometry.attributes.position as THREE.BufferAttribute;
  const count = position.count;
  const uv = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    uv[i * 2] = (Math.atan2(z, x) / (Math.PI * 2) + 0.5) * uScale;
    uv[i * 2 + 1] = y * vScale;
  }
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return geometry;
}

/** Spherical mapping, for a rounded canopy. */
function wrapSpherical<T extends THREE.BufferGeometry>(
  geometry: T,
  uScale: number,
  vScale: number,
): T {
  const position = geometry.attributes.position as THREE.BufferAttribute;
  const count = position.count;
  const uv = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const radius = Math.hypot(x, y, z) || 1;
    uv[i * 2] = (Math.atan2(z, x) / (Math.PI * 2) + 0.5) * uScale;
    uv[i * 2 + 1] = (Math.asin(Math.max(-1, Math.min(1, y / radius))) / Math.PI + 0.5) * vScale;
  }
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return geometry;
}

/**
 * Displace a closed shell by noise, keeping shared corners together.
 *
 * The displacement is keyed on the *position* rather than the vertex index, so
 * faces that meet at a corner move with it and the shell stays closed. Keying it
 * on the index — which is the obvious way, and the way this first went — splits
 * every shared edge into two, and the result is a rock with visible cracks
 * through it wherever the noise disagreed with itself.
 */
function roughen(
  geometry: THREE.BufferGeometry,
  frequency: number,
  amplitude: number,
  seed: number,
): THREE.BufferGeometry {
  const position = geometry.attributes.position as THREE.BufferAttribute;
  const vector = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    vector.set(position.getX(i), position.getY(i), position.getZ(i));
    const radius = vector.length() || 1;
    vector.divideScalar(radius);
    const noise = ridged(
      vector.x * frequency + seed * 0.37,
      vector.z * frequency - seed * 0.21,
      3,
    );
    const scale = 1 + (noise - 0.5) * amplitude;
    position.setXYZ(
      i,
      position.getX(i) * scale,
      position.getY(i) * scale,
      position.getZ(i) * scale,
    );
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

/* ── Vegetation ──────────────────────────────────────────────────────── */

export interface ConiferGeometry {
  trunk: THREE.CylinderGeometry;
  /** Stacked canopy tiers, each turned so the silhouette never repeats. */
  tiers: THREE.ConeGeometry[];
  /** The transform that places each tier on the trunk, for per-tree assembly. */
  tierMatrices: THREE.Matrix4[];
  /** Short branch arms between the tiers: the structure under the foliage. */
  branches: THREE.CylinderGeometry;
  branchMatrices: THREE.Matrix4[];
}

/**
 * A conifer.
 *
 * Five staggered tiers over a tapered trunk, with branch arms visible in the
 * gaps between them. Three things separate this from the two-cone tree it
 * replaces, and all three are about the silhouette:
 *
 *  - The tiers **overlap**: each one starts below the top of the one beneath, so
 *    there is no gap for the sky to show through and the tree reads as one mass
 *    rather than as a stack of hats.
 *  - Each tier is **a cone with more sides than it needs and a built-in taper**,
 *    so it catches the key light along two or three facets instead of one.
 *  - The trunk is **visible between the tiers** at the bottom, which is what
 *    gives the tree a base and stops it hovering.
 *
 * The light-catching is completed per instance, in `world.ts`, by giving each
 * tree its own colour and its own noise displacement.
 */
export function coniferGeometry(): ConiferGeometry {
  const specs: { radius: number; height: number; y: number; yaw: number; squash: number }[] = [
    { radius: 0.78, height: 1.35, y: 0.72, yaw: 0, squash: 0.96 },
    { radius: 0.68, height: 1.3, y: 1.24, yaw: Math.PI / 5, squash: 0.93 },
    { radius: 0.57, height: 1.26, y: 1.76, yaw: (Math.PI * 2) / 5, squash: 0.9 },
    { radius: 0.44, height: 1.22, y: 2.28, yaw: (Math.PI * 3) / 5, squash: 0.87 },
    { radius: 0.3, height: 1.16, y: 2.8, yaw: (Math.PI * 4) / 5, squash: 0.84 },
    { radius: 0.15, height: 1.0, y: 3.3, yaw: (Math.PI * 5) / 5, squash: 0.8 },
  ];
  const tiers = specs.map((spec) => {
    /* Twelve sides: enough that a tier reads as round at any angle, faceted
       enough that the key light breaks across it. */
    const cone = new THREE.ConeGeometry(spec.radius, spec.height, 12, 3, false);
    cone.scale(1, 1, spec.squash);
    cone.rotateY(spec.yaw);
    cone.translate(0, spec.y, 0);
    return wrapSpherical(cone, 2, 2);
  });

  const trunk = new THREE.CylinderGeometry(0.05, 0.17, 2.2, 8, 4);
  trunk.translate(0, 0.95, 0);
  wrapCylindrical(trunk, 1, 0.5);

  /*
   * Branch arms, in the gaps between tiers. They are what makes the canopy read
   * as something *grown*: without them the tiers float, and a conifer whose
   * needles have no visible support is the single most common look of a
   * low-effort procedural tree.
   */
  const branch = new THREE.CylinderGeometry(0.028, 0.055, 1, 4);
  branch.translate(0, 0.5, 0);
  wrapCylindrical(branch, 1, 1);
  const branchMatrices: THREE.Matrix4[] = [];
  const branchRows = [0.95, 1.5, 2.05, 2.6];
  for (let row = 0; row < branchRows.length; row++) {
    const arms = 6 - row;
    for (let i = 0; i < arms; i++) {
      const angle = (i / arms) * Math.PI * 2 + row * 0.5;
      /* Out and down, the way a conifer's lower branches actually set. */
      const tilt = -(0.5 + row * 0.09);
      const length = 1.5 - row * 0.22;
      const matrix = new THREE.Matrix4();
      const quaternion = new THREE.Quaternion()
        .setFromAxisAngle(new THREE.Vector3(0, 1, 0), -angle)
        .multiply(
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2 + tilt),
        );
      matrix.compose(
        new THREE.Vector3(0, branchRows[row], 0),
        quaternion,
        new THREE.Vector3(1, length, 1),
      );
      branchMatrices.push(matrix);
    }
  }

  return {
    trunk,
    tiers,
    /* Each tier is one instanced mesh sharing the tree's own transform, so no
       per-tier offset is needed here; the offsets are baked into the geometry. */
    tierMatrices: tiers.map(() => new THREE.Matrix4()),
    branches: branch,
    branchMatrices,
  };
}

export interface BroadleafGeometry {
  trunk: THREE.CylinderGeometry;
  /** Three limbs reaching out of the trunk into the crown. */
  limbs: THREE.CylinderGeometry;
  limbMatrices: THREE.Matrix4[];
  /**
   * The whole crown as one merged, noise-displaced mesh.
   *
   * Merged rather than kept as four separate lobes because the world places one
   * instance per tree: four lobes would mean four instanced meshes per tree
   * species to keep in step, for a shape that never moves relative to itself.
   */
  canopy: THREE.BufferGeometry;
}

/**
 * A broadleaf tree.
 *
 * A trunk that splits into three limbs, carrying a crown built from four
 * overlapping lobes of different sizes and at different heights. The lobes are
 * deliberately *not* concentric: a single sphere scaled into an ellipsoid is a
 * lollipop, and the difference between a lollipop and a tree is entirely the
 * asymmetry of the mass and the negative space around it.
 *
 * The lobes are noise-displaced, which is what gives the crown the broken edge
 * that catches light and reads as foliage rather than as geometry.
 */
export function broadleafGeometry(): BroadleafGeometry {
  const trunk = new THREE.CylinderGeometry(0.07, 0.2, 1.9, 9, 4);
  trunk.translate(0, 0.9, 0);
  wrapCylindrical(trunk, 1, 0.5);

  const limb = new THREE.CylinderGeometry(0.04, 0.085, 1, 6);
  limb.translate(0, 0.5, 0);
  wrapCylindrical(limb, 1, 1);
  const limbMatrices: THREE.Matrix4[] = [];
  for (let i = 0; i < 3; i++) {
    const angle = (i / 3) * Math.PI * 2 + 0.4;
    const tilt = 0.52 + (i % 2) * 0.12;
    const quaternion = new THREE.Quaternion()
      .setFromAxisAngle(new THREE.Vector3(0, 1, 0), -angle)
      .multiply(
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2 - tilt),
      );
    const matrix = new THREE.Matrix4();
    matrix.compose(
      new THREE.Vector3(0, 1.72, 0),
      quaternion,
      new THREE.Vector3(1, 1.5 + (i % 2) * 0.3, 1),
    );
    limbMatrices.push(matrix);
  }

  const lobeSpecs: { radius: number; x: number; y: number; z: number; seed: number }[] = [
    { radius: 0.95, x: 0, y: 2.5, z: 0, seed: 3 },
    { radius: 0.72, x: 0.62, y: 2.28, z: 0.34, seed: 11 },
    { radius: 0.66, x: -0.52, y: 2.66, z: -0.3, seed: 19 },
    { radius: 0.56, x: 0.16, y: 2.96, z: -0.44, seed: 27 },
  ];
  const lobes = lobeSpecs.map((spec) => {
    const lobe = new THREE.IcosahedronGeometry(spec.radius, 2);
    roughen(lobe, 5.5, 0.3, spec.seed);
    lobe.scale(1.06, 0.86, 1.02);
    lobe.translate(spec.x, spec.y, spec.z);
    return wrapSpherical(lobe, 3, 3);
  });
  const canopy = mergeGeometries(lobes);
  for (const lobe of lobes) lobe.dispose();
  canopy.computeVertexNormals();
  canopy.computeBoundingSphere();

  return { trunk, limbs: limb, limbMatrices, canopy };
}

/**
 * A boulder.
 *
 * Displacement is keyed on the vertex position rather than the vertex index, so
 * faces that share a corner move together and the shell stays closed. Two
 * details do the work of making it read as stone rather than as a blob: the
 * displacement is *ridged* rather than smooth, which produces flats and arrises
 * where a smooth field produces a bulge; and the bottom is flattened, because a
 * rock that has been sitting on the ground has a base.
 */
export function boulderGeometry(seed: number, squash = 0.72): THREE.BufferGeometry {
  const geometry = new THREE.IcosahedronGeometry(1, 2);
  const position = geometry.attributes.position as THREE.BufferAttribute;
  const vector = new THREE.Vector3();
  const scratch = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    vector.set(position.getX(i), position.getY(i), position.getZ(i));
    const radius = vector.length() || 1;
    scratch.copy(vector).divideScalar(radius);
    /* Two scales: broad ones, and one that breaks each face up. */
    const broad = ridged(scratch.x * 3.4 + seed * 0.11, scratch.z * 3.4 - seed * 0.07, 2);
    const fine = ridged(scratch.x * 11 + seed * 0.23, scratch.z * 11 + seed * 0.17, 2);
    const scale = 0.8 + broad * 0.3 + fine * 0.12;
    const x = vector.x * scale;
    let y = vector.y * scale * squash;
    const z = vector.z * scale;
    /* A flat base: below this the rock is cut off, as if bedded in. */
    const floor = -0.62;
    if (y < floor) y = floor + (y - floor) * 0.18;
    position.setXYZ(i, x, y, z);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  wrapSpherical(geometry, 2.5, 2.5);
  return geometry;
}

/**
 * Squash a rock into a shard.
 *
 * Scree is not made of small boulders: it is made of the flat, angular pieces a
 * face sheds, which are flatter and sharper than the rock they came off.
 * Scaling a boulder down gives a pebble; the silhouette has to be *reshaped*,
 * which is what this does once, for every fragment instance to share.
 */
export function reduceBoulder(
  geometry: THREE.BufferGeometry,
  roundness: number,
): THREE.BufferGeometry {
  const position = geometry.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    /*
     * Pull each vertex toward the box that just contains it. The flat faces grow
     * at the expense of the corners, which is what makes an angular shard;
     * blending rather than snapping keeps the shell closed.
     */
    const longest = Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) || 1;
    position.setXYZ(
      i,
      x + (Math.sign(x) * longest - x) * roundness,
      y + (Math.sign(y) * longest * 0.6 - y) * roundness,
      z + (Math.sign(z) * longest - z) * roundness,
    );
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * A grass clump, as a small rosette of crossed cards.
 *
 * The geometry is three quads at 60° to one another, each the full height of the
 * clump, plus a quadratic **bend** attribute that the vertex shader uses to
 * curve the tips. That bend is the whole trick: a clump of flat cards standing
 * perfectly upright reads as a paper flower, and the same cards with their tops
 * displaced and swaying read as grass.
 *
 * The cards taper to the top as well, so the silhouette narrows the way a tuft
 * does instead of ending in a square edge.
 */
export function grassClumpGeometry(height = 1, width = 0.42): THREE.BufferGeometry {
  const cards = 3;
  const positions: number[] = [];
  const uvs: number[] = [];
  const bends: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  for (let card = 0; card < cards; card++) {
    const angle = (card / cards) * Math.PI;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const half = width / 2;
    const base = card * 4;
    /*
     * Four vertices: bottom-left, bottom-right, top-right, top-left. The top
     * pair is narrower than the base, which tapers the card.
     */
    const taper = 0.62;
    const corners: [number, number, number][] = [
      [-half, 0, 0],
      [half, 0, 0],
      [half * taper, 1, 0],
      [-half * taper, 1, 0],
    ];
    for (const [lx, ly] of corners) {
      positions.push(lx * cos, ly * height, lx * sin);
      normals.push(-sin, 0, cos);
      uvs.push(lx / width + 0.5, ly);
      /* Only the top of the card bends. */
      bends.push(ly * ly);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('aBend', new THREE.Float32BufferAttribute(bends, 1));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * A low shrub: several noise-displaced spheres fused into one mass.
 *
 * A shrub is the cheapest thing in the scene to get wrong, because a single
 * sphere is instantly recognisable as one. Three or four overlapping blobs of
 * different sizes, noise-displaced and squashed, read as a bush at any distance
 * the camera can reach them from.
 */
export function shrubGeometry(seed: number): THREE.BufferGeometry {
  const random = mulberry32(seed);
  const parts: THREE.BufferGeometry[] = [];
  const count = 3 + Math.floor(random() * 2);
  for (let i = 0; i < count; i++) {
    const radius = 0.4 + random() * 0.36;
    const blob = new THREE.IcosahedronGeometry(radius, 2);
    roughen(blob, 5 + random() * 5, 0.34, seed + i * 13);
    blob.scale(1 + random() * 0.3, 0.62 + random() * 0.3, 1 + random() * 0.3);
    blob.translate(
      (random() - 0.5) * 0.62,
      0.24 + random() * 0.36,
      (random() - 0.5) * 0.62,
    );
    parts.push(blob);
  }
  const merged = mergeGeometries(parts);
  for (const part of parts) part.dispose();
  merged.computeVertexNormals();
  merged.computeBoundingSphere();
  return merged;
}

/** Merge geometries position-by-position, keeping UVs where every part has them. */
function mergeGeometries(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const hasUv = parts.every((part) => part.attributes.uv);
  const push = (geometry: THREE.BufferGeometry, index: number) => {
    const position = geometry.attributes.position as THREE.BufferAttribute;
    positions.push(position.getX(index), position.getY(index), position.getZ(index));
    if (hasUv) {
      const uv = geometry.attributes.uv as THREE.BufferAttribute;
      uvs.push(uv.getX(index), uv.getY(index));
    }
  };
  for (const geometry of parts) {
    const index = geometry.index;
    if (index) {
      const array = index.array as ArrayLike<number>;
      for (let i = 0; i < array.length; i++) push(geometry, array[i]);
    } else {
      for (let i = 0; i < geometry.attributes.position.count; i++) push(geometry, i);
    }
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (hasUv) merged.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  return merged;
}

/* ── Textures ────────────────────────────────────────────────────────── */

/** Soft radial falloff used for mist layers — generated, never downloaded. */
export function radialFalloffTexture(size = 128): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const gradient = ctx.createRadialGradient(
      size / 2,
      size / 2,
      0,
      size / 2,
      size / 2,
      size / 2,
    );
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.45, 'rgba(255,255,255,0.55)');
    gradient.addColorStop(0.78, 'rgba(255,255,255,0.14)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/** Equirectangular sky gradient, pre-filtered by PMREM into an environment. */
export function skyEnvironmentTexture(theme: {
  skyTop: number;
  skyHorizon: number;
  fog: number;
}): THREE.CanvasTexture {
  const width = 64;
  const height = 64;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    const hex = (value: number) => `#${value.toString(16).padStart(6, '0')}`;
    gradient.addColorStop(0, hex(theme.skyTop));
    gradient.addColorStop(0.46, hex(theme.skyHorizon));
    gradient.addColorStop(0.52, hex(theme.fog));
    gradient.addColorStop(1, hex(theme.fog));
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}
