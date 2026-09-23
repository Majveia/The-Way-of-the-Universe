import * as THREE from 'three';
import { FullscreenQuad, FULLSCREEN_VERT } from '../../core/post/FullscreenQuad';
import { bulkWindow, CENTER_TAU, type Diagnostics } from './cpu';
import { sphereScale, SMOOTH_EPS, type SmoothModel } from './galaxy';
import { applyDiskMoments, DISK_REFIT_TAU, MOMENT_HARD, MOMENT_SIGMA, type DiskMoments } from './moments';
import { SKELETON_WIDTH, TRACER_WIDTH, type ScenarioData } from './scenario';
import { COPY2_FRAG, DIAG_FRAG, FORCE_FRAG, K_FRAG, KD_FRAG, MOMENTS_FRAG, TRACER_FRAG, TRACK_FRAG } from './shaders';
import { G_SIM } from './units';

/**
 * GPU galaxy-collision integrator (WebGL2, float32 ping-pong textures).
 *
 * Per skeleton step (dt Myr):
 *   KD     skeleton  v += ½a dt, x += v dt                          (MRT: pos, vel)
 *   FORCE  skeleton  direct N² Plummer-softened gravity + potential  (acc)
 *   K      skeleton  v += ½a dt                                      (MRT: pos, vel)
 *   TRACK  1×2       filtered galaxy centres (bulk motion of each skeleton)
 *   TRACER tracers   K leapfrog sub-steps in the smooth field          (MRT: pos, vel)
 * Occasional reductions (energy, momentum; disk moments) are read back asynchronously.
 *
 * Reusable: any scene can build a ScenarioData, step it, and read `tracerPosition` etc.
 */
export interface NBodyOptions {
  /** Skeleton time step in Myr (default 1). */
  dt?: number;
  /** Tracer sub-steps per skeleton step (default 4). */
  substeps?: number;
}

export interface GalaxyState {
  center: THREE.Vector3;
  velocity: THREE.Vector3;
  spin: THREE.Vector3;
}

const floatTarget = (w: number, h: number, count = 1) =>
  new THREE.WebGLRenderTarget(w, h, {
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    count,
  });

const dataTexture = (data: Float32Array, w: number, h: number) => {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
  t.minFilter = THREE.NearestFilter;
  t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
};

/** True when this WebGL2 context can render to float32 textures (required). */
export function supportsGpuNBody(renderer: THREE.WebGLRenderer): boolean {
  return renderer.capabilities.isWebGL2 !== false && renderer.extensions.has('EXT_color_buffer_float');
}

export class NBodySystem {
  readonly data: ScenarioData;
  readonly dt: number;
  readonly substeps: number;
  /** Simulated time (Myr) of the current state. */
  time = 0;
  steps = 0;
  /** CPU copies of the smooth-field models (disk refit from tracer moments). */
  readonly models: SmoothModel[];
  readonly spins: number[][];
  /** Latest asynchronously read diagnostics (null until the first read completes). */
  diagnostics: Diagnostics | null = null;
  initialDiagnostics: Diagnostics | null = null;
  /** Latest read galaxy centres/velocities (world frame, kpc & kpc/Myr). */
  readonly galaxies: GalaxyState[];
  /** Time (Myr) of the state the latest galaxy readback describes. */
  galaxiesTime = 0;

  private renderer: THREE.WebGLRenderer;
  private quad = new FullscreenQuad();
  private sA: THREE.WebGLRenderTarget;
  private sB: THREE.WebGLRenderTarget;
  private sAcc: THREE.WebGLRenderTarget;
  private tA: THREE.WebGLRenderTarget;
  private tB: THREE.WebGLRenderTarget;
  private mA: THREE.WebGLRenderTarget;
  private mB: THREE.WebGLRenderTarget;
  private diagRT: THREE.WebGLRenderTarget;
  private momRT: THREE.WebGLRenderTarget;
  private attr: THREE.DataTexture;
  private mats: Record<string, THREE.ShaderMaterial> = {};
  private pending = { diag: false, mom: false, model: false };
  /** Frame-ish counters of how long each async read has been outstanding. */
  private waited = { diag: 0, mom: 0, model: 0 };
  /**
   * Some drivers (notably software rasterisers) signal fences very late; after one read has waited
   * too long, fall back to synchronous reads of these tiny textures.
   */
  syncReads = false;
  private lastRefitTime = 0;
  private disposed = false;
  private readonly sH: number;
  private readonly tH: number;
  private scratch = {
    diag0: new Float32Array(0),
    diag1: new Float32Array(0),
    mom: [new Float32Array(0), new Float32Array(0), new Float32Array(0)],
    model: [new Float32Array(8), new Float32Array(8), new Float32Array(8)],
  };

