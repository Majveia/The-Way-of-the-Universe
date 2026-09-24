import * as THREE from 'three';
import type { Experience, ExperienceContext, FrameInfo } from '../../core/types';
import { OrbitRig } from '../../core/rigs/OrbitRig';
import type { Readout } from '../../ui/UI';
import type { Control } from '../../ui/Panel';
import { Sky } from '../../worlds/sky/Sky';
import { NBodySystem, supportsGpuNBody } from '../../worlds/nbody/NBodySystem';
import { GalaxyRenderer } from '../../worlds/nbody/GalaxyRenderer';
import { buildScenario, type ScenarioData } from '../../worlds/nbody/scenario';
import { keplerStart } from '../../worlds/nbody/orbit';
import { simToKms } from '../../worlds/nbody/units';
import { formatNumber } from '../../physics/units';
import { customPreset, DEFAULT_CUSTOM, PRESETS, presetById, type CustomParams, type Preset } from './presets';
import { Timeline } from './Timeline';

/**
 * Collision — two disk galaxies merging, computed live on the GPU from Newton's law.
 *
 * Physics lives in src/worlds/nbody (reusable): a self-gravitating "skeleton" (dark halo, bulge and
 * disk mass carriers, direct-summation N², kick-drift-kick leapfrog) and many light star and gas
 * tracers that move in the smooth, live field of both galaxies and form stars where the gas is
 * compressed. See NBodySystem, galaxy.ts, starformation.ts and GalaxyRenderer for the models and
 * references. Units: kpc, Myr, 10¹⁰ M☉.
 */

/** Particle budgets by quality detail (0.35 low … 1.6 ultra). */
export function budgetFor(detail: number) {
  const skeleton = Math.min(16384, Math.max(2048, Math.round((8192 * detail) / 1024) * 1024));
  const tracers = Math.max(32768, Math.round((196608 * detail) / 4096) * 4096);
  return { skeleton, tracers };
}

