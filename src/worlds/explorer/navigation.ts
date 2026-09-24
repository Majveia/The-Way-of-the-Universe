import * as THREE from 'three';
import { Frame, commonAncestor, convertPoint, convertDirection, rootDirToFrame, frameDirToRoot, type NavState } from './frames';

/**
 * Travel across 24 decades of scale.
 *
 * SPEED. Manual flight scales speed with the distance to the nearest body (SpaceEngine / Powers of
 * Ten): v = k · throttle · d_nearest, so the view always changes at the same *rate* — from km/s
 * above a planet to Mpc/s between galaxies. When v exceeds c this is the labelled "imagination
 * drive"; below c it is ordinary (and, in sub-light mode, relativistic) flight.
 *
 * AUTOPILOT. A trip from A to B is flown in logarithmic distance. Departing, the distance from the
 * start grows as r_s = L₀ (e^λ − 1); arriving, the distance to the end shrinks as r_t = L₁ (e^μ − 1),
 * where L₀, L₁ are the natural scales of the two ends (e.g. the planet's radius, the galaxy's size).
 * The trip parameter Λ = λ + (μ_max − μ) runs over Λ_tot = ln(1 + D/2L₀) + ln(1 + D/2L₁) with a
 * quintic ease, so the traveller leaves smoothly, crosses the middle at ~D/2 per unit Λ (velocity is
 * continuous at the switch), and arrives at rest. Every point is evaluated in the frame of the end it
 * is close to (full float64 precision at both ends); in the middle the two expressions are blended in
 * their common ancestor frame, which also absorbs the motion of moving end frames (planets).
 */

export const SPEED_OF_LIGHT = 299_792_458;

/** Fraction of the nearest-body distance crossed per second at full throttle. */
export const AUTO_SPEED_K = 0.55;

/** Automatic cruise speed (m/s) for a throttle in [0, 1] at distance `dNearest` (m) from the nearest body. */
export function autoSpeed(dNearest: number, throttle: number, k = AUTO_SPEED_K, min = 50, max = 1e32): number {
  const t = THREE.MathUtils.clamp(throttle, 0, 1);
  // A gentle power law on the throttle gives fine control near zero.
  return THREE.MathUtils.clamp(k * t * t * Math.max(dNearest, 0), min * t, max);
}

/** Is a speed faster than light (the imagination drive)? */
export const isSuperluminal = (v: number) => v > SPEED_OF_LIGHT;

/** Quintic smoother-step: zero velocity and acceleration at both ends. */
export const smoother = (t: number) => {
  const x = THREE.MathUtils.clamp(t, 0, 1);
  return x * x * x * (x * (6 * x - 15) + 10);
};
/** Its derivative d/dt smoother(t). */
export const smootherDeriv = (t: number) => {
  const x = THREE.MathUtils.clamp(t, 0, 1);
  return 30 * x * x * (x - 1) * (x - 1);
};

export interface TripEnd {
  frame: Frame;
  /** Position (frame units). */
  position: THREE.Vector3;
  /** Natural length scale at this end (metres): how far away "near" is (a planet's radius, a galaxy's size). */
  scale: number;
}

export interface TripOptions {
  /** Trip duration in seconds (default from the log length). */
  duration?: number;
  /** Where to look on arrival (in the end frame); default: continue along the path. */
  lookAt?: THREE.Vector3;
  /** Final attitude (root axes). Overrides lookAt. */
  finalQuaternion?: THREE.Quaternion;
  /** Up vector for the arrival attitude (root axes). */
  up?: THREE.Vector3;
  /** Start attitude (root axes) — usually the traveller's current one. */
  startQuaternion?: THREE.Quaternion;
  /** Seconds to turn toward the destination at departure (default ≈ 2.2). */
  turn?: number;
}

/** Recommended duration (s) of a trip with log-length Λ. */
export function tripDuration(logLength: number): number {
  return THREE.MathUtils.clamp(3.5 + 0.42 * logLength, 5, 24);
}

/** Log length Λ of a trip of distance D between ends of scales L0, L1 (all metres). */
export function tripLogLength(D: number, L0: number, L1: number): number {
  return Math.log1p(D / (2 * Math.max(L0, 1e-3))) + Math.log1p(D / (2 * Math.max(L1, 1e-3)));
}

/**
 * Distance from the start and to the end (metres) at trip parameter Λ ∈ [0, Λtot].
 * Pure function; exported for tests.
 */
