/**
 * Camera rig.
 *
 * A shot is a composed viewpoint: position, look-at target and field of view.
 * Travel between shots is eased over ~900ms and always interruptible.
 *
 * Orbit and zoom are applied on top of the current shot and are always
 * available — the world is the interface, so dragging and zooming it is the
 * primary way of looking around.
 *
 * The rig owns the one rule that keeps the world legible: the camera is never
 * allowed to end up underneath the island, inside the rock, or inside a
 * building. Bounds alone are not enough for that, because the distance a shot
 * is framed from depends on the viewport, so a limit that is safe on a desktop
 * is not safe in a short strip. Instead every candidate position is tested
 * against the island's own silhouette — the same profile the geometry is
 * lathed from — plus a list of solid volumes the world registers, and is
 * pulled in to the last point on its approach line that clears them. That
 * holds for the composed shots, for the orbit the visitor drives, and for
 * every intermediate frame of a transition.
 */

import * as THREE from 'three';
import { islandEnvelopeAt } from './parts';
import type { Shot } from './world';

const MIN_TRAVEL = 0.7;
const MAX_TRAVEL = 1.1;
/** Horizontal swing around the subject. Generous: the whole campus is round. */
const AZIMUTH_LIMIT = 1.9;
/** Vertical swing: from just above the horizon to a steep look-down. */
const ORBIT_POLAR_DOWN = 0.92;
const ORBIT_POLAR_UP = 0.44;
/** Distance multiplier limits, relative to the composed shot. */
const ZOOM_MIN = 0.62;
const ZOOM_MAX = 1.7;
/** How high the ground sits, matching the world's plateau. */
const GROUND = 1;
/** The camera never comes closer to the plateau than this. */
const GROUND_CLEARANCE = 1.9;
/**
 * The steepest and shallowest the camera is ever allowed to look at the
 * island from, measured as the polar angle of its offset from the subject.
 * Phi is measured from straight up, so the small value is the steep look-down
 * and the value near a right angle is the flattest view above the horizon.
 */
const POLAR_LOOK_DOWN = 0.22;
const POLAR_LOOK_LEVEL = Math.PI / 2 - 0.06;
/** The shallowest a composed shot's own elevation may be pulled to. */
const SHOT_POLAR_FLOOR = 0.5;

/** A solid the camera must stay out of: a vertical cylinder with a lid. */
export interface SolidVolume {
  x: number;
  z: number;
  /** Radius of the volume, already including the camera's own body. */
  radius: number;
  /** World height of the top of the volume. */
  top: number;
}

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

/**
 * The lowest the camera may sit at a horizontal position.
 *
 * Inside the island's footprint the floor is the plateau itself; outside it
 * there is nothing underneath at all, and the camera may drop to the level of
 * the keel's foot so the underside can be looked at from a distance — which is
 * the one view from below that is worth having, and it is a view of a finished
 * body rather than of its back faces.
 */
