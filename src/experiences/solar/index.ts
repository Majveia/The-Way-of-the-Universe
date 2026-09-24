/**
 * Solar System — our home system on real ephemerides.
 *
 * Planets from Standish's JPL elements, the Moon from ELP-2000/82, 30 moons from mean elements
 * fitted to JPL Horizons, comets / asteroids / dwarf planets from the JPL Small-Body Database,
 * Voyager, Pioneer and New Horizons from Horizons state vectors; ~120 000 small bodies on
 * GPU Kepler orbits with Kirkwood gaps, Hildas, Trojans and the resonant Kuiper belt.
 * Starts at the present moment; time runs from real time to a century per second, both ways.
 */
import * as THREE from 'three';
import type { Experience, ExperienceContext, FrameInfo } from '../../core/types';
import { Sky } from '../../worlds/sky/Sky';
import { SolarSystemModel, type SolarBody } from '../../worlds/solar/SolarSystemModel';
import { SolarSystemLayer, type SolarLayerSettings } from '../../worlds/solar/render/SolarSystemLayer';
import { DAY_S, JD_MAX, JD_MIN, WARP_STEPS, dateToJD, utcToTT } from '../../worlds/solar/time';
import { formatDistance } from '../../physics/units';
import { AU } from '../../physics/constants';
import type { Readout } from '../../ui/UI';
import type { Control } from '../../ui/Panel';
import { SolarCamera } from './camera';
import { TimeBar, type TimeState } from './TimeBar';
import { EVENTS, VIEWS, type ViewPreset, type ViewTarget } from './views';
import { formatAU, formatLightTime, infoCard } from './info';

const DEFAULT_WARP = WARP_STEPS.findIndex((w) => w.label === '1 day / s');

class SolarExperience implements Experience {
  private ctx!: ExperienceContext;
  private sky!: Sky;
  private model!: SolarSystemModel;
  private layer!: SolarSystemLayer;
  private cam!: SolarCamera;
  private time!: TimeBar;
  private timeState: TimeState = { step: DEFAULT_WARP, paused: false, reverse: false };
  /** Master clock: UTC Julian date. */
  private jdUTC = 2461306.5;
  /** True while the clock tracks the real present (1× forward from Now). */
  private live = false;
  private selected: SolarBody | null = null;
  private exposure = 1;
  /** Jump straight to the metered exposure on the next frame (after an instant cut). */
  private snapExposure = true;
  private readouts: Record<string, Readout> = {};
  private readoutTimer = 0;
  private infoTimer = 0;
  private infoOpen = false;
  private skyBase = 1;
  private ready = false;
  private frames = 0;
  private toggles: Partial<Record<keyof SolarLayerSettings, Control<boolean>>> = {};
  private eccSlider: Control<number> | null = null;
  private enlargeSlider: Control<number> | null = null;
  private scaleSelect: Control<'true' | 'enlarged'> | null = null;
  private viewButtons: { setActive(i: number): void } | null = null;
  private goSelect: Control<string> | null = null;
  private eccAnim: { from: number; to: number; t: number } | null = null;
  private resonance: Array<{ el: HTMLElement; a: number; label: string }> = [];
  private resonanceRoot: HTMLElement | null = null;
  private tmpV = new THREE.Vector3();
  private tmp2 = new THREE.Vector2();
  private tmpP = new THREE.Vector3();
  private skyCam = new THREE.PerspectiveCamera(50, 1, 0.1, 10);

