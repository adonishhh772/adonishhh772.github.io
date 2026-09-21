/**
 * Lighting, sky and atmosphere.
 *
 * The scene's light is not authored — it is *derived*. The sun's and the moon's
 * real positions arrive on the theme, and everything here is a consequence of
 * them: which of the two casts the key light, what colour it is, how much
 * ambient there is, how bright the sky dome is drawn, whether the stars are out,
 * and how far the fog reaches.
 *
 * That direction of causality is the point. An art-directed night is a night
 * that looks the same in June and December; a derived one is dark in the morning
 * and light in the evening, has long shadows in winter and short ones in summer,
 * and has no key light at all for the twenty minutes around sunset when the sun
 * is below the horizon and the moon has not risen. The scene has to survive all
 * of that, which is why the night rig leans on ambient and on a moonlit rim
 * rather than on the key.
 *
 * The sky is a shader on a dome rather than a painted gradient, because the
 * brightest part of a sky has to be where the sun is. See `sky-textures.ts`.
 */

import * as THREE from 'three';
import type { QualitySettings } from './quality';
import type { WorldTheme } from './theme';
import { radialFalloffTexture } from './parts';
import {
  directionFrom,
  moonTexture,
  skyMaterial,
  starGeometry,
  starMaterial,
  STAR_POLE_AXIS,
  sunTexture,
  type SkyUniforms,
  type StarUniforms,
} from './sky-textures';

const SKY_RADIUS = 420;

/**
 * How far below the horizon the key light's *direction* is allowed to sink.
 *
 * The key light is a directional light with a shadow camera, and a light at two
 * degrees below the horizon throws a shadow the length of the island; a light
 * at forty degrees below throws it to infinity, which fills the frame with
 * shadow and reads as a bug. The direction is clamped to the horizon while the
 * *intensity* continues to fall away with the real altitude, so twilight darkens
 * the world without the shadows going mad.
 */
const KEY_MIN_ELEVATION = 11;

export class Atmosphere {
  readonly group = new THREE.Group();
  readonly hemi: THREE.HemisphereLight;
  readonly key: THREE.DirectionalLight;
  readonly fill: THREE.DirectionalLight;
  readonly practicals: THREE.PointLight[] = [];
  readonly fog: THREE.FogExp2;

  private readonly skyMesh: THREE.Mesh;
  private readonly skyMaterial: THREE.ShaderMaterial;
  private readonly skyUniforms: SkyUniforms;
  private readonly hazeTexture: THREE.Texture;

  /** The two sky bodies, placed at their real compass positions. */
  private readonly sunBody: THREE.Group;
  private readonly moonBody: THREE.Group;
  private readonly sunMaterials: { disc: THREE.SpriteMaterial; glow: THREE.SpriteMaterial };
  private readonly moonMaterials: { disc: THREE.SpriteMaterial; glow: THREE.SpriteMaterial };
  private readonly sunFace: THREE.SpriteMaterial;
  private readonly sunTexture: THREE.Texture;
  private moonTexture: THREE.Texture;
  private moonPhaseKey = -1;

  /**
   * The stars.
   *
   * A field of points on the celestial sphere rather than a map on the dome:
   * each star keeps its own apparent size and colour, so the sky is a sky at any
   * zoom. `sky-textures.ts` builds the field; here it only has to be turned by
   * the sidereal angle and faded.
   */
  private readonly stars: THREE.Points;
  private readonly starUniforms: StarUniforms;

  private theme: WorldTheme;
  private quality: QualitySettings;

  /** Where the key light currently points, for the diagnostics. */
  private readonly keyDirection = new THREE.Vector3(0, 1, 0);
  /**
   * Where the *sun's own* direction points, before the key light's elevation
   * clamp. Reported separately because the two answer different questions: the
   * key light is clamped to keep its shadows sane, and the sun is not.
   */
  private readonly sunKeyDirection = new THREE.Vector3(0, 1, 0);
  private sunDirection = new THREE.Vector3(0, 1, 0);
  private moonDirection = new THREE.Vector3(0, -1, 0);

  private sunOpacity = 0;
  private moonOpacity = 0;
  private celestialOpacity = 0;
  private starOpacity = 0;
  private lastFocusDistance = 1;
  private celestialEnabled = true;

  private readonly scratchBody = new THREE.Vector3();
  private readonly scratchForward2 = new THREE.Vector3();
  private readonly scratchProject = new THREE.Vector3();
  private readonly captionOffset = new THREE.Vector3();
  private readonly scratchLightPosition = new THREE.Vector3();
  private readonly scratchViewDir = new THREE.Vector3();

  private pmrem: THREE.PMREMGenerator;
  environment: THREE.Texture | null = null;

