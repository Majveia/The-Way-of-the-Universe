import type { PotentialComponent } from '../../physics/galaxyPotential';
import { milkyWayComponents, SUN_GALACTIC } from '../../physics/galaxyPotential';
import { hash2u, u01, next } from './hash';

/**
 * Galaxy parameters and the Hubble-sequence presets.
 *
 * Frames. The "model frame" is a right-handed disk frame with azimuth φ increasing in the
 * direction of rotation, (X, Y) = (R cos φ, R sin φ), H = height above the mid-plane.
 * Rendering (three.js, y-up, parsecs): x = X, y = H, z = −spin·Y. With spin = +1 the galaxy turns
 * counter-clockwise seen from +y; the Milky Way (spin −1) turns clockwise seen from the north
 * galactic pole, exactly as observed. For the Milky Way preset the render frame is the
 * astropy-style galactocentric frame mapped through `astroToThree`: the Sun sits at
 * (−8200, +20.8, 0) pc, +x points from the Sun to the Galactic Centre and +y to the NGP,
 * so galactic longitude l = 90° (the direction of rotation) is −z.
 * The pattern frame rotates with the spiral pattern speed Ωp; arm azimuths are given there at t = 0.
 */

export type MorphologyId = 'milkyway' | 'E0' | 'E5' | 'S0' | 'Sa' | 'Sb' | 'Sc' | 'SBb' | 'SBc' | 'Irr';

export interface ArmSpec {
  name?: string;
  /** Pitch angle in degrees (trailing arms). */
  pitchDeg: number;
  /** Pattern-frame azimuth (rad) at radius r0. Arm locus: φ(R) = phase − ln(R/r0)/tan(pitch). */
  phase: number;
  r0: number;
  rStart: number;
  rEnd: number;
  /** 0..1 — gas, dust and star formation along this arm. */
  strength: number;
  /** Gaussian σ of the gas arm as a fraction of R. */
  width: number;
}

export interface GalaxyParams {
  id: MorphologyId;
  label: string;
  /** Hubble / de Vaucouleurs class for the readout. */
  hubble: string;
  seed: number;
  /** +1: counter-clockwise seen from +y; −1: clockwise (Milky Way). */
  spin: 1 | -1;
  potential: PotentialComponent[];
  /** Radius of the visible galaxy (pc): bounds for lookup tables, maps and the volume. */
  rMax: number;
  /** Half-thickness of the ray-marched volume (pc). */
  zMax: number;
  disk: {
    lum: number; // L☉ in the thin (old + intermediate) disk
    scaleLength: number;
    scaleHeight: number;
    truncation: number;
    sigmaR: number; // km/s radial dispersion at R = 3.15 R_d
    colorT: number;
    thickLum: number;
    thickScaleLength: number;
    thickScaleHeight: number;
    thickSigmaR: number;
    thickColorT: number;
    /** e-folding radius of scale-height flaring (0 = none). */
    flare: number;
  };
  bulge: { lum: number; a: number; flatten: number; colorT: number; rotation: number; rMaxFactor: number };
  bar: {
    lum: number;
    halfLength: number;
    axisRatio: number;
    /** 0..1 — fraction of bar orbits on peanut ("banana") vertical orbits. */
    peanut: number;
    patternSpeed: number; // km/s/kpc
    angle: number; // model-frame azimuth of the major axis at t = 0
    strength: number; // 0..1
    colorT: number;
  };
  spiral: {
    /** m of the kinematic (old-star) density wave; 0 = none. */
    arms: number;
    pitchDeg: number;
    patternSpeed: number; // km/s/kpc
    /** Pattern-frame azimuth (rad) of arm 0 at radius r0. */
    phase: number;
    r0: number;
    /** Epicycle amplitude A0 = X/R of the organised (density-wave) motion. */
    amplitude: number;
    rInner: number;
    rOuter: number;
    /** 0..1 — short, broken arm segments and spurs (flocculent spirals). */
    flocculence: number;
    /** Explicit gas/young arms (Milky Way). Otherwise `arms` symmetric arms are used. */
    armList?: ArmSpec[];
  };
  young: {
    lum: number; // L☉ of the OB population averaged over a cycle
    scaleLength: number;
    rInner: number;
    rOuter: number;
    scaleHeight: number;
    /** 0 = no star formation … 1 = typical for the type. Live multiplier lives in the layer. */
    sfr: number;
    /** 0..1 — how much of the star formation happens in arms (vs. scattered/flocculent). */
    armFraction: number;
    colorT: number;
  };
  gas: {
    /** Face-on V-band optical depth of the smooth dust disk extrapolated to R = 0. */
    dust: number;
    dustScaleLength: number;
    dustScaleHeight: number;
    /** Extra optical depth in arm dust lanes (peak τ_V). */
    dustLane: number;
    /** Radius inside which dust and gas are depleted (bar-swept region), pc. */
    dustHole: number;
    /** HII/Hα emission strength. */
    hii: number;
    /** Radius (pc) of a nuclear star-forming ring (0 = none). */
    nuclearRing: number;
  };
  halo: { lum: number; rMin: number; rMax: number; flatten: number };
  globulars: { count: number; rCore: number; rMax: number };
  warp: { amplitude: number; rStart: number; nodeAngle: number };
  /** Irregulars: clumpy, lopsided light (0..1). */
  clumpiness: number;
  /** Look. */
  look: { exposure: number; viewDistance: number };
  /** The Sun (Milky Way only). */
  sun?: { R: number; z: number; phi: number; U: number; V: number; W: number };
}

