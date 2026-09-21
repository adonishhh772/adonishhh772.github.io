/**
 * Procedural PBR textures.
 *
 * Everything the ground, the rock and the stone are coloured with is generated
 * here at boot: albedo, a normal map derived from a height field, and a
 * roughness map. Nothing is downloaded, nothing is licensed, and the whole set
 * costs a few dozen milliseconds of canvas work rather than a few megabytes of
 * transfer.
 *
 * The distinction that matters is between a *pattern* and a *surface*. A noise
 * field painted straight into a colour map gives you a pattern: at any zoom it
 * is the same picture, and it reads as wallpaper. A surface is built the other
 * way round — a height field first, then colour and roughness *derived* from
 * it, so the crevices are dark because they are crevices and the crests are dry
 * because they are crests. That is why every generator below starts from
 * `heights` and shades out of it.
 *
 * All of the noise here tiles: it is sampled on a wrapped lattice, so a texture
 * can repeat across the island without a visible seam. Everything is also
 * deterministic, so the same island is textured the same way on every visit.
 */

import * as THREE from 'three';

const SIZE = 256;

/* ── Tiling noise ────────────────────────────────────────────────────── */

/**
 * A tileable value-noise lattice.
 *
 * The lattice wraps at `period`, which is what makes the result seamless: the
 * interpolation between the last cell and the first is a real interpolation
 * between two stored values rather than a jump off the end of the array.
 */
function latticeNoise(seed: number, period: number): (x: number, y: number) => number {
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const grid = new Float32Array(period * period);
  for (let i = 0; i < grid.length; i++) grid[i] = random();

  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  return (x: number, y: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const wrap = (v: number) => ((v % period) + period) % period;
    const x0 = wrap(xi);
    const y0 = wrap(yi);
    const x1 = wrap(xi + 1);
    const y1 = wrap(yi + 1);
    const u = fade(xf);
    const v = fade(yf);
    const a = grid[y0 * period + x0];
    const b = grid[y0 * period + x1];
    const c = grid[y1 * period + x0];
    const d = grid[y1 * period + x1];
    const top = a + (b - a) * u;
    const bottom = c + (d - c) * u;
    return top + (bottom - top) * v;
  };
}

/** Tileable fractal noise over a unit square, in roughly `[0, 1]`. */
function tiledFbm(seed: number, basePeriod: number, octaves: number): (u: number, v: number) => number {
  const layers: { noise: (x: number, y: number) => number; frequency: number; amplitude: number }[] = [];
  let amplitude = 1;
  let frequency = basePeriod;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    layers.push({ noise: latticeNoise(seed + i * 7919, frequency), frequency, amplitude });
    norm += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return (u: number, v: number) => {
    let sum = 0;
    for (const layer of layers) {
      sum += layer.noise(u * layer.frequency, v * layer.frequency) * layer.amplitude;
    }
    return sum / norm;
  };
}

/** Tileable ridged noise, for crevices and crack lines. */
function tiledRidged(seed: number, basePeriod: number, octaves: number): (u: number, v: number) => number {
  const fbm = tiledFbm(seed, basePeriod, octaves);
  return (u: number, v: number) => {
    const value = fbm(u, v);
    return 1 - Math.abs(value * 2 - 1);
  };
}

/* ── Canvas plumbing ─────────────────────────────────────────────────── */

function canvas(size = SIZE): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const element = document.createElement('canvas');
  element.width = element.height = size;
  const ctx = element.getContext('2d');
  if (!ctx) throw new Error('2d canvas unavailable');
  return { canvas: element, ctx };
}

function dataTexture(
  pixels: Uint8ClampedArray,
  size: number,
  options: { srgb?: boolean; repeat?: number } = {},
): THREE.DataTexture {
  const texture = new THREE.DataTexture(pixels, size, size, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = options.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  const repeat = options.repeat ?? 1;
  texture.repeat.set(repeat, repeat);
  texture.needsUpdate = true;
  return texture;
}

/**
 * Convert a height field into a tangent-space normal map.
 *
 * Central differences on the wrapped field, so the map tiles with the height
 * it came from. The `strength` is the tangent-space slope per unit of height:
 * a high value gives a jagged, gravelly surface and a low one a soft, worn
 * one, which is the only knob that actually needs tuning per material.
 */
function normalPixels(
  height: Float32Array,
  size: number,
  strength: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(size * size * 4);
  const at = (x: number, y: number) =>
    height[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      /* The normal of the height field z = h(x, y), normalised. */
      const length = Math.sqrt(dx * dx + dy * dy + 1);
      const index = (y * size + x) * 4;
      out[index] = ((-dx / length) * 0.5 + 0.5) * 255;
      out[index + 1] = ((-dy / length) * 0.5 + 0.5) * 255;
      out[index + 2] = (1 / length) * 0.5 * 255 + 127.5;
      out[index + 3] = 255;
    }
  }
  return out;
}

