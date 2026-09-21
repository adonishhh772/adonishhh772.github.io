/**
 * The island's terrain: one height field, shared by everything that stands on
 * it.
 *
 * Before this module the plateau was a flat disc at a single height and every
 * prop, stone and tree was placed at that height by hand. Nothing could be
 * relaid without re-deriving a dozen offsets, and a surface that is exactly
 * flat reads — correctly — as a table top. A landform is not a flat surface
 * with things on it: it is a field of small, related irregularities, and the
 * only way to place anything convincingly on it is to ask the terrain where
 * its own surface is.
 *
 * So this is the single source of truth for ground height. The island mesh is
 * displaced by `heightAt`, and every scatter pass — outcrops, scree, shrubs,
 * grass, trees — asks the same function where to plant itself. There is no
 * second copy of the numbers to drift out of step, which is the failure mode
 * that produced rocks floating over a dip and trees sunk to their canopies.
 *
 * The field is built from three layers with deliberately different jobs:
 *
 *  - `rolling` — broad, gentle swells. This is what makes ground read as
 *    ground from the overview camera; it is small in amplitude because the
 *    campus is built on this surface and a terrace cannot sit on a wave.
 *  - `detail` — tighter bumps that catch the key light as facets and give the
 *    grass something to follow.
 *  - `micro` — very fine roughness, barely a few centimetres. At the overview
 *    distance this is under a pixel, but it is what stops a lit slope from
 *    reading as a smooth plastic sheet when the camera comes down to a
 *    destination.
 *
 * Every layer is deterministic and continuous, so it can be sampled at any
 * point in any order by any caller.
 */

import * as THREE from 'three';

/* ── Deterministic value noise ───────────────────────────────────────── */

/**
 * Precomputed permutation table.
 *
 * The noise below is sampled a few million times while the island and its
 * scatter are built, so the hash has to be a table lookup rather than an
 * arithmetic one — a multiply-xor hash per corner is measurable in the boot
 * time of a world that punishes a slow first frame.
 */
const PERM = (() => {
  const table = new Uint8Array(512);
  let seed = 0x9e3779b9;
  const random = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
  const source = new Uint8Array(256);
  for (let i = 0; i < 256; i++) source[i] = i;
  /* Fisher–Yates, so the permutation is fixed but not patterned. */
  for (let i = 255; i > 0; i--) {
    const j = random() % (i + 1);
    const swap = source[i];
    source[i] = source[j];
    source[j] = swap;
  }
  for (let i = 0; i < 512; i++) table[i] = source[i & 255];
  return table;
})();

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Two-dimensional value noise in roughly `[-1, 1]`. */
export function noise2(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const xa = xi & 255;
  const ya = yi & 255;
  const aa = PERM[PERM[xa] + ya] / 255;
  const ba = PERM[PERM[xa + 1] + ya] / 255;
  const ab = PERM[PERM[xa] + ya + 1] / 255;
  const bb = PERM[PERM[xa + 1] + ya + 1] / 255;
  const u = fade(xf);
  const v = fade(yf);
  const top = aa + (ba - aa) * u;
  const bottom = ab + (bb - ab) * u;
  return (top + (bottom - top) * v) * 2 - 1;
}

/** Fractal Brownian motion: `octaves` layers at doubling frequency, halving gain. */
export function fbm(x: number, y: number, octaves: number, lacunarity = 2, gain = 0.5): number {
  let amplitude = 1;
  let frequency = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise2(x * frequency, y * frequency) * amplitude;
    norm += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

/**
 * Ridged noise: the absolute value of a signed field, folded and inverted.
 *
 * This is what turns smooth swells into something with a crest and a shoulder,
 * which is the difference between a rolling field and a set of dunes.
 */
export function ridged(x: number, y: number, octaves: number): number {
  let amplitude = 1;
  let frequency = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const value = 1 - Math.abs(noise2(x * frequency, y * frequency));
    sum += value * value * amplitude;
    norm += amplitude;
    amplitude *= 0.5;
    frequency *= 2.07;
  }
  return norm > 0 ? sum / norm : 0;
}

/* ── The island envelope ─────────────────────────────────────────────── */

/** Height of the island's plateau before the relief is applied. */
export const PLATEAU_Y = 1.02;
/** The radius at which the plateau gives way to the cliff face. */
export const PLATEAU_RADIUS = 12.2;
/** The cliff keeps opening out to here, then falls away. */
export const LIP_RADIUS = 14.05;

/**
 * The plateau's radial silhouette: the radius of the ground at a given radius
 * from the axis, as a function of the *square* of the normalised distance.
 *
 * The plateau's own edge is not a circle. Written as a smooth fall from a
 * central crown to the lip, it gives the shelf the shallow dome that ground
 * has, and it is shared with the island mesh so the two cannot disagree.
 */
export function profileHeight(radius: number): number {
  if (radius >= PLATEAU_RADIUS) return PLATEAU_Y * 0.97;
  const t = radius / PLATEAU_RADIUS;
  /* A gentle crown: 0.12 units at the middle, falling off as the square. */
  return PLATEAU_Y + 0.12 * (1 - t * t) - 0.02 * t;
}

