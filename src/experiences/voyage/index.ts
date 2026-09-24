import * as THREE from 'three';
import type { Experience, ExperienceContext, FrameInfo } from '../../core/types';
import type { Readout } from '../../ui/UI';
import type { Control } from '../../ui/Panel';
import { FlyRig } from '../../core/rigs/FlyRig';
import { loadStarCatalog, equatorialToGalacticThree } from '../../worlds/sky/catalog';
import { AU_PC, estimateRadius } from '../../worlds/sky/stellar';
import { Ship, SkyProbe } from '../../worlds/ship/Ship';
import { ShipCamera, type ShipView } from '../../worlds/ship/ShipCamera';
import { StarshipFlight, describeWarp, TIME } from '../../worlds/ship/flight';
import { C_PC_PER_YEAR, gammaOf } from '../../physics/voyage-relativity';
import { formatNumber, formatDuration, formatScientific, formatDistance, formatParsecs } from '../../physics/units';
import { YEAR } from '../../physics/constants';
import { Frame, UNIT, convertPoint, makeNav, rebase, rootQuatToFrame, settleFrame, translateMetres, type NavState } from '../../worlds/explorer/frames';
import { Trip, autoSpeed, lookQuat, niceScaleBar, SPEED_OF_LIGHT } from '../../worlds/explorer/navigation';
import { DESTINATIONS, type Destination } from './targets';
import { Hud, type LabelItem } from './hud';
import { WarpField } from './warp';
import { LocalSky, LY_PC, NOW_YEAR, P_REF, type Light } from './localSky';
import { Cosmos, type GalaxyEntry } from './cosmos';

/**
 * VOYAGE — the seamless universe (explorer, phase 2; built on Starflight, phase 1).
 *
 * One continuous, flyable universe from a planet's sky to the cosmic web. Position is kept in
 * float64 in the deepest of a stack of frames (universe Mpc → galaxy pc → solar neighbourhood pc →
 * star system AU → planet km; src/worlds/explorer/frames.ts), entered and left with hysteresis.
 * Each scale is drawn by the module that owns it — the cosmic web (a z = 0 ΛCDM simulation), the
 * Milky Way and Andromeda (GalaxyLayer: stars on density-wave orbits, dust, HII), the real sky of
 * the solar neighbourhood (HYG catalogue in 3D with special relativity) — and cross-faded by
 * distance so nothing pops. Speed scales with the distance to the nearest body; beyond c this is the
 * "imagination drive", labelled as such. Sub-light flight between nearby stars stays fully
 * relativistic (Starflight): aberration, Doppler colour, beaming, time dilation.
 */
type Drive = 'sublight' | 'imagination';

/** Starting distance from the Sun (AU): well past the heliopause, where the Sun is a −13.7 mag star. */
const DEPART_AU = 420;
/** Galaxy radiance (L☉ pc⁻² sr⁻¹ units of GalaxyLayer) → the explorer's sky-calibrated scale. */
const GALAXY_GAIN = 0.1;
/** Cosmic-web brightness in the same scale. */
const WEB_GAIN = 1.1;

interface Place {
  frame: Frame;
  position: THREE.Vector3;
  lookAt?: THREE.Vector3;
  /** Natural scale of the destination (m). */
  scale: number;
  up?: THREE.Vector3;
}

interface ExplorerDest {
  id: string;
  name: string;
  kicker: string;
  group: 'Stars' | 'Galaxies' | 'Universe';
  facts: Array<[string, string]>;
  body: string;
  /** Star destinations fly sub-light when that drive is selected. */
  star?: Destination;
  place(): Place | null;
}

class Voyage implements Experience {
  private ctx!: ExperienceContext;
  private local!: LocalSky;
  private cosmos!: Cosmos;
  private ship!: Ship;
  private probe!: SkyProbe;
  private flight = new StarshipFlight();
  private rig!: FlyRig;
  private shipCam!: ShipCamera;
  private warp!: WarpField;
  private hud!: Hud;
  private shipScene = new THREE.Scene();
  private skyCam = new THREE.PerspectiveCamera(55, 1, 0.1, 10);
  private layerCam = new THREE.PerspectiveCamera(55, 1, 1e-4, 1e8);
  private nav!: NavState;
  private trip: Trip | null = null;
  private tripDest: ExplorerDest | null = null;
  private drive: Drive = 'sublight';
  private view: ShipView | 'sky' = 'chase';
  private relOn = true;
  private dests: ExplorerDest[] = [];
  private dest!: ExplorerDest;
  private exposure = 1;
  private labelsOn = true;
  private constellationsOn = false;
  private deepTime = 0;
  private time = 0;
  /** Imagination-drive throttle 0..1 and current speed (m/s). */
  private throttle = 0;
  private speed = 0;
  private arrivedTurn = 0;
  private skyLook = { yaw: 0, pitch: 0, frame: new THREE.Quaternion() };
  private autoEngage = 0;
  private width = 1;
  private height = 1;
  // Derived per frame.
  private navLocal = new THREE.Vector3();
  private navRoot = new THREE.Vector3();
  private dSun = 0;
  private dNearest = 1e12;
  private beta = new THREE.Vector3();
  private warpStrength = 0;
  // Scratch.
  private lights: Light[] = [];
  private lightPool: Light[] = [];
  private keyColor = new THREE.Color();
  private fillColor = new THREE.Color();
  private labelItems: LabelItem[] = [];
  private labelPool: LabelItem[] = [];
  private targetLabel: LabelItem = { dir: new THREE.Vector3(), text: '', priority: 0 };
  private homeLabel: LabelItem = { dir: new THREE.Vector3(), text: '', priority: 0 };
  private reservedBoxes: [number, number, number, number][] = [];
  // UI.
  private ro!: { speed: Readout; gamma: Readout; ship: Readout; earth: Readout; dist: Readout };
  private flightParts!: { crumb: HTMLElement; name: HTMLElement; phase: HTMLElement; bar: HTMLElement; eta: HTMLElement; tag: HTMLElement; scale: HTMLElement; scaleBar: HTMLElement };
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
  /** Default framing: Sun azimuth/elevation from the nose (deg), chase camera offsets (rad). */
  departureSun = { az: 100, el: 20, camYaw: 0.4, camPitch: 0 };

  async mount(ctx: ExperienceContext): Promise<void> {
    this.ctx = ctx;
    ctx.progress(0.1, 'Charting 11 600 stars');
    const cat = await loadStarCatalog();
    ctx.progress(0.45, 'Building the ship');
    const q = ctx.quality;
    this.local = new LocalSky(cat, q.detail);
    this.cosmos = new Cosmos(ctx.renderer, q.detail);
    this.cosmos.resize(ctx.engine.width, ctx.engine.height);
    this.nav = makeNav(this.cosmos.local);
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
    for (let i = 0; i < 48; i++) this.labelPool.push({ dir: new THREE.Vector3(), text: '', priority: 0 });
    this.buildDestinations();
    this.dest = this.dests.find((d) => d.id === 'alpha-cen')!;
    this.flight.onArrive = () => this.onArrive();
    this.buildUI();
    this.bindInput();
    this.preset('departure');
    ctx.post.bloomStrength = 0.075;
    ctx.post.bloomRadius = 0.85;
    ctx.post.vignette = 0.18;
    ctx.post.tonemap = 'aces';
    ctx.audio.setMood('voyage', { intensity: 0.3, speed: 0 });
    await this.local.ready;
    ctx.progress(1);
    ctx.signalReady();
  }

