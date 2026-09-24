import * as THREE from 'three';
import type { Experience, ExperienceContext, FrameInfo } from '../../core/types';
import { OrbitRig } from '../../core/rigs/OrbitRig';
import { Sky } from '../../worlds/sky/Sky';
import { formatNumber } from '../../physics/units';
import { Rng } from '../../physics/random';
import { findSeed, generateSystem, SystemLayer, WorldCloseup, type SystemData, type SystemFeature } from '../../worlds/systems';
import { Portal } from './portal';
import { formatPeriod, planetCard, skySizeText, starCard } from './cards';
import { Labels } from './labels';

/**
 * Possible Worlds — procedural star systems from physics and a seed.
 *
 * Modes
 *  - 'system': the whole system in mapped AU (SystemLayer): star(s), Keplerian orbits with trails,
 *    habitable zone and snow line, enlarged planets (full planet renderer). Click a planet to fly in.
 *  - 'closeup': the planet at true scale in its own frame (WorldCloseup), star(s) at their true
 *    distance and angular size, moons. Zooming far out returns to the system seamlessly: the
 *    switch happens where the enlarged planet and the true planet subtend the same angle.
 *  - 'orbit': low orbit over the terminator, the star(s) rising over the limb; drag to move
 *    along the terminator (sunrise ↔ sunset), wheel for altitude.
 *
 * The portal ("Next world", key N) swaps in a new seed behind a swirling vortex.
 *
 * Camera: an OrbitRig whose target stays at the origin of a *focus frame*; the focus point blends
 * between bodies as they move (so flights track moving planets), and is applied as a
 * camera-relative origin.
 */

type Mode = 'system' | 'closeup' | 'orbit';

const DEFAULT_SEED = 60372;
const SURPRISES: Array<{ value: SystemFeature | 'random'; label: string }> = [
  { value: 'random', label: 'Anything' },
  { value: 'habitable', label: 'A temperate world' },
  { value: 'binary-sunset', label: 'Two suns' },
  { value: 'hot-jupiter', label: 'A hot Jupiter' },
  { value: 'ringed-giant', label: 'A ringed giant' },
  { value: 'resonant-chain', label: 'A resonant chain' },
  { value: 'eyeball', label: 'An eyeball world' },
  { value: 'giant-star', label: 'Around a red giant' },
  { value: 'white-dwarf', label: 'Around a white dwarf' },
];

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeIn = (t: number) => t * t * t;
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

interface Focus {
  from: number; // −1 = system centre, else planet index
  to: number;
  t: number;
  dur: number;
}

class PossibleWorlds implements Experience {
  private ctx!: ExperienceContext;
  private sky!: Sky;
  private rig!: OrbitRig;
  private camera = new THREE.PerspectiveCamera(42, 16 / 9, 1e-4, 100);
  private sys!: SystemData;
  private layer!: SystemLayer;
  private closeup: WorldCloseup | null = null;
  private portal = new Portal();
  private labels!: Labels;
  private mode: Mode = 'system';
  private selected = -1;
  private focus: Focus = { from: -1, to: -1, t: 1, dur: 1 };
  private origin = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private timeDays = 0;
  private rate = 1; // user multiplier on the natural rate
  private paused = false;
  private shaderTime = 0;
  private width = 1280;
  private height = 720;
  private detail = 1;
  private arriving = false;
  // Low-orbit camera.
  private orbitBeta = -0.02;
  private orbitAlt = 0.04;
  private orbitLook = { yaw: 0, pitch: 0.05 };
  // Portal state machine.
  private jump: { t: number; seed: number; swapped: boolean; freeze: number | null } | null = null;
  // UI handles.
  private seedInput: HTMLInputElement | null = null;
  private readouts: Array<{ set(v: string, u?: string): void; remove(): void }> = [];
  private planetButtons: HTMLElement | null = null;
  private viewButtons: { setActive(i: number): void } | null = null;
  private toggles = { orbits: true, zones: true, labels: true, trueScale: false };
  private trueScaleCtl: { set(v: boolean): void } | null = null;
  private surprise: SystemFeature | 'random' = 'random';
  private gammaGoal = 0.5;
  private exposureGoal = 1;

  // ——— Lifecycle ———