type ViewName = 'orbit' | 'edge-on' | 'oblique' | 'default';
const FOLLOW_OPTIONS = [
  { value: 'pair', label: 'Both galaxies' },
  { value: '0', label: 'Primary' },
  { value: '1', label: 'Companion' },
] as const;
const ORDINALS = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth'];

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
  follow: 'pair' | 0 | 1 = 'pair';
  custom: CustomParams = { ...DEFAULT_CUSTOM };
  /** Simulated time owed to the integrator (Myr). */
  private owed = 0;
  private frameCount = 0;
  /** Integration progress (0–1) while loading/jumping, else null. */
  private busy: number | null = null;
  /** Bumped to cancel an in-flight load/jump. */
  private gen = 0;
  private job: Promise<void> = Promise.resolve();
  private disposed = false;
  private look_ = { dust: 1, darkMatter: false, youngStars: true, starFormation: true };
  // Encounter events (pericentre passages, coalescence) from the separation history.
  private ev = { t: -1, s1: Infinity, s2: Infinity, passages: 0, lastPassage: -1e9, mergedSince: -1, merged: false };
  private moodTimer = 0;
  private readouts!: { time: Readout; sep: Readout; speed: Readout; sfr: Readout; drift: Readout };
  private controls!: {
    rate: Control<number>;
    presets: { setActive(i: number): void };
    follow: Control<string>;
    pause: Control<void>;
    momentum: (v: string) => void;
    particles: (v: string) => void;
    derived: (v: string) => void;
  };
  private timeline!: Timeline;

  async mount(ctx: ExperienceContext): Promise<void> {
    this.ctx = ctx;
    if (!supportsGpuNBody(ctx.renderer)) throw new Error('This device cannot render to float textures (EXT_color_buffer_float).');
    ctx.post.exposure = 1;
    ctx.post.bloomStrength = 0.08;
    ctx.post.bloomRadius = 0.85;
    ctx.post.vignette = 0.2;
    ctx.post.tonemap = 'agx';
    ctx.post.saturation = 1.35;
    // Seen from intergalactic space: only a sparse, faint field of foreground stars.
    this.sky = new Sky({ stars: Math.round(6000 * ctx.quality.detail), milkyWay: 0, brightness: 0.28, starSize: 0.9 });
    this.rig = new OrbitRig(ctx.input, { distance: 150, pitch: 0.5, yaw: 0.5, minDistance: 2, maxDistance: 4000, autoRotate: 0.02, idleDelay: 5 });
    this.readouts = {
      time: ctx.ui.readout('Time', 'Myr'),
      sep: ctx.ui.readout('Separation', 'kpc'),
      speed: ctx.ui.readout('Relative speed', 'km/s'),
      sfr: ctx.ui.readout('Star formation', 'M☉/yr'),
      drift: ctx.ui.readout('Energy drift', '%'),
    };
    this.timeline = new Timeline((t) => void this.goTo(t));
    ctx.ui.corner(this.timeline.el);
    this.buildPanel();
    this.bindKeys();
    ctx.audio.setMood('collision', { intensity: 0.4 });
    await this.load(presetById(ctx.params.get('preset') ?? 'antennae'), { initial: true });
    ctx.ui.hint('Drag to orbit · Scroll to zoom · Space pause · [ ] rate · P controls', 9000);
    ctx.signalReady();
  }

  // ——— UI ———

  private buildPanel(): void {
    const ui = this.ctx.ui;
    const enc = ui.section('Encounter');
    const presets = enc.buttons(
      [
        ...PRESETS.map((p) => ({ label: p.name.replace(/^The /, ''), onClick: () => void this.load(p, { about: true }) })),
        { label: 'Custom', onClick: () => void this.load(customPreset(this.custom), { about: true }) },
      ],
      0,
    );
    enc.button({ label: 'About this encounter', onClick: () => this.showInfo() });

    const time = ui.section('Time');
    const rate = time.slider({
      label: 'Rate',
      min: 1,
      max: 400,
      log: true,
      value: this.rate,
      unit: 'Myr/s',
      format: (v) => formatNumber(v, 2),
      onChange: (v) => (this.rate = v),
      help: 'Simulated millions of years per second of your time.',
    });
    const pause = time.button({ label: 'Pause', onClick: () => this.togglePause() });
    time.button({ label: 'Restart', onClick: () => void this.load(this.preset, { warm: false }) });

    const view = ui.section('View');
    view.buttons(
      [
        { label: 'Oblique', onClick: () => this.setView('oblique') },
        { label: 'Orbit plane', onClick: () => this.setView('orbit') },
        { label: 'Edge-on', onClick: () => this.setView('edge-on') },
      ],
      0,
    );
    const follow = view.select({
      label: 'Follow',
      value: 'pair',
      options: FOLLOW_OPTIONS,
      onChange: (v) => (this.follow = v === 'pair' ? 'pair' : (Number(v) as 0 | 1)),
    });
    view.toggle({ label: 'Dark matter (shown violet)', value: false, onChange: (v) => this.setLook({ darkMatter: v }), help: 'Dark matter emits no light; the live halo particles are drawn as a faint violet glow.' });
    view.toggle({ label: 'Dust', value: true, onChange: (v) => this.setLook({ dust: v ? 1 : 0 }) });
    view.toggle({ label: 'Young clusters & Hα', value: true, onChange: (v) => this.setLook({ youngStars: v }) });
    view.slider({ label: 'Exposure', min: 0.25, max: 4, log: true, value: 1, format: (v) => `×${formatNumber(v, 2)}`, onChange: (v) => (this.ctx.post.exposure = v) });

    const cus = ui.section('Design an encounter');
    cus.text('Two Sc spirals. Set the orbit and how each disk spins, then launch.');
    const derived = cus.readout('Approach speed');
    const upd = () => this.updateDerived();
    cus.slider({ label: 'Mass ratio', min: 1, max: 10, log: true, value: this.custom.massRatio, format: (v) => `1 : ${formatNumber(v, 2)}`, onChange: (v) => ((this.custom.massRatio = v), upd()) });
    cus.slider({ label: 'Pericentre', min: 1, max: 40, value: this.custom.rp, unit: 'kpc', format: (v) => v.toFixed(0), onChange: (v) => ((this.custom.rp = v), upd()) });
    cus.slider({
      label: 'Eccentricity',
      min: 0.5,
      max: 1.3,
      step: 0.01,
      value: this.custom.e,
      format: (v) => `${v.toFixed(2)} ${v < 0.98 ? 'bound' : v > 1.02 ? 'hyperbolic' : 'parabolic'}`,
      onChange: (v) => ((this.custom.e = v), upd()),
      help: 'Below 1 the galaxies are bound and fall back; above 1 they arrive faster than escape speed.',
    });
    cus.slider({ label: 'Primary disk tilt i₁', min: 0, max: 180, value: this.custom.i1, unit: '°', format: (v) => v.toFixed(0), onChange: (v) => (this.custom.i1 = v), help: '0° spins with the orbit (prograde), 180° against it (retrograde).' });
    cus.slider({ label: 'Companion disk tilt i₂', min: 0, max: 180, value: this.custom.i2, unit: '°', format: (v) => v.toFixed(0), onChange: (v) => (this.custom.i2 = v) });
    cus.slider({ label: 'Gas fraction', min: 0.05, max: 0.5, value: this.custom.gas, format: (v) => `${Math.round(v * 100)} %`, onChange: (v) => (this.custom.gas = v) });
    cus.button({
      label: 'Launch',
      primary: true,
      onClick: () => {
        presets.setActive(PRESETS.length);
        void this.load(customPreset(this.custom), { about: true });
      },
    });

    const phys = ui.section('Physics');
    phys.toggle({ label: 'Star formation', value: true, onChange: (v) => this.setLook({ starFormation: v }), help: 'Gas parcels form clusters at the Schmidt-law rate of their local density (ε_ff = 3 %).' });
    const particles = phys.readout('Particles');
    const momentum = phys.readout('Momentum drift');
    phys.text(
      'Dark halo, bulge and disk mass (the skeleton) attract each other particle by particle (direct N², leapfrog). ' +
        'Stars and gas are light tracers in that live field. Units: kpc, Myr, 10¹⁰ M☉; G = 0.04499 kpc³ Myr⁻² (10¹⁰ M☉)⁻¹.',
    );
    this.controls = { rate, presets, follow, pause, momentum, particles, derived };
    this.updateDerived();
  }

  private updateDerived(): void {
    const c = customPreset(this.custom);
    const [a, b] = c.scenario.galaxies.map((g) => g.spec.halo.mass + g.spec.bulge.mass + g.spec.disk.mass);
    const s = keplerStart(a, b, c.scenario.orbit);
    const v = Math.hypot(s.v[0], s.v[1], s.v[2]);
    this.controls?.derived(`${formatNumber(simToKms(v), 3)} km/s at ${c.scenario.orbit.r0.toFixed(0)} kpc`);
  }

  private bindKeys(): void {
    this.ctx.input.onKeyDown((e) => {
      if (e.code === 'Space') {
        this.togglePause();
        e.preventDefault();
      } else if (e.code === 'BracketRight') this.setRate(Math.min(400, this.rate * 1.5));
      else if (e.code === 'BracketLeft') this.setRate(Math.max(1, this.rate / 1.5));
      else if (e.code === 'KeyR') void this.load(this.preset, { warm: false });
      else if (/^Digit[1-5]$/.test(e.code)) {
        const i = Number(e.code.slice(5)) - 1;
        this.controls.presets.setActive(i);
        void this.load(i < PRESETS.length ? PRESETS[i] : customPreset(this.custom), { about: true });
      }
    });
  }

  private togglePause(): void {
    this.paused = !this.paused;
    const b = this.controls.pause.el.querySelector('button');
    if (b) b.textContent = this.paused ? 'Play' : 'Pause';
  }

  private setRate(v: number): void {
    this.rate = v;
    this.controls.rate.set(v);
  }

  private showInfo(): void {
    const p = this.preset;
    this.ctx.ui.info({ title: p.name, subtitle: p.designation, rows: p.facts, body: p.blurb });
  }

  setLook(o: Partial<CollisionExperience['look_']>): void {
    Object.assign(this.look_, o);
    this.applyLook();
  }

  private applyLook(): void {
    const g = this.galaxyRenderer;
    if (g) {
      g.dust = this.look_.dust;
      g.darkMatter = this.look_.darkMatter;
      g.youngStars = this.look_.youngStars;
    }
    if (this.sim) this.sim.starFormation = this.look_.starFormation;
  }

  // ——— Loading and jumping ———

  /** Queue a job so loads and jumps never interleave; newer requests cancel older ones. */
  private enqueue(fn: (gen: number) => Promise<void>): Promise<void> {
    const gen = ++this.gen;
    this.job = this.job.then(() => (gen === this.gen && !this.disposed ? fn(gen) : undefined)).catch((e) => console.error(e));
    return this.job;
  }

  /** Build a preset's scenario and integrate to its opening moment (or `to`). */
  load(preset: Preset, o: { warm?: boolean; to?: number; initial?: boolean; about?: boolean } = {}): Promise<void> {
    return this.enqueue(async (gen) => {
      const ctx = this.ctx;
      this.preset = preset;
      this.busy = 0;
      const report = (f: number, label: string) => {
        this.busy = f;
        if (o.initial) ctx.progress(0.05 + 0.95 * f, label);
      };
      report(0, preset.name);
      await this.yieldFrame();
      if (gen !== this.gen) return;
      const budget = budgetFor(ctx.quality.detail);
      const n = ctx.params.get('n');
      if (n) budget.tracers = Math.max(4096, Number(n));
      const sk = ctx.params.get('sk');
      if (sk) budget.skeleton = Math.max(768, Number(sk));
      const data = buildScenario(preset.scenario, budget);
      if (gen !== this.gen || this.disposed) return;
      this.sim?.dispose();
      this.galaxyRenderer?.dispose();
      this.data = data;
      const sim = new NBodySystem(ctx.renderer, data, { dt: preset.dt ?? 1, substeps: 4 });
      // Screenshots must be deterministic: read back synchronously (tiny textures).
      sim.syncReads = true;
      sim.requestDiagnostics(); // t = 0 reference for the energy drift
      sim.requestGalaxies();
      sim.syncReads = ctx.engine.shotMode;
      this.sim = sim;
      this.galaxyRenderer = new GalaxyRenderer({ data, exposure: 30, lightScale: 0.5 });
      this.applyLook();
      this.owed = 0;
      this.ev = { t: -1, s1: Infinity, s2: Infinity, passages: 0, lastPassage: -1e9, mergedSince: -1, merged: false };
      this.follow = preset.follow;
      this.controls.follow.set(String(preset.follow));
      this.setRate(preset.rate);
      const span = preset.moments.length ? preset.moments[preset.moments.length - 1].t * 1.12 : 1200;
      this.timeline.setMoments(preset.moments, span);
      this.rig.set({ distance: preset.view.distance, pitch: preset.view.pitch, yaw: preset.view.yaw });
      this.snapFollow();
      const wq = o.initial ? ctx.params.get('warm') : null; // dev: open at another time
      const target = o.to ?? (wq ? Number(wq) : o.warm === false ? 0 : preset.warmup);
      await this.integrate(sim, target, gen, (f) => report(f, 'Integrating'));
      if (gen !== this.gen) return;
      this.snapFollow();
      this.busy = null;
      if (o.about) this.showInfo();
      else if (!o.initial) ctx.ui.info(null);
    });
  }

  /** Jump to simulation time t (Myr): integrate forward, or rebuild and integrate when t is past. */
  goTo(t: number): Promise<void> {
    const sim = this.sim;
    if (!sim || t < sim.time - 0.5 * sim.dt) return this.load(this.preset, { to: Math.max(0, t) });
    return this.enqueue(async (gen) => {
      if (!this.sim) return;
      this.busy = 0;
      await this.integrate(this.sim, t, gen, (f) => (this.busy = f));
      if (gen === this.gen) this.busy = null;
    });
  }

  private yieldFrame(): Promise<void> {
    return new Promise((r) => setTimeout(r, 0));
  }

  /** Integrate to time t in chunks sized to ~30 ms, yielding to the frame loop in between. */
  private async integrate(sim: NBodySystem, t: number, gen: number, progress: (f: number) => void): Promise<void> {
    const t0 = sim.time;
    let chunk = this.ctx.engine.shotMode ? 64 : 4;
    while (sim.time < t - 0.5 * sim.dt) {
      if (gen !== this.gen || this.disposed) return;
      const n = Math.min(chunk, Math.round((t - sim.time) / sim.dt));
      const w0 = performance.now();
      for (let i = 0; i < n; i += 8) {
        sim.step(Math.min(8, n - i));
        sim.requestDiskRefit();
      }
      sim.requestGalaxies();
      sim.requestStarFormationRate();
      this.trackEvents(true);
      // Fast-forward shows every chunk: aim for ~30 ms of submitted work per frame (≤ 16 steps).
      // Shot mode (software GL) renders frames slowly, so integrate in big chunks there.
      const w = performance.now() - w0;
      chunk = this.ctx.engine.shotMode ? 64 : Math.max(2, Math.min(16, Math.round(chunk * (w > 40 ? 0.7 : w < 20 ? 1.4 : 1))));
      progress((sim.time - t0) / Math.max(1e-9, t - t0));
      await this.yieldFrame();
    }
    sim.requestDiagnostics();
    sim.requestGalaxies();
    sim.requestStarFormationRate();
    progress(1);
  }

  // ——— Frame loop ———

  update(f: FrameInfo): void {
    this.rig.update(f.dt);
    const sim = this.sim;
    if (!sim) return;
    if (this.busy === null) {
      this.frameCount++;
      if (!this.paused) this.owed += this.rate * f.dt;
      const maxSteps = 10;
      let n = Math.floor(this.owed / sim.dt);
      if (n > maxSteps) {
        n = maxSteps;
        this.owed = Math.min(this.owed, (maxSteps + 1) * sim.dt);
      }
      if (n > 0) {
        sim.step(n);
        this.owed -= n * sim.dt;
        if (this.frameCount % 4 === 0) sim.requestDiskRefit();
      }
      if (this.frameCount % 3 === 0) sim.requestGalaxies();
      if (this.frameCount % 20 === 0) sim.requestDiagnostics();
      if (this.frameCount % 30 === 0) sim.requestStarFormationRate();
      this.trackEvents(false);
    }
    this.updateFollow(f.dt);
    this.updateReadouts();
    this.moodTimer -= f.dt;
    if (this.moodTimer <= 0) {
      this.moodTimer = 1;
      const [a, b] = sim.galaxies;
      const sep = a.center.distanceTo(b.center);
      const sfr = sim.starFormationRate?.total ?? 0;
      this.ctx.audio.setMood('collision', { intensity: Math.min(1, 0.25 + 0.5 * Math.exp(-sep / 30) + 0.02 * sfr), separation: sep, sfr });
    }
  }

  /** Pericentre passages and coalescence, detected from the (filtered) centre separation. */
  private trackEvents(quiet: boolean): void {
    const sim = this.sim!;
    const e = this.ev;
    if (sim.galaxiesTime === e.t) return;
    e.t = sim.galaxiesTime;
    const [a, b] = sim.galaxies;
    const s = a.center.distanceTo(b.center);
    if (e.s1 < e.s2 && e.s1 < s && e.s1 < 60 && e.t - e.lastPassage > 60 && !e.merged) {
      e.lastPassage = e.t;
      const name = ORDINALS[Math.min(e.passages, ORDINALS.length - 1)];
      e.passages++;
      if (!quiet) {
        this.ctx.ui.toast(`${name} passage · ${formatNumber(e.s1, 2)} kpc apart`, 4000);
        this.ctx.audio.event('collision-passage', { intensity: Math.min(1, 10 / Math.max(1, e.s1)) });
      }
    }
    if (s < 2.5) {
      if (e.mergedSince < 0) e.mergedSince = e.t;
      if (!e.merged && e.t - e.mergedSince > 80) {
        e.merged = true;
        if (!quiet) {
          this.ctx.ui.toast('The two nuclei have merged', 5000);
          this.ctx.audio.event('collision-merger', { intensity: 1 });
        }
      }
    } else e.mergedSince = -1;
    e.s2 = e.s1;
    e.s1 = s;
  }

  private followPoint(out: THREE.Vector3): THREE.Vector3 {
    const sim = this.sim!;
    const [a, b] = sim.galaxies;
    if (this.follow !== 'pair') return out.copy(sim.galaxies[this.follow].center);
    const ma = this.data!.galaxies[0].mass, mb = this.data!.galaxies[1].mass;
    return out.copy(a.center).multiplyScalar(ma).addScaledVector(b.center, mb).multiplyScalar(1 / (ma + mb));
  }

  private snapFollow(): void {
    if (!this.sim) return;
    this.followPoint(this.tmpV);
    this.rig.goal.target.copy(this.tmpV);
    this.rig.target.copy(this.tmpV);
  }

  private updateFollow(dt: number): void {
    this.followPoint(this.tmpV);
    const k = 1 - Math.exp(-dt / 1.2);
    this.rig.goal.target.lerp(this.tmpV, k);
  }

  private updateReadouts(): void {
    const sim = this.sim!;
    const [a, b] = sim.galaxies;
    const clock = this.preset.clock;
    const t = sim.time + (clock?.offsetMyr ?? 0);
    const timeText = clock ? `${formatNumber(t / 1000, 3)} Gyr ${clock.label}` : `${formatNumber(sim.time, 4)} Myr`;
    if (clock) this.readouts.time.set(formatNumber(t / 1000, 3), `Gyr ${clock.label}`);
    else this.readouts.time.set(formatNumber(sim.time, 4), 'Myr');
    this.readouts.sep.set(formatNumber(a.center.distanceTo(b.center), 3));
    this.readouts.speed.set(formatNumber(simToKms(a.velocity.distanceTo(b.velocity)), 3));
    const sfr = sim.starFormationRate;
    this.readouts.sfr.set(sfr ? formatNumber(sfr.total, 2) : '—');
    const d = sim.diagnostics, d0 = sim.initialDiagnostics;
    if (d && d0) {
      this.readouts.drift.set(formatNumber((100 * (d.energy - d0.energy)) / Math.abs(d0.energy), 2));
      if (this.frameCount % 30 === 0) {
        // Momentum drift relative to the momentum scale Σ m|v|.
        const P = Math.hypot(d.momentum[0] - d0.momentum[0], d.momentum[1] - d0.momentum[1], d.momentum[2] - d0.momentum[2]);
        const scale = Math.sqrt(2 * d0.kinetic * (this.data!.galaxies[0].mass + this.data!.galaxies[1].mass));
        this.controls.momentum(`${formatNumber((100 * P) / Math.max(scale, 1e-30), 2)} %`);
      }
    }
    if (this.frameCount % 60 === 1) {
      this.controls.particles(`${formatNumber(sim.skeletonCount, 3)} heavy · ${formatNumber(sim.tracerCount, 3)} stars & gas`);
    }
    this.timeline.update(sim.time, this.preset.name, timeText, this.busy);
  }

  render(target: THREE.WebGLRenderTarget): void {
    const r = this.ctx.renderer;
    this.camera.aspect = target.width / target.height;
    // Portrait screens: widen the vertical field so the pair keeps its horizontal framing.
    const widen = Math.pow(Math.max(1, 1.4 / this.camera.aspect), 0.8);
    this.camera.fov = Math.min(75, (360 / Math.PI) * Math.atan(Math.tan((20 * Math.PI) / 180) * widen));
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
      const dCenter = -mid.applyMatrix4(this.camera.matrixWorldInverse).z;
      const radius = 0.5 * a.center.distanceTo(b.center) + 40;
      this.galaxyRenderer.render(r, this.camera, target, {
        pos: sim.tracerPosition,
        vel: sim.tracerVelocity,
        attr: sim.tracerAttributes,
        skeletonPos: sim.skeletonPosition,
        time: sim.time,
        extrapolate: this.paused || this.busy !== null ? 0 : Math.min(this.owed, sim.dt),
        depthNear: dCenter - radius,
        depthFar: dCenter + radius,
        pixelRatio: this.ctx.engine.pixelRatio,
      });
    }
  }

  // ——— Debug hooks (window.__universe.experience) ———

  /** Load a preset by id ('antennae' | 'mice' | 'cartwheel' | 'milkomeda' | 'custom'). */
  preset_(id: string, to?: number): Promise<void> {
    return this.load(id === 'custom' ? customPreset(this.custom) : presetById(id), to === undefined ? {} : { to });
  }
  /** Integrate (or rebuild and integrate) to simulation time t (Myr). */
  setTime(t: number): Promise<void> {
    return this.goTo(t);
  }
  setView(name: ViewName | string): void {
    const p = this.preset.view;
    const v: Record<string, { pitch: number; yaw?: number; distance?: number }> = {
      default: { pitch: p.pitch, yaw: p.yaw, distance: p.distance },
      oblique: { pitch: 0.55 },
      orbit: { pitch: 1.5 },
      'face-on': { pitch: 1.5 },
      'edge-on': { pitch: 0.02 },
    };
    const s = v[name];
    if (!s) return;
    const to = { pitch: s.pitch, yaw: s.yaw ?? this.rig.yaw, distance: s.distance ?? this.rig.distance };
    if (this.ctx.engine.shotMode) this.rig.set(to);
    else this.rig.flyTo(to, 1.6);
  }
  setDistance(d: number): void {
    this.rig.set({ distance: d });
  }
  setCamera(o: { distance?: number; pitch?: number; yaw?: number }): void {
    this.rig.set(o);
  }
  /** Debug: renderer knobs, e.g. look({ dust: 0, pointFraction: 0.5 }). */
  look(o: Partial<Record<'dust' | 'exposure' | 'pointFraction' | 'ngb', number>> & { darkMatter?: boolean; youngStars?: boolean }) {
    if (this.galaxyRenderer) Object.assign(this.galaxyRenderer, o);
    if (o.darkMatter !== undefined) this.look_.darkMatter = o.darkMatter;
    if (o.youngStars !== undefined) this.look_.youngStars = o.youngStars;
    if (o.dust !== undefined) this.look_.dust = o.dust;
  }
  gridStats() {
    return this.sim?.gridStats();
  }
  sfStats(window = 10) {
    return this.sim?.starFormationStats(window);
  }
  get state() {
    const sim = this.sim;
    return sim
      ? { preset: this.preset.id, time: sim.time, galaxies: sim.galaxies.map((g) => g.center.toArray()), diag: sim.diagnostics, sfr: sim.starFormationRate, busy: this.busy }
      : null;
  }

  unmount(): void {
    this.disposed = true;
    this.gen++;
    this.sim?.dispose();
    this.galaxyRenderer?.dispose();
    this.sky.dispose();
    this.sim = null;
    this.galaxyRenderer = null;
  }
}