export function tripDistances(Lam: number, D: number, L0: number, L1: number): { fromStart: number; toEnd: number; departing: boolean } {
  const lmax = Math.log1p(D / (2 * L0));
  const mmax = Math.log1p(D / (2 * L1));
  if (Lam <= lmax) {
    const rs = L0 * Math.expm1(Math.max(0, Lam));
    return { fromStart: rs, toEnd: D - rs, departing: true };
  }
  const mu = Math.max(0, mmax - (Lam - lmax));
  const rt = L1 * Math.expm1(mu);
  return { fromStart: D - rt, toEnd: rt, departing: false };
}

export class Trip {
  readonly start: TripEnd;
  readonly end: TripEnd;
  readonly lca: Frame;
  /** Straight-line distance at departure (m). */
  readonly distance: number;
  readonly logLength: number;
  readonly duration: number;
  t = 0;
  private dirStart = new THREE.Vector3();
  private dirEnd = new THREE.Vector3();
  private dirRoot = new THREE.Vector3();
  /** Current direction to the destination (root axes). */
  private dirNow = new THREE.Vector3();
  private q0 = new THREE.Quaternion();
  private qTravel = new THREE.Quaternion();
  private q1 = new THREE.Quaternion();
  private turn: number;
  private hasFinal: boolean;
  /** Current speed (m/s), measured. */
  speed = 0;
  private prevRoot = new THREE.Vector3();
  private prevValid = false;

  constructor(start: TripEnd, end: TripEnd, o: TripOptions = {}) {
    this.start = { frame: start.frame, position: start.position.clone(), scale: start.scale };
    this.end = { frame: end.frame, position: end.position.clone(), scale: end.scale };
    const lca = commonAncestor(start.frame, end.frame);
    if (!lca) throw new Error('trip ends share no frame');
    this.lca = lca;
    const a = convertPoint(start.position, start.frame, lca, new THREE.Vector3());
    const b = convertPoint(end.position, end.frame, lca, new THREE.Vector3());
    const d = b.sub(a);
    this.distance = d.length() * lca.metres;
    if (d.lengthSq() > 0) d.normalize();
    else d.set(0, 0, -1);
    frameDirToRoot(d, lca, this.dirRoot);
    this.dirNow.copy(this.dirRoot);
    convertDirection(d, lca, start.frame, this.dirStart);
    convertDirection(d, lca, end.frame, this.dirEnd);
    this.logLength = tripLogLength(this.distance, start.scale, end.scale);
    this.duration = o.duration ?? tripDuration(this.logLength);
    this.turn = o.turn ?? Math.min(2.2, 0.3 * this.duration);
    // Attitudes: current → facing the destination → the arrival view.
    this.q0.copy(o.startQuaternion ?? new THREE.Quaternion());
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.q0);
    lookQuat(this.dirRoot, up, this.qTravel);
    this.hasFinal = !!(o.finalQuaternion || o.lookAt);
    if (o.finalQuaternion) this.q1.copy(o.finalQuaternion);
    else if (o.lookAt) {
      const dirF = new THREE.Vector3().copy(o.lookAt).sub(end.position);
      if (dirF.lengthSq() < 1e-30) dirF.copy(this.dirEnd);
      frameDirToRoot(dirF.normalize(), end.frame, dirF);
      lookQuat(dirF, o.up ?? up, this.q1);
    } else this.q1.copy(this.qTravel);
  }

  get done(): boolean {
    return this.t >= this.duration;
  }
  get progress(): number {
    return THREE.MathUtils.clamp(this.t / this.duration, 0, 1);
  }

  /** Remaining straight-line distance (m) at the current time. */
  remaining(): number {
    const L = smoother(this.progress) * this.logLength;
    return tripDistances(L, this.distance, this.start.scale, this.end.scale).toEnd;
  }

  /**
   * Advance by dt seconds and write the traveller's position/attitude (nav.frame is set to the
   * frame the point is expressed in; call settleFrame() afterwards).
   */
  step(dt: number, nav: NavState): void {
    this.t = Math.min(this.duration, this.t + dt);
    this.sample(this.progress, nav);
    // Measured speed (root axes, metres).
    const rootPos = convertPoint(nav.position, nav.frame, rootOf(nav.frame), _w).multiplyScalar(rootOf(nav.frame).metres);
    if (this.prevValid && dt > 0) this.speed = rootPos.distanceTo(this.prevRoot) / dt;
    this.prevRoot.copy(rootPos);
    this.prevValid = true;
    if (this.done) this.speed = 0;
  }

  /** Position and attitude at progress u ∈ [0, 1]. */
  sample(u: number, nav: NavState): void {
    const e = smoother(u);
    const Lam = e * this.logLength;
    const { fromStart, toEnd } = tripDistances(Lam, this.distance, this.start.scale, this.end.scale);
    // Blend weight between the start-frame and end-frame expressions: 0 near the start, 1 near the
    // end, in log distance (so both ends keep their own frame's precision).
    const ls = Math.log1p(fromStart / this.start.scale);
    const le = Math.log1p(toEnd / this.end.scale);
    const w = THREE.MathUtils.smoothstep(ls / Math.max(ls + le, 1e-9), 0.4, 0.6);
    if (w <= 0) {
      nav.frame = this.start.frame;
      nav.position.copy(this.start.position).addScaledVector(this.dirStart, fromStart / this.start.frame.metres);
    } else if (w >= 1) {
      nav.frame = this.end.frame;
      nav.position.copy(this.end.position).addScaledVector(this.dirEnd, -toEnd / this.end.frame.metres);
    } else {
      const lca = this.lca;
      const pa = _pa.copy(this.start.position).addScaledVector(this.dirStart, fromStart / this.start.frame.metres);
      convertPoint(pa, this.start.frame, lca, pa);
      const pb = _pb.copy(this.end.position).addScaledVector(this.dirEnd, -toEnd / this.end.frame.metres);
      convertPoint(pb, this.end.frame, lca, pb);
      nav.frame = lca;
      nav.position.copy(pa).lerp(pb, w);
    }
    // Follow the destination if its frame moves (a planet on its orbit): aim at where it is now.
    const lcaEnd = convertPoint(this.end.position, this.end.frame, nav.frame, _pb).sub(nav.position);
    if (lcaEnd.lengthSq() > 0) {
      frameDirToRoot(lcaEnd.normalize(), nav.frame, this.dirNow);
      lookQuat(this.dirNow, _up2.set(0, 1, 0).applyQuaternion(this.q0), this.qTravel);
    }
    // Attitude: turn to the destination, travel, then turn to the arrival view in the last stretch.
    const tSec = u * this.duration;
    const k0 = smoother(tSec / Math.max(this.turn, 1e-3));
    _q.slerpQuaternions(this.q0, this.qTravel, k0);
    if (this.hasFinal) {
      const k1 = smoother((tSec - (this.duration - this.turn * 1.6)) / (this.turn * 1.6));
      _q.slerp(this.q1, k1);
    }
    nav.quaternion.copy(_q);
    nav.velocity.copy(this.dirNow).multiplyScalar(this.speed);
  }
}

