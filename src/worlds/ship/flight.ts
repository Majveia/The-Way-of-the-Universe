import * as THREE from 'three';
import { C_PC_PER_YEAR, G_IN_C_PER_YEAR, gammaFromProperSpeed, stepProperVelocity } from '../../physics/voyage-relativity';

/**
 * Relativistic flight for the Ship of the Imagination.
 *
 * State: position (pc, float64, world frame), proper velocity u = γβ (c = 1), orientation, proper
 * time τ and coordinate ("Earth") time t, both in Julian years. The engine delivers a proper
 * acceleration up to `accelG` (in g) along the ship's nose; the 4-acceleration boost
 * du/dτ = γ a∥ + a⊥ is integrated exactly (voyage-relativity.stepProperVelocity), dt = γ dτ,
 * dx = u c dτ. Nothing ever reaches c: speed is capped in rapidity (default β ≤ 0.999).
 *
 * Autopilot (`engage`): time-optimal "flip and burn" with a velocity-matched arrival.
 *   align      turn the nose to the destination (engine idle)
 *   accelerate full proper acceleration α, steering the velocity vector onto the destination line
 *   coast      at the speed cap
 *   flip       when the deceleration needed to stop exactly at the destination,
 *                a_req = c (cosh φ − 1) / s        (φ = rapidity, s = remaining distance),
 *              reaches 90 % of α, the engine cuts and the ship turns end over end
 *   brake      engine thrusts against the motion at a_req — for the relativistic rocket this is
 *              constant along an exactly-followed braking trajectory, so the ship glides to rest at
 *              the arrival point with no overshoot and no chattering
 * Thrust is only produced along the nose, so the flip is physical: the engine idles while it turns.
 *
 * Time warp is expressed in ship proper time per real second. In autopilot it is chosen
 * automatically: gentle at departure, fast in cruise, slow-motion during the flip, easing into arrival.
 */
export type FlightPhase = 'idle' | 'align' | 'accelerate' | 'coast' | 'flip' | 'brake' | 'arrived';

export interface EngageOptions {
  /** Stop this far from the target, pc. */
  arrive?: number;
  /** Real seconds the cruise should take (sets the cruise time warp). Default 26. */
  cruiseSeconds?: number;
}

const DAY_YR = 1 / 365.25;
const HOUR_YR = DAY_YR / 24;
const FWD = new THREE.Vector3(0, 0, -1);
const _zero = new THREE.Vector3();

export class StarshipFlight {
  /** Position relative to the Sun, parsecs, world (galactic three.js) frame. */
  readonly position = new THREE.Vector3();
  /** Proper velocity γβ (c = 1). */
  readonly u = new THREE.Vector3();
  /** Orientation; the nose is local −Z. */
  readonly quaternion = new THREE.Quaternion();
  /** Elapsed proper (ship) time, years. */
  tau = 0;
  /** Elapsed coordinate (Earth-frame) time, years. */
  t = 0;
  /** Maximum proper acceleration, g. */
  accelG = 1;
  /** Speed cap (fraction of c). */
  betaCap = 0.999;
  /** Current main-engine output, fraction of the maximum (drives the plume). */
  thrust = 0;
  /** Current proper acceleration vector (c per year of proper time), world frame. */
  readonly accel = new THREE.Vector3();
  /** Ship proper time per real second (years/s). */
  warp = HOUR_YR;
  /** Manual cruise-speed command as a fraction of c along the nose (null = engine off / coast). */
  manualBeta: number | null = null;
  /** Maximum slew rate, radians per real second. */
  turnRate = 0.95;
  phase: FlightPhase = 'idle';
  onArrive: (() => void) | null = null;
  /** Distance (pc) the final settle moved the ship at the last arrival (diagnostic). */
  lastSnap = 0;
  private target: THREE.Vector3 | null = null;
  private arrive = 0;
  private warpCruise = 0.1;
  private startDist = 0;
  private sinceEngage = 0;
  private aReq = 0;
  private warpFloor = HOUR_YR;
  private tauEngaged = 0;
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private tmp3 = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private qTmp = new THREE.Quaternion();
  private m = new THREE.Matrix4();

  get beta(): number {
    const um = this.u.length();
    return um / Math.sqrt(1 + um * um);
  }
  get gamma(): number {
    return gammaFromProperSpeed(this.u.length());
  }
  /** Velocity as a fraction of c (β vector). */
  velocity(out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(this.u).divideScalar(Math.sqrt(1 + this.u.lengthSq()));
  }
  /** Maximum proper acceleration in c per year. */
  get alpha(): number {
    return this.accelG * G_IN_C_PER_YEAR;
  }
  get autopilot(): boolean {
    return this.target !== null;
  }
  get destination(): THREE.Vector3 | null {
    return this.target;
  }
  /** Remaining distance to the arrival point, pc (0 when idle). */
  get remaining(): number {
    if (!this.target) return 0;
    return Math.max(0, this.position.distanceTo(this.target) - this.arrive);
  }
  /** 0 → 1 over the current trip (by distance). */
  get progress(): number {
    if (!this.target) return 1;
    return THREE.MathUtils.clamp(1 - this.remaining / this.startDist, 0, 1);
  }
  /** Nose direction, world frame. */
  forward(out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(FWD).applyQuaternion(this.quaternion);
  }

