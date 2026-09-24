import * as THREE from 'three';
import { OrbitRig } from '../../core/rigs/OrbitRig';
import type { InputScope } from '../../core/Input';

export type ShipView = 'chase' | 'cockpit' | 'orbit';

/**
 * Cameras around the ship, in the ship layer's camera-relative frame (ship at the origin, world axes).
 *
 *  chase   spring-damped follow from behind and above. In manual flight it follows the ship's attitude;
 *          under autopilot it follows the direction of travel instead, so during the flip-and-burn
 *          the ship turns to face you while its drive fires toward the destination.
 *          Dragging looks around the ship; the view drifts back after a few seconds.
 *  cockpit the pilot's eye inside the canopy.
 *  orbit   free orbit around the ship (drag / wheel / pinch).
 */
export class ShipCamera {
  mode: ShipView = 'chase';
  readonly camera: THREE.PerspectiveCamera;
  readonly orbit: OrbitRig;
  /** Chase distance and height (m); the wheel scales the distance. */
  distance = 36;
  height = 7.2;
  /** Extra free-look angles in chase view (radians), decaying back to zero. */
  lookYaw = 0;
  lookPitch = 0;
  /** Persistent framing offsets for chase view (radians) — a cinematic 3/4 angle for presets. Cleared by free look. */
  yawBias = 0;
  pitchBias = 0;
  private idle = 10;
  private follow = new THREE.Quaternion();
  private followInit = false;
  private tmpV = new THREE.Vector3();
  private tmpQ = new THREE.Quaternion();
  private m = new THREE.Matrix4();
  private euler = new THREE.Euler();
  /** Smoothed camera position (relative to the ship). */
  private pos = new THREE.Vector3(0, 7, 36);
  private posInit = false;
  /** Seconds for the chase frame to catch up with the ship's attitude. */
  lag = 0.45;

  constructor(input: InputScope | null, fov = 55) {
    this.camera = new THREE.PerspectiveCamera(fov, 1, 0.05, 2e5);
    this.orbit = new OrbitRig(null, { distance: 48, yaw: 0.9, pitch: 0.28, minDistance: 8, maxDistance: 5000, enablePan: false, damping: 0.1 });
    if (input) {
      input.onDrag((e) => {
        if (this.mode === 'orbit') {
          this.orbit.rotate(e.dx, e.dy);
        }
      });
      input.onWheel((e) => {
        if (this.mode === 'orbit') this.orbit.zoom(e.delta * 0.18);
        else if (this.mode === 'chase') this.distance = THREE.MathUtils.clamp(this.distance * Math.exp(e.delta * 0.12), 16, 400);
      });
      input.onPinch((e) => {
        const z = -Math.log(Math.max(0.2, Math.min(5, e.scale)));
        if (this.mode === 'orbit') this.orbit.zoom(z);
        else if (this.mode === 'chase') this.distance = THREE.MathUtils.clamp(this.distance * Math.exp(z), 16, 400);
      });
    }
  }

  /** Free look in chase view (called by the experience when the drag is not steering). */
  look(dx: number, dy: number): void {
    if (this.yawBias || this.pitchBias) {
      // Hand the preset framing over to the (decaying) free look.
      this.lookYaw += this.yawBias;
      this.lookPitch += this.pitchBias;
      this.yawBias = this.pitchBias = 0;
    }
    this.lookYaw -= dx * 0.005;
    this.lookPitch = THREE.MathUtils.clamp(this.lookPitch - dy * 0.005, -1.2, 1.2);
    this.idle = 0;
  }

  /** Jump the smoothed state (after teleports / view changes). */
  snap(): void {
    this.followInit = false;
    this.posInit = false;
  }

  /**
   * @param shipQuat ship attitude (world)
   * @param travelDir world direction of travel for the autopilot frame (null → follow attitude)
   * @param cockpit ship-local eye point
   */
  update(dt: number, shipQuat: THREE.Quaternion, travelDir: THREE.Vector3 | null, cockpit: THREE.Vector3, aspect: number): void {
    const cam = this.camera;
    cam.aspect = aspect;
    if (this.mode === 'orbit') {
      this.orbit.update(dt);
      this.orbit.applyTo(cam);
      cam.updateProjectionMatrix();
      return;
    }
    if (this.mode === 'cockpit') {
      cam.position.copy(cockpit).applyQuaternion(shipQuat);
      // Slight look-down so the nose frames the bottom of the view.
      this.euler.set(0.02 + this.lookPitch, this.lookYaw, 0, 'YXZ');
      this.tmpQ.setFromEuler(this.euler);
      cam.quaternion.copy(shipQuat).multiply(this.tmpQ);
      this.decayLook(dt);
      cam.updateMatrixWorld();
      cam.updateProjectionMatrix();
      return;
    }
    // Chase frame: attitude, or the travel direction with the ship's up.
    const goal = this.tmpQ;
    if (travelDir && travelDir.lengthSq() > 0.5) {
      const up = this.tmpV.set(0, 1, 0).applyQuaternion(this.followInit ? this.follow : shipQuat);
      if (Math.abs(up.dot(travelDir)) > 0.95) up.set(1, 0, 0).applyQuaternion(shipQuat);
      this.m.lookAt(_zero, travelDir, up);
      goal.setFromRotationMatrix(this.m);
    } else goal.copy(shipQuat);
    if (!this.followInit) {
      this.follow.copy(goal);
      this.followInit = true;
    } else {
      const k = dt > 0 ? 1 - Math.exp(-dt / this.lag) : 1;
      this.follow.slerp(goal, k).normalize();
    }
    // Free-look offset applied in the follow frame.
    this.euler.set(this.lookPitch + this.pitchBias, this.lookYaw + this.yawBias, 0, 'YXZ');
    const q = _q.copy(this.follow).multiply(_q2.setFromEuler(this.euler));
    // Portrait screens: back off so the ship keeps a similar share of the (narrow) width.
    const dist = this.distance * THREE.MathUtils.clamp(1.3 / aspect, 1, 2.4);
    const want = this.tmpV.set(0, this.height * (dist / 36), dist).applyQuaternion(q);
    if (!this.posInit) {
      this.pos.copy(want);
      this.posInit = true;
    } else {
      const k = dt > 0 ? 1 - Math.exp(-dt / 0.12) : 1;
      this.pos.lerp(want, k);
    }
    cam.position.copy(this.pos);
    // Look slightly ahead of the ship so it sits in the lower third.
    const ahead = _v.set(0, this.height * 0.35 * (dist / 36), -dist * 0.55).applyQuaternion(q);
    const upv = _v2.set(0, 1, 0).applyQuaternion(q);
    this.m.lookAt(cam.position, ahead, upv);
    cam.quaternion.setFromRotationMatrix(this.m);
    this.decayLook(dt);
    cam.updateMatrixWorld();
    cam.updateProjectionMatrix();
  }

  private decayLook(dt: number): void {
    this.idle += dt;
    if (this.idle > 2.5) {
      const k = 1 - Math.exp(-dt / 0.9);
      this.lookYaw -= this.lookYaw * k;
      this.lookPitch -= this.lookPitch * k;
    }
  }
}

const _zero = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
