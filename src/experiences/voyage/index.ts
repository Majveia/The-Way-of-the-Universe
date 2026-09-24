import * as THREE from 'three';
import type { Experience, ExperienceContext, FrameInfo } from '../../core/types';
import type { Readout } from '../../ui/UI';
import type { Control } from '../../ui/Panel';
import { FlyRig } from '../../core/rigs/FlyRig';
import { Sky, type ApparentStar } from '../../worlds/sky/Sky';
import { loadStarCatalog, equatorialToGalacticThree, type StarCatalog } from '../../worlds/sky/catalog';
import { NearStars, type NearStarView } from '../../worlds/sky/NearStars';
import { AU_PC, R_SUN_PC, estimateRadius, tangentBasis, visualOrbitOffset } from '../../worlds/sky/stellar';
import { Ship, SkyProbe } from '../../worlds/ship/Ship';
import { ShipCamera, type ShipView } from '../../worlds/ship/ShipCamera';
import { StarshipFlight, describeWarp, TIME } from '../../worlds/ship/flight';
import { C_PC_PER_YEAR, aberrateDirection, gammaOf, logBlackbodyLuminance } from '../../physics/voyage-relativity';
import { formatNumber, formatDuration, formatScientific } from '../../physics/units';
import { YEAR } from '../../physics/constants';
import { DESTINATIONS, STAR_OVERRIDES, type Destination } from './targets';
import { Hud, type LabelItem } from './hud';
import { WarpField } from './warp';

/**
 * STARFLIGHT — Voyage phase 1.
 * Fly the Ship of the Imagination through the real solar neighbourhood (HYG catalogue in 3D) at
 * relativistic speeds. Everything you see follows special relativity for a moving observer:
 * aberration, Doppler colour, beaming, time dilation (ship vs Earth clocks), constant-proper-
 * acceleration flight with a flip-and-burn autopilot. The "imagination drive" is the one labelled
 * exception: faster-than-light travel for distant stars, without relativistic effects.
 */
type Drive = 'sublight' | 'imagination';

const LY_PC = 1 / 3.2615637771674337;
const NOW_YEAR = 2026.73; // 2026 Sep 23
const J2000 = 2000.0;
/** Reference pixel angle (rad) for converting star flux to illuminance on the hull (≈ 60° / 1047 px). */
const P_REF = 1e-3;
const NEAR_PC = 0.05;
/** Starting distance from the Sun (AU): well past the heliopause, where the Sun is a −13.7 mag star. */
const DEPART_AU = 420;

interface NearEntry {
  index: number;
  /** Heliocentric position (pc), world frame. */
  pos: THREE.Vector3;
  radiusRsun: number;
  temperature: number;
  absMag: number;
  name: string;
}

interface Light {
  dir: THREE.Vector3;
  illum: number;
  temperature: number;
}

class Voyage implements Experience {
  private ctx!: ExperienceContext;
  private cat!: StarCatalog;
  private sky!: Sky;
  private near!: NearStars;
  private ship!: Ship;
  private probe!: SkyProbe;
  private flight = new StarshipFlight();
  private rig!: FlyRig;
  private shipCam!: ShipCamera;
  private warp!: WarpField;
  private hud!: Hud;
  private shipScene = new THREE.Scene();
  private skyCam = new THREE.PerspectiveCamera(55, 1, 0.1, 10);
  private drive: Drive = 'sublight';
  private view: ShipView | 'sky' = 'chase';
  private relOn = true;
  private relFlags = { aberration: true, doppler: true, beaming: true };
  private targetIdx = 1;
  private customTarget: Destination | null = null;
  private exposure = 1;
  private exposureTarget = 1;
  private labelsOn = true;
  private constellationsOn = false;
  private deepTime = 0;
  private time = 0;
  private imaginationSpeed = 0;
  private imaginationPrev = new THREE.Vector3();
  private arrivedTurn = 0;
  private skyLook = { yaw: 0, pitch: 0, frame: new THREE.Quaternion() };
  private width = 1;
  private height = 1;
  // Scratch (no per-frame allocation).
  private beta = new THREE.Vector3();
  private app: ApparentStar = { dir: new THREE.Vector3(), restDir: new THREE.Vector3(), distance: 0, mag: 0, temperature: 0, delta: 1 };
  private nearList: NearEntry[] = [];
  private nearViews: NearStarView[] = [];
  private lights: Light[] = [];
  private lightPool: Light[] = [];
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private tmpQ = new THREE.Quaternion();
  private keyColor = new THREE.Color();
  private fillColor = new THREE.Color();
  private labelItems: LabelItem[] = [];
  private labelPool: LabelItem[] = [];
  private targetLabel: LabelItem = { dir: new THREE.Vector3(), text: '', priority: 0 };
  private namedBright: number[] = [];
  private nearScanFrame = 0;
  // UI
  private ro!: { speed: Readout; gamma: Readout; ship: Readout; earth: Readout; dist: Readout };
  private flightEl!: HTMLElement;
  private flightParts!: { name: HTMLElement; phase: HTMLElement; bar: HTMLElement; eta: HTMLElement; tag: HTMLElement };
  private ctl: Partial<{
    target: Control<string>;
    drive: Control<string>;
    rel: Control<boolean>;
    ab: Control<boolean>;
    dop: Control<boolean>;
    beam: Control<boolean>;
    speed: Control<number>;
    warp: Control<string>;
    deep: Control<number>;
    cons: Control<boolean>;
    labels: Control<boolean>;
  }> = {};
  private viewButtons!: { setActive(i: number): void };
  private warpManual = TIME.DAY_YR * 7;
  /** Default framing: Sun azimuth/elevation from the nose (deg, +az = starboard), chase camera offsets (rad). */
  departureSun = { az: 100, el: 20, camYaw: 0.4, camPitch: 0 };
  /** Seconds until the default departure lights the drive (0 = off). */
  private autoEngage = 0;