  mount(ctx: ExperienceContext): void {
    this.ctx = ctx;
    ctx.progress(0.05, 'Solar System');
    const q = ctx.quality;
    ctx.post.tonemap = 'agx';
    ctx.post.bloomStrength = 0.075;
    ctx.post.bloomRadius = 0.85;
    ctx.post.vignette = 0.18;
    ctx.post.saturation = 1.05;
    ctx.post.exposure = 1;

    this.sky = new Sky({ frame: 'ecliptic', stars: Math.round(26000 * q.detail), milkyWay: 0.9, brightness: 1, constellations: 0 });
    this.model = new SolarSystemModel();
    ctx.progress(0.3, 'Ephemerides');
    this.layer = new SolarSystemLayer(ctx.renderer, this.model, {
      quality: q,
      overlay: ctx.ui.overlay,
      onLabelPick: (id) => this.selectById(id, true),
    });
    ctx.progress(0.7, 'Small bodies');
    this.layer.setSize(ctx.engine.width, ctx.engine.height, ctx.engine.pixelRatio);
    this.cam = new SolarCamera(ctx.input);

    // Clock: the present (the page's own clock, UTC).
    this.jdUTC = THREE.MathUtils.clamp(dateToJD(new Date()), JD_MIN, JD_MAX);
    this.model.update(utcToTT(this.jdUTC));

    this.buildUI();
    this.bindInput();
    ctx.audio.setMood('solar', { intensity: 0.32 });

    // Default composition: the inner system, today.
    this.applyView(VIEWS[0], true);
    const touch = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
    ctx.ui.hint(
      touch
        ? 'Drag to orbit · Pinch to zoom · Tap a world to fly there · Double-tap to follow'
        : 'Drag to orbit · Scroll to zoom · Click a world to fly there · Double-click to follow · Space pauses · [ ] time warp · 0–9 planets',
      9000,
    );
    // Expose debug hooks through the experience object (window.__universe.experience).
    ctx.progress(1);
    void this.sky.ready.then(() => (this.ready = true));
    window.setTimeout(() => (this.ready = true), 4000);
  }

  // ————————————————————————————————————————— UI
  private buildUI(): void {
    const ui = this.ctx.ui;
    this.readouts.focus = ui.readout('Focus', '');
    this.readouts.sun = ui.readout('From the Sun', '');
    this.readouts.light = ui.readout('Light-time', '');
    this.readouts.view = ui.readout('Camera', '');

    this.time = new TimeBar(this.timeState, {
      changed: () => {
        this.live = false;
      },
      now: () => this.goNow(),
    });
    ui.overlay.appendChild(this.time.style);
    ui.corner(this.time.el);

    const views = ui.section('Views');
    this.viewButtons = views.buttons(
      VIEWS.map((v) => ({ label: v.label, onClick: () => this.applyView(v) })),
      0,
    );
    const ids = this.model.bodies;
    const opts = [{ value: '', label: 'Choose…' }].concat(
      ids
        .filter((b) => b.def.priority <= 4)
        .map((b) => ({ value: b.id, label: b.def.kind === 'moon' ? `${b.def.name} (${b.parent?.def.name})` : b.def.name })),
    );
    this.goSelect = views.select({ label: 'Go to', value: '', options: opts, onChange: (id) => id && this.selectById(id, true) });

    const events = ui.section('Moments');
    events.buttons(
      [{ label: 'Now', onClick: () => this.goNow() }].concat(EVENTS.map((e) => ({ label: e.label, onClick: () => this.applyView(e) }))),
    );

    const show = ui.section('Show');
    const tog = (key: keyof SolarLayerSettings, label: string, help?: string) => {
      this.toggles[key] = show.toggle({
        label,
        value: this.layer.settings[key] as boolean,
        help,
        onChange: (v) => {
          (this.layer.settings as unknown as Record<string, unknown>)[key] = v;
        },
      });
    };
    tog('orbits', 'Orbits');
    tog('labels', 'Labels');
    tog('moons', 'Moons');
    tog('asteroids', 'Asteroid belt');
    tog('kuiper', 'Kuiper belt');
    tog('comets', 'Comets');
    tog('spacecraft', 'Spacecraft');
    tog('oort', 'Oort cloud (from afar)', 'A hypothesised reservoir of comets 2 000 – 100 000 AU out; never observed directly');

    const scale = ui.section('Scale');
    this.scaleSelect = scale.select({
      label: 'Bodies',
      value: 'true',
      options: [
        { value: 'true', label: 'True scale' },
        { value: 'enlarged', label: 'Enlarged' },
      ],
      onChange: (v) => {
        this.layer.settings.scaleMode = v;
        this.enlargeSlider?.setDisabled(v === 'true');
        this.ctx.ui.toast(v === 'true' ? 'True scale: planets are points of light from afar' : `Planets drawn ×${Math.round(this.layer.settings.enlarge)}, Sun ×10 — the focused system stays true to scale`);
      },
    });
    this.enlargeSlider = scale.slider({
      label: 'Enlargement',
      min: 10,
      max: 3000,
      log: true,
      value: this.layer.settings.enlarge,
      format: (v) => `×${Math.round(v)}`,
      onChange: (v) => (this.layer.settings.enlarge = v),
    });
    this.enlargeSlider.setDisabled(true);
    scale.text('At true scale the planets are specks: Earth is 1/23 000 of an AU across. Enlarged bodies are labelled ×N; the system you fly to returns to true scale.');

    const belt = ui.section('Asteroid belt');
    this.eccSlider = belt.slider({
      label: 'Eccentricity',
      min: 0,
      max: 1,
      value: 1,
      format: (v) => `${Math.round(v * 100)} %`,
      onChange: (v) => {
        this.eccAnim = null;
        this.layer.settings.beltEccentricity = v;
      },
    });
    belt.text('Slide to 0 % to place every asteroid at its mean distance: the Kirkwood gaps appear where an asteroid would orbit 3, 5/2, 7/3 or 2 times per Jupiter year.');

    // Resonance markers (DOM labels at the resonance radii, shown when the gaps are revealed).
    this.resonanceRoot = document.createElement('div');
    this.resonanceRoot.className = 'solar-resonances';
    ui.overlay.appendChild(this.resonanceRoot);
    for (const [label, a] of [['3:1', 2.5], ['5:2', 2.824], ['7:3', 2.957], ['2:1', 3.278], ['3:2 Hildas', 3.97]] as Array<[string, number]>) {
      const el = document.createElement('div');
      el.className = 'solar-ann';
      el.textContent = label;
      el.style.opacity = '0';
      this.resonanceRoot.appendChild(el);
      this.resonance.push({ el, a, label });
    }
  }