  // ——— Destinations ———————————————————————————————————————————————————————————

  private buildDestinations(): void {
    const L = this.local;
    const cz = this.cosmos;
    for (const d of DESTINATIONS) {
      this.dests.push({
        id: d.id,
        name: d.name,
        kicker: d.kicker,
        group: 'Stars',
        facts: d.facts,
        body: d.body,
        star: d,
        place: () => {
          const center = L.destCenter(d, new THREE.Vector3());
          const here = this.navLocal;
          const dir = center.clone().sub(here);
          const dist = dir.length();
          dir.divideScalar(Math.max(dist, 1e-30));
          const standoff = d.standoffAU * AU_PC;
          return { frame: cz.local, position: center.clone().addScaledVector(dir, -standoff), lookAt: center, scale: standoff * UNIT.PC };
        },
      });
    }
    this.dests.push(
      {
        id: 'milky-way',
        name: 'The Milky Way from outside',
        kicker: 'Our galaxy · 100 000 ly across',
        group: 'Galaxies',
        facts: [
          ['Type', 'Barred spiral SBbc'],
          ['Stars', '≈ 100–400 billion'],
          ['Sun', '8.2 kpc from the centre, in the Orion Spur'],
          ['Rotation', '230 km/s at the Sun · 220 Myr per orbit'],
        ],
        body: 'A disk of stars on density-wave orbits, dust lanes on the inner edges of the arms, pink star-forming regions — and, marked, the one ordinary star we call the Sun.',
        place: () => {
          const pos = new THREE.Vector3(-0.42, 0.62, 0.66).normalize().multiplyScalar(52000);
          return { frame: cz.mw, position: pos, lookAt: new THREE.Vector3(-1500, 0, 800), scale: 15000 * UNIT.PC };
        },
      },
      {
        id: 'andromeda',
        name: 'Andromeda',
        kicker: 'M31 · the nearest large galaxy · 2.5 million ly',
        group: 'Galaxies',
        facts: [
          ['Distance', '780 kpc (2.5 million ly)'],
          ['Type', 'Spiral Sb, ≈ 1 trillion stars'],
          ['Approaching', 'at 110 km/s — merger in ~4.5 Gyr'],
          ['Inclination', '77° to our line of sight'],
        ],
        body: 'The Milky Way’s larger sibling. The light you see left it before there were humans. Its disk is tilted 77° to our line of sight: from home it is a long ellipse, from here a spiral.',
        place: () => {
          const pos = new THREE.Vector3(0.35, 0.72, 0.6).normalize().multiplyScalar(68000);
          return { frame: cz.m31Entry.frame, position: pos, lookAt: new THREE.Vector3(), scale: 20000 * UNIT.PC };
        },
      },
      {
        id: 'cosmic-web',
        name: 'The cosmic web',
        kicker: 'Dark matter and galaxies · 1 billion ly across',
        group: 'Universe',
        facts: [
          ['Box', '≈ 300 Mpc on a side (ΛCDM, Planck 2018)'],
          ['Structure', 'filaments, walls, clusters and voids'],
          ['You are here', 'a small group in a filament'],
        ],
        body: 'Gravity amplified tiny ripples of the early universe into this web of dark matter. Every point of light is a galaxy; the glow between them is dark matter, drawn as if we could see it.',
        place: () => {
          const box = cz.universe.boxMpc || 300;
          const pos = new THREE.Vector3(0.62, 0.42, 0.66).normalize().multiplyScalar(box * 1.35);
          return { frame: cz.root, position: pos, lookAt: new THREE.Vector3(), scale: box * 0.3 * UNIT.MPC };
        },
      },
      {
        id: 'random-galaxy',
        name: 'A random galaxy',
        kicker: 'Somewhere in the simulated universe',
        group: 'Universe',
        facts: [],
        body: 'A halo picked at random from the simulated web; its galaxy is generated from the halo’s mass (the morphology–density relation).',
        place: () => {
          const u = cz.universe;
          if (!u.isReady) return null;
          const cands = u.halos.filter((h) => h.position.length() > 6 && h.position.length() < 90 && h.mass < 6e14);
          if (!cands.length) return null;
          const h = cands[Math.floor(Math.random() * cands.length)];
          const g = cz.visitHalo(h);
          this.describeGalaxy(g);
          const dist = g.params.look.viewDistance * 1.6;
          const pos = new THREE.Vector3(0.3, 0.75, 0.6).normalize().multiplyScalar(dist);
          return { frame: g.frame, position: pos, lookAt: new THREE.Vector3(), scale: g.radius * UNIT.PC };
        },
      },
    );
  }

  private describeGalaxy(g: GalaxyEntry): void {
    const d = this.dests.find((x) => x.id === 'random-galaxy')!;
    d.name = g.name;
    d.kicker = g.kicker;
    const dist = g.frame.origin.length();
    d.facts = [
      ['Distance', `${formatNumber(dist, 3)} Mpc (${formatNumber(dist * 3.2616, 3)} million ly)`],
      ['Type', g.params.label],
    ];
  }

  setTarget(id: string, silent = false): void {
    const d = this.dests.find((x) => x.id === id);
    if (!d) return;
    this.dest = d;
    this.ctl.target?.set(id);
    if (!silent) this.showInfo();
  }

  /** Go to the current destination. */
  engage(): void {
    const d = this.dest;
    const useSublight = this.drive === 'sublight' && !!d.star && this.dSun < 400;
    if (useSublight) {
      const star = d.star!;
      const center = this.local.destCenter(star, _v2);
      const arrive = star.standoffAU * AU_PC;
      if (this.navLocal.distanceTo(center) < arrive * 1.05) {
        this.ctx.ui.toast(`Already at ${d.name}`);
        return;
      }
      this.trip = null;
      this.syncFlightFromNav();
      this.flight.engage(center, { arrive, cruiseSeconds: 22 });
      this.ctx.audio.event('engage');
      this.ctx.ui.toast(`Course set · ${d.name}`);
      return;
    }
    const place = d.place();
    if (!place) {
      this.ctx.ui.toast('The cosmic web is still forming — try again in a moment');
      return;
    }
    this.travelTo(place, d);
  }

  private travelTo(place: Place, d: ExplorerDest | null, duration?: number): void {
    this.flight.halt();
    this.arrivedTurn = 0;
    this.throttle = 0;
    this.ctl.speed?.set(0);
    const start = { frame: this.nav.frame, position: this.nav.position, scale: Math.max(this.dNearest * 0.5, 1e5) };
    const end = { frame: place.frame, position: place.position, scale: place.scale };
    this.trip = new Trip(start, end, { lookAt: place.lookAt, startQuaternion: this.nav.quaternion, up: place.up, duration });
    this.tripDest = d;
    this.shipCam.yawBias = this.shipCam.pitchBias = 0;
    if (this.drive !== 'imagination') this.setDrive('imagination', true);
    this.ctx.audio.event('warp');
    if (d) this.ctx.ui.toast(`Imagination drive · ${d.name}`);
  }