export interface PbrSet {
  map: THREE.DataTexture;
  normalMap: THREE.DataTexture;
  roughnessMap: THREE.DataTexture;
  /** Per-texel height, kept so a second material can reuse the same surface. */
  height: Float32Array;
  size: number;
}

/* ── Palette mixing ──────────────────────────────────────────────────── */

interface Color {
  r: number;
  g: number;
  b: number;
}

function rgb(hex: number): Color {
  return { r: (hex >> 16) & 0xff, g: (hex >> 8) & 0xff, b: hex & 0xff };
}

function mix(a: Color, b: Color, t: number): Color {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  };
}

function scale(color: Color, k: number): Color {
  return { r: color.r * k, g: color.g * k, b: color.b * k };
}

/** A packed colour as a CSS `rgb()`, for a canvas gradient stop. */
function css(color: Color): string {
  return `rgb(${Math.round(color.r)},${Math.round(color.g)},${Math.round(color.b)})`;
}

/* ── Ground ──────────────────────────────────────────────────────────── */

export interface GroundColors {
  /** The dominant vegetation tone. */
  grass: number;
  /** Dry, sun-bleached grass — the second tone in a real field. */
  dry: number;
  /** Bare soil showing through. */
  soil: number;
  /** Weathered stone. */
  stone: number;
  /** A deep green, for the sheltered pockets. */
  moss: number;
}

/**
 * The ground texture: grass tufts over soil, over stone.
 *
 * Three overlapping scales, which is what stops it reading as a single noise
 * pattern: a broad patchiness that decides whether this texel is field, dirt or
 * rock; a tuft layer of short, high-frequency strokes that gives the grass its
 * grain; and a fine stipple on top for the texture inside a patch. Colour and
 * roughness are both read out of the combined height, so the dirt in a hollow
 * is darker *and* smoother than the grass on the ridge above it.
 */
export function groundPbr(colors: GroundColors): PbrSet {
  const size = SIZE;
  const heights = new Float32Array(size * size);
  const patchiness = tiledFbm(1201, 4, 4);
  const tufts = tiledFbm(1307, 48, 2);
  const stipple = tiledFbm(1409, 96, 1);
  const erosion = tiledFbm(1511, 12, 3);

  const grass = rgb(colors.grass);
  const dry = rgb(colors.dry);
  const soil = rgb(colors.soil);
  const stone = rgb(colors.stone);
  const moss = rgb(colors.moss);

  const map = new Uint8ClampedArray(size * size * 4);
  const rough = new Uint8ClampedArray(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const index = (y * size + x) * 4;

      const patch = patchiness(u, v);
      const grain = tufts(u, v);
      const fine = stipple(u, v);
      const wear = erosion(u, v);

      /*
       * The height the normal map is built from. Tufts dominate because they
       * are what the eye reads as grass; the broad erosion field only lifts
       * and drops the whole patch, which is what gives the ground its large
       * scale relief.
       */
      const height = grain * 0.58 + fine * 0.16 + wear * 0.26;
      heights[y * size + x] = height;

      /*
       * Bare ground where the erosion field peaks: the same field that decides
       * the relief decides where the cover has failed, so dirt collects in the
       * hollows instead of being sprinkled on at random.
       */
      const bare = Math.min(1, Math.max(0, (wear - 0.56) * 3.4 + (patch - 0.5) * 0.8));
      const rocky = Math.min(1, Math.max(0, (wear - 0.74) * 5));

      /*
       * Grass itself varies: fresh growth in the shade of the noise, bleached
       * straw where it is exposed. A field of one green is the single most
       * common giveaway that a surface is procedural.
       */
      const dryness = Math.min(1, Math.max(0, (patch - 0.34) * 1.9 + (fine - 0.5) * 0.5));
      let color = mix(grass, dry, dryness * 0.8);
      color = mix(color, moss, Math.max(0, (0.4 - patch) * 2.2) * 0.5);
      color = mix(color, soil, bare * 0.86);
      color = mix(color, stone, rocky * 0.9);

      /* Shade from the height field: hollows dark, crests catching the light. */
      const shade = 0.74 + height * 0.52 + (fine - 0.5) * 0.2;
      const shaded = scale(color, shade);

      map[index] = shaded.r;
      map[index + 1] = shaded.g;
      map[index + 2] = shaded.b;
      map[index + 3] = 255;

      /*
       * Roughness: vegetation is rough and stone is rougher still, and it is
       * the *variation* that sells it. A single roughness value across a whole
       * surface makes it look like painted plastic under a moving light.
       */
      const roughness = 0.72 + bare * 0.1 + rocky * 0.14 + (grain - 0.5) * 0.16;
      const value = Math.min(255, Math.max(0, roughness * 255));
      rough[index] = value;
      rough[index + 1] = value;
      rough[index + 2] = value;
      rough[index + 3] = 255;
    }
  }

  return {
    map: dataTexture(map, size, { srgb: true }),
    normalMap: dataTexture(normalPixels(heights, size, 26), size),
    roughnessMap: dataTexture(rough, size),
    height: heights,
    size,
  };
}

