/**
 * Cosmic Web — structure formation in an expanding universe, simulated live.
 *
 * A particle-mesh N-body simulation (2LPT initial conditions from the Eisenstein & Hu spectrum,
 * FastPM kick–drift–kick steps, friends-of-friends halos) runs in a Web Worker and streams
 * keyframes; this experience plays cosmic history back from the recombination fireball to the
 * far future, interpolating between keyframes along the linear growth factor.
 */
import * as THREE from 'three';
import type { Experience, ExperienceContext, FrameInfo } from '../../core/types';
import { OrbitRig } from '../../core/rigs/OrbitRig';
import { FlyRig } from '../../core/rigs/FlyRig';
import type { Readout } from '../../ui/UI';
import type { Control } from '../../ui/Panel';
import { SimClient } from '../../worlds/cosmicweb/SimClient';
import { WebRenderer, type WebFrameState } from '../../worlds/cosmicweb/WebRenderer';
import { makeExpansion } from '../../worlds/cosmicweb/Simulation';
import type { CosmoParams, HaloCatalog, SimConfig, SimInfo } from '../../worlds/cosmicweb/types';
import { PLANCK_COSMO } from '../../worlds/cosmicweb/types';
import type { StoredFrame } from '../../worlds/cosmicweb/SnapshotStore';
import type { Expansion } from '../../physics/cosmosExpansion';
import { cosmicCalendar } from '../../physics/cosmology';
import { formatDuration, formatNumber, formatScientific } from '../../physics/units';
import { GYR } from '../../physics/constants';
import { cosmicSFRD, v200 } from '../../physics/cosmosGalaxies';
import { CosmicTimeline, fireballRadiance, type Epoch } from './timeline';
import { TimelineWidget } from './TimelineWidget';
import { ExpansionPlot, PowerPlot } from './plots';
import { COSMOS_CSS } from './style';
import { PRESETS, simConfigFor, type PresetId } from './config';

type ViewId = 'volume' | 'inside' | 'slice' | 'cluster' | 'void';
const VIEWS: Array<{ id: ViewId; label: string }> = [
  { id: 'volume', label: 'Volume' },
  { id: 'inside', label: 'Inside' },
  { id: 'slice', label: 'Slice' },
  { id: 'cluster', label: 'Cluster' },
  { id: 'void', label: 'Void' },
];
const SPEEDS = [0.25, 0.5, 1, 2, 4];
const SPEED_TEXT = SPEEDS.map((x) => `×${x}`);
/** Values decoded / particles packed per frame while playback approaches the next keyframe. */
const PREFETCH_VALUES = 900_000;
const STAGE_PARTICLES = 300_000;
/** Track units per second at ×1 — the whole history in about a minute. */
const BASE_RATE = 1 / 62;
const THIN = ' ';
const SIMULATING = `Simulating${THIN}…`;

const fmtZ = (z: number) => {
  const a = Math.abs(z);
  if (a >= 100) return formatNumber(Math.round(z), 6);
  if (a >= 10) return z.toFixed(1);
  return (z < 0 ? '−' : '') + a.toFixed(2);
};
const fmtDur = (gyr: number) => {
  const f = formatDuration(Math.abs(gyr) * GYR, 3);
  return { value: f.value, unit: f.unit };
};
const fmtMass = (m: number) => `${formatScientific(m, 2)}${THIN}M☉`;

class CosmicWebExperience implements Experience {
  private ctx!: ExperienceContext;
  private camera = new THREE.PerspectiveCamera(50, 1, 0.05, 2e5);
  private orbit!: OrbitRig;
  private fly!: FlyRig;
  private rigMode: 'orbit' | 'fly' = 'orbit';
  private client = new SimClient();
  private web: WebRenderer | null = null;
  private info: SimInfo | null = null;
  private config: SimConfig | null = null;
  private e!: Expansion;
  private planckE!: Expansion;
  private tl: CosmicTimeline | null = null;
  private cosmo: CosmoParams = { ...PLANCK_COSMO };
  private pending: CosmoParams = { ...PLANCK_COSMO };
  private box = 128;
  private seed = 42;
  private presetId: PresetId | null = 'planck';

  // playback
  private u = 0;
  private t = 0;
  private playing = true;
  private speedIdx = 2;
  private stopAtToday = true;
  private reachedToday = false;
  private introDone = false;
  private waiting = false;

  // presentation
  private coords: 'comoving' | 'physical' = 'comoving';
  private view: ViewId = 'volume';
  private galaxiesOn = true;
  private replicasOn = false;
  private outlineOn = true;
  private brightness = 1;
  private viewFade = 1;
  private viewFadeTarget = 1;
  private pendingView: (() => void) | null = null;
  private state: WebFrameState = {
    mix: 0,
    za: 0,
    D: 0,
    z: 1500,
    scale: 1,
    wrap: false,
    wrapCenter: new THREE.Vector3(0.5, 0.5, 0.5),
    fadeFar: 0,
    slab: null,
    darkMatter: 1,
    galaxies: 1,
    fieldGalaxies: 1,
    replicas: 0,
    outline: 1,
    exposure: 1,
    sfrBoost: 0,
    quench: 0,
    cmb: null,
  };
  private slabAxis = new THREE.Vector3(0, 1, 0);
  /** Reused every frame while the primordial glow is visible (no per-frame allocation). */
  private cmbState = { T: 3000, radiance: 0, aniso: 0 };
  private zKey = NaN;
  private zText = '';
  private disposed = false;

  // current keyframe interval
  private kA = -1;
  private kB = -1;
  private posA: Uint16Array | null = null;
  private posB: Uint16Array | null = null;

  // UI
  private styleEl: HTMLStyleElement | null = null;
  private timeline!: TimelineWidget;
  private caption!: HTMLElement;
  private captionKicker!: HTMLElement;
  private captionLine!: HTMLElement;
  private captionTimer = 0;
  private lastEpoch: Epoch | null = null;
  private epochSince = 0;
  private shownEpoch = '';
  private rdZ!: Readout;
  private rdAge!: Readout;
  private rdCal!: Readout;
  private rdEpoch!: Readout;
  private nowRows: Record<string, (v: string) => void> = {};
  private aPlot = new ExpansionPlot();
  private pkPlot = new PowerPlot();
  private readoutClock = 0;
  private fateLine!: (v: string) => void;
  private sliders: Record<string, Control<number>> = {};
  private presetChips!: { el: HTMLElement; setActive(i: number): void };
  private viewChips!: { el: HTMLElement; setActive(i: number): void };
  private normSelect!: Control<'sigma8' | 'As'>;
  private wiggleToggle!: Control<boolean>;
  private coordsToggle!: Control<boolean>;
  private galaxyToggle!: Control<boolean>;
  private replicaToggle!: Control<boolean>;
  private rerunBtn!: Control<void>;
  private ringHover!: HTMLElement;
  private ringSel!: HTMLElement;
  private selected = -1;
  private selectedFrame = -1;
  private hover = -1;
  private hoverClock = 0;
  private lastPointerMove = 0;
  private statusLine!: (v: string) => void;
  private progressLine = '';