  /** Fly to `target` (pc) and stop `arrive` pc short of it. */
  engage(target: THREE.Vector3, o: EngageOptions = {}): void {
    this.target = target.clone();
    this.arrive = o.arrive ?? 0;
    this.manualBeta = null;
    this.startDist = Math.max(1e-12, this.remaining);
    this.sinceEngage = 0;
    const tau = this.estimateTripTau(this.startDist) + Math.asinh(this.u.length()) / this.alpha;
    this.warpCruise = THREE.MathUtils.clamp(tau / (o.cruiseSeconds ?? 22), HOUR_YR, 60);
    // Floor: the last fifth of the standoff distance takes about a second and a half.
    const sEnd = Math.max(0.2 * this.arrive, 1e-9);
    const tauEnd = Math.acosh(1 + (this.alpha * sEnd) / C_PC_PER_YEAR) / this.alpha;
    this.warpFloor = THREE.MathUtils.clamp(tauEnd / 1.5, HOUR_YR, this.warpCruise);
    this.tauEngaged = this.tau;
    this.phase = 'align';
  }

  disengage(): void {
    this.target = null;
    this.phase = this.u.lengthSq() > 1e-14 ? 'coast' : 'idle';
  }

  /** Stop dead (no physics — used for resets and teleports). */
  halt(): void {
    this.u.set(0, 0, 0);
    this.thrust = 0;
    this.accel.set(0, 0, 0);
    this.target = null;
    this.manualBeta = null;
    this.phase = 'idle';
  }

  /** Proper time (years) of an accelerate–coast–decelerate trip of `d` pc, from rest to rest. */
  estimateTripTau(d: number): number {
    const a = this.alpha, c = C_PC_PER_YEAR;
    const phiCap = Math.atanh(this.betaCap);
    const phiHalf = Math.acosh(1 + (a * d * 0.5) / c);
    if (phiHalf <= phiCap) return (2 * phiHalf) / a;
    const xBurn = (c / a) * (Math.cosh(phiCap) - 1);
    return (2 * phiCap) / a + (d - 2 * xBurn) / (c * Math.sinh(phiCap));
  }

  /** Estimated proper time (years) to arrival from the current state. */
  estimateRemainingTau(): number {
    if (!this.target) return 0;
    const s = this.remaining;
    const a = this.alpha, c = C_PC_PER_YEAR;
    const phi = Math.asinh(this.u.length());
    if (this.phase === 'brake') return phi / Math.max(this.aReq, 1e-9);
    const xBrake = (c / a) * (Math.cosh(phi) - 1);
    const extra = Math.max(0, s - xBrake);
    return phi / a + (extra > 0 ? this.estimateTripTau(extra) : 0);
  }

  update(dtReal: number): void {
    if (dtReal <= 0) return;
    this.sinceEngage += dtReal;
    if (this.target) {
      this.updateWarpAuto(dtReal);
      this.autopilotAttitude(dtReal);
    }
    const dTau = this.warp * dtReal;
    this.integrate(dTau);
  }

  /** Autopilot attitude: point the nose along the thrust direction the current phase needs. */
  private autopilotAttitude(dtReal: number): void {
    const tgt = this.target!;
    const r = this.tmp.copy(tgt).sub(this.position);
    const dist = r.length();
    r.divideScalar(Math.max(dist, 1e-300));
    const um = this.u.length();
    const s = Math.max(0, dist - this.arrive);
    const phi = Math.asinh(um);
    const a = this.alpha;
    this.aReq = s > 0 ? (C_PC_PER_YEAR * (Math.cosh(phi) - 1)) / s : Infinity;
    // Desired thrust directions. While speeding up: along the destination line r̂, tilted against any
    // velocity across the line (u⊥) by atan(3|u⊥|) so sideways drift dies away on a ~1/(3α) timescale.
    // While braking: against the motion.
    const fwd = this.forward(this.tmp2);
    const wantGo = this.dir.copy(this.u).addScaledVector(r, -this.u.dot(r)).multiplyScalar(-3).add(r).normalize();
    if (this.phase === 'align') {
      if (fwd.dot(wantGo) > 0.995 && this.sinceEngage > 0.8) this.phase = 'accelerate';
      if (um > 1e-9 && this.aReq > 0.9 * a) this.phase = 'flip';
    } else if (this.phase === 'accelerate' || this.phase === 'coast') {
      if (this.aReq >= 0.9 * a && um > 1e-12) this.phase = 'flip';
      else if (this.beta >= this.betaCap * 0.99999) this.phase = 'coast';
      else this.phase = 'accelerate';
    } else if (this.phase === 'flip') {
      const back = this.tmp3.copy(this.u).normalize().negate();
      if (fwd.dot(back) > 0.995) this.phase = 'brake';
    }
    if (this.phase === 'align' || this.phase === 'accelerate' || this.phase === 'coast') {
      this.slewToward(wantGo, dtReal);
    } else {
      const back = um > 1e-12 ? this.tmp3.copy(this.u).normalize().negate() : this.tmp3.copy(r).negate();
      this.slewToward(back, dtReal);
    }
  }