  stop(): void {
    this.trip = null;
    this.flight.disengage();
    this.flight.manualBeta = 0;
    this.throttle = 0;
    this.ctl.speed?.set(0);
  }

  private onArrive(): void {
    this.arrivedTurn = this.trip ? 0 : 4.5;
    this.flight.manualBeta = null;
    this.ctl.speed?.set(0);
    this.ctx.audio.event('arrive');
    this.ctx.ui.toast(`Arrived · ${(this.tripDest ?? this.dest).name}`);
    this.showInfo();
  }

  // ——— Presets and views (debug hooks) ————————————————————————————————————————

  preset(name: string): void {
    const f = this.flight;
    f.halt();
    this.trip = null;
    this.autoEngage = 0;
    f.tau = 0;
    f.t = 0;
    this.arrivedTurn = 0;
    this.throttle = 0;
    const L = this.local;
    const acen = L.cat.find('Rigil Kentaurus');
    const toAcen = L.starPos(acen, _v1).normalize();
    rebase(this.nav, this.cosmos.local);
    if (name === 'departure' || name === 'default') {
      // 420 AU out, nose toward α Centauri; the Sun stands behind the camera's shoulder.
      this.setTarget('alpha-cen', true);
      this.setDrive('sublight', true);
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
      this.autoEngage = 2.2;
    } else if (name === 'relativistic' || name === '0.9c') {
      this.setTarget('alpha-cen', true);
      this.setDrive('sublight', true);
      f.position.copy(toAcen).multiplyScalar(0.3);
      this.faceDirection(toAcen);
      f.u.copy(toAcen).multiplyScalar(0.9 / Math.sqrt(1 - 0.81));
      f.manualBeta = 0.9;
      this.ctl.speed?.set(0.9);
      f.warp = TIME.DAY_YR * 2;
      this.setView('cockpit');
    } else if (name === 'approach' || name === 'alpha-cen') {
      this.setTarget('alpha-cen', true);
      this.setDrive('sublight', true);
      const star = this.dest.star!;
      const center = L.destCenter(star, _v2);
      const arrive = star.standoffAU * AU_PC;
      const from = _v3.copy(center).normalize();
      f.position.copy(center).addScaledVector(from, -(arrive + 0.0016));
      this.faceDirection(from);
      f.engage(center, { arrive, cruiseSeconds: 22 });
      const s = 0.0016;
      const a = f.alpha * 0.95;
      const phi = Math.acosh(1 + (a * s) / C_PC_PER_YEAR);
      f.u.copy(from).multiplyScalar(Math.sinh(phi));
      f.quaternion.copy(lookQuat(_v4.copy(from).negate(), _v6.set(0, 1, 0), _q2));
      f.phase = 'brake';
      this.setView('chase');
      this.shipCam.distance = 42;
    } else if (name === 'earth' || name === 'home-sky') {
      this.setTarget('sun', true);
      f.position.set(0, 0, 0);
      this.setView('sky');
      const ncp = equatorialToGalacticThree(0, 0, 1, _v3).normalize();
      this.skyLook.frame.setFromUnitVectors(_v4.set(0, 1, 0), ncp);
      this.setConstellations(true);
      this.lookSkyAt('Alnilam', -8);
    }
    if (name !== 'departure' && name !== 'default') this.shipCam.yawBias = this.shipCam.pitchBias = 0;
    this.shipCam.snap();
    this.nav.frame = this.cosmos.local;
    this.nav.position.copy(f.position);
    this.nav.quaternion.copy(f.quaternion);
    settleFrame(this.nav, this.cosmos.children);
    this.updateDerived();
  }

  /** Debug/tour: jump (no flight) to a destination. */
  jump(id: string): void {
    const d = this.dests.find((x) => x.id === id);
    const p = d?.place();
    if (!d || !p) return;
    this.setTarget(id, true);
    this.flight.halt();
    this.trip = null;
    this.throttle = 0;
    this.nav.frame = p.frame;
    this.nav.position.copy(p.position);
    if (p.lookAt) {
      const dir = _v1.copy(p.lookAt).sub(p.position).normalize();
      dir.applyQuaternion(p.frame.rootRotation);
      lookQuat(dir, p.up ?? _v2.set(0, 1, 0), this.nav.quaternion);
    }
    settleFrame(this.nav, this.cosmos.children);
    this.setDrive('imagination', true);
    if (this.view === 'sky') this.setView('chase');
    this.shipCam.yawBias = this.shipCam.pitchBias = 0;
    this.shipCam.snap();
    this.updateDerived();
  }

  /** Debug: fly to a destination with the imagination drive. */
  go(id: string): void {
    this.setTarget(id, true);
    this.setDrive('imagination', true);
    this.engage();
  }

  private faceDirection(dir: THREE.Vector3): void {
    lookQuat(dir, _v6.set(0, 1, 0), this.flight.quaternion);
  }

  private syncFlightFromNav(): void {
    convertPoint(this.nav.position, this.nav.frame, this.cosmos.local, this.flight.position);
    this.flight.quaternion.copy(this.nav.quaternion);
  }

  setView(v: ShipView | 'sky'): void {
    this.view = v;
    if (v !== 'sky') this.shipCam.mode = v;
    this.ship.group.visible = v !== 'sky';
    this.ship.cockpit = v === 'cockpit';
    this.local.baseStarSize = v === 'sky' ? 1.45 : 1;
    this.local.baseBrightness = v === 'sky' ? 2 : 1;
    this.local.sky.starSize = this.local.baseStarSize;
    this.viewButtons?.setActive(['chase', 'cockpit', 'orbit', 'sky'].indexOf(v));
    this.shipCam.snap();
  }

  private lookSkyAt(name: string, pitchOffsetDeg = 0): void {
    const i = this.local.cat.find(name);
    if (i < 0) return;
    const d = this.local.starPos(i, _v1).sub(this.flight.position).normalize();
    d.applyQuaternion(_q1.copy(this.skyLook.frame).invert());
    this.skyLook.yaw = Math.atan2(-d.x, -d.z);
    this.skyLook.pitch = Math.asin(THREE.MathUtils.clamp(d.y, -1, 1)) + THREE.MathUtils.degToRad(pitchOffsetDeg);
  }

