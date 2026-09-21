/**
 * Grass.
 *
 * The single largest visual difference between a terrain that reads as ground
 * and one that reads as a coloured surface. A slope with a grass *texture* on it
 * is a picture of grass; a slope with several thousand clumps standing on it
 * catches the light along a million small edges, moves when the wind does, and
 * breaks its own silhouette against everything behind it.
 *
 * Two decisions shaped this:
 *
 * **Cards, not blades.** A blade of grass is under a pixel wide at any distance
 * the camera can reach, so modelling one is pure cost. What actually reads is
 * the *clump*: three crossed cards carrying a drawn tuft, which is the standard
 * technique for a reason — the silhouette and the light-catching are what the
 * eye uses, and both survive on a card.
 *
 * **Wind in the vertex shader.** The clumps sway by displacing their tops in the
 * vertex shader from the clump's own world position, so there is no per-frame
 * work on the CPU, no per-instance matrix rewrite, and no limit on how much
 * grass there is. Gusts travel across the field because the phase is a function
 * of position, which is the detail that turns a uniform wobble into weather.
 *
 * The whole layer is one `InstancedMesh` per card variant — four draw calls for
 * the entire island.
 */

import * as THREE from 'three';
import type { QualitySettings } from './quality';
import type { TextureLibrary } from './textures';
import { grassClumpGeometry, mulberry32 } from './parts';
import { heightAt, normalAt, slopeAt } from './terrain';

/**
 * Where grass may and may not grow.
 *
 * A clump standing in the middle of a walkway or through the floor of the
 * workshop is worse than no grass at all, so the placement is filtered against
 * everything the campus has built. The bands are the four radii that matter:
 * inside the terraces, on the walkway ring, and along the avenue.
 */
export interface GrassBounds {
  /** Keep clear of these discs entirely. */
  exclusion: { x: number; z: number; radius: number }[];
  /** The radius beyond which the shelf turns to bare stone at the lip. */
  outerRadius: number;
  /** The radius inside which the observatory's own terrace sits. */
  innerRadius: number;
}

export interface GrassOptions {
  count: number;
  /** Size range of a clump, in world units. */
  minHeight: number;
  maxHeight: number;
  bounds: GrassBounds;
  seed?: number;
}

interface WindUniforms {
  time: { value: number };
  strength: { value: number };
  direction: { value: THREE.Vector2 };
  tint: { value: THREE.Color };
  sway: { value: number };
}

/**
 * Patch a material to bend grass in the wind.
 *
 * `onBeforeCompile` rather than a fully custom shader, so the clumps keep
 * three's own lighting, fog, shadow-receiving and tone mapping — all of which a
 * hand-written grass shader would have to reimplement, and all of which it would
 * reimplement *slightly differently* from every other object in the scene. Grass
 * that is lit differently from the ground it stands on is grass that looks
 * pasted on.
 */