  // scratch
  private v1 = new THREE.Vector3();
  private v2 = new THREE.Vector3();
  private v3 = new THREE.Vector3();

  mount(ctx: ExperienceContext): void {
    this.ctx = ctx;
    this.styleEl = document.createElement('style');
    this.styleEl.textContent = COSMOS_CSS;
    document.head.appendChild(this.styleEl);

    const p = ctx.params;
    const seedParam = Number(p.get('seed'));
    if (seedParam > 0) this.seed = Math.floor(seedParam);
    const boxParam = Number(p.get('box'));
    if (boxParam >= 50 && boxParam <= 1000) this.box = boxParam;
    const presetParam = p.get('preset') as PresetId | null;
    if (presetParam && PRESETS[presetParam]) {
      this.presetId = presetParam;
      this.cosmo = { ...PRESETS[presetParam].cosmo };
      this.pending = { ...this.cosmo };
    }
    this.planckE = makeExpansion(PLANCK_COSMO);
    this.e = makeExpansion(this.cosmo);

    ctx.post.exposure = 1;
    ctx.post.bloomStrength = 0.14;
    ctx.post.bloomRadius = 0.72;
    ctx.post.tonemap = 'aces';
    ctx.post.saturation = 1.08;
    ctx.post.vignette = 0.22;

    const L = this.box / this.cosmo.h;
    this.orbit = new OrbitRig(ctx.input, {
      distance: 2.05 * L,
      yaw: 0.62,
      pitch: 0.36,
      minDistance: 0.5,
      maxDistance: 12 * L,
      autoRotate: 0.028,
      idleDelay: 3,
      damping: 0.18,
    });
    this.fly = new FlyRig(ctx.input, { speed: 30, inertia: 0.5 });
    this.fly.enabled = false;

    this.buildUI();
    this.bindInput();
    this.startRun(false);
    ctx.audio.setMood('cosmos', { intensity: 0.35, z: 1500 });
    ctx.ui.hint('Drag to orbit · Scroll to zoom · Space play/pause · ←/→ scrub · Click a cluster · V views · X expansion · F fly', 9000);
    ctx.signalReady();
  }

  // ——— Simulation lifecycle ———

  private startRun(keepTime: boolean): void {
    const ctx = this.ctx;
    this.config = simConfigFor(ctx.quality, this.cosmo, this.box, this.seed, ctx.params);
    this.e = makeExpansion(this.cosmo);
    this.info = null;
    this.kA = this.kB = -1;
    this.posA = this.posB = null;
    this.selected = -1;
    this.ctx.ui.info(null);
    const cfg = this.config;
    this.progressLine = 'Seeding primordial fluctuations';
    this.client.start(cfg, {
      info: (info) => this.onInfo(info),
      keyframe: () => this.onKeyframe(),
      progress: (f, label) => (this.progressLine = f < 1 ? `${label} · ${Math.round(f * 100)} %` : ''),
      done: (ms) => {
        this.progressLine = '';
        if (this.ctx) this.statusLine?.(`${this.info?.count.toLocaleString('en-US') ?? ''} particles · simulated in ${(ms / 1000).toFixed(1)} s${this.client.mainThread ? ' (main thread)' : ''}`);
      },
      error: (msg) => {
        this.progressLine = '';
        this.ctx.ui.toast(msg, 5000);
      },
    });
    // The timeline is known before the first keyframe: build it from the planned schedule.
    const sched = this.plannedSchedule(cfg);
    this.tl = new CosmicTimeline(this.e, sched.t0, sched.tEnd);
    this.timeline.setTicks(this.tl.ticks());
    this.aPlot.setModel(this.e, this.presetId === 'planck' ? null : this.planckE, this.tl.tEnd);
    if (!keepTime) {
      this.u = 0;
      this.reachedToday = false;
      this.playing = true;
    } else {
      // Re-runs replay structure formation from the start of the simulation.
      this.u = this.tl.uIC * 0.999;
      this.reachedToday = false;
      this.playing = true;
      this.introDone = true;
    }
    this.t = this.tl.tOfU(this.u);
  }

  private plannedSchedule(cfg: SimConfig): { t0: number; tEnd: number } {
    const e = this.e;
    const t0 = e.timeOfA(cfg.aInit);
    let tEnd: number;
    if (!e.recollapses) tEnd = e.timeOfA(Math.max(1.05, cfg.aFuture));
    else {
      let lo = e.tTurn, hi = Math.min(e.tCrunch, e.tEnd);
      for (let k = 0; k < 60; k++) {
        const m = 0.5 * (lo + hi);
        if (e.aAt(m) > 0.4 * e.aMax) lo = m;
        else hi = m;
      }
      tEnd = lo;
    }
    if (!isFinite(tEnd)) tEnd = e.tEnd;
    return { t0, tEnd };
  }

  private onInfo(info: SimInfo): void {
    this.info = info;
    const L = info.box / this.cosmo.h;
    // Every run gets a fresh renderer: the Lagrangian overdensities (field galaxies), σL and the
    // collapsed-fraction variances belong to the run — reusing the old one after "Re-run" with a
    // new seed lit field galaxies at the previous universe's peaks.
    this.web?.dispose();
    this.web = null;
    this.fireballFallback?.dispose();
    this.fireballFallback = null;
    const varR = info.sigmaL * info.sigmaL;
    const sig11 = this.sigmaAtMass11();
    const opts = {
      np: info.np,
      count: info.count,
      nm: info.nm,
      boxWorld: L,
      deltaL: info.deltaL,
      sigmaL: info.sigmaL,
      varDwarf: Math.max(0.5, info.sigmaMin2 - varR),
      varBright: Math.max(0.3, sig11 - varR),
      detail: this.ctx.quality.detail,
    };
    this.web = new WebRenderer(this.ctx.renderer, opts);
    this.web.pixelRatio = this.ctx.engine.pixelRatio;
    this.web.resize(this.ctx.engine.width, this.ctx.engine.height);
    this.statusLine?.(`${info.count.toLocaleString('en-US')} particles · ${info.nm}³ mesh · ${formatNumber(L, 3)} Mpc box · m = ${formatScientific(info.particleMass, 2)} M☉`);
    // Power-spectrum axes for this run.
    const kf = (2 * Math.PI) / info.box;
    this.pkPlot.setRange(kf * 0.9, kf * info.nm * 0.5 * 1.05, 1, 3e5);
  }

  /** σ² of the linear field at 10¹¹ M☉ (luminous-galaxy halos) for this cosmology, today. */
  private sigmaAtMass11(): number {
    // Cheap fit: σ(M) ∝ M^(−0.1…−0.2) around 10¹¹; scale from σ8 via the EH shape is overkill here.
    const s8 = this.info?.sigma8 ?? 0.81;
    const Om = this.cosmo.Om0;
    // σ(10¹¹ h⁻¹M☉) ≈ 3.1 σ8/0.81 for Planck-like shapes, steeper for high Ωm h (more small-scale power).
    const shape = Math.pow(Math.max(Om * this.cosmo.h, 0.03) / 0.21, 0.35);
    const s = 3.1 * (s8 / 0.81) * shape;
    return s * s;
  }