  async mount(ctx: ExperienceContext): Promise<void> {
    this.ctx = ctx;
    ctx.progress(0.1, 'Charting 11 600 stars');
    this.cat = await loadStarCatalog();
    ctx.progress(0.5, 'Building the ship');
    const q = ctx.quality;
    this.sky = new Sky({ catalog: this.cat, stars: Math.round(26000 * q.detail), milkyWay: 1, constellations: 0 });
    this.sky.minStarDistance = 1e-9;
    for (const [name, o] of Object.entries(STAR_OVERRIDES)) {
      const i = this.cat.find(name);
      if (i >= 0 && o.teff) this.sky.overrideStar(i, { temperature: o.teff });
    }
    this.near = new NearStars();
    this.ship = new Ship({ detail: Math.max(0.55, Math.min(1.3, q.detail)), shadowSize: q.detail >= 1 ? 2048 : 1024 });
    this.ship.plume.steps = q.detail >= 1 ? 32 : q.detail >= 0.7 ? 24 : 20;
    this.probe = new SkyProbe(q.detail >= 1 ? 128 : 64, ctx.engine.halfFloat);
    this.ship.setEnvironment(this.probe, 1);
    this.shipScene.add(this.ship.group);
    this.warp = new WarpField(Math.round(2600 * Math.max(0.5, q.detail)));
    this.shipScene.add(this.warp.object);
    this.shipCam = new ShipCamera(ctx.input, 55);
    this.rig = new FlyRig(ctx.input, { lookSpeed: 0.0028, lookDamping: 0.12, translation: false, rollSpeed: 0.9, gamepad: true });
    this.rig.speed = 1;
    this.hud = new Hud(ctx.ui.overlay);
    for (let i = 0; i < 40; i++) this.labelPool.push({ dir: new THREE.Vector3(), text: '', priority: 0 });
    // Named bright stars for labels (apparent from the Sun; refined per frame from the observer).
    this.namedBright = this.cat.namedIndices.filter((i) => this.cat.mag[i] < 2.6 || this.cat.distance[i] < 5.5).slice(0, 160);

    this.flight.onArrive = () => this.onArrive();
    this.buildUI();
    this.bindInput();
    this.preset('departure');
    ctx.post.bloomStrength = 0.075;
    ctx.post.bloomRadius = 0.85;
    ctx.post.vignette = 0.18;
    ctx.post.tonemap = 'aces';
    ctx.audio.setMood('voyage', { intensity: 0.3, speed: 0 });
    await this.sky.ready;
    ctx.progress(1);
    ctx.signalReady();
  }

  // ——— Destinations ———

  private get dest(): Destination {
    return this.customTarget ?? DESTINATIONS[this.targetIdx];
  }

  /** World position (pc) of a destination's centre (barycentre for binaries), at Earth time t. */
  private destCenter(d: Destination, out: THREE.Vector3): THREE.Vector3 {
    const i = this.findStar(d.star);
    this.starPos(i, out);
    if (d.companion) {
      // The catalogue gives the primary; shift to the barycentre using the visual orbit.
      const rel = this.companionOffset(d, i, this.relScratch);
      out.addScaledVector(rel, d.companion.orbit.q);
    }
    return out;
  }
  private relScratch = new THREE.Vector3();
  private baryScratch = new THREE.Vector3();

  /** Heliocentric position (pc, world) of catalogue star i at the current epoch. */
  private starPos(i: number, out: THREE.Vector3): THREE.Vector3 {
    const c = this.cat;
    const t = this.epochYears();
    return out.set(c.position[i * 3] + c.velocity[i * 3] * t, c.position[i * 3 + 1] + c.velocity[i * 3 + 1] * t, c.position[i * 3 + 2] + c.velocity[i * 3 + 2] * t);
  }

  /** Secondary − primary offset (pc, world) of a destination's visual binary. */
  private companionOffset(d: Destination, primary: number, out: THREE.Vector3): THREE.Vector3 {
    const o = d.companion!.orbit;
    const [n, e, r] = visualOrbitOffset(o, NOW_YEAR + this.flight.t);
    const b = tangentBasis(this.cat.ra[primary], this.cat.dec[primary], equatorialToGalacticThree);
    return out.set(0, 0, 0).addScaledVector(b.north, n * AU_PC).addScaledVector(b.east, e * AU_PC).addScaledVector(b.los, r * AU_PC);
  }

  private epochYears(): number {
    return NOW_YEAR - J2000 + this.flight.t + this.deepTime;
  }

  private arrivalPoint(d: Destination, out: THREE.Vector3): { center: THREE.Vector3; arrive: number } {
    const center = this.destCenter(d, out);
    return { center, arrive: d.standoffAU * AU_PC };
  }

  setTarget(id: string, silent = false): void {
    const i = DESTINATIONS.findIndex((d) => d.id === id);
    if (i >= 0) {
      this.targetIdx = i;
      this.customTarget = null;
      this.ctl.target?.set(id);
      if (!silent) this.showInfo();
    }
  }

  private selectStar(index: number): void {
    const known = DESTINATIONS.findIndex((d) => this.cat.find(d.star) === index);
    if (known >= 0) {
      this.setTarget(DESTINATIONS[known].id);
      return;
    }
    const inf = this.cat.info(index);
    const T = this.sky.starProps(index).temperature;
    const R = estimateRadius(this.cat.absMag[index], T);
    const dist = this.cat.distance[index] / LY_PC;
    this.customTarget = {
      id: `hyg-${index}`,
      name: inf.name,
      star: inf.proper || inf.designation || inf.name,
      kicker: `${inf.spect || 'Star'} · ${formatNumber(dist, 3)} ly from the Sun`,
      standoffAU: Math.max(0.03, R * 0.0465 * 60),
      facts: [
        ['Designation', inf.designation || '—'],
        ['Spectral type', inf.spect || '—'],
        ['Temperature', `${formatNumber(T, 3)} K (from B−V)`],
        ['Brightness from Earth', `V = ${this.cat.mag[index].toFixed(2)}`],
      ],
      body: 'Any star in the catalogue can be a destination. Press Enter to set course.',
    };
    // Make find() resolve for custom stars without a name.
    if (this.cat.find(this.customTarget.star) !== index) this.customTarget.star = `#${index}`;
    this.ctl.target?.set('custom');
    this.showInfo();
  }

  private findStar(q: string): number {
    if (q.startsWith('#')) return Number(q.slice(1));
    return this.cat.find(q);
  }

  engage(): void {
    const d = this.dest;
    const idx = this.findStar(d.star);
    if (idx < 0) return;
    const { center, arrive } = this.arrivalPoint(d, _v2);
    if (this.flight.position.distanceTo(center) < arrive * 1.05) {
      this.ctx.ui.toast(`Already at ${d.name}`);
      return;
    }
    this.arrivedTurn = 0;
    if (this.drive === 'imagination') {
      this.flight.halt();
      this.rig.position.copy(this.flight.position);
      this.rig.quaternion.copy(this.flight.quaternion);
      this.rig.velocity.set(0, 0, 0);
      const dist = this.flight.position.distanceTo(center);
      this.rig.travelTo({ position: center, arriveDistance: arrive }, { profile: 'log', duration: THREE.MathUtils.clamp(5 + 1.6 * Math.log10(dist / arrive), 7, 16), orient: true, onArrive: () => this.onArrive() });
      this.imaginationPrev.copy(this.flight.position);
      this.ctx.audio.event('warp');
      this.ctx.ui.toast(`Imagination drive · ${d.name}`);
    } else {
      this.flight.engage(center, { arrive, cruiseSeconds: 22 });
      this.ctx.audio.event('engage');
      this.ctx.ui.toast(`Course set · ${d.name}`);
    }
  }

  stop(): void {
    if (this.rig.traveling) {
      this.rig.cancelTravel();
      this.flight.position.copy(this.rig.position);
      this.imaginationSpeed = 0;
    }
    this.flight.disengage();
    this.flight.manualBeta = 0;
    this.ctl.speed?.set(0);
  }