/* ── Rock ────────────────────────────────────────────────────────────── */

export interface RockColors {
  stoneDeep: number;
  stone: number;
  /** A mineral streak, for the lit faces. */
  mineral: number;
}

/**
 * Broken rock: fracture planes, vertical striation and mineral speckle.
 *
 * Rock is not noise — it is *fracture*. So the dominant term here is a ridged
 * field sampled with a strong vertical anisotropy, which produces long, mostly
 * vertical crack lines like the ones a cliff face actually has. A second,
 * coarser ridged field cuts across it for the bedding planes. The speckle on
 * top is the mineral grain.
 */
export function rockPbr(colors: RockColors): PbrSet {
  const size = SIZE;
  const heights = new Float32Array(size * size);
  /* Anisotropic sampling: far more variation across the crack than along it. */
  const cracks = tiledRidged(2203, 9, 4);
  const bedding = tiledRidged(2311, 3, 3);
  const grainField = tiledFbm(2417, 64, 2);
  const speckle = tiledFbm(2521, 128, 1);

  const deep = rgb(colors.stoneDeep);
  const light = rgb(colors.stone);
  const mineral = rgb(colors.mineral);

  const map = new Uint8ClampedArray(size * size * 4);
  const rough = new Uint8ClampedArray(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const index = (y * size + x) * 4;

      /* Cracks run downward: sampling x at a much higher rate than y turns an
         isotropic field into one with a grain. */
      const crack = cracks(u * 3.1, v * 0.85);
      const bed = bedding(u * 0.7, v * 2.4);
      const grain = grainField(u, v);
      const fleck = speckle(u, v);

      const crevice = Math.max(0, 1 - crack * 1.35);
      const plane = Math.max(0, 1 - bed * 1.2);
      const height = grain * 0.34 + crack * 0.3 + bed * 0.2 + fleck * 0.16;
      heights[y * size + x] = height - crevice * 0.34 - plane * 0.2;

      /* The rock's own colour runs from dark in the crevice to pale on a fresh
         break, which is what a weathered face looks like from a distance. */
      const exposure = Math.min(1, Math.max(0, crack * 1.25 - 0.25));
      let color = mix(deep, light, exposure * 0.78 + grain * 0.24);
      /* Sun-bleached mineral on the proud faces. */
      color = mix(color, mineral, Math.max(0, fleck - 0.62) * 1.5 * 0.5);
      /* Crevices are not just darker — they are dirtier and cooler. */
      color = scale(color, 0.56 + (1 - crevice) * 0.5 + grain * 0.16);

      map[index] = color.r;
      map[index + 1] = color.g;
      map[index + 2] = color.b;
      map[index + 3] = 255;

      const roughness = 0.84 + exposure * -0.08 + (grain - 0.5) * 0.14 + crevice * 0.12;
      const value = Math.min(255, Math.max(0, roughness * 255));
      rough[index] = value;
      rough[index + 1] = value;
      rough[index + 2] = value;
      rough[index + 3] = 255;
    }
  }

  return {
    map: dataTexture(map, size, { srgb: true }),
    normalMap: dataTexture(normalPixels(heights, size, 34), size),
    roughnessMap: dataTexture(rough, size),
    height: heights,
    size,
  };
}