  constructor(renderer: THREE.WebGLRenderer, data: ScenarioData, opts: NBodyOptions = {}) {
    this.renderer = renderer;
    this.data = data;
    this.dt = opts.dt ?? 1;
    this.substeps = opts.substeps ?? 4;
    const S = data.skeleton, T = data.tracers;
    this.sH = S.n / SKELETON_WIDTH;
    this.tH = T.n / TRACER_WIDTH;
    this.sA = floatTarget(SKELETON_WIDTH, this.sH, 2);
    this.sB = floatTarget(SKELETON_WIDTH, this.sH, 2);
    this.sAcc = floatTarget(SKELETON_WIDTH, this.sH, 1);
    this.tA = floatTarget(TRACER_WIDTH, this.tH, 2);
    this.tB = floatTarget(TRACER_WIDTH, this.tH, 2);
    this.mA = floatTarget(1, 2, 4);
    this.mB = floatTarget(1, 2, 4);
    this.diagRT = floatTarget(1, this.sH, 2);
    this.momRT = floatTarget(1, this.tH, 3);
    this.attr = dataTexture(T.attr, TRACER_WIDTH, this.tH);
    this.scratch.diag0 = new Float32Array(this.sH * 4);
    this.scratch.diag1 = new Float32Array(this.sH * 4);
    this.scratch.mom = [0, 1, 2].map(() => new Float32Array(this.tH * 4));
    this.models = data.galaxies.map((g) => structuredClone(g.model));
    this.spins = data.galaxies.map((g) => [...g.spin]);
    this.galaxies = data.galaxies.map((g) => ({
      center: new THREE.Vector3(...g.center),
      velocity: new THREE.Vector3(...g.velocity),
      spin: new THREE.Vector3(...g.spin),
    }));
    this.buildMaterials();
    this.upload(S.pos, S.vel, T.pos, T.vel);
  }

  private material(name: string, frag: string, uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
    const m = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: frag,
      uniforms,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    this.mats[name] = m;
    return m;
  }

  private buildMaterials(): void {
    const segs = this.data.skeleton.segments;
    // ivec2[] uniforms must be flat Int32Arrays (three.js does not flatten Vector2s for int arrays).
    const segRows = new Int32Array(segs.flatMap((s) => [s.start / SKELETON_WIDTH, (s.start + s.count) / SKELETON_WIDTH]));
    const segEps2 = segs.map((s) => s.eps * s.eps);
    this.material('copy', COPY2_FRAG, { tA: { value: null }, tB: { value: null } });
    const dtU = { value: this.dt };
    this.material('kd', KD_FRAG, { tPos: { value: null }, tVel: { value: null }, tAcc: { value: null }, uDt: dtU });
    this.material('k', K_FRAG, { tPos: { value: null }, tVel: { value: null }, tAcc: { value: null }, uDt: dtU });
    this.material('force', FORCE_FRAG, {
      tPos: { value: null },
      tVel: { value: null },
      uSeg: { value: segRows },
      uSegEps2: { value: segEps2 },
      uG: { value: G_SIM },
    });
    // Segment rows per (comp, galaxy): index comp*2 + g — same order as scenario segments.
    this.material('track', TRACK_FRAG, {
      tPos: { value: null },
      tVel: { value: null },
      tAcc: { value: null },
      tM0: { value: null },
      tM1: { value: null },
      tM2: { value: null },
      uRows: { value: segRows },
      uWin: { value: this.data.galaxies.map((g) => bulkWindow(g.spec.disk.scale)) },
      uInitCenter: { value: this.data.galaxies.map((g) => new THREE.Vector3(...g.center)) },
      uDt: dtU,
      uTau: { value: new THREE.Vector3(CENTER_TAU.x, CENTER_TAU.v, CENTER_TAU.u) },
      uInit: { value: 0 },
    });
    this.material('tracer', TRACER_FRAG, {
      tPos: { value: null },
      tVel: { value: null },
      tM0: { value: null },
      tM3: { value: null },
      uDt: dtU,
      uK: { value: this.substeps },
      uHalo: { value: [new THREE.Vector4(), new THREE.Vector4()] },
      uBulge: { value: [new THREE.Vector4(), new THREE.Vector4()] },
      uSph: { value: [new THREE.Vector4(), new THREE.Vector4()] },
      uMnA: { value: [new THREE.Vector4(), new THREE.Vector4()] },
      uMnM: { value: [new THREE.Vector4(), new THREE.Vector4()] },
      uSpin: { value: [new THREE.Vector4(), new THREE.Vector4()] },
    });
    this.material('diag', DIAG_FRAG, { tPos: { value: null }, tVel: { value: null }, tAcc: { value: null } });
    this.material('moments', MOMENTS_FRAG, {
      tPos: { value: null },
      tVel: { value: null },
      tAttr: { value: this.attr },
      tM0: { value: null },
      tM1: { value: null },
      uSplitRow: { value: this.data.galaxies[1].tracerRows[0] },
      uHard2: { value: this.data.galaxies.map((g) => (MOMENT_HARD * g.spec.disk.scale) ** 2) },
      uSig2: { value: this.data.galaxies.map((g) => 2 * (MOMENT_SIGMA * g.spec.disk.scale) ** 2) },
      uWidth: { value: TRACER_WIDTH },
    });
    this.syncSmoothUniforms();
  }

