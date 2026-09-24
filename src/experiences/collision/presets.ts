import { ANDROMEDA, CARTWHEEL_TARGET, DWARF, EARLY_SPIRAL, LATE_SPIRAL, MILKY_WAY } from '../../worlds/nbody/catalog';
import type { GalaxySpec } from '../../worlds/nbody/galaxy';
import type { ScenarioDef } from '../../worlds/nbody/scenario';

/**
 * Encounter presets. Orbits are the nominal Keplerian approach (pericentre r_p, eccentricity e,
 * starting separation r₀); disk orientations use Toomre & Toomre's (1972) angles (i, ω). Real
 * pericentres come out somewhat larger (extended halos) and dynamical friction then decays the
 * orbit — the readouts show what actually happens. Moment times were measured with the CPU
 * reference integrator (src/worlds/nbody/cpu.ts) on the same initial conditions.
 */
export interface Preset {
  id: string;
  name: string;
  /** Short catalogue designation / subtitle. */
  designation: string;
  blurb: string;
  scenario: ScenarioDef;
  /** Simulated time (Myr) to pre-integrate while loading, so the scene opens mid-story. */
  warmup: number;
  /** Default time rate (Myr of simulation per second). */
  rate: number;
  /** Skeleton time step (Myr). */
  dt?: number;
  /** Offset added to simulation time for the readout (e.g. "Gyr from now"). */
  clock?: { offsetMyr: number; label: string };
  /** Default camera: distance (kpc), pitch and yaw (rad). */
  view: { distance: number; pitch: number; yaw: number };
  /** What the camera follows: the pair's barycentre or one galaxy. */
  follow: 'pair' | 0 | 1;
  /** Moments worth jumping to (Myr after the start). */
  moments: Array<{ label: string; t: number }>;
  /** Readable facts for the info card. */
  facts: Array<[string, string]>;
}

const withGas = (g: GalaxySpec, fraction: number): GalaxySpec => ({ ...g, gas: { ...g.gas, fraction } });

/**
 * Scale a galaxy template by mass factor f at fixed mean density (R ∝ M^⅓), so a 1:4 companion
 * is also ~1.6× smaller. Velocity dispersions and Q are kept.
 */
export function scaleGalaxy(g: GalaxySpec, f: number, name = g.name): GalaxySpec {
  const l = Math.cbrt(f);
  return {
    ...g,
    name,
    halo: { mass: g.halo.mass * f, scale: g.halo.scale * l, rmax: g.halo.rmax * l },
    bulge: { mass: g.bulge.mass * f, scale: g.bulge.scale * l },
    disk: { ...g.disk, mass: g.disk.mass * f, scale: g.disk.scale * l, height: g.disk.height * Math.max(0.6, l) },
  };
}

export const PRESETS: Preset[] = [
  {
    id: 'antennae',
    name: 'The Antennae',
    designation: 'NGC 4038 / 4039',
    blurb:
      'Two gas-rich spirals on a bound, prograde orbit. After the first passage two long tidal tails ' +
      'sweep out like an insect’s antennae; on the second approach the disks collide and the gas ' +
      'squeezed between them bursts into blue star clusters. Toomre & Toomre reproduced it with ' +
      'nothing but gravity in 1972.',
    scenario: {
      galaxies: [
        { spec: withGas(LATE_SPIRAL, 0.25), i: 60, w: -30 },
        { spec: withGas(LATE_SPIRAL, 0.22), i: 60, w: -30 },
      ],
      orbit: { rp: 7, e: 0.8, r0: 60 },
      seed: 4038,
    },
    warmup: 420,
    rate: 30,
    view: { distance: 120, pitch: 0.55, yaw: 0.6 },
    follow: 'pair',
    moments: [
      { label: 'Approach', t: 150 },
      { label: 'First passage', t: 285 },
      { label: 'Tails', t: 420 },
      { label: 'Antennae', t: 560 },
      { label: 'Merger', t: 820 },
      { label: 'Remnant', t: 1300 },
    ],
    facts: [
      ['Distance', '≈ 22 Mpc (Corvus)'],
      ['Mass ratio', '1 : 1'],
      ['Orbit', 'bound, prograde'],
      ['Model', 'Toomre & Toomre 1972; Karl et al. 2010'],
    ],
  },
  {
    id: 'mice',
    name: 'The Mice',
    designation: 'NGC 4676 A / B',
    blurb:
      'Two early-type spirals just after their first close passage, trailing long, straight tails — ' +
      'one disk seen nearly edge-on. Prograde disks feel the passing tide for longest, so their stars ' +
      'are flung out in the most spectacular bridges and tails. They will merge within a billion years.',
    scenario: {
      galaxies: [
        { spec: EARLY_SPIRAL, i: 25, w: -30 },
        { spec: EARLY_SPIRAL, i: 70, w: 60 },
      ],
      orbit: { rp: 10, e: 0.7, r0: 70 },
      seed: 4676,
    },
    warmup: 420,
    rate: 30,
    view: { distance: 130, pitch: 0.35, yaw: -0.4 },
    follow: 'pair',
    moments: [
      { label: 'Approach', t: 220 },
      { label: 'First passage', t: 355 },
      { label: 'Tails', t: 420 },
      { label: 'Plunge', t: 570 },
      { label: 'Merger', t: 800 },
      { label: 'Remnant', t: 1250 },
    ],
    facts: [
      ['Distance', '≈ 90 Mpc (Coma)'],
      ['Mass ratio', '1 : 1'],
      ['Orbit', 'bound, first passage'],
      ['Model', 'Toomre & Toomre 1972; Barnes 2004'],
    ],
  },
  {
    id: 'cartwheel',
    name: 'The Cartwheel',
    designation: 'ESO 350-40',
    blurb:
      'A compact companion plunges almost straight through a large gas-rich disk. The sudden extra ' +
      'gravity pulls every orbit inward at once; as they rebound together, a ring of crowded stars ' +
      'and compressed gas races outward, igniting a necklace of blue star formation — a stone dropped ' +
      'in a pond. The ring is a wave: the stars in it keep changing.',
    scenario: {
      galaxies: [
        { spec: CARTWHEEL_TARGET, i: 90, w: 90 },
        { spec: DWARF, i: 40, w: 20 },
      ],
      orbit: { rp: 0.5, e: 1.0, r0: 50 },
      seed: 35040,
    },
    warmup: 260,
    rate: 12,
    view: { distance: 80, pitch: 0.5, yaw: 1.4 },
    follow: 0,
    moments: [
      { label: 'Approach', t: 50 },
      { label: 'Impact', t: 92 },
      { label: 'Ring forms', t: 200 },
      { label: 'Cartwheel', t: 260 },
      { label: 'Two rings', t: 320 },
    ],
    facts: [
      ['Distance', '≈ 150 Mpc (Sculptor)'],
      ['Mass ratio', '≈ 1 : 5'],
      ['Orbit', 'parabolic, head-on'],
      ['Model', 'Lynds & Toomre 1976; Hernquist & Weil 1993'],
    ],
  },
  {
    id: 'milkomeda',
    name: 'Milkomeda',
    designation: 'Milky Way + Andromeda',
    blurb:
      'Our own future. Andromeda approaches at about 110 km/s. Some 3.9 billion years from now the two ' +
      'spirals swing past each other, fly apart, fall back and merge into a single giant elliptical ' +
      'about 6 billion years from now (van der Marel et al. 2012). Gaia and HST now give roughly even ' +
      'odds for a merger within 10 Gyr — this is the classic, head-on scenario.',
    scenario: {
      galaxies: [
        { spec: MILKY_WAY, i: 45, w: 30 },
        { spec: ANDROMEDA, i: 110, w: -40 },
      ],
      orbit: { rp: 30, e: 0.95, r0: 150 },
      seed: 31,
    },
    warmup: 330,
    rate: 60,
    dt: 1.5,
    clock: { offsetMyr: 3500, label: 'from now' },
    view: { distance: 165, pitch: 0.45, yaw: 0.9 },
    follow: 'pair',
    moments: [
      { label: 'Approach', t: 150 },
      { label: 'First passage', t: 375 },
      { label: 'Apocentre', t: 1060 },
      { label: 'Second passage', t: 1975 },
      { label: 'Milkomeda', t: 2700 },
    ],
    facts: [
      ['Separation today', '770 kpc'],
      ['Mass ratio', '≈ 1 : 1.4'],
      ['First passage', '≈ 3.9 Gyr from now'],
      ['Model', 'van der Marel et al. 2012; Cox & Loeb 2008'],
    ],
  },
];

