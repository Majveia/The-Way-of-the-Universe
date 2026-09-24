import { ANDROMEDA, CARTWHEEL_TARGET, DWARF, EARLY_SPIRAL, LATE_SPIRAL, MILKY_WAY } from '../../worlds/nbody/catalog';
import type { GalaxySpec } from '../../worlds/nbody/galaxy';
import type { ScenarioDef } from '../../worlds/nbody/scenario';

/**
 * Encounter presets. Orbits are the nominal Keplerian approach (pericentre r_p, eccentricity e,
 * starting separation r₀); disk orientations use Toomre & Toomre's (1972) angles (i, ω). Real
 * pericentres come out somewhat larger (extended halos) and dynamical friction then decays the
 * orbit — the readouts show what actually happens.
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
  /** Offset added to simulation time for the readout (e.g. "Gyr from now"). */
  clock?: { offsetMyr: number; label: string };
  /** Default camera: distance (kpc) and pitch. */
  view: { distance: number; pitch: number; yaw: number };
  /** Moments worth jumping to (Myr after the start). */
  moments?: Array<{ label: string; t: number }>;
  /** Readable facts for the info card. */
  facts: Array<[string, string]>;
}

const withGas = (g: GalaxySpec, fraction: number): GalaxySpec => ({ ...g, gas: { ...g.gas, fraction } });

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
    warmup: 260,
    view: { distance: 150, pitch: 0.55, yaw: 0.6 },
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
      'one seen nearly edge-on. Prograde disks feel the passing tide for longest, so their stars are ' +
      'flung out in the most spectacular bridges and tails.',
    scenario: {
      galaxies: [
        { spec: EARLY_SPIRAL, i: 25, w: -30 },
        { spec: EARLY_SPIRAL, i: 70, w: 60 },
      ],
      orbit: { rp: 12, e: 1, r0: 70 },
      seed: 4676,
    },
    warmup: 240,
    view: { distance: 170, pitch: 0.35, yaw: -0.4 },
    facts: [
      ['Distance', '≈ 90 Mpc (Coma)'],
      ['Mass ratio', '1 : 1'],
      ['Orbit', 'parabolic, first passage'],
      ['Model', 'Toomre & Toomre 1972; Barnes 2004'],
    ],
  },
  {
    id: 'cartwheel',
    name: 'The Cartwheel',
    designation: 'ESO 350-40',
    blurb:
      'A compact companion plunges almost straight through the centre of a large gas-rich disk. The ' +
      'sudden extra gravity pulls the disk in; as it rebounds, an expanding ring of compressed gas ' +
      'races outward at ~100 km/s, igniting a necklace of blue star formation — a stone dropped in a pond.',
    scenario: {
      galaxies: [
        { spec: CARTWHEEL_TARGET, i: 90, w: 0 },
        { spec: DWARF, i: 40, w: 20 },
      ],
      orbit: { rp: 1.5, e: 1.4, r0: 50 },
      seed: 35040,
    },
    warmup: 200,
    view: { distance: 110, pitch: 1.05, yaw: 0.2 },
    facts: [
      ['Distance', '≈ 150 Mpc (Sculptor)'],
      ['Mass ratio', '≈ 1 : 5'],
      ['Orbit', 'hyperbolic, head-on'],
      ['Model', 'Lynds & Toomre 1976; Hernquist & Weil 1993'],
    ],
  },
  {
    id: 'milkomeda',
    name: 'Milkomeda',
    designation: 'Milky Way + Andromeda',
    blurb:
      'Our own future. Andromeda approaches at about 110 km/s; after a first passage some 4 billion ' +
      'years from now the two spirals swing apart, fall back and merge into a single giant elliptical. ' +
      'Recent Gaia/HST analyses give roughly even odds for a merger within 10 Gyr — this is the ' +
      'classic head-on scenario. Follow the Sun.',
    scenario: {
      galaxies: [
        { spec: MILKY_WAY, i: 45, w: 30 },
        { spec: ANDROMEDA, i: 110, w: -40 },
      ],
      orbit: { rp: 30, e: 0.95, r0: 150 },
      seed: 31,
    },
    warmup: 120,
    clock: { offsetMyr: 3300, label: 'from now' },
    view: { distance: 260, pitch: 0.45, yaw: 0.9 },
    facts: [
      ['Separation today', '770 kpc'],
      ['Mass ratio', '≈ 1 : 1.4'],
      ['First passage', '≈ 4 Gyr from now'],
      ['Model', 'van der Marel et al. 2012; Cox & Loeb 2008'],
    ],
  },
];

export const presetById = (id: string): Preset => PRESETS.find((p) => p.id === id) ?? PRESETS[0];