function windify(material: THREE.Material, uniforms: WindUniforms): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWindTime = uniforms.time;
    shader.uniforms.uWindStrength = uniforms.strength;
    shader.uniforms.uWindDirection = uniforms.direction;
    shader.uniforms.uGrassTint = uniforms.tint;
    shader.uniforms.uSway = uniforms.sway;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        attribute float aBend;
        uniform float uWindTime;
        uniform float uWindStrength;
        uniform vec2 uWindDirection;
        uniform float uSway;
        `,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `
        #include <begin_vertex>

        /*
         * The clump's world position, before any of three's own instancing
         * transforms have been applied. Reading it here rather than from the
         * already-transformed vertex is deliberate: that one is in the
         * *instance's* local space, so every clump in the field would sway in
         * lockstep.
         */
        vec3 windOrigin = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);

        /*
         * A travelling gust. The phase depends on position, so a wave crosses
         * the field instead of the whole island breathing at once, and the two
         * terms at different frequencies keep it from looking like a sine.
         */
        float travel = dot(windOrigin.xz, uWindDirection) * 0.55;
        float gust =
          sin(uWindTime * 1.35 - travel) * 0.6 +
          sin(uWindTime * 0.47 - travel * 0.31) * 0.4;
        gust = gust * 0.5 + 0.5;

        /*
         * A stiffening breeze rather than a wobble: the gust is raised to a
         * power so the grass is mostly still and moves in gusts, which is what
         * wind actually does to a field.
         */
        float strength = uWindStrength * mix(0.28, 1.0, gust * gust);

        /*
         * Displacement grows with the square of the height up the card, so the
         * base stays planted. A card whose bottom edge moves is a card that has
         * come unstuck from the ground.
         */
        float bend = clamp(aBend, 0.0, 1.0);
        vec2 lean = uWindDirection * strength * bend * uSway;
        transformed.x += lean.x;
        transformed.z += lean.y;
        /* The tips dip as they lean, which is what keeps the clump's height
           honest under a strong gust. */
        transformed.y -= dot(lean, lean) * 0.6 * bend;
        `,
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `
        #include <color_fragment>
        diffuseColor.rgb *= uGrassTint;
        `,
      );
  };
  material.customProgramCacheKey = () => 'grass-wind';
}

export class GrassField {
  readonly group = new THREE.Group();

  private readonly materials: THREE.MeshStandardMaterial[] = [];
  private readonly uniforms: WindUniforms;
  private readonly meshes: THREE.InstancedMesh[] = [];
  private readonly disposables: (THREE.BufferGeometry | THREE.Material)[] = [];

  constructor(textures: TextureLibrary, quality: QualitySettings, options: GrassOptions) {
    this.group.name = 'grass';

    this.uniforms = {
      time: { value: 0 },
      strength: { value: 0.16 },
      direction: { value: new THREE.Vector2(0.86, 0.51) },
      tint: { value: new THREE.Color(0xffffff) },
      sway: { value: 0.24 },
    };

    /*
     * Sink the clump slightly into the ground. Grass that starts exactly at the
     * surface shows its own bottom edge on any slope, because the card is flat
     * and the ground is not.
     */
    const clump = this.track(grassClumpGeometry(1, 0.42));
    const random = mulberry32(options.seed ?? 4242);

    const variants = textures.grassCards.length || 1;
    const buckets: THREE.Matrix4[][] = Array.from({ length: variants }, () => []);

    let placed = 0;
    let attempts = 0;
    const maxAttempts = options.count * 6;

    while (placed < options.count && attempts < maxAttempts) {
      attempts++;
      /*
       * Sampled uniformly over the disc, not by radius and angle: picking a
       * radius uniformly puts most of the grass in the middle, because the area
       * at radius r grows with r. `sqrt` is the correction, and without it the
       * field thins out visibly toward the rim.
       */
      const angle = random() * Math.PI * 2;
      const radius =
        Math.sqrt(random()) * (options.bounds.outerRadius - options.bounds.innerRadius) +
        options.bounds.innerRadius;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;

      if (this.excluded(x, z, options.bounds)) continue;

      /*
       * Grass does not grow on a cliff. The slope test keeps the tufts off the
       * rock band at the lip and off the steep faces of the relief, and it is
       * measured from the same height field the island is built from so the two
       * cannot disagree.
       */
      if (slopeAt(x, z) > 0.42) continue;

      const height = THREE.MathUtils.lerp(options.minHeight, options.maxHeight, random());
      const width = height * (0.72 + random() * 0.5);
      const normal = normalAt(x, z, new THREE.Vector3());

      /*
       * The clump leans with the slope it is growing out of — but only about
       * a third of the way, because grass grows *upward* and a clump lying flat
       * on a hillside reads as combed hair. The remaining lean is random, so the
       * field is not a carpet of parallel strands.
       */
      const tilt = Math.acos(THREE.MathUtils.clamp(normal.y, -1, 1));
      const tiltBearing = Math.atan2(normal.z, normal.x);
      const quaternion = new THREE.Quaternion()
        .setFromAxisAngle(new THREE.Vector3(0, 1, 0), random() * Math.PI * 2)
        .multiply(
          new THREE.Quaternion().setFromAxisAngle(
            new THREE.Vector3(Math.cos(tiltBearing), 0, Math.sin(tiltBearing)),
            Math.min(tilt * 0.4, 0.5) + (random() - 0.5) * 0.18,
          ),
        );

      const matrix = new THREE.Matrix4().compose(
        new THREE.Vector3(x, heightAt(x, z) - height * 0.06, z),
        quaternion,
        new THREE.Vector3(width, height, width),
      );
      buckets[Math.floor(random() * variants)].push(matrix);
      placed++;
    }

    for (let variant = 0; variant < variants; variant++) {
      const matrices = buckets[variant];
      if (!matrices.length) continue;

      const material = this.trackMaterial(
        new THREE.MeshStandardMaterial({
          /*
           * Alpha testing rather than blending. Blended grass has to be sorted,
           * cannot be written to the depth buffer, and at this density produces
           * a milky haze where thousands of cards overlap. A hard cutoff costs a
           * slightly jagged edge that is invisible at a distance, and it is what
           * every game does.
           */
          map: textures.grassCards[variant],
          alphaTest: 0.42,
          transparent: false,
          side: THREE.DoubleSide,
          roughness: 0.92,
          metalness: 0,
        }),
      );
      windify(material, this.uniforms);

      const mesh = new THREE.InstancedMesh(clump, material, matrices.length);
      mesh.name = `grass-${variant}`;
      for (let i = 0; i < matrices.length; i++) mesh.setMatrixAt(i, matrices[i]);
      mesh.instanceMatrix.needsUpdate = true;
      /*
       * The clumps receive shadow but do not cast it. A shadow pass over
       * thousands of alpha-tested cards is the single most expensive thing this
       * scene could do, and the shadow a tuft casts is not what a visitor
       * notices about a hillside.
       */
      mesh.castShadow = false;
      mesh.receiveShadow = quality.shadows;
      mesh.frustumCulled = false;
      this.meshes.push(mesh);
      this.group.add(mesh);
    }
  }

  private excluded(x: number, z: number, bounds: GrassBounds): boolean {
    const radius = Math.hypot(x, z);
    if (radius < bounds.innerRadius) return true;
    if (radius > bounds.outerRadius) return true;
    for (let i = 0; i < bounds.exclusion.length; i++) {
      const spot = bounds.exclusion[i];
      if (Math.hypot(x - spot.x, z - spot.z) < spot.radius) return true;
    }
    return false;
  }

  private track<T extends THREE.BufferGeometry | THREE.Material>(item: T): T {
    this.disposables.push(item);
    return item;
  }

  private trackMaterial(material: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
    this.materials.push(material);
    this.disposables.push(material);
    return material;
  }

  /**
   * Run the wind.
   *
   * One uniform write per frame for the whole field, which is the entire cost of
   * animating it. `strength` is left alone by the caller so a still day and a
   * gale are a matter of one number.
   */
  update(time: number, strengthScale = 1): void {
    this.uniforms.time.value = time;
    this.uniforms.strength.value = 0.16 * strengthScale;
  }

  /** Recolour the grass with the current light. */
  setTint(color: number, brightness = 1): void {
    this.uniforms.tint.value.setHex(color).multiplyScalar(brightness);
  }

  dispose(): void {
    for (const item of this.disposables) item.dispose();
    this.disposables.length = 0;
    this.materials.length = 0;
    this.meshes.length = 0;
    this.group.clear();
  }
}