/** Parameters of a user-designed encounter. */
export interface CustomParams {
  /** Mass ratio M₁/M₂ ≥ 1. */
  massRatio: number;
  /** Nominal pericentre (kpc). */
  rp: number;
  /** Orbital eccentricity. */
  e: number;
  /** Disk inclinations to the orbital plane (deg): 0 prograde, 180 retrograde. */
  i1: number;
  i2: number;
  /** Gas fraction of both disks. */
  gas: number;
}

export const DEFAULT_CUSTOM: CustomParams = { massRatio: 1, rp: 8, e: 0.8, i1: 0, i2: 180, gas: 0.2 };

/** Build a preset from custom parameters (Sc spirals; the companion scaled at fixed density). */
export function customPreset(c: CustomParams): Preset {
  const q = Math.max(1, c.massRatio);
  const g1 = withGas(LATE_SPIRAL, c.gas);
  const g2 = scaleGalaxy(withGas(LATE_SPIRAL, c.gas), 1 / q, 'Companion');
  const r0 = Math.max(40, 4 * c.rp + 30);
  const pro = (i: number) => (i < 60 ? 'prograde' : i > 120 ? 'retrograde' : 'polar');
  return {
    id: 'custom',
    name: 'Your encounter',
    designation: `${pro(c.i1)} × ${pro(c.i2)} · 1 : ${q.toFixed(q < 10 ? 1 : 0)}`,
    blurb:
      'Toomre & Toomre’s lesson: a disk spinning the same way as the orbit (prograde, i = 0°) stays in ' +
      'resonance with the passing tide and is torn into long tails and bridges; a retrograde disk ' +
      '(i = 180°) feels the tide flicker past and barely responds. Tighter pericentres and slower, ' +
      'bound orbits (e < 1) merge sooner — dynamical friction on the live dark halos does the rest.',
    scenario: {
      galaxies: [
        { spec: g1, i: c.i1, w: -30 },
        { spec: g2, i: c.i2, w: -30 },
      ],
      orbit: { rp: c.rp, e: c.e, r0 },
      seed: 1972,
    },
    warmup: 0,
    rate: 30,
    view: { distance: Math.max(110, 2 * r0), pitch: 0.7, yaw: 0.4 },
    follow: 'pair',
    moments: [],
    facts: [
      ['Mass ratio', `1 : ${q.toFixed(1)}`],
      ['Pericentre', `${c.rp.toFixed(0)} kpc (nominal)`],
      ['Eccentricity', c.e.toFixed(2)],
      ['Disks', `i₁ = ${c.i1.toFixed(0)}°, i₂ = ${c.i2.toFixed(0)}°`],
    ],
  };
}

export const presetById = (id: string): Preset => PRESETS.find((p) => p.id === id) ?? PRESETS[0];