const deg = Math.PI / 180;

function nfw(Ms: number, rs: number): PotentialComponent {
  return { kind: 'nfw', name: 'dark halo', Ms, rs, dark: true };
}

/** The Milky Way (SBbc), assembled from the references in physics/galaxyPotential.ts. */
export function milkyWay(seed = 1): GalaxyParams {
  // Arm crossings of the Sun–Galactic-Centre line (β = 0) follow the maser-parallax fits of
  // Reid et al. (2014, 2019): Scutum–Centaurus 5.4 kpc, Sagittarius–Carina 6.9 kpc, Local (Orion)
  // 8.5 kpc, Perseus ≈ 10 kpc, Outer ≈ 13 kpc. Model azimuth φ = π + β.
  const pitch = 12;
  const armList: ArmSpec[] = [
    { name: 'Scutum–Centaurus', pitchDeg: pitch, phase: Math.PI, r0: 5430, rStart: 3300, rEnd: 17500, strength: 1, width: 0.045 },
    { name: 'Perseus', pitchDeg: pitch, phase: 2 * Math.PI, r0: 5430, rStart: 3300, rEnd: 18500, strength: 1, width: 0.05 },
    { name: 'Sagittarius–Carina', pitchDeg: pitch, phase: Math.PI, r0: 6870, rStart: 3600, rEnd: 15500, strength: 0.72, width: 0.04 },
    { name: 'Norma–Outer', pitchDeg: pitch, phase: 2 * Math.PI, r0: 6870, rStart: 3400, rEnd: 17500, strength: 0.72, width: 0.042 },
    { name: 'Orion Spur', pitchDeg: 11.4, phase: Math.PI, r0: 8530, rStart: 7300, rEnd: 9900, strength: 0.42, width: 0.03 },
  ];
  return {
    id: 'milkyway',
    label: 'Milky Way',
    hubble: 'SBbc',
    seed,
    spin: -1,
    potential: milkyWayComponents(),
    rMax: 26000,
    zMax: 4200,
    disk: {
      lum: 1.6e10,
      scaleLength: 2600,
      scaleHeight: 300,
      truncation: 20000,
      sigmaR: 35,
      colorT: 5200,
      thickLum: 2.5e9,
      thickScaleLength: 2000,
      thickScaleHeight: 900,
      thickSigmaR: 60,
      thickColorT: 4750,
      flare: 11000,
    },
    bulge: { lum: 3e9, a: 450, flatten: 0.8, colorT: 4250, rotation: 0.7, rMaxFactor: 8 },
    bar: {
      lum: 6.5e9,
      halfLength: 5000,
      axisRatio: 0.32,
      peanut: 0.55,
      patternSpeed: 39, // Portail et al. 2017; Sanders, Smith & Evans 2019
      angle: Math.PI + 27 * deg, // near end at l > 0, 27° from the Sun–GC line (Wegg et al. 2015)
      strength: 1,
      colorT: 4300,
    },
    spiral: {
      arms: 2,
      pitchDeg: pitch,
      patternSpeed: 25,
      phase: Math.PI,
      r0: 5430,
      amplitude: 0.032,
      rInner: 3300,
      rOuter: 18000,
      flocculence: 0.35,
      armList,
    },
    young: { lum: 9e9, scaleLength: 3500, rInner: 3000, rOuter: 17000, scaleHeight: 70, sfr: 1, armFraction: 0.82, colorT: 13000 },
    gas: { dust: 1.25, dustScaleLength: 5000, dustScaleHeight: 95, dustLane: 3.2, dustHole: 2600, hii: 1, nuclearRing: 230 },
    halo: { lum: 6e7, rMin: 1500, rMax: 70000, flatten: 0.65 },
    globulars: { count: 150, rCore: 1200, rMax: 40000 },
    warp: { amplitude: 1400, rStart: 11000, nodeAngle: Math.PI + 17.5 * deg },
    clumpiness: 0.15,
    look: { exposure: 1, viewDistance: 32000 },
    sun: { R: SUN_GALACTIC.R, z: SUN_GALACTIC.z, phi: Math.PI, U: SUN_GALACTIC.U, V: SUN_GALACTIC.V, W: SUN_GALACTIC.W },
  };
}