  setBeta(b: number): void {
    const fwd = this.flight.forward(_v1);
    this.flight.u.copy(fwd).multiplyScalar(b / Math.sqrt(1 - b * b));
    this.flight.manualBeta = b;
    this.ctl.speed?.set(b);
  }
  setDrive(d: Drive, silent = false): void {
    if (d === this.drive) return;
    this.drive = d;
    this.ctl.drive?.set(d);
    if (d === 'imagination') {
      // Leave relativistic flight at rest in the current frame.
      this.flight.halt();
    } else {
      this.trip = null;
      this.throttle = 0;
      this.syncFlightFromNav();
    }
    if (!silent) this.ctx.ui.toast(d === 'imagination' ? 'Imagination drive — faster than light, not physics' : 'Sub-light drive · 1 g · special relativity');
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
  /** Debug: advance the simulation by n seconds of dt without rendering. */
  advance(seconds: number, dt = 1 / 60): void {
    for (let t = 0; t < seconds; t += dt) this.step(dt);
  }
  /** Debug: state summary. */
  state(): Record<string, unknown> {
    return {
      frame: this.nav.frame.id,
      pos: this.nav.position.toArray(),
      dSunPc: this.dSun,
      root: this.navRoot.toArray(),
      trip: this.trip ? this.trip.progress : null,
      galaxies: this.cosmos.galaxies.map((g) => ({ id: g.id, layer: !!g.layer, ready: g.ready, w: g.weight })),
      web: this.cosmos.universe.isReady,
      exposure: this.exposure,
    };
  }

  // ——— UI ———————————————————————————————————————————————————————————————————

  private buildUI(): void {
    const ui = this.ctx.ui;
    this.ro = {
      speed: ui.readout('Speed', 'c'),
      gamma: ui.readout('Lorentz γ'),
      ship: ui.readout('Ship clock', 'yr'),
      earth: ui.readout('Earth date'),
      dist: ui.readout('To target', 'ly'),
    };
    const el = document.createElement('div');
    el.className = 'vy-flight';
    el.innerHTML = `<div class="vy-fl-crumb"></div><div class="vy-fl-name"></div><div class="vy-fl-phase"></div><div class="vy-fl-bar"><i></i></div><div class="vy-fl-eta"></div><div class="vy-fl-scale"><span></span><i></i></div><div class="vy-fl-tag"></div>`;
    ui.corner(el);
    const q = (s: string) => el.querySelector(s) as HTMLElement;
    this.flightParts = { crumb: q('.vy-fl-crumb'), name: q('.vy-fl-name'), phase: q('.vy-fl-phase'), bar: q('.vy-fl-bar i'), eta: q('.vy-fl-eta'), tag: q('.vy-fl-tag'), scale: q('.vy-fl-scale span'), scaleBar: q('.vy-fl-scale i') };

    const s1 = ui.section('Destination');
    const groups: Array<ExplorerDest['group']> = ['Galaxies', 'Universe', 'Stars'];
    const opts = groups.flatMap((g) => this.dests.filter((d) => d.group === g).map((d) => ({ value: d.id, label: d.name })));
    this.ctl.target = s1.select<string>({ label: 'Go to', value: this.dest.id, options: opts, onChange: (v) => this.setTarget(v) });
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
      onChange: (v) => this.setDrive(v as Drive, true),
    });
    s1.slider({ label: 'Acceleration', min: 0.1, max: 20, log: true, value: 1, unit: 'g', format: (v) => (v < 1 ? v.toFixed(2) : v.toFixed(1)), onChange: (v) => (this.flight.accelG = v) });
    s1.text('Sub-light: constant proper acceleration, flip at the midpoint, brake to a stop — between nearby stars. The imagination drive is not physics: it crosses galaxies in seconds, its speed scaled to the distance of the nearest body.');

    const s2 = ui.section('Relativity');
    this.ctl.rel = s2.toggle({ label: 'Special relativity', value: true, onChange: (v) => (this.relOn = v) });
    this.ctl.ab = s2.toggle({ label: 'Aberration', value: true, onChange: (v) => (this.local.flags.aberration = v) });
    this.ctl.dop = s2.toggle({ label: 'Doppler colour shift', value: true, onChange: (v) => (this.local.flags.doppler = v) });
    this.ctl.beam = s2.toggle({ label: 'Beaming (brightness)', value: true, onChange: (v) => (this.local.flags.beaming = v) });
    this.ctl.speed = s2.slider({
      label: 'Cruise speed',
      min: 0,
      max: 0.999,
      value: 0,
      step: 0.001,
      unit: 'c',
      format: (v) => v.toFixed(3),
      onChange: (v) => {
        if (this.drive !== 'sublight') this.setDrive('sublight', true);
        if (this.flight.autopilot) this.flight.disengage();
        this.flight.manualBeta = v;
      },
    });

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
    this.ctl.labels = s3.toggle({ label: 'Names', value: true, onChange: (v) => this.setLabels(v) });
    s3.slider({ label: 'Field of view', min: 20, max: 100, value: 55, unit: '°', format: (v) => v.toFixed(0), onChange: (v) => (this.shipCam.camera.fov = v) });

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
      label: 'Time warp',
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
    s4.text('Deep time moves every nearby star along its measured space velocity: watch the constellations dissolve and reform.');

