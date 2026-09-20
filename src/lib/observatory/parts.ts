/**
 * Procedural geometry for the observatory.
 *
 * Everything here is generated at runtime: no external models, no texture
 * downloads, no paid asset services. Builders return plain geometries or
 * instance matrices so the world can share a small number of draw calls.
 */

import * as THREE from 'three';

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
 * Built from a single `LatheGeometry` traced round `ISLAND_PROFILE`, so the
 * top, the cliff, the underside and both caps are the same watertight surface.
 * Vertices are then displaced by a per-sector radial bite — flat facets rather
 * than a smooth bulge — and shaded by height and steepness into four bands.
 * The band colours are recomputed from the live theme, so the same geometry
 * carries the day and the night palette without a second build.
 *
 * `computeVertexNormals` runs after the displacement, on the closed mesh, so
 * every normal is a genuine average of the faces around its vertex. The
 * earlier build re-computed normals on a lathe that had no caps, which is how
 * a surface ends up lit from behind.
 */
export function islandGeometry(
  options: {
    seed?: number;
    sectors?: number;
    strength?: number;
    /** Radial segments around the axis. */
    segments?: number;
  } = {},
): THREE.BufferGeometry {
  const { seed = 11, sectors = 11, strength = 0.03, segments = 128 } = options;
  const geometry = new THREE.LatheGeometry(
    ISLAND_PROFILE.map(([x, y]) => new THREE.Vector2(Math.max(x, 0.0001), y)),
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
    if (radius < 0.05) continue;
    scratchNormal.fromBufferAttribute(normals, i);
    /*
     * Only the outward-facing shell is bitten. The caps are horizontal, so a
     * vertical normal means "cap" and a sideways one means "wall"; using the
     * normal instead of a raw height test keeps the flat plateau perfectly
     * flat while still cutting the cliff.
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
    const scale = 1 + offsets[sector] * strength * wall * (0.45 + depth * 0.9);
    vector.x *= scale;
    vector.z *= scale;
    /* Sink the very bottom, so the keel is a point rather than a disc. */
    if (vector.y < -6) vector.y -= (1 - radius / 6) * 0.4;
    position.setXYZ(i, vector.x, vector.y, vector.z);
  }
  position.needsUpdate = true;

  /*
   * Normals are averaged on the indexed mesh — where the lathe's seam vertices
   * are still shared — and only then is the geometry flattened into the
   * non-indexed form the band colours want. Computing them afterwards would
   * average nothing: every triangle would be its own island and the plateau
   * would shade as a mosaic.
   */
  geometry.computeVertexNormals();
  const flat = geometry.toNonIndexed();
  geometry.dispose();
  flat.computeBoundingSphere();
  return flat;
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
  const span = 1.7;
  for (let i = 0; i < lobes; i++) {
    const t = lobes === 1 ? 0.5 : i / (lobes - 1);
    /* A wide, flat footprint: a cloud is much broader than it is tall. */
    const x = (t - 0.5) * span * (0.9 + random() * 0.25);
    const radius = 0.42 + Math.sin(Math.PI * t) * 0.4 + random() * 0.14;
    const lobe = new THREE.IcosahedronGeometry(radius, 1);
    lobe.scale(1.5, 0.62 + random() * 0.18, 1.05);
    lobe.translate(x, (random() - 0.5) * 0.09, (random() - 0.5) * 0.32);
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
 * upper-left of every lobe, cooler and dimmer underneath.
 */export function paintCloud(geometry: THREE.BufferGeometry, light: number, shade: number): void {
  const position = geometry.attributes.position as THREE.BufferAttribute;
  const normal = geometry.attributes.normal as THREE.BufferAttribute;
  const bright = new THREE.Color(light);
  const dark = new THREE.Color(shade);
  const scratch = new THREE.Color();
  const colors = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    /* A fixed direction rather than the scene's key light: the cloud reads the
       same at every hour, which is what keeps it from turning grey at night. */
    const facing = normal.getX(i) * 0.4 + normal.getY(i) * 0.8 + normal.getZ(i) * 0.2;
    const t = THREE.MathUtils.clamp(facing * 0.5 + 0.5, 0, 1);
    scratch.copy(dark).lerp(bright, Math.pow(t, 0.8));
    colors[i * 3] = scratch.r;
    colors[i * 3 + 1] = scratch.g;
    colors[i * 3 + 2] = scratch.b;
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
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

/* ── Vegetation ──────────────────────────────────────────────────────── */

export interface ConiferGeometry {
  trunk: THREE.CylinderGeometry;
  /** Stacked canopy tiers. Each is rotated differently so the silhouette
      never reads as one cone sitting on another. */
  tiers: THREE.ConeGeometry[];
}

/**
 * A conifer with four staggered tiers instead of two.
 *
 * The old two-cone tree read as a plain triangle from the island's camera
 * distance. Tiers at decreasing radius, each turned on its own axis, give the
 * stepped silhouette a fir actually has, and the taper is wider at the base
 * so the trees anchor to the ground instead of hovering over it.
 */
export function coniferGeometry(): ConiferGeometry {
  const specs: { radius: number; height: number; y: number; yaw: number; squash: number }[] = [
    { radius: 0.66, height: 1.05, y: 0.8, yaw: 0, squash: 0.94 },
    { radius: 0.56, height: 0.98, y: 1.28, yaw: Math.PI / 5, squash: 0.9 },
    { radius: 0.45, height: 0.94, y: 1.76, yaw: (Math.PI * 2) / 5, squash: 0.86 },
    { radius: 0.32, height: 0.9, y: 2.24, yaw: (Math.PI * 3) / 5, squash: 0.82 },
    { radius: 0.17, height: 0.84, y: 2.7, yaw: (Math.PI * 4) / 5, squash: 0.78 },
  ];
  const tiers = specs.map((spec) => {
    /* Nine radial segments with a slight squash: faceted enough to catch the
       key light, round enough not to look cut out. Each tier is a little
       tighter than the one below, which is what gives a fir its taper. */
    const cone = new THREE.ConeGeometry(spec.radius, spec.height, 9, 1, false);
    cone.scale(1, 1, spec.squash);
    cone.rotateY(spec.yaw);
    cone.translate(0, spec.y, 0);
    return cone;
  });
  const trunk = new THREE.CylinderGeometry(0.06, 0.12, 0.9, 6);
  trunk.translate(0, 0.42, 0);
  return { trunk, tiers };
}

export interface BroadleafGeometry {
  trunk: THREE.CylinderGeometry;
  canopy: THREE.IcosahedronGeometry;
}

/**
 * A second species. A treeline of identical conifers reads as a texture
 * rather than as planting; a rounded crown beside them makes it a wood.
 */
export function broadleafGeometry(): BroadleafGeometry {
  const trunk = new THREE.CylinderGeometry(0.07, 0.12, 1.3, 6);
  trunk.translate(0, 0.62, 0);
  const canopy = new THREE.IcosahedronGeometry(0.78, 1);
  canopy.scale(1.08, 0.94, 1.02);
  canopy.translate(0, 1.72, 0);
  return { trunk, canopy };
}

/*
 * A boulder.
 *
 * Displacement is keyed on the vertex position rather than the vertex index,
 * so faces that share a corner move together and the shell stays closed. The
 * amplitude is small and the proportions stay close to cubic: a rock that has
 * been worn, not a shard — which is what the earlier high-amplitude version
 * produced once it was squashed and laid on the ground.
 */
export function boulderGeometry(seed: number, squash = 0.72): THREE.BufferGeometry {
  const geometry = new THREE.IcosahedronGeometry(1, 1);
  const position = geometry.attributes.position as THREE.BufferAttribute;
  const vector = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    vector.set(position.getX(i), position.getY(i), position.getZ(i));
    /* A cheap deterministic hash of the rounded corner. */
    const key = `${vector.x.toFixed(3)}:${vector.y.toFixed(3)}:${vector.z.toFixed(3)}`;
    let hash = seed >>> 0;
    for (let c = 0; c < key.length; c++) {
      hash = (Math.imul(hash ^ key.charCodeAt(c), 16777619) >>> 0) % 100003;
    }
    const scale = 0.84 + ((hash % 1000) / 1000) * 0.28;
    const lift = 1 + (vector.y > 0 ? 0.05 : 0);
    position.setXYZ(i, vector.x * scale, vector.y * scale * squash * lift, vector.z * scale);
  }
  geometry.computeVertexNormals();
  return geometry;
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
