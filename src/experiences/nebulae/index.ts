import * as THREE from 'three';
import type { Experience, ExperienceContext, FrameInfo } from '../../core/types';
import { OrbitRig } from '../../core/rigs/OrbitRig';
import { FlyRig } from '../../core/rigs/FlyRig';
import type { Control } from '../../ui/Panel';
import type { Readout } from '../../ui/UI';
import { Sky } from '../../worlds/sky/Sky';
import { NebulaVolume } from '../../worlds/nebula/NebulaVolume';
import { NebulaStars, type SpikeStyle } from '../../worlds/nebula/NebulaStars';
import { PRESETS, VARIANTS, getPreset } from '../../worlds/nebula/presets';
import type { NebulaPreset, NebulaVariant } from '../../worlds/nebula/types';
import {
  avFromBalmerDecrement,
  describeIonizingFlux,
  NEBULA_LINES,
  paletteLineColours,
  pulsarExposure,
  stromgrenRadiusPc,
  type Palette,
} from '../../physics/nebulae';
import { formatNumber, formatScientific } from '../../physics/units';

const PALETTES: Array<{ id: Palette; label: string }> = [
  { id: 'true', label: 'True colour' },
  { id: 'sho', label: 'Hubble SHO' },
  { id: 'hoo', label: 'HOO' },
];
const SPIKES: Array<{ id: SpikeStyle; label: string }> = [
  { id: 'none', label: 'None' },
  { id: 'hubble', label: 'Hubble' },
  { id: 'jwst', label: 'JWST' },
];

/** Years → "4.0 kyr" style. */
function fmtYears(y: number): string {
  if (y >= 1e6) return `${formatNumber(y / 1e6, 3)} Myr`;
  if (y >= 1e4) return `${formatNumber(y / 1e3, 3)} kyr`;
  return `${formatNumber(Math.round(y), 4)} yr`;
}

const fmtPc = (pc: number) => (pc < 0.1 ? `${formatNumber(pc * 206265, 3)} AU` : `${formatNumber(pc, 3)} pc`);

/**
 * Nebulae — the interstellar medium, lit and coloured by atomic physics.
 * Presets: the Pillars, the Horsehead, three planetary nebulae, two supernova remnants and the
 * Pleiades. Orbit or fly through each; toggle true colour / Hubble palette; change the gas
 * density, the ionizing flux and the dust; let time run to watch shells expand at their real
 * speeds (sped up). Tap anywhere to take a spectrum of that line of sight.
 */
class Nebulae implements Experience {
  private ctx!: ExperienceContext;
  private sky!: Sky;
  private orbit!: OrbitRig;
  private fly!: FlyRig;
  private mode: 'orbit' | 'fly' = 'orbit';
  private camera = new THREE.PerspectiveCamera(42, 1, 0.0005, 5000);
  volume: NebulaVolume | null = null;
  private stars: NebulaStars | null = null;
  private pending: { volume: NebulaVolume; stars: NebulaStars; view: string } | null = null;
  private outgoing: { volume: NebulaVolume; stars: NebulaStars; fade: number } | null = null;
  private fadeIn = 1;
  private variant: NebulaVariant = 'pillars';
  private seed = 0;
  private palette: Palette = 'true';
  private spikes: SpikeStyle = 'jwst';
  private exposure = 1;
  private densityScale = 1;
  private fluxScale = 1;
  private dustScale = 1;
  private teff = 0;
  private age = 0;
  private playing = false;
  private rateMul = 1;
  private realTime = 0;
  private viewName = 'default';
  private seedTimer = 0;
  private probeEl: HTMLElement | null = null;
  private ui: {
    preset?: Control<string>;
    views?: { el: HTMLElement; setActive(i: number): void };
    viewsHost?: HTMLElement;
    palette?: { el: HTMLElement; setActive(i: number): void };
    spikes?: { el: HTMLElement; setActive(i: number): void };
    seed?: Control<number>;
    density?: Control<number>;
    flux?: Control<number>;
    teff?: Control<number>;
    dust?: Control<number>;
    play?: Control<void>;
    rate?: Control<number>;
    physText?: HTMLElement;
    fluxOut?: (v: string) => void;
    rsOut?: (v: string) => void;
    chips?: HTMLElement[];
    mode?: { el: HTMLElement; setActive(i: number): void };
  } = {};
  private readAge!: Readout;
  private readSize!: Readout;
  private readView!: Readout;
  private readonly tmpV = new THREE.Vector3();