export function terrainFloorAt(x: number, z: number): number {
  const radial = Math.hypot(x, z);
  const footprint = islandEnvelopeAt(GROUND - 0.02);
  if (radial <= footprint + 0.4) return GROUND + GROUND_CLEARANCE;
  /*
   * Outside the footprint the camera is in open air; it may descend, but never
   * below the keel, so the island is always seen from the side or above.
   */
  const approach = THREE.MathUtils.clamp(
    (radial - footprint) / 6,
    0,
    1,
  );
  return THREE.MathUtils.lerp(GROUND + GROUND_CLEARANCE, -8.4, approach);
}

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;

  private base: Shot;
  private from: Shot;
  private to: Shot;
  /** The last shot as composed, before the clearance pass corrected it. */
  private wanted: Shot | null = null;
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
  /** Solid volumes the camera must not enter; filled by the world. */
  private solids: SolidVolume[] = [];
  private reducedMotion: boolean;
  /**
   * Automatic turning, in radians per second.
   *
   * `turnTarget` is what the shell has asked for and `turnRate` is what the
   * camera is actually doing, so the movement eases in and out rather than
   * starting at full speed the moment the page loads — the first thing a
   * visitor sees should settle into motion, not jerk into it.
   */
  private turnRate = 0;
  private turnTarget = 0;
  private turnOffset = 0;

  constructor(aspect: number, home: Shot, reducedMotion: boolean) {
    this.camera = new THREE.PerspectiveCamera(home.fov, aspect, 0.35, 1200);
    this.base = cloneShot(home);
    this.from = cloneShot(home);
    this.to = cloneShot(home);
    this.reducedMotion = reducedMotion;
    this.duration = 0;
    this.clearance(home.position);
    this.camera.position.copy(home.position);
    this.camera.lookAt(home.target);
    this.apply();
  }

  setReducedMotion(value: boolean): void {
    this.reducedMotion = value;
  }

  /** Register the buildings the camera must keep out of. */
  setSolids(solids: SolidVolume[]): void {
    this.solids = solids;
  }

  get home(): Shot {
    return cloneShot(this.base);
  }

  /** Travel to a composed viewpoint, along a path that stays above ground. */
  goTo(shot: Shot, options: TravelOptions = {}): void {
    this.wanted = cloneShot(shot);
    const safe = this.safeShot(shot);
    const duration = this.reducedMotion || options.immediate ? 0 : this.travelDuration(safe);
    this.from = this.currentShot();
    this.to = safe;
    this.duration = duration;
    this.travel = duration === 0 ? 1 : 0;
    if (duration === 0) {
      this.base = cloneShot(safe);
      this.apply();
    }
  }

  /** Duration scales gently with how far the camera has to move. */
  private travelDuration(to: Shot): number {
    const distance = this.from.position.distanceTo(to.position);
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

  /**
   * Make a shot safe before it is ever travelled to.
   *
   * The line from the look-at target out to the composed position is sampled
   * from the inside out, and the camera is placed at the last sample that
   * clears the island and every registered volume. Sampling rather than
   * testing the endpoint is what stops a shot whose endpoint happens to be
   * clear from passing through the dome to get there.
   */
  private safeShot(shot: Shot): Shot {
    const position = this.clearanceAlong(shot.target, shot.position);
    return { position, target: shot.target.clone(), fov: shot.fov };
  }

  /** Walk target → wanted and return the furthest clear point. */
  private clearanceAlong(target: THREE.Vector3, wanted: THREE.Vector3): THREE.Vector3 {
    const distance = target.distanceTo(wanted);
    if (distance < 0.001) return this.clearance(wanted);
    const steps = Math.max(6, Math.min(40, Math.ceil(distance * 3)));
    /*
     * What to keep when the walk finds no clear air at all: the composed
     * position, not a point just off the target.
     *
     * The target is a framing anchor, not a place, and `readingShot` is free to
     * slide it below the plateau or into a building — that is how the subject
     * is lifted in a short frame. A walk that starts there can legitimately
     * find nothing clear, and answering that by collapsing the camera to the
     * near end of the line buries it in the island the target was slid under.
     * The composed position is what the composition asked for; `clearance`
     * below still lifts it out of the ground and out of every building.
     */
    let lastClear = this.clearance(wanted);
    /* The near end of the line is inside the building; start from the first
       clear sample and keep the furthest one after that. */
    let started = false;
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      const point = new THREE.Vector3().lerpVectors(target, wanted, t);
      if (this.clears(point)) {
        started = true;
        lastClear = point;
      } else if (started) {
        /* The line went into something after having been clear: stop here. */
        break;
      }
    }
    return this.clearance(lastClear);
  }

  /** True when a point is above the ground and outside every solid. */
  private clears(point: THREE.Vector3): boolean {
    if (point.y < terrainFloorAt(point.x, point.z)) return false;
    for (const solid of this.solids) {
      if (point.y > solid.top) continue;
      const dx = point.x - solid.x;
      const dz = point.z - solid.z;
      if (dx * dx + dz * dz < solid.radius * solid.radius) return false;
    }
    return true;
  }

  /**
   * Lift a point to the first clear position above it.
   *
   * Vertical, not radial: a camera pushed straight up keeps its bearing on the
   * subject, so the composition the shot was chosen for survives the
   * correction instead of sliding sideways. This is the correction
   * `clearanceAlong` applies to the point it settles on, and the one the live
   * orbit is clamped with every frame.
   */
  private clearance(point: THREE.Vector3): THREE.Vector3 {
    const out = point.clone();
    const floor = terrainFloorAt(out.x, out.z);
    if (out.y < floor) out.y = floor;
    for (const solid of this.solids) {
      if (out.y > solid.top) continue;
      const dx = out.x - solid.x;
      const dz = out.z - solid.z;
      const squared = dx * dx + dz * dz;
      if (squared >= solid.radius * solid.radius) continue;
      /* Push out along the horizontal normal, away from the volume's axis. */
      const distance = Math.sqrt(squared);
      if (distance < 0.0001) {
        out.x += solid.radius;
        continue;
      }
      const push = (solid.radius - distance) / distance;
      out.x += dx * push;
      out.z += dz * push;
    }
    const floorAfter = terrainFloorAt(out.x, out.z);
    if (out.y < floorAfter) out.y = floorAfter;
    return out;
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
      -ORBIT_POLAR_DOWN,
      ORBIT_POLAR_UP,
    );
  }

  /**
   * Zoom. `amount` is a signed fraction of the current distance: positive
   * moves closer, so a wheel notch of 0.1 closes ten percent of the gap.
   *
   * MIN_ZOOM keeps the camera outside the largest building on the island: the
   * closest a composed shot ever is to its subject is about 9 units, and 0.58
   * of that is still clear of the dome's 2.7-unit radius, so zooming all the
   * way in reveals detail rather than the inside of a wall.
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

  /** True when the visitor has looked away from the composed view. */
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
    /* A reset puts the island back where it was composed, which includes
       undoing however far the automatic turn had carried it. */
    this.turnOffset = 0;
    this.orbitAzimuth = 0;
  }

  /**
   * Turn the campus slowly, forever.
   *
   * `rate` is in radians per second; zero stops it. The rig adds this to its
   * own azimuth rather than moving the composed shot, so the visitor's drag
   * limits, the reset and the return-view restore all keep working in the same
   * coordinates — the turn is a baseline the visitor's own movement is added
   * on top of.
   *
   * Starting is eased and stopping is not, and that asymmetry is deliberate.
   * The ease-in is what keeps the campus from jerking into motion the moment
   * the page settles. Easing *out*, on the other hand, means the world keeps
   * drifting for a second and a half after the visitor has taken the camera,
   * opened a document or arrived somewhere — which is exactly when the scene
   * should be still. It also drags the captions with it: they are re-placed
   * every frame against a camera that has not finished stopping, so a
   * destination with a dozen labels to fit churns through them while it
   * coasts, and reads as a glitch rather than as movement. Zero therefore
   * means zero, now.
   */
  setAutoTurn(rate: number): void {
    const target = this.reducedMotion ? 0 : rate;
    this.turnTarget = target;
    if (target === 0) this.turnRate = 0;
  }

  /** True while the campus is turning itself. */
  get turning(): boolean {
    return this.turnRate > 0.0001;
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
      this.orbitAzimuth = THREE.MathUtils.clamp(state.azimuth, -AZIMUTH_LIMIT, AZIMUTH_LIMIT);
      this.targetAzimuth = this.orbitAzimuth;
    }
    if (typeof state.polar === 'number') {
      this.orbitPolar = THREE.MathUtils.clamp(
        state.polar,
        -ORBIT_POLAR_DOWN,
        ORBIT_POLAR_UP,
      );
      this.targetPolar = this.orbitPolar;
    }
    if (typeof state.zoom === 'number') {
      this.zoom = THREE.MathUtils.clamp(state.zoom, ZOOM_MIN, ZOOM_MAX);
      this.targetZoom = this.zoom;
    }
    this.apply();
  }

  /**
   * `delta` is the clamped step the simulation uses; `realDelta` is the time
   * that actually passed. They differ only on a slow renderer, and the
   * difference matters: easing must be clamped so a long frame does not
   * teleport the camera, but the automatic turn is wall-clock motion and would
   * otherwise crawl on exactly the devices that need it most.
   */
  update(delta: number, realDelta = delta): void {
    if (this.duration > 0 && this.travel < 1) {
      this.travel = Math.min(1, this.travel + delta / this.duration);
    }
    this.base = this.currentShot();

    /* Eased so a flick feels weighted rather than twitchy. */
    const lambda = this.reducedMotion ? 1000 : 7;
    this.orbitAzimuth = THREE.MathUtils.damp(this.orbitAzimuth, this.targetAzimuth, lambda, delta);
    this.orbitPolar = THREE.MathUtils.damp(this.orbitPolar, this.targetPolar, lambda, delta);
    this.zoom = THREE.MathUtils.damp(this.zoom, this.targetZoom, lambda, delta);

    /* The automatic turn eases in over about a second and a half. */
    const turnLambda = this.reducedMotion ? 1000 : 0.9;
    this.turnRate = THREE.MathUtils.damp(this.turnRate, this.turnTarget, turnLambda, realDelta);
    if (this.turnRate > 0.00001) this.turnOffset += this.turnRate * realDelta;

    this.apply();
  }

  private apply(): void {
    this.offset.subVectors(this.base.position, this.base.target);
    this.spherical.setFromVector3(this.offset);
    this.spherical.theta += this.orbitAzimuth + this.turnOffset;
    /*
     * The composed shot's own elevation plus the visitor's swing, held inside
     * the band where the island reads. Phi is measured from straight up, so
     * the lower bound is the steep look-down and the upper bound is the
     * shallowest angle above the horizon.
     */
    const basePolar = THREE.MathUtils.clamp(
      this.spherical.phi,
      SHOT_POLAR_FLOOR,
      POLAR_LOOK_LEVEL,
    );
    this.spherical.phi = THREE.MathUtils.clamp(
      basePolar + this.orbitPolar,
      POLAR_LOOK_DOWN,
      POLAR_LOOK_LEVEL,
    );
    this.spherical.radius = Math.max(3.4, this.spherical.radius * this.zoom);
    this.position.setFromSpherical(this.spherical).add(this.base.target);

    const clear = this.clearance(this.position);
    this.camera.position.copy(clear);
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

  /** The point the camera is currently looking at. */
  get focus(): THREE.Vector3 {
    return this.base.target.clone();
  }

  /** True while the camera is still moving between shots. */
  get travelling(): boolean {
    return this.duration > 0 && this.travel < 1;
  }

  /** Live diagnostics: where the camera is and how far it is above the floor. */
  debug(): {
    position: [number, number, number];
    target: [number, number, number];
    wanted: [number, number, number] | null;
    above: number;
    radius: number;
    polar: number;
    turn: number;
  } {
    return {
      position: [this.camera.position.x, this.camera.position.y, this.camera.position.z],
      target: [this.base.target.x, this.base.target.y, this.base.target.z],
      wanted: this.wanted
        ? [this.wanted.position.x, this.wanted.position.y, this.wanted.position.z]
        : null,
      above: this.camera.position.y - terrainFloorAt(this.camera.position.x, this.camera.position.z),
      radius: this.camera.position.distanceTo(this.base.target),
      polar: this.spherical.phi,
      turn: this.turnOffset,
    };
  }
}

export function cloneShot(shot: Shot): Shot {
  return {
    position: shot.position.clone(),
    target: shot.target.clone(),
    fov: shot.fov,
  };
}