function rootOf(f: Frame): Frame {
  let r = f;
  while (r.parent) r = r.parent;
  return r;
}

const _w = new THREE.Vector3();
const _pa = new THREE.Vector3();
const _pb = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _zero = new THREE.Vector3();
const _up = new THREE.Vector3();
const _up2 = new THREE.Vector3();

/** Attitude looking along `dir` (root axes) with `up` as near-up. Camera convention: −Z forward. */
export function lookQuat(dir: THREE.Vector3, up: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  _up.copy(up);
  if (Math.abs(_up.dot(dir)) > 0.999 * dir.length() * _up.length()) _up.set(0, 0, 1).cross(dir).lengthSq() > 1e-6 ? _up.set(0, 0, 1) : _up.set(1, 0, 0);
  _m.lookAt(_zero, dir, _up);
  return out.setFromRotationMatrix(_m);
}

/** Express a root-axis point displacement in a frame (helper for callers). */
export function rootToFrameDisplacement(dRootMetres: THREE.Vector3, f: Frame, out: THREE.Vector3): THREE.Vector3 {
  return rootDirToFrame(dRootMetres, f, out).divideScalar(f.metres);
}

/** A round scale-bar length (1, 2 or 5 × 10ⁿ metres) not longer than `maxMetres`. */
export function niceScaleBar(maxMetres: number): number {
  if (!(maxMetres > 0)) return 0;
  const e = Math.floor(Math.log10(maxMetres));
  const base = Math.pow(10, e);
  const m = maxMetres / base;
  return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * base;
}