  constructor(
    theme: WorldTheme,
    quality: QualitySettings,
    private readonly renderer: THREE.WebGLRenderer,
  ) {
    this.theme = theme;
    this.quality = quality;
    this.group.name = 'atmosphere';

    /* Sky dome ------------------------------------------------------- */
    this.skyMaterial = skyMaterial(
      {
        zenith: theme.skyTop,
        horizon: theme.skyHorizon,
        sunTint: theme.sunLow,
        ground: theme.fog,
        sun: theme.sunHigh,
      },
      theme.haze,
    );
    this.skyUniforms = this.skyMaterial.uniforms as unknown as SkyUniforms;

    this.skyMesh = new THREE.Mesh(
      new THREE.SphereGeometry(SKY_RADIUS, 32, 20),
      this.skyMaterial,
    );
    this.skyMesh.name = 'sky';
    this.skyMesh.frustumCulled = false;
    this.skyMesh.renderOrder = -20;
    this.group.add(this.skyMesh);

    /* Stars ---------------------------------------------------------- */
    this.stars = new THREE.Points(starGeometry(), starMaterial());
    this.starUniforms = (this.stars.material as THREE.ShaderMaterial)
      .uniforms as unknown as StarUniforms;
    this.starUniforms.pixelScale.value = renderer.getPixelRatio();
    this.stars.name = 'stars';
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -18;
    this.stars.visible = false;
    /*
     * The field sits on a unit sphere and is *scaled* to the dome's radius, so
     * the rotation that turns the sky is applied about the origin in the
     * object's own space rather than against a second, huge coordinate system.
     */
    this.stars.scale.setScalar(SKY_RADIUS * 0.99);
    this.group.add(this.stars);

    /* The sun and the moon ------------------------------------------- */
    this.hazeTexture = radialFalloffTexture(96);
    this.sunTexture = sunTexture();
    this.moonTexture = moonTexture(0);
    this.moonPhaseKey = 0;

    const sun = this.celestialBody(this.sunTexture, 0.22, 2.35);
    const moon = this.celestialBody(this.moonTexture, 0.12, 1.85);
    this.sunBody = sun.group;
    this.moonBody = moon.group;
    this.sunMaterials = { disc: sun.disc, glow: sun.glow };
    this.moonMaterials = { disc: moon.disc, glow: moon.glow };
    this.sunFace = sun.disc;
    this.sunBody.name = 'sun';
    this.moonBody.name = 'moon';
    this.group.add(this.sunBody, this.moonBody);

    /* Lights --------------------------------------------------------- */
    this.hemi = new THREE.HemisphereLight(theme.skyHorizon, theme.stoneDeep, theme.hemi);
    this.hemi.name = 'hemi';
    this.group.add(this.hemi);

    /*
     * The single shadow-casting light. It is the sun by day and the moon by
     * night — one light, re-aimed, rather than two with one switched off,
     * because two shadow-casting lights cost two shadow passes and the world
     * only ever has one body bright enough to cast a shadow.
     */
    this.key = new THREE.DirectionalLight(theme.key, theme.keyIntensity);
    this.key.name = 'key';
    this.key.position.copy(directionFrom(48, 140)).multiplyScalar(30);
    this.key.target.position.set(0, 1, 0);
    this.group.add(this.key, this.key.target);

    /* A weak, cool counter-light on the shadow side, so nothing is pure black. */
    this.fill = new THREE.DirectionalLight(theme.skyTop, 0.4);
    this.fill.name = 'fill';
    this.fill.position.set(-18, 12, -21);
    this.fill.target.position.set(0, 1, 0);
    this.group.add(this.fill, this.fill.target);

    /*
     * Four lights inside the buildings and four out on the campus lamps — the
     * posts are built by the world and have their positions handed back here.
     * The count is a budget rather than an accident: every one of these costs
     * a term in the fragment shader of every lit surface in the scene, and a
     * night campus is perfectly readable with one lamp in two actually lit.
     */
    for (const name of [
      'studio',
      'tower',
      'beacon',
      'drone',
      'lamp-0',
      'lamp-1',
      'lamp-2',
      'lamp-3',
    ]) {
      const light = new THREE.PointLight(theme.practical, 0, 11, 2);
      light.name = `practical-${name}`;
      this.practicals.push(light);
      this.group.add(light);
    }

    this.fog = new THREE.FogExp2(theme.fog, theme.fogDensity);

    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileEquirectangularShader();

    this.setTheme(theme, { environment: true });
    this.setQuality(quality);
  }