  async mount(ctx: ExperienceContext): Promise<void> {
    this.ctx = ctx;
    ctx.post.tonemap = 'agx-punchy';
    ctx.post.bloomStrength = 0.07;
    ctx.post.bloomRadius = 0.75;
    ctx.post.vignette = 0.2;
    ctx.post.exposure = 1;
    ctx.post.saturation = 1.08;

    const v = ctx.params.get('nebula') as NebulaVariant | null;
    if (v && PRESETS[v]) this.variant = v;
    if (ctx.params.has('seed')) this.seed = Math.max(0, Math.floor(Number(ctx.params.get('seed')) || 0));
    const pal = ctx.params.get('palette') as Palette | null;
    if (pal === 'sho' || pal === 'hoo' || pal === 'true') this.palette = pal;
    const sp = ctx.params.get('spikes') as SpikeStyle | null;
    if (sp === 'none' || sp === 'hubble' || sp === 'jwst') this.spikes = sp;

    this.sky = new Sky({ stars: Math.round(9000 * ctx.quality.detail), milkyWay: 0.22, brightness: 0.5 });
    const preset = getPreset(this.variant);
    const view = preset.views.default;
    this.orbit = new OrbitRig(ctx.input, {
      distance: view.distance * this.fit(),
      yaw: view.yaw,
      pitch: view.pitch,
      target: new THREE.Vector3(...(view.target ?? [0, 0, 0])),
      minDistance: preset.half * 0.02,
      maxDistance: preset.half * 30,
      autoRotate: 0.012,
      idleDelay: 12,
    });
    this.fly = new FlyRig(ctx.input, {
      speed: preset.half * 0.2,
      nearestDistance: () => this.flyScale(),
      autoSpeed: 0.35,
      inertia: 0.4,
      lookDamping: 0.08,
    });
    this.fly.enabled = false;

    const built = this.build(this.variant, this.seed);
    this.volume = built.volume;
    this.stars = built.stars;
    this.age = this.volume.preset.ageYears;
    this.teff = this.volume.preset.source.teff;
    ctx.audio.setMood('nebulae', { intensity: 0.4 });
    this.buildUI();
    this.applyVariantUI();
    await this.volume.bake(ctx.renderer, (f) => ctx.progress(f, 'Ionizing the gas'));
    if (!ctx.params.has('nometer')) await this.volume.calibrate(ctx.renderer);
    ctx.ui.hint('Drag to orbit · Scroll to zoom · Tap for a spectrum · 1–8 nebulae · C palette · G fly · Space time');
    ctx.signalReady();
  }

  // ——— construction ——————————————————————————————————————————————————————————

  private build(variant: NebulaVariant, seed: number): { volume: NebulaVolume; stars: NebulaStars } {
    const q = this.ctx.quality.detail;
    const volume = new NebulaVolume({ variant, seed, detail: q, palette: this.palette });
    volume.exposure = this.exposure;
    volume.densityScale = this.densityScale;
    volume.fluxScale = this.fluxScale;
    volume.dustScale = this.dustScale;
    if (this.teff && variant === this.variant) volume.teff = this.teff;
    volume.applyParams();
    const p = volume.preset;
    const field = this.ctx.params.has('field')
      ? Number(this.ctx.params.get('field'))
      : Math.round((variant === 'veil' ? 5200 : 2600) * Math.min(1.2, q + 0.3));
    const stars = new NebulaStars({
      stars: volume.stars,
      fieldStars: field,
      fieldRadius: p.half * 18,
      fieldInner: p.half * 1.2,
      seed: 7 + seed * 13 + VARIANTS.indexOf(variant),
    });
    stars.spikes = this.spikes;
    stars.setVolume(volume);
    return { volume, stars };
  }