  private onKeyframe(): void {
    // Nothing to do eagerly: update() picks up new frames. Refresh the plot range once.
    const st = this.client.store;
    if (st && st.length === 1) this.kA = this.kB = -1;
  }

  // ——— UI ———

  private buildUI(): void {
    const ctx = this.ctx;
    this.timeline = new TimelineWidget({
      scrub: (u, done) => this.scrubTo(u, done),
      toggle: () => this.togglePlay(),
      speed: () => this.cycleSpeed(1),
    });
    ctx.ui.corner(this.timeline.el);

    this.caption = document.createElement('div');
    this.caption.className = 'cw-caption';
    this.captionKicker = document.createElement('div');
    this.captionKicker.className = 'cw-caption-kicker';
    this.captionLine = document.createElement('div');
    this.captionLine.className = 'cw-caption-line';
    this.caption.append(this.captionKicker, this.captionLine);
    ctx.ui.overlay.appendChild(this.caption);

    this.ringHover = document.createElement('div');
    this.ringHover.className = 'cw-ring';
    this.ringHover.hidden = true;
    this.ringHover.appendChild(document.createElement('span'));
    this.ringSel = document.createElement('div');
    this.ringSel.className = 'cw-ring is-selected';
    this.ringSel.hidden = true;
    this.ringSel.appendChild(document.createElement('span'));
    ctx.ui.overlay.append(this.ringHover, this.ringSel);

    this.rdZ = ctx.ui.readout('Redshift');
    this.rdAge = ctx.ui.readout('Cosmic time');
    this.rdCal = ctx.ui.readout('Cosmic calendar');
    this.rdEpoch = ctx.ui.readout('Epoch');

    // Universe (cosmology)
    const u = ctx.ui.section('Universe');
    const ids = Object.keys(PRESETS) as PresetId[];
    this.presetChips = u.buttons(
      ids.map((id) => ({ label: PRESETS[id].label, onClick: () => this.applyPreset(id) })),
      this.presetId ? ids.indexOf(this.presetId) : undefined,
    );
    const fmt2 = (v: number) => v.toFixed(2);
    this.sliders.Om = u.slider({ label: 'Matter Ωm', min: 0.05, max: 3, value: this.pending.Om0, format: fmt2, onChange: (v) => this.edit({ Om0: v }), help: 'Density of all matter today (dark + ordinary), in units of the critical density.' });
    this.sliders.Ol = u.slider({ label: 'Dark energy ΩΛ', min: -0.5, max: 1.5, value: this.pending.Ode0, format: fmt2, onChange: (v) => this.edit({ Ode0: v }), help: 'Cosmological constant. Ωk = 1 − Ωm − ΩΛ is the curvature.' });
    this.sliders.h = u.slider({ label: 'Hubble constant', min: 50, max: 90, value: this.pending.h * 100, unit: 'km/s/Mpc', format: (v) => v.toFixed(1), onChange: (v) => this.edit({ h: v / 100 }) });
    this.normSelect = u.select({
      label: 'Normalise to',
      value: this.pending.norm,
      options: [
        { value: 'sigma8', label: 'σ8 today' },
        { value: 'As', label: 'Early universe (Aₛ)' },
      ],
      onChange: (v) => this.edit({ norm: v }),
      help: 'σ8: fix today’s clumpiness. Aₛ: fix the primordial fluctuations and let each universe grow its own structure.',
    });
    this.sliders.s8 = u.slider({ label: 'σ8', min: 0.3, max: 1.5, value: this.pending.sigma8, format: (v) => v.toFixed(3), onChange: (v) => this.edit({ sigma8: v }) });
    this.sliders.As = u.slider({ label: 'Aₛ × 10⁹', min: 0.5, max: 6, value: this.pending.As * 1e9, format: (v) => v.toFixed(2), onChange: (v) => this.edit({ As: v * 1e-9 }) });
    this.sliders.ns = u.slider({ label: 'Spectral index nₛ', min: 0.8, max: 1.1, value: this.pending.ns, format: (v) => v.toFixed(3), onChange: (v) => this.edit({ ns: v }) });
    this.wiggleToggle = u.toggle({ label: 'Baryon acoustic wiggles', value: this.pending.wiggles, onChange: (v) => this.edit({ wiggles: v }) });
    this.sliders.box = u.slider({ label: 'Box size', min: 60, max: 500, step: 5, value: this.box / this.cosmo.h, unit: 'Mpc', format: (v) => v.toFixed(0), onChange: () => this.markDirty() });
    this.sliders.seed = u.slider({ label: 'Seed', min: 1, max: 999, step: 1, value: this.seed, format: (v) => v.toFixed(0), onChange: () => this.markDirty() });
    this.fateLine = u.readout('Fate');
    this.rerunBtn = u.button({ label: 'Re-run simulation', primary: true, onClick: () => this.rerun() });
    this.syncNormControls();
    this.updateFate();

    // View
    const v = ctx.ui.section('View');
    this.viewChips = v.buttons(VIEWS.map((vw) => ({ label: vw.label, onClick: () => this.setView(vw.id) })), 0);
    this.coordsToggle = v.toggle({
      label: 'Physical coordinates',
      value: false,
      onChange: (on) => this.setCoords(on ? 'physical' : 'comoving'),
      help: 'Comoving coordinates follow the expansion; physical ones show space itself stretching (X).',
    });
    this.galaxyToggle = v.toggle({ label: 'Galaxies', value: true, onChange: (on) => (this.galaxiesOn = on) });
    this.replicaToggle = v.toggle({ label: 'Periodic neighbours', value: false, onChange: (on) => (this.replicasOn = on), help: 'The simulated box tiles an infinite universe.' });
    v.toggle({ label: 'Box outline', value: true, onChange: (on) => (this.outlineOn = on) });
    v.toggle({ label: 'Stop at today', value: true, onChange: (on) => (this.stopAtToday = on) });
    v.slider({ label: 'Brightness', min: 0.3, max: 3, log: true, value: 1, format: (x) => `×${x.toFixed(2)}`, onChange: (x) => (this.brightness = x) });

    // Now
    const n = ctx.ui.section('Now');
    n.custom(this.aPlot.el);
    const row = (label: string) => (this.nowRows[label] = n.readout(label));
    row('Scale factor a');
    row('Lookback time');
    row('Hubble rate H');
    row('CMB temperature');
    row('Ωm · ΩΛ');
    row('σ8 (linear)');
    row('Halos found');
    n.custom(this.pkPlot.el);
    n.text('Dashed: linear theory D²P(k). Solid: the simulation. On small scales gravity has pushed it far above linear growth.');

    const about = ctx.ui.section('About');
    about.text(
      'Dark matter only: 2LPT initial conditions from the Eisenstein & Hu (1998) spectrum, then a particle-mesh N-body run with FastPM time steps (Feng et al. 2016), in a Web Worker. Halos: friends-of-friends (b = 0.2). Galaxies: Moster et al. (2013) stellar masses; faint galaxies from extended Press–Schechter. Colour shows local density (false colour); brightness shows projected density.',
    );
    this.statusLine = about.readout('Run');
  }

