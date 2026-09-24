import * as THREE from 'three';
import type { Experience, ExperienceContext, FrameInfo } from '../../core/types';
import { OrbitRig } from '../../core/rigs/OrbitRig';
import { Sky } from '../../worlds/sky/Sky';
import type { Control } from '../../ui/Panel';
import type { Readout } from '../../ui/UI';
import { BlackHoleRenderer, type BlackHoleParams, type BlackHoleQuality } from '../../worlds/blackhole/BlackHoleRenderer';
import {
  accretionForPeakTemperature,
  circularOrbit,
  circularOrbitSpeed,
  gravitationalRadius,
  gravitationalTime,
  horizonRadius,
  iscoRadius,
  ksRadius,
  photonOrbitRadius,
  radiativeEfficiency,
  relativeGamma,
  shadowAngularWidth,
  staticTimeDilation,
  tidalAcceleration,
  zamoLapse,
  zamoObserver,
  type Vec3,
} from '../../worlds/blackhole/kerr';
import { PlungeTrajectory } from '../../worlds/blackhole/plunge';
import { formatDistance, formatDuration, formatNumber, formatScientific, joinFormatted } from '../../physics/units';
import {
  LOOKS,
  MASS_PRESETS,
  VIEWS,
  exposureFactor,
  fovForDistance,
  type LookId,
  type MassPresetId,
  type ViewId,
} from './presets';

const DEG = Math.PI / 180;
const PC_M = 3.0857e16;
/** 95th-percentile disk luminance at the default view — the auto-exposure reference. */
const REF_HIGHLIGHT = 0.68;

/**
 * Gargantua — a Kerr black hole ray-traced along exact light paths, with a Page–Thorne thin disk,
 * relativistic Doppler beaming and gravitational redshift, a lensed Milky Way and a free-fall plunge
 * through the horizon. All physics lives in src/worlds/blackhole (kerr.ts, plunge.ts, shaders.ts).
 */
class Gargantua implements Experience {
  private ctx!: ExperienceContext;
  private bh!: BlackHoleRenderer;
  private sky!: Sky;
  private cubeRT!: THREE.WebGLCubeRenderTarget;
  private cubeCam!: THREE.CubeCamera;
  private rig!: OrbitRig;
  private camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  private camPos = new THREE.Vector3();
  private lookYaw = 0;
  private lookYawGoal = 0;
  private time = 0;
  /** Coordinate time flow, M per second of wall time. */
  private flow = 4;
  private paused = false;
  private mass: MassPresetId = 'sgra';
  private look: LookId = 'physical';
  private view: ViewId = 'gargantua';
  private readyFrames = 0;
  private plunge: PlungeTrajectory | null = null;
  private plungeLook = 0;
  private plungeEnd = 0;
  private wasInside = false;
  private shadowWidth = NaN;
  private shadowKey = '';
  private shadowTimer = 0;
  private readoutTimer = 0;
  private moodTimer = 0;
  private fovDeg = 32;
  private baseExposure = 2.4;
  private exposure = -1;
  private shotSig = '';
  private shotStill = 0;
  // UI
  private rDist!: Readout;
  private rDil!: Readout;
  private rOrb!: Readout;
  private rShadow!: Readout;
  private controls: Partial<Record<string, Control<number> | Control<boolean> | Control<string>>> = {};
  private viewButtons: { setActive(i: number): void } | null = null;
  private massInfo!: (v: string) => void;
  private diskInfo!: (v: string) => void;
  // scratch
  private readonly tmpM = new THREE.Matrix4();
  private readonly tmpQ = new THREE.Quaternion();
  private readonly qA = new THREE.Quaternion();
  private readonly qB = new THREE.Quaternion();
  private readonly v0 = new THREE.Vector3();
  private readonly v1 = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly yAxis = new THREE.Vector3(0, 1, 0);

