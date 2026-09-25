/**
 * CosmicWebLayer — the present-day cosmic web as a drop-in layer for other experiences (Voyage).
 *
 *   const web = new CosmicWebLayer(renderer, { seed: 42, detail: ctx.quality.detail });
 *   await web.ready;                       // simulation (Web Worker, cached) + GPU upload
 *   web.halos                              // [{ position (Mpc), mass (M☉), seed }], most massive first
 *   web.position.set(...)                  // where the box centre sits in the caller's Mpc frame
 *   web.setOpacity(0…1);                   // cross-fade with neighbouring scales
 *   web.render(renderer, camera);          // additive linear HDR into the bound render target
 *   web.dispose();
 *
 * Units: world units are Mpc (not h⁻¹ Mpc). The layer renders a comoving z = 0 snapshot of a
 * ΛCDM particle-mesh simulation (Planck 2018 by default) with its friends-of-friends halos.
 */
import * as THREE from 'three';
import { WebRenderer, type WebFrameState } from './WebRenderer';
import { loadWebToday, type CachedWeb, type CosmicHalo, type WebRequest } from './webCache';

export interface CosmicWebLayerOptions extends WebRequest {
  /** Quality detail multiplier (ctx.quality.detail). Chooses 64³ / 96³ / 128³ particles if np is unset. */
  detail?: number;
  /** Show galaxies (default true). */
  galaxies?: boolean;
  /** Draw the periodic box outline (default false). */
  outline?: boolean;
  /** Brightness multiplier (default 1). */
  exposure?: number;
}

export class CosmicWebLayer {
  /** Resolved z = 0 halos (empty until `ready`). */
  halos: CosmicHalo[] = [];
  /** Box centre in the caller's world frame (Mpc). */
  readonly position = new THREE.Vector3();
  /** Resolves when the web can be drawn. */
  readonly ready: Promise<void>;
  /** Box side (Mpc) once ready. */
  boxMpc = 0;
  private renderer: THREE.WebGLRenderer;
  private web: WebRenderer | null = null;
  private data: CachedWeb | null = null;
  private opacity = 1;
  private disposed = false;
  private readonly opts: CosmicWebLayerOptions;
  private readonly cam = new THREE.PerspectiveCamera();
  private readonly state: WebFrameState = {
    mix: 0,
    za: -1,
    D: 1,
    z: 0,
    scale: 1,
    wrap: false,
    wrapCenter: new THREE.Vector3(0.5, 0.5, 0.5),
    fadeFar: 0,
    slab: null,
    darkMatter: 1,
    galaxies: 1,
    fieldGalaxies: 1,
    replicas: 0,
    outline: 0,
    exposure: 1,
    sfrBoost: 0,
    quench: 1,
    cmb: null,
  };

  constructor(renderer: THREE.WebGLRenderer, opts: CosmicWebLayerOptions = {}) {
    this.renderer = renderer;
    this.opts = opts;
    const detail = opts.detail ?? 1;
    const np = opts.np ?? (detail >= 1 ? 128 : detail >= 0.6 ? 96 : 64);
    this.ready = loadWebToday({ ...opts, np }).then((d) => {
      if (this.disposed) return;
      this.data = d;
      this.halos = d.halos;
      this.boxMpc = d.boxMpc;
      const info = d.info;
      this.web = new WebRenderer(renderer, {
        np: info.np,
        count: info.count,
        nm: info.nm,
        boxWorld: d.boxMpc,
        deltaL: info.deltaL,
        sigmaL: info.sigmaL,
        varDwarf: Math.max(0.5, info.sigmaMin2 - info.sigmaL * info.sigmaL),
        varBright: Math.max(0.3, 9 - info.sigmaL * info.sigmaL),
        detail,
      });
      this.web.setKeyframes(0, d.today.positions, 0, d.today.positions);
      this.web.setGalaxies(d.today.galaxies, d.today.galaxies);
    });
  }

  /** 0 = invisible (render is skipped), 1 = full brightness. */
  setOpacity(o: number): void {
    this.opacity = Math.max(0, Math.min(1, o));
  }

  get isReady(): boolean {
    return !!this.web;
  }

  /** Draw into the currently bound render target (linear HDR, additive). */
  render(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera): void {
    const web = this.web;
    if (!web || this.opacity <= 0 || !this.data) return;
    // The renderer sizes its internal targets from the bound target (or the canvas) itself.
    const target = renderer.getRenderTarget();
    // Camera relative to the box centre (keeps vertex coordinates small and precise).
    const c = this.cam;
    c.copy(camera);
    c.position.sub(this.position);
    c.updateMatrixWorld();
    const st = this.state;
    st.exposure = (this.opts.exposure ?? 1) * this.opacity;
    // Opacity scales the (linear) exposure only: the asinh stretch of the dark matter is not linear.
    st.darkMatter = 1;
    const g = this.opts.galaxies === false ? 0 : 1;
    st.galaxies = g;
    st.fieldGalaxies = g;
    st.outline = this.opts.outline ? 1 : 0;
    web.pixelRatio = renderer.getPixelRatio();
    web.render(target, c, st, true);
    renderer.setRenderTarget(target);
  }

  dispose(): void {
    this.disposed = true;
    this.web?.dispose();
    this.web = null;
    this.data = null;
    this.halos = [];
  }
}