  private onArrive(): void {
    this.arrivedTurn = 4.5;
    this.flight.manualBeta = null;
    this.ctl.speed?.set(0);
    this.ctx.audio.event('arrive');
    this.ctx.ui.toast(`Arrived · ${this.dest.name}`);
    this.showInfo();
  }

  // ——— Presets and views (also debug hooks) ———

  preset(name: string): void {
    const f = this.flight;
    f.halt();
    this.autoEngage = 0;
    f.tau = 0;
    f.t = 0;
    this.rig.cancelTravel();
    this.imaginationSpeed = 0;
    this.arrivedTurn = 0;
    const acen = this.cat.find('Rigil Kentaurus');
    const toAcen = this.starPos(acen, _v1).normalize();
    if (name === 'departure' || name === 'default') {
      // 420 AU out (far beyond the heliopause), nose toward α Centauri. The Sun — now a −16 mag star —
      // stands behind the camera's shoulder, raking light across the hull; the camera sits off the
      // starboard quarter so the ship reads in three-quarter view against the southern Milky Way.
      this.setTarget('alpha-cen', true);
      this.drive = 'sublight';
      const upG = _v3.set(0, 1, 0);
      const right = _v4.crossVectors(toAcen, upG).normalize();
      const up = _v6.crossVectors(right, toAcen).normalize();
      const az = THREE.MathUtils.degToRad(this.departureSun.az), el = THREE.MathUtils.degToRad(this.departureSun.el);
      const sunDir = _v5.copy(toAcen).multiplyScalar(Math.cos(el) * Math.cos(az)).addScaledVector(right, Math.cos(el) * Math.sin(az)).addScaledVector(up, Math.sin(el)).normalize();
      f.position.copy(sunDir).multiplyScalar(-DEPART_AU * AU_PC);
      this.faceDirection(toAcen);
      this.setView('chase');
      this.shipCam.distance = 34;
      this.shipCam.yawBias = this.departureSun.camYaw;
      this.shipCam.pitchBias = this.departureSun.camPitch;
      // A moment of stillness, then the drive lights and the ship sets out for α Centauri at 1 g.
      this.autoEngage = 2.2;
    } else if (name === 'relativistic' || name === '0.9c') {
      // Coasting at 0.9 c toward α Centauri, a light-year out.
      this.setTarget('alpha-cen', true);
      this.drive = 'sublight';
      f.position.copy(toAcen).multiplyScalar(0.3);
      this.faceDirection(toAcen);
      f.u.copy(toAcen).multiplyScalar(0.9 / Math.sqrt(1 - 0.81));
      f.manualBeta = 0.9;
      this.ctl.speed?.set(0.9);
      f.warp = TIME.DAY_YR * 2;
      this.setView('cockpit');
    } else if (name === 'approach' || name === 'alpha-cen') {
      // Braking into α Centauri: 0.004 ly out, engine firing toward the two suns.
      this.setTarget('alpha-cen', true);
      this.drive = 'sublight';
      const { center, arrive } = this.arrivalPoint(this.dest, _v2);
      const from = _v3.copy(center).normalize();
      f.position.copy(center).addScaledVector(from, -(arrive + 0.0016));
      this.faceDirection(from);
      f.engage(center, { arrive, cruiseSeconds: 22 });
      // Start in the braking phase at the matching speed.
      const s = 0.0016;
      const a = f.alpha * 0.95;
      const phi = Math.acosh(1 + (a * s) / C_PC_PER_YEAR);
      f.u.copy(from).multiplyScalar(Math.sinh(phi));
      f.quaternion.copy(this.lookQuat(_v4.copy(from).negate()));
      f.phase = 'brake';
      this.setView('chase');
      this.shipCam.distance = 42;
    } else if (name === 'earth' || name === 'home-sky') {
      // The night sky from Earth: constellations and names, celestial north up.
      this.setTarget('sun', true);
      f.position.set(0, 0, 0);
      this.setView('sky');
      const ncp = equatorialToGalacticThree(0, 0, 1, _v3).normalize();
      this.skyLook.frame.setFromUnitVectors(_v4.set(0, 1, 0), ncp);
      this.setConstellations(true);
      this.lookSkyAt('Alnilam', -8);
    } else if (name === 'arrived-acen') {
      this.setTarget('alpha-cen', true);
      const { center, arrive } = this.arrivalPoint(this.dest, _v2);
      const from = _v3.copy(center).normalize();
      f.position.copy(center).addScaledVector(from, -arrive);
      this.faceDirection(from);
      this.setView('chase');
    }
    if (name !== 'departure' && name !== 'default') this.shipCam.yawBias = this.shipCam.pitchBias = 0;
    this.shipCam.snap();
    this.syncRigToFlight();
    this.ctl.drive?.set(this.drive);
  }

  private lookQuat(dir: THREE.Vector3): THREE.Quaternion {
    const m = _m.lookAt(_zero, dir, _v6.set(0, 1, 0));
    return this.tmpQ.setFromRotationMatrix(m);
  }
  private faceDirection(dir: THREE.Vector3): void {
    this.flight.quaternion.copy(this.lookQuat(dir));
  }
  private syncRigToFlight(): void {
    this.rig.position.copy(this.flight.position);
    this.rig.quaternion.copy(this.flight.quaternion);
  }

  setView(v: ShipView | 'sky'): void {
    this.view = v;
    if (v !== 'sky') this.shipCam.mode = v;
    this.ship.group.visible = v !== 'sky';
    this.ship.cockpit = v === 'cockpit';
    // Planetarium view: a dark-adapted naked eye resolves ~1.45× broader, brighter star images than a
    // camera at the same field of view (the eye's PSF + scattering halo).
    this.sky.starSize = v === 'sky' ? 1.45 : 1;
    this.sky.brightness = v === 'sky' ? 2 : 1;
    this.viewButtons?.setActive(['chase', 'cockpit', 'orbit', 'sky'].indexOf(v));
    this.shipCam.snap();
  }

  private lookSkyAt(name: string, pitchOffsetDeg = 0): void {
    const i = this.cat.find(name);
    if (i < 0) return;
    const d = this.starPos(i, _v1).sub(this.flight.position).normalize();
    // Express in the sky-look frame.
    const inv = _q1.copy(this.skyLook.frame).invert();
    d.applyQuaternion(inv);
    this.skyLook.yaw = Math.atan2(-d.x, -d.z);
    this.skyLook.pitch = Math.asin(THREE.MathUtils.clamp(d.y, -1, 1)) + THREE.MathUtils.degToRad(pitchOffsetDeg);
  }

