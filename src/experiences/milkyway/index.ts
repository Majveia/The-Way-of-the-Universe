import * as THREE from 'three';
import type { Experience, ExperienceContext, FrameInfo } from '../../core/types';
import { OrbitRig } from '../../core/rigs/OrbitRig';
import { FlyRig } from '../../core/rigs/FlyRig';
import type { Control } from '../../ui/Panel';
import type { Readout } from '../../ui/UI';
import { GalaxyLayer } from '../../worlds/galaxy/GalaxyLayer';
import { armPhi, MORPHOLOGIES, preset, type GalaxyParams, type MorphologyId } from '../../worlds/galaxy/params';
import { kmsFromPcMyr } from '../../physics/galaxyPotential';
import { MILKYWAY_CSS, RotationCurvePlot } from './rotationCurve';

/**
 * The Milky Way — a living spiral galaxy.
 *
 * Everything moves: disk stars on epicycles organised by a density wave (arms at Ω_p = 25 km/s/kpc),
 * the bar at Ω_b = 39 km/s/kpc, OB associations born in the arms and dying on their real
 * lifetimes, the halo and globular clusters on inclined rosettes. Remove the dark halo and the GPU
 * integrates every star in the visible mass alone. See src/worlds/galaxy/* for the physics.
 */

type ViewName = 'default' | 'face-on' | 'edge-on' | 'sun' | 'neighbourhood' | 'centre' | 'halo';
interface ViewDef {
  label: string;
  distance: number | ((p: GalaxyParams) => number);
  yaw: number;
  pitch: number;
  /** 'sun' = the Sun (Milky Way only), otherwise a render-frame point. */
  target?: 'sun' | [number, number, number];
  fov?: number;
}

const VIEWS: Record<ViewName, ViewDef> = {
  default: { label: 'Overview', distance: (p) => p.look.viewDistance, yaw: 2.35, pitch: 0.6 },
  'face-on': { label: 'Face-on', distance: (p) => p.look.viewDistance * 1.28, yaw: 0, pitch: 1.5 },
  'edge-on': { label: 'Edge-on', distance: (p) => p.look.viewDistance * 1.2, yaw: 1.2, pitch: 0.02 },
  // From just behind the Sun, looking toward the Galactic Centre along the plane.
  sun: { label: 'From the Sun', distance: 60, yaw: -Math.PI / 2, pitch: 0.035, target: 'sun', fov: 72 },
  neighbourhood: { label: 'Neighbourhood', distance: 4200, yaw: -2.1, pitch: 0.75, target: 'sun' },
  centre: { label: 'Centre', distance: (p) => Math.max(2500, p.bar.halfLength * 2.6), yaw: 2.0, pitch: 0.42 },
  halo: { label: 'Halo', distance: 150000, yaw: 2.35, pitch: 0.35 },
};
const VIEW_KEYS: ViewName[] = ['default', 'face-on', 'edge-on', 'sun', 'centre'];

const WARPS = [0.1, 0.3, 1, 3, 10, 30, 100];

class MilkyWay implements Experience {
  private ctx!: ExperienceContext;
  private layer!: GalaxyLayer;
  private orbit!: OrbitRig;
  private fly: FlyRig | null = null;
  private flying = false;
  private camera = new THREE.PerspectiveCamera(50, 1, 0.05, 2e6);
  private fov = 50;
  private fovGoal = 50;
  /** Myr per second. */
  private warp = 2;
  private paused = false;
  private frame = 0;
  private morph: MorphologyId = 'milkyway';
  private seed = 1;
  private view: ViewName = 'default';

  private curve = new RotationCurvePlot();
  private showCurve = false;
  private showSun = true;
  private showLabels = true;
  private sunMark!: HTMLElement;
  private bhMark!: HTMLElement;
  private armLabels: Array<{ el: HTMLElement; arm: number; R: number }> = [];
  private labelsPlacedAt = 0;
  private readouts!: { time: Readout; radius: Readout; speed: Readout; period: Readout };
  private controls: {
    arms?: Control<number>;
    pitch?: Control<number>;
    bar?: Control<number>;
    dust?: Control<number>;
    sfr?: Control<number>;
    dark?: Control<boolean>;
    curve?: Control<boolean>;
    fly?: Control<boolean>;
    morph?: Control<MorphologyId>;
    seed?: Control<number>;
    views?: { setActive(i: number): void };
  } = {};
  private fadeIn = 0;