  /** Push the CPU smooth models (halo, bulge, refit disk, spin) into the tracer shader. */
  syncSmoothUniforms(): void {
    const u = this.mats.tracer.uniforms;
    this.models.forEach((m, g) => {
      const e2 = SMOOTH_EPS * SMOOTH_EPS;
      (u.uHalo.value[g] as THREE.Vector4).set(G_SIM * m.halo.mass, m.halo.scale, m.halo.eps * m.halo.eps, 0);
      (u.uBulge.value[g] as THREE.Vector4).set(G_SIM * m.bulge.mass, m.bulge.scale, m.bulge.eps * m.bulge.eps, 0);
      (u.uSph.value[g] as THREE.Vector4).set(G_SIM * m.disk.mass * m.sphere, sphereScale(m.disk.rd), e2, 0);
      (u.uMnA.value[g] as THREE.Vector4).set(m.mn.a[0], m.mn.a[1], m.mn.a[2], m.mn.b);
      (u.uMnM.value[g] as THREE.Vector4).set(G_SIM * m.mn.m[0], G_SIM * m.mn.m[1], G_SIM * m.mn.m[2], 0);
      const s = this.spins[g];
      (u.uSpin.value[g] as THREE.Vector4).set(s[0], s[1], s[2], 0);
    });
  }

  private pass(mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget): void {
    this.quad.material = mat;
    this.quad.render(this.renderer, target);
  }

  /** Upload a full state (initial conditions or a snapshot) and re-initialise forces/centres. */
  upload(sPos: Float32Array, sVel: Float32Array, tPos: Float32Array, tVel: Float32Array, centersKnown?: Float32Array[]): void {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    const tex = [
      dataTexture(sPos, SKELETON_WIDTH, this.sH),
      dataTexture(sVel, SKELETON_WIDTH, this.sH),
      dataTexture(tPos, TRACER_WIDTH, this.tH),
      dataTexture(tVel, TRACER_WIDTH, this.tH),
    ];
    const copy = this.mats.copy;
    copy.uniforms.tA.value = tex[0];
    copy.uniforms.tB.value = tex[1];
    this.pass(copy, this.sA);
    copy.uniforms.tA.value = tex[2];
    copy.uniforms.tB.value = tex[3];
    this.pass(copy, this.tA);
    this.computeForces(this.sA);
    if (centersKnown) {
      // Restore the filter state exactly (snapshots).
      const mt = [0, 1, 2, 3].map((k) => dataTexture(centersKnown[k], 1, 2));
      copy.uniforms.tA.value = mt[0];
      copy.uniforms.tB.value = mt[1];
      // MRT copy only handles two attachments: write via track init then overwrite is simpler:
      this.initTrack();
      mt.forEach((t) => t.dispose());
    } else {
      this.initTrack();
    }
    copy.uniforms.tA.value = null;
    copy.uniforms.tB.value = null;
    r.setRenderTarget(prev);
    // Textures are uploaded lazily on first use; they can go once the copies have been issued.
    for (const t of tex) t.dispose();
  }

  private computeForces(state: THREE.WebGLRenderTarget): void {
    const f = this.mats.force;
    f.uniforms.tPos.value = state.textures[0];
    f.uniforms.tVel.value = state.textures[1];
    this.pass(f, this.sAcc);
  }

