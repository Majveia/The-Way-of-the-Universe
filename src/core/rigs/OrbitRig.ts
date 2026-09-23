import * as THREE from 'three';
import type { InputScope } from '../Input';

export interface OrbitRigOptions {
  target?: THREE.Vector3;
  distance?: number;
  minDistance?: number;
  maxDistance?: number;
  /** Radians around +Y. 0 = camera on +Z looking toward -Z. */
  yaw?: number;
  /** Radians above the XZ plane. */
  pitch?: number;
  minPitch?: number;
  maxPitch?: number;
  /** Smoothing time constant in seconds (0 = immediate). */
  damping?: number;
  rotateSpeed?: number;
  zoomSpeed?: number;
  panSpeed?: number;
  /** Radians/second of automatic yaw after `idleDelay` seconds without input (0 = off). */
  autoRotate?: number;
  idleDelay?: number;
  enablePan?: boolean;
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * Smooth orbit camera with log-space zoom (works from 1e-6 to 1e12 units).
 * All state is float64 (JS numbers); only the final camera transform reaches the GPU.
 */
export class OrbitRig {
  readonly target = new THREE.Vector3();
  distance: number;
  yaw: number;
  pitch: number;
  readonly goal: { target: THREE.Vector3; logDistance: number; yaw: number; pitch: number };
  minDistance: number;
  maxDistance: number;
  minPitch: number;
  maxPitch: number;
  damping: number;
  rotateSpeed: number;
  zoomSpeed: number;
  panSpeed: number;
  autoRotate: number;
  idleDelay: number;
  enablePan: boolean;
  enabled = true;
  /** Camera position (float64) and orientation, updated by update(). */
  readonly position = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();
  private idle = 0;
  private anim: {
    t: number;
    dur: number;
    from: { target: THREE.Vector3; logDistance: number; yaw: number; pitch: number };
    to: { target: THREE.Vector3; logDistance: number; yaw: number; pitch: number };
    done?: () => void;
  } | null = null;
  private m = new THREE.Matrix4();
  private tmp = new THREE.Vector3();

  constructor(private input: InputScope | null, o: OrbitRigOptions = {}) {
    this.distance = o.distance ?? 10;
    this.yaw = o.yaw ?? 0;
    this.pitch = o.pitch ?? 0.3;
    if (o.target) this.target.copy(o.target);
    this.minDistance = o.minDistance ?? 1e-6;
    this.maxDistance = o.maxDistance ?? 1e12;
    this.minPitch = o.minPitch ?? -Math.PI / 2 + 0.01;
    this.maxPitch = o.maxPitch ?? Math.PI / 2 - 0.01;
    this.damping = o.damping ?? 0.12;
    this.rotateSpeed = o.rotateSpeed ?? 0.005;
    this.zoomSpeed = o.zoomSpeed ?? 0.18;
    this.panSpeed = o.panSpeed ?? 1;
    this.autoRotate = o.autoRotate ?? 0;
    this.idleDelay = o.idleDelay ?? 6;
    this.enablePan = o.enablePan ?? true;
    this.goal = { target: this.target.clone(), logDistance: Math.log(this.distance), yaw: this.yaw, pitch: this.pitch };
    if (input) this.bind(input);
    this.update(0);
  }

  private bind(input: InputScope): void {
    input.onDrag((e) => {
      if (!this.enabled) return;
      this.idle = 0;
      this.anim = null;
      const pan = this.enablePan && (e.button !== 'primary' || e.shift);
      if (pan) this.pan(e.dx, e.dy);
      else this.rotate(e.dx, e.dy);
    });
    input.onWheel((e) => {
      if (!this.enabled) return;
      this.idle = 0;
      this.anim = null;
      this.zoom(e.delta * this.zoomSpeed * (e.shift ? 0.25 : 1));
    });
    input.onPinch((e) => {
      if (!this.enabled) return;
      this.idle = 0;
      this.anim = null;
      this.zoom(-Math.log(Math.max(0.2, Math.min(5, e.scale))));
      if (this.enablePan) this.pan(e.dx, e.dy);
    });
  }

  rotate(dx: number, dy: number): void {
    this.goal.yaw -= dx * this.rotateSpeed;
    this.goal.pitch = THREE.MathUtils.clamp(this.goal.pitch + dy * this.rotateSpeed, this.minPitch, this.maxPitch);
  }