  mount(ctx: ExperienceContext): void {
    this.ctx = ctx;
    this.detail = ctx.quality.detail;
    ctx.post.bloomStrength = 0.045;
    ctx.post.bloomRadius = 0.7;
    ctx.post.vignette = 0.2;
    ctx.post.exposure = 1;
    this.sky = new Sky({ stars: Math.round(22000 * this.detail), milkyWay: 0.38, catalog: false, seed: 11 });
    this.rig = new OrbitRig(ctx.input, { distance: 10, yaw: 0.6, pitch: 0.38, autoRotate: 0.012, idleDelay: 8, enablePan: false, damping: 0.14 });
    this.labels = new Labels(ctx.ui.overlay, (i) => this.visit(i), () => this.showStar());
    const q = ctx.params;
    const seed = q.has('seed') ? Number(q.get('seed')) : DEFAULT_SEED;
    this.buildUI();
    this.load(seed, true);
    this.bindInput();
    ctx.audio.setMood('worlds', { intensity: 0.35 });
    ctx.ui.hint('Click a planet to visit · N next world · Space pause · Esc back', 9000);
    if (q.has('view')) this.setView(q.get('view')!);
    ctx.signalReady();
  }

  unmount(): void {
    this.closeup?.dispose();
    this.closeup = null;
    this.layer?.dispose();
    this.portal.dispose();
    this.sky.dispose();
    this.labels.dispose();
    for (const r of this.readouts) r.remove();
    this.readouts = [];
  }

  resize(w: number, h: number): void {
    this.width = w;
    this.height = h;
  }

  // ——— Systems ———

  /** Build a system from a seed (disposing the previous one). */
  private load(seed: number, initial = false): void {
    this.leaveCloseup(false);
    this.layer?.dispose();
    this.sys = generateSystem(seed);
    this.layer = new SystemLayer(this.sys, { detail: this.detail, gamma: this.toggles.trueScale ? 1 : 0.5 });
    this.layer.prepare(this.ctx.renderer);
    this.layer.setOrbitsVisible(this.toggles.orbits);
    this.layer.setZonesVisible(this.toggles.zones);
    this.gammaGoal = this.layer.compression;
    this.timeDays = new Rng(seed).range(0, 1) * this.innerPeriod() * 3;
    this.layer.setTime(this.timeDays);
    this.selected = -1;
    this.layer.setSelected(-1);
    this.focus = { from: -1, to: -1, t: 1, dur: 1 };
    this.mode = 'system';
    this.viewButtons?.setActive(0);
    // Orient the sky differently for every system (we are somewhere else in the Galaxy).
    const r = new Rng(seed * 3 + 1);
    this.skyRotation.setFromEuler(new THREE.Euler(r.range(0, Math.PI * 2), r.range(0, Math.PI * 2), r.range(0, Math.PI * 2)));
    this.frameSystem(initial ? 0 : -1);
    this.labels.build(this.sys);
    if (this.seedInput) this.seedInput.value = String(seed);
    this.rebuildPlanetList();
    if (!initial) this.ctx.ui.info(null);
    this.ctx.audio.setMood('worlds', { intensity: 0.35, teff: this.sys.star.teff, planets: this.sys.planets.length });
  }

  private skyRotation = new THREE.Quaternion();

  /** Place the camera on a pleasing overview: 3/4 elevated, whole system in frame. */
  private frameSystem(duration: number): void {
    const ext = this.layer.extent;
    this.rig.minDistance = this.layer.starRadius * 3;
    this.rig.maxDistance = Math.max(ext * 12, 1);
    const d = ext * (this.width < this.height ? 3.6 : 2.05);
    if (duration <= 0) this.rig.set({ distance: d, pitch: 0.36, yaw: this.rig.yaw });
    else this.rig.flyTo({ distance: d, pitch: 0.36 }, duration);
  }

  /** Natural clock: the innermost planet completes an orbit in ~25 s. */
  private innerPeriod(): number {
    return Math.min(...this.sys.planets.map((p) => p.periodDays), 365);
  }
  private get daysPerSecond(): number {
    if (this.mode === 'system') return (this.innerPeriod() / 25) * this.rate;
    const p = this.sys.planets[this.selected];
    const spin = p.spinOrbit === '1:1' ? p.periodDays : Math.abs(p.rotationHours) / 24;
    return (Math.min(spin, p.periodDays) / 80) * this.rate;
  }

  // ——— Navigation ———

  private focusPoint(i: number, out: THREE.Vector3): THREE.Vector3 {
    if (i < 0) return out.set(0, 0, 0);
    return out.copy(this.layer.bodies[i].pos);
  }