  private bindInput(): void {
    const input = this.ctx.input;
    input.onTap((e) => {
      const b = this.layer.pick(e.x, e.y);
      if (b) this.select(b, true);
    });
    input.onDoubleTap((e) => {
      const b = this.layer.pick(e.x, e.y) ?? this.selected;
      if (!b) return;
      if (this.selected !== b) this.select(b, true);
      this.cam.follow = !this.cam.follow;
      this.ctx.ui.toast(this.cam.follow ? `Following ${b.def.name} — the view turns with its orbit` : 'Inertial view — fixed against the stars');
    });
    input.onKeyDown((e) => {
      if (e.repeat) return;
      switch (e.code) {
        case 'Space':
          e.preventDefault();
          this.time.togglePause();
          break;
        case 'BracketRight':
        case 'Period':
          this.time.faster();
          break;
        case 'BracketLeft':
        case 'Comma':
          this.time.slower();
          break;
        case 'KeyR':
          this.time.toggleReverse();
          break;
        case 'KeyN':
          this.goNow();
          break;
        case 'KeyO':
          this.setSetting('orbits', !this.layer.settings.orbits);
          break;
        case 'KeyL':
          this.setSetting('labels', !this.layer.settings.labels);
          break;
        case 'KeyF':
          this.cam.follow = !this.cam.follow;
          this.ctx.ui.toast(this.cam.follow ? 'Following — the view turns with the orbit' : 'Inertial view');
          break;
        case 'KeyB':
        case 'Home':
          this.applyView(VIEWS[0]);
          break;
        default: {
          const m = /^Digit(\d)$/.exec(e.code);
          if (m) {
            const ids = ['sun', 'mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto'];
            this.selectById(ids[Number(m[1])], true);
          }
        }
      }
    });
  }

  private setSetting(key: keyof SolarLayerSettings, v: boolean): void {
    (this.layer.settings as unknown as Record<string, unknown>)[key] = v;
    this.toggles[key]?.set(v);
  }

  // ————————————————————————————————————————— navigation
  private selectById(id: string, fly: boolean): void {
    const b = this.model.get(id);
    if (b) this.select(b, fly);
  }

  /** Framing distance that makes the body (and its rings / moons) sit comfortably in view. */
  private frameDistance(b: SolarBody): number {
    const R = b.radius; // the focused system is shown at true scale
    const k = b.def.kind;
    if (k === 'star') return R * 7;
    if (k === 'spacecraft') return 0.05;
    if (k === 'comet') return b.sunDistance < 5 ? 0.25 : R * 60;
    if (b.def.planet?.rings) return R * 8.5;
    if (k === 'planet') return R * 5.2;
    return R * 6;
  }

