import * as THREE from 'three';
import type { InputScope } from '../Input';

export interface FlyRigOptions {
  position?: THREE.Vector3;
  quaternion?: THREE.Quaternion;
  /** Cruise speed in units/second (Shift = ×8 boost). */
  speed?: number;
  /** Seconds to reach target velocity. */
  inertia?: number;
  lookSpeed?: number;
  /**
   * Distance to the nearest object, in rig units. When given, cruise speed scales with it
   * (speed = autoSpeed × distance per second) so flight feels right from metres to megaparsecs.
   */
  nearestDistance?: () => number;
  /** Fraction of the nearest-object distance covered per second at full input (default 0.5). */
  autoSpeed?: number;
  /** Clamp for the automatic speed (units/second). */
  minSpeed?: number;
  maxSpeed?: number;
  /**
   * Throttle mode: W/S (or gamepad triggers) set a persistent throttle in [0, 1] instead of
   * hold-to-move; forward motion then continues at `throttle × speed`. Default false.
   */
  throttleMode?: boolean;
  /** Rate at which W/S change the throttle, per second (default 0.6). */
  throttleRate?: number;
  /** Keyboard / gamepad translation (default true). Turn off when another controller handles thrust. */
  translation?: boolean;
  /** Roll speed for Q/E in rad/s (default 1.2). */
  rollSpeed?: number;
  /** Smoothing time constant for drag/stick look, seconds (0 = immediate, default). */
  lookDamping?: number;
  /** Poll the first connected gamepad (default true). */
  gamepad?: boolean;
}

/** Target for {@link FlyRig.travelTo}. */
export interface TravelTarget {
  /** Point to travel toward. */
  position: THREE.Vector3;
  /** Stop this far short of `position` (default 0). */
  arriveDistance?: number;
  /** Point to face on arrival (default: `position`). */
  lookAt?: THREE.Vector3;
}

export interface TravelOptions {
  /** Seconds for the whole trip (default: grows gently with the logarithm of the distance ratio). */
  duration?: number;
  /**
   * 'linear' eases position along a straight line; 'log' eases the *logarithm* of the distance to the
   * target (constant fraction of the remaining distance per second mid-flight — the "Powers of Ten"
   * feel for trips spanning many orders of magnitude); 'auto' picks log when the start/end distance
   * ratio exceeds 30.
   */
  profile?: 'auto' | 'linear' | 'log';
  /** Turn to face the target during the first part of the trip (default true). */
  orient?: boolean;
  onArrive?: () => void;
}

interface Travel {
  t: number;
  dur: number;
  p0: THREE.Vector3;
  v0: THREE.Vector3;
  q0: THREE.Quaternion;
  q1: THREE.Quaternion;
  target: THREE.Vector3;
  end: THREE.Vector3;
  dir: THREE.Vector3;
  d0: number;
  d1: number;
  log: boolean;
  orient: boolean;
  onArrive?: () => void;
}

const smoother = (t: number) => t * t * t * (t * (6 * t - 15) + 10);

/**
 * Six-degree-of-freedom free-flight camera: drag to look, WASD to move,
 * R/F (or Space/C) up/down, Q/E roll, Shift boost, wheel scales cruise speed.
 *
 * Extensions (all optional, API-compatible): inertia; a throttle mode; automatic speed scaling from a
 * distance-to-nearest-object callback; a velocity-matched autopilot `travelTo()` with a smooth
 * (quintic, zero-jerk-at-ends) acceleration/deceleration profile in linear or logarithmic distance;
 * and gamepad input (left stick move, right stick look, triggers throttle/vertical, bumpers roll).
 */
export class FlyRig {
  readonly position = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();
  readonly velocity = new THREE.Vector3();
  speed: number;
  inertia: number;
  lookSpeed: number;
  enabled = true;
  /** Optional hook to scale speed with context (e.g. distance to nearest body). */
  speedScale: () => number = () => 1;
  /** Distance to the nearest object (enables automatic speed); see FlyRigOptions. */
  nearestDistance: (() => number) | null;
  autoSpeed: number;
  minSpeed: number;
  maxSpeed: number;
  throttleMode: boolean;
  throttleRate: number;
  /** Persistent throttle in [0, 1] (throttle mode). */
  throttle = 0;
  translation: boolean;
  rollSpeed: number;
  lookDamping: number;
  gamepad: boolean;
  /** Called when a travelTo() completes. */
  onArrive: (() => void) | null = null;
  /** Latest steering input (radians this frame, before smoothing) — for banking effects. */
  readonly steer = { yaw: 0, pitch: 0, roll: 0 };
  private look = { x: 0, y: 0 };
  private lookVel = { x: 0, y: 0 };
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private dq = new THREE.Quaternion();
  private e = new THREE.Euler();
  private m = new THREE.Matrix4();
  private travel: Travel | null = null;
  private zAxis = new THREE.Vector3(0, 0, 1);

