/**
 * Material library for the observatory.
 *
 * One set of materials, themed by recolouring in place. Nothing is created
 * per frame and nothing is duplicated per station, so a theme switch costs
 * a handful of property writes rather than a rebuild.
 */

import * as THREE from 'three';
import type { QualitySettings } from './quality';
import type { WorldTheme } from './theme';

export class Materials {
  readonly stone: THREE.MeshStandardMaterial;
  readonly stoneDark: THREE.MeshStandardMaterial;
  readonly ceramic: THREE.MeshStandardMaterial;
  readonly rock: THREE.MeshStandardMaterial;
  readonly grass: THREE.MeshStandardMaterial;
  readonly foliage: THREE.MeshStandardMaterial;
  readonly metal: THREE.MeshStandardMaterial;
  readonly metalDark: THREE.MeshStandardMaterial;
  readonly glass: THREE.MeshStandardMaterial;
  readonly signal: THREE.MeshStandardMaterial;
  readonly practical: THREE.MeshStandardMaterial;
  readonly lamp: THREE.MeshStandardMaterial;
  readonly marker: THREE.MeshStandardMaterial;
  readonly portrait: THREE.MeshStandardMaterial;
  readonly paper: THREE.MeshStandardMaterial;
  readonly hill: THREE.MeshBasicMaterial;
  readonly mist: THREE.MeshBasicMaterial;

  private readonly all: THREE.Material[] = [];
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

    /* Warm ceramic stone — the island, terraces and plinths. */
    this.stone = standard(theme.stone, 0.82, 0.02, { flatShading: false });
    this.stoneDark = standard(theme.stoneDeep, 0.88, 0.03);
    this.ceramic = standard(theme.ceramic, 0.68, 0.03);
    this.rock = standard(theme.stoneDeep, 0.96, 0.01, { flatShading: true });
    this.grass = standard(theme.grass, 0.95, 0);
    this.foliage = standard(theme.grass, 0.9, 0, { flatShading: true });

    /* Deep navy metal for structure and instruments. */
    this.metal = standard(theme.metal, 0.34, 0.62);
    this.metalDark = standard(0x0a1020, 0.42, 0.5);

    /* Smoked glass — used sparingly, on vitrines and lamps only. */
    this.glass = standard(0x0d1729, 0.12, 0.08, {
      transparent: true,
      opacity: 0.42,
      side: THREE.DoubleSide,
    });

    /* Emissive accents. */
    this.signal = standard(0x061418, 0.35, 0.1, {
      emissive: new THREE.Color(theme.signal),
      emissiveIntensity: 1.1,
    });
    this.practical = standard(0x140d04, 0.5, 0.05, {
      emissive: new THREE.Color(theme.practical),
      emissiveIntensity: 0.9,
    });
    this.lamp = standard(0x1a1206, 0.4, 0, {
      emissive: new THREE.Color(theme.practical),
      emissiveIntensity: 1.6,
    });
    this.marker = new THREE.MeshStandardMaterial({
      color: 0x2a1b06,
      roughness: 0.25,
      metalness: 0.1,
      emissive: new THREE.Color(theme.practical),
      emissiveIntensity: 1.1,
      transparent: true,
      opacity: 0.95,
    });
    this.all.push(this.marker);

    /* The real portrait, shown on the studio wall. Starts as a plain panel
       and gains its map once the photograph has loaded. */
    this.portrait = standard(theme.stone, 0.85, 0);
    this.paper = standard(0xffffff, 0.75, 0);

    /* Distant hills are painted, not lit — they exist for silhouette. Their
       colour comes entirely from per-instance colours, so the base is white
       and fog is off (see World.buildLandscape). */
    this.hill = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      fog: false,
    });
    this.all.push(this.hill);

    this.mist = new THREE.MeshBasicMaterial({
      color: theme.mist,
      transparent: true,
      opacity: theme.name === 'light' ? 0.5 : 0.4,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.all.push(this.mist);

    this.setTheme(theme);
    this.setQuality(quality);
  }

  setTheme(theme: WorldTheme): void {
    const day = THREE.MathUtils.clamp(theme.dayness, 0, 1);
    this.stone.color.setHex(theme.stone);
    this.stoneDark.color.setHex(theme.stoneDeep);
    this.ceramic.color.setHex(theme.ceramic);
    this.rock.color.setHex(theme.stoneDeep);
    this.grass.color.setHex(theme.grass);
    this.foliage.color.setHex(theme.grass);
    this.metal.color.setHex(theme.metal);
    this.hill.color.setHex(0xffffff);
    this.mist.color.setHex(theme.mist);
    this.mist.opacity = 0.18 + day * 0.08;

    this.signal.emissive.setHex(theme.signal);
    this.signal.emissiveIntensity = theme.emissive;
    this.practical.emissive.setHex(theme.practical);
    this.practical.emissiveIntensity = theme.emissive * 0.8;
    /* Lamps and lit windows are visibly switched off by day. */
    this.lamp.emissive.setHex(theme.practical);
    this.lamp.emissiveIntensity = 1.6 - day * 1.15;
    /* Paper and the portrait frame sit just above the stone in both themes. */
    this.paper.color.setHex(theme.stone).lerp(new THREE.Color(0xffffff), 0.5);
    if (!this.portrait.map) this.portrait.color.setHex(theme.stone);

    this.marker.emissive.setHex(theme.practical);
    this.marker.emissiveIntensity = 1.2 - day * 0.45;

    /* Stone reads brighter by daylight; the key light does the rest. */
    this.stone.roughness = 0.8 + day * 0.08;
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
  }
}