  select(b: SolarBody, fly: boolean): void {
    this.selected = b;
    this.layer.selected = b;
    this.layer.focus = b;
    this.cam.follow = false;
    this.infoOpen = true;
    this.ctx.ui.info(infoCard(this.model, b));
    this.infoTimer = 0;
    this.goSelect?.set('');
    this.viewButtons?.setActive(-1);
    if (fly) {
      const d = this.frameDistance(b);
      this.cam.rig.minDistance = Math.max(1e-12, b.radius * 1.12);
      // Approach from the day side, a little above the orbital plane.
      this.tmpV.copy(b.position).negate();
      const yaw = Math.atan2(this.tmpV.x, this.tmpV.z) + 0.7;
      this.cam.flyTo(b, { distance: d, yaw, pitch: 0.28 });
    }
    this.ctx.audio.setMood('solar', { intensity: b.def.kind === 'star' ? 0.55 : 0.35, body: b.id });
  }

  private applyView(v: ViewPreset, instant = false): void {
    this.cam.follow = false;
    if (v.jdUTC !== undefined) {
      this.jdUTC = v.jdUTC;
      this.live = false;
      this.model.update(utcToTT(this.jdUTC));
    }
    if (v.warp !== undefined) this.timeState.step = v.warp;
    if (v.paused !== undefined) this.timeState.paused = v.paused;
    else if (v.jdUTC !== undefined) this.timeState.paused = false;
    this.timeState.reverse = false;
    this.time?.sync();
    if (v.settings) {
      for (const [k, val] of Object.entries(v.settings)) {
        if (k === 'beltEccentricity') {
          this.eccAnim = { from: this.layer.settings.beltEccentricity, to: val as number, t: 0 };
          continue;
        }
        (this.layer.settings as unknown as Record<string, unknown>)[k] = val;
        this.toggles[k as keyof SolarLayerSettings]?.set(val as boolean);
      }
    }
    const t: ViewTarget = v.view(this.model);
    // Portrait screens: pull back so what was composed for landscape still fits the width.
    const aspect = this.ctx.engine.width / Math.max(1, this.ctx.engine.height);
    if (aspect < 1.2 && !t.target) t.distance *= Math.pow(1.2 / aspect, 0.8);
    const body = this.model.get(t.focus)!;
    this.selected = t.focus === 'sun' ? null : body;
    this.layer.selected = this.selected;
    this.layer.focus = body;
    this.cam.rig.minDistance = Math.max(1e-12, body.radius * 1.12);
    this.targetFov = t.fov ?? 50;
    if (instant) {
      this.cam.set(body, { distance: t.distance, yaw: t.yaw, pitch: t.pitch, target: t.target });
      this.cam.fov = this.targetFov;
      this.layer.snapLabels();
      this.snapExposure = true;
    } else this.cam.flyTo(body, { distance: t.distance, yaw: t.yaw, pitch: t.pitch, target: t.target });
    const i = VIEWS.indexOf(v);
    this.viewButtons?.setActive(i);
    if (this.selected && !instant) {
      this.ctx.ui.info(infoCard(this.model, this.selected));
      this.infoOpen = true;
    } else if (!this.selected) {
      this.ctx.ui.info(null);
      this.infoOpen = false;
    }
    if (v.caption && !instant) this.ctx.ui.toast(v.caption, 5200);
  }
  private targetFov = 50;

  private goNow(): void {
    this.jdUTC = dateToJD(new Date());
    this.timeState.step = 0;
    this.timeState.paused = false;
    this.timeState.reverse = false;
    this.time.sync();
    this.live = true;
    this.ctx.ui.toast('Now — real time');
  }

