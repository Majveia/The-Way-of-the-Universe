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
import { Frame, UNIT, commonAncestor, convertPoint, makeNav, rebase, rootQuatToFrame, settleFrame, translateMetres, type NavState } from '../../worlds/explorer/frames';
import { Trip, autoSpeed, lookQuat, niceScaleBar, SPEED_OF_LIGHT } from '../../worlds/explorer/navigation';
import { procHostHint } from '../../worlds/explorer/hosts';
import { DESTINATIONS, type Destination } from './targets';
import { Hud, type LabelItem } from './hud';
import { WarpField } from './warp';
import { LocalSky, LY_PC, NOW_YEAR, type Light } from './localSky';
import { Cosmos, type GalaxyEntry } from './cosmos';
import { SolRegime } from './sol';
import { ProcSystem } from './systems';
import { SgrARegime, SGRA } from './sgra';
import { NebulaRegime } from './nebula';
import { R_EARTH_KM, type BodyEntry, type StarHint } from '../../worlds/systems';
import type { SolarBody } from '../../worlds/solar/SolarSystemModel';
import { J2000_JD } from '../../physics/constants';

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
/** Typical background radiance kept when surrounded by a galaxy's light (inside the disk). */
const INSIDE_LEVEL = 0.015;

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
  group: 'Solar System' | 'Stars' | 'Galaxies' | 'Universe';
  facts: Array<[string, string]>;
  body: string;
  /** Star destinations fly sub-light when that drive is selected. */
  star?: Destination;
  /** Frame whose origin is the destination (planets of other stars). */
  frameRef?: Frame;
  /** Chase-camera framing on arrival: distance (m), yaw and pitch offsets (rad). */
  chase?: [number, number, number];
  place(): Place | null;
}

class Voyage implements Experience {
  private ctx!: ExperienceContext;
  private local!: LocalSky;
  private cosmos!: Cosmos;
  private sol!: SolRegime;
  /** The procedural planetary system of the star we are at (or heading to), if any. */
  private proc: ProcSystem | null = null;
  private sgra!: SgrARegime;
  private neb!: NebulaRegime;
  private dRg = 1e12;
  private procStar = -1;
  /** Post exposure (set for star systems; other layers divide it back out). */
  private postE = 1;
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
  /** Debug: hold a trip at a fixed point (preview of transitions). */
  tripPaused = false;
  /** Frames during which eye adaptation jumps to its target (after a cut). */
  private snapFrames = 0;
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
  private arrivedId = '';
  private arrivedDist = 0;
  private skyLook = { yaw: 0, pitch: 0, frame: new THREE.Quaternion() };
  private autoEngage = 0;
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
  private caption!: { el: HTMLElement; title: HTMLElement; text: HTMLElement; t: number };
  /** The grand tour: a cinematic sequence of trips with captions. */
  private tour: { i: number; dwell: number; waiting: boolean } | null = null;
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
  private warpManual = 1 / (365.25 * 1440);
  private pushLight = (dir: THREE.Vector3, illum: number, T: number): void => {
    const L = this.lights;
    const slot = this.lightPool[L.length] ?? (this.lightPool[L.length] = { dir: new THREE.Vector3(), illum: 0, temperature: 0 });
    slot.dir.copy(dir);
    slot.illum = illum;
    slot.temperature = T;
    L.push(slot);
  };
  /** Real seconds of the current frame (render-side smoothing must not assume 60 fps). */
  private frameDt = 1 / 60;
  private audioTimer = 0;
  /** Probe draw callback (one closure for the experience's lifetime, not one per frame). */
  private drawProbeSky = (c: THREE.Camera): void => this.local.sky.render(this.ctx.renderer, c, 0.5);
  /** Galaxies drawn this frame, sorted far → near (reused). */
  private galaxyOrder: GalaxyEntry[] = [];
  private fartherFirst = (a: GalaxyEntry, b: GalaxyEntry): number => this.navRoot.distanceToSquared(b.frame.origin) - this.navRoot.distanceToSquared(a.frame.origin);
  /** Last values written to the flight widget's DOM (write only on change). */
  private hudCache: { bar: string; scale: string; crumbFrame: Frame | null; crumbHome: boolean } = { bar: '', scale: '', crumbFrame: null, crumbHome: false };
  /** HUD labels in use this frame (pool index). */
  private labelCount = 0;
  private addLabel = (dirRoot: THREE.Vector3, text: string, sub: string, pri: number, cool = false): void => {
    if (this.labelCount >= this.labelPool.length) return;
    const it = this.labelPool[this.labelCount++];
    it.dir.copy(dirRoot);
    it.text = text;
    it.sub = sub;
    it.priority = pri;
    it.cool = cool;
    this.labelItems.push(it);
  };
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
    this.sgra = new SgrARegime(ctx, this.cosmos.mw, (p, c) => this.cosmos.addChild(p, c));
    this.neb = new NebulaRegime(ctx);
    this.sol = new SolRegime(ctx, this.cosmos.local, (id) => this.selectBody(id), (p, c) => this.cosmos.addChild(p, c), JD0);
    this.ship = new Ship({ detail: Math.max(0.55, Math.min(1.3, q.detail)), shadowSize: q.detail >= 1 ? 2048 : 1024 });
    // Plume ray-march budget (max samples/pixel; the march adapts to ~4 samples per jet width).
    this.ship.plume.steps = q.detail >= 1 ? 24 : q.detail >= 0.7 ? 14 : 10;
    this.ship.plume.octaves = q.detail >= 1 ? 2 : 1;
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
    this.buildSolDestinations();
    for (const d of DESTINATIONS) {
      if (d.id === 'sun') continue;
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
        id: 'random-star',
        name: 'A random star system',
        kicker: 'Any star within 100 light-years — and its imagined planets',
        group: 'Stars',
        facts: [],
        body: 'A real star from the catalogue, chosen at random. Its planets are generated from physics — the Kroupa IMF, Hill-stable orbits, mass–radius relations, habitable zones — because we have not yet seen them.',
        place: () => null,
      },
      {
        id: 'orion',
        name: 'The Orion Nebula',
        kicker: 'M42 · stellar nursery · 1 344 ly',
        group: 'Stars',
        facts: [
          ['Distance', '412 pc (1 344 ly)'],
          ['Lit by', 'the Trapezium — O stars at ~39 000 K'],
          ['Colours', 'Hα 656 nm red · [O III] 501 nm teal · blue dust scattering'],
          ['Model', 'a generic star-forming region, not M42’s measured shape'],
        ],
        body: 'The nearest large nursery of stars, visible to the naked eye in Orion’s sword. Ultraviolet light from newborn massive stars ionises the gas; recombining hydrogen glows red, doubly ionised oxygen teal.',
        place: () => {
          const c = this.neb.position;
          const dir = _v1.copy(c).normalize();
          const side = _v2.set(0, 1, 0).cross(dir).normalize();
          const from = dir.clone().multiplyScalar(-0.9).addScaledVector(side, 0.35).add(_v3.set(0, 0.25, 0)).normalize();
          return { frame: this.cosmos.local, position: c.clone().addScaledVector(from, this.neb.half * 2.4), lookAt: c.clone(), scale: this.neb.half * UNIT.PC };
        },
      },
      {
        id: 'sgr-a',
        name: 'Sagittarius A*',
        kicker: 'The Milky Way’s central black hole · 4.3 million M☉',
        group: 'Galaxies',
        facts: [
          ['Mass', '4.3 × 10⁶ M☉ (stellar orbits, GRAVITY 2022)'],
          ['Horizon', '≈ 18 million km across (0.12 AU) at the spin drawn, a/M = 0.9'],
          ['Distance', '8.2 kpc (26 700 ly) from the Sun'],
          ['Disk', 'drawn bright to show the lensing — the real flow is faint'],
        ],
        body: 'Light bends around the hole: the sky of the galactic centre is lensed into rings, the far side of the disk lifts over the shadow, and the approaching side shines brighter by Doppler beaming.',
        place: () => {
          const dir = new THREE.Vector3(0.62, 0.2, 0.76).normalize();
          return { frame: this.sgra.frame, position: dir.multiplyScalar(48), lookAt: new THREE.Vector3(), scale: 25 * SGRA.rgMetres };
        },
      },
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
        chase: [70, 0.22, 0.1],
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
          const pos = new THREE.Vector3(0.62, 0.42, 0.66).normalize().multiplyScalar(box * 2.3);
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