  // Scratch (no per-frame allocation).
  private readonly ray = new THREE.Ray();
  private readonly v1 = new THREE.Vector3();
  private readonly v2 = new THREE.Vector3();
  private readonly sunPos = new THREE.Vector3();
  private readonly plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private cursorR = NaN;
  private pointerSeen = false;
  private shotMode = false;
  private exposureLocked = false;
  private uiTimer = 0;

  async mount(ctx: ExperienceContext): Promise<void> {
    this.ctx = ctx;
    this.shotMode = ctx.params.get('shot') === '1';
    const q = ctx.params.get('preset') as MorphologyId | null;
    if (q && MORPHOLOGIES.some((m) => m.id === q)) this.morph = q;
    const p = preset(this.morph, this.seed);
    this.layer = new GalaxyLayer(ctx.renderer, { params: p, detail: ctx.quality.detail });
    const v = VIEWS.default;
    this.orbit = new OrbitRig(ctx.input, {
      distance: this.viewDistance(v, p),
      yaw: v.yaw,
      pitch: v.pitch,
      minDistance: 2,
      maxDistance: 400000,
      autoRotate: 0.012,
      idleDelay: 10,
      zoomSpeed: 0.16,
    });
    this.post();
    this.buildUI();
    this.setSunPosition();
    ctx.audio.setMood('galaxy', { intensity: 0.35 });
    ctx.progress(0.3, 'Placing stars on their orbits');
    await this.layer.ready;
    this.curve.setPotential(this.layer.kin.potential, this.plotRadius(p), p.id === 'milkyway', p.sun?.R);
    ctx.progress(1);
    ctx.ui.hint('Drag to orbit · Scroll to zoom · Space pause · [ ] time warp · 1–5 views · G dark matter · C rotation curve · F fly', 9000);
    ctx.signalReady();
  }

  /**
   * Eye adaptation. Surface brightness does not depend on distance, so a galaxy's centre or the
   * sky from inside the disk is as bright as the whole galaxy seen from afar — only more of the view
   * is filled. The layer meters the diffuse light (log-mean of lit pixels); exposure follows it
   * partially, (L_ref / L)^0.6, as the eye (and a photographer) would; L_ref is the metered value
   * of the default Milky Way view. When the sky fills the view the background sets the exposure.
   */
  private adaptExposure(dt: number): void {
    const base = this.baseExposure;
    const { lum, sky, lit } = this.layer.meter;
    let target = base;
    if (Number.isFinite(lum) && lum > 0) {
      // Looking at a galaxy: adapt to the bright parts it is made of.
      const outside = base * THREE.MathUtils.clamp(Math.pow(11.4 / lum, 0.6), 0.3, 1.5);
      // Surrounded by sky (inside the disk): keep the typical background dark (scene ≈ 0.05) so the
      // band glows and the stars stand out, as in an unprocessed dark-site photograph.
      const inside = Number.isFinite(sky) && sky > 0 ? THREE.MathUtils.clamp(0.05 / sky, 0.1 * base, 1.5 * base) : outside;
      target = THREE.MathUtils.lerp(outside, inside, THREE.MathUtils.smoothstep(lit, 0.85, 0.99));
    }
    const tau = this.shotMode ? 0.12 : 1.1;
    this.ctx.post.exposure += (target - this.ctx.post.exposure) * (1 - Math.exp(-dt / tau));
  }

  private get baseExposure(): number {
    return 0.1 * this.layer.params.look.exposure;
  }

  private post(): void {
    const post = this.ctx.post;
    post.exposure = this.baseExposure;
    post.tonemap = (this.ctx.params.get('tonemap') as 'aces' | 'agx' | null) ?? 'aces';
    post.saturation = 1.2;
    post.bloomStrength = 0.06;
    post.vignette = 0.12;
  }