/** How many units the cliff face falls per unit of outward radius. */
function aboveLip(radius: number): number {
  if (radius <= LIP_RADIUS) return 0;
  /* A sharply falling face, so the ground ends in a cliff rather than a skirt. */
  const over = radius - LIP_RADIUS;
  return -(over * over * 1.6 + over * 1.1);
}

/* ── Flattened ground: where the campus stands ───────────────────────── */

export interface FlatSpot {
  x: number;
  z: number;
  /** Radius of the flat ground. */
  radius: number;
  /** How far past `radius` the flattening fades out. */
  falloff: number;
  /** Ground height held flat here. */
  y: number;
}

/**
 * The terraces, the walkway ring and the entrance avenue, as flat spots.
 *
 * The architecture was laid out against a flat island and its numbers are
 * fixed, so the terrain has to yield to it rather than the other way round:
 * the ground is levelled inside these discs and eased back into the natural
 * relief outside them. Without this the ring walk would undulate into the
 * ground at one end and hover over it at the other, which reads exactly as
 * badly as it sounds.
 */
export const FLAT_SPOTS: FlatSpot[] = [
  /* The observatory terrace: the largest single platform on the island. */
  { x: 0, z: 0, radius: 4.6, falloff: 3.4, y: 1.0 },
  /*
   * The ring the five destinations stand on. A ring of overlapping discs
   * rather than one annulus, because the flattening has to be measured from
   * the walkway itself, which is a curve — and a curve is what the discs
   * approximate closely enough that the walk never leaves the ground.
   */
  ...[
    [-23, 9.2],
    [22, 9.2],
    [72, 9.2],
    [137, 9.2],
    [234, 9.2],
  ].map(([degrees, reach]) => {
    const angle = (degrees * Math.PI) / 180;
    return {
      x: Math.sin(angle) * reach,
      z: Math.cos(angle) * reach,
      /* Reach spans the walkway between neighbours, so the path is level too. */
      radius: 5.6,
      falloff: 4.2,
      y: 1.0,
    } satisfies FlatSpot;
  }),
  /* The entrance avenue, out from the terrace toward the contact bearing. */
  ...[0.55, 0.72, 0.86, 0.97].map((fraction) => {
    const angle = (137 * Math.PI) / 180;
    return {
      x: Math.sin(angle) * 6.2 * fraction,
      z: Math.cos(angle) * 6.2 * fraction,
      radius: 2.2,
      falloff: 2.6,
      y: 1.0,
    } satisfies FlatSpot;
  }),
];

/** Weight by which the natural relief is replaced by the flat height, 0..1. */
export function flattenWeight(x: number, z: number): number {
  let weight = 0;
  for (let i = 0; i < FLAT_SPOTS.length; i++) {
    const spot = FLAT_SPOTS[i];
    const distance = Math.hypot(x - spot.x, z - spot.z);
    if (distance >= spot.radius + spot.falloff) continue;
    const t = distance <= spot.radius ? 1 : 1 - (distance - spot.radius) / spot.falloff;
    /* Smoothstep, so the ground eases into the terrace with no visible crease. */
    const smooth = t * t * (3 - 2 * t);
    if (smooth > weight) weight = smooth;
    if (weight >= 1) return 1;
  }
  return weight;
}

/* ── Relief ──────────────────────────────────────────────────────────── */

/** Ground height of the natural relief before the flattening is applied. */
function reliefAt(x: number, z: number): number {
  const radius = Math.hypot(x, z);
  const base = profileHeight(radius);

  /*
   * The relief is faded out toward the rim as well as by the flattening, so
   * the ground meets the cliff lip level: a swell that reached the lip would
   * leave the rock band following a wave instead of a shoreline.
   */
  const toLip = THREE.MathUtils.smoothstep(radius, PLATEAU_RADIUS - 3.4, PLATEAU_RADIUS);
  const rimFade = 1 - toLip * 0.82;

  const rolling = fbm(x * 0.048, z * 0.048, 4) * 0.66;
  const detail = fbm(x * 0.17 + 11.3, z * 0.17 - 7.1, 3) * 0.19;
  const micro = fbm(x * 0.62 - 3.7, z * 0.62 + 5.2, 2) * 0.05;
  /*
   * A crest term, kept deliberately small.
   *
   * `ridged` noise is built from the absolute value of a signed field, which
   * gives it ridges — and a ridge, sampled on a radial mesh, is a *ring*. At a
   * larger amplitude the plateau came out as concentric terraces, which reads as
   * a topographic model rather than as ground. At this weight it breaks up the
   * swells without drawing circles on the hillside.
   */
  const crest = (ridged(x * 0.13 + 21.7, z * 0.13 + 4.4, 2) - 0.5) * 0.16;

  return base + (rolling + detail + crest) * rimFade + micro;
}

/**
 * The height of the ground at a point, in world space.
 *
 * `flatten` defaults to on, which is what the island mesh and the scatter
 * passes both want. Passing `false` returns the natural relief, which is what
 * the parts of the world that have to know the *underlying* landform ask for.
 */