  /** Destinations in our Solar System. */
  private buildSolDestinations(): void {
    const S = this.sol;
    const body = (id: string, k: number, az: number, el: number, facts: Array<[string, string]>, kicker?: string, body?: string) => {
      const b = S.body(id)!;
      this.dests.push({
        id,
        name: b.def.name,
        kicker: kicker ?? b.def.subtitle,
        group: 'Solar System',
        facts,
        body: body ?? b.def.blurb,
        place: () => this.placeBody(id, k, az, el),
      });
    };
    body('earth', 3.1, 62, 14, [
      ['Radius', '6 371 km'],
      ['Distance from the Sun', '1.00 AU · 8.3 light-minutes'],
      ['Atmosphere', 'N₂ 78 % · O₂ 21 % — Rayleigh-blue limb'],
    ], 'Home · the third planet');
    body('moon', 3.4, 70, 10, [
      ['Radius', '1 737 km'],
      ['Distance', '384 400 km · 1.28 light-seconds'],
      ['Rotation', 'tidally locked — one face to Earth'],
    ]);
    body('mars', 3.2, 60, 12, [
      ['Radius', '3 390 km'],
      ['Day', '24 h 37 min'],
      ['Air', 'CO₂, 0.6 % of Earth’s pressure; dust-pink sky'],
    ]);
    body('jupiter', 3.4, 58, 8, [
      ['Radius', '69 911 km · 11 Earths'],
      ['Mass', '318 Earths'],
      ['Day', '9 h 56 min'],
    ]);
    body('saturn', 5.2, 55, 18, [
      ['Radius', '58 232 km'],
      ['Rings', '≈ 280 000 km across, mostly < 100 m thick'],
      ['Density', '0.69 g/cm³ — less than water'],
    ]);
    this.dests.push(
      {
        id: 'sun',
        name: 'The Sun',
        kicker: 'Our star · G2V · 5 772 K',
        group: 'Solar System',
        facts: [
          ['Radius', '696 000 km · 109 Earths'],
          ['Surface', '5 772 K — granulation, sunspots, faculae'],
          ['Age', '4.6 Gyr'],
        ],
        body: 'An ordinary star, one of some two hundred billion in the Milky Way. Up close: convection cells the size of countries, dark spots where magnetic fields choke the flow of heat.',
        place: () => {
          const dir = new THREE.Vector3(0.4, 0.3, 0.85).normalize();
          return { frame: this.sol.frame, position: dir.multiplyScalar(0.04), lookAt: new THREE.Vector3(), scale: 7e8 };
        },
      },
      {
        id: 'solar-system',
        chase: [75, 0.42, 0.14],
        name: 'The Solar System',
        kicker: 'Eight planets and the Sun · seen from 50 AU',
        group: 'Solar System',
        facts: [
          ['Extent', 'Neptune at 30 AU; the Kuiper belt to ≈ 50 AU'],
          ['Light-time', '4.2 hours from the Sun to Neptune'],
          ['Scale', 'true — planets are points of light'],
        ],
        body: 'At true scale the planets are specks: their orbits trace the system’s plan, the Kuiper belt a faint ring of ice beyond Neptune.',
        place: () => {
          const pos = new THREE.Vector3(0.28, 0.87, 0.4).normalize().multiplyScalar(50);
          return { frame: this.sol.frame, position: pos, lookAt: new THREE.Vector3(), scale: 20 * UNIT.AU };
        },
      },
    );
  }

  /** A viewpoint near a Solar-System body: k radii out, az/el (deg) from the sub-solar direction. */
  private placeBody(id: string, k: number, azDeg: number, elDeg: number): Place | null {
    const b = this.sol.body(id);
    const f = this.sol.bodyFrames.get(id);
    if (!b || !f) return null;
    return placeAround(f, _v1.copy(b.position).negate().normalize(), b.def.radiusKm, k * this.fitScale(), azDeg, elDeg);
  }

  /** Destination for planet i of the current procedural system. */
  private procPlanetDest(i: number): ExplorerDest | null {
    const P = this.proc;
    if (!P) return null;
    const b = P.layer.bodies[i];
    const f = P.planetFrames[i];
    const d = b.data;
    const id = `${f.id}`;
    let dest = this.dests.find((x) => x.id === id);
    if (dest) return dest;
    dest = {
      id,
      frameRef: f,
      name: `${d.givenName}`,
      kicker: `${d.designation} · ${d.class.replace('-', ' ')} · ${formatNumber(d.orbit.a, 3)} AU from ${P.spec.name}`,
      group: 'Stars',
      facts: [
        ['Mass', `${formatNumber(d.mass, 3)} M⊕`],
        ['Radius', `${formatNumber(d.radius, 3)} R⊕`],
        ['Year', `${formatNumber(d.periodDays, 3)} days`],
        ['Temperature', `${formatNumber(d.surfaceTemp, 3)} K`],
        ['Habitable zone', String(d.hz)],
      ],
      body: `${d.description} Imagined: the planets of other stars here are generated from physics (Possible Worlds), not observed.`,
      place: () => {
        if (!this.proc || this.proc !== P) return null;
        const k = (d.spec.rings ? 5 : 3.2) * this.fitScale();
        return placeAround(f, _v1.copy(b.truePos).negate().normalize(), d.radius * R_EARTH_KM, k, 58, 14);
      },
    };
    this.dests.push(dest);
    return dest;
  }

  /** The planet of the current system most worth a visit (habitable, ringed, or the biggest). */
  private bestProcPlanet(): number {
    const P = this.proc;
    if (!P) return -1;
    let best = -1, score = -Infinity;
    P.layer.bodies.forEach((b, i) => {
      const d = b.data;
      const sc = (d.hz === 'habitable zone' ? 30 : d.hz.startsWith('optimistic') ? 15 : 0) + (d.spec.rings ? 20 : 0) + Math.log(d.radius + 1) * 4 + (d.atmosphere ? 5 : 0);
      if (sc > score) {
        score = sc;
        best = i;
      }
    });
    return best;
  }