  private viewDistance(v: ViewDef, p: GalaxyParams): number {
    if (typeof v.distance !== 'function') return v.distance;
    // Galaxy-scale views: step back on tall (portrait) screens so the disk fits the width.
    const c = this.ctx.canvas;
    const aspect = c.clientWidth > 0 && c.clientHeight > 0 ? c.clientWidth / c.clientHeight : 16 / 9;
    return v.distance(p) * (aspect < 1.3 ? Math.pow(1.3 / aspect, 0.85) : 1);
  }

  private plotRadius(p: GalaxyParams): number {
    return p.id === 'milkyway' ? 25000 : Math.min(40000, Math.max(10000, p.rMax));
  }

  private setSunPosition(): void {
    const s = this.layer.params.sun;
    if (!s) return;
    // The Sun's guiding centre moves at Ω(R⊙); the Sun itself keeps its place in the
    // rotating frame to first order. Render frame: x = X, y = H, z = −spin·Y.
    const phi = s.phi + this.layer.kin.potential.omega(s.R) * this.layer.time;
    this.layer.kin.toRender(s.R * Math.cos(phi), s.R * Math.sin(phi), s.z, this.sunPos);
  }

  // ——— UI ——————————————————————————————————————————————————————————————————————

  private buildUI(): void {
    const ui = this.ctx.ui;
    const style = document.createElement('style');
    style.textContent = MILKYWAY_CSS;
    ui.overlay.appendChild(style);

    this.readouts = {
      time: ui.readout('Time', 'Myr'),
      radius: ui.readout('Radius', 'kpc'),
      speed: ui.readout('Orbital speed', 'km/s'),
      period: ui.readout('Galactic year', 'Myr'),
    };

    // Markers.
    this.sunMark = document.createElement('div');
    this.sunMark.className = 'mw-mark';
    this.sunMark.innerHTML = '<div class="ring"></div><div class="tick"></div><div class="txt">You are here<small>Sun · Orion Spur · 8.2 kpc from the centre</small></div>';
    this.bhMark = document.createElement('div');
    this.bhMark.className = 'mw-mark is-bh';
    this.bhMark.innerHTML = '<div class="ring"></div><div class="tick"></div><div class="txt">Sgr A*<small>4.3 × 10⁶ M☉ black hole</small></div>';
    ui.overlay.append(this.sunMark, this.bhMark);
    this.buildArmLabels();

    this.curve.el.hidden = !this.showCurve;
    ui.corner(this.curve.el);

    // ——— Panel ———
    const g = ui.section('Galaxy');
    this.controls.morph = g.select<MorphologyId>({
      label: 'Morphology',
      value: this.morph,
      options: MORPHOLOGIES.map((m) => ({ value: m.id, label: m.label })),
      onChange: (id) => this.preset(id),
      help: 'The Hubble sequence, generated from parameters and a seed.',
    });
    this.controls.views = g.buttons(
      VIEW_KEYS.map((k) => ({ label: VIEWS[k].label, onClick: () => this.setView(k, 2.6) })),
      0,
    );
    this.controls.seed = g.slider({
      label: 'Seed',
      min: 1,
      max: 99,
      step: 1,
      value: this.seed,
      format: (v) => String(Math.round(v)),
      onChange: (v) => {
        if (Math.round(v) !== this.seed) this.setSeed(Math.round(v));
      },
    });
    g.button({ label: 'About this galaxy', onClick: () => this.showInfo() });

    const s = ui.section('Structure');
    this.controls.arms = s.slider({
      label: 'Arms (m)',
      min: 0,
      max: 4,
      step: 1,
      value: this.layer.live.arms,
      format: (v) => String(Math.round(v)),
      onChange: (v) => this.layer.setLive({ arms: Math.round(v) }),
      help: 'Multiplicity of the stellar density wave.',
    });
    this.controls.pitch = s.slider({
      label: 'Pitch angle',
      min: 5,
      max: 35,
      step: 0.5,
      unit: '°',
      value: this.layer.live.pitchDeg,
      onChange: (v) => this.layer.setLive({ pitchDeg: v }),
      help: 'How tightly the arms wind (Milky Way ≈ 12°).',
    });
    this.controls.bar = s.slider({
      label: 'Bar strength',
      min: 0,
      max: 1,
      step: 0.01,
      value: this.layer.live.barStrength,
      onChange: (v) => this.layer.setLive({ barStrength: v }),
    });
    this.controls.dust = s.slider({
      label: 'Dust',
      min: 0,
      max: 2,
      step: 0.01,
      unit: '×',
      value: this.layer.live.dust,
      onChange: (v) => this.layer.setLive({ dust: v }),
    });
    this.controls.sfr = s.slider({
      label: 'Star formation',
      min: 0,
      max: 2,
      step: 0.01,
      unit: '×',
      value: this.layer.live.sfr,
      onChange: (v) => this.layer.setLive({ sfr: v }),
      help: 'New OB associations per arm crossing. Existing stars live out their lives.',
    });

    const d = ui.section('Dynamics');
    d.slider({
      label: 'Time warp',
      min: 0.1,
      max: 100,
      log: true,
      value: this.warp,
      unit: 'Myr/s',
      format: (v) => (v < 1 ? v.toFixed(2) : v < 10 ? v.toFixed(1) : v.toFixed(0)),
      onChange: (v) => (this.warp = v),
      help: 'Space pauses. At 2 Myr/s the Sun circles the Galaxy in two minutes.',
    });
    this.controls.dark = d.toggle({
      label: 'Dark-matter halo',
      value: true,
      onChange: (v) => this.setDarkMatter(v),
      help: 'Remove it and watch the outer disk fly apart.',
    });
    this.controls.curve = d.toggle({ label: 'Rotation curve', value: this.showCurve, onChange: (v) => this.setCurve(v) });
    d.toggle({ label: 'You are here', value: this.showSun, onChange: (v) => (this.showSun = v) });
    d.toggle({ label: 'Labels', value: this.showLabels, onChange: (v) => (this.showLabels = v) });
    this.controls.fly = d.toggle({ label: 'Fly (WASD)', value: false, onChange: (v) => this.setFly(v) });

    // Keys.
    this.ctx.input.onKeyDown((e) => {
      if (e.repeat) return;
      if (e.code === 'Space') {
        this.paused = !this.paused;
        this.ctx.ui.toast(this.paused ? 'Paused' : `Running · ${this.warp.toFixed(1)} Myr per second`);
        e.preventDefault();
      } else if (/^Digit[1-5]$/.test(e.code)) {
        this.setView(VIEW_KEYS[Number(e.code.slice(5)) - 1], 2.6);
      } else if (e.code === 'KeyF') {
        this.setFly(!this.flying);
        this.controls.fly?.set(this.flying);
      } else if (e.code === 'KeyG') {
        this.setDarkMatter(!this.layer.darkMatter);
      } else if (e.code === 'KeyC') {
        this.setCurve(!this.showCurve);
      } else if (e.code === 'BracketRight' || e.code === 'BracketLeft') {
        const i = WARPS.findIndex((w) => w >= this.warp - 1e-9);
        const j = THREE.MathUtils.clamp((i < 0 ? WARPS.length - 1 : i) + (e.code === 'BracketRight' ? 1 : -1), 0, WARPS.length - 1);
        this.warp = WARPS[j];
        this.ctx.ui.toast(`${this.warp} Myr per second`);
      }
    });
    this.ctx.input.onMove(() => (this.pointerSeen = true));
  }