/** Common skeleton for external galaxies. */
function base(id: MorphologyId, label: string, hubble: string, seed: number): GalaxyParams {
  const mw = milkyWay(seed);
  return {
    ...mw,
    id,
    label,
    hubble,
    spin: 1,
    sun: undefined,
    warp: { amplitude: 0, rStart: 12000, nodeAngle: 0 },
    spiral: { ...mw.spiral, armList: undefined, phase: 0, r0: 4000 },
    bar: { ...mw.bar, lum: 0, strength: 0, angle: 0.4 },
    look: { exposure: 1, viewDistance: 34000 },
  };
}

export function preset(id: MorphologyId, seed = 1): GalaxyParams {
  switch (id) {
    case 'milkyway':
      return milkyWay(seed);
    case 'E0':
    case 'E5': {
      const p = base(id, id === 'E0' ? 'Elliptical E0' : 'Elliptical E5', id, seed);
      const flat = id === 'E0' ? 1 : 0.5;
      p.potential = [
        { kind: 'point', name: 'black hole', M: 1.5e9, soft: 1 },
        { kind: 'hernquist', name: 'stars', M: 2.2e11, a: 2800 },
        nfw(2.2e12, 45000),
      ];
      p.rMax = 36000;
      p.zMax = 30000;
      p.disk = { ...p.disk, lum: 0, thickLum: 0 };
      p.bulge = { lum: 9e10, a: 2800, flatten: flat, colorT: 4100, rotation: id === 'E0' ? 0 : 0.35, rMaxFactor: 11 };
      p.spiral = { ...p.spiral, arms: 0, amplitude: 0, flocculence: 0 };
      p.young = { ...p.young, lum: 0, sfr: 0 };
      p.gas = { ...p.gas, dust: 0, dustLane: 0, hii: 0, nuclearRing: 0 };
      p.halo = { lum: 2e9, rMin: 4000, rMax: 90000, flatten: flat * 0.9 + 0.1 };
      p.globulars = { count: 700, rCore: 4000, rMax: 70000 };
      p.look = { exposure: 0.9, viewDistance: 70000 };
      return p;
    }
    case 'S0': {
      const p = base(id, 'Lenticular S0', 'S0', seed);
      p.potential = [
        { kind: 'point', name: 'black hole', M: 1e8, soft: 1 },
        { kind: 'hernquist', name: 'bulge', M: 4e10, a: 1100 },
        { kind: 'mn', name: 'disk', M: 6e10, a: 3200, b: 350 },
        nfw(9e11, 20000),
      ];
      p.rMax = 26000;
      p.zMax = 7000;
      p.disk = { ...p.disk, lum: 3.2e10, scaleLength: 3000, scaleHeight: 420, sigmaR: 60, colorT: 4700, thickLum: 4e9, thickColorT: 4500, flare: 0 };
      p.bulge = { lum: 2.4e10, a: 1100, flatten: 0.72, colorT: 4200, rotation: 0.6, rMaxFactor: 9 };
      p.spiral = { ...p.spiral, arms: 0, amplitude: 0, flocculence: 0 };
      p.young = { ...p.young, lum: 0, sfr: 0 };
      p.gas = { ...p.gas, dust: 0.18, dustLane: 0, hii: 0, dustHole: 5500, nuclearRing: 0, dustScaleLength: 3000 };
      p.look = { exposure: 0.95, viewDistance: 40000 };
      return p;
    }
    case 'Sa':
    case 'Sb':
    case 'Sc':
    case 'SBb':
    case 'SBc': {
      const barred = id === 'SBb' || id === 'SBc';
      const late = id === 'Sc' || id === 'SBc';
      const early = id === 'Sa';
      const p = base(id, `${barred ? 'Barred spiral' : 'Spiral'} ${id}`, id, seed);
      const bulgeM = early ? 3.5e10 : late ? 5e9 : 1.8e10;
      p.potential = [
        { kind: 'point', name: 'black hole', M: early ? 1e8 : 2e7, soft: 1 },
        { kind: 'hernquist', name: 'bulge', M: bulgeM, a: early ? 1000 : late ? 450 : 700 },
        { kind: 'mn', name: 'disk', M: late ? 4.5e10 : 5.5e10, a: 3400, b: 300 },
        { kind: 'mn', name: 'gas disk', M: late ? 1.6e10 : 8e9, a: 6000, b: 100 },
        nfw(late ? 6e11 : 8e11, late ? 18000 : 17000),
      ];
      p.rMax = late ? 30000 : 27000;
      p.zMax = early ? 6000 : 4500;
      p.disk = {
        ...p.disk,
        lum: late ? 2.2e10 : 2.8e10,
        scaleLength: late ? 3300 : 3000,
        colorT: early ? 4800 : late ? 5600 : 5200,
        sigmaR: early ? 45 : 35,
        flare: 0,
        truncation: late ? 23000 : 21000,
      };
      p.bulge = {
        lum: early ? 2.2e10 : late ? 2.5e9 : 9e9,
        a: early ? 1000 : late ? 450 : 700,
        flatten: 0.8,
        colorT: 4250,
        rotation: 0.6,
        rMaxFactor: 8,
      };
      p.spiral = {
        ...p.spiral,
        arms: 2,
        pitchDeg: early ? 7 : late ? 21 : 13,
        patternSpeed: barred ? 30 : early ? 32 : late ? 20 : 25,
        amplitude: early ? 0.025 : late ? 0.042 : 0.036,
        rInner: barred ? 3800 : early ? 3000 : 1800,
        rOuter: late ? 22000 : 19000,
        flocculence: early ? 0.12 : late ? 0.55 : 0.3,
        r0: barred ? 4200 : 4000,
        phase: 0.3,
      };
      p.young = {
        ...p.young,
        lum: early ? 1.2e9 : late ? 9e9 : 4e9,
        sfr: 1,
        rInner: barred ? 3500 : early ? 3500 : 1500,
        rOuter: late ? 21000 : 18000,
        scaleLength: late ? 4500 : 3800,
        armFraction: late ? 0.75 : 0.85,
      };
      p.gas = {
        ...p.gas,
        dust: early ? 1.0 : late ? 1.1 : 1.3,
        dustLane: early ? 1.1 : late ? 1.5 : 1.9,
        hii: early ? 0.35 : late ? 1.5 : 1,
        dustHole: barred ? 3000 : early ? 3000 : 1200,
        nuclearRing: barred ? 900 : 0,
        dustScaleLength: late ? 6000 : 5000,
      };
      if (barred) {
        p.bar = {
          lum: late ? 5e9 : 8e9,
          halfLength: late ? 3800 : 4300,
          axisRatio: 0.28,
          peanut: 0.35,
          patternSpeed: p.spiral.patternSpeed,
          angle: 0.3 + (Math.PI / 2 - 0.3), // the arms start at the bar ends (set below)
          strength: 1,
          colorT: 4350,
        };
        // Align the bar with the start of the arms: arm 0 passes through (rInner, phase).
        const ti = 1 / Math.tan(p.spiral.pitchDeg * deg);
        p.bar.angle = p.spiral.phase - ti * Math.log(p.spiral.rInner / p.spiral.r0);
      }
      p.look = { exposure: 1, viewDistance: late ? 38000 : 34000 };
      return p;
    }
    case 'Irr': {
      const p = base(id, 'Irregular', 'Irr', seed);
      p.potential = [
        { kind: 'hernquist', name: 'stars', M: 1.5e9, a: 900 },
        { kind: 'mn', name: 'disk', M: 2.5e9, a: 1800, b: 350 },
        { kind: 'mn', name: 'gas disk', M: 1.5e9, a: 3000, b: 200 },
        nfw(8e10, 9000),
      ];
      p.rMax = 9000;
      p.zMax = 2500;
      p.disk = { ...p.disk, lum: 1.4e9, scaleLength: 1500, scaleHeight: 380, truncation: 7500, sigmaR: 20, colorT: 5900, thickLum: 1.5e8, thickScaleLength: 1400, thickScaleHeight: 700, thickSigmaR: 28, flare: 0 };
      p.bulge = { lum: 1e8, a: 500, flatten: 0.7, colorT: 5000, rotation: 0.5, rMaxFactor: 5 };
      p.bar = { lum: 3.5e8, halfLength: 1400, axisRatio: 0.4, peanut: 0, patternSpeed: 25, angle: 0.5, strength: 1, colorT: 5400 };
      p.spiral = { ...p.spiral, arms: 0, amplitude: 0, flocculence: 1, rInner: 500, rOuter: 6500, pitchDeg: 25, patternSpeed: 15, r0: 2000 };
      p.young = { lum: 1.3e9, scaleLength: 1600, rInner: 0, rOuter: 7000, scaleHeight: 120, sfr: 1, armFraction: 0.2, colorT: 13000 };
      p.gas = { dust: 0.35, dustScaleLength: 2200, dustScaleHeight: 150, dustLane: 0.4, dustHole: 0, hii: 2.2, nuclearRing: 0 };
      p.halo = { lum: 1e6, rMin: 1000, rMax: 12000, flatten: 0.8 };
      p.globulars = { count: 12, rCore: 1500, rMax: 9000 };
      p.clumpiness = 0.85;
      p.look = { exposure: 1.1, viewDistance: 13000 };
      return p;
    }
  }
}