/* ── Dressed stone ───────────────────────────────────────────────────── */

/**
 * Cut and weathered stone for the terraces, plinths and walls.
 *
 * The opposite brief to the rock: this is *worked* stone, so the relief is
 * fine and regular — a chisel grain, a weathered surface, and a slight
 * pitting — rather than fracture. A building material that shares the cliff's
 * texture would read as part of the cliff.
 */
export function stonePbr(colors: { stone: number; stoneDeep: number }): PbrSet {
  const size = SIZE;
  const heights = new Float32Array(size * size);
  const chisel = tiledRidged(3109, 40, 2);
  const weather = tiledFbm(3217, 10, 3);
  const pits = tiledFbm(3323, 90, 1);

  const base = rgb(colors.stone);
  const deep = rgb(colors.stoneDeep);

  const map = new Uint8ClampedArray(size * size * 4);
  const rough = new Uint8ClampedArray(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const index = (y * size + x) * 4;

      const tool = chisel(u, v);
      const age = weather(u, v);
      const pit = pits(u, v);

      const height = tool * 0.42 + age * 0.42 + pit * 0.16;
      heights[y * size + x] = height;

      /* Grime collects in the low half of the weathering field. */
      const grime = Math.max(0, 0.52 - age) * 2.4;
      let color = mix(base, deep, grime * 0.7 + (1 - tool) * 0.16);
      color = scale(color, 0.88 + height * 0.24);

      map[index] = color.r;
      map[index + 1] = color.g;
      map[index + 2] = color.b;
      map[index + 3] = 255;

      const roughness = 0.68 + grime * 0.2 + (pit - 0.5) * 0.12;
      const value = Math.min(255, Math.max(0, roughness * 255));
      rough[index] = value;
      rough[index + 1] = value;
      rough[index + 2] = value;
      rough[index + 3] = 255;
    }
  }

  return {
    map: dataTexture(map, size, { srgb: true }),
    normalMap: dataTexture(normalPixels(heights, size, 14), size),
    roughnessMap: dataTexture(rough, size),
    height: heights,
    size,
  };
}

/* ── Vegetation cards ────────────────────────────────────────────────── */

/**
 * A grass tuft, drawn as an alpha card.
 *
 * Real grass in a 3D scene is not modelled blade by blade at this scale: it is
 * *cards* — a handful of quads per clump carrying a picture of blades — because a
 * blade is under a pixel wide from any camera the visitor can reach, and what
 * actually reads is the silhouette and the catching of light along it.
 *
 * The blades are drawn as *filled tapered shapes* rather than as strokes. That is
 * the detail the whole card turns on: a stroked line has the same width from base
 * to tip and reads as wire, while a blade that starts wide and comes to a point
 * has the shape grass actually has, and it is the taper — not the colour — that
 * makes a tuft look like a tuft.
 *
 * They are drawn back to front, each row starting a little above the surface, so
 * the card carries some of the depth of a real clump instead of looking like one
 * flat cut-out. The colour runs from a dark base through the mid tone to a
 * bleached tip, which is the shading that turns a flat card into a volume.
 */