  private buildArmLabels(): void {
    for (const a of this.armLabels) a.el.remove();
    this.armLabels = [];
    const list = this.layer.params.spiral.armList;
    if (!list) return;
    list.forEach((arm, i) => {
      // The Orion Spur is named in the Sun's own caption.
      if (!arm.name || arm.name.startsWith('Orion')) return;
      const el = document.createElement('div');
      el.className = 'mw-arm';
      el.textContent = arm.name;
      this.ctx.ui.overlay.appendChild(el);
      this.armLabels.push({ el, arm: i, R: 0 });
    });
    this.placeArmLabels();
  }

  /**
   * Put each arm's name where the arm is well developed and away from the Sun's marker and the
   * other names (model-frame distances; the pattern and the Sun turn at different rates, so this is
   * re-run when a name drifts too close to the Sun).
   */
  private placeArmLabels(): void {
    const k = this.layer.kin;
    const list = this.layer.params.spiral.armList;
    if (!list) return;
    const sun = this.layer.sunModel(this.v1);
    const placed: Array<[number, number]> = [];
    for (const a of this.armLabels) {
      const spec = k.arms[a.arm] ?? list[a.arm];
      let best = -1;
      let bestR = a.R || spec.rStart * 1.5;
      const lo = Math.max(spec.rStart * 1.2, 6500);
      const hi = Math.min(spec.rEnd * 0.85, 15500);
      for (let i = 0; i <= 8; i++) {
        const R = lo + ((hi - lo) * i) / 8;
        const phi = armPhi(spec, R) + k.omegaP * this.layer.time;
        const x = R * Math.cos(phi);
        const y = R * Math.sin(phi);
        let d = sun ? Math.hypot(x - sun.x, y - sun.y) : 1e9;
        for (const [px, py] of placed) d = Math.min(d, Math.hypot(x - px, y - py) * 0.8);
        // Prefer the middle of the arm's range when everything else is equal.
        const score = Math.min(d, 7000) - 0.05 * Math.abs(R - 0.5 * (lo + hi));
        if (score > best) {
          best = score;
          bestR = R;
        }
      }
      a.R = bestR;
      const phi = armPhi(spec, bestR) + k.omegaP * this.layer.time;
      placed.push([bestR * Math.cos(phi), bestR * Math.sin(phi)]);
    }
    this.labelsPlacedAt = this.layer.time;
  }