  private syncNormControls(): void {
    const s8 = this.pending.norm === 'sigma8';
    this.sliders.s8.setDisabled(!s8);
    this.sliders.As.setDisabled(s8);
  }

  private edit(p: Partial<CosmoParams>): void {
    Object.assign(this.pending, p);
    this.presetId = null;
    this.presetChips.setActive(-1);
    this.syncNormControls();
    this.markDirty();
  }

  private markDirty(): void {
    this.updateFate();
  }

  private fateClock = 0;
  private updateFate(): void {
    clearTimeout(this.fateClock);
    this.fateClock = window.setTimeout(() => {
      const e = makeExpansion(this.pending);
      let s: string;
      if (!e.bigBang) s = 'No Big Bang — bounces';
      else if (e.recollapses) s = `Recollapses · crunch at ${e.toGyr(e.tCrunch).toFixed(1)} Gyr`;
      else if (isFinite(e.tAccel)) s = `Expands forever · accelerating`;
      else s = 'Expands forever';
      const ok = e.bigBang && isFinite(e.tToday);
      this.rerunBtn?.setDisabled(!ok);
      this.fateLine?.(`${s} · age ${ok ? e.toGyr(e.tToday).toFixed(2) : '—'} Gyr`);
    }, 120);
  }

  private applyPreset(id: PresetId): void {
    const pr = PRESETS[id];
    this.presetId = id;
    this.pending = { ...pr.cosmo };
    this.sliders.Om.set(this.pending.Om0);
    this.sliders.Ol.set(this.pending.Ode0);
    this.sliders.h.set(this.pending.h * 100);
    this.sliders.s8.set(this.pending.sigma8);
    this.sliders.As.set(this.pending.As * 1e9);
    this.sliders.ns.set(this.pending.ns);
    this.normSelect.set(this.pending.norm);
    this.wiggleToggle.set(this.pending.wiggles);
    this.syncNormControls();
    this.updateFate();
    this.ctx.ui.toast(`${pr.label}: ${pr.blurb}`, 6500);
    this.rerun();
  }

  private rerun(): void {
    const e = makeExpansion(this.pending);
    if (!e.bigBang || !isFinite(e.tToday)) {
      this.ctx.ui.toast('That universe has no Big Bang leading to today — try less dark energy.', 4000);
      return;
    }
    this.cosmo = { ...this.pending };
    this.box = Math.round(this.sliders.box.get() * this.cosmo.h);
    this.seed = Math.round(this.sliders.seed.get());
    this.startRun(true);
    this.ctx.audio.event('portal');
  }

  // ——— Interaction ———

  private bindInput(): void {
    const inp = this.ctx.input;
    inp.onKeyDown((e) => {
      if (e.repeat && e.code !== 'ArrowLeft' && e.code !== 'ArrowRight') return;
      switch (e.code) {
        case 'Space':
          if (this.rigMode === 'fly') return;
          e.preventDefault();
          this.togglePlay();
          break;
        case 'KeyK':
          this.togglePlay();
          break;
        case 'ArrowLeft':
        case 'ArrowRight': {
          const du = (e.code === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 0.04 : 0.008);
          this.scrubTo(this.u + du, true);
          break;
        }
        case 'BracketLeft':
          this.cycleSpeed(-1);
          break;
        case 'BracketRight':
          this.cycleSpeed(1);
          break;
        case 'KeyX':
          this.setCoords(this.coords === 'comoving' ? 'physical' : 'comoving');
          this.coordsToggle.set(this.coords === 'physical');
          break;
        case 'KeyG':
          this.galaxiesOn = !this.galaxiesOn;
          this.galaxyToggle.set(this.galaxiesOn);
          break;
        case 'KeyV': {
          const i = VIEWS.findIndex((v) => v.id === this.view);
          this.setView(VIEWS[(i + 1) % VIEWS.length].id);
          break;
        }
        case 'KeyF':
          this.setRig(this.rigMode === 'orbit' ? 'fly' : 'orbit');
          break;
        case 'Home':
          this.scrubTo(0, true);
          this.playing = true;
          break;
      }
    });
    inp.onTap((tap) => this.pick(tap.x, tap.y, false));
    inp.onDoubleTap((tap) => this.pick(tap.x, tap.y, true));
    inp.onMove(() => (this.lastPointerMove = performance.now()));
  }

  private togglePlay(): void {
    if (!this.tl) return;
    if (!this.playing && this.u >= 0.9999) this.u = 0;
    if (!this.playing && Math.abs(this.u - this.tl.uToday) < 1e-3) this.reachedToday = true;
    this.playing = !this.playing;
  }

  private cycleSpeed(d: number): void {
    this.speedIdx = Math.max(0, Math.min(SPEEDS.length - 1, this.speedIdx + d));
  }

  private scrubTo(u: number, done: boolean): void {
    if (!this.tl) return;
    const max = this.bufferedU();
    this.u = Math.max(0, Math.min(max, u));
    if (!done) this.playing = false;
    if (this.u >= this.tl.uToday - 1e-4) this.reachedToday = true;
    else this.reachedToday = false;
    this.introDone = this.u > this.tl.uIC;
    this.readoutClock = 0;
  }

  /**
   * Orbit distance of the overview. In physical coordinates the camera holds a fixed physical
   * distance (sized for the box at a ≈ 1.6), so the growth of the box itself is the expansion.
   */
  private volumeDistance(): number {
    const Lc = (this.info?.box ?? this.box) / this.cosmo.h;
    return this.coords === 'physical' ? 3.4 * Lc : 2.05 * Lc;
  }

  private setCoords(c: 'comoving' | 'physical'): void {
    this.coords = c;
    if (this.view === 'volume') this.orbit.flyTo({ distance: this.volumeDistance() }, 2.2);
    this.ctx.ui.toast(c === 'physical' ? 'Physical coordinates — watch space itself expand' : 'Comoving coordinates — the expansion factored out', 2600);
  }

  private setRig(mode: 'orbit' | 'fly'): void {
    if (mode === this.rigMode) return;
    this.rigMode = mode;
    if (mode === 'fly') {
      this.fly.position.copy(this.orbit.position);
      this.fly.quaternion.copy(this.orbit.quaternion);
      this.fly.velocity.set(0, 0, 0);
      const L = this.boxWorld();
      this.fly.speed = 0.08 * L;
      this.fly.enabled = true;
      this.orbit.enabled = false;
      if (!this.state.wrap) this.setView('inside', true);
      this.ctx.ui.hint('Fly: drag to look · W/A/S/D move · R/F up/down · Q/E roll · Shift boost · wheel sets speed · F to orbit', 7000);
    } else {
      this.fly.enabled = false;
      this.orbit.enabled = true;
      // Re-seat the orbit around a point ahead of the ship.
      const fwd = this.v1.set(0, 0, -1).applyQuaternion(this.fly.quaternion);
      const d = Math.max(5, this.orbit.distance);
      const target = this.v2.copy(this.fly.position).addScaledVector(fwd, d);
      const rel = this.v3.copy(this.fly.position).sub(target);
      this.orbit.set({ target, distance: d, yaw: Math.atan2(rel.x, rel.z), pitch: Math.asin(THREE.MathUtils.clamp(rel.y / d, -1, 1)) });
    }
  }