  /** Debug: set the ship coasting at β along its nose. */
  setBeta(b: number): void {
    const fwd = this.flight.forward(_v1);
    this.flight.u.copy(fwd).multiplyScalar(b / Math.sqrt(1 - b * b));
    this.flight.manualBeta = b;
    this.ctl.speed?.set(b);
  }
  setDrive(d: Drive): void {
    this.drive = d;
    this.ctl.drive?.set(d);
  }
  setConstellations(on: boolean): void {
    this.constellationsOn = on;
    this.ctl.cons?.set(on);
  }
  setLabels(on: boolean): void {
    this.labelsOn = on;
    this.hud.labelsOn = on;
    this.ctl.labels?.set(on);
  }
  setRelativity(on: boolean): void {
    this.relOn = on;
    this.ctl.rel?.set(on);
  }
  /** Debug: advance the simulation by n frames of dt without rendering. */
  advance(seconds: number, dt = 1 / 60): void {
    for (let t = 0; t < seconds; t += dt) this.step(dt);
  }

  // ——— UI ———

  private buildUI(): void {
    const ui = this.ctx.ui;
    this.ro = {
      speed: ui.readout('Speed', 'c'),
      gamma: ui.readout('Lorentz γ'),
      ship: ui.readout('Ship clock', 'yr'),
      earth: ui.readout('Earth date'),
      dist: ui.readout('To target', 'ly'),
    };
    // Flight status (bottom-right).
    const el = document.createElement('div');
    el.className = 'vy-flight';
    el.innerHTML = `<div class="vy-fl-name"></div><div class="vy-fl-phase"></div><div class="vy-fl-bar"><i></i></div><div class="vy-fl-eta"></div><div class="vy-fl-tag"></div>`;
    this.flightEl = ui.corner(el);
    this.flightParts = {
      name: el.querySelector('.vy-fl-name') as HTMLElement,
      phase: el.querySelector('.vy-fl-phase') as HTMLElement,
      bar: el.querySelector('.vy-fl-bar i') as HTMLElement,
      eta: el.querySelector('.vy-fl-eta') as HTMLElement,
      tag: el.querySelector('.vy-fl-tag') as HTMLElement,
    };

    const s1 = ui.section('Destination');
    const opts = DESTINATIONS.map((d) => ({ value: d.id, label: d.name }));
    this.ctl.target = s1.select<string>({
      label: 'Star',
      value: this.dest.id,
      options: [...opts, { value: 'custom', label: 'Selected star' }],
      onChange: (v) => (v === 'custom' ? undefined : this.setTarget(v)),
    });
    s1.buttons(
      [
        { label: 'Engage', onClick: () => this.engage() },
        { label: 'Stop', onClick: () => this.stop() },
        { label: 'Home', onClick: () => { this.setTarget('sun'); this.engage(); } },
      ],
      undefined,
    );
    this.ctl.drive = s1.select<string>({
      label: 'Drive',
      value: this.drive,
      options: [
        { value: 'sublight', label: 'Sub-light · 1 g · ≤ 0.999 c' },
        { value: 'imagination', label: 'Imagination (faster than light)' },
      ],
      onChange: (v) => (this.drive = v as Drive),
    });
    s1.slider({ label: 'Acceleration', min: 0.1, max: 20, log: true, value: 1, unit: 'g', format: (v) => (v < 1 ? v.toFixed(2) : v.toFixed(1)), onChange: (v) => (this.flight.accelG = v) });
    s1.text('Sub-light: constant proper acceleration, flip at the midpoint, brake to a stop. Ship and Earth clocks drift apart — time dilation. The imagination drive is not physics: it ignores the speed of light to reach distant stars.');

    const s2 = ui.section('Relativity');
    this.ctl.rel = s2.toggle({ label: 'Special relativity', value: true, onChange: (v) => (this.relOn = v) });
    this.ctl.ab = s2.toggle({ label: 'Aberration', value: true, onChange: (v) => (this.relFlags.aberration = v) });
    this.ctl.dop = s2.toggle({ label: 'Doppler colour shift', value: true, onChange: (v) => (this.relFlags.doppler = v) });
    this.ctl.beam = s2.toggle({ label: 'Beaming (brightness)', value: true, onChange: (v) => (this.relFlags.beaming = v) });
    this.ctl.speed = s2.slider({
      label: 'Cruise speed',
      min: 0,
      max: 0.999,
      value: 0,
      step: 0.001,
      unit: 'c',
      format: (v) => v.toFixed(3),
      onChange: (v) => {
        if (this.flight.autopilot) this.flight.disengage();
        this.flight.manualBeta = v;
        if (this.drive === 'imagination') this.setDrive('sublight');
      },
    });
    s2.text('Ahead, starlight crowds together and shifts blue; behind, it thins and reddens. Beyond γ ≈ 1000 even the 2.7 K cosmic microwave background would glow visibly ahead.');

    const s3 = ui.section('View');
    this.viewButtons = s3.buttons(
      [
        { label: 'Chase', onClick: () => this.setView('chase') },
        { label: 'Cockpit', onClick: () => this.setView('cockpit') },
        { label: 'Orbit', onClick: () => this.setView('orbit') },
        { label: 'Sky', onClick: () => this.setView('sky') },
      ],
      0,
    );
    this.ctl.cons = s3.toggle({ label: 'Constellations', value: false, onChange: (v) => (this.constellationsOn = v) });
    this.ctl.labels = s3.toggle({ label: 'Star names', value: true, onChange: (v) => this.setLabels(v) });
    s3.slider({ label: 'Field of view', min: 20, max: 100, value: 55, unit: '°', format: (v) => v.toFixed(0), onChange: (v) => { this.shipCam.camera.fov = v; } });

    const s4 = ui.section('Time');
    const warps: Array<[string, number]> = [
      ['real', 1 / (365.25 * 86400)],
      ['1h', TIME.HOUR_YR],
      ['1d', TIME.DAY_YR],
      ['1w', TIME.DAY_YR * 7],
      ['1mo', 1 / 12],
      ['1y', 1],
    ];
    this.ctl.warp = s4.select<string>({
      label: 'Time warp (manual)',
      value: '1w',
      options: [
        { value: 'real', label: 'Real time' },
        { value: '1h', label: '1 s = 1 hour' },
        { value: '1d', label: '1 s = 1 day' },
        { value: '1w', label: '1 s = 1 week' },
        { value: '1mo', label: '1 s = 1 month' },
        { value: '1y', label: '1 s = 1 year' },
      ],
      onChange: (v) => (this.warpManual = warps.find((w) => w[0] === v)?.[1] ?? TIME.DAY_YR),
    });
    this.ctl.deep = s4.slider({
      label: 'Deep time',
      min: -200000,
      max: 200000,
      value: 0,
      step: 1000,
      unit: 'yr',
      format: (v) => (v === 0 ? 'now' : `${v > 0 ? '+' : '−'}${formatNumber(Math.abs(v), 3)}`),
      onChange: (v) => (this.deepTime = v),
    });
    s4.text('Deep time moves every star along its measured space velocity: watch the constellations dissolve and reform over hundreds of thousands of years.');

    ui.hint('Drag to steer · W/S speed · Enter engage · Tab next star · Click a star to select · V view · C constellations · I imagination drive', 9000);
  }

