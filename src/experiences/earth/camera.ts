import * as THREE from 'three';
import type { InputScope } from '../../core/Input';
import { OrbitRig } from '../../core/rigs/OrbitRig';

/**
 * Camera for the Earth experience. Three pose providers, blended by tweens:
 *  - orbit:   OrbitRig around a focus body (Earth, Moon or a gallery world), with an optional aim
 *             blend toward a second body (Earthrise) and a small framing offset (rule of thirds);
 *  - horizon: low Earth orbit (ISS): position on a real inclined circular orbit advancing at the
 *             Keplerian rate, looking along-track at the limb; drag looks around, wheel changes height;
 *  - tween:   from the last pose to the live pose of the new mode, direction slerped and distance
 *             interpolated in log space about the Earth's centre (so 400 km → 6 billion km is smooth).
 * All state is float64 (JS numbers); three.js uploads camera-relative matrices.
 */

export interface Pose {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  fov: number;
}

export interface OrbitFraming {
  /** Focus body centre (world, R⊕), read every frame. */
  focus: () => THREE.Vector3;
  /** Optional second body to aim toward (0..1 blend of the look direction). */
  aim?: (() => THREE.Vector3) | null;
  aimBlend?: number;
  /** Screen framing offsets (rad): positive x moves the subject right, positive y moves it up. */
  frameX?: number;
  frameY?: number;
  /** Screen-up along the local vertical of the focus body (horizon views) instead of world +Y. */
  radialUp?: boolean;
  /** Vertical field of view (deg); or a function of the rig distance. */
  fov: number | ((distance: number) => number);
}

export interface HorizonState {
  /** Orbit radius, R⊕. */
  radius: number;
  /** Orbit basis (world): position = r (cos a · e1 + sin a · e2). */
  e1: THREE.Vector3;
  e2: THREE.Vector3;
  /** Orbital phase (rad). */
  anomaly: number;
  /** Look direction relative to along-track: yaw about local up, elevation above the horizon line (rad). */
  yaw: number;
  elevation: number;
  fov: number;
}

const GM_EARTH = 398600.4418; // km³/s²
const R_EARTH_KM = 6371;