    ui.destinations(this.dests.map((d) => ({ label: d.name, hint: d.kicker, group: 'Destinations', keywords: d.group, run: () => { this.setTarget(d.id); this.engage(); } })));
    ui.shortcuts([
      { keys: 'Enter', label: 'Engage (fly to the destination)' },
      { keys: 'W / S', label: 'Throttle' },
      { keys: 'Tab', label: 'Next destination' },
      { keys: 'I', label: 'Imagination / sub-light drive' },
      { keys: 'V', label: 'Chase · cockpit · orbit · sky view' },
      { keys: 'X', label: 'Stop' },
    ] as never);
    ui.hint('Drag to steer · W/S speed · Enter engage · Tab next destination · Ctrl K search · I imagination drive · V view', 9000);
  }

  private showInfo(): void {
    const d = this.dest;
    const rows: Array<[string, string]> = [...d.facts];
    this.ctx.ui.info({ title: d.name, subtitle: d.kicker, rows, body: d.body });
  }

  private bindInput(): void {
    const inp = this.ctx.input;
    inp.onKeyDown((e) => {
      if (e.repeat) return;
      this.autoEngage = 0;
      switch (e.code) {
        case 'Enter':
        case 'NumpadEnter':
          this.engage();
          break;
        case 'Tab': {
          e.preventDefault();
          const n = this.dests.length;
          const i = this.dests.indexOf(this.dest);
          this.setTarget(this.dests[(i + (e.shiftKey ? n - 1 : 1)) % n].id);
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
      } else if (this.view === 'chase' && (this.flight.autopilot || this.trip || e.button !== 'primary')) {
        this.shipCam.look(e.dx, e.dy);
      }
    });
    inp.onTap((e) => this.pick(e.x, e.y));
    inp.onDoubleTap(() => this.engage());
  }

  private pick(x: number, y: number): void {
    const cam = this.skyCam;
    const w = this.ctx.engine.cssWidth, h = this.ctx.engine.cssHeight;
    const i = this.local.pick(x, y, cam, w, h);
    if (i >= 0) this.selectStar(i);
  }

  private selectStar(index: number): void {
    const known = this.dests.find((d) => d.star && this.local.findStar(d.star.star) === index);
    if (known) {
      this.setTarget(known.id);
      return;
    }
    const L = this.local;
    const inf = L.cat.info(index);
    const T = L.sky.starProps(index).temperature;
    const R = estimateRadius(L.cat.absMag[index], T);
    const dist = L.cat.distance[index] / LY_PC;
    const star: Destination = {
      id: `hyg-${index}`,
      name: inf.name,
      star: `#${index}`,
      kicker: `${inf.spect || 'Star'} · ${formatNumber(dist, 3)} ly from the Sun`,
      standoffAU: Math.max(0.03, R * 0.0465 * 60),
      facts: [
        ['Designation', inf.designation || '—'],
        ['Spectral type', inf.spect || '—'],
        ['Temperature', `${formatNumber(T, 3)} K (from B−V)`],
        ['Brightness from Earth', `V = ${L.cat.mag[index].toFixed(2)}`],
      ],
      body: 'Any star in the catalogue can be a destination. Press Enter to set course.',
    };
    const d: ExplorerDest = {
      id: star.id,
      name: star.name,
      kicker: star.kicker,
      group: 'Stars',
      facts: star.facts,
      body: star.body,
      star,
      place: () => {
        const center = L.destCenter(star, new THREE.Vector3());
        const dir = center.clone().sub(this.navLocal).normalize();
        const standoff = star.standoffAU * AU_PC;
        return { frame: this.cosmos.local, position: center.clone().addScaledVector(dir, -standoff), lookAt: center, scale: standoff * UNIT.PC };
      },
    };
    this.dest = d;
    this.showInfo();
  }

  // ——— Simulation ——————————————————————————————————————————————————————————————

  update(f: FrameInfo): void {
    this.time = f.time;
    this.step(f.dt);
  }

  private get sublightActive(): boolean {
    const fl = this.flight;
    return this.drive === 'sublight' && !this.trip && (fl.autopilot || fl.beta > 1e-9 || (fl.manualBeta ?? 0) > 0);
  }

  private step(dt: number): void {
    const fl = this.flight;
    const inp = this.ctx.input;
    const nav = this.nav;
    if (this.autoEngage > 0) {
      this.autoEngage -= dt;
      if (this.autoEngage <= 0) {
        this.autoEngage = 0;
        if (!fl.autopilot && !this.trip && fl.beta < 1e-6) this.engage();
      }
    }
    // Throttle keys.
    const k = (c: string) => (inp.isDown(c) ? 1 : 0);
    const dth = (k('KeyW') + k('ArrowUp') - k('KeyS') - k('ArrowDown')) * dt;
    if (dth && !this.trip && this.view !== 'sky') {
      if (this.drive === 'sublight' && !fl.autopilot) {
        const b = THREE.MathUtils.clamp((fl.manualBeta ?? fl.beta) + dth * 0.25, 0, fl.betaCap);
        fl.manualBeta = b;
        this.ctl.speed?.set(b);
      } else if (this.drive === 'imagination') this.throttle = THREE.MathUtils.clamp(this.throttle + dth * 0.45, 0, 1);
    }
    // Steering (manual flight owns the attitude).
    const manual = !fl.autopilot && !this.trip && this.arrivedTurn <= 0;
    this.rig.enabled = manual && (this.view === 'chase' || this.view === 'cockpit');
    if (manual) {
      this.rig.quaternion.copy(nav.quaternion);
      this.rig.update(dt);
      nav.quaternion.copy(this.rig.quaternion);
      fl.quaternion.copy(nav.quaternion);
    } else this.rig.update(0);
    if (!fl.autopilot) fl.warp = this.warpManual;

    if (this.trip) {
      this.trip.step(dt, nav);
      this.speed = this.trip.speed;
      if (this.trip.done) {
        this.trip = null;
        this.speed = 0;
        settleFrame(nav, this.cosmos.children);
        this.onArrive();
      }
      fl.t += dt * TIME.DAY_YR;
      fl.tau += dt * TIME.DAY_YR;
    } else if (this.sublightActive) {
      fl.update(dt);
      nav.frame = this.cosmos.local;
      nav.position.copy(fl.position);
      nav.quaternion.copy(fl.quaternion);
      this.speed = fl.beta * SPEED_OF_LIGHT;
    } else {
      // Imagination drive, manual: speed ∝ distance to the nearest body.
      const want = this.drive === 'imagination' ? autoSpeed(this.dNearest, this.throttle) : 0;
      this.speed += (want - this.speed) * (1 - Math.exp(-dt / 0.35));
      if (this.speed > 1e-6) {
        const fwd = _v1.set(0, 0, -1).applyQuaternion(nav.quaternion).multiplyScalar(this.speed * dt);
        translateMetres(nav, fwd);
      }
      fl.t += dt * this.warpManual;
      fl.tau += dt * this.warpManual;
    }
    if (this.arrivedTurn > 0 && this.dest.star) {
      this.arrivedTurn -= dt;
      const c = this.local.destCenter(this.dest.star, _v1).sub(fl.position).normalize();
      fl.slewToward(c, dt * 0.8);
      nav.quaternion.copy(fl.quaternion);
    }
    settleFrame(nav, this.cosmos.children);
    if (!this.sublightActive) this.syncFlightFromNav();
    this.updateDerived();

    // Regimes.
    const L = this.local;
    L.fade = 1 - THREE.MathUtils.smoothstep(this.dSun, 70, 450);
    L.epoch = NOW_YEAR - 2000 + fl.t + this.deepTime;
    L.yearsFromNow = fl.t;
    const rel = this.relOn && this.drive === 'sublight' && !this.trip;
    if (rel) fl.velocity(this.beta);
    else this.beta.set(0, 0, 0);
    L.update(this.navLocal, this.beta, this.time);
    const consTarget = this.constellationsOn && L.fade > 0.5 ? 1 : 0;
    L.sky.constellations += (consTarget - L.sky.constellations) * (1 - Math.exp(-dt / 0.35));
    if (Math.abs(L.sky.constellations - consTarget) < 0.002) L.sky.constellations = consTarget;
    this.cosmos.manage(this.navRoot, dt, this.dSun > 3000 || !!this.trip);
    this.updateGalaxyWeights();
    this.updateNearest();
    this.updateLightsAndExposure(dt);
    this.ship.setThrust(this.trip ? 0.25 : this.sublightActive ? fl.thrust : Math.min(1, this.throttle));
    this.ship.setTime(this.time);
    this.updateAudio();
  }

  private updateDerived(): void {
    const cz = this.cosmos;
    convertPoint(this.nav.position, this.nav.frame, cz.local, this.navLocal);
    convertPoint(this.nav.position, this.nav.frame, cz.root, this.navRoot);
    this.dSun = this.navLocal.length();
  }

  /** Render weight of each galaxy: fade-in after construction, the local sky near the Sun, distance. */
  private updateGalaxyWeights(): void {
    const cz = this.cosmos;
    for (const g of cz.galaxies) {
      if (!g.layer || !g.ready) {
        g.weight = 0;
        continue;
      }
      const d = this.navRoot.distanceTo(g.frame.origin); // Mpc
      let w = THREE.MathUtils.smoothstep(g.age, 0, 1.2);
      w *= 1 - THREE.MathUtils.smoothstep(d, g.buildMpc * 0.7, g.buildMpc);
      if (g === cz.mwEntry) w *= THREE.MathUtils.smoothstep(this.dSun, 25, 320);
      g.weight = w;
    }
  }

  /** Distance to the nearest body (m) for the automatic speed. */
  private updateNearest(): void {
    const cz = this.cosmos;
    let d = Infinity;
    if (this.local.fade > 0.01) d = this.local.nearestStar * UNIT.PC;
    for (const g of cz.galaxies) {
      const gp = convertPoint(this.nav.position, this.nav.frame, g.frame, _v7);
      const r = gp.length();
      const R = g.radius;
      const inside = r < R && Math.abs(gp.y) < 1500;
      const s = inside ? (g === cz.mwEntry && this.dSun < 1000 ? Math.max(this.local.nearestStar, 0.3) : 1.2) : Math.max(r - R, 0.05 * R);
      d = Math.min(d, s * UNIT.PC);
    }
    const u = cz.universe;
    if (u.isReady) {
      for (const h of u.halos) {
        const r = Math.max(h.position.distanceTo(this.navRoot) - 0.25, 0.05);
        if (r * UNIT.MPC < d) d = r * UNIT.MPC;
      }
    }
    this.dNearest = Math.min(d, 400 * UNIT.MPC);
  }

  /**
   * Physical lighting and eye adaptation (Starflight): each nearby or bright star illuminates the hull
   * with E = 3.17·10^(−0.4 (m − 1)) · p_ref² display units. Exposure adapts to the total illuminance so a
   * sunlit hull reads as sunlit, while in deep space the eye is dark-adapted (exposure 1).
   */
  private updateLightsAndExposure(dt: number): void {
    const L = this.lights;
    L.length = 0;
    this.local.collectLights((dir, illum, T) => {
      const slot = this.lightPool[L.length] ?? (this.lightPool[L.length] = { dir: new THREE.Vector3(), illum: 0, temperature: 0 });
      slot.dir.copy(dir);
      slot.illum = illum;
      slot.temperature = T;
      L.push(slot);
    });
    L.sort((a, b) => b.illum - a.illum);
    let total = 0;
    for (const l of L) total += l.illum;
    const E_REF = 1.5;
    const target = total > E_REF ? Math.pow(E_REF / total, 0.9) : 1;
    const tau = target < this.exposure ? 0.35 : 1.4;
    this.exposure = Math.exp(Math.log(this.exposure) + (Math.log(target) - Math.log(this.exposure)) * (1 - Math.exp(-dt / tau)));
    if (!isFinite(this.exposure) || this.exposure <= 0) this.exposure = target;
    const e = this.exposure;
    if (L[0]) {
      blackbodyColor(L[0].temperature, this.keyColor).multiplyScalar(L[0].illum * e);
      this.ship.setKeyLight(L[0].dir, this.keyColor);
    } else this.ship.setKeyLight(_v1.set(0, 1, 0), this.keyColor.setRGB(0, 0, 0));
    if (L[1]) {
      blackbodyColor(L[1].temperature, this.fillColor).multiplyScalar(L[1].illum * e);
      this.ship.setFillLight(L[1].dir, this.fillColor);
    } else this.ship.setFillLight(_v1.set(0, -1, 0), this.fillColor.setRGB(0, 0, 0));
    this.local.sky.exposure = e;
    this.ship.exposure = e;
  }

  private updateAudio(): void {
    const b = this.flight.beta;
    if ((this.time * 4) % 1 < 0.02) {
      this.ctx.audio.setMood('voyage', { intensity: 0.25 + 0.6 * b + (this.trip ? 0.3 : 0), speed: b, gamma: this.flight.gamma, imagination: !!this.trip || this.speed > SPEED_OF_LIGHT });
    }
  }

  // ——— Rendering ———————————————————————————————————————————————————————————————

  resize(w: number, h: number): void {
    this.width = w;
    this.height = h;
    this.cosmos?.resize(w, h);
  }

  render(target: THREE.WebGLRenderTarget): void {
    const r = this.ctx.renderer;
    const eng = this.ctx.engine;
    const aspect = target.width / target.height;
    const fl = this.flight;
    const nav = this.nav;
    // Direction of travel (root axes) for the chase camera and the warp streaks.
    let travelDir: THREE.Vector3 | null = null;
    if (fl.autopilot && fl.destination && this.sublightActive) travelDir = _v1.copy(fl.destination).sub(fl.position).normalize();
    else if (this.trip && nav.velocity.lengthSq() > 0) travelDir = _v1.copy(nav.velocity).normalize();
    this.ship.group.quaternion.copy(nav.quaternion);
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
      this.shipCam.update(1 / 60, nav.quaternion, travelDir, this.ship.geometry.cockpit, aspect);
      cam = this.shipCam.camera;
      this.skyCam.fov = cam.fov;
      this.skyCam.aspect = aspect;
      this.skyCam.quaternion.copy(cam.quaternion);
      this.skyCam.position.set(0, 0, 0);
      this.skyCam.updateMatrixWorld();
      this.skyCam.updateProjectionMatrix();
    }
    const e = this.exposure;
    // Environment probe: the local sky as the ship sees it.
    if (this.view !== 'sky' && this.local.fade > 0.01) this.probe.update(r, (c) => this.local.sky.render(r, c, 0.5), this.time < 0.2 ? 6 : 1);
    r.setRenderTarget(target);
    // 1. The real sky of the solar neighbourhood (writes the background).
    this.local.renderSky(r, this.skyCam, eng.pixelRatio, eng.cssHeight);
    // 2. The cosmic web.
    const cz = this.cosmos;
    const dHome = this.navRoot.length();
    let dGal = Infinity;
    for (const g of cz.galaxies) dGal = Math.min(dGal, this.navRoot.distanceTo(g.frame.origin));
    const dm = THREE.MathUtils.smoothstep(dGal, 1.5, 10);
    cz.universe.render(target, this.navRoot, this.skyCam.quaternion, this.skyCam.fov, {
      darkMatter: dm,
      galaxies: 1,
      exposure: WEB_GAIN * e,
      nearFade: THREE.MathUtils.clamp(0.8 + 0.02 * dHome, 0.8, 2),
      pixelRatio: eng.pixelRatio,
    });
    // 3. Galaxies in full, farthest first (their dust extinguishes what lies behind).
    const order = cz.galaxies.filter((g) => g.weight > 0.001 && g.layer).sort((a, b) => this.navRoot.distanceToSquared(b.frame.origin) - this.navRoot.distanceToSquared(a.frame.origin));
    for (const g of order) {
      const lc = this.layerCam;
      convertPoint(nav.position, nav.frame, g.frame, _v2);
      lc.fov = this.skyCam.fov;
      lc.aspect = aspect;
      lc.near = 1e-4;
      lc.far = 1e8;
      lc.position.set(0, 0, 0);
      rootQuatToFrame(this.skyCam.quaternion, g.frame, lc.quaternion);
      lc.updateProjectionMatrix();
      lc.updateMatrixWorld();
      g.layer!.radianceScale = GALAXY_GAIN * g.params.look.exposure * g.weight * e;
      g.layer!.render(r, lc, target, { origin: _v2, exposure: 1, frame: this.ctx.engine.frame, pixelRatio: eng.pixelRatio });
    }
    // 4. Resolved nearby stars.
    r.setRenderTarget(target);
    this.local.renderNear(r, this.skyCam, eng.pixelRatio, target.width, target.height, e);
    // 5. The ship.
    if (this.view !== 'sky') {
      r.clearDepth();
      this.ship.pixelRatio = eng.pixelRatio;
      this.ship.updateShadow(r);
      r.setRenderTarget(target);
      const warpDir = travelDir ?? fl.forward(_v3);
      const imag = this.trip ? THREE.MathUtils.clamp(Math.log10(Math.max(this.speed / SPEED_OF_LIGHT, 1)) / 4, 0, 1) : this.speed > SPEED_OF_LIGHT ? 0.5 : 0;
      this.warpStrength += (imag - this.warpStrength) * 0.08;
      this.warp.update(1 / 60, warpDir, this.warpStrength, Math.max(e, 0.5));
      r.render(this.shipScene, cam);
    }
    this.updateHud(this.view === 'sky' ? this.skyCam : cam);
  }

  private updateHud(cam: THREE.Camera): void {
    const fl = this.flight;
    const eng = this.ctx.engine;
    // Readouts.
    const v = this.speed;
    if (this.sublightActive) {
      const b = fl.beta;
      if (b < 0.001) this.ro.speed.set(formatNumber(b * 299792.458, 3), 'km/s');
      else this.ro.speed.set(b > 0.99 ? b.toFixed(5) : b.toFixed(3), 'c');
      this.ro.gamma.set(fl.gamma < 1.001 ? '1.000' : formatNumber(fl.gamma, 4));
    } else {
      const c = v / SPEED_OF_LIGHT;
      if (v < 1) this.ro.speed.set('0', 'km/s');
      else if (c < 0.01) this.ro.speed.set(formatNumber(v / 1000, 3), 'km/s');
      else if (c < 1) this.ro.speed.set(c.toFixed(3), 'c');
      else this.ro.speed.set(c >= 1e4 ? formatScientific(c, 2) : formatNumber(c, 3), 'c · imagination');
      this.ro.gamma.set(c < 1 && c > 0.01 ? formatNumber(gammaOf(c), 4) : '—');
    }
    const tauF = formatDuration(fl.tau * YEAR, 3);
    this.ro.ship.set(`+${tauF.value}`, tauF.unit);
    const year = NOW_YEAR + fl.t;
    this.ro.earth.set(year < 1e5 ? year.toFixed(year - NOW_YEAR < 10 ? 2 : 1) : formatNumber(year, 4), 'CE');
    // Distance to the destination.
    const d = this.dest;
    const tgtFrame = this.destFrame(d);
    const tgtPos = this.destCenter(d, _v5);
    let distM = NaN;
    if (tgtFrame && tgtPos) {
      const lca = commonFrame(tgtFrame, this.nav.frame);
      const a = convertPoint(this.nav.position, this.nav.frame, lca, _v6);
      const b = convertPoint(tgtPos, tgtFrame, lca, _v7);
      distM = a.distanceTo(b) * lca.metres;
      const fd = distM < 0.1 * UNIT.LY || distM > 3e5 * UNIT.PC ? (distM > 3e5 * UNIT.PC ? formatParsecs(distM, 3) : formatDistance(distM, 3)) : formatDistance(distM, 3);
      this.ro.dist.set(fd.value, fd.unit);
    }

    // Flight status widget.
    const p = this.flightParts;
    const crumb = this.breadcrumb();
    if (p.crumb.textContent !== crumb) p.crumb.textContent = crumb;
    p.name.textContent = (this.trip && this.tripDest ? this.tripDest : d).name;
    let phase = '', eta = '';
    let progress = 0;
    if (this.trip) {
      phase = this.speed > SPEED_OF_LIGHT ? 'Imagination drive' : 'Autopilot';
      progress = this.trip.progress;
      eta = this.speed > SPEED_OF_LIGHT ? 'faster than light — not physics' : '';
    } else if (fl.autopilot && this.sublightActive) {
      const names: Record<string, string> = {
        align: 'Turning to the destination',
        accelerate: `Accelerating · ${fl.accelG.toFixed(fl.accelG < 1 ? 2 : 1)} g`,
        coast: `Coasting at ${fl.beta.toFixed(4)} c`,
        flip: 'Flip — turning to brake',
        brake: 'Braking',
      };
      phase = names[fl.phase] ?? fl.phase;
      progress = fl.progress;
      const tl = formatDuration(fl.estimateRemainingTau() * YEAR, 2);
      eta = `${tl.value} ${tl.unit} ship time to go\ntime warp ${describeWarp(fl.warp)}`;
    } else if (this.view === 'sky' && this.dSun < 1e-9) {
      phase = 'The sky from Earth';
      eta = `${this.local.cat.count.toLocaleString('en-US').replace(/,/g, ' ')} catalogued stars · parallax from here`;
    } else if (distM < (d.star ? d.star.standoffAU * AU_PC * 1.2 * UNIT.PC : 0) || (!d.star && distM < 1.2 * this.destScale(d))) {
      phase = 'Arrived';
      progress = 1;
      eta = d.kicker;
    } else {
      phase = this.speed > 1 ? (this.drive === 'imagination' ? `Throttle ${Math.round(this.throttle * 100)} %` : 'Manual flight') : 'Holding position';
      eta = `Enter to set course`;
    }
    p.tag.textContent = this.drive === 'imagination' ? 'Imagination drive' : this.relOn ? '' : 'Relativity off';
    if (p.phase.textContent !== phase) p.phase.textContent = phase;
    if (p.eta.textContent !== eta) p.eta.textContent = eta;
    p.bar.style.width = '100%';
    p.bar.style.transform = `scaleX(${THREE.MathUtils.clamp(progress, 0, 1).toFixed(3)})`;
    // Scale bar: a round length spanning at most 90 CSS px at the distance of the nearest body.
    const pxAngle = (2 * Math.tan(THREE.MathUtils.degToRad(this.skyCam.fov) / 2)) / eng.cssHeight;
    const ref = Math.max(this.dNearest, 1);
    const raw = ref * pxAngle * 90;
    const unit = SCALE_UNITS.reduce((u, x) => (raw >= x[1] ? x : u), SCALE_UNITS[0]);
    const n = niceScaleBar(raw / unit[1]);
    const px = (n * unit[1]) / (ref * pxAngle);
    const st = `${formatNumber(n, 3)} ${unit[0]}`;
    if (p.scale.textContent !== st) p.scale.textContent = st;
    p.scaleBar.style.width = `${px.toFixed(0)}px`;

    // Labels.
    const items = this.labelItems;
    items.length = 0;
    this.local.labels(this.labelPool, items, this.dSun > 1e-7);
    let k = items.length;
    const add = (dirRoot: THREE.Vector3, text: string, sub: string, pri: number, cool = false) => {
      if (k >= this.labelPool.length) return;
      const it = this.labelPool[k++];
      it.dir.copy(dirRoot);
      it.text = text;
      it.sub = sub;
      it.priority = pri;
      it.cool = cool;
      items.push(it);
    };
    // Galaxies and home.
    for (const g of this.cosmos.galaxies) {
      const gp = convertPoint(this.nav.position, this.nav.frame, g.frame, _v6);
      const r = gp.length();
      if (r < g.radius * 1.3 || (d.id === g.id || (d.id === 'milky-way' && g === this.cosmos.mwEntry) || (d.id === 'andromeda' && g === this.cosmos.m31Entry))) continue;
      const dirRoot = _v7.copy(gp).negate().normalize().applyQuaternion(g.frame.rootRotation);
      const fd = formatDistance(r * UNIT.PC, 3);
      add(dirRoot, g.name, `${fd.value} ${fd.unit}`, 40, g === this.cosmos.mwEntry);
    }
    let home: LabelItem | null = null;
    if (this.dSun > 1500 && this.navRoot.length() < 3) {
      home = this.homeLabel;
      home.dir.copy(this.navLocal).negate().normalize();
      home.text = 'You are here · the Sun';
      const fp = formatParsecs(this.dSun * UNIT.PC, 3);
      home.sub = `${fp.value} ${fp.unit} · Orion Spur`;
    }
    // Target reticle.
    let tgt: LabelItem | null = null;
    if (tgtFrame && tgtPos && isFinite(distM) && distM > 0) {
      const lca = commonFrame(tgtFrame, this.nav.frame);
      const a = convertPoint(this.nav.position, this.nav.frame, lca, _v6);
      const b = convertPoint(tgtPos, tgtFrame, lca, _v7);
      this.targetLabel.dir.copy(b.sub(a).normalize()).applyQuaternion(lca.rootRotation);
      this.targetLabel.text = d.name;
      const fd = distM > 3e5 * UNIT.PC ? formatParsecs(distM, 3) : formatDistance(distM, 3);
      this.targetLabel.sub = `${fd.value} ${fd.unit}`;
      tgt = this.targetLabel;
    }
    const reserved = this.reservedBoxes;
    reserved.length = 0;
    if (this.view === 'cockpit') reserved.push([eng.cssWidth * 0.18, eng.cssHeight * 0.76, eng.cssWidth * 0.82, eng.cssHeight]);
    else if (this.view !== 'sky') {
      const pc = cam as THREE.PerspectiveCamera;
      const c = _v3.set(0, 0, 0).applyMatrix4(pc.matrixWorldInverse);
      if (c.z < 0) {
        const dist = -c.z;
        c.applyMatrix4(pc.projectionMatrix);
        const sx = (c.x * 0.5 + 0.5) * eng.cssWidth, sy = (-c.y * 0.5 + 0.5) * eng.cssHeight;
        const rpx = ((this.ship.geometry.boundingRadius * 0.5) / dist) * (eng.cssHeight / 2) / Math.tan(THREE.MathUtils.degToRad(pc.fov) / 2);
        reserved.push([sx - rpx, sy - rpx * 0.7, sx + rpx, sy + rpx * 0.7]);
      }
    }
    this.hud.update(items, tgt, this.skyCam, eng.cssWidth, eng.cssHeight, reserved, home);
  }

  /** Frame and centre of a destination (for distance and the reticle). */
  private destFrame(d: ExplorerDest): Frame | null {
    if (d.star) return this.cosmos.local;
    if (d.id === 'milky-way') return this.cosmos.mw;
    if (d.id === 'andromeda') return this.cosmos.m31Entry.frame;
    if (d.id === 'cosmic-web') return this.cosmos.root;
    if (d.id === 'random-galaxy') return this.cosmos.visited?.frame ?? null;
    return null;
  }
  private destCenter(d: ExplorerDest, out: THREE.Vector3): THREE.Vector3 | null {
    if (d.star) return this.local.destCenter(d.star, out);
    return out.set(0, 0, 0);
  }
  private destScale(d: ExplorerDest): number {
    if (d.id === 'cosmic-web') return 400 * UNIT.MPC;
    return 80_000 * UNIT.PC;
  }

  private breadcrumb(): string {
    const parts: string[] = [];
    const cz = this.cosmos;
    const dHome = this.navRoot.length();
    for (const f of this.nav.frame.path()) {
      if (f === cz.root) {
        parts.push('Cosmic web');
        if (dHome < 2) parts.push('Local Group');
      } else parts.push(f.label);
    }
    return parts.join(' › ');
  }

  /** Debug: place the orbit camera (radians, metres). */
  orbitView(yaw: number, pitch: number, distance: number): void {
    this.setView('orbit');
    this.shipCam.orbit.set({ yaw, pitch, distance });
  }

  unmount(): void {
    this.local.dispose();
    this.cosmos.dispose();
    this.ship.dispose();
    this.probe.dispose();
    this.warp.dispose();
    this.hud.dispose();
  }
}

