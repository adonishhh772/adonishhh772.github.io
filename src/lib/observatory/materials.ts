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

export class Materials {
  /** The island's ground: vertex-coloured, so one mesh carries all four bands. */
  readonly terrain: THREE.MeshStandardMaterial;
  readonly stone: THREE.MeshStandardMaterial;
  readonly stoneDark: THREE.MeshStandardMaterial;
  readonly ceramic: THREE.MeshStandardMaterial;
  readonly rock: THREE.MeshStandardMaterial;
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
     */
    this.terrain = standard(0xffffff, 0.86, 0.02, { vertexColors: true, flatShading: true });

    /* Warm ceramic stone — the terraces and plinths. */
    this.stone = standard(theme.stone, 0.8, 0.03);
    this.stoneDark = standard(theme.stoneDeep, 0.88, 0.04);
    this.ceramic = standard(theme.ceramic, 0.62, 0.04);
    this.rock = standard(theme.stoneDeep, 0.95, 0.02, { flatShading: true });
    this.keel = standard(
      new THREE.Color(theme.stoneDeep).lerp(new THREE.Color(0x080d18), 0.5).getHex(),
      0.96,
      0.01,
      { flatShading: true },
    );
    this.grass = standard(theme.grass, 0.94, 0);
    this.foliage = standard(theme.moss, 0.92, 0, { flatShading: true });
    /* Lifted toward the sky colour so a mixed treeline separates into shape
       instead of collapsing into one dark mass at island distance. */
    this.foliageLight = standard(
      new THREE.Color(theme.grass).lerp(new THREE.Color(theme.skyHorizon), 0.26).getHex(),
      0.9,
      0,
      { flatShading: true },
    );

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

  /** A window material the world can hand to a new pane; tracked for disposal. */
  windowPanel(color: number, intensity: number): THREE.MeshStandardMaterial {
    const material = new THREE.MeshStandardMaterial({
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