  /** A body picked on screen (label or click): make it the destination. */
  private selectBody(id: string): void {
    let d = this.dests.find((x) => x.id === id);
    if (!d) {
      const b = this.sol.body(id);
      if (!b) return;
      const f = this.sol.bodyFrames.get(id);
      d = {
        id,
        name: b.def.name,
        kicker: b.def.subtitle,
        group: 'Solar System',
        facts: Object.entries(b.def.facts ?? {}).slice(0, 4) as Array<[string, string]>,
        body: b.def.blurb,
        place: () => {
          if (f) return this.placeBody(id, 4, 60, 12);
          // Minor bodies: a point 30 radii (≥ 2 000 km) sunward-off-axis, in the Sol frame.
          const r = Math.max(b.radius * 30, 2000 / 1.495978707e8);
          const dir = _v1.copy(b.position).negate().normalize().applyAxisAngle(_v2.set(0, 1, 0), 1).multiplyScalar(r);
          return { frame: this.sol.frame, position: b.position.clone().add(dir), lookAt: b.position.clone(), scale: Math.max(b.radius * UNIT.AU, 1e4) };
        },
      };
      this.dests.push(d);
    }
    this.setTarget(id);
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
    if (this.dest.id === 'random-star') {
      const i = this.randomStar();
      this.dest = this.makeStarDest(i);
      this.setDrive('imagination', true);
    }
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
      void this.cosmos.universe.start();
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
    this.ctx.ui.info(null);
    this.trip = new Trip(start, end, { lookAt: place.lookAt, startQuaternion: this.nav.quaternion, up: place.up, duration });
    this.tripDest = d;
    this.frameShip(d);
    if (this.drive !== 'imagination') this.setDrive('imagination', true);
    this.ctx.audio.event('warp');
    if (d) this.ctx.ui.toast(`Imagination drive · ${d.name}`);
  }

  // ——— Grand tour ————————————————————————————————————————————————————————————

  private static readonly TOUR: ReadonlyArray<{ id: string; title: string; text: string; dwell: number }> = [
    { id: 'earth', title: 'Earth', text: 'Home: a rocky world 12 742 km across under a hundred kilometres of air. Everything we know happened here.', dwell: 6 },
    { id: 'sun', title: 'The Sun', text: 'A sphere of plasma 1.4 million km across, 5 772 K at the surface. An ordinary star — one of two hundred billion.', dwell: 6 },
    { id: 'milky-way', title: 'The Milky Way', text: 'Our galaxy, 100 000 light-years across. The Sun circles its centre once every 220 million years.', dwell: 7 },
    { id: 'cosmic-web', title: 'The cosmic web', text: 'Every point of light is a galaxy. The glow is dark matter — gathered by gravity into filaments over 13.8 billion years.', dwell: 7 },
    { id: 'andromeda', title: 'Andromeda', text: 'The light arriving here left 2.5 million years ago. In some 4.5 billion years Andromeda and the Milky Way will merge.', dwell: 7 },
    { id: 'random-star', title: '', text: '', dwell: 4 },
    { id: 'planet', title: '', text: '', dwell: 8 },
  ];

  /** Earth → Sun → out of the Milky Way → the cosmic web → Andromeda → a random star → its planet. */
  startTour(): void {
    this.tour = { i: -1, dwell: 0, waiting: false };
    this.nextTourLeg();
  }

  endTour(): void {
    if (!this.tour) return;
    this.tour = null;
    this.showCaption('', '');
  }

  private nextTourLeg(): void {
    const T = this.tour!;
    T.i++;
    const legs = Voyage.TOUR;
    if (T.i >= legs.length) {
      this.showCaption('', '');
      this.tour = null;
      this.ctx.ui.toast('The grand tour is over — the universe is yours');
      return;
    }
    const leg = legs[T.i];
    T.dwell = leg.dwell;
    T.waiting = false;
    this.setDrive('imagination', true);
    if (leg.id === 'planet') {
      if (!this.planet(false)) T.i = legs.length - 1; // no planets: end after the star
      const d = this.dest;
      this.showCaption(d.name, `${d.kicker}. ${d.body.split('.')[0]}.`);
      return;
    }
    this.setTarget(leg.id, true);
    this.engage();
    if (leg.id === 'random-star') {
      const d = this.dest;
      this.showCaption(d.name, `A real star, ${d.kicker.split('·').pop()?.trim() ?? ''}. Its planets are imagined — generated from physics, not yet observed.`);
    } else this.showCaption(leg.title, leg.text);
  }

  private updateTour(dt: number): void {
    const T = this.tour;
    if (!T) return;
    if (this.trip || this.flight.autopilot) return;
    T.dwell -= dt;
    if (T.dwell <= 0) this.nextTourLeg();
  }

  private showCaption(title: string, text: string): void {
    const c = this.caption;
    if (!c) return;
    c.title.textContent = title;
    c.text.textContent = text;
    c.el.classList.toggle('on', !!(title || text));
  }

  stop(): void {
    this.trip = null;
    this.flight.disengage();
    this.flight.manualBeta = 0;
    this.throttle = 0;
    this.ctl.speed?.set(0);
  }

  private onArrive(): void {
    const ad = this.tripDest ?? this.dest;
    const f = this.destFrame(ad);
    const c = this.destCenter(ad, _v5);
    this.arrivedId = ad.id;
    this.arrivedDist = f && c ? convertPoint(this.nav.position, this.nav.frame, f, _v6).distanceTo(c) * f.metres : 0;
    this.arrivedTurn = this.trip ? 0 : 4.5;
    this.flight.manualBeta = null;
    this.ctl.speed?.set(0);
    this.ctx.audio.event('arrive');
    if (!this.tour) {
      this.ctx.ui.toast(`Arrived · ${(this.tripDest ?? this.dest).name}`);
      this.showInfo();
    }
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
    this.frameShip(d);
    this.shipCam.snap();
    this.snapFrames = 4;
    this.sol.snap = 4;
    this.updateDerived();
  }

  /** Portrait screens see less width: stand further back from round subjects. */
  private fitScale(): number {
    const a = this.ctx.engine.cssWidth / Math.max(1, this.ctx.engine.cssHeight);
    return a < 1 ? THREE.MathUtils.clamp(Math.pow(1 / a, 0.75), 1, 1.9) : 1;
  }

  /** Chase-camera framing for a destination: keep the ship off the subject. */
  private frameShip(d: ExplorerDest | null): void {
    const c = d?.chase ?? (d?.group === 'Solar System' || d?.frameRef ? [42, 0.3, 0.1] : d?.group === 'Stars' ? [38, 0.26, 0.06] : [50, 0.32, 0.1]);
    // Portrait screens: keep the subject centred and drop the ship lower instead of aside.
    const aspect = this.ctx.engine.cssWidth / Math.max(1, this.ctx.engine.cssHeight);
    const portrait = aspect < 1;
    this.shipCam.distance = c[0] * (portrait ? 0.9 : 1);
    this.shipCam.yawBias = portrait ? c[1] * 0.25 : c[1];
    this.shipCam.pitchBias = portrait ? c[2] - 0.16 : c[2];
  }

  /** Debug/tour: fly to (or jump to) the most interesting planet of the current star system. */
  planet(jump = false): boolean {
    const i = this.bestProcPlanet();
    const d = i >= 0 ? this.procPlanetDest(i) : null;
    if (!d) return false;
    this.dest = d;
    if (jump) {
      const p = d.place();
      if (!p) return false;
      this.nav.frame = p.frame;
      this.nav.position.copy(p.position);
      const dir = _v1.copy(p.lookAt ?? _v2.set(0, 0, 0)).sub(p.position).normalize().applyQuaternion(p.frame.rootRotation);
      lookQuat(dir, p.up ?? _v2.set(0, 1, 0), this.nav.quaternion);
      settleFrame(this.nav, this.cosmos.children);
      this.shipCam.snap();
      this.updateDerived();
    } else this.engage();
    return true;
  }