  /** World size of the box right now (comoving L, or a·L in physical coordinates). */
  private boxWorld(): number {
    const L = (this.info?.box ?? this.box) / this.cosmo.h;
    return L * (this.coords === 'physical' ? this.e.aAt(this.t) : 1);
  }

  private setView(id: ViewId, immediate = false): void {
    const apply = () => {
      this.view = id;
      const L = this.boxWorld();
      const halos = this.currentHalos();
      const o = this.orbit;
      if (this.rigMode === 'fly' && id !== 'inside') this.setRig('orbit');
      switch (id) {
        case 'volume':
          this.state.wrap = false;
          this.state.slab = null;
          o.flyTo({ target: new THREE.Vector3(), distance: this.volumeDistance(), pitch: 0.36 }, 2.6);
          o.autoRotate = 0.028;
          break;
        case 'slice':
          this.state.wrap = false;
          this.state.slab = { axis: this.slabAxis, center: 0.5, half: 0.06 };
          o.flyTo({ target: new THREE.Vector3(), distance: 1.12 * L, pitch: Math.PI / 2 - 0.02, yaw: 0 }, 2.6);
          o.autoRotate = 0.012;
          break;
        case 'inside':
        case 'cluster': {
          this.state.wrap = true;
          this.state.slab = null;
          const target = new THREE.Vector3();
          let dist = 0.16 * L;
          if (halos && halos.count > 0) {
            const k = id === 'cluster' ? 0 : Math.min(halos.count - 1, 2);
            this.haloWorld(halos, k, target);
            if (id === 'cluster') dist = Math.max(0.1 * L, (halos.r200[0] / 1000) * 25);
          }
          o.flyTo({ target, distance: dist, pitch: 0.25 }, 3);
          o.autoRotate = id === 'cluster' ? 0.06 : 0.035;
          if (id === 'cluster' && halos && halos.count > 0) this.select(0);
          break;
        }
        case 'void': {
          this.state.wrap = true;
          this.state.slab = null;
          const f = this.frameNear();
          const target = new THREE.Vector3();
          if (f && f.stats.voids.length >= 3) {
            const s = this.coords === 'physical' ? this.e.aAt(this.t) : 1;
            const Lc = ((this.info?.box ?? this.box) / this.cosmo.h) * s;
            target.set((f.stats.voids[0] - 0.5) * Lc, (f.stats.voids[1] - 0.5) * Lc, (f.stats.voids[2] - 0.5) * Lc);
          }
          o.flyTo({ target, distance: 0.035 * L, pitch: 0.1 }, 3);
          o.autoRotate = 0.02;
          break;
        }
      }
      this.viewChips.setActive(VIEWS.findIndex((v) => v.id === id));
    };
    if (immediate) {
      apply();
      return;
    }
    // Cross-fade through black so the change of framing (wrap/slab) never pops.
    this.viewFadeTarget = 0;
    this.pendingView = () => {
      apply();
      this.viewFadeTarget = 1;
    };
  }

  // ——— Halos & picking ———

  private frameNear(): StoredFrame | null {
    const st = this.client.store;
    if (!st || !st.length) return null;
    if (this.kA < 0) return null;
    const k = this.state.za >= 0 ? 0 : this.state.mix < 0.5 ? this.kA : this.kB;
    return st.frames[k] ?? null;
  }

  private currentHalos(): HaloCatalog | null {
    const f = this.frameNear();
    return f && f.halos.count ? f.halos : null;
  }

  /** Interpolated box-fraction position of particle p. */
  private boxPos(p: number, out: THREE.Vector3): THREE.Vector3 {
    const A = this.posA, B = this.posB;
    if (!A) return out.set(0.5, 0.5, 0.5);
    const s = 1 / 65536;
    const wrap = (d: number) => d - Math.floor(d + 0.5);
    const fr = (x: number) => x - Math.floor(x);
    if (this.state.za >= 0 || !B) {
      out.set(A[3 * p] * s, A[3 * p + 1] * s, A[3 * p + 2] * s);
      return out;
    }
    const m = this.state.mix;
    const ax = A[3 * p] * s, ay = A[3 * p + 1] * s, az = A[3 * p + 2] * s;
    out.set(fr(ax + m * wrap(B[3 * p] * s - ax)), fr(ay + m * wrap(B[3 * p + 1] * s - ay)), fr(az + m * wrap(B[3 * p + 2] * s - az)));
    return out;
  }

  /** Box fraction → world position, matching the shaders' placeWorld(). */
  private worldOf(u: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const Lw = this.boxWorld();
    if (this.state.wrap) {
      const c = this.state.wrapCenter;
      const f = (x: number, cc: number) => x - cc + 0.5 - Math.floor(x - cc + 0.5) - 0.5 + (cc - 0.5);
      return out.set(f(u.x, c.x) * Lw, f(u.y, c.y) * Lw, f(u.z, c.z) * Lw);
    }
    return out.set((u.x - 0.5) * Lw, (u.y - 0.5) * Lw, (u.z - 0.5) * Lw);
  }

  private haloWorld(h: HaloCatalog, i: number, out: THREE.Vector3): THREE.Vector3 {
    this.boxPos(h.host[i], this.v3);
    return this.worldOf(this.v3, out);
  }

  private pick(x: number, y: number, fly: boolean): void {
    const h = this.currentHalos();
    if (!h) return;
    const cam = this.camera;
    const W = this.ctx.canvas.clientWidth, H = this.ctx.canvas.clientHeight;
    let best = -1, bd = 26 * 26;
    const n = Math.min(h.count, 4000);
    for (let i = 0; i < n; i++) {
      this.haloWorld(h, i, this.v1);
      this.v1.project(cam);
      if (this.v1.z < -1 || this.v1.z > 1) continue;
      const sx = (this.v1.x * 0.5 + 0.5) * W, sy = (-this.v1.y * 0.5 + 0.5) * H;
      // Prefer massive halos: effective distance shrinks with mass.
      const d2 = ((sx - x) ** 2 + (sy - y) ** 2) / Math.pow(h.mass[i] / h.mass[Math.min(n - 1, 50)], 0.25);
      if (d2 < bd) {
        bd = d2;
        best = i;
      }
    }
    if (best < 0) {
      if (!fly) this.select(-1);
      return;
    }
    this.select(best);
    if (fly) {
      const target = this.haloWorld(h, best, new THREE.Vector3());
      const dist = Math.max(3, (h.r200[best] / 1000) * 12);
      if (!this.state.wrap) {
        this.state.wrap = true;
        this.view = 'cluster';
        this.viewChips.setActive(3);
        this.haloWorld(h, best, target);
      }
      this.orbit.flyTo({ target, distance: dist }, 2.8);
      this.ctx.audio.event('select');
    }
  }

