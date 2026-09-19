/**
 * Procedural geometry for the observatory.
 *
 * Everything here is generated at runtime: no external models, no texture
 * downloads, no paid asset services. Builders return plain geometries or
 * instance matrices so the world can share a small number of draw calls.
 */

import * as THREE from 'three';

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
export function sculptIsland(
  geometry: THREE.BufferGeometry,
  options: { flatAbove?: number; strength?: number; seed?: number } = {},
): void {
  const { flatAbove = 0.4, strength = 0.5, seed = 7 } = options;
  const position = geometry.attributes.position as THREE.BufferAttribute;
  const vector = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    vector.fromBufferAttribute(position, i);
    const radius = Math.hypot(vector.x, vector.z);
    if (radius < 0.001 || vector.y > flatAbove) continue;
    const angle = Math.atan2(vector.z, vector.x);
    const depth = Math.min(1, Math.max(0, (flatAbove - vector.y) / 6));
    const wobble =
      Math.sin(angle * 3 + seed) * 0.55 +
      Math.sin(angle * 5.7 - seed * 0.6) * 0.3 +
      Math.sin(angle * 9.3 + seed * 1.7) * 0.16;
    const scale = 1 + wobble * strength * depth;
    vector.x *= scale;
    vector.z *= scale;
    /* Pull the underside into a slightly asymmetric keel. */
    vector.y -= depth * depth * 0.5 * Math.cos(angle * 2 + seed);
    position.setXYZ(i, vector.x, vector.y, vector.z);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
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

/** Low-poly hills far below, existing only to give the horizon depth. */
export function distantHills(
  seed: number,
  count: number,
  ringRadius: number,
): { matrices: THREE.Matrix4[]; colors: number[] } {
  const random = mulberry32(seed);
  const matrices: THREE.Matrix4[] = [];
  const colors: number[] = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + random() * 0.4;
    const distance = ringRadius * (0.75 + random() * 0.5);
    const height = 10 + random() * 8;
    const width = 22 + random() * 24;
    const matrix = new THREE.Matrix4();
    matrix.compose(
      /* Far below and far away: a low ridge line, not a mountain range
         crowding the island. */
      new THREE.Vector3(
        Math.cos(angle) * distance,
        -60 - height * 0.5,
        Math.sin(angle) * distance,
      ),
      new THREE.Quaternion().setFromAxisAngle(UP, random() * Math.PI),
      new THREE.Vector3(width, height, width),
    );
    matrices.push(matrix);
    /* Nearer hills are darker silhouettes; far ones fade toward the haze. */
    colors.push(THREE.MathUtils.clamp(1 - (distance - ringRadius) / (ringRadius * 0.72), 0.12, 1));
  }
  return { matrices, colors };
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
  const specs: { radius: number; height: number; y: number; yaw: number }[] = [
    { radius: 0.62, height: 1.0, y: 0.78, yaw: 0 },
    { radius: 0.53, height: 0.94, y: 1.24, yaw: Math.PI / 5 },
    { radius: 0.42, height: 0.9, y: 1.7, yaw: (Math.PI * 2) / 5 },
    { radius: 0.29, height: 0.86, y: 2.16, yaw: (Math.PI * 3) / 5 },
    { radius: 0.15, height: 0.8, y: 2.6, yaw: (Math.PI * 4) / 5 },
  ];
  const tiers = specs.map((spec) => {
    /* Nine radial segments with a slight squash: faceted enough to catch the
       key light, round enough not to look cut out. */
    const cone = new THREE.ConeGeometry(spec.radius, spec.height, 9, 1, false);
    cone.scale(1, 1, 0.9);
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