  /** Debug: start a trip to `id` and hold it at progress u (0..1) — for transition screenshots. */
  preview(id: string, u: number): void {
    this.go(id);
    if (!this.trip) return;
    this.trip.t = u * this.trip.duration;
    this.tripPaused = true;
  }
  /** Debug: release a held trip. */
  resume(): void {
    this.tripPaused = false;
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
      postE: this.postE,
      proc: this.proc ? { E: this.proc.exposure, op: this.proc.opacity, star: this.proc.sys.star, planets: this.proc.layer.bodies.map((b) => [b.data.letter, b.data.class, +b.data.orbit.a.toFixed(3), +b.irradiance.toFixed(4), b.data.albedo]) } : null,
      sol: { op: this.sol.opacity, E: this.sol.exposure },
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
    // Captions (grand tour): thin type, bottom-centre, fading.
    const cap = document.createElement('div');
    cap.className = 'vy-caption';
    cap.innerHTML = '<div class="vy-cap-t"></div><div class="vy-cap-x"></div>';
    ui.overlay.appendChild(cap);
    this.caption = { el: cap, title: cap.querySelector('.vy-cap-t') as HTMLElement, text: cap.querySelector('.vy-cap-x') as HTMLElement, t: 0 };
    const q = (s: string) => el.querySelector(s) as HTMLElement;
    this.flightParts = { crumb: q('.vy-fl-crumb'), name: q('.vy-fl-name'), phase: q('.vy-fl-phase'), bar: q('.vy-fl-bar i'), eta: q('.vy-fl-eta'), tag: q('.vy-fl-tag'), scale: q('.vy-fl-scale span'), scaleBar: q('.vy-fl-scale i') };
    this.flightParts.bar.style.width = '100%';

    const s1 = ui.section('Destination');
    const groups: Array<ExplorerDest['group']> = ['Solar System', 'Stars', 'Galaxies', 'Universe'];
    const opts = groups.flatMap((g) => this.dests.filter((d) => d.group === g).map((d) => ({ value: d.id, label: d.name })));
    this.ctl.target = s1.select<string>({ label: 'Go to', value: this.dest.id, options: opts, onChange: (v) => this.setTarget(v) });
    s1.buttons(
      [
        { label: 'Engage', onClick: () => this.engage() },
        { label: 'Stop', onClick: () => this.stop() },
        { label: 'Home', onClick: () => { this.setTarget('earth'); this.engage(); } },
      ],
      undefined,
    );
    s1.buttons([{ label: 'Grand tour', onClick: () => this.startTour() }], undefined);
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
      ['1min', 1 / (365.25 * 1440)],
      ['1h', TIME.HOUR_YR],
      ['1d', TIME.DAY_YR],
      ['1w', TIME.DAY_YR * 7],
      ['1mo', 1 / 12],
      ['1y', 1],
    ];
    this.ctl.warp = s4.select<string>({
      label: 'Time warp',
      value: '1min',
      options: [
        { value: 'real', label: 'Real time' },
        { value: '1min', label: '1 s = 1 minute' },
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
      { keys: 'Drag', label: 'Steer the ship (look around while the autopilot flies)' },
      { keys: 'Enter', label: 'Engage — fly to the destination' },
      { keys: ['W', 'S'], label: 'Throttle (speed scales with the distance to the nearest body)' },
      { keys: 'Tab', label: 'Next destination' },
      { keys: 'G', label: 'Grand tour' },
      { keys: 'I', label: 'Imagination drive / sub-light drive' },
      { keys: 'V', label: 'Chase · cockpit · orbit · sky view' },
      { keys: ['[', ']'], label: 'Time warp' },
      { keys: 'C', label: 'Constellations' },
      { keys: 'L', label: 'Names' },
      { keys: 'R', label: 'Special relativity on/off' },
      { keys: 'X', label: 'Stop' },
    ]);
    ui.hint('Drag to steer · W/S speed · Enter engage · Tab next destination · G grand tour · Ctrl K search · V view', 9000);
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
        case 'KeyG':
          if (this.tour) this.endTour();
          else this.startTour();
          break;
        case 'KeyX':
          this.endTour();
          this.stop();
          break;
        case 'BracketLeft':
        case 'BracketRight': {
          const order = ['real', '1min', '1h', '1d', '1w', '1mo', '1y'];
          const cur = order.indexOf(this.ctl.warp?.get() ?? '1min');
          const next = order[THREE.MathUtils.clamp(cur + (e.code === 'BracketRight' ? 1 : -1), 0, order.length - 1)];
          this.ctl.warp?.set(next);
          this.warpManual = [1 / (365.25 * 86400), 1 / (365.25 * 1440), TIME.HOUR_YR, TIME.DAY_YR, TIME.DAY_YR * 7, 1 / 12, 1][order.indexOf(next)];
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
    if (this.proc && this.proc.opacity > 0.5) {
      const pi = this.proc.pick(x, y, w, h);
      if (pi >= 0) {
        const d = this.procPlanetDest(pi);
        if (d) {
          this.dest = d;
          this.showInfo();
        }
        return;
      }
    }
    if (this.sol.layer && this.sol.opacity > 0.5) {
      const b = this.sol.layer.pick(x, y);
      if (b) {
        this.selectBody(b.id);
        return;
      }
    }
    const i = this.local.pick(x, y, cam, w, h);
    if (i >= 0) this.selectStar(i);
  }

  private selectStar(index: number): void {
    const known = this.dests.find((d) => d.star && this.local.findStar(d.star.star) === index);
    if (known) {
      this.setTarget(known.id);
      return;
    }
    this.dest = this.makeStarDest(index);
    this.showInfo();
  }

  private makeStarDest(index: number): ExplorerDest {
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
      standoffAU: THREE.MathUtils.clamp(2.2 * Math.sqrt(Math.pow(10, -0.4 * (L.cat.absMag[index] - 4.83))), Math.max(0.03, R * 0.0465 * 60), 25),
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
    return d;
  }

  /** A random nearby main-sequence star (4–30 pc) that is not already a named destination. */
  private randomStar(): number {
    const L = this.local;
    const c = L.cat;
    const cands: number[] = [];
    for (let i = 1; i < c.count; i++) {
      const d = c.distance[i];
      if (d < 4 || d > 30 || c.absMag[i] < 2 || c.absMag[i] > 10) continue;
      cands.push(i);
    }
    return cands[Math.floor(Math.random() * cands.length)] ?? 1;
  }

  // ——— Simulation ——————————————————————————————————————————————————————————————

  update(f: FrameInfo): void {
    this.time = f.time;
    this.frameDt = f.dt;
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
    // The Solar System's clock (Earth time of the voyage) moves the planets and their frames.
    const dSunAU0 = this.dSun / AU_PC;
    if (dSunAU0 < 20000) this.sol.setTime(JD0 + fl.t * 365.25);
    this.updateTour(dt);
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
      this.trip.step(this.tripPaused ? 0 : dt, nav);
      this.speed = this.trip.speed;
      if (this.trip.done) {
        this.trip = null;
        this.speed = 0;
        settleFrame(nav, this.cosmos.children);
        this.onArrive();
      }
      fl.t += dt * this.warpManual;
      fl.tau += dt * this.warpManual;
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
    const dSunAU = this.dSun / AU_PC;
    this.sol.manage(dSunAU);
    const L = this.local;
    L.sunWeight = 1 - this.sol.opacity;
    this.manageProc();
    this.dRg = convertPoint(this.nav.position, this.nav.frame, this.sgra.frame, _v7).length();
    this.sgra.manage(this.dRg);
    this.sgra.advance(dt * this.warpManual * YEAR);
    const tripId = this.trip && this.tripDest ? this.tripDest.id : '';
    this.neb.manage(this.navLocal.distanceTo(this.neb.position), tripId === 'orion', this.time);
    L.fade = 1 - THREE.MathUtils.smoothstep(this.dSun, 70, 450);
    L.epoch = NOW_YEAR - 2000 + fl.t + this.deepTime;
    L.yearsFromNow = fl.t;
    const rel = this.relOn && this.drive === 'sublight' && !this.trip;
    if (rel) fl.velocity(this.beta);
    else this.beta.set(0, 0, 0);
    L.update(this.navLocal, this.beta, this.time);
    L.sky.brightness = (this.view === 'sky' ? 2 : 1) * L.fade;
    const consTarget = this.constellationsOn && L.fade > 0.5 ? 1 : 0;
    L.sky.constellations += (consTarget - L.sky.constellations) * (1 - Math.exp(-dt / 0.35));
    if (Math.abs(L.sky.constellations - consTarget) < 0.002) L.sky.constellations = consTarget;
    // Heavy layers start lazily: the Galaxy once we leave the stars next door (or head out), Andromeda
    // and the cosmic web once we leave the Galaxy's disk (or head for them).
    const far = !!this.tripDest && (this.tripDest.group === 'Galaxies' || this.tripDest.group === 'Universe') && this.tripDest.id !== 'sgr-a';
    const outbound = !!this.trip && (far || this.tripDest?.id === 'sgr-a' || this.tripDest?.id === 'orion');
    this.cosmos.manage(this.navRoot, dt, { mw: this.dSun > 12 || outbound, m31: this.dSun > 3000 || (!!this.trip && far) });
    if (this.dSun > 3000 || (!!this.trip && far)) void this.cosmos.universe.start();
    this.updateGalaxyWeights();
    this.updateNearest();
    this.updateLightsAndExposure(dt);
    this.ship.setThrust(this.trip ? 0.25 : this.sublightActive ? fl.thrust : Math.min(1, this.throttle));
    this.ship.setTime(this.time);
    this.updateAudio();
  }

  /**
   * Keep a procedural planetary system for the catalogue star we are closest to (within 0.02 pc) or
   * flying to; drop it when we leave (beyond 0.08 pc).
   */
  private manageProc(): void {
    const L = this.local;
    let want = -1;
    const tripStar = this.trip && this.tripDest?.star ? L.findStar(this.tripDest.star.star) : -1;
    const destStar = this.dest.star ? L.findStar(this.dest.star.star) : -1;
    if (tripStar > 0) want = tripStar;
    else {
      let best = 0.02;
      for (const e of L.nearList) {
        if (e.index === 0) continue;
        const d = e.pos.distanceTo(this.navLocal);
        if (d < best) {
          best = d;
          want = e.index;
        }
      }
      if (want < 0 && destStar > 0 && L.starPos(destStar, _v1).distanceTo(this.navLocal) < 0.02) want = destStar;
    }
    // Hosts the generator cannot model faithfully (giants, white dwarfs) get no planets; the rest are
    // generated as main-sequence stars of the catalogue T_eff (see explorer/hosts.ts).
    const hint = want > 0 ? this.hostHint(want) : null;
    if (!hint) want = -1;
    if (this.proc && want !== this.procStar) {
      const d = L.starPos(this.procStar, _v1).distanceTo(this.navLocal);
      if (want >= 0 || d > 0.08) {
        if (this.nav.frame.isWithin(this.proc.frame)) rebase(this.nav, this.cosmos.local);
        this.proc.dispose();
        this.proc = null;
        this.procStar = -1;
      }
    }
    if (!this.proc && want > 0 && hint) {
      const inf = L.cat.info(want);
      this.proc = new ProcSystem(
        this.ctx,
        {
          id: `hyg${want}`,
          name: inf.proper || inf.designation || inf.name,
          parent: this.cosmos.local,
          position: L.starPos(want, new THREE.Vector3()),
          seed: (want * 7919 + 13) >>> 0,
          hint,
        },
        (p, c) => this.cosmos.addChild(p, c),
        (p, c) => this.cosmos.removeChild(p, c),
      );
      this.procStar = want;
    }
    if (this.proc) {
      // The star moves (proper motion); its planets orbit on system time.
      const e = L.nearList.find((x) => x.index === this.procStar);
      if (e) this.proc.frame.origin.copy(e.pos);
      else L.starPos(this.procStar, this.proc.frame.origin);
      this.proc.setTime(this.flight.t * 365.25 + (this.procStar % 97) * 3.1);
    }
  }

  /** Generator hint for catalogue star i (memoised; null = no planets modelled). */
  private hostHint(i: number): StarHint | null {
    let h = this.hostHints.get(i);
    if (h === undefined) this.hostHints.set(i, (h = procHostHint(this.local.cat.absMag[i], this.local.starInfo(i).temperature)));
    return h;
  }
  private hostHints = new Map<number, StarHint | null>();

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
      let w = this.ctx.engine.shotMode ? 1 : THREE.MathUtils.smoothstep(g.age, 0, 1.2);
      w *= 1 - THREE.MathUtils.smoothstep(d, g.buildMpc * 0.7, g.buildMpc);
      if (g === cz.mwEntry) w *= THREE.MathUtils.smoothstep(this.dSun, 25, 320);
      g.weight = w;
      this.adaptGalaxy(g);
    }
  }

  /**
   * Eye adaptation to a galaxy (after the Milky Way experience): surface brightness does not depend on
   * distance, so from inside the disk the whole sky glows as bright as the galaxy seen from afar.
   * Looking at a galaxy we adapt partially to its lit parts, (L_ref / L)^0.7; surrounded by it we keep
   * the typical background dark (INSIDE_LEVEL) so the band glows and the stars stand out, as in an
   * unprocessed dark-site photograph — continuous with the real sky of the solar neighbourhood.
   */
  private adaptGalaxy(g: GalaxyEntry): void {
    const m = g.layer!.meter;
    const s = Math.max(g.scaleUsed, 1e-12);
    let target = 1;
    if (Number.isFinite(m.lum) && m.lum > 0) {
      const lum = m.lum / s, sky = m.sky / s;
      const outside = THREE.MathUtils.clamp(Math.pow(1.08 / (lum * 0.1 * g.params.look.exposure), 0.7), 0.25, 1.1);
      const inside = Number.isFinite(sky) && sky > 0 ? THREE.MathUtils.clamp(INSIDE_LEVEL / (sky * 0.1 * g.params.look.exposure), 0.02, 1.5) : outside;
      target = THREE.MathUtils.lerp(outside, inside, THREE.MathUtils.smoothstep(m.lit, 0.85, 0.99));
    }
    const k = 1 - Math.exp(-this.frameDt / (this.ctx.engine.shotMode ? 0.15 : 1.1));
    g.adapt = Math.exp(Math.log(g.adapt) + (Math.log(target) - Math.log(g.adapt)) * k);
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
    if (this.dSun < 0.1) {
      convertPoint(this.nav.position, this.nav.frame, this.sol.frame, _v7);
      d = Math.min(d, this.sol.nearestSurfaceKm(_v7) * 1e3);
    }
    if (this.dRg < 1e7) d = Math.min(d, Math.max(this.dRg - 2, 0.5) * SGRA.rgMetres);
    if (this.proc) {
      convertPoint(this.nav.position, this.nav.frame, this.proc.frame, _v7);
      d = Math.min(d, this.proc.nearestSurfaceKm(_v7) * 1e3);
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
    this.local.collectLights(this.pushLight);
    L.sort(byIllum);
    let total = 0;
    for (const l of L) total += l.illum;
    const E_REF = 1.5;
    const target = total > E_REF ? Math.pow(E_REF / total, 0.9) : 1;
    // Stopping down is quick; dark adaptation is slow — except under the autopilot, where the view
    // must be readable at every scale of the trip.
    const tau = target < this.exposure ? 0.35 : this.trip ? 0.3 : 1.4;
    if (this.snapFrames > 0) {
      this.snapFrames--;
      this.exposure = target;
    }
    this.exposure = Math.exp(Math.log(this.exposure) + (Math.log(target) - Math.log(this.exposure)) * (1 - Math.exp(-dt / tau)));
    if (!isFinite(this.exposure) || this.exposure <= 0) this.exposure = target;
    const e = this.exposure;
    // Inside a star system the hull is lit on the same scale as the planets (irradiance relative to
    // the Sun at Earth, times the camera's exposure); in open space by Starflight's star fluxes.
    const po0 = this.proc?.opacity ?? 0;
    const sysW = Math.min(1, this.sol.opacity + po0);
    let eKey = e;
    if (sysW > 0.001 && L[0]) {
      let logS = 0;
      if (this.sol.opacity > 0) logS += this.sol.opacity * Math.log(Math.pow(Math.max(this.dSun / AU_PC, 0.005), -1.1));
      if (this.proc && po0 > 0) logS += po0 * Math.log(this.proc.irradianceAt(convertPoint(this.nav.position, this.nav.frame, this.proc.frame, _v7)));
      const want = (Math.exp(logS / sysW) * this.postE * 0.9) / Math.max(L[0].illum, 1e-30);
      eKey = Math.exp(THREE.MathUtils.lerp(Math.log(e), Math.log(want), sysW));
    }
    if (L[0]) {
      blackbodyColor(L[0].temperature, this.keyColor).multiplyScalar(L[0].illum * eKey);
      this.ship.setKeyLight(L[0].dir, this.keyColor);
    } else this.ship.setKeyLight(_v1.set(0, 1, 0), this.keyColor.setRGB(0, 0, 0));
    if (L[1]) {
      blackbodyColor(L[1].temperature, this.fillColor).multiplyScalar(L[1].illum * eKey);
      this.ship.setFillLight(L[1].dir, this.fillColor);
    } else this.ship.setFillLight(_v1.set(0, -1, 0), this.fillColor.setRGB(0, 0, 0));
    // Inside a star system the camera meters for the planets (post exposure); every other layer keeps
    // its own adaptation by dividing it back out. The sky then stays visible as in a long exposure.
    const po = this.proc?.opacity ?? 0;
    const so = Math.min(1, this.sol.opacity + po);
    this.postE = Math.exp(this.sol.opacity * Math.log(this.sol.exposure) + po * Math.log(this.proc?.exposure ?? 1));
    if (this.sgra.weight > 0) this.postE = Math.exp(THREE.MathUtils.lerp(Math.log(this.postE), Math.log(this.sgra.meterExposure(this.dRg)), this.sgra.weight));
    this.ctx.post.exposure = this.postE;
    this.local.sky.exposure = THREE.MathUtils.lerp(e, Math.max(e, 0.8), so) / this.postE;
    this.ship.exposure = e / this.postE;
  }

  private updateAudio(): void {
    const b = this.flight.beta;
    this.audioTimer -= this.frameDt;
    if (this.audioTimer <= 0) {
      this.audioTimer = 0.25;
      this.ctx.audio.setMood('voyage', { intensity: 0.25 + 0.6 * b + (this.trip ? 0.3 : 0), speed: b, gamma: this.flight.gamma, imagination: !!this.trip || this.speed > SPEED_OF_LIGHT });
    }
  }

  // ——— Rendering ———————————————————————————————————————————————————————————————

  resize(w: number, h: number): void {
    this.cosmos?.resize(w, h);
    this.sol?.resize(w, h);
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
    // (In the last stretch of a trip the ship turns to the view it will arrive at: follow its attitude.)
    else if (this.trip && this.trip.progress < 0.82 && nav.velocity.lengthSq() > 0) travelDir = _v1.copy(nav.velocity).normalize();
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
      this.shipCam.update(this.frameDt, nav.quaternion, travelDir, this.ship.geometry.cockpit, aspect);
      cam = this.shipCam.camera;
      this.skyCam.fov = cam.fov;
      this.skyCam.aspect = aspect;
      this.skyCam.quaternion.copy(cam.quaternion);
      this.skyCam.position.set(0, 0, 0);
      this.skyCam.updateMatrixWorld();
      this.skyCam.updateProjectionMatrix();
    }
    const e = this.exposure;
    // Off-screen passes first — the environment probe (the local sky as the ship sees it) and the
    // ship's shadow map — so the (multisampled) scene target is bound once and never has to be
    // stored and reloaded mid-frame (a full MSAA store + load per switch on tile-based GPUs).
    if (this.view !== 'sky' && this.local.fade > 0.01) this.probe.update(r, this.drawProbeSky, this.time < 0.2 ? 6 : 1);
    if (this.view !== 'sky') {
      this.ship.pixelRatio = eng.pixelRatio;
      this.ship.updateShadow(r);
    }
    r.setRenderTarget(target);
    // 1. The real sky of the solar neighbourhood (writes the background).
    this.local.renderSky(r, this.skyCam, eng.pixelRatio, eng.cssHeight);
    // 2. The cosmic web.
    const cz = this.cosmos;
    const bhFull = this.sgra.weight >= 0.999 && !this.sgra.needsCapture;
    const dHome = this.navRoot.length();
    let dGal = Infinity;
    for (const g of cz.galaxies) dGal = Math.min(dGal, this.navRoot.distanceTo(g.frame.origin));
    const dm = THREE.MathUtils.smoothstep(dGal, 1.5, 10);
    if (!bhFull) cz.universe.render(target, this.navRoot, this.skyCam.quaternion, this.skyCam.fov, {
      darkMatter: dm,
      galaxies: 1,
      exposure: (WEB_GAIN * e) / this.postE,
      nearFade: THREE.MathUtils.clamp(0.8 + 0.02 * dHome, 0.8, 2),
      pixelRatio: eng.pixelRatio,
    });
    // 3. Galaxies in full, farthest first (their dust extinguishes what lies behind).
    const order = this.galaxyOrder;
    order.length = 0;
    if (!bhFull) for (const g of cz.galaxies) if (g.weight > 0.001 && g.layer) order.push(g);
    if (order.length > 1) order.sort(this.fartherFirst);
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
      g.layer!.radianceScale = g.scaleUsed = (GALAXY_GAIN * g.params.look.exposure * g.adapt * g.weight * e) / this.postE;
      g.layer!.render(r, lc, target, { origin: _v2, exposure: 1, frame: this.ctx.engine.frame, pixelRatio: eng.pixelRatio });
    }
    // 3b. The Orion Nebula (its dust extinguishes what lies behind).
    if (this.neb.volume) this.neb.render(target, this.navLocal, this.skyCam.quaternion, this.skyCam.fov, e / this.postE, eng.pixelRatio);
    // 3c. Sgr A*: capture the galactic-centre sky once for the lens.
    if (this.sgra.needsCapture && cz.mwEntry.layer && cz.mwEntry.ready) {
      const g = cz.mwEntry;
      this.sgra.capture((c, rt) => {
        g.layer!.radianceScale = (GALAXY_GAIN * g.params.look.exposure * g.adapt * e) / this.postE;
        g.layer!.resetHistory();
        g.layer!.render(r, c, rt, { origin: _zero, exposure: 1, frame: 0, pixelRatio: 1 });
      });
      g.layer!.resetHistory();
      r.setRenderTarget(target);
    }
    // 4. Resolved nearby stars.
    r.setRenderTarget(target);
    this.local.renderNear(r, this.skyCam, eng.pixelRatio, target.width, target.height, e / this.postE);
    // 5. Our Solar System (planets resolved as they come near; labels; true scale).
    if (this.sol.layer) {
      const camSol = convertPoint(nav.position, nav.frame, this.sol.frame, _v4);
      const focus = nav.frame.kind === 'planet' && (nav.frame.data as SolarBody | undefined)?.def ? (nav.frame.data as SolarBody) : null;
      this.sol.update(camSol, this.skyCam.quaternion, this.skyCam.fov, this.time, this.frameDt, this.labelsOn, focus);
      this.sol.render(target);
    }
    // 5b. A procedural planetary system around another star.
    if (this.proc) {
      const camSys = convertPoint(nav.position, nav.frame, this.proc.frame, _v4);
      const focus = nav.frame.kind === 'planet' && nav.frame.parent === this.proc.frame ? (nav.frame.data as BodyEntry) : null;
      this.proc.update(camSys, this.skyCam.quaternion, this.skyCam.fov, aspect, target.height, this.time, focus);
      this.proc.render(target);
    }
    // 5c. Sagittarius A*: the Kerr ray tracer redraws the view near the hole.
    if (this.sgra.bh && this.sgra.weight > 0.001) {
      const camRg = convertPoint(nav.position, nav.frame, this.sgra.frame, _v4);
      rootQuatToFrame(this.skyCam.quaternion, this.sgra.frame, _q2);
      this.sgra.render(target, _q2, this.skyCam.fov, camRg, this.postE, this.ctx.engine.frame);
      r.setRenderTarget(target);
    }
    // 6. The ship (its shadow map was drawn before the scene target was bound).
    if (this.view !== 'sky') {
      r.setRenderTarget(target);
      r.clearDepth();
      const warpDir = travelDir ?? fl.forward(_v3);
      const imag = this.trip ? 0.42 * THREE.MathUtils.clamp(Math.log10(Math.max(this.speed / SPEED_OF_LIGHT, 1)) / 4, 0, 1) : this.speed > SPEED_OF_LIGHT ? 0.25 : 0;
      // (0.08 per frame at 60 fps, as a time constant: τ = 0.2 s at any frame rate)
      this.warpStrength += (imag - this.warpStrength) * (1 - Math.exp(-this.frameDt / 0.2));
      this.warp.update(this.frameDt, warpDir, this.warpStrength, Math.max(e, 0.5));
      r.render(this.shipScene, cam);
    }
    this.updateHud(this.view === 'sky' ? this.skyCam : cam);
    // Headless capture on a CPU rasteriser: keep rAF from running ahead of the GPU (never in normal use).
    if (eng.shotMode) r.getContext().finish();
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
    const nearHome = this.navRoot.length() < 2;
    if (this.hudCache.crumbFrame !== this.nav.frame || this.hudCache.crumbHome !== nearHome) {
      this.hudCache.crumbFrame = this.nav.frame;
      this.hudCache.crumbHome = nearHome;
      const crumb = this.breadcrumb();
      if (p.crumb.textContent !== crumb) p.crumb.textContent = crumb;
    }
    const nm = (this.trip && this.tripDest ? this.tripDest : d).name;
    if (p.name.textContent !== nm) p.name.textContent = nm;
    let phase = '', eta = '';
    let progress = 0;
    if (this.trip) {
      phase = this.speed > SPEED_OF_LIGHT ? 'Imagination drive' : 'Autopilot';
      progress = this.trip.progress;
      eta = this.speed > SPEED_OF_LIGHT ? 'faster than light — not physics' : '';
    } else if (fl.autopilot && this.sublightActive) {
      phase =
        fl.phase === 'align' ? 'Turning to the destination'
        : fl.phase === 'accelerate' ? `Accelerating · ${fl.accelG.toFixed(fl.accelG < 1 ? 2 : 1)} g`
        : fl.phase === 'coast' ? `Coasting at ${fl.beta.toFixed(4)} c`
        : fl.phase === 'flip' ? 'Flip — turning to brake'
        : fl.phase === 'brake' ? 'Braking'
        : fl.phase;
      progress = fl.progress;
      const tl = formatDuration(fl.estimateRemainingTau() * YEAR, 2);
      eta = `${tl.value} ${tl.unit} ship time to go\ntime warp ${describeWarp(fl.warp)}`;
    } else if (this.view === 'sky' && this.dSun < 1e-9) {
      phase = 'The sky from Earth';
      eta = `${this.local.cat.count.toLocaleString('en-US').replace(/,/g, ' ')} catalogued stars · parallax from here`;
    } else if (distM < (d.star ? d.star.standoffAU * AU_PC * 1.2 * UNIT.PC : 0) || (!d.star && this.arrivedId === d.id && distM < 1.5 * this.arrivedDist)) {
      phase = 'Arrived';
      progress = 1;
      eta = d.kicker;
    } else {
      phase = this.speed > 1 ? (this.drive === 'imagination' ? `Throttle ${Math.round(this.throttle * 100)} %` : 'Manual flight') : 'Holding position';
      eta = `Enter to set course`;
    }
    const tag = this.drive === 'imagination' ? 'Imagination drive' : this.relOn ? '' : 'Relativity off';
    if (p.tag.textContent !== tag) p.tag.textContent = tag;
    if (p.phase.textContent !== phase) p.phase.textContent = phase;
    if (p.eta.textContent !== eta) p.eta.textContent = eta;
    const barT = `scaleX(${THREE.MathUtils.clamp(progress, 0, 1).toFixed(3)})`;
    if (barT !== this.hudCache.bar) p.bar.style.transform = this.hudCache.bar = barT;
    // Scale bar: a round length spanning at most 90 CSS px at the distance of the nearest body.
    const pxAngle = (2 * Math.tan(THREE.MathUtils.degToRad(this.skyCam.fov) / 2)) / eng.cssHeight;
    const ref = Math.max(this.dNearest, 1);
    const raw = ref * pxAngle * 90;
    let unit = SCALE_UNITS[0];
    for (const x of SCALE_UNITS) if (raw >= x[1]) unit = x;
    const n = niceScaleBar(raw / unit[1]);
    const px = (n * unit[1]) / (ref * pxAngle);
    const st = `${formatNumber(n, 3)} ${unit[0]}`;
    if (p.scale.textContent !== st) p.scale.textContent = st;
    const sw = `${px.toFixed(0)}px`;
    if (sw !== this.hudCache.scale) p.scaleBar.style.width = this.hudCache.scale = sw;

    // Labels.
    const items = this.labelItems;
    items.length = 0;
    this.local.labels(this.labelPool, items, this.dSun > 1e-7 && this.sol.opacity < 0.5);
    this.labelCount = items.length;
    const add = this.addLabel;
    // Planets of a procedural system.
    const P = this.proc;
    if (P && P.opacity > 0.5) {
      const cs = convertPoint(this.nav.position, this.nav.frame, P.frame, _v6);
      for (const b of P.layer.bodies) {
        const rel = _v7.copy(b.truePos).sub(cs);
        const dist = rel.length();
        const R = (b.data.radius * R_EARTH_KM) / (UNIT.AU / 1e3);
        if (dist < 25 * R) continue;
        rel.divideScalar(dist).applyQuaternion(P.frame.rootRotation);
        const fd = formatDistance(dist * UNIT.AU, 3);
        add(rel, b.data.givenName, `${fd.value} ${fd.unit}`, 20);
      }
    }
    // Galaxies and home (not while the lensed sky of Sgr A* fills the view).
    for (const g of this.cosmos.galaxies) {
      if (this.sgra.weight > 0.5) break;
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
    } else if (this.navRoot.length() > 3) {
      home = this.homeLabel;
      home.dir.copy(this.navRoot).negate().normalize();
      home.text = 'You are here · the Local Group';
      const fp = formatParsecs(this.navRoot.length() * UNIT.MPC, 3);
      home.sub = `${fp.value} ${fp.unit}`;
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
      // No reticle on a target that already fills a good part of the view.
      const pxPerRad = eng.cssHeight / (2 * Math.tan(THREE.MathUtils.degToRad(this.skyCam.fov) / 2));
      if ((this.destRadius(d) / distM) * pxPerRad < 36) tgt = this.targetLabel;
    }
    const reserved = this.reservedBoxes;
    reserved.length = 0;
    // Keep star names off the disc of the planet we are at.
    if (this.nav.frame.kind === 'planet') {
      const fd = this.nav.frame.data as { def?: { radiusKm: number }; data?: { radius: number } } | undefined;
      const Rkm = fd?.def ? fd.def.radiusKm : fd?.data ? fd.data.radius * R_EARTH_KM : 0;
      const dist = this.nav.position.length();
      if (Rkm > 0 && dist > Rkm) {
        const dir = _v6.copy(this.nav.position).negate().normalize().applyQuaternion(this.nav.frame.rootRotation).applyMatrix3(_m3.setFromMatrix4(this.skyCam.matrixWorldInverse));
        if (dir.z < 0) {
          const ang = Math.asin(Math.min(1, (Rkm * (fd?.data && (fd.data as { spec?: { rings?: { outer: number } } }).spec?.rings ? 2.3 : 1.05)) / dist));
          const f = eng.cssHeight / (2 * Math.tan(THREE.MathUtils.degToRad(this.skyCam.fov) / 2));
          const cx = eng.cssWidth / 2 + (dir.x / -dir.z) * f, cy = eng.cssHeight / 2 - (dir.y / -dir.z) * f;
          const rp = Math.tan(Math.min(ang, 1.4)) * f * 1.05;
          reserved.push([cx - rp, cy - rp, cx + rp, cy + rp]);
        }
      }
    }
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
    if (d.frameRef) return d.frameRef.disposed ? null : d.frameRef;
    if (d.star) return this.cosmos.local;
    if (d.group === 'Solar System') return this.sol.bodyFrames.get(d.id) ?? this.sol.frame;
    if (d.id === 'milky-way') return this.cosmos.mw;
    if (d.id === 'andromeda') return this.cosmos.m31Entry.frame;
    if (d.id === 'sgr-a') return this.sgra.frame;
    if (d.id === 'orion') return this.cosmos.local;
    if (d.id === 'cosmic-web') return this.cosmos.root;
    if (d.id === 'random-galaxy') return this.cosmos.visited?.frame ?? null;
    return null;
  }
  private destCenter(d: ExplorerDest, out: THREE.Vector3): THREE.Vector3 | null {
    if (d.star) return this.local.destCenter(d.star, out);
    if (d.id === 'orion') return out.copy(this.neb.position);
    if (d.group === 'Solar System' && !this.sol.bodyFrames.has(d.id)) {
      const b = this.sol.body(d.id);
      if (b) return out.copy(b.position);
    }
    return out.set(0, 0, 0);
  }

  /** Physical radius (m) of a destination, for deciding whether it needs a reticle. */
  private destRadius(d: ExplorerDest): number {
    if (d.id === 'milky-way') return this.cosmos.mwEntry.radius * UNIT.PC;
    if (d.id === 'andromeda') return this.cosmos.m31Entry.radius * UNIT.PC;
    if (d.id === 'random-galaxy') return (this.cosmos.visited?.radius ?? 20000) * UNIT.PC;
    if (d.id === 'cosmic-web') return (this.cosmos.universe.boxMpc || 300) * 0.5 * UNIT.MPC;
    if (d.id === 'orion') return this.neb.half * UNIT.PC;
    if (d.id === 'sgr-a') return 6 * SGRA.rgMetres;
    if (d.group === 'Solar System') {
      const b = this.sol.body(d.id);
      if (b) return b.def.radiusKm * 1e3;
      if (d.id === 'solar-system') return 30 * UNIT.AU;
    }
    if (d.frameRef) {
      const b = d.frameRef.data as BodyEntry | undefined;
      if (b?.data) return b.data.radius * R_EARTH_KM * 1e3;
    }
    return 0;
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
    return (parts.length > 3 ? ['…', ...parts.slice(-3)] : parts).join(' › ');
  }

  /** Debug: place the orbit camera (radians, metres). */
  orbitView(yaw: number, pitch: number, distance: number): void {
    this.setView('orbit');
    this.shipCam.orbit.set({ yaw, pitch, distance });
  }

  unmount(): void {
    this.local.dispose();
    this.cosmos.dispose();
    this.sol.dispose();
    this.proc?.dispose();
    this.sgra.dispose();
    this.neb.dispose();
    this.ship.dispose();
    this.probe.dispose();
    this.warp.dispose();
    this.hud.dispose();
    this.caption.el.remove();
  }
}

