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

/** How far away the sky bodies hang. Distance only sets their scale. */
const CELESTIAL_DISTANCE = 220;
/** A body's size, as a fraction of the frame's half-height. */
const CELESTIAL_ANGULAR_SIZE = 0.1;
/** Where a body sits at the top of its arc, in half-heights above centre. */
const CELESTIAL_HIGH = 0.47;
/** Where it has gone by the time it is the other one's turn. */
const CELESTIAL_SET = 0.04;
/** The dayness range over which a body fades in or out at the arc's foot. */
const CELESTIAL_FADE = 0.24;

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
 * A celestial body's face, painted once.
 *
 * The sun is a bright core inside a soft corona with tapered rays; the moon is
 * a pale disc with a shaded limb and craters. Both are drawn on transparent
 * canvases so the sprite's own shape is the body, not a square.
 */
function celestialTexture(kind: 'sun' | 'moon'): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const centre = size / 2;
  if (ctx) {
    ctx.clearRect(0, 0, size, size);
    if (kind === 'sun') {
      /* Corona. */
      const corona = ctx.createRadialGradient(centre, centre, size * 0.16, centre, centre, size * 0.5);
      corona.addColorStop(0, 'rgba(255,224,140,0.9)');
      corona.addColorStop(0.35, 'rgba(249,178,72,0.42)');
      corona.addColorStop(1, 'rgba(244,150,40,0)');
      ctx.fillStyle = corona;
      ctx.fillRect(0, 0, size, size);

      /* Rays, tapered and uneven so it reads as a drawn sun. */
      ctx.save();
      ctx.translate(centre, centre);
      ctx.fillStyle = 'rgba(245,158,11,0.92)';
      const rays = 16;
      for (let i = 0; i < rays; i++) {
        const length = i % 2 === 0 ? size * 0.46 : size * 0.34;
        const half = size * 0.028;
        ctx.save();
        ctx.rotate((i / rays) * Math.PI * 2);
        ctx.beginPath();
        ctx.moveTo(size * 0.2, -half);
        ctx.lineTo(length, 0);
        ctx.lineTo(size * 0.2, half);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
      ctx.restore();

      /*
       * The disc. Deliberately saturated: by day the sky is nearly white, so a
       * pale sun is invisible against it. Saturated amber reads on both skies.
       */
      const disc = ctx.createRadialGradient(
        centre - size * 0.05,
        centre - size * 0.05,
        size * 0.02,
        centre,
        centre,
        size * 0.2,
      );
      disc.addColorStop(0, 'rgba(255,249,224,1)');
      disc.addColorStop(0.5, 'rgba(253,205,92,1)');
      disc.addColorStop(1, 'rgba(234,138,16,1)');
      ctx.fillStyle = disc;
      ctx.beginPath();
      ctx.arc(centre, centre, size * 0.2, 0, Math.PI * 2);
      ctx.fill();
      /* A defined edge, so the body has a silhouette rather than a smudge. */
      ctx.strokeStyle = 'rgba(214,116,10,0.75)';
      ctx.lineWidth = size * 0.012;
      ctx.beginPath();
      ctx.arc(centre, centre, size * 0.2, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      /* A soft nimbus, so the moon is not a hard pasted circle. */
      const nimbus = ctx.createRadialGradient(centre, centre, size * 0.18, centre, centre, size * 0.44);
      nimbus.addColorStop(0, 'rgba(214,226,248,0.34)');
      nimbus.addColorStop(1, 'rgba(196,210,244,0)');
      ctx.fillStyle = nimbus;
      ctx.fillRect(0, 0, size, size);

      /* Body, shaded toward the lower right as if lit from the upper left. */
      const body = ctx.createRadialGradient(
        centre - size * 0.075,
        centre - size * 0.075,
        size * 0.02,
        centre,
        centre,
        size * 0.2,
      );
      body.addColorStop(0, 'rgba(246,249,255,1)');
      body.addColorStop(0.6, 'rgba(206,217,238,1)');
      body.addColorStop(1, 'rgba(148,163,192,1)');
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.arc(centre, centre, size * 0.2, 0, Math.PI * 2);
      ctx.fill();
      /* A defined limb, so the moon reads as a sphere rather than a glow. */
      ctx.strokeStyle = 'rgba(126,142,172,0.6)';
      ctx.lineWidth = size * 0.012;
      ctx.beginPath();
      ctx.arc(centre, centre, size * 0.2, 0, Math.PI * 2);
      ctx.stroke();

      /* Maria and craters. */
      ctx.fillStyle = 'rgba(140,157,190,0.55)';
      const maria: [number, number, number][] = [
        [-0.06, -0.07, 0.062],
        [0.05, 0.04, 0.045],
        [-0.02, 0.09, 0.03],
      ];
      for (const [mx, my, mr] of maria) {
        ctx.beginPath();
        ctx.arc(centre + mx * size, centre + my * size, mr * size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      const craters: [number, number, number][] = [
        [-0.1, 0.045, 0.016],
        [0.07, -0.1, 0.013],
        [0.1, 0.06, 0.01],
      ];
      for (const [cx, cy, cr] of craters) {
        ctx.beginPath();
        ctx.arc(centre + cx * size, centre + cy * size, cr * size, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * One sky body: the drawn face plus a wider glow behind it, both sprites so
 * they always face the visitor.
 *
 * Depth testing is off on purpose. A sun that is drawn *behind* the island is
 * a sun nobody can find or press: the overview camera looks down at the
 * campus, so the geometric horizon sits above the top of the frame and a
 * physically placed sky body would be buried inside the island. The bodies
 * are therefore a sky layer that is always in front of the scene, and the arc
 * plus the fade is what makes them set and rise.
 */
function celestialBody(
  face: THREE.Texture,
  glowOpacity: number,
  glowTexture: THREE.Texture,
): { group: THREE.Group; disc: THREE.SpriteMaterial; glow: THREE.SpriteMaterial } {
  const group = new THREE.Group();
  group.renderOrder = 12;

  const glowMaterial = new THREE.SpriteMaterial({
    map: glowTexture,
    color: 0xffffff,
    transparent: true,
    opacity: glowOpacity,
    depthWrite: false,
    depthTest: false,
    fog: false,
    blending: THREE.AdditiveBlending,
  });
  const glow = new THREE.Sprite(glowMaterial);
  glow.name = 'glow';
  glow.scale.setScalar(3.2);
  glow.renderOrder = 12;
  group.add(glow);

  const faceMaterial = new THREE.SpriteMaterial({
    map: face,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  const disc = new THREE.Sprite(faceMaterial);
  disc.name = 'disc';
  disc.scale.setScalar(1.9);
  disc.renderOrder = 13;
  group.add(disc);

  return { group, disc: faceMaterial, glow: glowMaterial };
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
  /** The two sky bodies, on one arc: as the sun sets the moon rises. */
  private readonly sunBody: THREE.Group;
  private readonly moonBody: THREE.Group;
  private readonly sunMaterials: { disc: THREE.SpriteMaterial; glow: THREE.SpriteMaterial };
  private readonly moonMaterials: { disc: THREE.SpriteMaterial; glow: THREE.SpriteMaterial };
  private readonly sunTexture: THREE.CanvasTexture;
  private readonly moonTexture: THREE.CanvasTexture;
  private readonly stars: THREE.Points;
  private readonly hazeTexture: THREE.Texture;
  /** 0 at night, 1 in daylight — what positions the bodies. */
  private dayness = 1;
  /** Whether the sky bodies belong to where the visitor is standing. */
  private celestialEnabled = true;
  /** How visible they are right now, so a faded body is not a tap target. */
  private celestialOpacity = 1;
  private starOpacity = 0;
  private readonly scratchForward = new THREE.Vector3();
  private readonly scratchUp = new THREE.Vector3();
  private readonly captionOffset = new THREE.Vector3();
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

    /*
     * The sun and the moon.
     *
     * Two real bodies in the sky rather than a trinket on a plinth: a warm
     * rayed sun and a pale cratered moon, each on its own sprite so it always
     * faces the visitor. They share one arc — as the sun goes down the moon
     * comes up — and both are drawn behind the island, so a body that has set
     * genuinely disappears below the horizon instead of fading out.
     */
    this.hazeTexture = radialFalloffTexture(96);
    this.sunTexture = celestialTexture('sun');
    this.moonTexture = celestialTexture('moon');
    const sun = celestialBody(this.sunTexture, 0.34, this.hazeTexture);
    const moon = celestialBody(this.moonTexture, 0.1, this.hazeTexture);
    this.sunBody = sun.group;
    this.moonBody = moon.group;
    this.sunMaterials = { disc: sun.disc, glow: sun.glow };
    this.moonMaterials = { disc: moon.disc, glow: moon.glow };
    this.sunBody.name = 'sun';
    this.moonBody.name = 'moon';
    this.group.add(this.sunBody, this.moonBody);

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
    this.dayness = day;
    paintSky(this.skyCanvas, theme);
    this.skyTexture.needsUpdate = true;

    /* The bodies are placed and faded every frame in `follow`; the theme only
       decides their colour. */
    const sunGlow = this.sunMaterials.glow;
    const moonGlow = this.moonMaterials.glow;
    sunGlow.color.setHex(theme.practical);
    moonGlow.color.setHex(theme.skyHorizon);

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
    /* The sun's corona is a detail: gone on the lowest tier. */
    const sunGlow = this.sunBody.getObjectByName('glow');
    if (sunGlow) sunGlow.visible = quality.detail;
  }

  /**
   * Keep the sky, the sky bodies and the stars centred on the camera, and run
   * the sun and moon along their shared arc.
   *
   * Each body is positioned in the camera's own frame — a fraction of the
   * frame's half-height above centre — so "top centre" means exactly that,
   * whatever the visitor has done to the camera. `dayness` moves the sun from
   * high in the frame down toward the horizon while the moon comes up from it,
   * and each fades at the foot of its arc, so the change reads as one setting
   * while the other rises.
   */
  follow(camera: THREE.Camera, focus?: THREE.Vector3): void {
    this.skyMesh.position.copy(camera.position);
    this.stars.position.copy(camera.position);

    const perspective = camera as THREE.PerspectiveCamera;
    const halfHeight = Math.tan(THREE.MathUtils.degToRad(perspective.fov ?? 40) / 2);
    const forward = camera.getWorldDirection(this.scratchForward);
    const up = this.scratchUp.set(0, 1, 0).applyQuaternion(camera.quaternion).normalize();
    const distance = CELESTIAL_DISTANCE;
    const scale = Math.max(0.05, CELESTIAL_ANGULAR_SIZE * distance * halfHeight);

    const place = (body: THREE.Group, fraction: number) => {
      body.position
        .copy(camera.position)
        .addScaledVector(forward, distance)
        .addScaledVector(up, fraction * halfHeight * distance);
      body.scale.setScalar(scale);
    };

    const day = this.dayness;
    place(this.sunBody, THREE.MathUtils.lerp(CELESTIAL_SET, CELESTIAL_HIGH, day));
    place(this.moonBody, THREE.MathUtils.lerp(CELESTIAL_HIGH, CELESTIAL_SET, day));

    /* Remembered so the caption can hang below the body rather than across its
       face, which is what a pill centred on the sun would do. */
    this.captionOffset.copy(up).multiplyScalar(-0.17 * halfHeight * distance);

    /*
     * Fade with the camera's distance from what it is looking at, and again
     * when it looks steeply down.
     *
     * The bodies are a sky layer, so they draw over the island — right from the
     * wide shot, wrong when the visitor has zoomed in and the sun lands on the
     * dome, and wrongest when the camera is directly overhead and the sun
     * appears to be inside the building. They belong to a wide, level view.
     */
    const pitchDown = -forward.y;
    let range =
      focus === undefined
        ? 1
        : THREE.MathUtils.clamp((camera.position.distanceTo(focus) - 6.6) / 2.8, 0, 1);
    range *= THREE.MathUtils.clamp((0.8 - pitchDown) / 0.24, 0, 1);

    /* Fade at the foot of the arc, so nothing is left sliding across the
       island when it has effectively set. */
    const sunFade = THREE.MathUtils.clamp((day - 0.08) / CELESTIAL_FADE, 0, 1) * range;
    const moonFade = THREE.MathUtils.clamp((0.92 - day) / CELESTIAL_FADE, 0, 1) * range;
    this.celestialOpacity = Math.max(sunFade, moonFade);
    this.sunMaterials.disc.opacity = sunFade;
    this.sunMaterials.glow.opacity = 0.34 * sunFade * day;
    this.moonMaterials.disc.opacity = moonFade;
    this.moonMaterials.glow.opacity = 0.24 * moonFade * (1 - day);
    this.sunBody.visible = this.celestialEnabled && sunFade > 0.01;
    this.moonBody.visible = this.celestialEnabled && moonFade > 0.01;

    if (this.starOpacity > 0.01 && this.quality.ambient) {
      const twinkle = 0.9 + Math.sin(performance.now() * 0.0011) * 0.1;
      (this.stars.material as THREE.PointsMaterial).opacity = this.starOpacity * twinkle;
    }
  }

  /**
   * Show or hide the sky bodies.
   *
   * They belong to the campus: at a destination the frame is filled with the
   * building and its objects, and a sun hanging over the roof is decoration
   * where there should be none.
   */
  setCelestialEnabled(enabled: boolean): void {
    this.celestialEnabled = enabled;
  }

  /**
   * Where the body that is currently up can be tapped, in world space. Used
   * for the direct tap on it. A body that has faded out is not a target.
   */
  activeCelestialPosition(): THREE.Vector3 | null {
    if (!this.celestialEnabled || this.celestialOpacity < 0.35) return null;
    const body = this.dayness >= 0.5 ? this.sunBody : this.moonBody;
    if (!body.visible) return null;
    return body.position.clone();
  }

  /** Where the caption for the body that is up should hang. */
  activeCelestialCaptionPosition(): THREE.Vector3 | null {
    const body = this.activeCelestialPosition();
    return body ? body.add(this.captionOffset) : null;
  }

  /** The on-screen half-size of the active body, for a forgiving tap target. */
  activeCelestialRadius(camera: THREE.Camera): number {    const body = this.dayness >= 0.5 ? this.sunBody : this.moonBody;
    const perspective = camera as THREE.PerspectiveCamera;
    const distance = Math.max(camera.position.distanceTo(body.position), 1);
    /* The disc sprite is 1.9 units wide before the body's own scale. */
    const worldRadius = 0.95 * body.scale.x;
    const halfHeight = Math.tan(THREE.MathUtils.degToRad(perspective.fov ?? 40) / 2) * distance;
    return worldRadius / Math.max(halfHeight, 0.001) * 0.5;
  }

  dispose(): void {
    this.skyMesh.geometry.dispose();
    this.skyTexture.dispose();
    this.skyMaterial.dispose();
    this.sunTexture.dispose();
    this.moonTexture.dispose();
    for (const body of [this.sunBody, this.moonBody]) {
      body.traverse((child) => {
        const sprite = child as THREE.Sprite;
        if (sprite.isSprite) sprite.material.dispose();
      });
    }
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