  private setFocus(to: number, dur: number): void {
    // Start from wherever the focus is now.
    const k = easeInOut(Math.min(1, this.focus.t / this.focus.dur));
    this.focus = { from: k > 0.5 ? this.focus.to : this.focus.from, to, t: 0, dur: Math.max(dur, 1e-3) };
  }

  /** Fly to planet i and land in the close-up. */
  visit(i: number): void {
    if (i < 0 || i >= this.sys.planets.length || this.jump) return;
    if (this.mode !== 'system') {
      if (i === this.selected) return;
      this.leaveCloseup(true);
    }
    this.select(i);
    const b = this.layer.bodies[i];
    // Approach from the day side, three-quarter phase.
    const yaw = this.dayYaw(i);
    this.setFocus(i, 2.6);
    this.arriving = true;
    this.rig.minDistance = b.displayRadius * 1.5;
    this.rig.flyTo({ distance: b.displayRadius * 5.5, yaw, pitch: 0.16 }, 2.8, () => {
      if (this.selected === i && this.mode === 'system' && this.arriving) this.enterCloseup(i);
    });
    this.ctx.audio.event('whoosh');
  }

  private select(i: number): void {
    this.selected = i;
    this.layer.setSelected(i);
    this.labels.setSelected(i);
    if (i >= 0) this.ctx.ui.info(planetCard(this.sys, this.sys.planets[i]));
    this.updateReadoutLabels();
  }

  private enterCloseup(i: number): void {
    this.arriving = false;
    const b = this.layer.bodies[i];
    const dPlanetRadii = this.rig.distance / b.displayRadius;
    this.closeup = new WorldCloseup(this.layer, i, this.ctx.renderer, this.detail);
    this.closeup.sync();
    this.mode = 'closeup';
    this.viewButtons?.setActive(1);
    this.rig.minDistance = 1.08;
    this.rig.maxDistance = 60;
    this.rig.set({ distance: dPlanetRadii });
    this.rig.flyTo({ distance: this.closeDistance(i), pitch: this.bigStar(i) ? -0.2 : this.rig.pitch }, 1.6);
    this.labels.setVisible(false);
    this.updateReadoutLabels();
  }

  /** Back to the system view at the same place (the planet stays in focus). */
  private leaveCloseup(keepFocus: boolean): void {
    if (!this.closeup) return;
    const i = this.selected;
    const b = this.layer.bodies[i];
    const d = (this.mode === 'orbit' ? 4 : this.rig.distance) * b.displayRadius;
    this.closeup.dispose();
    this.closeup = null;
    this.mode = 'system';
    this.viewButtons?.setActive(0);
    this.rig.enabled = true;
    this.rig.minDistance = b.displayRadius * 1.5;
    this.rig.maxDistance = Math.max(this.layer.extent * 12, 1);
    if (keepFocus) {
      this.focus = { from: i, to: i, t: 1, dur: 1 };
      this.rig.set({ distance: d });
    }
    this.labels.setVisible(this.toggles.labels);
    this.updateReadoutLabels();
  }

  /** Return to the whole-system overview. */
  back(): void {
    if (this.jump) return;
    if (this.mode === 'orbit') {
      this.setView('closeup');
      return;
    }
    if (this.mode === 'closeup') this.leaveCloseup(true);
    this.arriving = false;
    this.setFocus(-1, 2.4);
    this.frameSystem(2.6);
    this.rig.minDistance = this.layer.starRadius * 3;
    this.labels.setSelected(-1);
    this.layer.setSelected(-1);
    this.selected = -1;
    this.ctx.ui.info(starCard(this.sys));
    this.updateReadoutLabels();
  }

  private showStar(): void {
    if (this.mode !== 'system') return;
    this.ctx.ui.info(starCard(this.sys));
    this.setFocus(-1, 2);
    this.rig.flyTo({ distance: this.layer.starRadius * 9 }, 2.4);
  }

  // ——— Views (debug hooks + UI) ———