  /** Proper acceleration for the current phase (c/yr), world frame. */
  private computeAccel(): void {
    const a = this.alpha;
    const fwd = this.forward(this.tmp2);
    this.accel.set(0, 0, 0);
    this.thrust = 0;
    if (this.target) {
      const r = this.tmp.copy(this.target).sub(this.position);
      const dist = r.length();
      r.divideScalar(Math.max(dist, 1e-300));
      const s = Math.max(0, dist - this.arrive);
      const um = this.u.length();
      if (this.phase === 'accelerate') {
        const align = THREE.MathUtils.smoothstep(fwd.dot(this.dir), 0.97, 0.999);
        this.thrust = align;
        this.accel.copy(fwd).multiplyScalar(a * align);
      } else if (this.phase === 'brake') {
        const phi = Math.asinh(um);
        const req = s > 0 ? (C_PC_PER_YEAR * (Math.cosh(phi) - 1)) / s : a;
        this.aReq = req;
        const back = this.tmp3.copy(this.u).normalize().negate();
        const align = THREE.MathUtils.smoothstep(fwd.dot(back), 0.97, 0.999);
        const mag = Math.min(req, a * 1.25) * align;
        this.thrust = Math.min(1, mag / a);
        this.accel.copy(fwd).multiplyScalar(mag);
        // Cancel drift off the destination line with the attitude jets (≤ 20 % α), on a time scale
        // well inside the remaining braking time.
        const tb = Math.max(1e-7, phi / Math.max(req, 1e-9));
        const lat = this.tmp3.copy(this.u).addScaledVector(r, -this.u.dot(r)).multiplyScalar(-1 / (0.15 * tb));
        const lm = lat.length();
        if (lm > 0.2 * a) lat.multiplyScalar((0.2 * a) / lm);
        this.accel.add(lat);
      }
    } else if (this.manualBeta !== null) {
      const b = Math.min(Math.abs(this.manualBeta), this.betaCap);
      const uDes = b / Math.sqrt(1 - b * b);
      const err = this.tmp.copy(fwd).multiplyScalar(uDes).sub(this.u);
      // Proportional speed hold with a 3-day response, saturating at α.
      const cmd = err.divideScalar(3 * DAY_YR);
      const along = cmd.dot(fwd);
      const main = THREE.MathUtils.clamp(along, 0, a);
      this.thrust = main / a;
      this.accel.copy(fwd).multiplyScalar(main);
      // Retro jets / flight assist for the rest (≤ 35 % α): lets you slow down and trim drift.
      const rest = cmd.addScaledVector(fwd, -main);
      const rm = rest.length();
      if (rm > 0.35 * a) rest.multiplyScalar((0.35 * a) / rm);
      this.accel.add(rest);
    }
  }

  private integrate(dTau: number): void {
    if (dTau <= 0) return;
    let left = dTau;
    let guard = 0;
    while (left > 0 && guard++ < 400) {
      this.computeAccel();
      const a = Math.max(this.accel.length(), 1e-12);
      // Step limits: Δu ≤ 0.01; ≤ 20 % of the remaining distance; ≤ 1/4 of a manual response time.
      let h = Math.min(left, 0.01 / a);
      if (this.target) {
        const speed = (this.u.length() / Math.sqrt(1 + this.u.lengthSq())) * C_PC_PER_YEAR;
        const s = this.remaining;
        if (speed > 0 && s > 0) h = Math.min(h, (0.2 * s) / speed);
      } else if (this.manualBeta !== null) h = Math.min(h, 0.75 * DAY_YR);
      h = Math.max(h, dTau / 400);
      const g0 = Math.sqrt(1 + this.u.lengthSq());
      const u0 = this.tmp2.copy(this.u);
      stepProperVelocity(this.u, this.accel, h);
      const um = this.u.length();
      const uCap = this.betaCap / Math.sqrt(1 - this.betaCap * this.betaCap);
      if (um > uCap) this.u.multiplyScalar(uCap / um);
      const g1 = Math.sqrt(1 + this.u.lengthSq());
      this.position.addScaledVector(u0.add(this.u), 0.5 * C_PC_PER_YEAR * h);
      this.tau += h;
      this.t += 0.5 * (g0 + g1) * h;
      left -= h;
      if (this.target && this.checkArrival()) break;
    }
  }