  private setCurve(v: boolean): void {
    this.showCurve = v;
    this.curve.el.hidden = !v;
    this.controls.curve?.set(v);
  }

  private showInfo(): void {
    const p = this.layer.params;
    const pot = this.layer.kin.potential;
    const Rref = p.sun ? p.sun.R : 2.2 * p.disk.scaleLength || p.bulge.a * 2;
    const vc = pot.vcKms(Rref, true);
    const bary = pot.baryonicMass();
    const halo = pot.darkMass(200000);
    const rows: Array<[string, string]> = [
      ['Type', p.hubble],
      ['Stars + gas', `${(bary / 1e10).toFixed(1)} × 10¹⁰ M☉`],
      ['Dark halo (< 200 kpc)', `${(halo / 1e11).toFixed(1)} × 10¹¹ M☉`],
      [p.sun ? 'v_c at the Sun' : `v_c at ${(Rref / 1000).toFixed(1)} kpc`, `${vc.toFixed(0)} km/s`],
    ];
    if (p.spiral.arms > 0) rows.push(['Spiral pattern speed', `${p.spiral.patternSpeed} km/s/kpc`]);
    if (p.bar.lum > 0) rows.push(['Bar pattern speed', `${p.bar.patternSpeed} km/s/kpc`]);
    if (p.sun) {
      const { A, B } = pot.oort(p.sun.R, true);
      rows.push(['Oort A, B', `${A.toFixed(1)}, ${B.toFixed(1)} km/s/kpc`]);
      rows.push(['Corotation (spiral)', `${(pot.resonance(this.layer.kin.omegaP, 'CR') / 1000).toFixed(1)} kpc`]);
    }
    this.ctx.ui.info({
      title: p.label,
      subtitle: p.id === 'milkyway' ? 'Our Galaxy, a barred spiral seen from outside' : 'A galaxy of the Hubble sequence',
      rows,
      body:
        p.id === 'milkyway'
          ? 'The arms are not fixed structures but traffic jams: stars and gas drift through them, slowing and crowding as they pass. Gas shocks on the inner edge (the dark dust lanes), forms stars, and the brightest of them — blue and short-lived — die before they can leave the arm. The Sun takes about 230 million years to go once around.'
          : 'Generated from the same physics as the Milky Way: a mass model gives the orbits, a density wave organises the stars, and gas and dust follow the arms.',
    });
  }

  // ——— Debug / integration hooks ——————————————————————————————————————————————