// ——— helpers ———

function commonFrame(a: Frame, b: Frame): Frame {
  const pa = a.path();
  const pb = b.path();
  let c = pa[0];
  for (let i = 0; i < Math.min(pa.length, pb.length) && pa[i] === pb[i]; i++) c = pa[i];
  return c;
}

/** Blackbody chromaticity (luminance 1) — CPU twin of BLACKBODY_GLSL. */
function blackbodyColor(Tin: number, out: THREE.Color): THREE.Color {
  const T = Math.min(Math.max(Tin, 800), 60000);
  const u = (0.860117757 + 1.54118254e-4 * T + 1.28641212e-7 * T * T) / (1 + 8.42420235e-4 * T + 7.08145163e-7 * T * T);
  const v = (0.317398726 + 4.22806245e-5 * T + 4.20481691e-8 * T * T) / (1 - 2.89741816e-5 * T + 1.61456053e-7 * T * T);
  const d = 2 * u - 8 * v + 4;
  const x = (3 * u) / d, y = (2 * v) / d;
  const X = x / y, Z = (1 - x - y) / y;
  return out.setRGB(Math.max(0, 3.2404542 * X - 1.5371385 - 0.4985314 * Z), Math.max(0, -0.969266 * X + 1.8760108 + 0.041556 * Z), Math.max(0, 0.0556434 * X - 0.2040259 + 1.0572252 * Z));
}

const SCALE_UNITS: Array<[string, number]> = [
  ['m', 1],
  ['km', 1e3],
  ['AU', UNIT.AU],
  ['ly', UNIT.LY],
  ['kly', 1e3 * UNIT.LY],
  ['Mly', 1e6 * UNIT.LY],
  ['Gly', 1e9 * UNIT.LY],
];

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
const _v6 = new THREE.Vector3();
const _v7 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();

void P_REF;

export default () => new Voyage();
