/**
 * Camera rig.
 *
 * A shot is a composed viewpoint: position, look-at target and field of
 * view. Travel between shots is eased over ~900ms and always interruptible.
 * Orbit offsets are applied on top of the current shot, clamped tightly so
 * exploration can never lose the island.
 */

import * as THREE from 'three';
import type { Shot } from './world';

const MIN_TRAVEL = 0.7;
const MAX_TRAVEL = 1.1;
const AZIMUTH_LIMIT = 0.72;
const POLAR_LIMIT = 0.38;
const MIN_POLAR = 0.24;
const MAX_POLAR = 1.42;
const MIN_HEIGHT = 2.4;

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

export interface TravelOptions {
  /** Skip the animation entirely (reduced motion, first frame). */
  immediate?: boolean;
}

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;

  private base: Shot;
  private from: Shot;
  private to: Shot;
  private travel = 1;
  private duration: number;
  private orbitAzimuth = 0;
  private orbitPolar = 0;
  private targetAzimuth = 0;
  private targetPolar = 0;
  private readonly offset = new THREE.Vector3();
  private readonly spherical = new THREE.Spherical();
  private readonly position = new THREE.Vector3();

  constructor(aspect: number, home: Shot, reducedMotion: boolean) {
    this.camera = new THREE.PerspectiveCamera(home.fov, aspect, 0.5, 900);
    this.camera.position.copy(home.position);
    this.base = cloneShot(home);
    this.from = cloneShot(home);
    this.to = cloneShot(home);
    this.reducedMotion = reducedMotion;
    this.duration = 0;
    this.apply();
  }

  private reducedMotion: boolean;

  setReducedMotion(value: boolean): void {
    this.reducedMotion = value;
  }

  get home(): Shot {
    return cloneShot(this.base);
  }

  /** Travel to a composed viewpoint. */
  goTo(shot: Shot, options: TravelOptions = {}): void {
    const duration = this.reducedMotion || options.immediate ? 0 : this.travelDuration();
    this.from = this.currentShot();
    this.to = cloneShot(shot);
    this.duration = duration;
    this.travel = duration === 0 ? 1 : 0;
    if (duration === 0) {
      this.base = cloneShot(shot);
      this.apply();
    }
  }

  /** Duration scales gently with how far the camera has to move. */
  private travelDuration(): number {
    const distance = this.from.position.distanceTo(this.to.position);
    const t = THREE.MathUtils.clamp(distance / 26, 0, 1);
    return THREE.MathUtils.lerp(MIN_TRAVEL, MAX_TRAVEL, t);
  }

  private currentShot(): Shot {
    if (this.duration === 0 || this.travel >= 1) return cloneShot(this.base);
    const t = easeInOut(this.travel);
    return {
      position: new THREE.Vector3().lerpVectors(this.from.position, this.to.position, t),
      target: new THREE.Vector3().lerpVectors(this.from.target, this.to.target, t),
      fov: THREE.MathUtils.lerp(this.from.fov, this.to.fov, t),
    };
  }

  /** Drag-to-orbit. Amounts are in pointer pixels. */
  orbit(dx: number, dy: number): void {
    this.targetAzimuth = THREE.MathUtils.clamp(
      this.targetAzimuth - dx * 0.0042,
      -AZIMUTH_LIMIT,
      AZIMUTH_LIMIT,
    );
    this.targetPolar = THREE.MathUtils.clamp(
      this.targetPolar - dy * 0.0032,
      -POLAR_LIMIT,
      POLAR_LIMIT,
    );
  }

  get orbiting(): boolean {
    return Math.abs(this.targetAzimuth) > 0.001 || Math.abs(this.targetPolar) > 0.001;
  }

  resetOrbit(): void {
    this.targetAzimuth = 0;
    this.targetPolar = 0;
  }

  update(delta: number): void {
    if (this.duration > 0 && this.travel < 1) {
      this.travel = Math.min(1, this.travel + delta / this.duration);
    }
    this.base = this.currentShot();

    /* Orbit eases so a flick feels weighted rather than twitchy. */
    const lambda = this.reducedMotion ? 1000 : 7;
    this.orbitAzimuth = THREE.MathUtils.damp(this.orbitAzimuth, this.targetAzimuth, lambda, delta);
    this.orbitPolar = THREE.MathUtils.damp(this.orbitPolar, this.targetPolar, lambda, delta);
    this.apply();
  }

  private apply(): void {
    this.offset.subVectors(this.base.position, this.base.target);
    this.spherical.setFromVector3(this.offset);
    this.spherical.theta += this.orbitAzimuth;
    this.spherical.phi = THREE.MathUtils.clamp(
      this.spherical.phi + this.orbitPolar,
      MIN_POLAR,
      MAX_POLAR,
    );
    this.position.setFromSpherical(this.spherical).add(this.base.target);
    this.position.y = Math.max(this.position.y, MIN_HEIGHT);
    this.camera.position.copy(this.position);
    this.camera.lookAt(this.base.target);
    if (Math.abs(this.camera.fov - this.base.fov) > 0.01) {
      this.camera.fov = this.base.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** True while the camera is still moving between shots. */
  get travelling(): boolean {
    return this.duration > 0 && this.travel < 1;
  }
}

export function cloneShot(shot: Shot): Shot {
  return {
    position: shot.position.clone(),
    target: shot.target.clone(),
    fov: shot.fov,
  };
}