  private showInfo(): void {
    const d = this.dest;
    const i = this.findStar(d.star);
    const pos = i >= 0 ? this.destCenter(d, _v1) : null;
    const rows: Array<[string, string]> = [...d.facts];
    if (pos) {
      const dist = pos.distanceTo(this.flight.position);
      rows.unshift(['Distance', `${formatNumber(dist / LY_PC, 3)} ly`]);
    }
    this.ctx.ui.info({ title: d.name, subtitle: d.kicker, rows, body: d.body });
  }

  private bindInput(): void {
    const inp = this.ctx.input;
    inp.onKeyDown((e) => {
      if (e.repeat) return;
      this.autoEngage = 0; // the pilot has taken the controls
      switch (e.code) {
        case 'Enter':
        case 'NumpadEnter':
          this.engage();
          break;
        case 'Tab': {
          e.preventDefault();
          const n = DESTINATIONS.length;
          this.setTarget(DESTINATIONS[(this.targetIdx + (e.shiftKey ? n - 1 : 1)) % n].id);
          break;
        }
        case 'KeyV': {
          const order: Array<ShipView | 'sky'> = ['chase', 'cockpit', 'orbit', 'sky'];
          this.setView(order[(order.indexOf(this.view) + 1) % order.length]);
          break;
        }
        case 'KeyC':
          this.setConstellations(!this.constellationsOn);
          break;
        case 'KeyL':
          this.setLabels(!this.labelsOn);
          break;
        case 'KeyR':
          this.setRelativity(!this.relOn);
          this.ctx.ui.toast(this.relOn ? 'Special relativity on' : 'Relativity off — the naive, Newtonian sky');
          break;
        case 'KeyI':
          this.setDrive(this.drive === 'imagination' ? 'sublight' : 'imagination');
          this.ctx.ui.toast(this.drive === 'imagination' ? 'Imagination drive — faster than light, not physics' : 'Sub-light drive · 1 g');
          break;
        case 'KeyX':
          this.stop();
          break;
        case 'BracketLeft':
        case 'BracketRight': {
          const order = ['real', '1h', '1d', '1w', '1mo', '1y'];
          const cur = order.indexOf(this.ctl.warp?.get() ?? '1w');
          const next = order[THREE.MathUtils.clamp(cur + (e.code === 'BracketRight' ? 1 : -1), 0, order.length - 1)];
          this.ctl.warp?.set(next);
          this.warpManual = [1 / (365.25 * 86400), TIME.HOUR_YR, TIME.DAY_YR, TIME.DAY_YR * 7, 1 / 12, 1][order.indexOf(next)];
          this.ctx.ui.toast(`Time warp · ${describeWarp(this.warpManual)}`);
          break;
        }
      }
    });
    inp.onDrag((e) => {
      if (this.view === 'sky') {
        this.skyLook.yaw += e.dx * 0.0032;
        this.skyLook.pitch = THREE.MathUtils.clamp(this.skyLook.pitch + e.dy * 0.0032, -1.55, 1.55);
      } else if (this.view === 'chase' && (this.flight.autopilot || this.rig.traveling || e.button !== 'primary')) {
        this.shipCam.look(e.dx, e.dy);
      }
    });
    inp.onTap((e) => this.pickStar(e.x, e.y));
    inp.onDoubleTap(() => this.engage());
  }

  /** Select the brightest-looking star near a click (in CSS pixels). */
  private pickStar(x: number, y: number): void {
    const cam = this.view === 'sky' ? this.skyCam : this.shipCam.camera;
    const w = this.ctx.engine.cssWidth, h = this.ctx.engine.cssHeight;
    const rot = _m3.setFromMatrix4(cam.matrixWorldInverse);
    let best = -1, bestScore = Infinity;
    for (let i = 1; i < this.cat.count; i++) {
      if (!this.sky.apparent(i, this.app) || this.app.mag > 6.8) continue;
      const p = _v1.copy(this.app.dir).applyMatrix3(rot);
      if (p.z >= 0) continue;
      p.applyMatrix4(cam.projectionMatrix);
      const sx = (p.x * 0.5 + 0.5) * w, sy = (-p.y * 0.5 + 0.5) * h;
      const d = Math.hypot(sx - x, sy - y);
      if (d > 28) continue;
      const score = d + 4 * this.app.mag;
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best >= 0) this.selectStar(best);
  }

  // ——— Simulation ———

  update(f: FrameInfo): void {
    this.time = f.time;
    this.step(f.dt);
  }

  private step(dt: number): void {
    const fl = this.flight;
    const inp = this.ctx.input;
    if (this.autoEngage > 0) {
      this.autoEngage -= dt;
      if (this.autoEngage <= 0) {
        this.autoEngage = 0;
        if (!fl.autopilot && !this.rig.traveling && fl.beta < 1e-6) this.engage();
      }
    }
    // Manual throttle (W/S) in sub-light mode.
    if (!fl.autopilot && !this.rig.traveling && this.drive === 'sublight' && this.view !== 'sky') {
      const k = (c: string) => (inp.isDown(c) ? 1 : 0);
      const dth = (k('KeyW') + k('ArrowUp') - k('KeyS') - k('ArrowDown')) * dt * 0.25;
      if (dth) {
        const b = THREE.MathUtils.clamp((fl.manualBeta ?? fl.beta) + dth, 0, fl.betaCap);
        fl.manualBeta = b;
        this.ctl.speed?.set(b);
      }
    }
    // Steering: FlyRig owns the attitude in manual flight (chase/cockpit).
    const manual = !fl.autopilot && !this.rig.traveling && this.arrivedTurn <= 0;
    this.rig.enabled = manual && (this.view === 'chase' || this.view === 'cockpit');
    if (manual) {
      this.rig.quaternion.copy(fl.quaternion);
      this.rig.update(dt);
      fl.quaternion.copy(this.rig.quaternion);
    } else {
      this.rig.update(0);
    }
    if (this.arrivedTurn > 0) {
      // After arriving (nose still pointing back along the braking burn), turn to face the star.
      this.arrivedTurn -= dt;
      const c = this.destCenter(this.dest, _v1).sub(fl.position).normalize();
      fl.slewToward(c, dt * 0.8);
    }
    // Time warp: automatic under autopilot, manual otherwise.
    if (!fl.autopilot) fl.warp = this.warpManual;
    if (this.rig.traveling) {
      // Imagination drive: position from the rig's log-distance profile; clocks run at the manual warp.
      this.imaginationPrev.copy(fl.position);
      this.rig.update(dt);
      fl.position.copy(this.rig.position);
      fl.quaternion.copy(this.rig.quaternion);
      fl.u.set(0, 0, 0);
      const moved = fl.position.distanceTo(this.imaginationPrev);
      this.imaginationSpeed = dt > 0 ? moved / dt : 0; // pc per real second
      fl.t += dt * TIME.DAY_YR;
      fl.tau += dt * TIME.DAY_YR;
    } else {
      this.imaginationSpeed *= Math.exp(-dt / 0.3);
      fl.update(dt);
    }

    // Sky state.
    this.sky.setObserver(fl.position);
    this.sky.setEpoch(this.epochYears());
    const rel = this.relOn && this.drive === 'sublight';
    if (rel) fl.velocity(this.beta);
    else this.beta.set(0, 0, 0);
    this.sky.setVelocity(this.beta);
    this.sky.setRelativity(this.relFlags);
    const consTarget = this.constellationsOn ? 1 : 0;
    this.sky.constellations += (consTarget - this.sky.constellations) * (1 - Math.exp(-dt / 0.35));
    if (Math.abs(this.sky.constellations - consTarget) < 0.002) this.sky.constellations = consTarget;

    this.updateNearStars();
    this.updateLightsAndExposure(dt);
    this.ship.setThrust(this.rig.traveling ? 0.25 : fl.thrust);
    this.ship.setTime(this.time);
    this.near.time = this.time;
    this.updateAudio();
  }