  // ————————————————————————————————————————— frame
  update(f: FrameInfo): void {
    const dt = f.dt;
    this.frames++;
    // Clock.
    const rate = this.time.rate;
    if (this.live && rate === 1 && !this.ctx.engine.shotMode) this.jdUTC = dateToJD(new Date());
    else this.jdUTC += (rate * dt) / DAY_S;
    if (this.jdUTC < JD_MIN || this.jdUTC > JD_MAX) {
      this.jdUTC = THREE.MathUtils.clamp(this.jdUTC, JD_MIN, JD_MAX);
      this.timeState.paused = true;
      this.time.sync();
      this.ctx.ui.toast('The ephemerides are valid from 3000 BC to AD 3000');
    }
    if (rate !== 1 || this.timeState.reverse) this.live = false;
    const jdTT = utcToTT(this.jdUTC);

    // Belt eccentricity animation (Kirkwood reveal).
    const s = this.layer.settings;
    if (this.eccAnim) {
      const a = this.eccAnim;
      a.t = Math.min(1, a.t + dt / 2.4);
      const e = a.t * a.t * (3 - 2 * a.t);
      s.beltEccentricity = a.from + (a.to - a.from) * e;
      this.eccSlider?.set(s.beltEccentricity);
      if (a.t >= 1) this.eccAnim = null;
    }

    this.model.update(jdTT);
    this.cam.fov += (this.targetFov - this.cam.fov) * (1 - Math.exp(-dt / 0.6));
    this.cam.update(dt);
    // Keep the camera outside the focused body.
    this.layer.exposure = this.exposure;
    this.layer.setCamera(this.cam.position, this.cam.quaternion, this.cam.fov);
    this.layer.update(jdTT, f.time, dt);
    this.updateExposure(dt);
    this.layer.updateLabels(dt);
    this.updateResonanceLabels();
    this.time.show(this.jdUTC, this.live);
    this.readoutTimer -= dt;
    if (this.readoutTimer <= 0) {
      this.readoutTimer = 0.2;
      this.updateReadouts();
    }
    // Refresh the info card occasionally so distances stay live.
    this.infoTimer += dt;
    if (this.infoOpen && this.selected && this.infoTimer > 1.5 && Math.abs(rate) > 0) {
      this.infoTimer = 0;
      if (!document.querySelector('.info-card[hidden]')) this.ctx.ui.info(infoCard(this.model, this.selected));
      else this.infoOpen = false;
    }
    if (this.ready && this.frames > 2) this.ctx.signalReady();
  }

  /** Camera-like auto exposure: expose for the subject, so the dim outer worlds stay readable. */
  private updateExposure(dt: number): void {
    const focus = this.layer.focus ?? this.model.sun;
    const camSun = this.cam.position.length();
    let target: number;
    const sunR = this.model.sun.radius;
    if (focus.def.kind === 'star' || camSun < sunR * 40) {
      const d = Math.max(camSun / sunR, 1);
      // The photosphere's disc-centre radiance is ~40 (createStar): meter so the centre sits just past
      // white and the limb darkening, granulation and faculae read.
      target = THREE.MathUtils.clamp(0.045 * Math.pow(d / 6, 0.9), 0.04, 1);
    } else {
      // Expose for the subject: fully compensate the 1/r² sunlight when a resolved body fills the
      // view (a camera metering on Saturn), partially for overviews so distance still reads as dimming.
      const r = Math.max(0.3, focus.sunDistance);
      const close = 1 - THREE.MathUtils.smoothstep(this.cam.position.distanceTo(focus.position) / Math.max(focus.radius, 1e-12), 30, 400);
      target = Math.pow(this.layer.sunIntensity(r), -(0.75 + 0.25 * close));
    }
    target = THREE.MathUtils.clamp(target, 0.015, 30);
    const k = this.snapExposure || dt <= 0 ? 1 : 1 - Math.exp(-dt / 0.8);
    this.snapExposure = false;
    this.exposure = this.exposure * Math.exp((Math.log(target) - Math.log(this.exposure)) * k);
    this.ctx.post.exposure = this.exposure;
    // The star field keeps its display brightness (as a long exposure would), so divide it back out.
    this.sky.exposure = this.skyBase / this.exposure;
  }

  private updateResonanceLabels(): void {
    const s = this.layer.settings;
    const show = s.asteroids ? 1 - THREE.MathUtils.smoothstep(s.beltEccentricity, 0.05, 0.4) : 0;
    const camDist = this.cam.position.length();
    const scaleOk = THREE.MathUtils.smoothstep(camDist, 3, 6) * (1 - THREE.MathUtils.smoothstep(camDist, 60, 120));
    // Each label sits on its own resonance circle, fanned out in angle about the camera's right so
    // the closely spaced radii (2.50, 2.82, 2.96, 3.28 AU) never collide on screen.
    const right = this.tmpV.set(1, 0, 0).applyQuaternion(this.cam.quaternion);
    right.y = 0;
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    right.normalize();
    const base = Math.atan2(right.x, right.z);
    for (let i = 0; i < this.resonance.length; i++) {
      const r = this.resonance[i];
      const o = show * scaleOk;
      if (o < 0.01) {
        if (r.el.style.opacity !== '0') r.el.style.opacity = '0';
        continue;
      }
      const ang = base + (i - (this.resonance.length - 1) / 2) * 0.2;
      const p = this.tmpP.set(Math.sin(ang) * r.a, 0, Math.cos(ang) * r.a);
      if (this.layer.projectPoint(p, this.tmp2)) {
        r.el.style.transform = `translate3d(${(this.tmp2.x + 4).toFixed(1)}px, ${(this.tmp2.y - 5).toFixed(1)}px, 0)`;
        r.el.style.opacity = (o * 0.9).toFixed(2);
      } else r.el.style.opacity = '0';
    }
  }