  private initTrack(): void {
    const t = this.mats.track;
    t.uniforms.uInit.value = 1;
    this.bindTrack(t, this.mA);
    this.pass(t, this.mB);
    t.uniforms.uInit.value = 0;
    [this.mA, this.mB] = [this.mB, this.mA];
  }

  private bindTrack(t: THREE.ShaderMaterial, model: THREE.WebGLRenderTarget): void {
    t.uniforms.tPos.value = this.sA.textures[0];
    t.uniforms.tVel.value = this.sA.textures[1];
    t.uniforms.tAcc.value = this.sAcc.texture;
    t.uniforms.tM0.value = model.textures[0];
    t.uniforms.tM1.value = model.textures[1];
    t.uniforms.tM2.value = model.textures[2];
  }

  /** Advance `n` skeleton steps (each with `substeps` tracer sub-steps). */
  step(n = 1): void {
    if (this.disposed) return;
    const r = this.renderer;
    const prev = r.getRenderTarget();
    const { kd, k, track, tracer } = this.mats;
    for (let i = 0; i < n; i++) {
      kd.uniforms.tPos.value = this.sA.textures[0];
      kd.uniforms.tVel.value = this.sA.textures[1];
      kd.uniforms.tAcc.value = this.sAcc.texture;
      this.pass(kd, this.sB);
      this.computeForces(this.sB);
      k.uniforms.tPos.value = this.sB.textures[0];
      k.uniforms.tVel.value = this.sB.textures[1];
      k.uniforms.tAcc.value = this.sAcc.texture;
      this.pass(k, this.sA);
      this.bindTrack(track, this.mA);
      this.pass(track, this.mB);
      [this.mA, this.mB] = [this.mB, this.mA];
      tracer.uniforms.tPos.value = this.tA.textures[0];
      tracer.uniforms.tVel.value = this.tA.textures[1];
      tracer.uniforms.tM0.value = this.mA.textures[0];
      tracer.uniforms.tM3.value = this.mA.textures[3];
      this.pass(tracer, this.tB);
      [this.tA, this.tB] = [this.tB, this.tA];
      this.time += this.dt;
      this.steps++;
    }
    r.setRenderTarget(prev);
  }

  // ——— Render-side accessors ———
  get tracerPosition(): THREE.Texture {
    return this.tA.textures[0];
  }
  get tracerVelocity(): THREE.Texture {
    return this.tA.textures[1];
  }
  get tracerAttributes(): THREE.Texture {
    return this.attr;
  }
  get skeletonPosition(): THREE.Texture {
    return this.sA.textures[0];
  }
  get skeletonVelocity(): THREE.Texture {
    return this.sA.textures[1];
  }
  /** Filtered galaxy centres on the GPU (1×2 texture, one texel per galaxy). */
  get centerTexture(): THREE.Texture {
    return this.mA.textures[0];
  }
  get tracerCount(): number {
    return this.data.tracers.n;
  }
  get skeletonCount(): number {
    return this.data.skeleton.n;
  }

  // ——— Asynchronous reductions ———

  /** Read several attachments of a small float target, async when possible. */
  private read(kind: 'diag' | 'mom' | 'model', rt: THREE.WebGLRenderTarget, w: number, h: number, bufs: Float32Array[]): Promise<Float32Array[]> | null {
    if (this.pending[kind]) {
      if (++this.waited[kind] > 45) this.syncReads = true;
      return null;
    }
    this.waited[kind] = 0;
    const r = this.renderer;
    if (this.syncReads) {
      bufs.forEach((b, k) => r.readRenderTargetPixels(rt, 0, 0, w, h, b, undefined, k));
      return Promise.resolve(bufs);
    }
    this.pending[kind] = true;
    return Promise.all(bufs.map((b, k) => r.readRenderTargetPixelsAsync(rt, 0, 0, w, h, b, undefined, k) as Promise<Float32Array>)).finally(
      () => (this.pending[kind] = false),
    );
  }