export function heightAt(x: number, z: number, flatten = true): number {
  const radius = Math.hypot(x, z);
  if (radius >= LIP_RADIUS) return profileHeight(radius) + aboveLip(radius);
  if (!flatten) return reliefAt(x, z);
  const weight = flattenWeight(x, z);
  if (weight <= 0) return reliefAt(x, z);
  if (weight >= 1) return FLAT_SPOTS[0].y;
  return reliefAt(x, z) * (1 - weight) + 1.0 * weight;
}

/** How far below the plateau the cliff has fallen at a given radius. */
export function isOnPlateau(x: number, z: number): boolean {
  return Math.hypot(x, z) < PLATEAU_RADIUS;
}

/**
 * The surface normal at a point in *ground* space, given as a radius and an
 * angle, plus the outward radial direction there.
 *
 * The island's mesh is a lathe, so its vertices arrive as (radius, angle) rather
 * than as a grid, and `normalAt` — which samples a Cartesian neighbourhood —
 * cannot be used on them without collapsing onto the axis. This evaluates the
 * same height field along the two directions the surface actually has: outward,
 * and around. The caller supplies the outward direction, so the two agree by
 * construction rather than by a second copy of the trigonometry.
 */
export function radialNormal(
  radius: number,
  angle: number,
  outward: THREE.Vector3,
  target = new THREE.Vector3(),
): THREE.Vector3 {
  const step = 0.14;
  const tangent = new THREE.Vector3(-outward.z, 0, outward.x);

  const outwardHeight =
    heightAt(
      (radius + step) * Math.cos(angle),
      (radius + step) * Math.sin(angle),
    ) -
    heightAt(
      (radius - step) * Math.cos(angle),
      (radius - step) * Math.sin(angle),
    );

  /*
   * The tangent step is a short arc on the circle of that radius, so the two
   * differences describe the same physical distance and the normal is not
   * skewed near the axis, where a degree of angle is almost no distance at all.
   */
  const tangentHeight =
    heightAt(radius * Math.cos(angle) + tangent.x * step, radius * Math.sin(angle) + tangent.z * step) -
    heightAt(radius * Math.cos(angle) - tangent.x * step, radius * Math.sin(angle) - tangent.z * step);

  return target
    .copy(outward)
    .multiplyScalar(-outwardHeight)
    .addScaledVector(tangent, -tangentHeight)
    .addScaledVector(UP_AXIS, 2 * step)
    .normalize();
}

const UP_AXIS = new THREE.Vector3(0, 1, 0);

/**
 * The surface normal at a point, from central differences on the height field.
 *
 * Derived rather than averaged from the mesh, so a prop can be aligned to the
 * slope it stands on without depending on which triangle it happened to land
 * in — and so the answer is the same before and after the mesh is built.
 */
export function normalAt(
  x: number,
  z: number,
  target = new THREE.Vector3(),
  flatten = true,
): THREE.Vector3 {
  const step = 0.14;
  const left = heightAt(x - step, z, flatten);
  const right = heightAt(x + step, z, flatten);
  const back = heightAt(x, z - step, flatten);
  const front = heightAt(x, z + step, flatten);
  return target.set(left - right, 2 * step, back - front).normalize();
}

/** How steeply the ground rises at a point, 0 for level and 1 for vertical. */
export function slopeAt(x: number, z: number, flatten = true): number {
  const normal = normalAt(x, z, new THREE.Vector3(), flatten);
  return 1 - THREE.MathUtils.clamp(normal.y, 0, 1);
}

/* ── Prop anchoring ──────────────────────────────────────────────────── */

/**
 * The transform that beds an object into the ground.
 *
 * Ground cover is not placed *on* terrain, it is placed *in* it: a stone sunk
 * by a fraction of its own height, a shrub with its base below the surface. The
 * `sink` argument is that fraction, expressed in the object's own local units,
 * and the yaw/tilt are applied before the sink so a tilted object is sunk along
 * its own up axis rather than the world's — which is what stops a leaning tree
 * from hanging over a dip with its roots in the air.
 */
export function bedMatrix(
  x: number,
  z: number,
  options: {
    scale: THREE.Vector3;
    yaw?: number;
    /** Tilt in radians, about a horizontal axis. */
    tilt?: number;
    /** Bearing of the tilt axis, in radians. */
    tiltBearing?: number;
    /** Fraction of the object's height buried, measured along its own up axis. */
    sink?: number;
    /** Sink is scaled by this before use. */
    sinkHeight?: number;
    target?: THREE.Matrix4;
    flatten?: boolean;
  },
): THREE.Matrix4 {
  const {
    scale,
    yaw = 0,
    tilt = 0,
    tiltBearing = 0,
    sink = 0,
    sinkHeight = 1,
    target = new THREE.Matrix4(),
    flatten = true,
  } = options;

  const quaternion = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    yaw,
  );
  if (tilt !== 0) {
    const axis = new THREE.Vector3(Math.cos(tiltBearing), 0, Math.sin(tiltBearing));
    quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(axis, tilt));
  }

  const y = heightAt(x, z, flatten) - sink * sinkHeight * scale.y;
  return target.compose(new THREE.Vector3(x, y, z), quaternion, scale);
}