export function grassCard(
  seed: number,
  colors: { base: number; mid: number; tip: number },
): THREE.CanvasTexture {
  const width = 128;
  const height = 128;
  const { canvas: element, ctx } = canvas(height);
  ctx.clearRect(0, 0, width, height);

  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const base = rgb(colors.base);
  const mid = rgb(colors.mid);
  const tip = rgb(colors.tip);

  /** One blade: a tapered, bent ribbon, filled with a vertical gradient. */
  const blade = (
    originX: number,
    originY: number,
    length: number,
    lean: number,
    baseWidth: number,
    shade: number,
  ) => {
    const tipX = originX + lean;
    const tipY = originY - length;
    /* The control point bends the blade outward, which is what stops a tuft
       looking like a bundle of straight wires. */
    const controlX = originX + lean * 0.34;
    const controlY = originY - length * 0.62;
    const segments = 7;

    const left: [number, number][] = [];
    const right: [number, number][] = [];
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const oneMinus = 1 - t;
      const x = oneMinus * oneMinus * originX + 2 * oneMinus * t * controlX + t * t * tipX;
      const y = oneMinus * oneMinus * originY + 2 * oneMinus * t * controlY + t * t * tipY;
      /* Tapered to a point, with a slight belly near the base. */
      const half = (baseWidth / 2) * Math.pow(1 - t, 0.72) * (1 + 0.18 * Math.sin(Math.PI * t));
      left.push([x - half, y]);
      right.push([x + half, y]);
    }

    const gradient = ctx.createLinearGradient(0, originY, 0, tipY);
    gradient.addColorStop(0, css(scale(base, shade * 0.55)));
    gradient.addColorStop(0.38, css(scale(mid, shade)));
    gradient.addColorStop(0.82, css(scale(tip, shade * 1.05)));
    gradient.addColorStop(1, css(scale(tip, shade * 1.18)));

    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.moveTo(left[0][0], left[0][1]);
    for (let i = 1; i <= segments; i++) ctx.lineTo(left[i][0], left[i][1]);
    for (let i = segments; i >= 0; i--) ctx.lineTo(right[i][0], right[i][1]);
    ctx.closePath();
    ctx.fill();
  };

  /*
   * Four rows, back to front. The back rows start higher up the card, so the
   * card has a real depth ordering rather than being a single flat layer.
   */
  const rows = 4;
  const perRow = 9;
  for (let row = 0; row < rows; row++) {
    const depth = row / (rows - 1);
    const rowBase = height - depth * height * 0.16;
    for (let i = 0; i < perRow; i++) {
      const x = 8 + (i / (perRow - 1)) * (width - 16) + (random() - 0.5) * 9;
      const length = height * (0.36 + depth * 0.5) * (0.68 + random() * 0.62);
      const lean = (random() - 0.5) * width * 0.42;
      const baseWidth = 2.4 + random() * 2.6 + depth * 1.2;
      const shade = 0.6 + depth * 0.5;
      blade(x, rowBase, length, lean, baseWidth, shade);
    }
  }

  const texture = new THREE.CanvasTexture(element);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/**
 * A foliage card for the trees' outer canopy.
 *
 * Leaves read as a mass of small overlapping shapes with sky showing through,
 * so the card is drawn as clusters of leaf lobes with real gaps between them.
 * Alpha testing on a card with genuine holes is what gives a tree its soft,
 * broken silhouette instead of a solid blob.
 */