  /** Switch to another nebula (or a new seed of the same one): bake off-screen, then cross-fade. */
  private select(variant: NebulaVariant, seed = 0, view = 'default'): void {
    if (this.pending) {
      this.pending.volume.dispose();
      this.pending.stars.dispose();
      this.pending = null;
    }
    const sameVariant = variant === this.variant;
    this.variant = variant;
    this.seed = seed;
    if (!sameVariant) {
      this.densityScale = 1;
      this.fluxScale = 1;
      this.dustScale = 1;
      this.teff = getPreset(variant).source.teff;
      this.age = getPreset(variant).ageYears;
      this.rateMul = 1;
    }
    const b = this.build(variant, seed);
    this.pending = { ...b, view: sameVariant ? '' : view };
    this.applyVariantUI();
    if (!sameVariant) {
      this.ctx.audio.event('portal');
      this.ctx.ui.info(null);
    }
  }

  private flyScale(): number {
    const v = this.volume;
    if (!v) return 1;
    const d = this.fly.position.length();
    return Math.max(v.preset.half * 0.08, Math.min(d, v.preset.half * 2));
  }

  // ——— UI ————————————————————————————————————————————————————————————————————

  private buildUI(): void {
    const ui = this.ctx.ui;
    this.readAge = ui.readout('Age', '');
    this.readSize = ui.readout('Size', '');
    this.readView = ui.readout('Camera', '');

    // Nebula chips in the corner: the fastest way to travel between objects.
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end;max-width:min(92vw,560px);pointer-events:auto';
    this.ui.chips = VARIANTS.map((v, i) => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.textContent = PRESETS[v].label;
      b.title = `${PRESETS[v].title} (${i + 1})`;
      b.addEventListener('click', () => this.select(v));
      bar.appendChild(b);
      return b;
    });
    ui.corner(bar);

    const s1 = ui.section('Nebula');
    this.ui.preset = s1.select({
      label: 'Object',
      value: this.variant,
      options: VARIANTS.map((v) => ({ value: v, label: `${PRESETS[v].title} — ${PRESETS[v].subtitle.split(' · ')[0]}` })),
      onChange: (v) => this.select(v as NebulaVariant),
    });
    this.ui.viewsHost = s1.custom(document.createElement('div'));
    this.ui.seed = s1.slider({
      label: 'Seed',
      min: 0,
      max: 99,
      step: 1,
      value: this.seed,
      format: (v) => (v === 0 ? 'curated' : String(Math.round(v))),
      help: 'Seed 0 resembles the real object; any other seed grows a new nebula from the same physics.',
      onChange: (v) => {
        const sd = Math.round(v);
        clearTimeout(this.seedTimer);
        this.seedTimer = window.setTimeout(() => this.select(this.variant, sd), 250);
      },
    });
    s1.button({ label: 'About this object', onClick: () => this.showInfo() });

    const s2 = ui.section('Light');
    s2.text('Colour mapping of the emission lines.');
    this.ui.palette = s2.buttons(
      PALETTES.map((p) => ({ label: p.label, onClick: () => this.setPalette(p.id) })),
      PALETTES.findIndex((p) => p.id === this.palette),
    );
    s2.text('Diffraction spikes');
    this.ui.spikes = s2.buttons(
      SPIKES.map((p) => ({ label: p.label, onClick: () => this.setSpikes(p.id) })),
      SPIKES.findIndex((p) => p.id === this.spikes),
    );
    s2.slider({
      label: 'Exposure',
      min: 0.1,
      max: 10,
      log: true,
      value: this.exposure,
      format: (v) => `${v >= 1 ? '+' : '−'}${formatNumber(Math.abs(Math.log2(v)), 2)} EV`,
      onChange: (v) => {
        this.exposure = v;
        if (this.volume) {
          this.volume.exposure = v;
          this.volume.applyParams();
        }
      },
    });