  constructor(private input: InputScope | null, o: FlyRigOptions = {}) {
    if (o.position) this.position.copy(o.position);
    if (o.quaternion) this.quaternion.copy(o.quaternion);
    this.speed = o.speed ?? 1;
    this.inertia = o.inertia ?? 0.35;
    this.lookSpeed = o.lookSpeed ?? 0.0035;
    this.nearestDistance = o.nearestDistance ?? null;
    this.autoSpeed = o.autoSpeed ?? 0.5;
    this.minSpeed = o.minSpeed ?? 0;
    this.maxSpeed = o.maxSpeed ?? Infinity;
    this.throttleMode = o.throttleMode ?? false;
    this.throttleRate = o.throttleRate ?? 0.6;
    this.translation = o.translation ?? true;
    this.rollSpeed = o.rollSpeed ?? 1.2;
    this.lookDamping = o.lookDamping ?? 0;
    this.gamepad = o.gamepad ?? true;
    if (input) {
      input.onDrag((e) => {
        if (!this.enabled) return;
        this.look.x += e.dx;
        this.look.y += e.dy;
      });
      input.onWheel((e) => {
        if (!this.enabled) return;
        this.speed *= Math.exp(-e.delta * 0.25);
      });
    }
  }

  lookAt(target: THREE.Vector3): void {
    const m = this.m.lookAt(this.position, target, this.tmp.set(0, 1, 0).applyQuaternion(this.quaternion));
    this.quaternion.setFromRotationMatrix(m);
  }

  /** Add look input programmatically (CSS-pixel-equivalent deltas, like a drag). */
  addLook(dx: number, dy: number): void {
    this.look.x += dx;
    this.look.y += dy;
  }

  /** Effective cruise speed right now (units/s), including auto speed and speedScale. */
  cruiseSpeed(): number {
    let s = this.speed;
    if (this.nearestDistance) {
      const d = Math.max(0, this.nearestDistance());
      s = THREE.MathUtils.clamp(this.autoSpeed * d * this.speed, this.minSpeed, this.maxSpeed);
    }
    return s * this.speedScale();
  }

