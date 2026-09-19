/**
 * Lighting and atmosphere.
 *
 * A gradient sky dome, a key light that casts a single low-cost shadow, a
 * soft fill, three practical in-world lamps and an image-based environment
 * generated from a canvas gradient. No post-processing is required for the
 * scene to read well.
 */

import * as THREE from 'three';
import type { QualitySettings } from './quality';
import type { WorldTheme } from './theme';
import { mulberry32, radialFalloffTexture, skyEnvironmentTexture } from './parts';

/**
 * Direction the key light travels from. Deliberately on the camera's side of
 * the island (the default camera sits at roughly +X +Z), offset about 35°:
 * the surfaces a visitor actually sees stay lit, and the far side falls into
 * shadow so the architecture keeps its form.
 */
export const KEY_DIRECTION = new THREE.Vector3(0.54, 0.64, 0.55).normalize();

/**
 * Where the sun / moon disc hangs in the sky — behind and to the left of the
 * island, so it reads as a light source in the frame and rims the silhouette
 * without lighting the scene from behind.
 */
export const SKY_LIGHT_DIRECTION = new THREE.Vector3(-0.46, 0.34, -0.82).normalize();

const SKY_RADIUS = 420;

/**
 * The sky is one canvas, repainted in place. Rebuilding a texture per frame
 * would make a 700ms day/night blend allocate and upload dozens of textures;
 * repainting keeps the transition cheap enough to run continuously.
 */
function paintSky(canvas: HTMLCanvasElement, theme: WorldTheme): void {
  const height = canvas.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const hex = (value: number) => `#${value.toString(16).padStart(6, '0')}`;
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  /* Stops are tuned to the default camera: it looks slightly downward, so
     the horizon glow belongs just past the mid-point to appear behind the
     island's silhouette rather than above the frame. */
  gradient.addColorStop(0, hex(theme.skyTop));
  gradient.addColorStop(0.3, hex(theme.skyTop));
  gradient.addColorStop(0.48, hex(theme.skyHorizon));
  gradient.addColorStop(0.62, hex(theme.fog));
  gradient.addColorStop(1, hex(theme.fog));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, height);
}

/**
 * The sky body.
 *
 * One canvas carries both faces of the same object: at one end a warm disc
 * with rays, at the other a pale cratered moon. Blending between them by
 * `dayness` means the change happens on the sun itself as the light turns,
 * rather than a sprite vanishing and a different one appearing.
 */