  /** Catalogue stars within NEAR_PC (plus binary companions from their orbits) → resolved list. */
  private updateNearStars(): void {
    const fl = this.flight;
    const c = this.cat;
    const list = this.nearList;
    // Rescan the catalogue for neighbours a few times per second (cheap: 11 600 distance tests).
    if (this.nearScanFrame++ % 8 === 0 || list.length === 0) {
      list.length = 0;
      const t = this.epochYears();
      const o = fl.position;
      for (let i = 0; i < c.count; i++) {
        const dx = c.position[i * 3] + c.velocity[i * 3] * t - o.x;
        if (dx > NEAR_PC || dx < -NEAR_PC) continue;
        const dy = c.position[i * 3 + 1] + c.velocity[i * 3 + 1] * t - o.y;
        const dz = c.position[i * 3 + 2] + c.velocity[i * 3 + 2] * t - o.z;
        const d = Math.hypot(dx, dy, dz);
        if (d > NEAR_PC || d < 1e-12) continue;
        if (list.length >= 8) break;
        const inf = c.info(i);
        const ov = STAR_OVERRIDES[inf.proper] ?? STAR_OVERRIDES[inf.name];
        const props = this.sky.starProps(i);
        const T = ov?.teff ?? props.temperature;
        list.push({ index: i, pos: new THREE.Vector3(), radiusRsun: ov?.radius ?? estimateRadius(props.absMag, T), temperature: T, absMag: props.absMag, name: inf.name });
      }
    }
    // Positions (with binary orbits where known).
    for (const e of list) this.starPos(e.index, e.pos);
    for (const d of DESTINATIONS) {
      if (!d.companion) continue;
      const pi = c.find(d.star), si = c.find(d.companion.star);
      const P = list.find((x) => x.index === pi), S = list.find((x) => x.index === si);
      if (!P && !S) continue;
      const rel = this.companionOffset(d, pi, this.relScratch);
      const bary = this.starPos(pi, this.baryScratch); // catalogue primary position ≈ barycentre of the pair
      if (P) P.pos.copy(bary).addScaledVector(rel, -d.companion.orbit.q);
      if (S) {
        S.pos.copy(bary).addScaledVector(rel, 1 - d.companion.orbit.q);
        S.temperature = d.companion.teff;
        S.radiusRsun = d.companion.radius;
      }
    }
    // Hide them from the sky's point sprites and build their views.
    const views = this.nearViews;
    views.length = 0;
    const hide: number[] = [];
    for (let k = 0; k < list.length; k++) {
      const e = list[k];
      hide.push(e.index);
      const rel = _v3.copy(e.pos).sub(fl.position);
      const d = rel.length();
      const restDir = rel.divideScalar(d);
      let delta = 1;
      const view = views[k] ?? (views[k] = { dir: new THREE.Vector3(), angularRadius: 0, temperature: 0, mag: 0, seed: 0 });
      if (this.beta.lengthSq() > 1e-14) {
        delta = aberrate(restDir, this.beta, view.dir);
        if (!this.relFlags.aberration) view.dir.copy(restDir);
      } else view.dir.copy(restDir);
      let m = e.absMag + 5 * (Math.log10(d) - 1);
      let T = e.temperature;
      if (delta !== 1) {
        const Tobs = T * delta;
        if (this.relFlags.beaming) m -= 2.5 * (logLum10(Tobs) - logLum10(T) - 2 * Math.log10(delta));
        if (this.relFlags.doppler) T = Tobs;
      }
      view.mag = m;
      view.temperature = T;
      view.angularRadius = Math.asin(Math.min(1, (e.radiusRsun * R_SUN_PC) / d)) / delta;
      view.seed = e.index * 0.137;
    }
    this.sky.hideStars(hide);
  }

  /**
   * Physical lighting and eye adaptation. Each nearby or bright star illuminates the hull with
   * E = 3.17·10^(−0.4 (m − 1)) · p_ref² display units (the same flux calibration as the star
   * sprites). The exposure adapts to the total illuminance so a sunlit hull reads as a sunlit hull,
   * while in deep space the eye is dark-adapted (exposure 1, the sky's own calibration).
   */
  private updateLightsAndExposure(dt: number): void {
    const L = this.lights;
    L.length = 0;
    const push = (dir: THREE.Vector3, mag: number, T: number) => {
      const illum = 3.17 * Math.pow(10, -0.4 * (mag - 1)) * P_REF * P_REF;
      const slot = this.lightPool[L.length] ?? (this.lightPool[L.length] = { dir: new THREE.Vector3(), illum: 0, temperature: 0 });
      slot.dir.copy(dir);
      slot.illum = illum;
      slot.temperature = T;
      L.push(slot);
    };
    for (const v of this.nearViews) push(v.dir, v.mag, v.temperature);
    // The brightest sprites (e.g. a star just outside the near radius).
    for (let i = 0; i < 7; i++) {
      if (this.nearList.some((e) => e.index === i)) continue;
      if (this.sky.apparent(i, this.app) && this.app.distance > 1e-9 && this.app.mag < -3) push(this.app.dir, this.app.mag, this.app.temperature);
    }
    L.sort((a, b) => b.illum - a.illum);
    let total = 0;
    for (const l of L) total += l.illum;
    // CMB glow ahead at extreme speeds (γ ≳ 300).
    const b = this.beta.length();
    if (b > 0.99999 && this.relFlags.doppler) {
      const g = gammaOf(b);
      total += 1e-6 * Math.pow(g / 300, 4);
    }
    // Eye adaptation: dark-adapted below E_ref, then compensate ~90 % of the extra light (in log).
    const E_REF = 1.5;
    const target = total > E_REF ? Math.pow(E_REF / total, 0.9) : 1;
    this.exposureTarget = target;
    const tau = target < this.exposure ? 0.35 : 1.4;
    this.exposure = Math.exp(Math.log(this.exposure) + (Math.log(target) - Math.log(this.exposure)) * (1 - Math.exp(-dt / tau)));
    if (!isFinite(this.exposure) || this.exposure <= 0) this.exposure = target;
    // Key and fill lights on the hull (Doppler-shifted colours).
    const e = this.exposure;
    if (L[0]) {
      blackbodyColor(L[0].temperature, this.keyColor).multiplyScalar(L[0].illum * e);
      this.ship.setKeyLight(L[0].dir, this.keyColor);
    } else this.ship.setKeyLight(_v1.set(0, 1, 0), this.keyColor.setRGB(0, 0, 0));
    if (L[1]) {
      blackbodyColor(L[1].temperature, this.fillColor).multiplyScalar(L[1].illum * e);
      this.ship.setFillLight(L[1].dir, this.fillColor);
    } else this.ship.setFillLight(_v1.set(0, -1, 0), this.fillColor.setRGB(0, 0, 0));
    this.sky.exposure = e;
    this.ship.exposure = e;
  }

