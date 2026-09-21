/**
 * Material library for the observatory.
 *
 * One set of materials, themed by recolouring in place. Nothing is created
 * per frame and nothing is duplicated per station, so a theme switch costs a
 * handful of property writes rather than a rebuild.
 *
 * Everything here is a single-sided `MeshStandardMaterial` with a roughness
 * that suits a miniature: stone is matte, metal is not, glazing is smooth and
 * slightly transparent. Nothing leans on `DoubleSide` to hide a hole, because
 * there are no holes — the island is a closed body and every panel has a face
 * pointing the way it is looked at from.
 */

import * as THREE from 'three';
import type { QualitySettings } from './quality';
import type { WorldTheme } from './theme';
import type { TextureLibrary } from './textures';

export class Materials {
  /** The island's ground: vertex-coloured, so one mesh carries all four bands. */
  readonly terrain: THREE.MeshStandardMaterial;
  readonly stone: THREE.MeshStandardMaterial;
  readonly stoneDark: THREE.MeshStandardMaterial;
  readonly ceramic: THREE.MeshStandardMaterial;
  readonly rock: THREE.MeshStandardMaterial;
  /** Tree trunks and limbs. */
  readonly bark: THREE.MeshStandardMaterial;
  /**
   * The island's underside. The same stone pushed well toward shadow, so the
   * island reads as a lit plateau over a dark rock keel instead of one pale
   * mass all the way down.
   */
  readonly keel: THREE.MeshStandardMaterial;
  readonly grass: THREE.MeshStandardMaterial;
  readonly foliage: THREE.MeshStandardMaterial;
  /** A lighter crown for the rounded species, so a treeline has depth. */
  readonly foliageLight: THREE.MeshStandardMaterial;
  readonly metal: THREE.MeshStandardMaterial;
  readonly metalDark: THREE.MeshStandardMaterial;
  readonly glass: THREE.MeshStandardMaterial;
  readonly signal: THREE.MeshStandardMaterial;
  readonly practical: THREE.MeshStandardMaterial;
  /** The warm light behind a window. */
  readonly window: THREE.MeshStandardMaterial;
  readonly lamp: THREE.MeshStandardMaterial;
  readonly marker: THREE.MeshStandardMaterial;
  readonly portrait: THREE.MeshStandardMaterial;
  readonly paper: THREE.MeshStandardMaterial;
  readonly hill: THREE.MeshBasicMaterial;
  readonly mist: THREE.MeshBasicMaterial;
  readonly cloud: THREE.MeshBasicMaterial;

  private readonly all: THREE.Material[] = [];
  private readonly windowPanels: THREE.MeshStandardMaterial[] = [];
  private quality: QualitySettings | null = null;