  private select(i: number): void {
    const h = this.currentHalos();
    this.selected = h && i >= 0 && i < h.count ? i : -1;
    const f = this.frameNear();
    this.selectedFrame = f ? f.index : -1;
    if (!h || this.selected < 0 || !f) {
      this.ctx.ui.info(null);
      return;
    }
    const m = h.mass[i];
    const r = h.r200[i];
    const vc = v200(m, r);
    const z = 1 / f.a - 1;
    const title = m >= 1e14 ? 'Galaxy cluster' : m >= 1e13 ? 'Galaxy group' : 'Massive halo';
    const compare =
      m >= 8e14
        ? 'As massive as the Coma Cluster: thousands of galaxies swarming through a sea of hot, X-ray-bright gas.'
        : m >= 1.5e14
          ? 'Comparable to the Virgo Cluster, the heart of our own Local Supercluster.'
          : m >= 3e13
            ? 'A rich group, like the Fornax or Hickson compact groups — ellipticals dominate its core.'
            : m >= 5e12
              ? 'A galaxy group, a few times heavier than our Local Group (Milky Way + Andromeda).'
              : 'A massive galaxy halo.';
    const rTxt = r >= 1000 ? `${(r / 1000).toFixed(2)}${THIN}Mpc` : `${r.toFixed(0)}${THIN}kpc`;
    this.ctx.ui.info({
      title,
      subtitle: `Friends-of-friends halo · z ${fmtZ(z)}`,
      rows: [
        ['Mass', fmtMass(m)],
        ['Virial radius R₂₀₀', rTxt],
        // The particle-mesh force is softened on the mesh scale (≳ R₂₀₀), which puffs halos up and
        // under-reports their internal motions; quote the virial (isothermal-sphere) value σ = V₂₀₀/√2.
        ['Velocity dispersion', `${formatNumber(vc / Math.SQRT2, 3)}${THIN}km/s`],
        ['Circular velocity V₂₀₀', `${formatNumber(vc, 3)}${THIN}km/s`],
        ['Galaxies (resolved)', String(h.ngal[i])],
        ['Simulation particles', h.npart[i].toLocaleString('en-US')],
      ],
      body: compare,
    });
  }

  // ——— Frame loop ———

  private bufferedU(): number {
    const tl = this.tl;
    if (!tl) return 0;
    const st = this.client.store;
    if (!st || !st.length) return tl.uIC * 0.999;
    const last = st.last()!;
    if (this.client.finished) return 1;
    return Math.min(1, tl.uOfT(last.t));
  }

  update(f: FrameInfo): void {
    const dt = f.dt;
    const tl = this.tl;
    if (!tl) return;
    // View cross-fade.
    const fadeRate = dt / 0.35;
    if (this.viewFade > this.viewFadeTarget) {
      this.viewFade = Math.max(this.viewFadeTarget, this.viewFade - fadeRate);
      if (this.viewFade <= 0 && this.pendingView) {
        const pv = this.pendingView;
        this.pendingView = null;
        pv();
      }
    } else if (this.viewFade < this.viewFadeTarget) this.viewFade = Math.min(this.viewFadeTarget, this.viewFade + fadeRate * 0.7);

    // Playback.
    const buffered = this.bufferedU();
    this.waiting = false;
    if (this.playing && !this.timeline.isDragging) {
      const rate = BASE_RATE * SPEEDS[this.speedIdx] * (this.u < tl.uIC ? 1.25 : 1);
      let u = this.u + dt * rate;
      if (this.stopAtToday && !this.reachedToday && u >= tl.uToday && this.u < tl.uToday + 1e-6) {
        u = tl.uToday;
        this.reachedToday = true;
        this.playing = false;
        this.ctx.audio.event('arrive');
      }
      if (u > buffered) {
        u = buffered;
        if (this.client.finished || u >= 1) this.playing = false;
        else this.waiting = true;
      }
      this.u = u;
      if (u >= 1) this.playing = false;
    }
    this.t = tl.tOfU(this.u);
    if (this.u > tl.uIC) this.introDone = true;

    const e = this.e;
    const t = this.t;
    const a = e.aAt(t);
    const z = 1 / a - 1;
    const D = e.DAt(t);
    const st = this.state;
    st.z = z;
    st.D = D;
    st.scale = this.coords === 'physical' ? a : 1;

    // Keyframe interval.
    this.selectInterval(t, D);

    // Epoch look: fireball, dark ages, the web lighting up.
    const T = 2.7255 / a;
    const glow = fireballRadiance(T);
    // Soft-capped so the 4000 K fireball stays a deep, saturated orange on screen.
    const glowShown = 0.2 * (1 - Math.exp(-glow / 0.2));
    if (glow > 1e-5) {
      const c = this.cmbState;
      c.T = T;
      c.radiance = glowShown;
      c.aniso = z < 1090 && (!e.recollapses || t < e.tTurn) ? 0.02 : 0;
      st.cmb = c;
    } else st.cmb = null;
    const lz = Math.log(1 + Math.max(z, 0));
    const dmIn = 1 - smooth(Math.log(40), Math.log(420), lz);
    // Up close (immersive views) the smoothed dark matter becomes a soft glow and the galaxies —
    // the only things a telescope would actually see — carry the scene.
    const immersive = st.wrap;
    st.darkMatter = dmIn * this.viewFade;
    if (this.web) {
      this.web.look.bright = immersive ? 0.16 : 0.3;
      this.web.look.galaxy = immersive ? 2e-3 : 3.5e-4;
    }
    // Galaxies: the first sparks after z ≈ 25, brightest near cosmic noon.
    const sfr = cosmicSFRD(Math.max(0, z)) / cosmicSFRD(0);
    st.sfrBoost = Math.min(4, 0.6 * (sfr - 1));
    st.quench = smooth(2.2, 0.3, Math.max(0, z));
    const gOn = this.galaxiesOn ? 1 : 0;
    st.galaxies = gOn * this.viewFade;
    st.fieldGalaxies = gOn * this.viewFade * (1 - smooth(Math.log(26), Math.log(40), lz));
    st.replicas = this.replicasOn || (this.coords === 'physical' && this.view === 'volume') ? 0.09 : 0;
    st.outline = this.outlineOn && !st.slab ? this.viewFade * (1 - Math.min(1, glow * 20)) : 0;
    // Gentle eye adaptation: the young, smooth web is dimmer (emission ∝ ρ², so it brightens as it
    // clumps); open the aperture a little at high redshift so early filaments stay readable.
    st.exposure = this.brightness * THREE.MathUtils.clamp(Math.pow(Math.max(D, 1e-3), -0.45), 1, 2.1);

    // Camera.
    const L = this.boxWorld();
    if (this.rigMode === 'orbit') {
      this.orbit.update(dt);
      this.orbit.applyTo(this.camera);
    } else {
      this.fly.update(dt);
      this.fly.applyTo(this.camera);
    }
    this.camera.near = Math.max(0.02, Math.min(0.5, (this.rigMode === 'orbit' ? this.orbit.distance : 10) * 0.002));
    this.camera.far = Math.max(50 * L, 1e3);
    if (st.wrap) {
      const Lw = L;
      st.wrapCenter.set(this.camera.position.x / Lw + 0.5, this.camera.position.y / Lw + 0.5, this.camera.position.z / Lw + 0.5);
      st.fadeFar = 0.5 * Lw;
    } else st.fadeFar = 0;

    // Captions & audio.
    this.updateEpoch(t, dt);

    // Readouts & plots (≈ 8 Hz).
    this.readoutClock -= dt;
    if (this.readoutClock <= 0) {
      this.readoutClock = 0.12;
      this.updateReadouts(t, a, z, D);
    }
    const busy = this.waiting ? SIMULATING : this.progressLine && this.u >= tl.uIC * 0.99 ? this.progressLine : '';
    // The redshift label changes a few times a second at most: rebuild it only then.
    const az = Math.abs(z);
    const zKey = az >= 100 ? Math.round(z) : az >= 10 ? Math.round(z * 10) + 0.25 : Math.round(z * 100) + 0.5;
    if (zKey !== this.zKey) {
      this.zKey = zKey;
      this.zText = `z ${fmtZ(z)}`;
    }
    this.timeline.update(this.u, buffered, this.playing, this.zText, SPEED_TEXT[this.speedIdx], busy);
    this.updateRings();
    this.prefetchNext();
  }