/** Circular-orbit mean motion (rad/s) at radius r (R⊕). */
export const meanMotion = (rEarthRadii: number) => Math.sqrt(GM_EARTH / Math.pow(rEarthRadii * R_EARTH_KM, 3));

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class EarthCamera {
  readonly camera = new THREE.PerspectiveCamera(35, 1, 0.01, 10);
  readonly rig: OrbitRig;
  mode: 'orbit' | 'horizon' = 'orbit';
  framing: OrbitFraming;
  readonly horizon: HorizonState = {
    radius: 1 + 420 / R_EARTH_KM,
    e1: new THREE.Vector3(1, 0, 0),
    e2: new THREE.Vector3(0, 0, -1),
    anomaly: 0,
    yaw: 0,
    elevation: 0.12,
    fov: 62,
  };
  /** Live pose (world, R⊕). */
  readonly pose: Pose = { position: new THREE.Vector3(0, 0, 4), quaternion: new THREE.Quaternion(), fov: 35 };
  private tween: { from: Pose; t: number; dur: number } | null = null;
  private live: Pose = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), fov: 35 };
  private m = new THREE.Matrix4();
  private v1 = new THREE.Vector3();
  private v2 = new THREE.Vector3();
  private v3 = new THREE.Vector3();
  private q1 = new THREE.Quaternion();
  private e = new THREE.Euler();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private dragVel = { x: 0, y: 0 };
  private aspect = 16 / 9;

  constructor(input: InputScope, framing: OrbitFraming) {
    this.framing = framing;
    this.rig = new OrbitRig(input, { distance: 4, yaw: 0, pitch: 0.2, minDistance: 1.02, maxDistance: 3e6, enablePan: false, damping: 0.14, zoomSpeed: 0.14 });
    // Horizon-mode look-around and altitude (the orbit rig is disabled in that mode).
    input.onDrag((e) => {
      if (this.mode !== 'horizon') return;
      this.dragVel.x += e.dx;
      this.dragVel.y += e.dy;
    });
    input.onWheel((e) => {
      if (this.mode !== 'horizon') return;
      const h = (this.horizon.radius - 1) * R_EARTH_KM;
      const nh = THREE.MathUtils.clamp(h * Math.exp(e.delta * 0.12), 160, 3000);
      this.horizon.radius = 1 + nh / R_EARTH_KM;
    });
    input.onPinch((e) => {
      if (this.mode !== 'horizon') return;
      const h = (this.horizon.radius - 1) * R_EARTH_KM;
      this.horizon.radius = 1 + THREE.MathUtils.clamp(h / Math.max(0.2, Math.min(5, e.scale)), 160, 3000) / R_EARTH_KM;
    });
  }

  /** Distance of the camera from the Earth's centre (R⊕). */
  get altitudeRadius(): number {
    return this.pose.position.length();
  }

  get transitioning(): boolean {
    return this.tween !== null || this.rig.animating;
  }

  /** Snapshot the current pose and blend to whatever the (newly configured) mode produces. */
  beginTween(duration: number): void {
    this.tween = {
      from: { position: this.pose.position.clone(), quaternion: this.pose.quaternion.clone(), fov: this.pose.fov },
      t: 0,
      dur: duration,
    };
  }

  setOrbit(framing: OrbitFraming, view: { distance: number; yaw: number; pitch: number }, tween = 0): void {
    if (tween > 0) this.beginTween(tween);
    this.mode = 'orbit';
    this.framing = framing;
    this.rig.enabled = true;
    this.rig.set(view);
  }

  setHorizon(h: Partial<HorizonState>, tween = 0): void {
    if (tween > 0) this.beginTween(tween);
    this.mode = 'horizon';
    this.rig.enabled = false;
    Object.assign(this.horizon, h);
    this.dragVel.x = this.dragVel.y = 0;
  }

  /** Advance (dt real seconds, simDt simulated seconds). */
  update(dt: number, simDt: number): void {
    if (this.mode === 'orbit') {
      this.rig.update(dt);
      this.orbitPose(this.live);
    } else {
      const h = this.horizon;
      h.anomaly += meanMotion(h.radius) * simDt;
      // Smoothed look-around.
      const k = 1 - Math.exp(-dt / 0.12);
      const dx = this.dragVel.x * k;
      const dy = this.dragVel.y * k;
      this.dragVel.x -= dx;
      this.dragVel.y -= dy;
      h.yaw -= dx * 0.004;
      h.elevation = THREE.MathUtils.clamp(h.elevation + dy * 0.004, -1.2, 1.2);
      this.horizonPose(this.live);
    }
    const out = this.pose;
    if (this.tween) {
      const tw = this.tween;
      tw.t += dt;
      const k = easeInOut(Math.min(1, tw.t / tw.dur));
      // Direction slerp and log-distance about the Earth's centre.
      const r0 = Math.max(tw.from.position.length(), 1e-6);
      const r1 = Math.max(this.live.position.length(), 1e-6);
      const d0 = this.v1.copy(tw.from.position).divideScalar(r0);
      const d1 = this.v2.copy(this.live.position).divideScalar(r1);
      const ang = Math.acos(THREE.MathUtils.clamp(d0.dot(d1), -1, 1));
      if (ang > 1e-6) {
        const axis = this.v3.crossVectors(d0, d1);
        if (axis.lengthSq() < 1e-12) axis.set(0, 1, 0);
        axis.normalize();
        d0.applyAxisAngle(axis, ang * k);
      }
      out.position.copy(d0).multiplyScalar(Math.exp(Math.log(r0) + (Math.log(r1) - Math.log(r0)) * k));
      out.quaternion.slerpQuaternions(tw.from.quaternion, this.live.quaternion, k);
      out.fov = Math.exp(Math.log(tw.from.fov) + (Math.log(this.live.fov) - Math.log(tw.from.fov)) * k);
      if (tw.t >= tw.dur) this.tween = null;
    } else {
      out.position.copy(this.live.position);
      out.quaternion.copy(this.live.quaternion);
      out.fov = this.live.fov;
    }
  }

  private orbitPose(p: Pose): void {
    const f = this.framing;
    const focus = f.focus();
    const rig = this.rig;
    p.position.copy(rig.position).add(focus);
    // Look at the focus, optionally blended toward a second body.
    const toFocus = this.v1.copy(focus).sub(p.position).normalize();
    if (f.aim && (f.aimBlend ?? 0) > 0) {
      const toAim = this.v2.copy(f.aim()).sub(p.position).normalize();
      toFocus.lerp(toAim, f.aimBlend ?? 0).normalize();
    }
    const target = this.v3.copy(p.position).add(toFocus);
    const up = f.radialUp ? this.v2.copy(rig.position).normalize() : this.up;
    this.m.lookAt(p.position, target, up);
    p.quaternion.setFromRotationMatrix(this.m);
    if ((f.frameX || f.frameY) && this.aspect >= 1) {
      this.q1.setFromEuler(this.e.set(-(f.frameY ?? 0), f.frameX ?? 0, 0, 'YXZ'));
      p.quaternion.multiply(this.q1);
    }
    p.fov = typeof f.fov === 'function' ? f.fov(rig.distance) : f.fov;
  }

  private horizonPose(p: Pose): void {
    const h = this.horizon;
    const ca = Math.cos(h.anomaly), sa = Math.sin(h.anomaly);
    p.position.copy(h.e1).multiplyScalar(ca * h.radius).addScaledVector(h.e2, sa * h.radius);
    const U = this.v1.copy(p.position).normalize();
    // Along-track direction, then yaw about the local vertical.
    const V = this.v2.copy(h.e1).multiplyScalar(-sa).addScaledVector(h.e2, ca).normalize();
    V.applyAxisAngle(U, h.yaw);
    // Horizon dip below the local horizontal: cos δ = 1/r.
    const dip = Math.acos(Math.min(1, 1 / h.radius));
    const el = -dip + h.elevation;
    const fwd = this.v3.copy(V).multiplyScalar(Math.cos(el)).addScaledVector(U, Math.sin(el));
    const target = fwd.add(p.position);
    this.m.lookAt(p.position, target, U);
    p.quaternion.setFromRotationMatrix(this.m);
    p.fov = h.fov;
  }

  /** Write the pose into the three.js camera (aspect from the target). */
  apply(aspect: number): THREE.PerspectiveCamera {
    const c = this.camera;
    this.aspect = aspect;
    c.position.copy(this.pose.position);
    c.quaternion.copy(this.pose.quaternion);
    // Portrait screens: keep the designed field across the narrow (horizontal) dimension.
    c.fov = aspect < 1 ? (2 * Math.atan(Math.tan((this.pose.fov * Math.PI) / 360) / aspect) * 180) / Math.PI : this.pose.fov;
    c.aspect = aspect;
    c.updateMatrixWorld(true);
    return c;
  }

  /** Set near/far to bracket a sphere of radius `r` at `centre` and update the projection. */
  bracket(centre: THREE.Vector3, r: number): void {
    const c = this.camera;
    const d = c.position.distanceTo(centre);
    c.near = Math.max(d - r, d * 2e-6, 1e-5);
    c.far = Math.max(d + r, c.near * 4);
    c.updateProjectionMatrix();
  }
}