  /** 'system' | 'closeup' | 'orbit' | 'star' | 'edge-on' | 'top' */
  setView(name: string): void {
    const pick = () => (this.selected >= 0 ? this.selected : this.showcasePlanet());
    switch (name) {
      case 'system':
        this.back();
        break;
      case 'top':
        if (this.mode !== 'system') this.back();
        this.rig.flyTo({ pitch: 1.45 }, 2);
        break;
      case 'edge-on':
        if (this.mode !== 'system') this.back();
        this.rig.flyTo({ pitch: 0.03 }, 2);
        break;
      case 'star':
        if (this.mode !== 'system') this.back();
        this.showStar();
        break;
      case 'closeup': {
        const i = pick();
        if (this.mode === 'orbit') {
          this.mode = 'closeup';
          this.rig.enabled = true;
          this.viewButtons?.setActive(1);
          this.updateReadoutLabels();
          return;
        }
        if (this.mode === 'closeup' && i === this.selected && this.closeup) return;
        if (this.mode === 'closeup') this.leaveCloseup(false);
        this.select(i);
        this.focus = { from: i, to: i, t: 1, dur: 1 };
        this.rig.set({ distance: this.layer.bodies[i].displayRadius * 5.5, yaw: this.dayYaw(i), pitch: 0.16 });
        this.enterCloseup(i);
        this.rig.set({ distance: this.closeDistance(i), pitch: this.bigStar(i) ? -0.2 : 0.16 });
        break;
      }
      case 'orbit': {
        if (this.mode === 'system') this.setView('closeup');
        this.mode = 'orbit';
        this.rig.enabled = false;
        this.orbitBeta = -0.02;
        this.orbitAlt = 0.04;
        this.orbitLook = { yaw: 0, pitch: 0.05 };
        this.viewButtons?.setActive(2);
        this.updateReadoutLabels();
        break;
      }
    }
  }

  /**
   * Camera azimuth for arriving at planet i: a three-quarter phase by default; the sub-stellar
   * "pupil" for eyeball worlds; and a crescent beside the star when the star looms large (> 4°).
   */
  private dayYaw(i: number): number {
    const b = this.layer.bodies[i];
    const p = b.data;
    const toStar = this.tmp.copy(this.layer.starPos).sub(b.pos).normalize();
    const base = Math.atan2(toStar.x, toStar.z);
    if (p.eyeball) return base + 0.55;
    if (this.bigStar(i)) return base + Math.PI + 0.5;
    return base + 1.25;
  }

  /** Angular diameter of the primary seen from planet i, degrees. */
  private starDegrees(i: number): number {
    return (2 * Math.asin(Math.min(1, (this.sys.star.radius * 0.00465047) / this.sys.planets[i].orbit.a)) * 180) / Math.PI;
  }
  private bigStar(i: number): boolean {
    return this.starDegrees(i) > 4 && !this.sys.planets[i].eyeball;
  }
  /** Close-up framing distance (planet radii): rings need room; a looming star shares the frame. */
  private closeDistance(i: number): number {
    const p = this.sys.planets[i];
    if (this.bigStar(i)) return 6.5;
    return p.spec.rings ? 3.4 * Math.max(1.5, p.spec.rings.outer * 0.75) : 3.4;
  }

  /** The most interesting planet: habitable > eyeball > ringed > largest. */
  private showcasePlanet(): number {
    const ps = this.sys.planets;
    const score = (p: (typeof ps)[number]) =>
      (p.hz === 'habitable zone' && (p.kind === 'terrestrial' || p.kind === 'ocean') ? 100 : 0) + (p.eyeball ? 50 : 0) + (p.spec.rings ? 40 : 0) + (p.atmosphere ? 10 : 0) + Math.log(p.radius + 1);
    let best = 0;
    ps.forEach((p, i) => {
      if (score(p) > score(ps[best])) best = i;
    });
    return best;
  }

  /** Jump through the portal to a new seed (random, or matching the current "surprise" filter). */
  next(seed?: number): void {
    if (this.jump) return;
    let s = seed;
    if (s === undefined) {
      const start = (Math.random() * 4e9) >>> 0;
      s = this.surprise === 'random' ? start % 1_000_000 : findSeed(this.surprise, start % 1_000_000);
    }
    this.jump = { t: 0, seed: s, swapped: false, freeze: null };
    this.ctx.audio.event('portal');
    this.ctx.ui.info(null);
  }

  /** Debug: hold the portal at a phase (0..1 of the whole transition). */
  portalFreeze(progress: number): void {
    if (!this.jump) this.next(this.sys.seed + 1);
    this.jump!.freeze = progress * PORTAL_TOTAL;
  }

  /** Debug/UI: jump straight to planet i ('closeup' or 'orbit' view), no flight. */
  planet(i: number, view: 'closeup' | 'orbit' = 'closeup'): void {
    if (!(i >= 0 && i < this.sys.planets.length)) return;
    if (this.mode !== 'system') this.leaveCloseup(false);
    this.selected = i;
    this.mode = 'system';
    this.setView('closeup');
    if (view === 'orbit') this.setView('orbit');
  }