export const MORPHOLOGIES: ReadonlyArray<{ id: MorphologyId; label: string }> = [
  { id: 'milkyway', label: 'Milky Way (SBbc)' },
  { id: 'E0', label: 'Elliptical E0' },
  { id: 'E5', label: 'Elliptical E5' },
  { id: 'S0', label: 'Lenticular S0' },
  { id: 'Sa', label: 'Spiral Sa' },
  { id: 'Sb', label: 'Spiral Sb' },
  { id: 'Sc', label: 'Spiral Sc' },
  { id: 'SBb', label: 'Barred spiral SBb' },
  { id: 'SBc', label: 'Barred spiral SBc' },
  { id: 'Irr', label: 'Irregular' },
];

/** Maximum number of arm segments passed to shaders. */
export const MAX_ARMS = 12;

/**
 * The arm segments that carry gas, dust and young stars: the preset's explicit list (Milky Way)
 * or `arms` symmetric arms, plus short flocculent spurs derived from the seed.
 * `armsOverride` / `pitchOverride` come from the live controls.
 */
export function buildArms(p: GalaxyParams, armsOverride?: number, pitchOverride?: number): ArmSpec[] {
  const m = armsOverride ?? p.spiral.arms;
  const pitch = pitchOverride ?? p.spiral.pitchDeg;
  const useList = p.spiral.armList && armsOverride === undefined && pitchOverride === undefined;
  const arms: ArmSpec[] = [];
  if (useList) {
    arms.push(...p.spiral.armList!.map((a) => ({ ...a })));
  } else if (p.spiral.armList && armsOverride === undefined) {
    // Milky Way with a new pitch: keep the arms, change their winding.
    for (const a of p.spiral.armList) arms.push({ ...a, pitchDeg: pitch * (a.pitchDeg / p.spiral.pitchDeg) });
  } else if (m > 0) {
    for (let k = 0; k < m; k++) {
      arms.push({
        pitchDeg: pitch,
        phase: p.spiral.phase + (2 * Math.PI * k) / m,
        r0: p.spiral.r0,
        rStart: p.spiral.rInner,
        rEnd: p.spiral.rOuter,
        strength: 1,
        width: m > 2 ? 0.04 : 0.05,
      });
    }
  }
  // Flocculent spurs and branches (deterministic from the seed).
  const nSpur = Math.round(p.spiral.flocculence * (m > 0 || useList ? 7 : 10));
  let h = hash2u(p.seed >>> 0, 0x5b0e);
  for (let i = 0; i < nSpur && arms.length < MAX_ARMS; i++) {
    h = next(h);
    const r0 = p.spiral.rInner + (p.spiral.rOuter - p.spiral.rInner) * (0.15 + 0.7 * u01(h));
    h = next(h);
    const phase = u01(h) * 2 * Math.PI;
    h = next(h);
    const len = 0.25 + 0.35 * u01(h);
    h = next(h);
    arms.push({
      pitchDeg: Math.min(40, pitch * (1.3 + 0.9 * u01(h)) + 4),
      phase,
      r0,
      rStart: r0 * (1 - len * 0.5),
      rEnd: r0 * (1 + len * 0.6),
      strength: 0.35 + 0.35 * u01(next(h)),
      width: 0.035,
    });
  }
  return arms.slice(0, MAX_ARMS);
}

/** Pattern-frame azimuth of an arm at radius R. */
export function armPhi(a: ArmSpec, R: number): number {
  return a.phase - Math.log(Math.max(R, 1) / a.r0) / Math.tan(a.pitchDeg * deg);
}

/** Wrap an angle to (−π, π]. */
export function wrapPi(x: number): number {
  x = (x + Math.PI) % (2 * Math.PI);
  if (x < 0) x += 2 * Math.PI;
  return x - Math.PI;
}