  /** Energy / momentum of the skeleton (resolves into `diagnostics`). */
  requestDiagnostics(): void {
    if (this.disposed || this.pending.diag) {
      if (this.pending.diag && ++this.waited.diag > 45) this.syncReads = true;
      return;
    }
    const d = this.mats.diag;
    d.uniforms.tPos.value = this.sA.textures[0];
    d.uniforms.tVel.value = this.sA.textures[1];
    d.uniforms.tAcc.value = this.sAcc.texture;
    const prev = this.renderer.getRenderTarget();
    this.pass(d, this.diagRT);
    this.renderer.setRenderTarget(prev);
    this.read('diag', this.diagRT, 1, this.sH, [this.scratch.diag0, this.scratch.diag1])
      ?.then(([a, b]) => {
        if (this.disposed) return;
        let K = 0, W = 0;
        const P: [number, number, number] = [0, 0, 0], L: [number, number, number] = [0, 0, 0];
        for (let i = 0; i < this.sH; i++) {
          K += a[i * 4];
          W += a[i * 4 + 1];
          P[0] += a[i * 4 + 2];
          P[1] += a[i * 4 + 3];
          P[2] += b[i * 4];
          L[0] += b[i * 4 + 1];
          L[1] += b[i * 4 + 2];
          L[2] += b[i * 4 + 3];
        }
        this.diagnostics = { kinetic: K, potential: W, energy: K + W, momentum: P, angularMomentum: L };
        if (!this.initialDiagnostics) this.initialDiagnostics = this.diagnostics;
      })
      .catch(() => undefined);
  }

  /** Disk-tracer moments → refit the smooth disks (applied when the read completes). */
  requestDiskRefit(): void {
    if (this.disposed || this.pending.mom) {
      if (this.pending.mom && ++this.waited.mom > 45) this.syncReads = true;
      return;
    }
    const m = this.mats.moments;
    m.uniforms.tPos.value = this.tA.textures[0];
    m.uniforms.tVel.value = this.tA.textures[1];
    m.uniforms.tM0.value = this.mA.textures[0];
    m.uniforms.tM1.value = this.mA.textures[1];
    const prev = this.renderer.getRenderTarget();
    this.pass(m, this.momRT);
    this.renderer.setRenderTarget(prev);
    const t = this.time;
    this.read('mom', this.momRT, 1, this.tH, this.scratch.mom)
      ?.then((buf) => {
        if (this.disposed) return;
        const split = this.data.galaxies[1].tracerRows[0];
        const mo: DiskMoments[] = [0, 1].map(() => ({ wIn: 0, w: 0, L: [0, 0, 0], S: [0, 0, 0, 0, 0, 0] }));
        for (let row = 0; row < this.tH; row++) {
          const o = mo[row < split ? 0 : 1];
          const a = row * 4;
          o.wIn += buf[0][a];
          o.w += buf[0][a + 1];
          o.L[0] += buf[0][a + 2];
          o.L[1] += buf[0][a + 3];
          o.L[2] += buf[1][a];
          o.S[0] += buf[1][a + 1];
          o.S[1] += buf[1][a + 2];
          o.S[2] += buf[1][a + 3];
          o.S[3] += buf[2][a];
          o.S[4] += buf[2][a + 1];
          o.S[5] += buf[2][a + 2];
        }
        const dtRefit = Math.max(0, t - this.lastRefitTime);
        this.lastRefitTime = t;
        const k = 1 - Math.exp(-dtRefit / DISK_REFIT_TAU);
        if (k > 0) {
          this.data.galaxies.forEach((g, gi) => applyDiskMoments(this.models[gi], this.spins[gi], g, mo[gi], k));
          this.syncSmoothUniforms();
          this.spins.forEach((s, gi) => this.galaxies[gi].spin.set(s[0], s[1], s[2]));
        }
      })
      .catch(() => undefined);
  }

  /** Read the filtered centres/velocities back to the CPU (for cameras, readouts, events). */
  requestGalaxies(): void {
    if (this.disposed) return;
    const t = this.time;
    this.read('model', this.mA, 1, 2, [this.scratch.model[0], this.scratch.model[1]])
      ?.then(([c, v]) => {
        if (this.disposed) return;
        for (let g = 0; g < 2; g++) {
          this.galaxies[g].center.set(c[g * 4], c[g * 4 + 1], c[g * 4 + 2]);
          this.galaxies[g].velocity.set(v[g * 4], v[g * 4 + 1], v[g * 4 + 2]);
        }
        this.galaxiesTime = t;
      })
      .catch(() => undefined);
  }

  dispose(): void {
    this.disposed = true;
    for (const rt of [this.sA, this.sB, this.sAcc, this.tA, this.tB, this.mA, this.mB, this.diagRT, this.momRT]) rt.dispose();
    this.attr.dispose();
    for (const m of Object.values(this.mats)) m.dispose();
  }
}