  /**
   * While playing forward, decode and pack the keyframe after the current interval a slice per
   * frame, so crossing into the next interval costs only a texture upload (no 10–20 ms stall).
   */
  private prefetchNext(): void {
    const store = this.client.store;
    const web = this.web;
    if (!store || !web || !this.playing || this.kB < 0) return;
    const next = this.kB + 1;
    if (next >= store.length) return;
    if (store.prefetch(next, PREFETCH_VALUES)) web.stage(next, store.positions(next), STAGE_PARTICLES);
  }

  private selectInterval(t: number, D: number): void {
    const store = this.client.store;
    const st = this.state;
    if (!store || !store.length || !this.web) {
      st.za = -1;
      return;
    }
    const k = store.frameAt(t);
    let A: number, B: number;
    if (k < 0) {
      A = B = 0;
      const D0 = store.frames[0].D;
      st.za = Math.max(0, D / D0);
      st.mix = 0;
    } else if (k >= store.length - 1) {
      A = B = store.length - 1;
      st.za = -1;
      st.mix = 0;
    } else {
      A = k;
      B = k + 1;
      const fa = store.frames[A], fb = store.frames[B];
      st.za = -1;
      const dD = fb.D - fa.D;
      st.mix = dD > 1e-9 ? THREE.MathUtils.clamp((D - fa.D) / dD, 0, 1) : THREE.MathUtils.clamp((t - fa.t) / Math.max(fb.t - fa.t, 1e-12), 0, 1);
    }
    if (A !== this.kA || B !== this.kB) {
      this.posA = store.positions(A);
      this.posB = A === B ? this.posA : store.positions(B);
      this.web.setKeyframes(A, this.posA, B, this.posB);
      this.web.setGalaxies(store.frames[A].galaxies, store.frames[B].galaxies);
      this.kA = A;
      this.kB = B;
      const f = store.frames[st.mix < 0.5 ? A : B];
      this.pkPlot.draw(f.pk);
      if (this.selected >= 0 && this.selectedFrame !== f.index) {
        // Halo catalogs change between keyframes; keep the card only while the frame is the same.
        this.selected = -1;
        this.ctx.ui.info(null);
      }
    }
  }

  private updateEpoch(t: number, dt: number): void {
    const ep = this.tl!.epochAt(t);
    if (ep !== this.lastEpoch) {
      this.lastEpoch = ep;
      this.epochSince = 0;
    } else this.epochSince += dt;
    if (this.epochSince > 0.35 && ep.id !== this.shownEpoch && (this.playing || this.epochSince > 1)) {
      this.shownEpoch = ep.id;
      this.captionKicker.textContent = ep.kicker;
      this.captionLine.textContent = ep.line;
      this.caption.classList.add('is-visible');
      clearTimeout(this.captionTimer);
      this.captionTimer = window.setTimeout(() => this.caption.classList.remove('is-visible'), 6500);
      this.rdEpoch.set(ep.kicker.replace(/ ·.*$/, ''));
      const z = this.state.z;
      this.ctx.audio.setMood('cosmos', { intensity: 0.25 + 0.5 * (1 - Math.min(1, Math.log10(1 + Math.max(z, 0)) / 3)), z, epoch: ep.id });
    }
  }

  private updateReadouts(t: number, a: number, z: number, D: number): void {
    const e = this.e;
    const tGyr = e.toGyr(t);
    this.rdZ.set(fmtZ(z));
    const age = fmtDur(tGyr);
    this.rdAge.set(age.value, age.unit);
    const tToday = e.tToday;
    const frac = t / tToday;
    if (frac <= 1) {
      const c = cosmicCalendar(Math.min(frac, 1 - 1e-9));
      this.rdCal.set(`${c.month.slice(0, 3)} ${c.day} · ${c.time.slice(0, 5)}`);
    } else {
      const yr = Math.floor(frac);
      const c = cosmicCalendar(frac - yr);
      this.rdCal.set(`Year ${yr + 1} · ${c.month.slice(0, 3)} ${c.day}`);
    }
    const R = this.nowRows;
    R['Scale factor a'](a < 0.01 ? a.toExponential(2) : a.toFixed(4));
    const lb = e.toGyr(tToday - t);
    R['Lookback time'](lb >= 0 ? `${joinDur(fmtDur(lb))} ago` : `${joinDur(fmtDur(-lb))} ahead`);
    R['Hubble rate H'](`${formatNumber(e.HAt(t) * e.H0, 4)}${THIN}km/s/Mpc`);
    R['CMB temperature'](`${formatNumber(2.7255 / a, 4)}${THIN}K`);
    R['Ωm · ΩΛ'](`${e.OmAt(t).toFixed(3)} · ${e.OdeAt(t).toFixed(3)}`);
    R['σ8 (linear)'](((this.info?.sigma8 ?? this.cosmo.sigma8) * D).toFixed(3));
    const f = this.frameNear();
    R['Halos found'](f && f.halos.count ? `${f.halos.count.toLocaleString('en-US')} · largest ${fmtMass(f.halos.mass[0])}` : '—');
    this.aPlot.draw(t);
    this.rdEpoch.set(this.tl!.epochAt(t).kicker.replace(/ ·.*$/, ''));
  }

  private updateRings(): void {
    const h = this.currentHalos();
    this.placeRing(this.ringSel, h, this.selected, false);
    // Hover highlight while the pointer is moving over the canvas.
    this.hoverClock--;
    const now = performance.now();
    if (now - this.lastPointerMove < 1500 && this.ctx.input.pointer.inside && !this.ctx.input.pointer.down && h) {
      if (this.hoverClock <= 0) {
        this.hoverClock = 4;
        this.hover = this.nearestHalo(h, this.ctx.input.pointer.x, this.ctx.input.pointer.y, 20);
      }
    } else this.hover = -1;
    this.placeRing(this.ringHover, h, this.hover !== this.selected ? this.hover : -1, true);
  }