  private updateAudio(): void {
    const b = this.flight.beta;
    if ((this.time * 4) % 1 < 0.02) {
      this.ctx.audio.setMood('voyage', { intensity: 0.25 + 0.6 * b + (this.rig.traveling ? 0.3 : 0), speed: b, gamma: this.flight.gamma, imagination: this.rig.traveling });
    }
  }

  // ——— Rendering ———

  resize(w: number, h: number): void {
    this.width = w;
    this.height = h;
  }

  render(target: THREE.WebGLRenderTarget): void {
    const r = this.ctx.renderer;
    const eng = this.ctx.engine;
    const aspect = target.width / target.height;
    const fl = this.flight;
    // Cameras.
    const travelDir = fl.autopilot && fl.destination ? _v1.copy(fl.destination).sub(fl.position).normalize() : this.rig.traveling ? this.rig.velocity.lengthSq() > 0 ? _v1.copy(this.rig.velocity).normalize() : null : null;
    this.ship.group.quaternion.copy(fl.quaternion);
    this.ship.group.updateMatrixWorld(true);
    let cam: THREE.PerspectiveCamera;
    if (this.view === 'sky') {
      cam = this.skyCam;
      cam.fov = this.shipCam.camera.fov;
      cam.aspect = aspect;
      _e.set(this.skyLook.pitch, this.skyLook.yaw, 0, 'YXZ');
      cam.quaternion.copy(this.skyLook.frame).multiply(_q1.setFromEuler(_e));
      cam.position.set(0, 0, 0);
      cam.updateMatrixWorld();
      cam.updateProjectionMatrix();
    } else {
      this.shipCam.update(1 / 60, fl.quaternion, travelDir, this.ship.geometry.cockpit, aspect);
      cam = this.shipCam.camera;
      this.skyCam.fov = cam.fov;
      this.skyCam.aspect = aspect;
      this.skyCam.quaternion.copy(cam.quaternion);
      this.skyCam.position.set(0, 0, 0);
      this.skyCam.updateMatrixWorld();
      this.skyCam.updateProjectionMatrix();
    }
    // Environment probe: the sky as the ship sees it (one cube face per frame).
    this.sky.cssHeight = eng.cssHeight;
    if (this.view !== 'sky') this.probe.update(r, (c) => this.sky.render(r, c, 0.5), this.time < 0.2 ? 6 : 1);
    // Sky, resolved stars.
    r.setRenderTarget(target);
    this.sky.render(r, this.skyCam, eng.pixelRatio);
    const pxAngle = (2 * Math.tan(THREE.MathUtils.degToRad(this.skyCam.fov) / 2)) / target.height;
    this.near.set(this.nearViews, pxAngle, eng.pixelRatio, this.exposure, target.width, target.height, target.height * 0.28);
    this.near.render(r, this.skyCam);
    // Ship layer.
    if (this.view !== 'sky') {
      r.clearDepth();
      this.ship.pixelRatio = eng.pixelRatio;
      this.ship.updateShadow(r);
      r.setRenderTarget(target);
      const warpDir = travelDir ?? fl.forward(_v2);
      this.warp.update(1 / 60, warpDir, this.rig.traveling ? Math.min(1, this.imaginationSpeed * 2) : 0, this.exposure);
      r.render(this.shipScene, cam);
    }
    this.updateHud(this.view === 'sky' ? this.skyCam : cam);
  }

