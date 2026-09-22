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
 * A dark-sky star field, as points rather than as a painted map.
 *
 * This started as an equirectangular canvas mapped onto the dome, and it was
 * wrong in a way that only shows up on a screen: a star drawn as a radial
 * gradient eight texels wide on a 2048-texel map is one and a half degrees of
 * sky, which is a *blob*. Every star in the night sky was a soft grey smudge
 * twenty-odd pixels across, and the brightest were worse. A star map is the
 * right structure for a star *chart* and the wrong one for a sky.
 *
 * Points have no such problem. Each star is a sprite of a fixed angular size on
 * screen whatever the camera is doing, so it stays a point when the visitor
 * zooms and does not shimmer when the field turns. Everything that makes a
 * starfield readable is per-star data instead of brushwork: magnitude decides
 * the size *and* the brightness, the colour index runs blue-white through
 * amber, and the brightest few get a faint four-point flare — which is a lens
 * artefact rather than a property of the star, but it is what the eye reads as
 * "bright".
 *
 * The distribution is the same simple galactic model as before: a sprinkle plus
 * a heavy concentration along a tilted great circle, so the Milky Way is a band
 * rather than an average. A fraction of those band stars are drawn as a wide,
 * very faint haze, which is what the unaided eye actually sees there.
 */
