import * as THREE from 'three';
import type { ExperienceContext } from '../../core/types';
import { NebulaVolume } from '../../worlds/nebula/NebulaVolume';
import { NebulaStars } from '../../worlds/nebula/NebulaStars';
import { galacticDir } from '../../worlds/explorer/universe';

/**
 * The Orion Nebula (M42) as a stop in the solar neighbourhood: the nearest large stellar nursery,
 * l = 209.0°, b = −19.4°, 412 pc away (VLBA parallax, Menten et al. 2007: 414 ± 7 pc), ionised by the
 * Trapezium's O stars (θ¹ Ori C, ~ 39 000 K).
 *
 * Rendered by the nebula module's photoionised-gas volume (emission lines Hα 656 nm red, [OIII]
 * 501 nm teal, dust extinction and scattering, embedded stars). Its structure is the module's generic
 * star-forming-region model, not M42's measured 3D shape; the UI says so. The volume is built lazily
 * near Orion and faded in with distance; its dust also extinguishes the stars behind it.
 */
export const M42 = { l: 209.01, b: -19.38, distancePc: 412 };

export class NebulaRegime {
  readonly position = galacticDir(M42.l, M42.b).multiplyScalar(M42.distancePc);
  volume: NebulaVolume | null = null;
  stars: NebulaStars | null = null;
  weight = 0;
  private cam = new THREE.PerspectiveCamera(55, 1, 1e-4, 1e4);
  private calibrating = false;
  private readyAt = -1;
  /** Half-size of the model volume (pc). */
  half = 4.5;

  constructor(private ctx: ExperienceContext) {}

  /** Build / drop by distance (pc) from the nebula. */
  manage(d: number, wanted: boolean, time: number): void {
    if (!this.volume && (d < 150 || wanted)) {
      const v = new NebulaVolume({ variant: 'pillars', seed: 0, detail: this.ctx.quality.detail });
      this.half = v.preset.half;
      this.volume = v;
      this.stars = new NebulaStars({ stars: v.stars, fieldStars: 0, fieldRadius: this.half * 4, fieldInner: this.half, seed: 42 });
      this.stars.setVolume(v);
      this.readyAt = -1;
    } else if (this.volume && d > 260 && !wanted) {
      this.volume.dispose();
      this.stars?.dispose();
      this.volume = null;
      this.stars = null;
    }
    const v = this.volume;
    if (!v) {
      this.weight = 0;
      return;
    }
    if (v.ready && !v.metered && !this.calibrating) {
      this.calibrating = true;
      // The meter renders the preset's reference view in nebula-local coordinates: do it with the
      // volume at its own origin (its render call happens synchronously inside calibrate()).
      const keep = v.object.position.clone();
      v.object.position.set(0, 0, 0);
      v.object.updateMatrixWorld();
      void v.calibrate(this.ctx.renderer).finally(() => (this.calibrating = false));
      v.object.position.copy(keep);
      v.object.updateMatrixWorld();
    }
    if (v.ready && this.readyAt < 0) this.readyAt = time;
    // (Headless captures run a few frames per minute: skip the fade-in there.)
    const age = this.readyAt < 0 ? 0 : this.ctx.engine.shotMode ? 10 : time - this.readyAt;
    this.weight = (1 - THREE.MathUtils.smoothstep(d, 90, 150)) * THREE.MathUtils.smoothstep(age, 0, 1.2);
  }

  /** Draw (camera attitude in local = root axes; camLocal in pc). `exposure` in the explorer's scale. */
  render(target: THREE.WebGLRenderTarget, camLocal: THREE.Vector3, quat: THREE.Quaternion, fov: number, exposure: number, pixelRatio: number): void {
    const v = this.volume;
    if (!v || this.weight <= 0.001) {
      // Keep baking in the background while approaching.
      if (v && !v.ready) v.bakeStep(this.ctx.renderer, 24);
      return;
    }
    const r = this.ctx.renderer;
    const c = this.cam;
    c.fov = fov;
    c.aspect = target.width / target.height;
    c.near = this.half * 1e-4;
    c.far = 5e4;
    c.position.set(0, 0, 0);
    c.quaternion.copy(quat);
    c.updateProjectionMatrix();
    c.updateMatrixWorld();
    v.object.position.copy(this.position).sub(camLocal);
    v.object.updateMatrixWorld();
    v.emission = this.weight;
    v.applyEmission();
    v.exposure = exposure;
    v.render(r, c, target);
    if (this.stars) {
      this.stars.brightness = this.weight * exposure;
      this.stars.object.position.copy(v.object.position);
      this.stars.object.updateMatrixWorld();
      this.stars.render(r, c, target, pixelRatio);
    }
    r.setRenderTarget(target);
  }

  dispose(): void {
    this.volume?.dispose();
    this.stars?.dispose();
    this.volume = null;
    this.stars = null;
  }
}
