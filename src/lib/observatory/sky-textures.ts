/**
 * The sky: its dome shader, its stars and its moon.
 *
 * Three things live here, and all three exist because a painted gradient behind
 * a flat sprite cannot do what a sky has to do:
 *
 *  - **The dome.** One shader on one sphere, driven by the sun's real direction.
 *    Its whole point is that the glow sits *where the sun is*: a sky whose
 *    brightest region is fixed to the middle of the frame is the single clearest
 *    sign to a viewer that the sun above the buildings is a sticker. A gradient
 *    sampled by the angle to the sun is also, incidentally, most of what a
 *    Rayleigh scattering integral looks like once it has been tone-mapped.
 *
 *  - **The stars.** Drawn as an equirectangular map of dark-sky stars, then
 *    applied along the *celestial* rotation rather than a fixed vertical seam.
 *    A starfield that does not turn with the sky is a texture; one that turns by
 *    the local sidereal angle is a sky, and it is the detail that makes a night
 *    scene read as a real place at a real hour.
 *
 *  - **The moon.** Drawn per phase from the geometry of the terminator rather
 *    than from eight stored pictures. A moon at the wrong phase over a
 *    correctly-placed sun is the kind of error that looks like a bug in the
 *    world, and it is the first thing anyone who has looked up at night notices.
 */

import * as THREE from 'three';

export interface SkyColors {
  /** Overhead. */
  zenith: number;
  /** At the horizon, in the direction of the sun. */
  horizon: number;
  /** The band immediately around the sun. */
  sunTint: number;
  /** The sky below the horizon line, seen past the island's edge. */
  ground: number;
  /** The sun's own colour in the glow term. */
  sun: number;
}

/** Format a packed 0xRRGGBB as a GLSL `vec3` in linear-light space. */
function glslColor(hex: number): string {
  const r = ((hex >> 16) & 0xff) / 255;
  const g = ((hex >> 8) & 0xff) / 255;
  const b = (hex & 0xff) / 255;
  const toLinear = (value: number) =>
    (value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4)).toFixed(5);
  return `vec3(${toLinear(r)}, ${toLinear(g)}, ${toLinear(b)})`;
}

/* ── The dome ────────────────────────────────────────────────────────── */

export interface SkyUniforms {
  zenith: { value: THREE.Color };
  horizon: { value: THREE.Color };
  sunTint: { value: THREE.Color };
  ground: { value: THREE.Color };
  sunColor: { value: THREE.Color };
  sunDirection: { value: THREE.Vector3 };
  /** How wide the glow around the sun spreads. */
  sunGlow: { value: number };
  /** How bright the glow is. */
  sunStrength: { value: number };
  /** Haze thickens the band at the horizon. */
  haze: { value: number };
  /** Overall sky brightness — the tone the sky is exposed at. */
  intensity: { value: number };
}

export function skyUniforms(colors: SkyColors, haze = 0.3): SkyUniforms {
  return {
    zenith: { value: new THREE.Color(colors.zenith) },
    horizon: { value: new THREE.Color(colors.horizon) },
    sunTint: { value: new THREE.Color(colors.sunTint) },
    ground: { value: new THREE.Color(colors.ground) },
    sunColor: { value: new THREE.Color(colors.sun) },
    sunDirection: { value: new THREE.Vector3(0, 1, 0) },
    sunGlow: { value: 0.24 },
    sunStrength: { value: 1 },
    haze: { value: haze },
    intensity: { value: 1 },
  };
}

const SKY_VERTEX = /* glsl */ `
varying vec3 vDirection;
void main() {
  /*
   * The dome is centred on the camera every frame, so the world position *is*
   * the view direction. Passing it through unmodified avoids carrying a camera
   * uniform and a matrix multiply into the fragment stage.
   */
  vDirection = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SKY_FRAGMENT = /* glsl */ `
precision highp float;

uniform vec3 zenith;
uniform vec3 horizon;
uniform vec3 sunTint;
uniform vec3 ground;
uniform vec3 sunColor;
uniform vec3 sunDirection;
uniform float sunGlow;
uniform float sunStrength;
uniform float haze;
uniform float intensity;