export function leafCard(
  seed: number,
  colors: { light: number; mid: number; dark: number },
): THREE.CanvasTexture {
  const size = 128;
  const { canvas: element, ctx } = canvas(size);
  ctx.clearRect(0, 0, size, size);

  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const light = rgb(colors.light);
  const mid = rgb(colors.mid);
  const dark = rgb(colors.dark);

  const leaves = 90;
  for (let i = 0; i < leaves; i++) {
    const x = random() * size;
    const y = random() * size;
    const radius = 3 + random() * 7;
    /* A leaf is longer than it is wide and points outward from the cluster. */
    const angle = random() * Math.PI * 2;
    const squash = 0.42 + random() * 0.3;
    /* Leaves toward the top-left catch the key light; the lower right is shaded. */
    const facing = (x / size) * 0.35 + (1 - y / size) * 0.65;
    const tone = random() * 0.5 + facing * 0.5;
    const color = tone < 0.5 ? mix(dark, mid, tone * 2) : mix(mid, light, (tone - 0.5) * 2);

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.fillStyle = `rgb(${Math.round(color.r)},${Math.round(color.g)},${Math.round(color.b)})`;
    ctx.beginPath();
    ctx.ellipse(0, 0, radius, radius * squash, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  const texture = new THREE.CanvasTexture(element);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/* ── Bark ────────────────────────────────────────────────────────────── */

/**
 * Bark: deep vertical fissures over a fibrous grain.
 *
 * Trees are the tallest thing on the island and their trunks are read edge-on
 * against the sky, so a smooth cylinder is the most obviously fake object in
 * the scene. Fissures running the length of the trunk are what fix it.
 */
export function barkPbr(colors: { bark: number; barkDeep: number }): PbrSet {
  const size = SIZE;
  const heights = new Float32Array(size * size);
  const fissure = tiledRidged(4127, 7, 4);
  const fibre = tiledFbm(4231, 56, 2);
  const knot = tiledFbm(4337, 22, 3);

  const bark = rgb(colors.bark);
  const deep = rgb(colors.barkDeep);

  const map = new Uint8ClampedArray(size * size * 4);
  const rough = new Uint8ClampedArray(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const index = (y * size + x) * 4;

      /* Strongly anisotropic: fissures are long in v and narrow in u. */
      const crack = fissure(u * 6.2, v * 0.7);
      const grain = fibre(u, v);
      const swell = knot(u, v);

      const groove = Math.max(0, 1 - crack * 1.4);
      const height = grain * 0.32 + crack * 0.34 + swell * 0.34 - groove * 0.4;
      heights[y * size + x] = height;

      let color = mix(deep, bark, Math.max(0, crack * 1.2 - 0.1) * 0.8 + grain * 0.22);
      color = scale(color, 0.66 + (1 - groove) * 0.46);
      map[index] = color.r;
      map[index + 1] = color.g;
      map[index + 2] = color.b;
      map[index + 3] = 255;

      const roughness = 0.88 + (grain - 0.5) * 0.1;
      const value = Math.min(255, Math.max(0, roughness * 255));
      rough[index] = value;
      rough[index + 1] = value;
      rough[index + 2] = value;
      rough[index + 3] = 255;
    }
  }

  return {
    map: dataTexture(map, size, { srgb: true }),
    normalMap: dataTexture(normalPixels(heights, size, 30), size),
    roughnessMap: dataTexture(rough, size),
    height: heights,
    size,
  };
}

/* ── The library ─────────────────────────────────────────────────────── */

export interface TextureLibrary {
  ground: PbrSet;
  rock: PbrSet;
  stone: PbrSet;
  bark: PbrSet;
  grassCards: THREE.CanvasTexture[];
  leafCards: THREE.CanvasTexture[];
  dispose(): void;
}

export interface TexturePalette {
  grass: number;
  dry: number;
  soil: number;
  stoneAlt: number;
  moss: number;
  stoneDeep: number;
  stone: number;
  mineral: number;
  bark: number;
  barkDeep: number;
  leafLight: number;
  leafMid: number;
  leafDark: number;
  grassBase: number;
  grassMid: number;
  grassTip: number;
}

/**
 * Build every texture the world uses, once.
 *
 * A single call rather than a texture per material, because the cost is
 * dominated by the per-texel loops: generating a set on demand would stall a
 * first frame at exactly the moment the visitor is deciding whether the site
 * works.
 */
export function buildTextures(palette: TexturePalette): TextureLibrary {
  const ground = groundPbr({
    grass: palette.grass,
    dry: palette.dry,
    soil: palette.soil,
    stone: palette.stoneAlt,
    moss: palette.moss,
  });
  const rock = rockPbr({
    stoneDeep: palette.stoneDeep,
    stone: palette.stone,
    mineral: palette.mineral,
  });
  const stone = stonePbr({ stone: palette.stone, stoneDeep: palette.stoneDeep });
  const bark = barkPbr({ bark: palette.bark, barkDeep: palette.barkDeep });

  const grassCards = [0, 1, 2, 3].map((index) =>
    grassCard(5000 + index * 131, {
      base: palette.grassBase,
      mid: palette.grassMid,
      tip: palette.grassTip,
    }),
  );
  const leafCards = [0, 1, 2].map((index) =>
    leafCard(6000 + index * 197, {
      light: palette.leafLight,
      mid: palette.leafMid,
      dark: palette.leafDark,
    }),
  );

  const all = [
    ground.map,
    ground.normalMap,
    ground.roughnessMap,
    rock.map,
    rock.normalMap,
    rock.roughnessMap,
    stone.map,
    stone.normalMap,
    stone.roughnessMap,
    bark.map,
    bark.normalMap,
    bark.roughnessMap,
    ...grassCards,
    ...leafCards,
  ];

  return {
    ground,
    rock,
    stone,
    bark,
    grassCards,
    leafCards,
    dispose(): void {
      for (const texture of all) texture.dispose();
    },
  };
}