// ——— helpers ———

/** Lowest common frame of two frames (every frame hangs off the universe root). */
function commonFrame(a: Frame, b: Frame): Frame {
  return commonAncestor(a, b) ?? a.path()[0];
}

/** A viewpoint k radii from a body (frame km, centred on it): azimuth/elevation (deg) from the star direction. */
function placeAround(f: Frame, starDir: THREE.Vector3, radiusKm: number, k: number, azDeg: number, elDeg: number): Place {
  const up = new THREE.Vector3(0, 1, 0);
  const side = new THREE.Vector3().crossVectors(starDir, up).normalize();
  const az = THREE.MathUtils.degToRad(azDeg), el = THREE.MathUtils.degToRad(elDeg);
  const dir = new THREE.Vector3().copy(starDir).multiplyScalar(Math.cos(az)).addScaledVector(side, Math.sin(az)).multiplyScalar(Math.cos(el)).addScaledVector(up, Math.sin(el)).normalize();
  return { frame: f, position: dir.multiplyScalar(radiusKm * k), lookAt: new THREE.Vector3(), scale: radiusKm * 1e3 * 1.5, up: up.applyQuaternion(f.rootRotation) };
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

/** Julian date (UTC) of the voyage's "now" (NOW_YEAR, 2026 Sep 23). */
const JD0 = J2000_JD + (NOW_YEAR - 2000) * 365.25;

const SCALE_UNITS: Array<[string, number]> = [
  ['m', 1],
  ['km', 1e3],
  ['AU', UNIT.AU],
  ['ly', UNIT.LY],
  ['kly', 1e3 * UNIT.LY],
  ['Mly', 1e6 * UNIT.LY],
  ['Gly', 1e9 * UNIT.LY],
];

const byIllum = (a: Light, b: Light): number => b.illum - a.illum;
const _zero = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
const _v6 = new THREE.Vector3();
const _v7 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _m3 = new THREE.Matrix3();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();


export default () => new Voyage();