  setView(name: string, duration = 0): void {
    const v = VIEWS[name as ViewName];
    if (!v) return;
    if (v.target === 'sun' && !this.layer.params.sun) return;
    this.view = name as ViewName;
    if (this.flying) {
      this.setFly(false);
      this.controls.fly?.set(false);
    }
    this.setSunPosition();
    const target = v.target === 'sun' ? this.sunPos.clone() : new THREE.Vector3(...(v.target ?? [0, 0, 0]));
    let yaw = v.yaw;
    if (v.target === 'sun') {
      // Look from behind the Sun toward the Galactic Centre (the Sun's azimuth moves with time).
      yaw = Math.atan2(this.sunPos.x, this.sunPos.z) + (name === 'neighbourhood' ? -0.55 : 0);
    }
    const to = { target, distance: this.viewDistance(v, this.layer.params), yaw, pitch: v.pitch };
    this.fovGoal = v.fov ?? 50;
    if (duration > 0) this.orbit.flyTo(to, duration);
    else {
      this.orbit.set(to);
      this.fov = this.fovGoal;
    }
    this.orbit.autoRotate = name === 'sun' ? 0 : 0.012;
    const i = VIEW_KEYS.indexOf(name as ViewName);
    if (i >= 0) this.controls.views?.setActive(i);
  }
  setTime(t: number): void {
    this.layer.time = t;
    this.setSunPosition();
  }
  setWarp(w: number): void {
    this.warp = w;
  }
  /** Advance simulated time by dt Myr in steps (integrates when dark matter is off). */
  advance(dt: number, steps = 1): void {
    for (let i = 0; i < steps; i++) this.layer.advance(dt / steps);
  }
  setDarkMatter(on: boolean): void {
    this.layer.setDarkMatter(on);
    this.controls.dark?.set(on);
    this.curve.setDark(on);
    if (!on) this.setCurve(true);
    if (on) this.fadeIn = 0;
    this.ctx.ui.toast(on ? 'Dark halo restored · the galaxy returns to equilibrium' : 'Dark halo removed · only the visible mass holds the stars now', 3600);
    this.ctx.audio.event(on ? 'restore' : 'rupture');
  }
  preset(id: string, seed = this.seed): void {
    if (!MORPHOLOGIES.some((m) => m.id === id)) return;
    this.morph = id as MorphologyId;
    this.seed = seed;
    const p = preset(this.morph, seed);
    const dmOff = !this.layer.darkMatter;
    if (dmOff) this.setDarkMatter(true);
    this.layer.setParams(p);
    this.fadeIn = 0;
    this.controls.morph?.set(this.morph);
    this.controls.arms?.set(p.spiral.arms);
    this.controls.pitch?.set(p.spiral.pitchDeg);
    this.controls.bar?.set(1);
    this.controls.dust?.set(1);
    this.controls.sfr?.set(1);
    this.controls.arms?.setDisabled(p.spiral.amplitude === 0);
    this.controls.pitch?.setDisabled(p.spiral.amplitude === 0);
    this.controls.bar?.setDisabled(p.bar.lum === 0);
    this.post();
    this.curve.setPotential(this.layer.kin.potential, this.plotRadius(p), p.id === 'milkyway', p.sun?.R);
    this.buildArmLabels();
    this.setSunPosition();
    this.setView(this.view === 'sun' || this.view === 'neighbourhood' ? 'default' : this.view, 2.2);
    this.ctx.audio.setMood('galaxy', { intensity: p.young.sfr > 0 ? 0.35 : 0.2 });
  }
  setSeed(seed: number): void {
    this.seed = seed;
    const p = preset(this.morph, seed);
    const dmOff = !this.layer.darkMatter;
    if (dmOff) this.setDarkMatter(true);
    const live = this.layer.live;
    this.layer.setParams(p);
    this.layer.setLive(live);
    this.fadeIn = 0.3;
    this.controls.seed?.set(seed);
  }
  setFly(on: boolean): void {
    if (on === this.flying) return;
    this.flying = on;
    if (on) {
      if (!this.fly) {
        this.fly = new FlyRig(this.ctx.input, {
          nearestDistance: () => this.flyScale(),
          autoSpeed: 0.35,
          minSpeed: 2,
          maxSpeed: 60000,
          inertia: 0.35,
        });
      }
      this.fly.position.copy(this.orbit.position);
      this.fly.quaternion.copy(this.orbit.quaternion);
      this.fly.velocity.set(0, 0, 0);
      this.fly.enabled = true;
      this.orbit.enabled = false;
      this.ctx.ui.hint('W/S forward · A/D strafe · R/F up/down · Q/E roll · drag to look · Shift boost', 7000);
    } else if (this.fly) {
      this.fly.enabled = false;
      this.orbit.enabled = true;
      // Orbit around a point ahead of the ship.
      const fwd = this.v1.set(0, 0, -1).applyQuaternion(this.fly.quaternion);
      const d = THREE.MathUtils.clamp(this.flyScale() * 2, 20, 200000);
      const target = this.v2.copy(this.fly.position).addScaledVector(fwd, d);
      const off = this.v1.copy(this.fly.position).sub(target);
      this.orbit.set({
        target: target.clone(),
        distance: d,
        yaw: Math.atan2(off.x, off.z),
        pitch: Math.asin(THREE.MathUtils.clamp(off.y / d, -1, 1)),
      });
    }
  }
  /** Distance scale for flight speed: height above the disk, or distance to the galaxy. */
  private flyScale(): number {
    const p = this.fly?.position ?? this.orbit.position;
    const R = Math.hypot(p.x, p.z);
    const out = Math.max(0, R - this.layer.params.rMax);
    return Math.max(25, Math.hypot(Math.abs(p.y) + 150, out));
  }
  /** Debug toggles. */
  debug(o: { old?: number; young?: number; hii?: number; stars?: boolean; volume?: boolean; map?: number; exposure?: number; vol?: number; mask?: number; tonemap?: 'aces' | 'agx' | 'agx-punchy' }): void {
    if (o.old !== undefined) this.layer.oldGain = o.old;
    if (o.hii !== undefined) this.layer.hiiGain = o.hii;
    if (o.young !== undefined) this.layer.popGain.y = o.young;
    if (o.vol !== undefined) this.layer.debugVolume = o.vol;
    if (o.mask !== undefined) this.layer.debugMask = o.mask;
    if (o.tonemap !== undefined) this.ctx.post.tonemap = o.tonemap;
    if (o.stars !== undefined) this.layer.starsVisible = o.stars;
    if (o.volume !== undefined) this.layer.volumeVisible = o.volume;
    if (o.map !== undefined) this.layer.debugMap = o.map;
    if (o.exposure !== undefined) {
      this.ctx.post.exposure = o.exposure;
      this.exposureLocked = true;
    }
  }
  get galaxy(): GalaxyLayer {
    return this.layer;
  }

