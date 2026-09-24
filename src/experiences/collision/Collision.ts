import * as THREE from 'three';
import type { Experience, ExperienceContext, FrameInfo } from '../../core/types';
import { OrbitRig } from '../../core/rigs/OrbitRig';
import { Sky } from '../../worlds/sky/Sky';
import { NBodySystem, supportsGpuNBody } from '../../worlds/nbody/NBodySystem';
import { GalaxyRenderer } from '../../worlds/nbody/GalaxyRenderer';
import { buildScenario, type ScenarioData } from '../../worlds/nbody/scenario';
import { simToKms } from '../../worlds/nbody/units';
import { formatNumber } from '../../physics/units';
import { PRESETS, presetById, type Preset } from './presets';

/** Particle budgets by quality detail (0.35 low … 1.6 ultra). */
export function budgetFor(detail: number) {
  const skeleton = Math.min(16384, Math.max(2048, Math.round((8192 * detail) / 1024) * 1024));
  const tracers = Math.max(32768, Math.round((196608 * detail) / 4096) * 4096);
  return { skeleton, tracers };
}

export class CollisionExperience implements Experience {
  private ctx!: ExperienceContext;
  private sky!: Sky;
  private rig!: OrbitRig;
  private camera = new THREE.PerspectiveCamera(40, 1, 0.05, 50000);
  private tmpV = new THREE.Vector3();
  private sim: NBodySystem | null = null;
  private galaxyRenderer: GalaxyRenderer | null = null;
  private preset!: Preset;
  private data: ScenarioData | null = null;
  /** Simulated Myr per real second. */
  rate = 30;
  paused = false;
  /** Simulated time owed to the integrator (Myr). */
  private owed = 0;
  private frameCount = 0;
  private followTarget = new THREE.Vector3();
  private readouts!: {
    time: ReturnType<ExperienceContext['ui']['readout']>;
    sep: ReturnType<ExperienceContext['ui']['readout']>;
    speed: ReturnType<ExperienceContext['ui']['readout']>;
    drift: ReturnType<ExperienceContext['ui']['readout']>;
  };
  private loading: Promise<void> | null = null;

  async mount(ctx: ExperienceContext): Promise<void> {
    this.ctx = ctx;
    ctx.post.exposure = 1;
    ctx.post.bloomStrength = 0.06;
    ctx.post.bloomRadius = 0.85;
    ctx.post.vignette = 0.2;
    ctx.post.tonemap = 'agx';
    this.sky = new Sky({ stars: Math.round(9000 * ctx.quality.detail), milkyWay: 0, brightness: 0.35, starSize: 0.9 });
    this.rig = new OrbitRig(ctx.input, { distance: 150, pitch: 0.5, yaw: 0.5, minDistance: 2, maxDistance: 4000, autoRotate: 0.02, idleDelay: 4 });
    this.readouts = {
      time: ctx.ui.readout('Time', 'Myr'),
      sep: ctx.ui.readout('Separation', 'kpc'),
      speed: ctx.ui.readout('Relative speed', 'km/s'),
      drift: ctx.ui.readout('Energy drift', '%'),
    };
    this.buildPanel();
    ctx.audio.setMood('collision', { intensity: 0.4 });
    const id = ctx.params.get('preset') ?? 'antennae';
    await this.load(presetById(id), true);
    ctx.ui.hint('Drag to orbit · Scroll to zoom · Space pause · [ ] time rate · P controls');
    ctx.input.onKeyDown((e) => {
      if (e.code === 'Space') {
        this.paused = !this.paused;
        e.preventDefault();
      } else if (e.code === 'BracketRight') this.rate = Math.min(400, this.rate * 1.5);
      else if (e.code === 'BracketLeft') this.rate = Math.max(1, this.rate / 1.5);
    });
    ctx.signalReady();
  }