  /**
   * Autopilot: fly to a target with a smooth, velocity-matched profile. The current velocity is
   * blended out over the trip (no jolt at departure) and the rig arrives at rest.
   */
  travelTo(target: THREE.Vector3 | TravelTarget, opts: TravelOptions = {}): void {
    const t: TravelTarget = target instanceof THREE.Vector3 ? { position: target } : target;
    const p0 = this.position.clone();
    const dir = this.tmp.copy(t.position).sub(p0);
    const dist = dir.length();
    if (dist < 1e-12) return;
    dir.divideScalar(dist);
    const arrive = Math.max(0, Math.min(t.arriveDistance ?? 0, dist * 0.999));
    const end = t.position.clone().addScaledVector(dir, -arrive);
    const d0 = dist;
    const d1 = Math.max(arrive, dist * 1e-9);
    const ratio = d0 / Math.max(d1, 1e-300);
    const profile = opts.profile ?? 'auto';
    const log = profile === 'log' || (profile === 'auto' && ratio > 30 && arrive > 0);
    const dur = opts.duration ?? THREE.MathUtils.clamp(2.5 + 1.1 * Math.log10(Math.max(ratio, 1)), 2.5, 14);
    const look = t.lookAt ?? t.position;
    const q1 = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().lookAt(end, look, this.tmp2.set(0, 1, 0).applyQuaternion(this.quaternion)),
    );
    this.travel = {
      t: 0,
      dur,
      p0,
      v0: this.velocity.clone(),
      q0: this.quaternion.clone(),
      q1,
      target: t.position.clone(),
      end,
      dir: dir.clone(),
      d0,
      d1,
      log,
      orient: opts.orient ?? true,
      onArrive: opts.onArrive,
    };
  }

  cancelTravel(): void {
    this.travel = null;
  }
  get traveling(): boolean {
    return this.travel !== null;
  }
  /** 0..1 progress of the current trip (1 when idle). */
  get travelProgress(): number {
    return this.travel ? Math.min(1, this.travel.t / this.travel.dur) : 1;
  }

  update(dt: number): void {
    const inp = this.input;
    const pad = this.gamepad ? readGamepad() : null;
    // Look: yaw about local up, pitch about local right (true 6DOF, no gimbal lock).
    let lx = this.look.x, ly = this.look.y;
    this.look.x = this.look.y = 0;
    if (pad && this.enabled) {
      lx += pad.rx * 520 * dt;
      ly += pad.ry * 520 * dt;
    }
    if (this.lookDamping > 0 && dt > 0) {
      const k = 1 - Math.exp(-dt / this.lookDamping);
      this.lookVel.x += (lx / dt - this.lookVel.x) * k;
      this.lookVel.y += (ly / dt - this.lookVel.y) * k;
      lx = this.lookVel.x * dt;
      ly = this.lookVel.y * dt;
    }
    this.steer.yaw = -lx * this.lookSpeed;
    this.steer.pitch = -ly * this.lookSpeed;
    this.steer.roll = 0;
    if ((lx || ly) && !(this.travel && this.travel.orient)) {
      this.e.set(-ly * this.lookSpeed, -lx * this.lookSpeed, 0, 'YXZ');
      this.dq.setFromEuler(this.e);
      this.quaternion.multiply(this.dq).normalize();
    }

    if (this.travel) {
      this.updateTravel(dt);
      return;
    }

    const want = this.tmp.set(0, 0, 0);
    if (this.enabled) {
      const k = (c: string) => (inp && inp.isDown(c) ? 1 : 0);
      let roll = k('KeyQ') - k('KeyE');
      if (pad) roll += pad.roll;
      if (roll) {
        this.steer.roll = roll * dt * this.rollSpeed;
        this.dq.setFromAxisAngle(this.zAxis, roll * dt * this.rollSpeed);
        this.quaternion.multiply(this.dq).normalize();
      }
      if (this.translation) {
        want.x = k('KeyD') - k('KeyA');
        want.y = k('KeyR') + k('Space') - k('KeyF') - k('KeyC');
        let fwd = k('KeyS') - k('KeyW');
        if (pad) {
          want.x += pad.lx;
          want.y += pad.up;
          fwd += pad.ly;
        }
        const boost = inp && (inp.isDown('ShiftLeft') || inp.isDown('ShiftRight')) ? 8 : 1;
        const cruise = this.cruiseSpeed();
        if (this.throttleMode) {
          this.throttle = THREE.MathUtils.clamp(this.throttle - fwd * this.throttleRate * dt, 0, 1);
          if (inp && inp.isDown('KeyX')) this.throttle = 0;
          want.z = -this.throttle;
          want.x *= 0.5;
          want.y *= 0.5;
          want.multiplyScalar(cruise * boost);
        } else {
          want.z = fwd;
          if (want.lengthSq() > 1) want.normalize();
          want.multiplyScalar(cruise * boost);
        }
      }
    }
    want.applyQuaternion(this.quaternion);
    const a = this.inertia > 0 ? 1 - Math.exp(-dt / this.inertia) : 1;
    this.velocity.lerp(want, a);
    this.position.addScaledVector(this.velocity, dt);
  }

  private updateTravel(dt: number): void {
    const tr = this.travel!;
    const prev = this.tmp2.copy(this.position);
    tr.t = Math.min(tr.dur, tr.t + dt);
    const u = tr.t / tr.dur;
    const e = smoother(u);
    // Base path: straight line from p0 to end, eased linearly or in log-distance to the target.
    if (tr.log) {
      const d = tr.d0 * Math.pow(tr.d1 / tr.d0, e);
      this.position.copy(tr.target).addScaledVector(tr.dir, -d);
    } else {
      this.position.lerpVectors(tr.p0, tr.end, e);
    }
    // Velocity matching: add v0·h(t) with h(0)=0, h'(0)=1, h(T)=h'(T)=0 → no jolt at departure.
    const h = tr.t * (1 - u) * (1 - u);
    this.position.addScaledVector(tr.v0, h);
    if (tr.orient) {
      // Turn to face the destination within the first ~2 s (while the eased path is still slow),
      // so the ship never visibly slides sideways at speed.
      const k = smoother(Math.min(1, tr.t / Math.min(2.2, 0.35 * tr.dur)));
      this.quaternion.slerpQuaternions(tr.q0, tr.q1, k);
    }
    if (dt > 0) this.velocity.copy(this.position).sub(prev).divideScalar(dt);
    if (tr.t >= tr.dur) {
      this.position.copy(tr.end);
      this.velocity.set(0, 0, 0);
      this.travel = null;
      tr.onArrive?.();
      this.onArrive?.();
    }
  }

  applyTo(camera: THREE.Camera, origin?: THREE.Vector3): void {
    camera.position.copy(this.position);
    if (origin) camera.position.sub(origin);
    camera.quaternion.copy(this.quaternion);
    camera.updateMatrixWorld();
  }
}

/** Standard-mapping gamepad state with a radial dead zone (null if none connected). */
export interface PadState {
  lx: number;
  ly: number;
  rx: number;
  ry: number;
  /** Right trigger − left trigger. */
  up: number;
  /** Right bumper − left bumper. */
  roll: number;
  buttons: readonly boolean[];
}

const DEAD = 0.14;
const dz = (x: number, y: number): [number, number] => {
  const m = Math.hypot(x, y);
  if (m < DEAD) return [0, 0];
  const s = (m - DEAD) / (1 - DEAD) / m;
  return [x * s, y * s];
};

export function readGamepad(): PadState | null {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
  let pads: (Gamepad | null)[];
  try {
    pads = navigator.getGamepads();
  } catch {
    return null;
  }
  const p = pads.find((g) => g && g.connected && g.axes.length >= 4);
  if (!p) return null;
  const [lx, ly] = dz(p.axes[0], p.axes[1]);
  const [rx, ry] = dz(p.axes[2], p.axes[3]);
  const b = (i: number) => (p.buttons[i] ? p.buttons[i].value : 0);
  return {
    lx,
    ly,
    rx,
    ry,
    up: b(7) - b(6),
    roll: b(4) - b(5),
    buttons: p.buttons.map((x) => x.pressed),
  };
}