function paintCelestial(canvas: HTMLCanvasElement, dayness: number): void {
  const size = canvas.width;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const centre = size / 2;
  const sun = Math.max(0, Math.min(1, dayness));
  const moon = 1 - sun;
  const disc = size * 0.3;

  ctx.clearRect(0, 0, size, size);

  if (moon > 0.01) {
    ctx.globalAlpha = moon;
    const body = ctx.createRadialGradient(
      centre - disc * 0.35,
      centre - disc * 0.35,
      disc * 0.1,
      centre,
      centre,
      disc,
    );
    body.addColorStop(0, 'rgba(246,248,255,1)');
    body.addColorStop(0.72, 'rgba(214,222,240,1)');
    body.addColorStop(1, 'rgba(176,190,214,1)');
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(centre, centre, disc, 0, Math.PI * 2);
    ctx.fill();

    /* Craters, fixed positions: the moon is the same moon every night. */
    const craters: [number, number, number][] = [
      [-0.32, -0.22, 0.16],
      [0.18, -0.36, 0.1],
      [0.34, 0.1, 0.14],
      [-0.12, 0.3, 0.12],
      [-0.44, 0.16, 0.07],
    ];
    ctx.globalAlpha = moon * 0.34;
    ctx.fillStyle = 'rgb(122,138,168)';
    for (const [cx, cy, r] of craters) {
      ctx.beginPath();
      ctx.arc(centre + cx * disc, centre + cy * disc, r * disc, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  if (sun > 0.01) {
    ctx.globalAlpha = sun;
    /* Rays first, so the disc sits on top of them. */
    ctx.save();
    ctx.translate(centre, centre);
    ctx.rotate(0.2);
    ctx.fillStyle = 'rgba(255,214,140,0.85)';
    for (let i = 0; i < 12; i++) {
      ctx.rotate((Math.PI * 2) / 12);
      const length = i % 2 === 0 ? disc * 0.62 : disc * 0.36;
      ctx.beginPath();
      ctx.moveTo(disc * 0.92, -disc * 0.075);
      ctx.lineTo(disc * 0.92 + length, 0);
      ctx.lineTo(disc * 0.92, disc * 0.075);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    const glow = ctx.createRadialGradient(centre, centre, 0, centre, centre, disc);
    glow.addColorStop(0, 'rgba(255,255,246,1)');
    glow.addColorStop(0.55, 'rgba(255,224,158,1)');
    glow.addColorStop(1, 'rgba(255,183,86,0.92)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(centre, centre, disc, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.globalAlpha = 1;
}

/**
 * A starfield. Points rather than geometry: one draw call, no shadows, and
 * `sizeAttenuation` off so a star stays the same speck however far the sky is.
 */
function starField(radius: number, count: number): THREE.Points {
  const positions = new Float32Array(count * 3);
  const random = mulberry32(913);
  for (let i = 0; i < count; i++) {
    /* Upper hemisphere, thinning toward the horizon where the haze sits. */
    const phi = Math.acos(Math.pow(random(), 0.62));
    const theta = random() * Math.PI * 2;
    const sinPhi = Math.sin(phi);
    positions[i * 3] = radius * sinPhi * Math.cos(theta);
    positions[i * 3 + 1] = radius * Math.cos(phi) + 40;
    positions[i * 3 + 2] = radius * sinPhi * Math.sin(theta);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 32;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const dot = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    dot.addColorStop(0, 'rgba(255,255,255,1)');
    dot.addColorStop(0.4, 'rgba(255,255,255,0.55)');
    dot.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = dot;
    ctx.fillRect(0, 0, 32, 32);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;

  const material = new THREE.PointsMaterial({
    size: 5,
    sizeAttenuation: false,
    map: texture,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  const points = new THREE.Points(geometry, material);
  points.name = 'stars';
  points.frustumCulled = false;
  points.renderOrder = -8;
  return points;
}

export class Atmosphere {
  readonly group = new THREE.Group();
  readonly hemi: THREE.HemisphereLight;
  readonly key: THREE.DirectionalLight;
  readonly fill: THREE.DirectionalLight;
  readonly practicals: THREE.PointLight[] = [];
  readonly fog: THREE.FogExp2;

  private readonly skyMesh: THREE.Mesh;
  private readonly skyMaterial: THREE.MeshBasicMaterial;
  private readonly skyCanvas: HTMLCanvasElement;
  private readonly skyTexture: THREE.CanvasTexture;
  private readonly sunGroup: THREE.Group;
  private readonly sunDisc: THREE.Mesh;
  private readonly sunHalo: THREE.Mesh;
  private readonly sunDiscMaterial: THREE.MeshBasicMaterial;
  private readonly sunHaloMaterial: THREE.MeshBasicMaterial;
  private readonly celestialCanvas: HTMLCanvasElement;
  private readonly celestialTexture: THREE.CanvasTexture;
  private readonly stars: THREE.Points;
  private readonly hazeTexture: THREE.Texture;
  /** Last dayness the celestial canvas was painted for. */
  private paintedDayness = -1;
  private starOpacity = 0;
  private quality: QualitySettings;

  constructor(
    theme: WorldTheme,
    quality: QualitySettings,
    private readonly renderer: THREE.WebGLRenderer,
  ) {
    this.quality = quality;
    this.group.name = 'atmosphere';

    /* Sky dome ------------------------------------------------------- */
    this.skyCanvas = document.createElement('canvas');
    this.skyCanvas.width = 8;
    this.skyCanvas.height = 256;
    paintSky(this.skyCanvas, theme);
    this.skyTexture = new THREE.CanvasTexture(this.skyCanvas);
    this.skyTexture.colorSpace = THREE.SRGBColorSpace;
    this.skyMaterial = new THREE.MeshBasicMaterial({
      map: this.skyTexture,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      toneMapped: true,
    });
    this.skyMesh = new THREE.Mesh(
      new THREE.SphereGeometry(SKY_RADIUS, 24, 16),
      this.skyMaterial,
    );
    this.skyMesh.name = 'sky';
    this.skyMesh.frustumCulled = false;
    this.skyMesh.renderOrder = -10;
    this.group.add(this.skyMesh);

    /* Sun / moon disc + halo ----------------------------------------- */
    this.hazeTexture = radialFalloffTexture(96);
    this.celestialCanvas = document.createElement('canvas');
    this.celestialCanvas.width = this.celestialCanvas.height = 128;
    paintCelestial(this.celestialCanvas, theme.dayness);
    this.paintedDayness = theme.dayness;
    this.celestialTexture = new THREE.CanvasTexture(this.celestialCanvas);
    this.celestialTexture.colorSpace = THREE.SRGBColorSpace;
    this.sunDiscMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      map: this.celestialTexture,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      fog: false,
    });
    this.sunHaloMaterial = new THREE.MeshBasicMaterial({
      color: theme.key,
      map: this.hazeTexture,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
      fog: false,
      blending: THREE.AdditiveBlending,
    });
    this.sunDisc = new THREE.Mesh(new THREE.CircleGeometry(9, 36), this.sunDiscMaterial);
    this.sunHalo = new THREE.Mesh(new THREE.PlaneGeometry(70, 70), this.sunHaloMaterial);
    this.sunGroup = new THREE.Group();
    this.sunGroup.name = 'sun';
    this.sunGroup.add(this.sunHalo, this.sunDisc);
    this.sunGroup.position.copy(SKY_LIGHT_DIRECTION).multiplyScalar(SKY_RADIUS * 0.86);
    this.sunGroup.lookAt(0, 0, 0);
    this.sunGroup.renderOrder = -9;
    this.group.add(this.sunGroup);

    /* Stars, dark until the sun goes down. */
    this.stars = starField(SKY_RADIUS * 0.94, 560);
    this.group.add(this.stars);

    /* Lights --------------------------------------------------------- */
    this.hemi = new THREE.HemisphereLight(theme.skyHorizon, theme.stoneDeep, theme.hemi);
    this.hemi.name = 'hemi';
    this.group.add(this.hemi);

    this.key = new THREE.DirectionalLight(theme.key, theme.keyIntensity);
    this.key.name = 'key';
    this.key.position.copy(KEY_DIRECTION).multiplyScalar(26);
    this.key.target.position.set(0, 1, 0);
    this.group.add(this.key, this.key.target);

    this.fill = new THREE.DirectionalLight(theme.skyTop, 0.4);
    this.fill.name = 'fill';
    this.fill.position.set(14, 9, -16);
    this.group.add(this.fill);

    for (const name of ['studio', 'tower', 'beacon', 'drone']) {
      const light = new THREE.PointLight(theme.practical, 0, 9, 2);
      light.name = `practical-${name}`;
      this.practicals.push(light);
      this.group.add(light);
    }

    /* Fog ------------------------------------------------------------ */
    this.fog = new THREE.FogExp2(theme.fog, theme.fogDensity);

    /* Environment ---------------------------------------------------- */
    this.environment = null;
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileEquirectangularShader();

    this.setTheme(theme);
    this.setQuality(quality);
  }

  private pmrem: THREE.PMREMGenerator;
  environment: THREE.Texture | null;

  /** Where the practical lights sit; set by the world once it is built. */
  setPractical(index: number, position: THREE.Vector3, intensity: number, color: number): void {
    const light = this.practicals[index];
    if (!light) return;
    light.position.copy(position);
    light.color.setHex(color);
    light.userData.baseIntensity = intensity;
  }

  /**
   * Recolour the atmosphere for a theme.
   *
   * `environment` regenerates the image-based probe. A day/night blend calls
   * this every frame and passes `environment: false` for most of them, so the
   * probe is refreshed a handful of times rather than sixty.
   */
  setTheme(theme: WorldTheme, options: { environment?: boolean } = {}): void {
    const day = THREE.MathUtils.clamp(theme.dayness, 0, 1);
    paintSky(this.skyCanvas, theme);
    this.skyTexture.needsUpdate = true;

    this.sunDiscMaterial.color.setHex(0xffffff);
    this.sunHaloMaterial.color.setHex(theme.key);
    /* The body itself is drawn by the canvas, so the blend of sun and moon is
       a repaint rather than a cross-fade between two objects. */
    if (Math.abs(theme.dayness - this.paintedDayness) > 0.02) {
      paintCelestial(this.celestialCanvas, theme.dayness);
      this.celestialTexture.needsUpdate = true;
      this.paintedDayness = theme.dayness;
    }
    this.sunDiscMaterial.opacity = 0.7 + day * 0.25;
    this.sunHaloMaterial.opacity = 0.2 + day * 0.22;
    this.sunDisc.scale.setScalar(1 - day * 0.22);
    this.sunHalo.scale.setScalar(1 + day * 0.5);

    /* Stars: on at night, gone by day. */
    this.starOpacity = (1 - day) * (this.quality.detail ? 1 : 0.78);
    const starMaterial = this.stars.material as THREE.PointsMaterial;
    starMaterial.opacity = this.starOpacity;
    this.stars.visible = this.starOpacity > 0.01;

    this.hemi.color.setHex(theme.skyHorizon);
    this.hemi.groundColor.setHex(theme.stoneDeep);
    this.hemi.intensity = theme.hemi;

    this.key.color.setHex(theme.key);
    this.key.intensity = theme.keyIntensity;
    this.fill.color.setHex(theme.skyTop);
    this.fill.intensity = 0.3 + day * 0.25;

    /* Artificial light: on at night, subdued by day. */
    for (const light of this.practicals) {
      const base = (light.userData.baseIntensity as number | undefined) ?? 0;
      light.intensity = base * theme.practicalIntensity;
      if (light.name === 'practical-tower') light.color.setHex(theme.signal);
    }

    this.fog.color.setHex(theme.fog);
    this.fog.density = theme.fogDensity;

    this.renderer.toneMappingExposure = theme.exposure;

    if (options.environment !== false) {
      /* Rebuild the environment probe for the new sky. */
      const source = skyEnvironmentTexture(theme);
      const generated = this.pmrem.fromEquirectangular(source);
      source.dispose();
      this.environment?.dispose();
      this.environment = generated.texture;
    }
  }

  setQuality(quality: QualitySettings): void {
    this.quality = quality;
    this.key.castShadow = quality.shadows;
    if (quality.shadows) {
      const size = quality.shadowMapSize;
      this.key.shadow.mapSize.set(size, size);
      const camera = this.key.shadow.camera;
      camera.left = -17;
      camera.right = 17;
      camera.top = 17;
      camera.bottom = -17;
      camera.near = 2;
      camera.far = 62;
      camera.updateProjectionMatrix();
      this.key.shadow.bias = -0.0006;
      this.key.shadow.normalBias = 0.022;
      this.key.shadow.radius = quality.tier === 'high' ? 2.5 : 1.5;
    } else if (this.key.shadow.map) {
      this.key.shadow.map.dispose();
      this.key.shadow.map = null;
    }
    this.sunHalo.visible = quality.detail;
  }

  /**
   * Keep the sky, the sky body and the stars centred on the camera so the
   * horizon never clips. The stars are given a slow, shallow twinkle — but
   * only while ambient motion is allowed, so the night sky holds still while
   * somebody is reading.
   */
  follow(camera: THREE.Camera): void {
    this.skyMesh.position.copy(camera.position);
    this.sunGroup.position.copy(SKY_LIGHT_DIRECTION).multiplyScalar(SKY_RADIUS * 0.86).add(camera.position);
    this.stars.position.copy(camera.position);
    if (this.starOpacity > 0.01 && this.quality.ambient) {
      const twinkle = 0.9 + Math.sin(performance.now() * 0.0011) * 0.1;
      (this.stars.material as THREE.PointsMaterial).opacity = this.starOpacity * twinkle;
    }
  }

  dispose(): void {
    this.skyMesh.geometry.dispose();
    this.skyTexture.dispose();
    this.skyMaterial.dispose();
    this.sunDisc.geometry.dispose();
    this.sunHalo.geometry.dispose();
    this.sunDiscMaterial.dispose();
    this.sunHaloMaterial.dispose();
    this.celestialTexture.dispose();
    this.stars.geometry.dispose();
    (this.stars.material as THREE.PointsMaterial).map?.dispose();
    (this.stars.material as THREE.PointsMaterial).dispose();
    this.hazeTexture.dispose();
    this.pmrem.dispose();
    this.environment?.dispose();
    this.group.clear();
    void this.quality;
  }
}
