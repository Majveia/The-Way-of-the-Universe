import * as THREE from 'three';
import { GalaxyRenderer } from './GalaxyRenderer';
import { NBodySystem, supportsGpuNBody, type NBodyOptions } from './NBodySystem';
import { buildScenario, type ScenarioCounts, type ScenarioData, type ScenarioDef } from './scenario';

export { NBodySystem, supportsGpuNBody, ADD_ONE_ONE } from './NBodySystem';
export type { NBodyOptions, GalaxyState } from './NBodySystem';
export { GalaxyRenderer, whiteBalance } from './GalaxyRenderer';
export type { GalaxyRendererOptions, RenderInputs } from './GalaxyRenderer';
export { buildScenario } from './scenario';
export type { ScenarioDef, ScenarioData, ScenarioCounts, GalaxyPlacement } from './scenario';
export { CpuNBody } from './cpu';
export { GALAXY_TEMPLATES, MILKY_WAY, ANDROMEDA, LATE_SPIRAL, EARLY_SPIRAL, CARTWHEEL_TARGET, DWARF } from './catalog';
export type { GalaxySpec } from './galaxy';
export * from './units';
export * from './starformation';

export interface GalaxyCollisionLayerOptions extends NBodyOptions {
  counts: ScenarioCounts;
  /** Surface-brightness exposure (display units per 10¹⁰ L☉ kpc⁻²). */
  exposure?: number;
}

/**
 * Drop-in galaxy collision for any scene (e.g. the Voyage explorer): owns the GPU integrator and
 * the renderer. World units are kpc; place the layer by rendering with a camera expressed in the
 * encounter's frame (orbital plane = XZ, barycentre at the origin at t = 0).
 *
 *   const layer = new GalaxyCollisionLayer(renderer, def, { counts: { skeleton: 4096, tracers: 131072 } });
 *   layer.advance(dtSeconds * myrPerSecond);        // per frame
 *   layer.render(renderer, camera, hdrTarget, pixelRatio);
 */
export class GalaxyCollisionLayer {
  readonly data: ScenarioData;
  readonly sim: NBodySystem;
  readonly view: GalaxyRenderer;
  private owed = 0;
  private frame = 0;
  private tmp = new THREE.Vector3();

  constructor(renderer: THREE.WebGLRenderer, def: ScenarioDef, o: GalaxyCollisionLayerOptions) {
    this.data = buildScenario(def, o.counts);
    this.sim = new NBodySystem(renderer, this.data, o);
    this.view = new GalaxyRenderer({ data: this.data, exposure: o.exposure ?? 30 });
  }

  /** Advance by `myr` of simulated time (at most `maxSteps` skeleton steps this call). */
  advance(myr: number, maxSteps = 10): void {
    const s = this.sim;
    this.owed = Math.min(this.owed + Math.max(0, myr), (maxSteps + 1) * s.dt);
    const n = Math.min(maxSteps, Math.floor(this.owed / s.dt));
    if (n > 0) {
      s.step(n);
      this.owed -= n * s.dt;
    }
    this.frame++;
    if (this.frame % 4 === 0) s.requestDiskRefit();
    if (this.frame % 3 === 0) s.requestGalaxies();
  }

  render(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, target: THREE.WebGLRenderTarget, pixelRatio = 1): void {
    const s = this.sim;
    const [a, b] = s.galaxies;
    camera.updateMatrixWorld();
    const mid = this.tmp.copy(a.center).add(b.center).multiplyScalar(0.5);
    const d = -mid.applyMatrix4(camera.matrixWorldInverse).z;
    const r = 0.5 * a.center.distanceTo(b.center) + 40;
    this.view.render(renderer, camera, target, {
      pos: s.tracerPosition,
      vel: s.tracerVelocity,
      attr: s.tracerAttributes,
      skeletonPos: s.skeletonPosition,
      time: s.time,
      extrapolate: Math.min(this.owed, s.dt),
      depthNear: d - r,
      depthFar: d + r,
      pixelRatio,
    });
  }

  dispose(): void {
    this.sim.dispose();
    this.view.dispose();
  }
}
