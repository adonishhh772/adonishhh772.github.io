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
import { radialFalloffTexture, skyEnvironmentTexture } from './parts';

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
  private readonly hazeTexture: THREE.Texture;
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
    this.sunDiscMaterial = new THREE.MeshBasicMaterial({
      color: theme.key,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      fog: false,
      blending: THREE.AdditiveBlending,
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
    this.sunDisc = new THREE.Mesh(new THREE.CircleGeometry(7, 24), this.sunDiscMaterial);
    this.sunHalo = new THREE.Mesh(new THREE.PlaneGeometry(70, 70), this.sunHaloMaterial);
    this.sunGroup = new THREE.Group();
    this.sunGroup.name = 'sun';
    this.sunGroup.add(this.sunHalo, this.sunDisc);
    this.sunGroup.position.copy(SKY_LIGHT_DIRECTION).multiplyScalar(SKY_RADIUS * 0.86);
    this.sunGroup.lookAt(0, 0, 0);
    this.sunGroup.renderOrder = -9;
    this.group.add(this.sunGroup);

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

    this.sunDiscMaterial.color.setHex(theme.key);
    this.sunHaloMaterial.color.setHex(theme.key);
    this.sunDiscMaterial.opacity = 0.42 + day * 0.28;
    this.sunHaloMaterial.opacity = 0.24 + day * 0.16;
    this.sunDisc.scale.setScalar(0.72 + day * 0.28);
    this.sunHalo.scale.setScalar(1 + day * 0.5);

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

  /** Keep the sky centred on the camera so the horizon never clips. */
  follow(camera: THREE.Camera): void {
    this.skyMesh.position.copy(camera.position);
    this.sunGroup.position.copy(SKY_LIGHT_DIRECTION).multiplyScalar(SKY_RADIUS * 0.86).add(camera.position);
  }

  dispose(): void {
    this.skyMesh.geometry.dispose();
    this.skyTexture.dispose();
    this.skyMaterial.dispose();
    this.sunDisc.geometry.dispose();
    this.sunHalo.geometry.dispose();
    this.sunDiscMaterial.dispose();
    this.sunHaloMaterial.dispose();
    this.hazeTexture.dispose();
    this.pmrem.dispose();
    this.environment?.dispose();
    this.group.clear();
    void this.quality;
  }
}
