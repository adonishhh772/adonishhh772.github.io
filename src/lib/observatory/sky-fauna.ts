/**
 * Sky traffic — airliners and jets on horizontal lanes (no trails).
 */

import * as THREE from 'three';
import { mulberry32 } from './parts';
import { airplaneSkyTexture, jetSkyTexture } from './sky-fauna-textures';

export type SkyFaunaKind = 'airplane' | 'jet';

export const SKY_FAUNA_CRAFT_POOL = 4;

export interface SkyFaunaAgent {
  root: THREE.Group;
  sprite: THREE.Sprite;
  kind: SkyFaunaKind;
  orbitSpeed: number;
  bobPhase: number;
  baseScaleX: number;
  baseScaleY: number;
  transitStart: THREE.Vector3;
  transitEnd: THREE.Vector3;
  transitT: number;
}

function makeSprite(
  map: THREE.Texture,
  scaleX: number,
  scaleY: number,
): { root: THREE.Group; sprite: THREE.Sprite } {
  const root = new THREE.Group();
  const spriteMaterial = new THREE.SpriteMaterial({
    map,
    transparent: true,
    depthWrite: false,
    fog: false,
    depthTest: true,
    alphaTest: 0.04,
    opacity: 1,
  });
  const sprite = new THREE.Sprite(spriteMaterial);
  sprite.scale.set(scaleX, scaleY, 1);
  sprite.renderOrder = 16;
  root.add(sprite);
  return { root, sprite };
}

export interface SkyFaunaTextureSet {
  airplane: THREE.Texture;
  jet: THREE.Texture;
}

export function createSkyFaunaTextureSet(): SkyFaunaTextureSet {
  return {
    airplane: airplaneSkyTexture(),
    jet: jetSkyTexture(),
  };
}

export function createSkyFaunaAgents(options: {
  craftCount: number;
  textures: SkyFaunaTextureSet;
  seed: number;
}): SkyFaunaAgent[] {
  const random = mulberry32(options.seed);
  const agents: SkyFaunaAgent[] = [];
  const craftToBuild = Math.min(SKY_FAUNA_CRAFT_POOL, Math.max(options.craftCount, 0));

  for (let index = 0; index < craftToBuild; index += 1) {
    const kind: SkyFaunaKind = index % 2 === 0 ? 'airplane' : 'jet';
    const scale = 4.2 + random() * 1.2;
    const aspect = kind === 'jet' ? 0.32 : 0.3;
    const map = kind === 'jet' ? options.textures.jet : options.textures.airplane;

    const built = makeSprite(map, scale, scale * aspect);
    built.root.name = `sky-${kind}`;

    const altitude = 38 + (index % 2) * 6 + random() * 2;
    const laneZ = -28 + index * 18 + random() * 6;
    const eastbound = index % 2 === 0;
    const x0 = eastbound ? -94 - random() * 6 : 94 + random() * 6;
    const x1 = eastbound ? 94 + random() * 6 : -94 - random() * 6;

    agents.push({
      root: built.root,
      sprite: built.sprite,
      kind,
      orbitSpeed: 0.011 + random() * 0.006,
      bobPhase: random() * Math.PI * 2,
      baseScaleX: scale,
      baseScaleY: scale * aspect,
      transitStart: new THREE.Vector3(x0, altitude, laneZ),
      transitEnd: new THREE.Vector3(x1, altitude, laneZ),
      transitT: random(),
    });
  }

  return agents;
}

function stepHorizontal(agent: SkyFaunaAgent, step: number): void {
  agent.transitT = (agent.transitT + agent.orbitSpeed * step) % 1;
  agent.root.position.lerpVectors(agent.transitStart, agent.transitEnd, agent.transitT);

  const dx = agent.transitEnd.x - agent.transitStart.x;
  const heading = dx >= 0 ? Math.PI / 2 : -Math.PI / 2;
  agent.root.rotation.set(0, heading, 0);
}

export function stepSkyFauna(
  agents: SkyFaunaAgent[],
  _textures: SkyFaunaTextureSet,
  time: number,
  step: number,
): void {
  for (const agent of agents) {
    if (!agent.root.visible) continue;
    stepHorizontal(agent, step);
    const pulse = 1 + Math.sin(time * 2.2 + agent.bobPhase) * 0.008;
    agent.sprite.scale.set(agent.baseScaleX * pulse, agent.baseScaleY * pulse, 1);
  }
}

export function disposeSkyFaunaTextures(textures: SkyFaunaTextureSet): void {
  textures.airplane.dispose();
  textures.jet.dispose();
}