  setSeed(seed: number): void {
    this.load(seed);
  }
  preset(feature: string): void {
    this.load(findSeed(feature as SystemFeature, 1));
  }
  setTime(days: number): void {
    this.timeDays = days;
  }
  get system(): SystemData {
    return this.sys;
  }

  // ——— Frame ———

  update(f: FrameInfo): void {
    const dt = f.dt;
    this.shaderTime += dt;
    // Portal.
    if (this.jump) this.updatePortal(dt);
    if (!this.paused && !this.jump) this.timeDays += dt * this.daysPerSecond;
    // Animated distance compression.
    const g = this.layer.compression;
    if (Math.abs(g - this.gammaGoal) > 1e-4) {
      const ng = g + (this.gammaGoal - g) * (1 - Math.exp(-dt / 0.35));
      this.layer.setCompression(Math.abs(ng - this.gammaGoal) < 2e-3 ? this.gammaGoal : ng);
      if (this.mode === 'system' && this.focus.to < 0) this.rig.goal.logDistance = Math.log(this.layer.extent * 2.7);
    }
    this.layer.setTime(this.timeDays);
    this.rig.update(dt);
    this.focus.t = Math.min(this.focus.t + dt, this.focus.dur);
    // Exposure eases toward the goal (the close-up of a bright ice world vs a dark hot Jupiter).
    this.ctx.post.exposure += (this.exposureGoal - this.ctx.post.exposure) * (1 - Math.exp(-dt / 0.5));

    if (this.mode === 'system') {
      const k = easeInOut(this.focus.t / this.focus.dur);
      this.focusPoint(this.focus.from, this.tmp);
      this.focusPoint(this.focus.to, this.tmp2);
      this.origin.lerpVectors(this.tmp, this.tmp2, k).negate();
      this.rig.applyTo(this.camera, this.origin);
      this.layer.update(this.camera, this.ctx.renderer, this.shaderTime);
      // Hover highlight (desktop).
      const ptr = this.ctx.input.pointer;
      this.layer.setHovered(this.layer.pick(ptr.x, ptr.y, this.camera, this.cssW, this.cssH, 10));
      this.exposureGoal = 1;
    } else if (this.closeup) {
      this.closeup.sync();
      if (this.mode === 'orbit') this.applyOrbitCamera();
      else {
        this.rig.applyTo(this.camera);
        // Zoomed far out: hand back to the system view (seamless — same angle, same direction).
        if (!this.rig.animating && this.rig.distance > 40) {
          this.leaveCloseup(true);
          return;
        }
      }
      this.closeup.update(this.camera, this.ctx.renderer, this.shaderTime);
      const p = this.sys.planets[this.selected];
      this.exposureGoal = p.kind === 'gas-giant' && (p.sudarsky === 'IV' || p.sudarsky === 'III') ? 2.2 : p.kind === 'ice' || p.kind === 'venus' ? 0.7 : 0.85;
    }
    if (--this.cardCheck <= 0) {
      this.cardCheck = 10;
      const card = document.querySelector('.info-card') as HTMLElement | null;
      this.cardOpen = !!card && !card.hidden && !document.querySelector('.ui.is-hidden');
    }
    this.updateReadouts();
    this.labels.update(this.layer, this.camera, this.cssW, this.cssH, this.mode === 'system' && !this.jump);
  }

  private get cssW(): number {
    return this.ctx.canvas.clientWidth || this.width;
  }
  private get cssH(): number {
    return this.ctx.canvas.clientHeight || this.height;
  }