  /** Positive = zoom out, in natural-log units of distance. */
  zoom(dLog: number): void {
    this.goal.logDistance = THREE.MathUtils.clamp(
      this.goal.logDistance + dLog,
      Math.log(this.minDistance),
      Math.log(this.maxDistance),
    );
  }

  pan(dx: number, dy: number): void {
    const h = Math.max(1, window.innerHeight);
    const d = Math.exp(this.goal.logDistance);
    const s = (d / h) * 1.2 * this.panSpeed;
    const right = this.tmp.set(1, 0, 0).applyQuaternion(this.quaternion);
    this.goal.target.addScaledVector(right, -dx * s);
    const up = this.tmp.set(0, 1, 0).applyQuaternion(this.quaternion);
    this.goal.target.addScaledVector(up, dy * s);
  }

  /** Animate to a new view. Distance interpolates in log space; yaw takes the short way. */
  flyTo(to: { target?: THREE.Vector3; distance?: number; yaw?: number; pitch?: number }, duration = 2, done?: () => void): void {
    const from = { target: this.goal.target.clone(), logDistance: this.goal.logDistance, yaw: this.goal.yaw, pitch: this.goal.pitch };
    let yaw = to.yaw ?? from.yaw;
    while (yaw - from.yaw > Math.PI) yaw -= Math.PI * 2;
    while (yaw - from.yaw < -Math.PI) yaw += Math.PI * 2;
    this.anim = {
      t: 0,
      dur: Math.max(0.001, duration),
      from,
      to: {
        target: (to.target ?? from.target).clone(),
        logDistance: to.distance !== undefined ? Math.log(to.distance) : from.logDistance,
        yaw,
        pitch: to.pitch ?? from.pitch,
      },
      done,
    };
  }

  /** Jump immediately (no smoothing). */
  set(v: { target?: THREE.Vector3; distance?: number; yaw?: number; pitch?: number }): void {
    if (v.target) {
      this.goal.target.copy(v.target);
      this.target.copy(v.target);
    }
    if (v.distance !== undefined) {
      this.goal.logDistance = Math.log(v.distance);
      this.distance = v.distance;
    }
    if (v.yaw !== undefined) this.goal.yaw = this.yaw = v.yaw;
    if (v.pitch !== undefined) this.goal.pitch = this.pitch = v.pitch;
    this.anim = null;
    this.update(0);
  }

  get animating(): boolean {
    return this.anim !== null;
  }

  update(dt: number): void {
    if (this.anim) {
      const a = this.anim;
      a.t += dt;
      const k = easeInOut(Math.min(1, a.t / a.dur));
      this.goal.target.lerpVectors(a.from.target, a.to.target, k);
      this.goal.logDistance = a.from.logDistance + (a.to.logDistance - a.from.logDistance) * k;
      this.goal.yaw = a.from.yaw + (a.to.yaw - a.from.yaw) * k;
      this.goal.pitch = a.from.pitch + (a.to.pitch - a.from.pitch) * k;
      if (a.t >= a.dur) {
        this.anim = null;
        a.done?.();
      }
    } else {
      this.idle += dt;
      if (this.autoRotate && this.idle > this.idleDelay) this.goal.yaw += this.autoRotate * dt;
    }
    const k = this.damping > 0 && dt > 0 ? 1 - Math.exp(-dt / this.damping) : 1;
    this.target.lerp(this.goal.target, k);
    const logD = Math.log(this.distance);
    this.distance = Math.exp(logD + (this.goal.logDistance - logD) * k);
    this.yaw += (this.goal.yaw - this.yaw) * k;
    this.pitch += (this.goal.pitch - this.pitch) * k;

    const cp = Math.cos(this.pitch);
    this.position.set(
      this.target.x + this.distance * cp * Math.sin(this.yaw),
      this.target.y + this.distance * Math.sin(this.pitch),
      this.target.z + this.distance * cp * Math.cos(this.yaw),
    );
    this.m.lookAt(this.position, this.target, THREE.Object3D.DEFAULT_UP);
    this.quaternion.setFromRotationMatrix(this.m);
  }

  /**
   * Copy the view into a camera. With `origin`, the camera is placed relative to it
   * (camera-relative rendering keeps float32 precision near the viewer).
   */
  applyTo(camera: THREE.Camera, origin?: THREE.Vector3): void {
    camera.position.copy(this.position);
    if (origin) camera.position.sub(origin);
    camera.quaternion.copy(this.quaternion);
    camera.updateMatrixWorld();
  }
}