  private updateHud(cam: THREE.Camera): void {
    const fl = this.flight;
    const eng = this.ctx.engine;
    // Readouts.
    if (this.rig.traveling) {
      const cPerS = (this.imaginationSpeed / C_PC_PER_YEAR) * (365.25 * 86400);
      this.ro.speed.set(cPerS >= 1e4 ? formatScientific(cPerS, 2) : formatNumber(cPerS, 3), 'c · imagination');
      this.ro.gamma.set('—');
    } else {
      const b = fl.beta;
      if (b < 0.001) {
        const kms = b * 299792.458;
        this.ro.speed.set(formatNumber(kms, 3), 'km/s');
      } else this.ro.speed.set(b > 0.99 ? b.toFixed(5) : b.toFixed(3), 'c');
      this.ro.gamma.set(fl.gamma < 1.001 ? '1.000' : formatNumber(fl.gamma, 4));
    }
    const tauF = formatDuration(fl.tau * YEAR, 3);
    this.ro.ship.set(`+${tauF.value}`, tauF.unit);
    const year = NOW_YEAR + fl.t;
    this.ro.earth.set(year < 1e5 ? year.toFixed(year - NOW_YEAR < 10 ? 2 : 1) : formatNumber(year, 4), 'CE');
    const d = this.dest;
    const center = this.destCenter(d, _v1);
    const dist = center.distanceTo(fl.position);
    const distLy = dist / LY_PC;
    if (distLy < 0.01) this.ro.dist.set(formatNumber((dist / AU_PC), 3), 'AU');
    else this.ro.dist.set(formatNumber(distLy, 3), 'ly');

    // Flight status widget.
    const p = this.flightParts;
    p.name.textContent = d.name;
    let phase = '', eta = '';
    let progress = 0;
    if (this.rig.traveling) {
      phase = 'Imagination drive';
      progress = this.rig.travelProgress;
      eta = 'faster than light — not physics';
      p.tag.textContent = '';
    } else if (fl.autopilot) {
      const names: Record<string, string> = {
        align: 'Turning to the destination',
        accelerate: `Accelerating · ${fl.accelG.toFixed(fl.accelG < 1 ? 2 : 1)} g`,
        coast: `Coasting at ${fl.beta.toFixed(4)} c`,
        flip: 'Flip — turning to brake',
        brake: 'Braking',
      };
      phase = names[fl.phase] ?? fl.phase;
      progress = fl.progress;
      const tauLeft = fl.estimateRemainingTau();
      const tl = formatDuration(tauLeft * YEAR, 2);
      eta = `${tl.value} ${tl.unit} ship time to go\ntime warp ${describeWarp(fl.warp)}`;
      p.tag.textContent = '';
    } else if (this.view === 'sky' && fl.position.lengthSq() < 1e-16) {
      phase = 'The sky from Earth';
      eta = `${this.cat.count.toLocaleString('en-US').replace(/,/g, ' ')} catalogued stars · parallax from here`;
      progress = 0;
    } else if (fl.phase === 'arrived' || dist < d.standoffAU * AU_PC * 1.2) {
      phase = 'Arrived';
      eta = `${formatNumber(dist / AU_PC, 3)} AU from ${d.name}`;
      progress = 1;
    } else {
      phase = fl.beta > 0.0005 ? 'Manual flight' : 'Holding position';
      eta = `Enter to set course\ntime warp ${describeWarp(fl.warp)}`;
    }
    p.tag.textContent = this.drive === 'imagination' ? 'Imagination drive armed' : this.relOn ? '' : 'Relativity off';
    if (p.phase.textContent !== phase) p.phase.textContent = phase;
    if (p.eta.textContent !== eta) p.eta.textContent = eta;
    p.bar.style.width = '100%';
    p.bar.style.transform = `scaleX(${THREE.MathUtils.clamp(progress, 0, 1).toFixed(3)})`;

    // Labels: named stars as seen from here, plus the Sun.
    const items = this.labelItems;
    items.length = 0;
    let k = 0;
    const addLabel = (i: number, priorityBoost = 0) => {
      if (k >= this.labelPool.length) return;
      if (!this.sky.apparent(i, this.app)) return;
      const nearView = this.nearList.findIndex((e) => e.index === i);
      const dir = nearView >= 0 ? this.nearViews[nearView].dir : this.app.dir;
      const mag = nearView >= 0 ? this.nearViews[nearView].mag : this.app.mag;
      if (mag > 3.2 && priorityBoost === 0) return;
      const it = this.labelPool[k++];
      it.dir.copy(dir);
      const inf = this.cat.info(i);
      it.text = i === 0 ? 'Sun' : inf.proper || inf.designation || inf.name;
      const dly = this.app.distance / LY_PC;
      it.sub = dly < 0.05 ? `${formatNumber(this.app.distance / AU_PC, 2)} AU` : `${formatNumber(dly, dly < 10 ? 2 : 3)} ly`;
      it.priority = -mag + priorityBoost;
      it.cool = i === 0;
      items.push(it);
    };
    if (fl.position.lengthSq() > 1e-14) addLabel(0, 30);
    for (const i of this.namedBright) addLabel(i);
    for (const e of this.nearList) if (!this.namedBright.includes(e.index)) addLabel(e.index, 5);
    // Companion labels (drawn from the orbit model).
    // Target reticle.
    const ti = this.findStar(d.star);
    let tgt: LabelItem | null = null;
    if (ti >= 0 && this.sky.apparent(ti, this.app)) {
      const nearView = this.nearList.findIndex((e) => e.index === ti);
      this.targetLabel.dir.copy(nearView >= 0 ? this.nearViews[nearView].dir : this.app.dir);
      if (d.companion) {
        // Aim between the pair.
        const cen = this.destCenter(d, _v2).sub(fl.position).normalize();
        if (this.beta.lengthSq() > 1e-14 && this.relFlags.aberration) aberrate(cen, this.beta, this.targetLabel.dir);
        else this.targetLabel.dir.copy(cen);
      }
      this.targetLabel.text = d.name;
      this.targetLabel.sub = distLy < 0.01 ? `${formatNumber(dist / AU_PC, 3)} AU` : `${formatNumber(distLy, 3)} ly`;
      tgt = this.targetLabel;
    }
    // Keep labels off the ship.
    const reserved = this.reservedBoxes;
    reserved.length = 0;
    if (this.view === 'cockpit') {
      // The nose fills the lower part of the cockpit view.
      reserved.push([eng.cssWidth * 0.18, eng.cssHeight * 0.76, eng.cssWidth * 0.82, eng.cssHeight]);
    } else if (this.view !== 'sky') {
      const pc = cam as THREE.PerspectiveCamera;
      const c = _v3.set(0, 0, 0).applyMatrix4(pc.matrixWorldInverse);
      if (c.z < 0) {
        const dist = -c.z;
        c.applyMatrix4(pc.projectionMatrix);
        const sx = (c.x * 0.5 + 0.5) * eng.cssWidth, sy = (-c.y * 0.5 + 0.5) * eng.cssHeight;
        const rpx = (this.ship.geometry.boundingRadius * 0.8 / dist) * (eng.cssHeight / 2) / Math.tan(THREE.MathUtils.degToRad(pc.fov) / 2);
        reserved.push([sx - rpx, sy - rpx * 0.7, sx + rpx, sy + rpx * 0.7]);
      }
    }
    this.hud.update(items, tgt, cam, eng.cssWidth, eng.cssHeight, reserved);
  }
  private reservedBoxes: [number, number, number, number][] = [];

  /** Debug: place the orbit camera (radians, metres). */
  orbitView(yaw: number, pitch: number, distance: number): void {
    this.setView('orbit');
    this.shipCam.orbit.set({ yaw, pitch, distance });
  }

  unmount(): void {
    this.sky.dispose();
    this.near.dispose();
    this.ship.dispose();
    this.probe.dispose();
    this.warp.dispose();
    this.hud.dispose();
  }
}

// ——— helpers ———

function aberrate(dir: THREE.Vector3, beta: THREE.Vector3, out: THREE.Vector3): number {
  return aberrateDirection(dir, beta, out);
}
function logLum10(T: number): number {
  return logBlackbodyLuminance(T) / Math.LN10;
}
/** Blackbody chromaticity (luminance 1) — CPU twin of BLACKBODY_GLSL. */
function blackbodyColor(Tin: number, out: THREE.Color): THREE.Color {
  const T = Math.min(Math.max(Tin, 800), 60000);
  const u = (0.860117757 + 1.54118254e-4 * T + 1.28641212e-7 * T * T) / (1 + 8.42420235e-4 * T + 7.08145163e-7 * T * T);
  const v = (0.317398726 + 4.22806245e-5 * T + 4.20481691e-8 * T * T) / (1 - 2.89741816e-5 * T + 1.61456053e-7 * T * T);
  const d = 2 * u - 8 * v + 4;
  const x = (3 * u) / d, y = (2 * v) / d;
  const X = x / y, Z = (1 - x - y) / y;
  return out.setRGB(
    Math.max(0, 3.2404542 * X - 1.5371385 - 0.4985314 * Z),
    Math.max(0, -0.969266 * X + 1.8760108 + 0.041556 * Z),
    Math.max(0, 0.0556434 * X - 0.2040259 + 1.0572252 * Z),
  );
}

const _zero = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
const _v6 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _m3 = new THREE.Matrix3();
const _e = new THREE.Euler();

export default () => new Voyage();