  // ——— Frame ——————————————————————————————————————————————————————————————————

  update(f: FrameInfo): void {
    this.frame = f.frame;
    if (this.flying && this.fly) this.fly.update(f.dt);
    else this.orbit.update(f.dt);
    this.fov += (this.fovGoal - this.fov) * (1 - Math.exp(-f.dt / 0.5));
    if (!this.exposureLocked) this.adaptExposure(f.dt);
    if (!this.paused) this.layer.advance(this.warp * f.dt);
    this.fadeIn = Math.min(1, this.fadeIn + f.dt / 0.8);
    this.layer.radianceScale = this.fadeIn * this.fadeIn * (3 - 2 * this.fadeIn);
    this.setSunPosition();
  }

  render(target: THREE.WebGLRenderTarget): void {
    const r = this.ctx.renderer;
    this.camera.aspect = target.width / target.height;
    this.camera.fov = this.fov;
    this.camera.updateProjectionMatrix();
    if (this.flying && this.fly) this.fly.applyTo(this.camera);
    else this.orbit.applyTo(this.camera);
    r.setRenderTarget(target);
    this.layer.render(r, this.camera, target, { exposure: this.ctx.post.exposure, frame: this.frame });
    // Headless capture on a CPU rasteriser: keep rAF from running ahead of the GPU process
    // (otherwise seconds-long frames queue up behind the screenshot). Never in normal use.
    if (this.shotMode) r.getContext().finish();
    this.updateOverlay();
  }

