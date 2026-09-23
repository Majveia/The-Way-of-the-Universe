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
}

/**
 * Six-degree-of-freedom free-flight camera: drag to look, WASD to move,
 * R/F (or Space/C) up/down, Q/E roll, Shift boost, wheel scales cruise speed.
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
  private look = { x: 0, y: 0 };
  private tmp = new THREE.Vector3();
  private dq = new THREE.Quaternion();
  private e = new THREE.Euler();

  constructor(private input: InputScope | null, o: FlyRigOptions = {}) {
    if (o.position) this.position.copy(o.position);
    if (o.quaternion) this.quaternion.copy(o.quaternion);
    this.speed = o.speed ?? 1;
    this.inertia = o.inertia ?? 0.35;
    this.lookSpeed = o.lookSpeed ?? 0.0035;
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
    const m = new THREE.Matrix4().lookAt(this.position, target, this.tmp.set(0, 1, 0).applyQuaternion(this.quaternion));
    this.quaternion.setFromRotationMatrix(m);
  }

  update(dt: number): void {
    const inp = this.input;
    // Look: yaw about local up, pitch about local right (true 6DOF, no gimbal lock).
    if (this.look.x || this.look.y) {
      this.e.set(-this.look.y * this.lookSpeed, -this.look.x * this.lookSpeed, 0, 'YXZ');
      this.dq.setFromEuler(this.e);
      this.quaternion.multiply(this.dq).normalize();
      this.look.x = this.look.y = 0;
    }
    const want = this.tmp.set(0, 0, 0);
    if (inp && this.enabled) {
      const k = (c: string) => (inp.isDown(c) ? 1 : 0);
      want.x = k('KeyD') - k('KeyA');
      want.y = k('KeyR') + k('Space') - k('KeyF') - k('KeyC');
      want.z = k('KeyS') - k('KeyW');
      const roll = k('KeyQ') - k('KeyE');
      if (roll) {
        this.dq.setFromAxisAngle(new THREE.Vector3(0, 0, 1), roll * dt * 1.2);
        this.quaternion.multiply(this.dq).normalize();
      }
      const boost = inp.isDown('ShiftLeft') || inp.isDown('ShiftRight') ? 8 : 1;
      if (want.lengthSq() > 0) want.normalize().multiplyScalar(this.speed * boost * this.speedScale());
    }
    want.applyQuaternion(this.quaternion);
    const a = this.inertia > 0 ? 1 - Math.exp(-dt / this.inertia) : 1;
    this.velocity.lerp(want, a);
    this.position.addScaledVector(this.velocity, dt);
  }

  applyTo(camera: THREE.Camera, origin?: THREE.Vector3): void {
    camera.position.copy(this.position);
    if (origin) camera.position.sub(origin);
    camera.quaternion.copy(this.quaternion);
    camera.updateMatrixWorld();
  }
}