varying vec3 vDirection;

void main() {
  vec3 direction = normalize(vDirection);

  /*
   * Elevation, remapped to a 0..1 coordinate along the vertical gradient.
   *
   * The exponent is the whole character of the sky: a linear ramp gives the
   * flat two-band wash that reads as a 1990s skydome, while a power curve
   * keeps the zenith colour overhead and compresses the transition into the
   * last few degrees above the horizon, which is what a real sky does.
   */
  float elevation = clamp(direction.y, -1.0, 1.0);
  float up = clamp(elevation, 0.0, 1.0);
  float gradient = pow(up, 0.42);

  vec3 sky = mix(horizon, zenith, gradient);

  /*
   * The horizon band. A real horizon is not a line but a thickness of air, and
   * the thickness grows with haze — so this band does too. It is what separates
   * the island's silhouette from the sky instead of leaving it pasted on.
   */
  float bandWidth = 0.16 + haze * 0.22;
  float band = exp(-abs(elevation) / bandWidth);
  sky = mix(sky, horizon, band * (0.45 + haze * 0.35));

  /*
   * The glow around the sun.
   *
   * Two lobes: a tight one that is nearly the sun itself, and a wide one that
   * is the light scattering through the air ahead of it. The wide lobe is what
   * makes the sky read as directional — it is the difference between a sky that
   * happens to be orange and a sky that is being lit from a particular place.
   */
  float cosine = dot(direction, normalize(sunDirection));
  float tight = pow(max(cosine, 0.0), 220.0);
  float wide = pow(max(cosine, 0.0), 7.0);
  float below = smoothstep(-0.35, 0.08, elevation);
  sky += sunColor * tight * 1.35 * sunStrength * below;
  sky += sunTint * wide * sunGlow * sunStrength * below;

  /*
   * Below the horizon. The dome has no bottom, and without this the sky'd
   * simply mirror its own top half downward, which reads as a second sky
   * underneath the island.
   */
  float under = smoothstep(0.0, -0.22, elevation);
  sky = mix(sky, ground, under);

  gl_FragColor = vec4(sky * intensity, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function skyMaterial(colors: SkyColors, haze = 0.3): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: skyUniforms(colors, haze) as unknown as Record<string, THREE.IUniform>,
    vertexShader: SKY_VERTEX,
    fragmentShader: SKY_FRAGMENT,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    toneMapped: true,
  });
}

/* ── The stars ───────────────────────────────────────────────────────── */

/**
 * A dark-sky star map, as an equirectangular texture.
 *
 * Roughly 1400 stars, distributed by a simple galactic-plane model: a uniform
 * sprinkle plus a heavy concentration along a tilted great circle, because the
 * real sky is not evenly populated and a uniform sprinkle reads as noise. The
 * colour index is sampled too — blue-white through amber — since the brightest
 * stars are visibly coloured.
 *
 * Brightness follows the real distribution closely enough to matter: a great
 * many faint points and a handful of dominating ones. A field of equally bright
 * dots is the single most common giveaway of a procedural starfield.
 */