  private updateOverlay(): void {
    const w = this.ctx.canvas.clientWidth;
    const h = this.ctx.canvas.clientHeight;
    const cam = this.camera;
    const camPos = cam.position;
    const params = this.layer.params;

    // Sun and Sgr A* markers.
    const place = (el: HTMLElement, p: THREE.Vector3, visible: boolean, minDist = 0) => {
      const v = this.v1.copy(p).project(cam);
      const d = camPos.distanceTo(p);
      const on = visible && v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1 && d > minDist;
      el.style.opacity = on ? '1' : '0';
      if (!on) return;
      const x = (v.x + 1) * 0.5 * w;
      el.classList.toggle('is-left', x > w - 230);
      el.style.transform = `translate(${x.toFixed(1)}px, ${((1 - v.y) * 0.5 * h).toFixed(1)}px)`;
    };
    // With the halo removed the orbits are integrated, so the analytic Sun and arm loci no longer apply.
    const dm = this.layer.darkMatter;
    place(this.sunMark, this.sunPos, this.showSun && !!params.sun && dm, 20);
    this.v2.set(0, 0, 0);
    place(this.bhMark, this.v2, this.showLabels && params.id === 'milkyway' && camPos.length() < 16000 && camPos.length() > 300);

    // Arm names (Milky Way), riding with the pattern.
    const k = this.layer.kin;
    const list = params.spiral.armList;
    const labelsOn = this.showLabels && dm && !!list && w > 720 && camPos.length() > 9000 && camPos.length() < 120000;
    if (labelsOn && Math.abs(this.layer.time - this.labelsPlacedAt) > 40) this.placeArmLabels();
    for (const a of this.armLabels) {
      if (!labelsOn || !list) {
        a.el.style.opacity = '0';
        continue;
      }
      const spec = k.arms[a.arm] ?? list[a.arm];
      const phi = armPhi(spec, a.R) + k.omegaP * this.layer.time;
      k.toRender(a.R * Math.cos(phi), a.R * Math.sin(phi), 0, this.v2);
      const v = this.v1.copy(this.v2).project(cam);
      const on = v.z < 1 && Math.abs(v.x) < 0.95 && Math.abs(v.y) < 0.95;
      a.el.style.opacity = on ? '0.8' : '0';
      if (on) a.el.style.transform = `translate(-50%, -50%) translate(${((v.x + 1) * 0.5 * w).toFixed(1)}px, ${((1 - v.y) * 0.5 * h).toFixed(1)}px)`;
    }

    // Readouts (throttled; string compare inside Readout avoids DOM churn).
    if (++this.uiTimer % 4 !== 0) return;
    const t = this.layer.time;
    if (Math.abs(t) < 1000) this.readouts.time.set(t.toFixed(Math.abs(t) < 100 ? 1 : 0), 'Myr');
    else this.readouts.time.set((t / 1000).toFixed(3), 'Gyr');

    // Galactocentric radius under the cursor (disk plane), else at the camera / its target.
    let R = NaN;
    const ptr = this.ctx.input.pointer;
    if (ptr.inside && this.pointerSeen) {
      this.ray.origin.copy(camPos);
      this.ray.direction.set(ptr.ndcX, ptr.ndcY, 0.5).unproject(cam).sub(camPos).normalize();
      const hit = this.ray.intersectPlane(this.plane, this.v2);
      if (hit) {
        const r = Math.hypot(hit.x, hit.z);
        if (r < params.rMax * 1.3) R = r;
      }
    }
    if (!(R > 0)) {
      const c = Math.hypot(camPos.x, camPos.z);
      const tR = Math.hypot(this.orbit.target.x, this.orbit.target.z);
      const ref = params.sun ? params.sun.R : 2.2 * (params.disk.scaleLength || params.bulge.a);
      R = Math.abs(camPos.y) < 3000 && c < params.rMax ? c : tR > 300 ? tR : ref;
    }
    this.cursorR = R;
    this.curve.setCursor(R);
    const pot = k.potential;
    const Rs = Math.max(R, 30);
    this.readouts.radius.set(R < 1000 ? R.toFixed(0) : (R / 1000).toFixed(2), R < 1000 ? 'pc' : 'kpc');
    this.readouts.speed.set(kmsFromPcMyr(pot.vc(Rs)).toFixed(0), 'km/s');
    const P = pot.period(Rs);
    this.readouts.period.set(P < 1000 ? P.toFixed(P < 10 ? 1 : 0) : (P / 1000).toFixed(2), P < 1000 ? 'Myr' : 'Gyr');
  }

  resize(w: number, h: number): void {
    this.layer?.resize(w, h);
  }

  unmount(): void {
    this.layer.dispose();
    for (const a of this.armLabels) a.el.remove();
    this.armLabels = [];
  }
}

export default () => new MilkyWay();