  /** Position a halo ring (DOM writes only when something visibly changed). */
  private placeRing(el: HTMLElement, h: HaloCatalog | null, i: number, labelled: boolean): void {
    if (!h || i < 0 || i >= h.count) {
      if (!el.hidden) el.hidden = true;
      return;
    }
    this.haloWorld(h, i, this.v1);
    const dist = this.v1.distanceTo(this.camera.position);
    this.v1.project(this.camera);
    if (this.v1.z < -1 || this.v1.z > 1) {
      if (!el.hidden) el.hidden = true;
      return;
    }
    const W = this.ctx.canvas.clientWidth, H = this.ctx.canvas.clientHeight;
    const sx = (this.v1.x * 0.5 + 0.5) * W, sy = (-this.v1.y * 0.5 + 0.5) * H;
    const rw = (h.r200[i] / 1000) * (this.coords === 'physical' ? 1 : 1 / Math.max(this.e.aAt(this.t), 1e-3));
    const fpx = H / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
    const r = THREE.MathUtils.clamp((rw * fpx) / Math.max(dist, 1e-3), 7, 120);
    if (el.hidden) el.hidden = false;
    const d = el as HTMLElement & { _x?: number; _y?: number; _r?: number; _i?: number; _h?: HaloCatalog };
    if (d._x === undefined || Math.abs(d._x - sx) > 0.05 || Math.abs(d._y! - sy) > 0.05) {
      d._x = sx;
      d._y = sy;
      el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px)`;
    }
    if (d._r === undefined || Math.abs(d._r - r) > 0.05) {
      d._r = r;
      el.style.setProperty('--r', `${r.toFixed(1)}px`);
    }
    if (labelled && (d._i !== i || d._h !== h)) {
      d._i = i;
      d._h = h;
      (el.firstElementChild as HTMLElement).textContent = fmtMass(h.mass[i]);
    }
  }

  private nearestHalo(h: HaloCatalog, x: number, y: number, radius: number): number {
    const W = this.ctx.canvas.clientWidth, H = this.ctx.canvas.clientHeight;
    let best = -1, bd = radius * radius;
    const n = Math.min(h.count, 1500);
    for (let i = 0; i < n; i++) {
      this.haloWorld(h, i, this.v2);
      this.v2.project(this.camera);
      if (this.v2.z < -1 || this.v2.z > 1) continue;
      const dx = (this.v2.x * 0.5 + 0.5) * W - x, dy = (-this.v2.y * 0.5 + 0.5) * H - y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bd) {
        bd = d2;
        best = i;
      }
    }
    return best;
  }

  render(target: THREE.WebGLRenderTarget): void {
    const r = this.ctx.renderer;
    const aspect = target.width / target.height;
    this.camera.aspect = aspect;
    // Portrait screens: widen the vertical field so the box still fits across.
    this.camera.fov = aspect < 1 ? Math.min(82, (2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(25)) / Math.pow(aspect, 0.8)) * 180) / Math.PI) : 50;
    this.camera.updateProjectionMatrix();
    r.setRenderTarget(target);
    const store = this.client.store;
    const has = !!(this.web && store && store.length && this.kA >= 0);
    if (this.web) {
      this.web.pixelRatio = this.ctx.engine.pixelRatio;
      this.web.render(target, this.camera, this.state, has);
    } else if (this.state.cmb) {
      // Before the simulation reports in, the fireball alone.
      this.renderFireballOnly(target);
    }
  }

  private fireballFallback: WebRenderer | null = null;
  private renderFireballOnly(target: THREE.WebGLRenderTarget): void {
    // A tiny renderer instance used only for the sky glow until the real one exists.
    if (!this.fireballFallback) {
      this.fireballFallback = new WebRenderer(this.ctx.renderer, {
        np: 16,
        count: 16 * 16 * 16,
        nm: 16,
        boxWorld: 1,
        deltaL: new Int8Array(4096),
        sigmaL: 1,
        varDwarf: 1,
        varBright: 1,
        detail: 0.35,
      });
    }
    this.fireballFallback.render(target, this.camera, this.state, false);
  }

  resize(w: number, h: number): void {
    this.web?.resize(w, h);
  }

  unmount(): void {
    this.disposed = true;
    clearTimeout(this.captionTimer);
    clearTimeout(this.fateClock);
    this.client.dispose();
    this.web?.dispose();
    this.web = null;
    this.fireballFallback?.dispose();
    this.fireballFallback = null;
    this.styleEl?.remove();
    this.styleEl = null;
  }

  // ——— Debug / automation hooks (window.__universe.experience.*) ———

  /** Jump to a redshift (clamped to what has been simulated). */
  setRedshift(z: number): void {
    const tl = this.tl;
    if (!tl) return;
    const tt = z < 0 && !this.e.recollapses ? this.e.timeOfA(1 / (1 + z)) : this.e.timeOfA(1 / (1 + Math.max(z, 0)));
    this.scrubTo(tl.uOfT(tt), true);
    this.playing = false;
  }

  setTimeGyr(g: number): void {
    if (!this.tl) return;
    this.scrubTo(this.tl.uOfT(this.e.fromGyr(g)), true);
    this.playing = false;
  }

  play(): void {
    this.playing = true;
  }

  pause(): void {
    this.playing = false;
  }

  debugView(id: ViewId): void {
    this.setView(id, true);
    // Automation: land on the destination at once (interactive view changes keep their flights).
    this.orbit.update(1e3);
  }

  preset(id: PresetId): void {
    this.applyPreset(id);
  }

  coordinates(c: 'comoving' | 'physical'): void {
    this.coords = c;
    if (this.view === 'volume') this.orbit.set({ distance: this.volumeDistance() });
    this.coordsToggle?.set(c === 'physical');
  }

  /** Resolves once the simulation has produced keyframes down to redshift z. */
  whenSimulated(z = 0): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        const st = this.client.store;
        const last = st?.last();
        if (this.disposed || this.client.finished || (last && 1 / last.a - 1 <= z + 1e-6)) resolve();
        else setTimeout(check, 250);
      };
      check();
    });
  }

  tune(p: Record<string, number>): void {
    this.web?.tune(p);
  }

  debugGPU(): Record<string, number | string> | null {
    return this.web ? this.web.debugStats() : null;
  }

  /** Snapshot of the state for automated checks. */
  debugState(): Record<string, unknown> {
    const st = this.client.store;
    return {
      u: this.u,
      z: this.state.z,
      frames: st?.length ?? 0,
      bytes: st?.bytes ?? 0,
      finished: this.client.finished,
      mainThread: this.client.mainThread,
      halos: this.currentHalos()?.count ?? 0,
      kA: this.kA,
      kB: this.kB,
      mix: this.state.mix,
    };
  }
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function joinDur(f: { value: string; unit: string }): string {
  return `${f.value}${THIN}${f.unit}`;
}

export default () => new CosmicWebExperience();