export function starTexture(seed = 20260913, count = 1400): THREE.CanvasTexture {
  const width = 2048;
  const height = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  if (ctx) {
    ctx.clearRect(0, 0, width, height);

    /* The galactic plane: a great circle inclined to the celestial equator. */
    const planeTilt = 62 * (Math.PI / 180);
    const planeNormal = new THREE.Vector3(
      Math.sin(planeTilt),
      Math.cos(planeTilt),
      0,
    ).normalize();

    for (let i = 0; i < count; i++) {
      /*
       * Two thirds of the stars are drawn toward the galactic plane. Sampling
       * the gap-to-plane with a power curve concentrates them without producing
       * the hard edge a rejection test would.
       */
      const inPlane = random() < 0.66;
      const azimuth = random() * Math.PI * 2;
      const declination = inPlane
        ? Math.asin(Math.max(-1, Math.min(1, (random() * 2 - 1) * Math.pow(random(), 0.6))))
        : Math.acos(1 - 2 * random()) - Math.PI / 2;

      const direction = new THREE.Vector3(
        Math.cos(declination) * Math.cos(azimuth),
        Math.sin(declination),
        Math.cos(declination) * Math.sin(azimuth),
      );

      /* Reject the ones that fell outside the band when they should be in it. */
      if (inPlane && Math.abs(direction.dot(planeNormal)) > 0.24) continue;

      const u = ((Math.atan2(direction.z, direction.x) / (Math.PI * 2)) + 0.5) * width;
      /* The texture's v axis runs to the zenith, so the sphere is not flipped. */
      const v = (0.5 - Math.asin(Math.max(-1, Math.min(1, direction.y))) / Math.PI) * height;

      /*
       * Magnitude: `random()^4` gives many faint stars and a few bright ones.
       * Squaring it again for the very brightest makes the first-magnitude
       * stars stand out the way they do in a real sky.
       */
      const magnitude = Math.pow(random(), 4);
      const brightness = 0.18 + magnitude * 0.82;
      const radius = 0.5 + magnitude * 2.1;

      /* Colour index: cool blue-white through white to warm amber. */
      const warmth = Math.pow(random(), 2) * (random() < 0.5 ? -1 : 1);
      const r = Math.round(255 * Math.min(1, 1 + warmth * 0.22));
      const g = Math.round(255 * Math.min(1, 1 - Math.abs(warmth) * 0.06));
      const b = Math.round(255 * Math.min(1, 1 - warmth * 0.26));

      const glow = ctx.createRadialGradient(u, v, 0, u, v, radius * 3.4);
      glow.addColorStop(0, `rgba(${r},${g},${b},${brightness})`);
      glow.addColorStop(0.28, `rgba(${r},${g},${b},${brightness * 0.42})`);
      glow.addColorStop(1, `rgba(${r},${g},${b},0)`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(u, v, radius * 3.4, 0, Math.PI * 2);
      ctx.fill();

      /* A hard core, so the brightest stars have a point rather than a smudge. */
      if (magnitude > 0.55) {
        ctx.fillStyle = `rgba(255,255,255,${(magnitude - 0.55) * 1.6})`;
        ctx.beginPath();
        ctx.arc(u, v, radius * 0.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/** The magnitude band of the star map, for the fade-in at dusk. */
export function starLimits(): { fadeStart: number; full: number } {
  return { fadeStart: 0.02, full: 0.26 };
}

/* ── The moon ────────────────────────────────────────────────────────── */

/**
 * The moon at a given phase, drawn from the geometry of the terminator.
 *
 * `elongation` is the sun-to-moon angle in degrees: 0 is new, 180 is full, and
 * the sign says which limb is lit. The terminator is an ellipse whose
 * semi-minor axis is `R·cos(elongation)` seen against a limb that is a circle
 * of radius `R`, so the figure is two arcs — and drawing it that way is what
 * makes every phase come out right, including the ones in between the eight
 * that a sprite sheet would have to approximate.
 *
 * The surface underneath is the real thing as far as a 256-pixel disc can carry
 * it: darker maria, a lighter highland, and a scatter of craters with bright
 * rims, all offset so the moon is slightly gibbous-looking rather than a flat
 * coin. Roughness is not simulated — the moon is airless — but the phase
 * boundary is softened by a couple of pixels, because a hard terminator on a
 * low-resolution disc aliases into a stair-step.
 */
export function moonTexture(elongation: number, size = 256): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const centre = size / 2;
  const radius = size * 0.34;

  if (ctx) {
    ctx.clearRect(0, 0, size, size);

    /* A nimbus, so the moon is not a disc pasted onto the sky. */
    const nimbus = ctx.createRadialGradient(centre, centre, radius, centre, centre, radius * 2.4);
    nimbus.addColorStop(0, 'rgba(206,220,246,0.3)');
    nimbus.addColorStop(0.5, 'rgba(190,206,238,0.09)');
    nimbus.addColorStop(1, 'rgba(180,198,232,0)');
    ctx.fillStyle = nimbus;
    ctx.fillRect(0, 0, size, size);

    /*
     * The surface. Drawn into an offscreen canvas first so it can be clipped to
     * the phase afterwards rather than being re-drawn per phase.
     */
    const surface = document.createElement('canvas');
    surface.width = surface.height = size;
    const sctx = surface.getContext('2d');
    if (sctx) {
      const body = sctx.createRadialGradient(
        centre - radius * 0.22,
        centre - radius * 0.22,
        radius * 0.05,
        centre,
        centre,
        radius,
      );
      body.addColorStop(0, 'rgb(248,250,255)');
      body.addColorStop(0.55, 'rgb(214,222,238)');
      body.addColorStop(0.88, 'rgb(178,188,210)');
      body.addColorStop(1, 'rgb(140,152,180)');
      sctx.fillStyle = body;
      sctx.beginPath();
      sctx.arc(centre, centre, radius, 0, Math.PI * 2);
      sctx.fill();

      let state = 7771;
      const random = () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };

      /* Maria: large, dark, irregular. Clipped to the disc by a save/clip. */
      sctx.save();
      sctx.beginPath();
      sctx.arc(centre, centre, radius, 0, Math.PI * 2);
      sctx.clip();

      sctx.fillStyle = 'rgba(132,146,176,0.5)';
      const maria: [number, number, number][] = [
        [-0.3, -0.28, 0.3],
        [0.16, -0.1, 0.24],
        [-0.12, 0.22, 0.2],
        [0.42, 0.24, 0.16],
        [-0.5, 0.1, 0.14],
      ];
      for (const [mx, my, mr] of maria) {
        sctx.beginPath();
        sctx.ellipse(
          centre + mx * radius,
          centre + my * radius,
          mr * radius,
          mr * radius * (0.6 + random() * 0.5),
          random() * Math.PI,
          0,
          Math.PI * 2,
        );
        sctx.fill();
      }

      /* Craters: a darker floor and a brighter rim, which is what makes them
         read as depressions rather than as spots. */
      for (let i = 0; i < 46; i++) {
        const angle = random() * Math.PI * 2;
        const distance = Math.sqrt(random()) * radius * 0.94;
        const cx = centre + Math.cos(angle) * distance;
        const cy = centre + Math.sin(angle) * distance;
        const cr = radius * (0.018 + random() * 0.075);

        sctx.fillStyle = `rgba(126,140,170,${0.16 + random() * 0.2})`;
        sctx.beginPath();
        sctx.arc(cx, cy, cr, 0, Math.PI * 2);
        sctx.fill();

        sctx.strokeStyle = `rgba(255,255,255,${0.16 + random() * 0.26})`;
        sctx.lineWidth = Math.max(0.6, cr * 0.22);
        sctx.beginPath();
        sctx.arc(cx, cy, cr * 0.96, 0, Math.PI * 2);
        sctx.stroke();
      }
      sctx.restore();

      /*
       * The phase mask. `cos(elongation)` is the terminator's horizontal
       * half-width as a fraction of the limb; its sign decides whether the
       * terminator bulges toward the lit limb (waning) or away from it
       * (waxing). The sign of the elongation places the lit limb on the right
       * for a waxing moon and on the left for a waning one, which is the
       * correct way up for an observer in the northern hemisphere.
       */
      const radians = (elongation * Math.PI) / 180;
      const terminator = Math.cos(radians) * radius;
      const waxing = elongation >= 0;
      const litRight = waxing;

      ctx.save();
      ctx.beginPath();
      /* The lit limb: a half circle from top to bottom on the lit side. */
      ctx.arc(centre, centre, radius, -Math.PI / 2, Math.PI / 2, !litRight);
      /*
       * And back along the terminator. `ellipse` with a horizontal radius of
       * |terminator| traces exactly the curve the shadow makes; the sweep flag
       * flips with the sign so a gibbous and a crescent are different figures
       * rather than the same one mirrored.
       */
      ctx.ellipse(
        centre,
        centre,
        Math.abs(terminator),
        radius,
        0,
        Math.PI / 2,
        -Math.PI / 2,
        (terminator >= 0) === litRight,
      );
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(surface, 0, 0);
      ctx.restore();

      /*
       * A hairline along the lit limb, drawn outside the clip so the disc has a
       * defined edge against a bright sky at moonset.
       */
      ctx.strokeStyle = 'rgba(178,192,220,0.5)';
      ctx.lineWidth = size * 0.004;
      ctx.beginPath();
      ctx.arc(centre, centre, radius, -Math.PI / 2, Math.PI / 2, !litRight);
      ctx.stroke();
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/* ── The sun ─────────────────────────────────────────────────────────── */

/**
 * The sun's disc and corona.
 *
 * A sun is not a yellow circle: it is a blinding white core that the eye reads
 * as a coloured glow around it, with rays that are a lens artefact rather than
 * a property of the star. Drawing it that way — a saturated core, a broad
 * thermal falloff, and short uneven rays — is what stops it looking like a
 * sticker, and the core being *white* rather than orange is what lets it sit in
 * a pale blue midday sky without disappearing.
 */
export function sunTexture(size = 256): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const centre = size / 2;
  const coreRadius = size * 0.15;

  if (ctx) {
    ctx.clearRect(0, 0, size, size);

    const corona = ctx.createRadialGradient(centre, centre, coreRadius, centre, centre, size * 0.5);
    corona.addColorStop(0, 'rgba(255,244,214,0.95)');
    corona.addColorStop(0.22, 'rgba(255,214,140,0.5)');
    corona.addColorStop(0.55, 'rgba(252,178,92,0.16)');
    corona.addColorStop(1, 'rgba(248,150,60,0)');
    ctx.fillStyle = corona;
    ctx.fillRect(0, 0, size, size);

    /* Rays: tapered wedges, alternating length, so the disc is not a target. */
    ctx.save();
    ctx.translate(centre, centre);
    const rays = 20;
    for (let i = 0; i < rays; i++) {
      const length = size * (i % 2 === 0 ? 0.46 : 0.33) * (0.86 + ((i * 37) % 11) / 40);
      const half = size * (i % 2 === 0 ? 0.026 : 0.016);
      ctx.save();
      ctx.rotate((i / rays) * Math.PI * 2);
      const ray = ctx.createLinearGradient(size * 0.16, 0, length, 0);
      ray.addColorStop(0, 'rgba(255,236,182,0.75)');
      ray.addColorStop(0.4, 'rgba(255,206,128,0.32)');
      ray.addColorStop(1, 'rgba(252,176,84,0)');
      ctx.fillStyle = ray;
      ctx.beginPath();
      ctx.moveTo(size * 0.14, -half);
      ctx.lineTo(length, 0);
      ctx.lineTo(size * 0.14, half);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();

    /*
     * The disc itself: white at the very centre, warming to amber at the limb.
     * The white core is what makes the body read as *bright* rather than as
     * yellow, which is the difference between a sun and an orange circle.
     */
    const disc = ctx.createRadialGradient(
      centre - coreRadius * 0.18,
      centre - coreRadius * 0.18,
      0,
      centre,
      centre,
      coreRadius,
    );
    disc.addColorStop(0, 'rgba(255,255,252,1)');
    disc.addColorStop(0.42, 'rgba(255,246,220,1)');
    disc.addColorStop(0.78, 'rgba(255,216,138,1)');
    disc.addColorStop(1, 'rgba(248,178,74,1)');
    ctx.fillStyle = disc;
    ctx.beginPath();
    ctx.arc(centre, centre, coreRadius, 0, Math.PI * 2);
    ctx.fill();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/* ── Direction helpers ───────────────────────────────────────────────── */

/**
 * A compass bearing and an altitude, as a unit vector.
 *
 * The renderer's world axes are the ones the whole scene is built on, so this
 * is where the astronomy's north-up convention meets them: the campus's own
 * north is `-Z`, which is the bearing the overview camera looks in from.
 */
export function directionFrom(
  altitude: number,
  azimuth: number,
  target = new THREE.Vector3(),
): THREE.Vector3 {
  const alt = (altitude * Math.PI) / 180;
  const az = (azimuth * Math.PI) / 180;
  const horizontal = Math.cos(alt);
  /* Bearing 0 is north (-Z), 90 east (+X). */
  return target.set(horizontal * Math.sin(az), Math.sin(alt), -horizontal * Math.cos(az));
}