  /**
   * One sky body: the drawn face plus a wider glow behind it, both sprites so
   * they always face the visitor.
   *
   * Depth testing is off. A sprite at the sun's real position is 420 units away
   * and would be occluded by the island's own horizon from any camera looking
   * down at the campus — which is *correct* physically and useless practically,
   * since it makes the sun unpressable and, at a glance, absent. The body's
   * altitude already decides whether it is up: that is what the opacity is for,
   * and it is the honest version of the same behaviour.
   */
  private celestialBody(
    face: THREE.Texture,
    glowOpacity: number,
    discScale: number,
  ): { group: THREE.Group; disc: THREE.SpriteMaterial; glow: THREE.SpriteMaterial } {
    const group = new THREE.Group();
    group.renderOrder = 80;

    const glowMaterial = new THREE.SpriteMaterial({
      map: this.hazeTexture,
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
    glow.scale.setScalar(discScale * 4.4);
    glow.renderOrder = 80;
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
    disc.scale.setScalar(discScale);
    disc.renderOrder = 81;
    group.add(disc);

    return { group, disc: faceMaterial, glow: glowMaterial };
  }

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
   * `environment` regenerates the image-based probe. The probe is a render pass
   * and the frame loop asks for it a handful of times a minute rather than every
   * frame, so this is throttled by the caller rather than here.
   */
  setTheme(theme: WorldTheme, options: { environment?: boolean } = {}): void {
    this.theme = theme;
    const day = THREE.MathUtils.clamp(theme.dayness, 0, 1);

    /* The sky dome ---------------------------------------------------- */
    this.skyUniforms.zenith.value.setHex(theme.skyTop);
    this.skyUniforms.horizon.value.setHex(theme.skyHorizon);
    this.skyUniforms.sunTint.value.setHex(theme.sunLow);
    this.skyUniforms.ground.value.setHex(theme.fog);
    this.skyUniforms.sunColor.value.setHex(theme.sunHigh);
    this.skyUniforms.haze.value = theme.haze;
    this.skyUniforms.intensity.value = theme.skyIntensity;
    /*
     * The glow: tight and cool when the sun is high, broad and blazing when it
     * is near the horizon. That widening is most of what a sunset *is*.
     */
    this.skyUniforms.sunGlow.value = 0.18 + theme.golden * 0.5 + theme.twilight * 0.34;
    this.skyUniforms.sunStrength.value = 0.5 + day * 0.9 + theme.golden * 0.4;

    /* Stars ----------------------------------------------------------- */
    this.starOpacity = theme.starOpacity * (this.quality.detail ? 1 : 0.75);
    this.starUniforms.opacity.value = this.starOpacity;
    /* The stars are tinted by the sky they hang in, so they never read as a
       layer pasted over it. */
    this.starUniforms.tint.value.setHex(theme.snow).lerp(new THREE.Color(theme.skyTop), 0.35);
    this.stars.visible = this.starOpacity > 0.01;

    /* The bodies' colour: the sun's disc warms at the horizon, the moon is
       always the same pale body and only its glow takes the sky's colour. */
    this.sunFace.color.setHex(theme.sunHigh);
    this.sunMaterials.glow.color.setHex(theme.sunLow);
    this.moonMaterials.glow.color.setHex(theme.moonLight);

    /* Phase: redraw the moon's face only when the phase has actually moved. */
    this.updateMoonPhase(theme);

    /* Lights ---------------------------------------------------------- */
    this.hemi.color.setHex(theme.skyHorizon);
    this.hemi.groundColor.setHex(theme.stoneDeep);
    this.hemi.intensity = theme.hemi;

    this.aimKey(theme);
    this.key.color.setHex(this.keyColour(theme));
    this.key.intensity = theme.keyIntensity;

    this.fill.color.setHex(theme.skyTop);
    this.fill.intensity = 0.22 + day * 0.34;

    for (const light of this.practicals) {
      const base = (light.userData.baseIntensity as number | undefined) ?? 0;
      light.intensity = base * theme.practicalIntensity;
      if (light.name === 'practical-tower') light.color.setHex(theme.signal);
    }

    this.fog.color.setHex(theme.fog);
    this.fog.density = theme.fogDensity;

    this.renderer.toneMappingExposure = theme.exposure;

    if (options.environment) this.refreshEnvironment();
  }

  /**
   * Point the key light at whichever body is up.
   *
   * The choice is made on the sun's altitude rather than on `dayness`, so the
   * handover happens when the sun is genuinely gone rather than when the palette
   * has finished moving — and the moon takes over with its own direction, which
   * is what makes a moonlit night's shadows fall the way they should.
   */
  private aimKey(theme: WorldTheme): void {
    this.sunDirection.copy(directionFrom(theme.sunAltitude, theme.sunAzimuth));
    this.moonDirection.copy(directionFrom(theme.moonAltitude, theme.moonAzimuth));

    const sunUp = theme.sunAltitude > -0.5;
    const moonUp = theme.moonAltitude > -0.5;
    let lightToward: THREE.Vector3;
    if (sunUp) {
      lightToward = this.sunDirection;
    } else if (moonUp) {
      lightToward = this.moonDirection;
    } else {
      /*
       * Between two worlds: the sun is down and the moon has not risen. There is
       * no key light; the scene is carried by ambient and the practicals, which
       * is what a real overcast night amounts to. The direction is still set so
       * the shadow camera's frustum stays valid and its map is not thrown away
       * and rebuilt when the moon does come up.
       */
      lightToward = this.sunDirection;
      this.keyDirection.copy(this.sunDirection).normalize();
      this.key.position.copy(lightToward).multiplyScalar(30);
      this.key.target.position.set(0, 1, 0);
      this.key.shadow.intensity = 0;
      return;
    }

    /*
     * The direction is clamped to a minimum elevation while the intensity keeps
     * falling with the real altitude: a shadow-casting light below the horizon
     * puts every surface on the island into shadow at once, which reads as a
     * broken renderer rather than as dusk.
     */
    const target = this.keyDirection.copy(lightToward).normalize();
    this.sunKeyDirection.copy(this.sunDirection).normalize();
    if (target.y < Math.sin((KEY_MIN_ELEVATION * Math.PI) / 180)) {
      const horizontal = Math.hypot(target.x, target.z);
      const rise = Math.sin((KEY_MIN_ELEVATION * Math.PI) / 180);
      const squash = Math.sqrt(Math.max(0, 1 - rise * rise));
      if (horizontal > 1e-4) {
        target.x = (target.x / horizontal) * squash;
        target.z = (target.z / horizontal) * squash;
      }
      target.y = rise;
      target.normalize();
    }

    this.scratchLightPosition.copy(target).multiplyScalar(30);
    this.key.position.copy(this.scratchLightPosition);
    this.key.target.position.set(0, 1, 0);
    /*
     * Contact shadows fade out with the light rather than vanishing with it, so
     * a dusk that is already carried by ambient does not switch a hard edge on
     * halfway through.
     */
    const altitude = sunUp ? theme.sunAltitude : theme.moonAltitude;
    this.key.shadow.intensity = THREE.MathUtils.clamp((altitude + 4) / 10, 0, 1);
  }

  /** The key light's colour: warm at the horizon, neutral when high, moonlit by night. */
  private keyColour(theme: WorldTheme): number {
    if (theme.sunAltitude > -0.5) {
      const height = THREE.MathUtils.clamp(theme.sunAltitude / 45, 0, 1);
      return mixHex(theme.keyWarm, theme.keyCool, height);
    }
    return theme.moonLight;
  }

  /**
   * Redraw the moon's disc when its phase has moved enough to matter.
   *
   * A phase changes continuously, so redrawing on every difference would upload
   * a texture every frame for a difference no one can see. A twentieth of a
   * phase is about the smallest step that is visible on a 200-pixel disc, and it
   * comes round every day and a half.
   */
  private updateMoonPhase(theme: WorldTheme): void {
    const quantised = Math.round(theme.moonElongation / 18);
    if (quantised === this.moonPhaseKey) return;
    this.moonPhaseKey = quantised;
    const previous = this.moonTexture;
    this.moonTexture = moonTexture(theme.moonElongation);
    this.moonMaterials.disc.map = this.moonTexture;
    this.moonMaterials.disc.needsUpdate = true;
    previous.dispose();
  }

  /** Regenerate the image-based lighting from the current sky. */
  refreshEnvironment(): void {
    const cube = new THREE.WebGLCubeRenderTarget(64, {
      type: THREE.HalfFloatType,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
    });
    const camera = new THREE.CubeCamera(1, SKY_RADIUS * 2, cube);
    const scene = new THREE.Scene();
    const probeMaterial = this.skyMaterial.clone();
    /* The probe borrows the live uniforms, so it sees the current sky. */
    probeMaterial.uniforms = this.skyUniforms as unknown as Record<string, THREE.IUniform>;
    const probe = new THREE.Mesh(new THREE.SphereGeometry(SKY_RADIUS, 24, 16), probeMaterial);
    scene.add(probe);
    camera.update(this.renderer, scene);

    const generated = this.pmrem.fromCubemap(cube.texture);
    this.environment?.dispose();
    this.environment = generated.texture;

    probe.geometry.dispose();
    probeMaterial.dispose();
    cube.dispose();
  }

  /**
   * What the sky's own artwork is made of.
   *
   * Two claims about this world are claims about pixels that a frame cannot
   * settle: that the moon's sprite does not draw the edge of its own quad onto
   * the sky, and that a star is a point rather than a smudge. Both were once
   * false, and both were invisible in a screenshot taken at the wrong hour.
   *
   * So they are read back from the live objects. The moon's boundary is read
   * from the alpha channel the sprite is actually textured with — a glow that
   * has not reached zero where the canvas ends *is* a square, whatever the
   * frame happens to show. The star sizes are read from the attribute the
   * shader turns into `gl_PointSize`, so "a star is at most a few pixels" is
   * measured on the data rather than inferred from a blur.
   */
  craftDiagnostics(): {
    moon: { size: number; edge: number; centre: number; disc: number };
    stars: { count: number; median: number; largest: number; flares: number };
  } {
    const moon = { size: 0, edge: 0, centre: 0, disc: 0 };
    const image = (this.moonTexture as THREE.CanvasTexture).image as
      | HTMLCanvasElement
      | undefined;
    const context = image?.getContext?.('2d') ?? null;
    if (image && context) {
      const size = image.width;
      const data = context.getImageData(0, 0, size, size).data;
      const alphaAt = (x: number, y: number) =>
        data[(Math.round(y) * size + Math.round(x)) * 4 + 3];
      moon.size = size;
      moon.edge = Math.max(
        alphaAt(0, 0),
        alphaAt(size - 1, 0),
        alphaAt(0, size - 1),
        alphaAt(size - 1, size - 1),
        alphaAt(size / 2, 0),
        alphaAt(0, size / 2),
        alphaAt(size - 1, size / 2),
        alphaAt(size / 2, size - 1),
        alphaAt(size / 2, 2),
        alphaAt(2, size / 2),
      );
      moon.centre = alphaAt(size / 2, size / 2);
      /* Three fifths of the way out along the disc's own radius, which is where
         a full moon has to be drawn if the disc is drawn at all. */
      moon.disc = alphaAt(size / 2, size * 0.272);
    }

    const sizes = (this.stars.geometry as THREE.BufferGeometry).attributes.aSize
      ?.array as Float32Array | undefined;
    const flares = (this.stars.geometry as THREE.BufferGeometry).attributes.aFlare
      ?.array as Float32Array | undefined;
    const stars = { count: sizes?.length ?? 0, median: 0, largest: 0, flares: 0 };
    if (sizes?.length) {
      const sorted = Array.from(sizes).sort((a, b) => a - b);
      stars.median = Number(sorted[Math.floor(sorted.length / 2)].toFixed(2));
      stars.largest = Number(sorted[sorted.length - 1].toFixed(2));
      stars.flares = flares ? Array.from(flares).filter((value) => value > 0.5).length : 0;
    }
    return { moon, stars };
  }

  setQuality(quality: QualitySettings): void {
    this.quality = quality;
    this.key.castShadow = quality.shadows;
    if (quality.shadows) {
      const size = quality.shadowMapSize;
      this.key.shadow.mapSize.set(size, size);
      const camera = this.key.shadow.camera;
      camera.left = -16;
      camera.right = 16;
      camera.top = 16;
      camera.bottom = -16;
      camera.near = 2;
      camera.far = 64;
      camera.updateProjectionMatrix();
      /*
       * A wide, soft shadow rather than a hard one. The island is a miniature,
       * so a crisp cast shadow reads as a diagram; the bias and radius are tuned
       * together to keep contact shadows under the buildings while letting the
       * treeline fall away softly.
       */
      this.key.shadow.bias = -0.0004;
      this.key.shadow.normalBias = 0.03;
      this.key.shadow.radius = quality.tier === 'high' ? 4 : quality.tier === 'medium' ? 2.5 : 1.5;
    } else if (this.key.shadow.map) {
      this.key.shadow.map.dispose();
      this.key.shadow.map = null;
    }
    const sunGlow = this.sunBody.getObjectByName('glow');
    if (sunGlow) sunGlow.visible = quality.detail;
  }

  /**
   * Keep the sky centred on the camera and run the two bodies along their real
   * paths.
   *
   * Each body is placed at its own compass bearing and altitude, projected onto
   * the frame from the camera's position. There is no arc and no fade at the
   * foot of one: the altitude *is* the arc, and a body that has set falls
   * genuinely below the horizon and fades out over the last few degrees, which is
   * the same behaviour seen from a hillside.
   */
  follow(camera: THREE.Camera, focus?: THREE.Vector3): void {
    this.skyMesh.position.copy(camera.position);
    this.stars.position.copy(camera.position);

    const theme = this.theme;
    const distance = SKY_RADIUS * 0.98;
    const place = (body: THREE.Group, direction: THREE.Vector3, size: number) => {
      body.position.copy(camera.position).addScaledVector(direction, distance);
      body.scale.setScalar(size);
    };

    /*
     * Apparent size. A sun and a moon are both about half a degree across, which
     * at 420 units is under four units — accurate and far too small to read or
     * press. They are drawn at roughly four times their true angular size, which
     * is the same licence a photograph of a sunset takes with a long lens.
     */
    const perspective = camera as THREE.PerspectiveCamera;
    const halfHeight = Math.tan(THREE.MathUtils.degToRad(perspective.fov ?? 40) / 2) * distance;

    const focusDistance = focus === undefined ? 0 : camera.position.distanceTo(focus);
    this.lastFocusDistance = focusDistance;

    let sunFade: number;
    let moonFade: number;

    if (this.celestialEnabled) {
      /*
       * On the campus overview the sun and moon are the light switch. They are
       * drawn in view space so they always sit in the upper sky the visitor is
       * looking at, while the key light and the dome shader still follow the
       * real astronomy. A body that has set slides below the frame; the other
       * rises through `dayness`.
       */
      const day = THREE.MathUtils.clamp(theme.dayness, 0, 1);
      const night = THREE.MathUtils.clamp(theme.nightness, 0, 1);
      const portrait = (perspective.aspect ?? 1) < 0.92;
      const sunLift = portrait
        ? THREE.MathUtils.lerp(-0.55, 0.34, day)
        : THREE.MathUtils.lerp(-0.62, 0.52, day);
      const moonLift = portrait
        ? THREE.MathUtils.lerp(0.22, -0.55, day)
        : THREE.MathUtils.lerp(0.4, -0.62, day);
      const sunPan = portrait ? 0 : -0.28;
      const moonPan = portrait ? 0.2 : 0.42;
      const sunSize = halfHeight * (portrait ? 0.15 : 0.125);
      const moonSize = halfHeight * (portrait ? 0.13 : 0.1);

      this.placeBodyInView(camera, this.sunBody, sunPan, sunLift, sunSize, distance);
      this.placeBodyInView(camera, this.moonBody, moonPan, moonLift, moonSize, distance);

      const sunHorizon = THREE.MathUtils.smoothstep(sunLift, -0.5, -0.15);
      const moonHorizon = THREE.MathUtils.smoothstep(moonLift, -0.5, -0.15);
      sunFade = day * sunHorizon;
      moonFade = night * moonHorizon * (0.55 + theme.moonIllumination * 0.45);
    } else {
      place(this.sunBody, this.sunDirection, halfHeight * 0.19);
      place(this.moonBody, this.moonDirection, halfHeight * 0.15);

      let range =
        focus === undefined ? 1 : THREE.MathUtils.clamp((focusDistance - 6.6) / 2.8, 0, 1);
      const pitchDown = -camera.getWorldDirection(this.scratchBody).y;
      range *= THREE.MathUtils.clamp((0.8 - pitchDown) / 0.24, 0, 1);

      sunFade = altitudeFade(theme.sunAltitude) * range;
      moonFade = altitudeFade(theme.moonAltitude) * range * (0.35 + theme.moonIllumination * 0.65);
    }

    this.captionOffset
      .set(0, 1, 0)
      .applyQuaternion(camera.quaternion)
      .multiplyScalar(-0.19 * halfHeight);
    this.sunOpacity = sunFade;
    this.moonOpacity = moonFade;
    this.celestialOpacity = Math.max(sunFade, moonFade);

    this.sunMaterials.disc.opacity = sunFade * 0.88;
    this.sunMaterials.glow.opacity =
      0.28 * sunFade * (0.45 + theme.golden * 0.45 + theme.dayness * 0.35);
    this.moonMaterials.disc.opacity = moonFade;
    this.moonMaterials.glow.opacity = 0.3 * moonFade * theme.nightness + 0.12 * moonFade;

    this.sunBody.visible = this.celestialEnabled && sunFade > 0.01;
    this.moonBody.visible = this.celestialEnabled && moonFade > 0.01;

    /*
     * Hold the stars still while the world turns under them.
     *
     * The dome and the star field are centred on the camera, so their shader
     * coordinates are camera-relative: when the camera swings, the whole sky
     * swings with it, and a star that should have stayed put slides across the
     * frame. That is invisible from a static camera and very visible from a
     * turning one — the campus auto-turns on arrival, and the effect was a sky
     * that span round with the island as though the two were welded together.
     *
     * The fix is to turn the field by the *sidereal* angle alone rather than by
     * the camera's bearing as well: the real sky does not care where the visitor
     * is looking, and now neither does this one. The field is a child of nothing
     * that rotates, so the quaternion is the whole of it.
     */
    this.stars.quaternion.setFromAxisAngle(STAR_POLE_AXIS, this.siderealAngle);
    this.starUniforms.pixelScale.value = this.renderer.getPixelRatio();
    this.starUniforms.time.value = performance.now() * 0.001;

    /* A slow twinkle, which is atmospheric scintillation compressed to
       something a viewer will actually notice. */
    if (this.starOpacity > 0.01 && this.quality.ambient) {
      const twinkle = 0.9 + Math.sin(performance.now() * 0.0011) * 0.1;
      this.starUniforms.opacity.value = this.starOpacity * twinkle;
    } else {
      this.starUniforms.opacity.value = this.starOpacity;
    }
  }

  /**
   * The sidereal angle for the current moment, in radians.
   *
   * Stored rather than written straight to the shader, because the shader's
   * rotation is the sidereal angle *minus the camera's bearing* — see `follow`.
   * Only the world half of that is the sky's business; the camera half changes
   * every frame.
   */
  private siderealAngle = 0;

  /**
   * Set the sidereal angle, in degrees.
   *
   * Called when the sky is recomputed rather than per frame: the stars move
   * about four minutes a day, so the angle is a property of the moment, and the
   * per-frame part of the rotation is the camera's bearing.
   */
  setSiderealAngle(degrees: number): void {
    this.siderealAngle = (degrees * Math.PI) / 180;
  }

  /** Show or hide the sky bodies. */
  setCelestialEnabled(enabled: boolean): void {
    this.celestialEnabled = enabled;
  }

  /**
   * Place a sky body on the inner dome in camera space so it stays in the
   * frame the visitor is looking at.
   */
  private placeBodyInView(
    camera: THREE.Camera,
    body: THREE.Group,
    pan: number,
    lift: number,
    size: number,
    distance: number,
  ): void {
    this.scratchViewDir.set(pan, lift, -1).normalize();
    this.scratchViewDir.applyQuaternion(camera.quaternion);
    body.position.copy(camera.position).addScaledVector(this.scratchViewDir, distance);
    body.scale.setScalar(size);
  }

  /**
   * Where the body that is currently up can be tapped, in world space. A body
   * that has faded out is not a target.
   */
  activeCelestialPosition(): THREE.Vector3 | null {
    if (!this.celestialEnabled) return null;
    if (Math.max(this.sunOpacity, this.moonOpacity) < 0.1) return null;
    const body = this.sunOpacity >= this.moonOpacity ? this.sunBody : this.moonBody;
    if (!body.visible) return null;
    return body.position.clone();
  }

  /** Where the caption for the body that is up should hang. */
  activeCelestialCaptionPosition(): THREE.Vector3 | null {
    const body = this.activeCelestialPosition();
    return body ? body.add(this.captionOffset) : null;
  }

  /** Which body a tap would land on. */
  activeCelestialKind(): 'sun' | 'moon' {
    return this.sunOpacity >= this.moonOpacity ? 'sun' : 'moon';
  }

  /**
   * Which sky body is under a screen point, by raycasting the real sprites.
   *
   * This is the honest test of where the bodies *are*: it resolves the tap
   * against the same scene graph the renderer drew, so a verification run can
   * prove the sun is in the eastern sky at nine in the morning by pointing at
   * the screen position that bearing implies and getting the sun back.
   */
  probeBody(ndcX: number, ndcY: number, camera: THREE.Camera): 'sun' | 'moon' | null {
    this.probe ??= new SkyProbe(this.sunBody, this.moonBody);
    return this.probe.pick(ndcX, ndcY, camera);
  }

  private probe: SkyProbe | null = null;

  /** The moon's phase name, for the caption. */
  celestialKind(): 'sun' | 'moon' | null {
    if (Math.max(this.sunOpacity, this.moonOpacity) < 0.1) return null;
    return this.activeCelestialKind();
  }

  celestialDiagnostics(): {
    enabled: boolean;
    dayness: number;
    opacity: number;
    sunVisible: boolean;
    moonVisible: boolean;
    distance: number;
    kind: 'sun' | 'moon' | null;
    sunAltitude: number;
    moonAltitude: number;
    moonIllumination: number;
  } {
    return {
      enabled: this.celestialEnabled,
      dayness: this.theme.dayness,
      opacity: this.celestialOpacity,
      sunVisible: this.sunBody.visible,
      moonVisible: this.moonBody.visible,
      distance: this.lastFocusDistance,
      kind: this.celestialKind(),
      sunAltitude: this.theme.sunAltitude,
      moonAltitude: this.theme.moonAltitude,
      moonIllumination: this.theme.moonIllumination,
    };
  }

  /** Which way the key light points, for the diagnostics. */
  get keyDirectionX(): number {
    return this.keyDirection.x;
  }
  get keyDirectionY(): number {
    return this.keyDirection.y;
  }
  get keyDirectionZ(): number {
    return this.keyDirection.z;
  }

  /** Which way the sun itself points, before the key light's elevation clamp. */
  get sunDirectionY(): number {
    return this.sunKeyDirection.y;
  }

  /**
   * What the sky dome is actually drawing.
   *
   * The sky is a shader on a mesh the camera sits inside, so "the sky is black"
   * has several possible causes and only one of them is in the shader. Reading
   * the live uniforms back is what separates "the palette is wrong" from "the
   * palette never arrived", and it is not something a screenshot can answer.
   */
  skyDiagnostics(): Record<string, unknown> {
    const colour = (uniform: { value: THREE.Color }) =>
      `#${uniform.value.getHexString()}`;
    return {
      zenith: colour(this.skyUniforms.zenith),
      horizon: colour(this.skyUniforms.horizon),
      sunTint: colour(this.skyUniforms.sunTint),
      ground: colour(this.skyUniforms.ground),
      sunColor: colour(this.skyUniforms.sunColor),
      sunDirection: this.skyUniforms.sunDirection.value.toArray().map((n) => Number(n.toFixed(3))),
      intensity: this.skyUniforms.intensity.value,
      sunGlow: this.skyUniforms.sunGlow.value,
      sunStrength: this.skyUniforms.sunStrength.value,
      haze: this.skyUniforms.haze.value,
      domeRadius: (this.skyMesh.geometry as THREE.SphereGeometry).parameters?.radius ?? null,
      domeVisible: this.skyMesh.visible,
      domePosition: this.skyMesh.position.toArray().map((n) => Number(n.toFixed(2))),
      starOpacity: this.starUniforms.opacity.value,
      /**
       * The star field's own rotation, and the sidereal angle it is taken from.
       *
       * The field is turned by the sidereal angle and nothing else, so the two
       * agree by construction; they are both reported because a sky that spun
       * with the camera would show the first changing while the second did not,
       * and that is the failure this pair exists to make visible.
       */
      starRotation: Number(((this.siderealAngle * 180) / Math.PI).toFixed(3)),
      siderealAngle: Number(((this.siderealAngle * 180) / Math.PI).toFixed(3)),
      exposure: this.renderer.toneMappingExposure,
      toneMapping: this.renderer.toneMapping,
      outputColorSpace: this.renderer.outputColorSpace,
      keyColour: `#${this.key.color.getHexString()}`,
      keyIntensity: this.key.intensity,
      fog: `#${this.fog.color.getHexString()}`,
      fogDensity: this.fog.density,
    };
  }

  /**
   * Where a body sits on the frame, in normalized device coordinates, or null
   * when it is not in front of the camera at all.
   *
   * The `z` test is the one that matters and the one that is easy to get wrong.
   * A point *behind* the camera still produces a finite projection — the
   * perspective divide flips it through the origin — so x and y look plausible
   * and the result is a body reported as on screen while it is at the camera's
   * back. The view-space depth is the only honest test, and it has to be applied
   * to the depth rather than to the *normalized* depth, because the near and far
   * planes put a legitimate point anywhere in `[-1, 1]` depending on how far
   * away it is.
   */
  projectBody(kind: 'sun' | 'moon', camera: THREE.Camera): { x: number; y: number; z: number } | null {
    /*
     * The camera's own matrices are only refreshed by the renderer, so a question
     * asked between frames is answered against the previous pose — and against a
     * projection matrix from before the last resize. That is invisible for a
     * camera standing still and wrong for one that is travelling, which is
     * exactly when this is asked.
     */
    camera.updateMatrix();
    camera.updateMatrixWorld();
    (camera as THREE.PerspectiveCamera).updateProjectionMatrix?.();
    const body = kind === 'sun' ? this.sunBody : this.moonBody;
    const toBody = this.scratchBody.copy(body.position).sub(camera.position);
    const forward = camera.getWorldDirection(this.scratchForward2);
    if (toBody.dot(forward) <= 0.01) return null;
    const point = this.scratchProject.copy(toBody).add(camera.position).project(camera);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
    return { x: point.x, y: point.y, z: point.z };
  }

  /** The on-screen half-size of the active body, for a forgiving tap target. */
  activeCelestialRadius(camera: THREE.Camera): number {
    return this.celestialBodyRadius(this.activeCelestialKind(), camera);
  }

  /** On-screen radius in NDC-height units for a given body. */
  celestialBodyRadius(kind: 'sun' | 'moon', camera: THREE.Camera): number {
    const body = kind === 'sun' ? this.sunBody : this.moonBody;
    const perspective = camera as THREE.PerspectiveCamera;
    const distance = Math.max(camera.position.distanceTo(body.position), 1);
    const worldRadius = 0.5 * body.scale.x;
    const halfHeight = Math.tan(THREE.MathUtils.degToRad(perspective.fov ?? 40) / 2) * distance;
    return (worldRadius / Math.max(halfHeight, 0.001)) * 0.58;
  }

  dispose(): void {
    this.skyMesh.geometry.dispose();
    this.skyMaterial.dispose();
    this.stars.geometry.dispose();
    (this.stars.material as THREE.Material).dispose();
    this.sunTexture.dispose();
    this.moonTexture.dispose();
    for (const body of [this.sunBody, this.moonBody]) {
      body.traverse((child) => {
        const sprite = child as THREE.Sprite;
        if (sprite.isSprite) sprite.material.dispose();
      });
    }
    this.hazeTexture.dispose();
    this.pmrem.dispose();
    this.environment?.dispose();
    this.group.clear();
  }
}

/**
 * How visible a body is at a given altitude.
 *
 * Full above about eight degrees, faded out by six below the horizon. The
 * asymmetry — quick to appear, slower to go — is deliberate: a body emerging
 * from a horizon is coming into a sky that is already lit, and one sinking is
 * taking the last of the light with it.
 *
 * The tail is longer than physical honesty would suggest, and that is a
 * deliberate trade. A body two degrees below the horizon is invisible in
 * reality; here it is a faint five percent, which is enough for a visitor to
 * find and press, and far too little to notice as wrong. The alternative is a
 * sky with no way to change it.
 */
function altitudeFade(altitude: number): number {
  if (altitude > 3) return 1;
  return THREE.MathUtils.clamp((altitude + 12) / 15, 0, 1);
}

/**
 * Turn a screen point into a ray in world space.
 *
 * Kept here rather than in the shell because the projection the sky bodies are
 * placed with is this class's own: a raycaster in the shell would have to
 * reconstruct half of what is already known, and the two could drift.
 */
export class SkyProbe {
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();

  constructor(
    private readonly sunBody: THREE.Object3D,
    private readonly moonBody: THREE.Object3D,
  ) {}

  /** Which sky body, if any, is under a normalized device coordinate. */
  pick(ndcX: number, ndcY: number, camera: THREE.Camera): 'sun' | 'moon' | null {
    this.pointer.set(ndcX, ndcY);
    this.raycaster.setFromCamera(this.pointer, camera);
    const hits = this.raycaster.intersectObjects([this.sunBody, this.moonBody], true);
    if (!hits.length) return null;
    let node: THREE.Object3D | null = hits[0].object;
    while (node) {
      if (node === this.sunBody) return 'sun';
      if (node === this.moonBody) return 'moon';
      node = node.parent;
    }
    return null;
  }
}

function mixHex(a: number, b: number, t: number): number {
  const clamped = THREE.MathUtils.clamp(t, 0, 1);
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  return (
    (Math.round(ar + (br - ar) * clamped) << 16) |
    (Math.round(ag + (bg - ag) * clamped) << 8) |
    Math.round(ab + (bb - ab) * clamped)
  );
}