  private buildPanel(): void {
    const s = this.ctx.ui.section('Encounter');
    s.buttons(
      PRESETS.map((p) => ({ label: p.name.replace(/^The /, ''), onClick: () => void this.load(p, true) })),
      0,
    );
    const t = this.ctx.ui.section('Time');
    t.slider({ label: 'Rate', min: 1, max: 400, log: true, value: this.rate, unit: 'Myr/s', onChange: (v) => (this.rate = v) });
    t.buttons([
      { label: 'Pause', onClick: () => (this.paused = !this.paused) },
      { label: 'Restart', onClick: () => void this.load(this.preset, false) },
    ]);
  }

  /** Build a preset's scenario and (optionally) pre-integrate its warm-up. */
  async load(preset: Preset, warm: boolean): Promise<void> {
    if (this.loading) await this.loading;
    this.loading = this.doLoad(preset, warm);
    await this.loading;
    this.loading = null;
  }

  private async doLoad(preset: Preset, warm: boolean): Promise<void> {
    const ctx = this.ctx;
    this.preset = preset;
    const budget = budgetFor(ctx.quality.detail);
    const q = ctx.params.get('n');
    if (q) budget.tracers = Math.max(4096, Number(q));
    ctx.progress(0.05, preset.name);
    await new Promise((r) => setTimeout(r, 0));
    const data = buildScenario(preset.scenario, budget);
    this.data = data;
    ctx.progress(0.3, 'Settling galaxies');
    if (!supportsGpuNBody(ctx.renderer)) throw new Error('This device cannot render to float textures (EXT_color_buffer_float).');
    this.sim?.dispose();
    this.galaxyRenderer?.dispose();
    const sim = new NBodySystem(ctx.renderer, data, { dt: 1, substeps: 4 });
    // Screenshots must be deterministic: read back synchronously (tiny textures).
    sim.syncReads = ctx.engine.shotMode;
    this.sim = sim;
    this.galaxyRenderer = new GalaxyRenderer({ data, exposure: 20 });
    this.owed = 0;
    const warmup = warm ? preset.warmup : 0;
    const chunk = 8;
    for (let done = 0; done < warmup; done += chunk) {
      sim.step(Math.min(chunk, warmup - done));
      if (done % 32 === 0) {
        sim.requestDiskRefit();
        ctx.progress(0.3 + (0.7 * done) / Math.max(1, warmup), 'Integrating');
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    sim.requestDiagnostics();
    sim.requestGalaxies();
    const c = data.galaxies;
    this.followTarget.set(0, 0, 0);
    for (const g of c) this.followTarget.addScaledVector(new THREE.Vector3(...g.center), 0.5);
    this.rig.set({ target: new THREE.Vector3(0, 0, 0), distance: preset.view.distance, pitch: preset.view.pitch, yaw: preset.view.yaw });
    this.ctx.ui.info({ title: preset.name, subtitle: preset.designation, rows: preset.facts, body: preset.blurb });
  }

  update(f: FrameInfo): void {
    this.rig.update(f.dt);
    const sim = this.sim;
    if (!sim || this.loading) return;
    this.frameCount++;
    if (!this.paused) this.owed += this.rate * f.dt;
    const maxSteps = 12;
    let n = Math.floor(this.owed / sim.dt);
    if (n > maxSteps) {
      n = maxSteps;
      this.owed = Math.min(this.owed, (maxSteps + 1) * sim.dt);
    }
    if (n > 0) {
      sim.step(n);
      this.owed -= n * sim.dt;
    }
    if (this.frameCount % 4 === 0) sim.requestDiskRefit();
    if (this.frameCount % 3 === 0) sim.requestGalaxies();
    if (this.frameCount % 20 === 0) sim.requestDiagnostics();
    // Camera follows the mass-weighted barycentre of the two galaxy centres.
    const [a, b] = sim.galaxies;
    const ma = this.data!.galaxies[0].mass, mb = this.data!.galaxies[1].mass;
    const bx = (a.center.x * ma + b.center.x * mb) / (ma + mb);
    const by = (a.center.y * ma + b.center.y * mb) / (ma + mb);
    const bz = (a.center.z * ma + b.center.z * mb) / (ma + mb);
    const k = 1 - Math.exp(-f.dt / 1.5);
    this.rig.goal.target.x += (bx - this.rig.goal.target.x) * k;
    this.rig.goal.target.y += (by - this.rig.goal.target.y) * k;
    this.rig.goal.target.z += (bz - this.rig.goal.target.z) * k;
    this.updateReadouts();
  }

  private updateReadouts(): void {
    const sim = this.sim!;
    const [a, b] = sim.galaxies;
    const off = this.preset.clock?.offsetMyr ?? 0;
    const t = sim.time + off;
    if (this.preset.clock) this.readouts.time.set(formatNumber(t / 1000, 3), `Gyr ${this.preset.clock.label}`);
    else this.readouts.time.set(formatNumber(t, 4), 'Myr');
    this.readouts.sep.set(formatNumber(a.center.distanceTo(b.center), 3));
    this.readouts.speed.set(formatNumber(simToKms(a.velocity.distanceTo(b.velocity)), 3));
    const d = sim.diagnostics, d0 = sim.initialDiagnostics;
    if (d && d0) this.readouts.drift.set(formatNumber((100 * (d.energy - d0.energy)) / Math.abs(d0.energy), 2));
  }

  render(target: THREE.WebGLRenderTarget): void {
    const r = this.ctx.renderer;
    this.camera.aspect = target.width / target.height;
    this.camera.updateProjectionMatrix();
    this.rig.applyTo(this.camera);
    r.setRenderTarget(target);
    this.sky.render(r, this.camera, this.ctx.engine.pixelRatio);
    r.clearDepth();
    const sim = this.sim;
    if (sim && this.galaxyRenderer) {
      // View-depth range holding the pair (for the dust slices).
      const [a, b] = sim.galaxies;
      const mid = this.tmpV.copy(a.center).add(b.center).multiplyScalar(0.5);
      const dCenter = mid.applyMatrix4(this.camera.matrixWorldInverse).z * -1;
      const radius = 0.5 * a.center.distanceTo(b.center) + 40;
      this.galaxyRenderer.render(r, this.camera, target, {
        pos: sim.tracerPosition,
        vel: sim.tracerVelocity,
        attr: sim.tracerAttributes,
        skeletonPos: sim.skeletonPosition,
        time: sim.time,
        extrapolate: this.paused ? 0 : Math.min(this.owed, sim.dt),
        depthNear: dCenter - radius,
        depthFar: dCenter + radius,
        pixelRatio: this.ctx.engine.pixelRatio,
      });
    }
  }

  // ——— Debug hooks (window.__universe.experience) ———
  preset_(id: string): Promise<void> {
    return this.load(presetById(id), true);
  }
  /** Integrate forward until simulation time t (Myr). */
  advanceTo(t: number): void {
    const sim = this.sim;
    if (!sim) return;
    const n = Math.max(0, Math.round((t - sim.time) / sim.dt));
    for (let i = 0; i < n; i += 16) {
      sim.step(Math.min(16, n - i));
      if (i % 64 === 0) sim.requestDiskRefit();
    }
    sim.requestGalaxies();
    sim.requestDiagnostics();
  }
  setView(name: string): void {
    const v: Record<string, { pitch: number; yaw?: number; distance?: number }> = {
      'face-on': { pitch: 1.45 },
      'edge-on': { pitch: 0.02 },
      oblique: { pitch: 0.5 },
    };
    const s = v[name];
    if (s) this.rig.set({ pitch: s.pitch, distance: s.distance ?? this.rig.distance });
  }
  setDistance(d: number): void {
    this.rig.set({ distance: d });
  }
  get state() {
    const sim = this.sim;
    return sim ? { time: sim.time, galaxies: sim.galaxies.map((g) => g.center.toArray()), diag: sim.diagnostics } : null;
  }

  unmount(): void {
    this.sim?.dispose();
    this.galaxyRenderer?.dispose();
    this.sky.dispose();
    this.sim = null;
    this.galaxyRenderer = null;
  }
}