    const s3 = ui.section('Physics');
    this.ui.physText = s3.text('');
    this.ui.density = s3.slider({
      label: 'Gas density',
      min: 0.25,
      max: 4,
      log: true,
      value: 1,
      unit: '×',
      help: 'Denser gas recombines faster (∝ n²), so the ionized region shrinks as n^−2/3.',
      onChange: (v) => this.setPhysics({ density: v }),
    });
    this.ui.flux = s3.slider({
      label: 'Ionizing flux',
      min: 0.05,
      max: 20,
      log: true,
      value: 1,
      unit: '×',
      help: 'Ultraviolet photons per second from the hot star(s). The Strömgren radius grows as Q^1/3.',
      onChange: (v) => this.setPhysics({ flux: v }),
    });
    this.ui.teff = s3.slider({
      label: 'Star temperature',
      min: 25000,
      max: 250000,
      log: true,
      value: this.teff || 40000,
      unit: 'K',
      format: (v) => formatNumber(Math.round(v / 100) * 100, 3),
      help: 'Hotter stars emit harder photons: O²⁺ ([OIII], teal) and He²⁺ zones grow.',
      onChange: (v) => this.setPhysics({ teff: v }),
    });
    this.ui.dust = s3.slider({
      label: 'Dust',
      min: 0,
      max: 3,
      value: 1,
      unit: '×',
      help: 'Dust-to-gas ratio relative to the Milky Way: absorbs and reddens light, scatters starlight blue.',
      onChange: (v) => this.setPhysics({ dust: v }),
    });
    this.ui.fluxOut = s3.readout('Ionizing source');
    this.ui.rsOut = s3.readout('Strömgren radius');

    const s4 = ui.section('Time');
    this.ui.play = s4.button({ label: 'Play', onClick: () => this.setPlaying(!this.playing) });
    this.ui.rate = s4.slider({
      label: 'Time-lapse',
      min: 0.1,
      max: 20,
      log: true,
      value: 1,
      unit: '×',
      format: (v) => formatNumber((this.volume?.preset.timeRate ?? 1) * v, 3),
      help: 'Simulated years per second. Shells expand at their measured speeds; gas drifts with its turbulent velocity.',
      onChange: (v) => (this.rateMul = v),
    });
    s4.button({
      label: 'Reset to today',
      onClick: () => {
        this.age = this.volume?.preset.ageYears ?? 0;
      },
    });

    const s5 = ui.section('Camera');
    this.ui.mode = s5.buttons(
      [
        { label: 'Orbit', onClick: () => this.setMode('orbit') },
        { label: 'Fly', onClick: () => this.setMode('fly') },
      ],
      0,
    );
    s5.text('Fly: drag to look · W A S D move · R F up/down · Shift faster');

    // Spectrum card (tap anywhere on the nebula).
    const probe = document.createElement('div');
    probe.style.cssText =
      'position:absolute;min-width:190px;padding:10px 12px 9px;background:var(--glass);border:1px solid var(--line);border-radius:10px;' +
      'font:11px/1.35 var(--font-mono);color:var(--ink-2);pointer-events:none;opacity:0;transition:opacity .35s;backdrop-filter:blur(6px)';
    ui.ui.overlay.appendChild(probe);
    this.probeEl = probe;