  mount(ctx: ExperienceContext): void {
    this.ctx = ctx;
    const tier = ctx.quality.tier as BlackHoleQuality;
    this.bh = new BlackHoleRenderer(ctx.renderer, { quality: tier });
    ctx.progress(0.3, 'Bending light');

    // Background: the project's sky (Milky Way band; point stars are lensed analytically).
    this.sky = new Sky({ stars: 100, brightness: 0, milkyWay: 1.1 });
    const size = tier === 'low' ? 256 : tier === 'medium' ? 512 : 1024;
    this.cubeRT = new THREE.WebGLCubeRenderTarget(size, {
      type: THREE.HalfFloatType,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.cubeCam = new THREE.CubeCamera(0.1, 10, this.cubeRT);
    this.orientSky(VIEWS.gargantua.yaw * DEG, VIEWS.gargantua.pitch * DEG);
    this.bh.setEnvironment(this.cubeRT.texture);
    ctx.progress(0.6, 'Bending light');

    const v = VIEWS.gargantua;
    this.rig = new OrbitRig(null, {
      distance: v.distance,
      yaw: v.yaw * DEG,
      pitch: v.pitch * DEG,
      minDistance: 3.2,
      maxDistance: 2000,
      minPitch: -89 * DEG,
      maxPitch: 89 * DEG,
      autoRotate: 0.012,
      idleDelay: 10,
      enablePan: false,
      damping: 0.25,
    });
    // Our own bindings: the orbit rig must stay outside the ergosphere, and input cancels a plunge.
    ctx.input.onDrag((e) => {
      if (this.plunge) return;
      const s = Math.min(1, Math.sqrt(this.rig.distance / 30));
      this.rig.rotate(e.dx * (0.6 + 0.4 * s), e.dy * (0.6 + 0.4 * s));
      this.lookYawGoal = this.lookYaw = this.lookYaw * 0.98;
      this.idle();
    });
    ctx.input.onWheel((e) => {
      if (this.plunge) return;
      this.rig.zoom(e.delta * 0.16 * (e.shift ? 0.25 : 1));
      this.idle();
    });
    ctx.input.onPinch((e) => {
      if (this.plunge) return;
      this.rig.zoom(-Math.log(Math.max(0.2, Math.min(5, e.scale))));
      this.idle();
    });
    ctx.input.onTap((e) => this.inspect(e.ndcX, e.ndcY));
    ctx.input.onDoubleTap(() => this.setView(this.view));
    ctx.input.onKeyDown((e) => this.onKey(e));

    ctx.post.exposure = 1.0;
    ctx.post.bloomStrength = 0.1;
    ctx.post.bloomRadius = 0.85;
    ctx.post.tonemap = (ctx.params.get('tm') as typeof ctx.post.tonemap) ?? 'aces';
    ctx.post.saturation = 1.1;
    ctx.post.vignette = 0.22;
    ctx.post.chromaticAberration = 0;
    this.applyLook('physical', false);
    this.buildUI();
    this.applyMass('sgra');
    ctx.ui.hint('Drag to orbit · Scroll to zoom · Tap to trace a ray · 1–5 views · G plunge');
    ctx.progress(1);
  }

  // ————————————————————————————————————————————————————————————————— UI

  private buildUI(): void {
    const ui = this.ctx.ui;
    this.rDist = ui.readout('Distance', 'r_g');
    this.rDil = ui.readout('Clock rate', '');
    this.rOrb = ui.readout('Orbital speed', 'c');
    this.rShadow = ui.readout('Shadow', '°');

    const views = ui.section('View');
    const ids = Object.keys(VIEWS) as ViewId[];
    this.viewButtons = views.buttons(
      ids.map((id, i) => ({ label: `${i + 1} ${VIEWS[id].label}`, onClick: () => this.setView(id) })),
      0,
    );
    views.buttons([{ label: 'Plunge into the hole  (G)', onClick: () => this.startPlunge() }]);

    const hole = ui.section('Black hole');
    this.controls.mass = hole.select<MassPresetId>({
      label: 'Mass',
      value: this.mass,
      options: (Object.keys(MASS_PRESETS) as MassPresetId[]).map((id) => ({ value: id, label: MASS_PRESETS[id].label })),
      onChange: (id) => this.applyMass(id),
      help: 'Geometry scales with mass; only the physical units change.',
    });
    this.controls.spin = hole.slider({
      label: 'Spin a/M',
      min: 0,
      max: 0.998,
      step: 0.001,
      value: this.bh.params.spin,
      format: (x) => x.toFixed(3),
      onChange: (x) => this.setParams({ spin: x }),
      help: 'Kerr spin. 0.998 is Thorne’s limit for a hole spun up by its own disk.',
    });
    this.massInfo = hole.readout('Horizon · ISCO');

    const disk = ui.section('Accretion disk');
    this.controls.temp = disk.slider({
      label: 'Peak temperature',
      min: 3000,
      max: 60000,
      log: true,
      unit: 'K',
      value: this.bh.params.peakTemperature,
      format: (x) => formatNumber(Math.round(x / 100) * 100, 3),
      onChange: (x) => this.setParams({ peakTemperature: x }),
      help: 'Set by the accretion rate: σT⁴ ∝ Ṁ/M² (Page & Thorne 1974).',
    });
    this.controls.inner = disk.slider({
      label: 'Inner edge',
      min: 1,
      max: 4,
      step: 0.01,
      value: 1,
      format: (x) => (x <= 1.001 ? 'ISCO' : `${formatNumber(x * iscoRadius(this.bh.params.spin), 3)} r_g`),
      onChange: (x) => this.setParams({ diskInner: x <= 1.001 ? 0 : x * iscoRadius(this.bh.params.spin) }),
      help: 'Gas plunges freely inside the innermost stable circular orbit.',
    });
    this.controls.outer = disk.slider({
      label: 'Outer edge',
      min: 8,
      max: 60,
      step: 0.5,
      unit: 'r_g',
      value: this.bh.params.diskOuter,
      onChange: (x) => this.setParams({ diskOuter: x }),
    });
    this.controls.thick = disk.slider({
      label: 'Thickness H/r',
      min: 0.004,
      max: 0.08,
      log: true,
      value: this.bh.params.thickness,
      format: (x) => x.toFixed(3),
      onChange: (x) => this.setParams({ thickness: x }),
    });
    this.controls.turb = disk.slider({
      label: 'Turbulence',
      min: 0,
      max: 1,
      value: this.bh.params.turbulence,
      onChange: (x) => this.setParams({ turbulence: x }),
    });
    this.controls.hot = disk.toggle({
      label: 'Orbiting hot spot',
      value: this.bh.params.hotSpot > 0,
      onChange: (on) => this.setParams({ hotSpot: on ? 2.2 : 0 }),
      help: 'A compact flare like those GRAVITY saw circling Sgr A* in 2018.',
    });
    this.diskInfo = disk.readout('Accretion');

    const light = ui.section('Light');
    this.controls.look = light.select<LookId>({
      label: 'Look',
      value: this.look,
      options: (Object.keys(LOOKS) as LookId[]).map((id) => ({ value: id, label: LOOKS[id].label })),
      onChange: (id) => this.applyLook(id),
      help: 'Interstellar switched Doppler effects off for the film; here you can compare.',
    });
    this.controls.doppler = light.toggle({
      label: 'Doppler beaming',
      value: this.bh.params.doppler,
      onChange: (on) => this.setParams({ doppler: on }),
      help: 'Gas orbiting at up to half the speed of light: the approaching side is brighter and bluer.',
    });
    this.controls.grav = light.toggle({
      label: 'Gravitational redshift',
      value: this.bh.params.gravitationalRedshift,
      onChange: (on) => this.setParams({ gravitationalRedshift: on }),
    });
    this.controls.lens = light.toggle({
      label: 'Curved light paths',
      value: this.bh.params.lensing,
      onChange: (on) => this.setParams({ lensing: on }),
      help: 'Off: light travels in straight lines, as if gravity did not bend it.',
    });
    this.controls.isco = light.toggle({
      label: 'Mark the ISCO',
      value: false,
      onChange: (on) => this.setParams({ showIsco: on }),
    });
    this.controls.photon = light.toggle({
      label: 'Mark photon orbits',
      value: false,
      onChange: (on) => this.setParams({ showPhotonOrbits: on }),
    });

    const time = ui.section('Time');
    this.controls.flow = time.slider({
      label: 'Time flow',
      min: 0,
      max: 40,
      step: 0.1,
      value: this.flow,
      format: (x) => this.flowLabel(x),
      onChange: (x) => {
        this.flow = x;
        this.paused = false;
      },
    });
    time.buttons([{ label: 'About this black hole', onClick: () => this.showInfo() }]);
  }

  private flowLabel(x: number): string {
    const tg = gravitationalTime(MASS_PRESETS[this.mass].mass);
    const ratio = x * tg;
    if (x === 0) return 'stopped';
    return `${formatNumber(x, 2)} M/s · ×${ratio >= 1 ? formatNumber(ratio, 2) : formatScientific(ratio, 2)}`;
  }

  private setParams(p: Partial<BlackHoleParams>): void {
    this.bh.setParams(p);
    if (p.spin !== undefined) {
      const inner = this.controls.inner as Control<number> | undefined;
      if (inner && inner.get() > 1.001) this.bh.setParams({ diskInner: inner.get() * iscoRadius(p.spin) });
      this.shadowKey = '';
      this.updateStaticInfo();
    }
    if (p.peakTemperature !== undefined) this.updateStaticInfo();
    if (p.doppler !== undefined || p.gravitationalRedshift !== undefined) {
      const physical = this.bh.params.doppler && this.bh.params.gravitationalRedshift;
      if (physical && this.look !== 'physical') {
        this.look = 'physical';
        (this.controls.look as Control<string> | undefined)?.set('physical');
      }
    }
  }

  private applyMass(id: MassPresetId): void {
    this.mass = id;
    const m = MASS_PRESETS[id];
    (this.controls.mass as Control<string> | undefined)?.set(id);
    (this.controls.flow as Control<number> | undefined)?.set(this.flow);
    this.updateStaticInfo();
    this.ctx.audio.setMood('blackhole', { intensity: 0.6, mass: m.mass });
  }

  private applyLook(id: LookId, toast = true): void {
    this.look = id;
    const l = LOOKS[id];
    this.bh.setParams(l.params);
    this.ctx.post.saturation = l.saturation;
    this.baseExposure = l.exposure;
    (this.controls.look as Control<string> | undefined)?.set(id);
    (this.controls.doppler as Control<boolean> | undefined)?.set(this.bh.params.doppler);
    (this.controls.grav as Control<boolean> | undefined)?.set(this.bh.params.gravitationalRedshift);
    (this.controls.temp as Control<number> | undefined)?.set(this.bh.params.peakTemperature);
    (this.controls.thick as Control<number> | undefined)?.set(this.bh.params.thickness);
    (this.controls.turb as Control<number> | undefined)?.set(this.bh.params.turbulence);
    (this.controls.outer as Control<number> | undefined)?.set(this.bh.params.diskOuter);
    if (l.spin !== undefined) {
      this.bh.setParams({ spin: l.spin });
      (this.controls.spin as Control<number> | undefined)?.set(l.spin);
      this.shadowKey = '';
    }
    this.updateStaticInfo();
    if (toast) this.ctx.ui.toast(l.note, 4200);
  }

  private updateStaticInfo(): void {
    if (!this.massInfo) return;
    const a = this.bh.params.spin;
    this.massInfo(`${horizonRadius(a).toFixed(2)} · ${iscoRadius(a).toFixed(2)} r_g`);
    const acc = accretionForPeakTemperature(a, MASS_PRESETS[this.mass].mass, this.bh.params.peakTemperature);
    this.diskInfo(`${formatScientific(acc.mdotSunPerYear, 2)} M☉/yr · ${formatNumber(acc.eddingtonRatio, 2)} L_Edd`);
  }

  private showInfo(): void {
    const a = this.bh.params.spin;
    const m = MASS_PRESETS[this.mass];
    const rg = gravitationalRadius(m.mass);
    const acc = accretionForPeakTemperature(a, m.mass, this.bh.params.peakTemperature);
    const iscoOrbit = circularOrbit(a, iscoRadius(a));
    const period = iscoOrbit ? (2 * Math.PI) / iscoOrbit.omega : NaN;
    const rows: Array<[string, string]> = [
      ['Mass', `${formatScientific(m.mass, 2)} M☉`],
      ['Spin a/M', a.toFixed(3)],
      ['Event horizon', `${horizonRadius(a).toFixed(3)} r_g · ${joinFormatted(formatDistance(horizonRadius(a) * rg))}`],
      ['Photon orbits', `${photonOrbitRadius(a, true).toFixed(2)} – ${photonOrbitRadius(a, false).toFixed(2)} r_g`],
      ['ISCO', `${iscoRadius(a).toFixed(3)} r_g · orbit ${joinFormatted(formatDuration(period * gravitationalTime(m.mass)))}`],
      ['Efficiency η', `${(radiativeEfficiency(a) * 100).toFixed(1)} % of mc²`],
      ['Accretion', `${formatScientific(acc.mdotSunPerYear, 2)} M☉/yr → ${formatScientific(acc.luminosity, 2)} W`],
    ];
    if (m.distancePc) {
      // Apparent shadow diameter from Earth, ≈ 2√27 GM/(c² D) (Kerr varies by a few per cent).
      const muas = ((2 * Math.sqrt(27) * rg) / (m.distancePc * PC_M)) * (180 / Math.PI) * 3600e6;
      rows.push(['Shadow from Earth', `${formatNumber(muas, 3)} μas`]);
    }
    rows.push(['Tides at horizon', `${formatScientific(tidalAcceleration(m.mass, horizonRadius(a)), 2)} m/s² per 2 m`]);
    this.ctx.ui.info({ title: m.label, subtitle: m.subtitle, rows, body: m.body });
  }

  // ————————————————————————————————————————————————————————————————— views

  /** Debug/UI hook: 'gargantua' | 'edge-on' | 'face-on' | 'photon-sphere' | 'far'. */
  setView(id: ViewId, seconds = 2.6): void {
    const v = VIEWS[id];
    if (!v) return;
    this.cancelPlunge();
    this.view = id;
    this.viewButtons?.setActive((Object.keys(VIEWS) as ViewId[]).indexOf(id));
    const instant = seconds <= 0 || this.ctx.engine.shotMode;
    if (instant) {
      this.rig.set({ distance: v.distance, yaw: v.yaw * DEG, pitch: v.pitch * DEG });
      this.lookYaw = this.lookYawGoal = (v.lookYaw ?? 0) * DEG;
      this.bh.resetHistory();
    } else {
      this.rig.flyTo({ distance: v.distance, yaw: v.yaw * DEG, pitch: v.pitch * DEG }, seconds);
      this.lookYawGoal = (v.lookYaw ?? 0) * DEG;
    }
    if (v.observer) this.bh.setParams({ observer: v.observer });
    else this.bh.setParams({ observer: 'static' });
    this.shadowKey = '';
  }

  /** Debug hook: jump the camera (distance in r_g, angles in degrees). */
  setCamera(distance: number, pitchDeg: number, yawDeg?: number, lookYawDeg = 0): void {
    this.cancelPlunge();
    this.rig.set({ distance, pitch: pitchDeg * DEG, yaw: yawDeg !== undefined ? yawDeg * DEG : undefined });
    this.lookYaw = this.lookYawGoal = lookYawDeg * DEG;
    this.bh.resetHistory();
  }

  /** Debug hook: merge renderer parameters, e.g. set({ doppler: false }). */
  set(p: Partial<BlackHoleParams>): void {
    this.setParams(p);
  }

  /** Debug hook: 'physical' | 'interstellar' | 'hot'. */
  preset(id: LookId): void {
    this.applyLook(id);
  }

  /** Debug hook: coordinate time in M. */
  setTime(t: number): void {
    this.time = t;
    this.bh.setParams({ time: t });
  }

  /** Debug hook: adjust the post chain (exposure, bloom, tone mapper…). */
  setPost(p: Partial<ExperienceContext['post']>): void {
    Object.assign(this.ctx.post, p);
    if (p.exposure !== undefined) this.baseExposure = p.exposure;
  }

  /** Debug hook: choose the mass preset. */
  setMass(id: MassPresetId): void {
    this.applyMass(id);
  }

  private idle(): void {
    this.rig.idleDelay = 10;
  }

  private onKey(e: KeyboardEvent): void {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const ids = Object.keys(VIEWS) as ViewId[];
    const n = Number(e.key);
    if (n >= 1 && n <= ids.length) this.setView(ids[n - 1]);
    else if (e.code === 'KeyG') this.plunge ? this.cancelPlunge(true) : this.startPlunge();
    else if (e.code === 'Space') {
      this.paused = !this.paused;
      this.ctx.ui.toast(this.paused ? 'Time stopped' : 'Time flowing');
      e.preventDefault();
    } else if (e.code === 'KeyB') {
      const on = !this.bh.params.doppler;
      this.setParams({ doppler: on });
      (this.controls.doppler as Control<boolean> | undefined)?.set(on);
      this.ctx.ui.toast(on ? 'Doppler beaming on' : 'Doppler beaming off');
    } else if (e.code === 'KeyL') {
      const on = !this.bh.params.lensing;
      this.setParams({ lensing: on });
      (this.controls.lens as Control<boolean> | undefined)?.set(on);
      this.ctx.ui.toast(on ? 'Light follows curved spacetime' : 'Straight light paths (no lensing)');
    } else if (e.code === 'KeyI') this.showInfo();
  }

  // ————————————————————————————————————————————————————————————————— plunge

  /** Debug/UI hook: fall in from the current position along a zero-angular-momentum geodesic. */
  startPlunge(): void {
    if (this.plunge) return;
    const a = this.bh.params.spin;
    const p = this.rig.position;
    // Start no closer than 12 r_g so there is a journey to watch.
    const d = Math.max(p.length(), 12);
    this.v0.copy(p).normalize().multiplyScalar(d);
    // Well above the disk plane (≥ 12°): rain observers fall at constant latitude, so we sweep down
    // past the inner disk and watch it from above rather than skimming through the gas.
    const minY = Math.sin(12 * DEG) * d;
    if (Math.abs(this.v0.y) < minY) {
      const h = Math.sqrt(Math.max(d * d - minY * minY, 0)) / Math.max(Math.hypot(this.v0.x, this.v0.z), 1e-9);
      this.v0.set(this.v0.x * h, minY * (this.v0.y < 0 ? -1 : 1), this.v0.z * h);
    }
    const ks: Vec3 = [this.v0.x, -this.v0.z, this.v0.y];
    this.plunge = new PlungeTrajectory(a, ks);
    this.plungeLook = 0;
    this.plungeEnd = 0;
    this.wasInside = false;
    this.rig.enabled = false;
    this.bh.setParams({ observer: 'rain' });
    this.ctx.ui.toast('Falling freely from rest — no rockets, no way back', 3600);
    this.ctx.audio.event('portal');
  }

  /** Debug hook: start (if needed) and fast-forward the plunge to Boyer–Lindquist radius r. */
  plungeTo(r: number): void {
    if (!this.plunge) this.startPlunge();
    const pl = this.plunge!;
    let guard = 0;
    while (pl.r > r && guard++ < 100000) pl.step(0.02 * pl.r);
    if (pl.inside) {
      this.wasInside = true;
      this.plungeLook = 1;
    }
    this.bh.setObserverVelocity(pl.velocity());
    this.bh.resetHistory();
  }

  private cancelPlunge(returnToView = false): void {
    if (!this.plunge) return;
    this.plunge = null;
    this.bh.setObserverVelocity(null);
    this.bh.setParams({ observer: 'static' });
    this.rig.enabled = true;
    this.bh.resetHistory();
    if (returnToView) this.setView(this.view, 0);
  }

  private updatePlunge(dt: number): void {
    const pl = this.plunge!;
    const a = pl.a;
    const rp = horizonRadius(a);
    const r = pl.r;
    // Wall-clock pacing: equal time per e-fold of radius, lingering at the horizon.
    const linger = 1 + 1.6 * Math.exp(-(((r - rp) / (0.7 * rp)) ** 2));
    const te = 2.2 * linger;
    const vr = Math.abs(pl.radialSpeed());
    const dTau = Math.min((dt * r) / (te * Math.max(vr, 1e-3)), 0.5 * r);
    if (this.plungeEnd === 0) pl.step(dTau);
    const inside = pl.inside;
    if (inside && !this.wasInside) {
      this.wasInside = true;
      this.ctx.ui.toast('Event horizon crossed. Every future now points inward.', 4200);
      this.ctx.audio.event('portal');
    }
    if (inside) this.plungeLook = Math.min(1, this.plungeLook + dt / 2.4);
    if (pl.r <= pl.endRadius && this.plungeEnd === 0) this.plungeEnd = 0.001;
    if (this.plungeEnd > 0) {
      this.plungeEnd += dt;
      if (this.plungeEnd > 1.6) {
        const tau = pl.tau * gravitationalTime(MASS_PRESETS[this.mass].mass);
        this.ctx.ui.toast(`Your clock ran ${joinFormatted(formatDuration(tau))} from the start of the fall.`, 5200);
        this.cancelPlunge();
        this.setView(this.view, 0);
        return;
      }
    }
    this.bh.setObserverVelocity(pl.velocity());
  }

  /** Camera pose for the plunge: facing the hole, turning to look back once inside. */
  private plungePose(cam: THREE.PerspectiveCamera): void {
    const pl = this.plunge!;
    const [x, y, z] = pl.pos;
    this.camPos.set(x, z, -y);
    const pos = this.camPos;
    this.v0.set(0, 0, 0);
    this.up.copy(this.yAxis);
    if (Math.abs(pos.y) > 0.95 * pos.length()) this.up.set(0, 0, -1);
    // Facing in (looking at the hole, a touch below centre so the disk stays in frame).
    this.tmpM.lookAt(pos, this.v0, this.up);
    this.qA.setFromRotationMatrix(this.tmpM);
    // Facing back out along the radius.
    this.v1.copy(pos).multiplyScalar(2);
    this.tmpM.lookAt(pos, this.v1, this.up);
    this.qB.setFromRotationMatrix(this.tmpM);
    const k = this.plungeLook * this.plungeLook * (3 - 2 * this.plungeLook);
    cam.quaternion.copy(this.qA).slerp(this.qB, k);
    cam.position.copy(pos);
    cam.updateMatrixWorld();
  }

  // ————————————————————————————————————————————————————————————————— inspect

  /** Tap: trace the ray through that pixel on the CPU and say where its light came from. */
  private inspect(ndcX: number, ndcY: number): void {
    const res = this.bh.pick(ndcX, ndcY);
    if (!res) return;
    const turns = Math.abs(res.sweep) / (2 * Math.PI);
    if (res.fate === 'captured') {
      this.ctx.ui.toast(`This direction looks into the horizon — no light comes back. Closest approach ${res.rMin.toFixed(2)} r_g.`, 4200);
      return;
    }
    const disk = res.crossings.find((c) => c.r >= this.bh.innerRadius && c.r <= this.bh.params.diskOuter);
    if (disk && this.bh.params.disk) {
      const order = disk.order === 0 ? 'direct image' : disk.order === 1 ? 'secondary image (light bent around the back)' : `image of order ${disk.order}`;
      this.ctx.ui.toast(`Disk light from r = ${disk.r.toFixed(2)} r_g, ${order}.`, 4200);
      return;
    }
    this.ctx.ui.toast(
      turns > 0.45
        ? `Starlight that wrapped ${formatNumber(turns, 2)} times around the hole, skimming ${res.rMin.toFixed(2)} r_g.`
        : `Starlight, passing within ${res.rMin.toFixed(1)} r_g of the hole.`,
      4200,
    );
  }

  // ————————————————————————————————————————————————————————————————— frame

  /** Orient the Milky Way: band tilted 50° behind the hole as seen from the default view. */
  private orientSky(yaw: number, pitch: number): void {
    const P = new THREE.Vector3(Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw));
    // Galactic centre 40° to the side of the hole: the band still crosses behind the shadow (and
    // is lensed into arcs), but the bright bulge does not smear into a full Einstein ring.
    const g = P.clone().negate().applyAxisAngle(new THREE.Vector3(0, 1, 0), 40 * DEG);
    const side = new THREE.Vector3(0, 1, 0).cross(g).normalize();
    const beta = 50 * DEG;
    const w = side.multiplyScalar(Math.cos(beta)).add(new THREE.Vector3(0, Math.sin(beta), 0));
    const n = g.clone().cross(w).normalize();
    const z = g.clone().cross(n).normalize();
    const m = new THREE.Matrix4().makeBasis(g, n, z);
    this.sky.setRotation(m, 'galactic');
    const r = this.ctx.renderer;
    const prev = r.autoClear;
    r.autoClear = true;
    this.cubeCam.update(r, this.sky.scene);
    r.autoClear = prev;
  }

  update(f: FrameInfo): void {
    const dt = f.dt;
    if (this.plunge) this.updatePlunge(dt);
    else {
      this.rig.update(dt);
      this.lookYaw += (this.lookYawGoal - this.lookYaw) * (1 - Math.exp(-dt / 0.5));
    }
    if (!this.paused) this.time += dt * this.flow;
    // A cinematographer's exposure: meter the highlights (async readback of a tiny summary) and stop
    // down when the disk is brighter than at the reference view — close up, face-on, beamed.
    if (f.frame % 6 === 0) this.bh.meter();
    const hl = this.bh.highlightLuminance;
    const s = Math.sin(this.plunge ? 0 : this.rig.pitch);
    const auto = hl > 0 ? Math.min(1, Math.max(0.02, Math.pow(REF_HIGHLIGHT / hl, 0.75))) * (1 - 0.3 * s * s) : exposureFactor(this.rig.distance, this.rig.pitch);
    const target = this.baseExposure * auto;
    this.exposure = this.exposure < 0 || this.ctx.engine.shotMode ? target : this.exposure + (target - this.exposure) * (1 - Math.exp(-dt / 0.35));
    this.ctx.post.exposure = this.exposure;
    this.bh.setParams({ time: this.time });

    this.readoutTimer -= dt;
    if (this.readoutTimer <= 0) {
      this.readoutTimer = 0.2;
      this.updateReadouts();
    }
    this.moodTimer -= dt;
    if (this.moodTimer <= 0) {
      this.moodTimer = 1.5;
      const r = this.plunge ? this.plunge.r : this.rig.distance;
      this.ctx.audio.setMood('blackhole', { intensity: Math.min(1, 0.35 + 3 / Math.max(r, 3)), mass: MASS_PRESETS[this.mass].mass });
    }
    if (++this.readyFrames === 2) this.ctx.signalReady();
  }

  private updateReadouts(): void {
    const a = this.bh.params.spin;
    const m = MASS_PRESETS[this.mass].mass;
    const rg = gravitationalRadius(m);
    const cam = this.bh.camera;
    const pos: Vec3 = cam ? cam.pos : [this.rig.position.x, -this.rig.position.z, this.rig.position.y];
    const r = ksRadius(a, pos[0], pos[1], pos[2]);
    const cosT = pos[2] / Math.max(r, 1e-9);
    this.rDist.set(formatNumber(r, 3), `r_g · ${joinFormatted(formatDistance(r * rg, 3))}`);
    if (this.plunge) {
      const pl = this.plunge;
      const tau = pl.tau * gravitationalTime(m);
      this.rDil.set(joinFormatted(formatDuration(tau, 3)), 'proper time');
      const zamo = zamoObserver(a, pos[0], pos[1], pos[2]);
      if (zamo && !pl.inside) {
        const g = relativeGamma(a, pos, pl.velocity(), zamo);
        this.rOrb.set(formatNumber(Math.sqrt(Math.max(0, 1 - 1 / (g * g))), 3), 'c infall');
      } else this.rOrb.set('—', 'inside the horizon');
      this.rShadow.set('—', '');
      return;
    }
    const dil = staticTimeDilation(a, r, cosT);
    if (Number.isFinite(dil)) this.rDil.set(formatNumber(dil, 4), `× distant clocks`);
    else this.rDil.set(formatNumber(zamoLapse(a, r, cosT), 4), '× (ergosphere, ZAMO)');
    const v = circularOrbitSpeed(a, r);
    this.rOrb.set(Number.isFinite(v) ? formatNumber(v, 3) : 'none', Number.isFinite(v) ? 'c circular' : 'inside photon orbit');
    // The shadow's angular width from exact geodesics (recomputed when the view changes).
    const key = `${a.toFixed(3)}|${r.toPrecision(3)}|${cosT.toFixed(2)}|${this.bh.params.lensing}`;
    this.shadowTimer -= 0.2;
    if (key !== this.shadowKey && this.shadowTimer <= 0) {
      this.shadowKey = key;
      this.shadowTimer = 0.6;
      this.shadowWidth = this.bh.params.lensing ? shadowAngularWidth(a, pos, 16) : 2 * Math.asin(Math.min(1, horizonRadius(a) / r));
    }
    const w = this.shadowWidth / DEG;
    this.rShadow.set(w >= 1 ? formatNumber(w, 3) : formatNumber(w * 60, 3), w >= 1 ? '° across' : '′ across');
  }

  render(target: THREE.WebGLRenderTarget): void {
    const cam = this.camera;
    const aspect = target.width / target.height;
    const d = this.plunge ? 0 : this.rig.distance;
    const baseFov = this.plunge ? 74 : fovForDistance(d);
    this.fovDeg = baseFov;
    // Keep enough horizontal field on portrait phones.
    const minH = Math.min(100, baseFov * 1.25) * DEG;
    const fovY = Math.max(baseFov * DEG, 2 * Math.atan(Math.tan(minH / 2) / aspect));
    cam.fov = fovY / DEG;
    cam.aspect = aspect;
    cam.updateProjectionMatrix();
    if (this.plunge) this.plungePose(cam);
    else {
      this.rig.applyTo(cam);
      if (Math.abs(this.lookYaw) > 1e-5) {
        cam.quaternion.multiply(this.tmpQ.setFromAxisAngle(this.yAxis, this.lookYaw));
        cam.updateMatrixWorld();
      }
      this.camPos.copy(this.rig.position);
    }
    // Headless screenshots run WebGL on the CPU (seconds per frame). Once the view has been still
    // for a few frames (enough to converge the temporal accumulation), re-composite the last trace
    // instead of tracing again, so the page stays responsive to the screenshot tool.
    const shot = this.ctx.engine.shotMode;
    let reuse = false;
    if (shot) {
      const q = cam.quaternion;
      const sig = `${this.bh.version}|${this.camPos.x.toFixed(4)},${this.camPos.y.toFixed(4)},${this.camPos.z.toFixed(4)}|${q.x.toFixed(5)},${q.y.toFixed(5)},${q.z.toFixed(5)}|${target.width}`;
      if (sig !== this.shotSig || this.plunge) this.shotStill = 0;
      else this.shotStill++;
      this.shotSig = sig;
      reuse = this.shotStill > 6;
    }
    this.bh.render(target, cam, this.camPos, reuse);
    if (shot) this.bh.syncGPU();
  }

  unmount(): void {
    this.bh.dispose();
    this.sky.dispose();
    this.cubeRT.dispose();
  }
}

export default () => new Gargantua();