  /** Low orbit above the terminator, looking along the surface toward the star. */
  private oc = { w: new THREE.Vector3(), up: new THREE.Vector3(), pos: new THREE.Vector3(), fwd: new THREE.Vector3(), right: new THREE.Vector3(), look: new THREE.Vector3(), m: new THREE.Matrix4() };
  private applyOrbitCamera(): void {
    const c = this.closeup!;
    const o = this.oc;
    const s = c.starDirection(this.tmp);
    // A horizontal direction perpendicular to the star: the terminator great circle's tangent.
    const axis = this.tmp2.set(0, 1, 0);
    if (Math.abs(s.dot(axis)) > 0.95) axis.set(1, 0, 0);
    const t = axis.cross(s).normalize(); // ⊥ s
    const w = o.w.crossVectors(s, t);
    // Camera over the terminator; β > 0 moves it toward the night side (the star sinks).
    const beta = this.orbitBeta;
    const up = o.up.copy(w).multiplyScalar(Math.cos(beta)).addScaledVector(s, -Math.sin(beta)).normalize();
    const pos = o.pos.copy(up).multiplyScalar(1 + this.orbitAlt);
    // Look toward the star's azimuth, pitched so the limb sits in the lower third.
    const fwd = o.fwd.copy(s).addScaledVector(up, -s.dot(up)).normalize();
    const right = o.right.crossVectors(fwd, up).normalize();
    fwd.applyAxisAngle(up, this.orbitLook.yaw);
    right.applyAxisAngle(up, this.orbitLook.yaw);
    const dip = Math.acos(1 / (1 + this.orbitAlt));
    fwd.applyAxisAngle(right, -dip * 0.8 + this.orbitLook.pitch);
    o.m.lookAt(pos, o.look.copy(pos).add(fwd), up);
    this.camera.position.copy(pos);
    this.camera.quaternion.setFromRotationMatrix(o.m);
    this.camera.updateMatrixWorld();
  }

  private updatePortal(dt: number): void {
    const j = this.jump!;
    if (j.freeze !== null) j.t = j.freeze;
    else j.t += dt;
    const t = j.t;
    // Phase A: the vortex opens over the old system while we lean in.
    this.portal.outer = t < OPEN ? 1.25 * easeIn(Math.min(1, t / OPEN)) : 1.25;
    this.portal.inner = t < OPEN + HOLD ? 0 : 1.3 * easeOut(Math.min(1, (t - OPEN - HOLD) / REVEAL));
    if (t < OPEN) this.rig.zoom(-dt * 0.5);
    if (!j.swapped && t >= OPEN) {
      j.swapped = true;
      this.load(j.seed);
      // Arrive a little close and drift out as the iris opens.
      this.rig.set({ distance: this.rig.distance * 0.55 });
      this.frameSystem(REVEAL + HOLD + 0.8);
      this.ctx.ui.info(null);
      this.ctx.ui.toast(`${this.sys.catalogue} · ${this.sys.name}`, 3200);
    }
    if (j.freeze === null && t >= PORTAL_TOTAL) {
      this.jump = null;
      this.portal.outer = 0;
      this.portal.inner = 0;
      this.ctx.ui.info(starCard(this.sys));
    }
  }

  render(target: THREE.WebGLRenderTarget): void {
    const r = this.ctx.renderer;
    this.camera.aspect = target.width / Math.max(1, target.height);
    this.camera.fov = this.mode === 'orbit' ? 60 : 42;
    r.setRenderTarget(target);
    // Sky at infinity: rotation only, with this system's orientation.
    const saved = this.camera.quaternion.clone();
    this.camera.quaternion.premultiply(this.skyRotation);
    this.camera.near = 0.1;
    this.camera.far = 10;
    const pos = this.camera.position.clone();
    this.camera.position.set(0, 0, 0);
    this.camera.updateMatrixWorld();
    this.camera.updateProjectionMatrix();
    this.sky.render(r, this.camera, this.ctx.engine.pixelRatio);
    this.camera.quaternion.copy(saved);
    this.camera.position.copy(pos);
    this.camera.updateMatrixWorld();
    r.clearDepth();
    // Keep the subject clear of the info card (desktop): shift the projection centre right.
    const shift = this.mode !== 'system' && this.cardOpen && target.width > 1.2 * target.height ? 0.13 : 0;
    this.frameShift += (shift - this.frameShift) * 0.08;
    if (Math.abs(this.frameShift) > 1e-4) this.camera.setViewOffset(target.width, target.height, -this.frameShift * target.width, 0, target.width, target.height);
    else this.camera.clearViewOffset();
    if (this.mode === 'system') this.layer.render(r, this.camera);
    else this.closeup?.render(r, this.camera);
    this.portal.render(r, target, this.shaderTime, 1.4);
    this.camera.clearViewOffset();
  }

  private frameShift = 0;
  private cardCheck = 0;
  private cardOpen = false;

  // ——— Input ———