  constructor(theme: WorldTheme, quality: QualitySettings) {
    const standard = (
      color: number,
      roughness: number,
      metalness: number,
      extra: THREE.MeshStandardMaterialParameters = {},
    ) => {
      const material = new THREE.MeshStandardMaterial({
        color,
        roughness,
        metalness,
        ...extra,
      });
      this.all.push(material);
      return material;
    };

    /*
     * The ground.
     *
     * One mesh, one material, and the band colours baked into a vertex
     * attribute — grass over the shelf, bare stone in patches, dry ground at
     * the lip, dark rock down the cliff. Painting it per vertex rather than
     * per mesh is what makes the transition between ground and rock follow the
     * landform instead of a ring of separate objects.
     *
     * Smooth-shaded, with a normal map: the vertex colours carry the *large*
     * scale variation and the map carries everything finer than a vertex. Flat
     * shading here would throw the normal map away and declare every triangle a
     * facet, which is precisely the look this is replacing.
     */
    this.terrain = standard(0xffffff, 0.86, 0.02, { vertexColors: true });

    /* Warm ceramic stone — the terraces and plinths. */
    this.stone = standard(theme.stone, 0.8, 0.03);
    this.stoneDark = standard(theme.stoneDeep, 0.88, 0.04);
    this.ceramic = standard(theme.ceramic, 0.62, 0.04);
    /* Broken rock. Smooth-shaded, because its surface is a normal map. */
    this.rock = standard(theme.stoneDeep, 0.95, 0.02);
    this.keel = standard(
      new THREE.Color(theme.stoneDeep).lerp(new THREE.Color(0x080d18), 0.5).getHex(),
      0.96,
      0.01,
    );
    this.grass = standard(theme.grass, 0.94, 0);
    this.foliage = standard(theme.moss, 0.92, 0);
    /* Lifted toward the sky colour so a mixed treeline separates into shape
       instead of collapsing into one dark mass at island distance. */
    this.foliageLight = standard(
      new THREE.Color(theme.grass).lerp(new THREE.Color(theme.skyHorizon), 0.26).getHex(),
      0.9,
      0,
    );
    /* Bark: rough, matte, and mapped. */
    this.bark = standard(theme.bark, 0.95, 0);

    /* Deep navy metal for structure and instruments. */
    this.metal = standard(theme.metal, 0.33, 0.6);
    this.metalDark = standard(
      new THREE.Color(theme.metal).lerp(new THREE.Color(0x05080f), 0.55).getHex(),
      0.4,
      0.52,
    );

    /*
     * Glazing. Smooth and faintly reflective, with a touch of transparency so
     * a shelf of books shows through the library's front — but not so much
     * that the interior has to be modelled to look right.
     */
    this.glass = standard(theme.glass, 0.14, 0.22, {
      transparent: true,
      opacity: 0.58,
    });

    /* Emissive accents. */
    this.signal = standard(0x061418, 0.34, 0.12, {
      emissive: new THREE.Color(theme.signal),
      emissiveIntensity: 1.15,
    });
    this.practical = standard(0x140d04, 0.5, 0.06, {
      emissive: new THREE.Color(theme.practical),
      emissiveIntensity: 1,
    });
    this.window = standard(0x1a1206, 0.42, 0.05, {
      emissive: new THREE.Color(theme.window),
      emissiveIntensity: 1.5,
    });
    this.windowPanels.push(this.window);
    this.lamp = standard(0x1a1206, 0.38, 0, {
      emissive: new THREE.Color(theme.window),
      emissiveIntensity: 1.8,
    });
    this.marker = new THREE.MeshStandardMaterial({
      color: 0x2a1b06,
      roughness: 0.25,
      metalness: 0.1,
      emissive: new THREE.Color(theme.window),
      emissiveIntensity: 1.15,
      transparent: true,
      opacity: 0.95,
    });
    this.all.push(this.marker);

    /* The real portrait, shown on the studio wall. Starts as a plain panel
       and gains its map once the photograph has loaded. */
    this.portrait = standard(theme.stone, 0.85, 0);
    this.paper = standard(0xffffff, 0.75, 0);

    /* Distant ridges are painted, not lit — they exist for silhouette. Their
       colour comes entirely from per-instance colours, so the base is white.
       Fog is on: it is what keeps them reading as distance rather than as
       black cut-outs pasted behind the island. */
    this.hill = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      fog: true,
    });
    this.all.push(this.hill);

    this.mist = new THREE.MeshBasicMaterial({
      color: theme.mist,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      fog: false,
    });
    this.all.push(this.mist);

    /* Clouds are painted rather than lit, for the same reason: a lit cloud in
       a scene with one shadow-casting key light turns into a grey polygon. */
    this.cloud = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      fog: false,
    });
    this.all.push(this.cloud);

    this.setTheme(theme);
    this.setQuality(quality);
  }

  /**
   * Attach the generated PBR maps.
   *
   * The maps are *detail*, not colour: the material's own colour still comes
   * from the theme, and the map is multiplied over it. That ordering is what
   * lets one set of greyscale-ish albedo textures serve both the day and the
   * night palette without a second download — and it is why the albedo maps here
   * are built around mid-grey rather than around a finished colour.
   *
   * The normal maps are what actually carry the realism. A `MeshStandardMaterial`
   * with a roughness and a colour is a smooth surface with a tint; the normal
   * map is what gives it a *surface* — a grain, a crack, a direction — and it is
   * most of the difference between the flat render this replaces and a credible
   * one.
   */
  setTextures(textures: TextureLibrary): void {
    /*
     * Ground: the map already carries a seven-unit tile, and this tightens it
     * further. The island is twenty-eight units across, so a seven-unit tile
     * gives four repetitions across the whole shelf — enough for the *large*
     * scale to read, and far too little for the fine one. A little over three
     * units per tile is where the tuft grain in the map stops being a smudge
     * at the overview distance and starts being texture.
     */
    this.terrain.map = textures.ground.map;
    this.terrain.normalMap = textures.ground.normalMap;
    this.terrain.roughnessMap = textures.ground.roughnessMap;
    this.terrain.normalScale.set(1.15, 1.15);
    for (const map of [
      this.terrain.map,
      this.terrain.normalMap,
      this.terrain.roughnessMap,
    ]) {
      map.repeat.set(2.2, 2.2);
      map.needsUpdate = true;
    }

    /* Broken rock and the raw keel share a surface: they are the same stone. */
    for (const material of [this.rock, this.keel]) {
      material.map = textures.rock.map;
      material.normalMap = textures.rock.normalMap;
      material.roughnessMap = textures.rock.roughnessMap;
      material.normalScale.set(1.1, 1.1);
    }

    /* Dressed stone, for everything the campus is built out of. */
    for (const material of [this.stone, this.stoneDark, this.ceramic]) {
      material.map = textures.stone.map;
      material.normalMap = textures.stone.normalMap;
      material.roughnessMap = textures.stone.roughnessMap;
      material.normalScale.set(0.5, 0.5);
    }

    this.bark.map = textures.bark.map;
    this.bark.normalMap = textures.bark.normalMap;
    this.bark.roughnessMap = textures.bark.roughnessMap;
    this.bark.normalScale.set(1.0, 1.0);

    for (const material of [
      this.terrain,
      this.rock,
      this.keel,
      this.stone,
      this.stoneDark,
      this.ceramic,
      this.bark,
    ]) {
      material.needsUpdate = true;
    }
  }

  /** A window material the world can hand to a new pane; tracked for disposal. */
  windowPanel(color: number, intensity: number): THREE.MeshStandardMaterial {    const material = new THREE.MeshStandardMaterial({
      color: 0x1a1206,
      roughness: 0.45,
      metalness: 0.05,
      emissive: new THREE.Color(color),
      emissiveIntensity: intensity,
    });
    this.all.push(material);
    this.windowPanels.push(material);
    return material;
  }

  setTheme(theme: WorldTheme): void {
    const day = THREE.MathUtils.clamp(theme.dayness, 0, 1);
    this.stone.color.setHex(theme.stone);
    this.stoneDark.color.setHex(theme.stoneDeep);
    this.ceramic.color.setHex(theme.ceramic);
    this.rock.color.setHex(theme.stoneDeep);
    this.keel.color.setHex(theme.stoneDeep).lerp(new THREE.Color(0x080d18), 0.5);
    this.grass.color.setHex(theme.grass);
    this.foliage.color.setHex(theme.moss);
    this.foliageLight.color.setHex(theme.grass).lerp(new THREE.Color(theme.skyHorizon), 0.26);
    this.bark.color.setHex(theme.bark);
    this.metal.color.setHex(theme.metal);
    this.metalDark.color.setHex(theme.metal).lerp(new THREE.Color(0x05080f), 0.55);
    this.glass.color.setHex(theme.glass);
    this.hill.color.setHex(0xffffff);
    this.mist.color.setHex(theme.mist);
    this.mist.opacity = 0.22 + day * 0.1;
    this.cloud.color.setHex(theme.snow);
    this.cloud.opacity = 0.34 + (1 - day) * 0.12;

    this.signal.emissive.setHex(theme.signal);
    this.signal.emissiveIntensity = theme.emissive;
    this.practical.emissive.setHex(theme.practical);
    this.practical.emissiveIntensity = theme.emissive * 0.85;

    /*
     * Windows are the one light that never goes out entirely: by day they are
     * a warm tint in the glazing, by night they are the thing that tells you
     * the buildings are inhabited. The band between the two is deliberately
     * narrow so dusk reads as the lamps coming on.
     */
    const lit = 0.28 + (1 - day) * 1.5;
    for (const panel of this.windowPanels) {
      panel.emissive.setHex(theme.window);
      panel.emissiveIntensity = lit;
    }
    this.lamp.emissive.setHex(theme.window);
    this.lamp.emissiveIntensity = 0.5 + (1 - day) * 1.6;

    /* Paper and the portrait frame sit just above the stone in both themes. */
    this.paper.color.setHex(theme.stone).lerp(new THREE.Color(0xffffff), 0.55);
    if (!this.portrait.map) this.portrait.color.setHex(theme.stone);

    this.marker.emissive.setHex(theme.window);
    this.marker.emissiveIntensity = 1.3 - day * 0.4;

    /* Stone reads brighter by daylight; the key light does the rest. */
    this.stone.roughness = 0.78 + day * 0.1;
    this.ceramic.roughness = 0.6 + day * 0.06;
  }

  /** Attach the portrait photograph to the studio's frame. */
  loadPortrait(url: string): void {
    if (!url) return;
    new THREE.TextureLoader().load(
      url,
      (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        this.portrait.map = texture;
        this.portrait.color.setHex(0xffffff);
        this.portrait.needsUpdate = true;
      },
      undefined,
      () => {
        /* Missing image: the frame simply stays a plain panel. */
      },
    );
  }

  setQuality(quality: QualitySettings): void {
    this.quality = quality;
  }

  get current(): QualitySettings | null {
    return this.quality;
  }

  dispose(): void {
    for (const material of this.all) material.dispose();
    this.all.length = 0;
    this.windowPanels.length = 0;
  }
}