    this.ctx.input.onTap((t) => this.probe(t.ndcX, t.ndcY, t.x, t.y));
    this.ctx.input.onKeyDown((e) => {
      if (e.repeat) return;
      const n = Number(e.key);
      if (n >= 1 && n <= VARIANTS.length) this.select(VARIANTS[n - 1]);
      else if (e.code === 'KeyC') this.setPalette(PALETTES[(PALETTES.findIndex((p) => p.id === this.palette) + 1) % PALETTES.length].id);
      else if (e.code === 'KeyX') this.setSpikes(SPIKES[(SPIKES.findIndex((p) => p.id === this.spikes) + 1) % SPIKES.length].id);
      else if (e.code === 'KeyG') this.setMode(this.mode === 'orbit' ? 'fly' : 'orbit');
      else if (e.code === 'Space') {
        e.preventDefault();
        this.setPlaying(!this.playing);
      } else if (e.code === 'KeyV' && this.mode === 'orbit') {
        const names = Object.keys((this.pending?.volume ?? this.volume)!.preset.views);
        this.setView(names[(names.indexOf(this.viewName) + 1) % names.length]);
      } else if (e.code === 'KeyN') this.select(this.variant, 1 + Math.floor(Math.random() * 99));
      else if (e.code === 'KeyI') this.showInfo();
    });
  }

  private showInfo(): void {
    const p = (this.pending?.volume ?? this.volume)?.preset;
    if (!p) return;
    this.ctx.ui.info({ title: p.title, subtitle: p.subtitle, rows: p.info.rows, body: p.info.body });
  }

  /** Refresh the variant-dependent parts of the panel. */
  private applyVariantUI(): void {
    const p = getPreset(this.variant);
    this.ui.preset?.set(this.variant);
    this.ui.seed?.set(this.seed);
    this.ui.chips?.forEach((c, i) => c.classList.toggle('is-active', VARIANTS[i] === this.variant));
    // View buttons.
    if (this.ui.viewsHost) {
      this.ui.viewsHost.innerHTML = '';
      const row = document.createElement('div');
      row.className = 'pnl-buttons';
      Object.keys(p.views).forEach((name) => {
        const b = document.createElement('button');
        b.className = 'chip';
        b.textContent = name === 'default' ? 'Overview' : name[0].toUpperCase() + name.slice(1);
        b.addEventListener('click', () => this.setView(name));
        row.appendChild(b);
      });
      this.ui.viewsHost.appendChild(row);
    }
    const photo = p.layout === 'photo' && p.source.Q > 0;
    this.ui.density?.set(this.densityScale);
    this.ui.flux?.set(this.fluxScale);
    this.ui.dust?.set(this.dustScale);
    this.ui.teff?.set(this.teff || p.source.teff);
    this.ui.density?.setDisabled(p.layout !== 'photo');
    this.ui.flux?.setDisabled(!photo);
    this.ui.teff?.setDisabled(!photo);
    this.ui.rate?.set(this.rateMul);
    if (this.ui.physText) {
      this.ui.physText.textContent =
        p.layout === 'shock'
          ? 'Shock-heated filaments: the colours come from gas cooling behind a blast wave, not from starlight.'
          : photo
            ? 'Ionization is solved ray by ray from the star (Strömgren balance). Change the inputs and watch the fronts move.'
            : 'No ionizing star: the nebula shines only by starlight scattered off dust grains.';
    }
    this.updatePhysicsReadouts();
  }

  private updatePhysicsReadouts(): void {
    const p = getPreset(this.variant);
    const Q = p.source.Q * this.fluxScale;
    if (p.layout !== 'photo' || Q <= 0) {
      this.ui.fluxOut?.('—');
      this.ui.rsOut?.('—');
      return;
    }
    this.ui.fluxOut?.(`${formatScientific(Q, 2)} s⁻¹ · ${describeIonizingFlux(Q)}`);
    const nRef = p.nRef ?? 100;
    const rs = stromgrenRadiusPc(Q, nRef * this.densityScale);
    this.ui.rsOut?.(`${fmtPc(rs)} at n = ${formatNumber(nRef * this.densityScale, 3)} cm⁻³`);
  }

  // ——— actions (also debug hooks for scripts/shot.mjs --eval) ——————————————————————

  setPalette(p: Palette): void {
    this.palette = p;
    for (const v of [this.volume, this.pending?.volume]) {
      if (!v) continue;
      v.palette = p;
      v.applyParams();
    }
    this.ui.palette?.setActive(PALETTES.findIndex((x) => x.id === p));
    this.ctx.ui.toast(PALETTES.find((x) => x.id === p)!.label + (p === 'sho' ? ' · [SII] red, Hα green, [OIII] blue' : p === 'hoo' ? ' · Hα red, [OIII] teal' : ''));
  }

  setSpikes(s: SpikeStyle): void {
    this.spikes = s;
    if (this.stars) this.stars.spikes = s;
    if (this.pending) this.pending.stars.spikes = s;
    this.ui.spikes?.setActive(SPIKES.findIndex((x) => x.id === s));
  }

  setView(name: string): void {
    const p = (this.pending?.volume ?? this.volume)?.preset;
    const v = p?.views[name];
    if (!v || !p) return;
    this.viewName = name;
    if (this.mode === 'fly') this.setMode('orbit');
    this.orbit.minDistance = p.half * 0.01;
    this.orbit.maxDistance = p.half * 30;
    this.orbit.flyTo({ distance: v.distance * this.fit(), yaw: v.yaw, pitch: v.pitch, target: new THREE.Vector3(...(v.target ?? [0, 0, 0])) }, 2.2);
  }

  /** Jump without animation (screenshots). */
  snapView(name: string): void {
    const v = this.volume?.preset.views[name];
    if (!v) return;
    this.viewName = name;
    this.orbit.set({ distance: v.distance * this.fit(), yaw: v.yaw, pitch: v.pitch, target: new THREE.Vector3(...(v.target ?? [0, 0, 0])) });
  }

  /** Views are framed for landscape screens; pull back on portrait ones so the object still fits. */
  private fit(): number {
    const c = this.ctx.canvas;
    const aspect = c.clientWidth / Math.max(1, c.clientHeight);
    return aspect >= 1.3 ? 1 : Math.min(2.2, 1.3 / Math.max(aspect, 0.3)) * 0.75 + 0.25;
  }

  setPhysics(o: { density?: number; flux?: number; dust?: number; teff?: number }): void {
    if (o.density !== undefined) this.densityScale = o.density;
    if (o.flux !== undefined) this.fluxScale = o.flux;
    if (o.dust !== undefined) this.dustScale = o.dust;
    if (o.teff !== undefined) this.teff = o.teff;
    const v = this.volume;
    if (v) {
      v.densityScale = this.densityScale;
      v.fluxScale = this.fluxScale;
      v.dustScale = this.dustScale;
      v.teff = this.teff || v.preset.source.teff;
      v.applyParams();
    }
    this.updatePhysicsReadouts();
  }

  setPlaying(on: boolean): void {
    this.playing = on;
    const b = this.ui.play?.el.querySelector('button') ?? this.ui.play?.el;
    if (b) b.textContent = on ? 'Pause' : 'Play';
  }

  setTime(years: number): void {
    this.age = Math.max(0, years);
  }

  preset(name: NebulaVariant, seed = 0): void {
    this.select(name, seed);
  }

  setMode(m: 'orbit' | 'fly'): void {
    if (m === this.mode) return;
    this.mode = m;
    if (m === 'fly') {
      this.fly.position.copy(this.orbit.position);
      this.fly.quaternion.copy(this.orbit.quaternion);
      this.fly.velocity.set(0, 0, 0);
      this.fly.enabled = true;
      this.orbit.enabled = false;
      this.ctx.ui.toast('Fly · drag to look · WASD to move · R/F up/down');
    } else {
      // Resume orbiting about the point in front of the camera.
      const fwd = this.tmpV.set(0, 0, -1).applyQuaternion(this.fly.quaternion);
      const d = Math.max(this.volume?.preset.half ?? 1, 0.1) * 0.8;
      const target = this.fly.position.clone().addScaledVector(fwd, d);
      const off = this.fly.position.clone().sub(target);
      this.orbit.set({ target, distance: off.length(), yaw: Math.atan2(off.x, off.z), pitch: Math.asin(THREE.MathUtils.clamp(off.y / off.length(), -1, 1)) });
      this.fly.enabled = false;
      this.orbit.enabled = true;
    }
    this.ui.mode?.setActive(m === 'orbit' ? 0 : 1);
  }

  /** Fly-through debug hook: place the free camera at `pos` looking at `look` (nebula-local pc). */
  flyTo(pos: [number, number, number], look: [number, number, number] = [0, 0, 0]): void {
    this.setMode('fly');
    this.fly.position.set(...pos);
    this.fly.velocity.set(0, 0, 0);
    this.fly.lookAt(new THREE.Vector3(...look));
  }

  // ——— spectrograph ——————————————————————————————————————————————————————————

  private async probe(ndcX: number, ndcY: number, x: number, y: number): Promise<void> {
    const v = this.volume;
    const el = this.probeEl;
    if (!v || !el) return;
    const spec = await v.probe(this.ctx.renderer, this.camera, ndcX, ndcY);
    if (!spec) return;
    const L = spec.lines;
    const hb = L.Hb;
    const total = NEBULA_LINES.reduce((a, l) => a + L[l.id], 0);
    const cols = paletteLineColours('true');
    let html = `<div style="font:500 10px/1 var(--font-ui);letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3);margin-bottom:8px">Spectrum of this line of sight</div>`;
    if (total <= 1e-3 * (1 / Math.max(v.preset.gain, 1e-12)) * 1e-4 || hb <= 0) {
      const c = spec.continuum;
      const lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      html += lum > 0 ? `<div>Continuum only — scattered starlight</div><div style="color:var(--ink-3)">blue/red ${formatNumber(c[2] / Math.max(c[0], 1e-9), 3)}</div>` : '<div>No emission — dark sky</div>';
    } else {
      const max = Math.max(...NEBULA_LINES.map((l) => L[l.id] / hb));
      for (const l of NEBULA_LINES) {
        const r = L[l.id] / hb;
        if (r < 0.005) continue;
        const [cr, cg, cb] = cols[l.id];
        const m = Math.max(cr, cg, cb) || 1;
        const css = `rgb(${Math.round(255 * Math.pow(cr / m, 0.45))},${Math.round(255 * Math.pow(cg / m, 0.45))},${Math.round(255 * Math.pow(cb / m, 0.45))})`;
        const w = Math.max(2, Math.round(90 * Math.sqrt(r / max)));
        html += `<div style="display:flex;align-items:center;gap:8px;height:15px"><span style="width:74px;white-space:nowrap">${l.label}</span><span style="display:inline-block;height:3px;width:${w}px;background:${css};border-radius:2px"></span><span style="margin-left:auto;color:var(--ink-3)">${formatNumber(r * 100, 3)}</span></div>`;
      }
      const dec = L.Ha / hb;
      const av = avFromBalmerDecrement(dec);
      html += `<div style="margin-top:7px;border-top:1px solid var(--line);padding-top:6px;color:var(--ink-3)">I/I(Hβ) × 100 · Hα/Hβ = ${formatNumber(dec, 3)}<br>→ dust A<sub>V</sub> ≈ ${formatNumber(av, 2)} mag</div>`;
    }
    el.innerHTML = html;
    const W = this.ctx.canvas.clientWidth;
    el.style.left = `${Math.min(x + 14, W - 210)}px`;
    el.style.top = `${Math.max(8, y - 60)}px`;
    el.style.opacity = '1';
    clearTimeout((el as unknown as { _t?: number })._t);
    (el as unknown as { _t?: number })._t = window.setTimeout(() => (el.style.opacity = '0'), 6000);
  }

  // ——— frame ————————————————————————————————————————————————————————————————

  update(f: FrameInfo): void {
    const dt = f.dt;
    this.realTime += dt;
    if (this.mode === 'orbit') this.orbit.update(dt);
    else this.fly.update(dt);

    // Swap in a freshly baked nebula.
    if (this.pending) {
      const pv = this.pending.volume;
      pv.bakeStep(this.ctx.renderer, 40);
      if (pv.ready && !pv.metered) void pv.calibrate(this.ctx.renderer);
      if (pv.ready && pv.metered) {
        if (this.outgoing) {
          this.outgoing.volume.dispose();
          this.outgoing.stars.dispose();
        }
        if (this.volume && this.stars) this.outgoing = { volume: this.volume, stars: this.stars, fade: 1 };
        this.volume = pv;
        this.stars = this.pending.stars;
        const view = this.pending.view;
        this.pending = null;
        this.fadeIn = 0;
        if (view) {
          this.viewName = '';
          // Cut, rather than fly, between objects of very different sizes; the cross-fade hides it.
          this.snapView(view);
          if (this.mode === 'fly') this.setMode('orbit');
          this.orbit.minDistance = pv.preset.half * 0.01;
          this.orbit.maxDistance = pv.preset.half * 30;
          this.fly.speed = pv.preset.half * 0.2;
          this.showInfo();
        }
        this.ctx.audio.setMood('nebulae', { intensity: pv.preset.type === 'remnant' ? 0.6 : 0.4 });
      }
    }
    if (this.outgoing) {
      this.outgoing.fade -= dt / 0.35;
      if (this.outgoing.fade <= 0) {
        this.outgoing.volume.dispose();
        this.outgoing.stars.dispose();
        this.outgoing = null;
      }
    }
    const v = this.volume;
    if (!v) return;
    if (this.fadeIn < 1) this.fadeIn = Math.min(1, this.fadeIn + dt / 0.9);
    v.emission = this.outgoing ? 0 : this.fadeIn * this.fadeIn;
    if (this.playing) this.age += v.preset.timeRate * this.rateMul * dt;
    v.age = this.age;
    v.animating = this.playing || this.fadeIn < 1 || this.outgoing !== null;
    if (this.stars) {
      this.stars.brightness = v.emission;
      // Crab pulsar: the light curve integrated over this frame's exposure.
      this.stars.pulse = pulsarExposure(this.realTime, Math.max(dt, 1 / 240));
    }
    v.applyEmission();

    // Readouts.
    const p = v.preset;
    this.readAge.set(fmtYears(this.age), this.playing ? `▶ ${formatNumber(p.timeRate * this.rateMul, 3)} yr/s` : '');
    if (p.expansionKmS > 0) {
      const R = p.shellRadius * v.expansion;
      const vel = p.variant === 'veil' ? p.expansionKmS * Math.pow(Math.max(this.age, 1) / p.ageYears, -0.6) : p.expansionKmS * (R / p.shellRadius) * (p.ageYears / Math.max(this.age, 1));
      this.readSize.set(`${fmtPc(R)}`, `· ${formatNumber(vel, 3)} km/s`);
    } else {
      this.readSize.set(fmtPc(p.half * 2), 'across');
    }
    const cam = this.mode === 'orbit' ? this.orbit.position : this.fly.position;
    this.readView.set(fmtPc(cam.length()), 'from centre');
  }

  render(target: THREE.WebGLRenderTarget): void {
    const r = this.ctx.renderer;
    this.camera.aspect = target.width / target.height;
    const half = this.volume?.preset.half ?? 1;
    this.camera.near = half * 1e-4;
    this.camera.far = half * 400;
    this.camera.updateProjectionMatrix();
    if (this.mode === 'orbit') this.orbit.applyTo(this.camera);
    else this.fly.applyTo(this.camera);
    r.setRenderTarget(target);
    this.sky.render(r, this.camera, this.ctx.engine.pixelRatio);
    r.clearDepth();
    if (this.outgoing) {
      this.outgoing.volume.emission = Math.max(0, this.outgoing.fade);
      this.outgoing.volume.applyEmission();
      this.outgoing.stars.brightness = Math.max(0, this.outgoing.fade);
      this.outgoing.volume.render(r, this.camera, target);
      this.outgoing.stars.render(r, this.camera, target, this.ctx.engine.pixelRatio);
    } else {
      this.volume?.render(r, this.camera, target);
      this.stars?.render(r, this.camera, target, this.ctx.engine.pixelRatio);
    }
  }

  resize(): void {
    /* targets follow the HDR target size inside NebulaVolume */
  }

  unmount(): void {
    clearTimeout(this.seedTimer);
    for (const o of [this.volume, this.pending?.volume, this.outgoing?.volume]) o?.dispose();
    for (const s of [this.stars, this.pending?.stars, this.outgoing?.stars]) s?.dispose();
    this.volume = null;
    this.stars = null;
    this.pending = null;
    this.outgoing = null;
    this.probeEl?.remove();
    this.sky.dispose();
  }
}

export type NebulaeExperience = Nebulae;
export type { NebulaPreset };
export default () => new Nebulae();
