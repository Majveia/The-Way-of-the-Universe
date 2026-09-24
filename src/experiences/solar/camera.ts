/**
 * Camera for the solar system: an OrbitRig (drag / wheel / pinch) whose frame is anchored to a
 * moving body. Flights blend the anchor between two moving bodies while the distance follows a
 * log-space path that swells mid-flight when the bodies are far apart (after van Wijk & Nuij 2003,
 * "Smooth and efficient zooming and panning"), so both ends stay in view.
 * "Follow" co-rotates the view with the body's orbit so the Sun (or the parent planet) stays put.
 */
import * as THREE from 'three';
import { OrbitRig } from '../../core/rigs/OrbitRig';
import type { InputScope } from '../../core/Input';
import type { SolarBody } from '../../worlds/solar/SolarSystemModel';

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const smoother = (t: number) => t * t * t * (t * (6 * t - 15) + 10);

interface Flight {
  t: number;
  dur: number;
  from: SolarBody | null;
  fromPoint: THREE.Vector3;
  to: SolarBody;
  d0: number;
  d1: number;
  yaw0: number;
  yaw1: number;
  pitch0: number;
  pitch1: number;
  bump: number;
  target0: THREE.Vector3;
  userTookOver: boolean;
  done?: () => void;
}

export class SolarCamera {
  readonly rig: OrbitRig;
  /** Body the view is anchored to (null = the fixed point `anchorPoint`). */
  anchor: SolarBody | null = null;
  readonly anchorPoint = new THREE.Vector3();
  /** Current camera position (heliocentric AU, float64) and orientation. */
  readonly position = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();
  /** Co-rotate with the anchor's orbit. */
  follow = false;
  fov = 50;
  /** Progress 0..1 of the current flight (1 when idle). */
  progress = 1;
  private flight: Flight | null = null;
  private lastLon = NaN;
  private tmp = new THREE.Vector3();
  private anchorNow = new THREE.Vector3();

  constructor(input: InputScope) {
    this.rig = new OrbitRig(input, {
      distance: 3,
      pitch: 0.5,
      yaw: 0,
      minDistance: 1e-9,
      maxDistance: 6e4,
      damping: 0.14,
      zoomSpeed: 0.2,
      rotateSpeed: 0.0045,
      enablePan: true,
      minPitch: -Math.PI / 2 + 0.02,
      maxPitch: Math.PI / 2 - 0.02,
    });
    const takeOver = () => {
      if (this.flight) this.flight.userTookOver = true;
    };
    input.onDrag(takeOver);
    input.onWheel(takeOver);
    input.onPinch(takeOver);
  }

  get flying(): boolean {
    return this.flight !== null;
  }

  /** Jump instantly. */
  set(body: SolarBody | null, v: { distance?: number; yaw?: number; pitch?: number }, point?: THREE.Vector3): void {
    this.flight = null;
    this.progress = 1;
    this.anchor = body;
    if (point) this.anchorPoint.copy(point);
    this.rig.set({ target: new THREE.Vector3(), ...v });
    this.lastLon = NaN;
  }

  /**
   * Fly to `body`, ending at `distance` (AU) with optional yaw/pitch. Duration grows gently with the
   * logarithm of the zoom ratio.
   */
  flyTo(body: SolarBody, v: { distance: number; yaw?: number; pitch?: number; duration?: number }, done?: () => void): void {
    const rig = this.rig;
    const fromPoint = this.anchorWorld(this.tmp).clone();
    const d0 = rig.distance;
    const d1 = v.distance;
    const sep = fromPoint.distanceTo(body.position);
    const span = Math.max(d0, d1);
    const bump = sep > span * 1.5 ? Math.log(sep / span) * 0.55 : 0;
    const ratio = Math.abs(Math.log(d0 / d1)) + bump * 1.4;
    const dur = v.duration ?? THREE.MathUtils.clamp(1.6 + 0.32 * ratio, 1.6, 6.5);
    let yaw1 = v.yaw ?? rig.yaw;
    while (yaw1 - rig.yaw > Math.PI) yaw1 -= Math.PI * 2;
    while (yaw1 - rig.yaw < -Math.PI) yaw1 += Math.PI * 2;
    this.flight = {
      t: 0,
      dur,
      from: this.anchor,
      fromPoint,
      to: body,
      d0,
      d1,
      yaw0: rig.yaw,
      yaw1,
      pitch0: rig.pitch,
      pitch1: v.pitch ?? rig.pitch,
      bump,
      target0: rig.target.clone(),
      userTookOver: false,
      done,
    };
    this.progress = 0;
    this.lastLon = NaN;
  }

  private anchorWorld(out: THREE.Vector3): THREE.Vector3 {
    return this.anchor ? out.copy(this.anchor.position) : out.copy(this.anchorPoint);
  }

  /** Longitude of the anchor's orbital position (about +Y), for follow mode. */
  private orbitLon(b: SolarBody): number {
    const p = b.parent && b.parent.def.kind !== 'star' ? b.local : b.position;
    return Math.atan2(p.x, p.z);
  }

  update(dt: number): void {
    const rig = this.rig;
    const f = this.flight;
    const a = this.anchorNow;
    if (f) {
      f.t += dt;
      const k = Math.min(1, f.t / f.dur);
      const e = easeInOut(k);
      const eA = smoother(Math.min(1, k * 1.08));
      // Anchor: blend between the (moving) start and the (moving) destination.
      const start = f.from ? f.from.position : f.fromPoint;
      a.copy(start).lerp(f.to.position, eA);
      if (!f.userTookOver) {
        const logD = Math.log(f.d0) + (Math.log(f.d1) - Math.log(f.d0)) * e + f.bump * Math.sin(Math.PI * e);
        const yaw = f.yaw0 + (f.yaw1 - f.yaw0) * e;
        const pitch = f.pitch0 + (f.pitch1 - f.pitch0) * e;
        rig.goal.target.copy(f.target0).multiplyScalar(1 - e);
        rig.target.copy(rig.goal.target);
        rig.goal.logDistance = logD;
        rig.distance = Math.exp(logD);
        rig.goal.yaw = rig.yaw = yaw;
        rig.goal.pitch = rig.pitch = pitch;
      }
      this.progress = k;
      if (k >= 1) {
        this.flight = null;
        this.anchor = f.to;
        this.progress = 1;
        f.done?.();
      }
    } else {
      this.anchorWorld(a);
    }
    // Follow: co-rotate yaw with the anchor's orbital longitude.
    const fb = this.flight ? null : this.anchor;
    if (this.follow && fb) {
      const lon = this.orbitLon(fb);
      if (isFinite(this.lastLon)) {
        let d = lon - this.lastLon;
        if (d > Math.PI) d -= Math.PI * 2;
        if (d < -Math.PI) d += Math.PI * 2;
        rig.yaw += d;
        rig.goal.yaw += d;
      }
      this.lastLon = lon;
    } else this.lastLon = NaN;
    rig.update(this.flight && !this.flight.userTookOver ? 0 : dt);
    this.position.copy(a).add(rig.position);
    this.quaternion.copy(rig.quaternion);
  }

  /** The point the camera looks at (heliocentric AU). */
  lookPoint(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.anchorNow).add(this.rig.target);
  }
}