export function starGeometry(seed = 20260913, count = 8000): THREE.BufferGeometry {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const phases = new Float32Array(count);
  const flares = new Float32Array(count);

  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  /* The galactic plane: a great circle inclined to the celestial equator. */
  const planeTilt = 62 * (Math.PI / 180);
  const planeNormal = new THREE.Vector3(Math.sin(planeTilt), Math.cos(planeTilt), 0).normalize();
  const direction = new THREE.Vector3();

  for (let i = 0; i < count; i++) {
    /*
     * Two thirds of the stars are drawn toward the galactic plane. Sampling the
     * gap-to-plane with a power curve concentrates them without producing the
     * hard edge a rejection test would.
     */
    const inPlane = random() < 0.66;
    const azimuth = random() * Math.PI * 2;
    const declination = inPlane
      ? Math.asin(Math.max(-1, Math.min(1, (random() * 2 - 1) * Math.pow(random(), 0.6))))
      : Math.acos(1 - 2 * random()) - Math.PI / 2;

    direction.set(
      Math.cos(declination) * Math.cos(azimuth),
      Math.sin(declination),
      Math.cos(declination) * Math.sin(azimuth),
    );

    /*
     * Stars that fell well outside the band when they were meant to be in it
     * are pushed back onto it rather than dropped, so a rejection never leaves
     * a hole in the count.
     */
    if (inPlane) {
      const gap = direction.dot(planeNormal);
      if (Math.abs(gap) > 0.24) direction.addScaledVector(planeNormal, -gap * 0.85).normalize();
    }

    positions[i * 3] = direction.x;
    positions[i * 3 + 1] = direction.y;
    positions[i * 3 + 2] = direction.z;

    /*
     * Magnitude: `random()^4` gives many faint stars and a handful of
     * dominating ones. A field of equally bright dots is the single most common
     * giveaway of a procedural starfield, so the exponent matters more than the
     * count does.
     */
    const magnitude = Math.pow(random(), 4);
    const brightness = 0.34 + magnitude * 0.8;

    /* Colour index: cool blue-white through white to warm amber. */
    const warmth = Math.pow(random(), 2) * (random() < 0.5 ? -1 : 1);
    const r = Math.min(1, 1 + warmth * 0.2) * brightness;
    const g = Math.min(1, 1 - Math.abs(warmth) * 0.06) * brightness;
    const b = Math.min(1, 1 - warmth * 0.24) * brightness;
    colors[i * 3] = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = b;

    /*
     * Size in CSS pixels on screen, which is the whole point of drawing these
     * as points: a first-magnitude star is a hard point two or three pixels
     * across however far away the camera is, and a faint one is a single pixel.
     *
     * Nothing here is drawn wide. An earlier version added a "galactic haze" of
     * very large, very faint sprites to suggest the Milky Way, and at any size
     * that could be rendered without costing a frame it read as exactly what it
     * was: a scatter of small grey smudges. The band is carried by the
     * *density* of stars instead, which is what it actually is.
     */
    sizes[i] = 0.9 + magnitude * 2.4 + (random() < 0.06 ? 0.6 : 0);

    /* Scintillation: a tiny, slow difference between one star and the next. */
    phases[i] = random();
    /* Only the brightest handful get a flare; a sky of crosses is a cartoon. */
    flares[i] = magnitude > 0.62 ? 1 : 0;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  geometry.setAttribute('aFlare', new THREE.BufferAttribute(flares, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
  return geometry;
}

export interface StarUniforms {
  opacity: { value: number };
  tint: { value: THREE.Color };
  time: { value: number };
  /** Device pixels per CSS pixel, so a star is the same size on any screen. */
  pixelScale: { value: number };
}

/**
 * The star shader.
 *
 * Additive, and unmoved by depth: the field hangs beyond everything and must
 * never be occluded by the island's own ridge. A star is a point source, so its
 * profile is a tight Gaussian core with a very small halo — a wide falloff here
 * is what turns a star back into the smudge this replaced.
 */
export function starMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      opacity: { value: 0 },
      tint: { value: new THREE.Color(0xffffff) },
      time: { value: 0 },
      pixelScale: { value: 1 },
    } as unknown as Record<string, THREE.IUniform>,
    vertexShader: /* glsl */ `
      attribute vec3 aColor;
      attribute float aSize;
      attribute float aPhase;
      attribute float aFlare;

      uniform float opacity;
      uniform float time;
      uniform float pixelScale;

      varying vec3 vColor;
      varying float vBrightness;
      varying float vFlare;
      varying float vPhase;

      void main() {
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * viewPosition;

        /*
         * A fixed size on screen rather than a size in the world. Scintillation
         * is folded in here as well as in the fragment stage so a twinkling star
         * breathes rather than merely brightens.
         */
        vPhase = aPhase;
        float twinkle = 1.0 + 0.16 * sin(time * (0.7 + aPhase * 1.4) + aPhase * 6.2831853);
        /*
         * Half the sphere is below the island. The field is turned by the
         * sidereal angle every frame, so "which way is down" has to be asked of
         * the world matrix rather than of the vertex itself.
         */
        float above = smoothstep(0.05, 0.16, normalize(mat3(modelMatrix) * position).y);
        vBrightness = opacity * above;
        vFlare = aFlare;
        vColor = aColor;

        float flare = aFlare > 0.5 ? 1.35 : 1.0;
        gl_PointSize = max(1.0, aSize * pixelScale * flare * twinkle);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;

      uniform vec3 tint;
      uniform float time;

      varying vec3 vColor;
      varying float vBrightness;
      varying float vFlare;
      varying float vPhase;

      void main() {
        vec2 point = gl_PointCoord * 2.0 - 1.0;
        float distance = length(point);
        if (distance > 1.0) discard;

        /*
         * The profile: a solid core out to about a third of the sprite, a sharp
         * Gaussian halo outside it, and nothing at the edge — so a star is a
         * point of light rather than a disc with a visible rim.
         */
        float core = smoothstep(0.5, 0.12, distance);
        float halo = exp(-distance * distance * 9.0) * 0.42;
        float profile = core + halo;

        /*
         * A four-point flare on the brightest few, drawn as two thin, tapering
         * lines. It is a lens artefact, and it is the thing that reads as
         * "bright" in a sky where nothing else can be.
         */
        if (vFlare > 0.5) {
          float horizontal =
            max(0.0, 1.0 - abs(point.x) * 5.0) * max(0.0, 1.0 - abs(point.y) * 1.9);
          float vertical =
            max(0.0, 1.0 - abs(point.y) * 5.0) * max(0.0, 1.0 - abs(point.x) * 1.9);
          profile += pow(horizontal + vertical, 2.2) * 0.5;
        }

        float twinkle = 1.0 + 0.16 * sin(time * (0.7 + vPhase * 1.4) + vPhase * 6.2831853);
        if (vBrightness < 0.02) {
          discard;
        }
        /*
         * The gain is what makes a star *bright* rather than merely present.
         * Everything upstream of here is a fraction — of a colour index, of a
         * magnitude, of a night exposure — and the product of three fractions
         * is a grey dot. This is the one place the field is allowed to be
         * brighter than the sky it is drawn on, and it is why the brightest
         * stars read as points of light rather than as pale specks.
         */
        gl_FragColor = vec4(vColor * tint * profile * vBrightness * twinkle * 2.6, 1.0);

        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    fog: false,
    blending: THREE.AdditiveBlending,
    toneMapped: true,
  });
}

/** The axis the star field turns about, and by how much per sidereal angle. */
export const STAR_POLE_AXIS = new THREE.Vector3(Math.sqrt(1 - 0.72 * 0.72), 0.72, 0).normalize();

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
  const radius = size * 0.38;

  if (ctx) {
    ctx.clearRect(0, 0, size, size);

    /*
     * A nimbus, so the moon is not a disc pasted onto the sky.
     *
     * The gradient has to reach zero *inside* the canvas, which the first
     * version of this did not do: its outer radius was 0.816 of the sprite, so
     * the falloff was still at five percent opacity where the canvas ended, and
     * the cut-off drew a visible square around the moon. The fix is an outer
     * radius of exactly half the sprite — the last stop is fully transparent, so
     * everything past it, corners included, is nothing at all.
     */
    const nimbus = ctx.createRadialGradient(
      centre,
      centre,
      radius * 0.88,
      centre,
      centre,
      size * 0.46,
    );
    nimbus.addColorStop(0, 'rgba(206,220,246,0.34)');
    nimbus.addColorStop(0.45, 'rgba(190,206,238,0.11)');
    nimbus.addColorStop(0.82, 'rgba(180,198,232,0.012)');
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
       * Earthshine, drawn before the lit side so the two never fight: the whole
       * disc at a fraction of full opacity. Without it a crescent is a bright
       * sliver floating beside nothing, and the moon stops reading as a *body*
       * — which is most of what the unaided eye actually sees at dusk.
       */
      ctx.save();
      ctx.globalAlpha = 0.1;
      ctx.beginPath();
      ctx.arc(centre, centre, radius, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(surface, 0, 0);
      ctx.restore();

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