  private updateReadouts(): void {
    const focus = this.layer.focus ?? this.model.sun;
    const ro = this.readouts;
    ro.focus.set(focus.def.name);
    if (focus.def.kind === 'star') {
      ro.sun.set('—', '');
      ro.light.set('—', '');
    } else {
      const [v, u] = formatAU(focus.sunDistance).split(' ');
      ro.sun.set(v, u ?? '');
      ro.light.set(formatLightTime(focus.sunDistance), '');
    }
    const camD = this.cam.position.distanceTo(focus.position);
    const fd = formatDistance(Math.max(0, camD - focus.radius) * AU, 3);
    ro.view.set(fd.value, `${fd.unit} away`);
  }

  render(target: THREE.WebGLRenderTarget): void {
    const r = this.ctx.renderer;
    r.setRenderTarget(target);
    // Sky at infinity: rotation only.
    this.skyCam.fov = this.cam.fov;
    this.skyCam.aspect = target.width / Math.max(1, target.height);
    this.skyCam.updateProjectionMatrix();
    this.skyCam.position.set(0, 0, 0);
    this.skyCam.quaternion.copy(this.cam.quaternion);
    this.skyCam.updateMatrixWorld();
    this.sky.cssHeight = this.ctx.engine.cssHeight;
    this.sky.render(r, this.skyCam, this.ctx.engine.pixelRatio);
    r.clearDepth();
    this.layer.render(target);
  }

  resize(w: number, h: number): void {
    this.layer?.setSize(w, h, this.ctx.engine.pixelRatio);
  }

  unmount(): void {
    this.layer?.dispose();
    this.sky?.dispose();
    this.resonanceRoot?.remove();
  }

  // ————————————————————————————————————————— debug hooks (window.__universe.experience)
  /** Switch to a named view ('inner', 'outer', 'trojans', 'saturn', 'jupiter', 'earth', 'kuiper', 'pluto', 'sun', 'voyager') or event id. */
  setView(id: string, instant = true): boolean {
    const v = VIEWS.find((x) => x.id === id) ?? EVENTS.find((x) => x.id === id);
    if (!v) return false;
    this.applyView(v, instant);
    if (instant && v.settings?.beltEccentricity !== undefined) {
      this.eccAnim = null;
      this.layer.settings.beltEccentricity = v.settings.beltEccentricity;
      this.eccSlider?.set(v.settings.beltEccentricity);
    }
    return true;
  }
  /** Set the clock: a Julian date (UTC) or an ISO date string. */
  setTime(t: number | string): void {
    this.jdUTC = typeof t === 'number' ? t : dateToJD(new Date(t));
    this.live = false;
  }
  setWarp(step: number, paused = false): void {
    this.timeState.step = THREE.MathUtils.clamp(step, 0, WARP_STEPS.length - 1);
    this.timeState.paused = paused;
    this.time.sync();
  }
  focusOn(id: string, instant = true, distance?: number): void {
    const b = this.model.get(id);
    if (!b) return;
    this.select(b, !instant);
    if (instant) {
      this.cam.set(b, { distance: distance ?? this.frameDistance(b), yaw: Math.atan2(-b.position.x, -b.position.z) + 0.7, pitch: 0.28 });
      this.layer.snapLabels();
      this.snapExposure = true;
    }
  }
  set(key: keyof SolarLayerSettings, value: unknown): void {
    (this.layer.settings as unknown as Record<string, unknown>)[key] = value;
  }
  orbitCamera(yaw: number, pitch: number, distance?: number): void {
    this.cam.rig.set({ yaw, pitch, distance });
  }
  get state() {
    return {
      jdUTC: this.jdUTC,
      focus: this.layer.focus?.id,
      camera: this.cam.position.toArray(),
      distance: this.cam.rig.distance,
      exposure: this.exposure,
      settings: { ...this.layer.settings },
    };
  }
}

export default () => new SolarExperience();