  private bindInput(): void {
    const inp = this.ctx.input;
    inp.onTap((e) => {
      if (this.jump) return;
      if (this.mode === 'system') {
        const i = this.layer.pick(e.x, e.y, this.camera, this.cssW, this.cssH, 18);
        if (i >= 0) this.visit(i);
      }
    });
    inp.onDoubleTap(() => {
      if (this.mode !== 'system') this.back();
    });
    inp.onDrag((e) => {
      if (this.mode !== 'orbit') return;
      this.orbitLook.yaw -= e.dx * 0.003;
      this.orbitLook.pitch = THREE.MathUtils.clamp(this.orbitLook.pitch + e.dy * 0.003, -0.6, 0.9);
      if (e.shift || e.pointers > 1) this.orbitBeta = THREE.MathUtils.clamp(this.orbitBeta + e.dx * 0.0005, -0.3, 0.3);
    });
    inp.onWheel((e) => {
      if (this.mode !== 'orbit') return;
      this.orbitAlt = THREE.MathUtils.clamp(this.orbitAlt * Math.exp(e.delta * 0.15), 0.004, 0.6);
    });
    inp.onKeyDown((e) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT')) return;
      if (e.code === 'KeyN') this.next();
      else if (e.code === 'Space') {
        this.paused = !this.paused;
        this.ctx.ui.toast(this.paused ? 'Paused' : 'Running');
        e.preventDefault();
      } else if (e.code === 'Escape' || e.code === 'Backspace') this.back();
      else if (e.code === 'BracketRight') this.visit((this.selected + 1) % this.sys.planets.length);
      else if (e.code === 'BracketLeft') this.visit((this.selected - 1 + this.sys.planets.length) % this.sys.planets.length);
      else if (e.code === 'KeyO') this.setView(this.mode === 'orbit' ? 'closeup' : 'orbit');
      else if (e.code === 'KeyT') this.setTrueScale(!this.toggles.trueScale);
      else if (this.mode === 'orbit' && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) this.orbitBeta += e.code === 'ArrowLeft' ? 0.01 : -0.01;
    });
  }

  // ——— UI ———

  private buildUI(): void {
    const ui = this.ctx.ui;
    // Corner: seed + next world.
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;align-items:center;gap:10px;pointer-events:auto;font:400 12px var(--font-ui);color:var(--ink-2)';
    const lab = document.createElement('span');
    lab.textContent = 'Seed';
    lab.style.cssText = 'letter-spacing:.12em;text-transform:uppercase;font-size:10px;color:var(--ink-3)';
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'numeric';
    input.setAttribute('aria-label', 'Seed');
    input.style.cssText = 'width:76px;background:transparent;border:0;border-bottom:1px solid var(--line-strong);color:var(--ink);font:400 13px var(--font-mono);font-variant-numeric:tabular-nums;padding:3px 0;outline:none';
    input.addEventListener('change', () => {
      const v = Math.floor(Math.abs(Number(input.value.replace(/[^0-9]/g, ''))));
      if (isFinite(v)) this.next(v);
      input.blur();
    });
    input.addEventListener('keydown', (e) => e.stopPropagation());
    this.seedInput = input;
    const go = document.createElement('button');
    go.className = 'btn';
    go.innerHTML = '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#8dff9e;box-shadow:0 0 8px #5dff7a;margin-right:8px;vertical-align:1px"></span>Next world';
    go.addEventListener('click', () => this.next());
    bar.append(lab, input, go);
    ui.corner(bar);

    // Panel.
    const w = ui.section('Possible Worlds');
    w.text('Every seed is a star system built from physics: a star from the initial mass function, planets spaced for stability, climates from starlight.');
    w.select({ label: 'Surprise me', value: 'random', options: SURPRISES, onChange: (v) => (this.surprise = v as SystemFeature | 'random') });
    w.buttons([{ label: 'Next world', onClick: () => this.next() }, { label: 'Star', onClick: () => this.setView('star') }]);

    const v = ui.section('View');
    this.viewButtons = v.buttons(
      [
        { label: 'System', onClick: () => this.setView('system') },
        { label: 'Planet', onClick: () => this.setView('closeup') },
        { label: 'Low orbit', onClick: () => this.setView('orbit') },
      ],
      0,
    );
    v.toggle({ label: 'Orbits', value: true, onChange: (x) => { this.toggles.orbits = x; this.layer.setOrbitsVisible(x); } });
    v.toggle({ label: 'Habitable zone · snow line', value: true, onChange: (x) => { this.toggles.zones = x; this.layer.setZonesVisible(x); } });
    v.toggle({ label: 'Labels', value: true, onChange: (x) => { this.toggles.labels = x; this.labels.setVisible(x && this.mode === 'system'); } });
    this.trueScaleCtl = v.toggle({ label: 'True distances', value: false, onChange: (x) => this.setTrueScale(x, false) });
    v.slider({ label: 'Time rate', min: 0.02, max: 50, log: true, value: 1, unit: '×', onChange: (x) => (this.rate = x) });
    v.text('System view: planets and stars enlarged, distances compressed (r^½) unless “True distances” is on; brightness ∝ flux^¼. Planet and low-orbit views are to scale: stars at their true angular size and colour, planet light white-balanced 40% toward neutral as an eye would, and very large stellar disks drawn dimmer so their surface stays visible.');
    const keys = ui.section('Keys');
    keys.text('N next world · [ ] previous / next planet · O low orbit · T true distances · Space pause · Esc back. In low orbit: drag to look, Shift-drag (or two fingers) to move along the terminator, scroll for altitude.');

    const pl = ui.section('Planets');
    this.planetButtons = pl.custom(document.createElement('div'));

    this.readouts = [ui.readout('System'), ui.readout('Star'), ui.readout('Time'), ui.readout('Rate')];
  }

  private setTrueScale(on: boolean, syncCtl = true): void {
    this.toggles.trueScale = on;
    this.gammaGoal = on ? 1 : 0.5;
    if (syncCtl) this.trueScaleCtl?.set(on);
    if (this.mode === 'system' && this.focus.to < 0) this.rig.flyTo({ distance: Math.pow(this.layer.extent, this.gammaGoal / this.layer.compression) * 2.7 }, 1.2);
  }

  private rebuildPlanetList(): void {
    const box = this.planetButtons;
    if (!box) return;
    box.innerHTML = '';
    box.style.cssText = 'display:flex;flex-direction:column;gap:2px';
    this.sys.planets.forEach((p, i) => {
      const b = document.createElement('button');
      b.className = 'btn';
      b.style.cssText = 'display:flex;justify-content:space-between;gap:12px;text-align:left;width:100%';
      const hz = p.hz === 'habitable zone' ? ' style="color:#7fe3b4"' : '';
      b.innerHTML = `<span><span style="font-family:var(--font-mono);color:var(--ink-3)">${p.letter}</span>&nbsp; ${p.givenName}</span><span${hz} style="color:var(--ink-3);font-size:11px">${kindWord(p.kind, p.class)}</span>`;
      if (hz) (b.lastElementChild as HTMLElement).style.color = '#7fe3b4';
      b.addEventListener('click', () => this.visit(i));
      box.appendChild(b);
    });
  }

  private updateReadoutLabels(): void {
    // Labels are fixed; values change per mode (see updateReadouts).
  }

  private updateReadouts(): void {
    const [sysR, starR, timeR, rateR] = this.readouts;
    if (!sysR) return;
    const s = this.sys;
    if (this.mode === 'system' || this.selected < 0) {
      sysR.set(`${s.catalogue} · ${s.name}`, '');
      starR.set(s.star.spectralType + (s.companion ? ` + ${s.companion.star.spectralType}` : ''), `${formatNumber(Math.round(s.star.teff), 4)} K`);
    } else {
      const p = s.planets[this.selected];
      sysR.set(`${p.designation} · ${p.givenName}`, '');
      starR.set(skySizeText(s, p), 'in the sky');
    }
    const yrs = this.timeDays / 365.25;
    timeR.set(this.timeDays < 800 ? formatNumber(this.timeDays, 4) : formatNumber(yrs, 4), this.timeDays < 800 ? 'd' : 'yr');
    const dps = this.daysPerSecond;
    rateR.set(this.paused ? 'paused' : formatPeriod(dps).replace(' ', ' '), this.paused ? '' : 'per second');
  }
}

const OPEN = 1.1;
const HOLD = 0.7;
const REVEAL = 1.4;
const PORTAL_TOTAL = OPEN + HOLD + REVEAL;

function kindWord(kind: string, cls: string): string {
  if (cls === 'sub-neptune') return 'sub-Neptune';
  if (cls === 'super-earth') return 'super-Earth';
  return (
    {
      'gas-giant': 'gas giant',
      'ice-giant': 'ice giant',
      terrestrial: 'temperate',
      ocean: 'ocean',
      desert: 'desert',
      lava: 'lava',
      ice: 'ice',
      barren: 'airless',
      venus: 'greenhouse',
    } as Record<string, string>
  )[kind] ?? kind;
}

export default () => new PossibleWorlds();