  private checkArrival(): boolean {
    if (this.phase !== 'brake') return false;
    const tgt = this.target!;
    const r = this.tmp.copy(tgt).sub(this.position);
    const dist = r.length();
    const s = dist - this.arrive;
    const closing = this.u.dot(r) / Math.max(dist, 1e-300);
    const tiny = Math.max(1e-10, this.arrive * 1e-4);
    if (s <= tiny || closing <= 0 || this.u.length() < 1e-9) {
      // Settle exactly at the arrival point, at rest.
      const endX = tgt.x - (r.x / Math.max(dist, 1e-300)) * this.arrive;
      const endY = tgt.y - (r.y / Math.max(dist, 1e-300)) * this.arrive;
      const endZ = tgt.z - (r.z / Math.max(dist, 1e-300)) * this.arrive;
      this.lastSnap = Math.hypot(this.position.x - endX, this.position.y - endY, this.position.z - endZ);
      this.position.copy(tgt).addScaledVector(r.divideScalar(Math.max(dist, 1e-300)), -this.arrive);
      this.u.set(0, 0, 0);
      this.accel.set(0, 0, 0);
      this.thrust = 0;
      this.target = null;
      this.phase = 'arrived';
      this.onArrive?.();
      return true;
    }
    return false;
  }

  /**
   * Automatic time warp during autopilot (years of ship time per real second).
   * Near either end of the trip the distance to the departure/arrival point grows or shrinks like
   * (c/α)(cosh ατ − 1); a warp proportional to the proper time from that end, W = τ_end / T, makes the
   * distance change by a constant factor per real second — a smooth logarithmic departure and
   * approach (≈ 0.25 decades/s for T = 3 s) instead of a sudden jump or an endless crawl.
   */
  private updateWarpAuto(dtReal: number): void {
    const T = 3.0;
    let w = this.warpCruise;
    w = Math.min(w, Math.max(this.warpFloor, this.tau - this.tauEngaged) / T + this.warpFloor * 0.5);
    w = Math.min(w, Math.max(this.warpFloor, this.estimateRemainingTau() / T));
    // Flip: slow motion while the nose swings round.
    if (this.phase === 'flip' || this.phase === 'align') w = Math.min(w, Math.max(DAY_YR * 1.5, this.warpCruise * 0.01));
    const k = 1 - Math.exp(-dtReal / 0.3);
    const lw = Math.log(Math.max(this.warp, 1e-12));
    this.warp = Math.exp(lw + (Math.log(Math.max(w, 1e-12)) - lw) * k);
  }

  /** Rotate the nose toward `dir` at the ship's slew rate (eased near the goal). */
  slewToward(dir: THREE.Vector3, dtReal: number): void {
    const fwd = this.forward(_slewFwd);
    const ang = Math.acos(THREE.MathUtils.clamp(fwd.dot(dir), -1, 1));
    if (ang < 1e-7) return;
    const up = _up.set(0, 1, 0).applyQuaternion(this.quaternion);
    if (Math.abs(up.dot(dir)) > 0.98) up.set(1, 0, 0).applyQuaternion(this.quaternion);
    // Matrix4.lookAt(eye, target, up): the resulting basis looks down −Z from eye toward target.
    this.m.lookAt(_zero, dir, up);
    this.qTmp.setFromRotationMatrix(this.m);
    const rate = this.turnRate * (0.2 + 0.8 * Math.min(1, ang / 0.5));
    this.quaternion.slerp(this.qTmp, Math.min(1, (rate * dtReal) / ang)).normalize();
  }
}
const _up = new THREE.Vector3();
const _slewFwd = new THREE.Vector3();

/** Human units for a time warp given in years per second. */
export function describeWarp(yearsPerSecond: number): string {
  const s = yearsPerSecond * 365.25 * 86400;
  if (s < 1.5) return 'real time';
  if (s < 90) return `1 s = ${Math.round(s)} s`;
  if (s < 5400) return `1 s = ${Math.round(s / 60)} min`;
  if (s < 1.5 * 86400) return `1 s = ${Math.round(s / 3600)} h`;
  if (s < 45 * 86400) return `1 s = ${Math.round(s / 86400)} d`;
  if (yearsPerSecond < 1.5) return `1 s = ${(yearsPerSecond * 12).toFixed(yearsPerSecond * 12 < 10 ? 1 : 0)} mo`;
  return `1 s = ${yearsPerSecond.toFixed(yearsPerSecond < 10 ? 1 : 0)} yr`;
}

export const TIME = { DAY_YR, HOUR_YR };
