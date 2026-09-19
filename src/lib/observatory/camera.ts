/**
 * Camera rig.
 *
 * A shot is a composed viewpoint: position, look-at target and field of view.
 * Travel between shots is eased over ~900ms and always interruptible.
 *
 * Orbit and zoom are applied on top of the current shot and are always
 * available — the world is the interface, so dragging and zooming it is the
 * primary way of looking around. Bounds are generous but hard, so no amount
 * of dragging can lose the island or turn the camera upside down.
 */

import * as THREE from 'three';
import type { Shot } from './world';

const MIN_TRAVEL = 0.7;
const MAX_TRAVEL = 1.1;
/** Horizontal swing around the subject. */
const AZIMUTH_LIMIT = 1.5;
/** Vertical swing: enough to look down on the campus, never past vertical. */
const POLAR_MIN = 0.16;
const POLAR_MAX = 1.45;
/** Distance multiplier limits. */
const ZOOM_MIN = 0.45;
const ZOOM_MAX = 2.4;
/** Orbit is expressed relative to the shot's own elevation. */
const ORBIT_POLAR_LIMIT = 0.95;
const MIN_HEIGHT = 2.2;

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

export interface TravelOptions {
  /** Skip the animation entirely (reduced motion, first frame). */
  immediate?: boolean;
}

/** How far the visitor has looked around from the composed shot. */
export interface OrbitState {
  azimuth: number;
  polar: number;
  zoom: number;
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
  /** Multiplier on the composed distance. Below 1 moves closer. */
  private zoom = 1;
  private targetZoom = 1;
  private readonly offset = new THREE.Vector3();
  private readonly spherical = new THREE.Spherical();
  private readonly position = new THREE.Vector3();
  private reducedMotion: boolean;

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

  /** Drag to look around. Amounts are in pointer pixels. */
  orbit(dx: number, dy: number): void {
    this.targetAzimuth = THREE.MathUtils.clamp(
      this.targetAzimuth - dx * 0.005,
      -AZIMUTH_LIMIT,
      AZIMUTH_LIMIT,
    );
    this.targetPolar = THREE.MathUtils.clamp(
      this.targetPolar - dy * 0.0038,
      -ORBIT_POLAR_LIMIT,
      ORBIT_POLAR_LIMIT,
    );
  }

  /**
   * Zoom. `amount` is a signed fraction of the current distance: positive
   * moves closer, so a wheel notch of 0.1 closes ten percent of the gap.
   */
  zoomBy(amount: number): void {
    this.targetZoom = THREE.MathUtils.clamp(
      this.targetZoom * (1 - amount),
      ZOOM_MIN,
      ZOOM_MAX,
    );
  }

  get zoomLevel(): number {
    return this.zoom;
  }

  get orbiting(): boolean {
    return (
      Math.abs(this.targetAzimuth) > 0.001 ||
      Math.abs(this.targetPolar) > 0.001 ||
      Math.abs(this.targetZoom - 1) > 0.001
    );
  }

  resetOrbit(): void {
    this.targetAzimuth = 0;
    this.targetPolar = 0;
    this.targetZoom = 1;
  }

  /** The visitor's current look-around, for restoring a previous view. */
  get orbitState(): OrbitState {
    return {
      azimuth: this.targetAzimuth,
      polar: this.targetPolar,
      zoom: this.targetZoom,
    };
  }

  /**
   * Restore a look-around. Both the live and the target values are set, so a
   * restored view does not drift back to where the camera happened to be.
   */
  setOrbitState(state: Partial<OrbitState> | null | undefined): void {
    if (!state) return;
    if (typeof state.azimuth === 'number') {
      this.orbitAzimuth = state.azimuth;
      this.targetAzimuth = state.azimuth;
    }
    if (typeof state.polar === 'number') {
      this.orbitPolar = state.polar;
      this.targetPolar = state.polar;
    }
    if (typeof state.zoom === 'number') {
      this.zoom = THREE.MathUtils.clamp(state.zoom, ZOOM_MIN, ZOOM_MAX);
      this.targetZoom = this.zoom;
    }
    this.apply();
  }

  update(delta: number): void {
    if (this.duration > 0 && this.travel < 1) {
      this.travel = Math.min(1, this.travel + delta / this.duration);
    }
    this.base = this.currentShot();

    /* Eased so a flick feels weighted rather than twitchy. */
    const lambda = this.reducedMotion ? 1000 : 7;
    this.orbitAzimuth = THREE.MathUtils.damp(this.orbitAzimuth, this.targetAzimuth, lambda, delta);
    this.orbitPolar = THREE.MathUtils.damp(this.orbitPolar, this.targetPolar, lambda, delta);
    this.zoom = THREE.MathUtils.damp(this.zoom, this.targetZoom, lambda, delta);
    this.apply();
  }

  private apply(): void {
    this.offset.subVectors(this.base.position, this.base.target);
    this.spherical.setFromVector3(this.offset);
    this.spherical.theta += this.orbitAzimuth;
    this.spherical.phi = THREE.MathUtils.clamp(
      this.spherical.phi + this.orbitPolar,
      POLAR_MIN,
      POLAR_MAX,
    );
    this.spherical.radius *= this.zoom;
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
