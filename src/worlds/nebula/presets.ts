import { L_SUN, SIGMA_SB } from '../../physics/constants';
import { blackbodyPhotonRate } from '../../physics/nebulae';
import type { NebulaPreset, NebulaType, NebulaVariant } from './types';

/**
 * H-ionizing photon rate of a hot star treated as a blackbody of effective temperature T (K)
 * and luminosity L (L☉): R = √(L / 4πσT⁴), Q = blackbodyPhotonRate(T, R). Good to ~0.2 dex for
 * planetary-nebula nuclei, whose spectra are close to blackbodies in the ionizing UV.
 */
export function blackbodyQ(teff: number, lumSun: number): number {
  const R = Math.sqrt((lumSun * L_SUN) / (4 * Math.PI * SIGMA_SB * Math.pow(teff, 4)));
  return blackbodyPhotonRate(teff, R);
}

/**
 * The nebula catalogue. Physical numbers are those of the real reference objects (sources in
 * each info card); geometry is procedural and seeded. Lengths in parsecs, densities in cm⁻³,
 * ionizing fluxes in photons s⁻¹, luminosities in L☉, velocities in km/s.
 */
export const PRESETS: Record<NebulaVariant, NebulaPreset> = {
  pillars: {
    variant: 'pillars',
    type: 'emission',
    label: 'Pillars',
    title: 'Pillars of Creation',
    subtitle: 'Emission nebula · stellar nursery',
    half: 4.5,
    layout: 'photo',
    // NGC 6611: a handful of O4–O7 stars, ≈ 2 × 10⁵⁰ ionizing photons/s (Hester et al. 1996).
    source: { pos: [1.1, 3.9, 0.7], Q: 2e50, teff: 42000, lum: 1.2e6 },
    nRef: 100,
    scatter: [],
    // Orion/Eagle-like H II region line strengths relative to Hβ in each ion's zone.
    lines: { O3: 3.4, N2: 1.15, S2: 1.1, He1: 0.12, He2: 0 },
    dustToGas: 1,
    ionDust: 0.3,
    turbulence: 0.32,
    detailScale: [2.6, 0.7],
    frontNoise: 0.4,
    streak: [3.2, 0.35, 0.45],
    gain: 1 / 190000,
    palette: 'true',
    views: {
      default: { distance: 6.4, yaw: 0.06, pitch: -0.01, target: [-0.4, -0.55, -0.35] },
      wide: { distance: 13, yaw: 0.35, pitch: 0.2, target: [0, 0, -0.3] },
      tip: { distance: 2.2, yaw: 0.2, pitch: 0.1, target: [-1.2, 0.35, -0.1] },
      cluster: { distance: 6.5, yaw: 2.5, pitch: 0.55, target: [1.1, 3.0, 0.7] },
      edge: { distance: 10, yaw: 1.5, pitch: 0.05, target: [0, -0.5, -0.4] },
      inside: { distance: 1.0, yaw: 0.6, pitch: 0.1, target: [0.2, 0.9, 0.4] },
    },
    ageYears: 1.5e6,
    timeRate: 2000,
    expansionKmS: 0,
    shellRadius: 3.4,
    flowKmS: 10,
    info: {
      rows: [
        ['Analogue', 'M16 · Eagle Nebula'],
        ['Distance', '5 700 ly (1.74 kpc)'],
        ['Tallest pillar', '≈ 4 ly'],
        ['Ionizing cluster', 'NGC 6611 · ~2 Myr'],
        ['Ionizing flux', '≈ 2 × 10⁵⁰ photons/s'],
      ],
      body:
        'Ultraviolet light from a young cluster of O stars eats into the molecular cloud it was born from. ' +
        'Dense knots use up the photons that reach them and shield the gas behind, leaving columns that point back at the stars. ' +
        'Their tips glow where the ionization front meets them; inside, new stars are still forming.',
    },
  },

  ring: {
    variant: 'ring',
    type: 'planetary',
    label: 'Ring',
    title: 'The Ring',
    subtitle: 'Planetary nebula · a dying Sun-like star',
    half: 0.6,
    layout: 'photo',
    // Central star of M57: T ≈ 125 kK, L ≈ 200 L☉ (O'Dell et al. 2013; González Santamaría 2021).
    nRef: 600,
    source: { pos: [0, 0, 0], Q: blackbodyQ(125000, 200), teff: 125000, lum: 200 },
    scatter: [],
    // Typical of M57: [OIII]/Hβ ≈ 12 inside, [NII]/Hβ ≈ 3.5 in the outer ring, He II 4686/Hβ ≈ 0.6 in the core.
    lines: { O3: 12, N2: 3.6, S2: 0.45, He1: 0.12, He2: 0.6 },
    dustToGas: 0.5,
    ionDust: 0.5,
    turbulence: 0.55,
    detailScale: [0.16, 0.045],
    frontNoise: 0.55,
    streak: [5.5, 10, 0.45],
    gain: 1 / 42000,
    palette: 'true',
    views: {
      default: { distance: 0.95, yaw: 0, pitch: 0 },
      oblique: { distance: 1.0, yaw: 0.9, pitch: 0.35 },
      side: { distance: 1.05, yaw: 1.57, pitch: 0.05 },
      inside: { distance: 0.06, yaw: 0.4, pitch: 0.2 },
    },
    ageYears: 4000,
    timeRate: 60,
    expansionKmS: 25,
    shellRadius: 0.13,
    flowKmS: 3,
    info: {
      rows: [
        ['Analogue', 'M57 · Ring Nebula'],
        ['Distance', '2 570 ly (790 pc)'],
        ['Main ring', '≈ 0.3 pc across'],
        ['Central star', 'white dwarf · 125 000 K'],
        ['Expansion', '≈ 25 km/s · ~4 000 yr'],
      ],
      body:
        'A star like the Sun has shed its outer layers. Its exposed core is so hot that its ultraviolet strips oxygen twice — ' +
        'the inner nebula glows in the teal of [OIII] — while hydrogen and nitrogen shine red in the cooler, thicker ring. ' +
        'We see a barrel almost end-on; faint arcs in the halo record pulses of mass loss every few centuries.',
    },
  },

  helix: {
    variant: 'helix',
    type: 'planetary',
    label: 'Helix',
    title: 'The Helix',
    subtitle: 'Planetary nebula · the eye of god',
    half: 0.85,
    layout: 'photo',
    // NGC 7293: T ≈ 104 kK, L ≈ 90 L☉ (Napiwotzki 1999; O'Dell et al. 2004).
    nRef: 100,
    source: { pos: [0, 0, 0], Q: blackbodyQ(104000, 90), teff: 104000, lum: 90 },
    scatter: [],
    lines: { O3: 7, N2: 4.2, S2: 0.7, He1: 0.12, He2: 0.45 },
    dustToGas: 0.6,
    ionDust: 0.5,
    turbulence: 0.6,
    detailScale: [0.3, 0.08],
    frontNoise: 0.6,
    streak: [6.0, 6.0, 0.5],
    gain: 1 / 9000,
    palette: 'true',
    views: {
      default: { distance: 1.75, yaw: 0, pitch: 0 },
      oblique: { distance: 1.8, yaw: 1.0, pitch: 0.4 },
      knots: { distance: 0.75, yaw: 0.15, pitch: 0.1, target: [0.18, 0.1, 0] },
      inside: { distance: 0.12, yaw: 0.5, pitch: 0.1 },
    },
    ageYears: 10600,
    timeRate: 150,
    expansionKmS: 32,
    shellRadius: 0.35,
    flowKmS: 4,
    info: {
      rows: [
        ['Analogue', 'NGC 7293 · Helix Nebula'],
        ['Distance', '655 ly (201 pc)'],
        ['Size', '≈ 1.7 pc across'],
        ['Central star', 'white dwarf · 104 000 K'],
        ['Cometary knots', '~20 000, each ≈ Solar System size'],
      ],
      body:
        'One of the nearest planetary nebulae: two nearly perpendicular rings seen almost face-on. ' +
        'On the inner edge thousands of dense knots cast tails pointing away from the star — molecular gas surviving the white dwarf’s glare. ' +
        'Red [NII] marks the outer ring, blue-green [OIII] the hot interior.',
    },
  },

  butterfly: {
    variant: 'butterfly',
    type: 'planetary',
    label: 'Butterfly',
    title: 'The Butterfly',
    subtitle: 'Bipolar planetary nebula',
    half: 0.7,
    layout: 'photo',
    // NGC 6302: one of the hottest central stars known, ≈ 220 kK (Wright et al. 2011).
    nRef: 1500,
    source: { pos: [0, 0, 0], Q: blackbodyQ(220000, 8000), teff: 220000, lum: 8000 },
    scatter: [],
    lines: { O3: 11, N2: 6, S2: 0.9, He1: 0.1, He2: 1.0 },
    dustToGas: 1.6,
    ionDust: 0.6,
    turbulence: 0.7,
    detailScale: [0.22, 0.06],
    frontNoise: 0.7,
    streak: [7.0, 9.0, 0.7],
    gain: 1 / 60000,
    palette: 'true',
    views: {
      default: { distance: 1.55, yaw: 0, pitch: 0.05 },
      oblique: { distance: 1.4, yaw: 0.8, pitch: 0.4 },
      pole: { distance: 1.4, yaw: 1.57, pitch: 0.1 },
      waist: { distance: 0.45, yaw: 0.2, pitch: 0.15 },
    },
    ageYears: 2200,
    timeRate: 30,
    expansionKmS: 245,
    shellRadius: 0.55,
    flowKmS: 20,
    info: {
      rows: [
        ['Analogue', 'NGC 6302 · Butterfly / Bug'],
        ['Distance', '3 400 ly (1.04 kpc)'],
        ['Wingspan', '≈ 1.1 pc'],
        ['Central star', '≈ 220 000 K, hidden in dust'],
        ['Outflow', 'Hubble-like, v ∝ r · ~2 200 yr'],
      ],
      body:
        'A dense, dusty torus pinches the dying star’s wind into two lobes. The gas moves ballistically — speed proportional to distance — ' +
        'so the whole nebula is a slow explosion that began about 2 200 years ago. ' +
        'The star is among the hottest known: its hard ultraviolet ionizes helium twice and oxygen far out into the wings.',
    },
  },

  crab: {
    variant: 'crab',
    type: 'remnant',
    label: 'Crab',
    title: 'The Crab',
    subtitle: 'Supernova remnant · pulsar wind nebula',
    half: 2.5,
    layout: 'shock',
    // Filaments are photoionized by the synchrotron nebula; the pulsar sits at the centre.
    source: { pos: [0, 0, 0], Q: 0, teff: 30000, lum: 0 },
    scatter: [],
    // Crab filaments: strong [NII], [SII], He I (helium-rich ejecta), moderate [OIII] (Davidson & Fesen 1985).
    lines: { O3: 3.2, N2: 2.6, S2: 1.9, He1: 0.45, He2: 0.15 },
    dustToGas: 0.4,
    ionDust: 1,
    turbulence: 0.5,
    detailScale: [0.9, 0.24],
    frontNoise: 0,
    gain: 1 / 9000,
    palette: 'true',
    views: {
      default: { distance: 5.4, yaw: 0, pitch: 0 },
      oblique: { distance: 5.0, yaw: 0.9, pitch: 0.4 },
      pulsar: { distance: 1.1, yaw: 0.2, pitch: 0.12 },
      inside: { distance: 0.5, yaw: 1.2, pitch: 0.1, target: [0.6, 0.2, 0] },
    },
    ageYears: 972,
    timeRate: 5,
    expansionKmS: 1500,
    shellRadius: 1.6,
    flowKmS: 0,
    info: {
      rows: [
        ['Analogue', 'M1 · Crab Nebula'],
        ['Distance', '6 500 ly (2.0 kpc)'],
        ['Size', '≈ 3.4 × 2.2 pc'],
        ['Supernova', 'seen from Earth in 1054 CE'],
        ['Pulsar', 'P = 33.7 ms · 30 turns per second'],
      ],
      body:
        'The debris of a star that exploded in 1054, still flying outward at 1 500 km/s. ' +
        'A neutron star spinning thirty times a second powers a wind of electrons that spiral in magnetic fields and glow blue-white (synchrotron light); ' +
        'the cage of red filaments is the star’s own ejecta, rich in helium and nitrogen.',
    },
  },

  veil: {
    variant: 'veil',
    type: 'remnant',
    label: 'Veil',
    title: 'The Veil',
    subtitle: 'Supernova remnant · Cygnus Loop',
    half: 24.5,
    layout: 'shock',
    source: { pos: [0, 0, 0], Q: 0, teff: 30000, lum: 0 },
    scatter: [],
    // Radiative shocks: [SII]/Hα ≳ 0.5 is the classic shock signature; [OIII] strong in faster, incomplete shocks.
    lines: { O3: 7, N2: 1.4, S2: 2.6, He1: 0.1, He2: 0 },
    dustToGas: 0.3,
    ionDust: 1,
    turbulence: 0.5,
    detailScale: [9, 2.4],
    frontNoise: 0,
    gain: 1 / 2600,
    palette: 'true',
    views: {
      default: { distance: 55, yaw: 0, pitch: 0 },
      eastern: { distance: 24, yaw: -0.25, pitch: 0.02, target: [-15, -1, 0] },
      western: { distance: 24, yaw: 0.25, pitch: 0.0, target: [14, 2, 0] },
      inside: { distance: 6, yaw: 0.6, pitch: 0.1, target: [-4, 0, 0] },
    },
    ageYears: 21000,
    timeRate: 60,
    expansionKmS: 350,
    shellRadius: 18,
    flowKmS: 0,
    info: {
      rows: [
        ['Analogue', 'Cygnus Loop · Veil Nebula'],
        ['Distance', '2 400 ly (735 pc)'],
        ['Diameter', '≈ 37 pc (six full Moons)'],
        ['Age', '≈ 21 000 yr · Sedov–Taylor phase'],
        ['Shock speed', '≈ 350 km/s'],
      ],
      body:
        'A blast wave from a supernova twenty millennia ago, still sweeping up interstellar gas. ' +
        'Where it meets denser clouds it slows, cools and glows. We only see the shock where our line of sight runs along the rippled sheet — ' +
        'that is why the Veil is made of threads. [OIII] leads, hydrogen and sulfur trail behind.',
    },
  },

  horsehead: {
    variant: 'horsehead',
    type: 'dark',
    label: 'Horsehead',
    title: 'The Horsehead',
    subtitle: 'Dark nebula against an ionization front',
    half: 3.2,
    layout: 'photo',
    // σ Orionis (O9.5 V + B0.5 V), a few pc above and behind the front: Q ≈ 10^47.9 (Pound et al. 2003).
    nRef: 60,
    source: { pos: [0.6, 3.9, 0.4], Q: 5e47, teff: 33000, lum: 4.5e4 },
    // NGC 2023's illuminating star HD 37903 (B1.5 V) lights the cloud from within.
    scatter: [{ pos: [-2.5, -1.9, 0.5], teff: 22000, lum: 1500 }],
    lines: { O3: 0.25, N2: 1.2, S2: 1.5, He1: 0.06, He2: 0 },
    dustToGas: 1,
    ionDust: 0.35,
    turbulence: 0.6,
    detailScale: [1.6, 0.42],
    frontNoise: 0.8,
    streak: [5, 0.6, 0.75],
    gain: 1 / 10000,
    palette: 'true',
    views: {
      default: { distance: 4.4, yaw: 0, pitch: 0.02, target: [-0.15, 0.05, 0.35] },
      close: { distance: 2.6, yaw: 0.1, pitch: 0.05, target: [-0.3, 0.3, 0.4] },
      side: { distance: 5.5, yaw: 1.35, pitch: 0.15, target: [0, 0, 0] },
      behind: { distance: 5.5, yaw: 3.0, pitch: 0.12, target: [0, 0, 0] },
    },
    ageYears: 3e5,
    timeRate: 1000,
    expansionKmS: 0,
    shellRadius: 3,
    flowKmS: 8,
    info: {
      rows: [
        ['Analogue', 'Barnard 33 in IC 434'],
        ['Distance', '1 375 ly (422 pc)'],
        ['Head', '≈ 1 pc tall'],
        ['Ionizing star', 'σ Orionis · O9.5 V'],
        ['Reflection nebula', 'NGC 2023 · B1.5 V star'],
      ],
      body:
        'A pillar of cold dust rises out of the Orion B molecular cloud, silhouetted against glowing hydrogen. ' +
        'Its top is lit by σ Orionis; gas boils off the ionization front toward the star, drawing the faint vertical streaks of IC 434. ' +
        'Where a young B star is still buried in the cloud, dust scatters its light blue.',
    },
  },

  pleiades: {
    variant: 'pleiades',
    type: 'reflection',
    label: 'Pleiades',
    title: 'The Pleiades',
    subtitle: 'Reflection nebula · a cluster passing a cloud',
    half: 3.4,
    layout: 'photo',
    // B stars are too cool to ionize much hydrogen: the nebula shines by scattered starlight only.
    source: { pos: [0, 0, 0], Q: 0, teff: 12300, lum: 2400 },
    scatter: [],
    lines: { O3: 0, N2: 0, S2: 0, He1: 0, He2: 0 },
    dustToGas: 1,
    ionDust: 1,
    turbulence: 0.8,
    detailScale: [1.6, 0.4],
    frontNoise: 0,
    gain: 1 / 1400,
    palette: 'true',
    views: {
      default: { distance: 7.2, yaw: 0, pitch: 0 },
      merope: { distance: 1.6, yaw: 0.25, pitch: 0.1, target: [0.63, -0.37, 0.2] },
      side: { distance: 7, yaw: 1.4, pitch: 0.1 },
      inside: { distance: 1.2, yaw: 0.9, pitch: 0.15, target: [0.2, 0.2, 0] },
    },
    ageYears: 1.0e8,
    timeRate: 2000,
    expansionKmS: 0,
    shellRadius: 3,
    flowKmS: 11,
    info: {
      rows: [
        ['Analogue', 'M45 · Pleiades'],
        ['Distance', '444 ly (136 pc)'],
        ['Cluster age', '≈ 100 Myr'],
        ['Brightest', 'Alcyone · B7 III · 2 400 L☉'],
        ['Encounter speed', '≈ 11 km/s through the cloud'],
      ],
      body:
        'The Seven Sisters are not in their birth cloud: they are passing through an unrelated cloud of dust. ' +
        'The stars are too cool to ionize it, so the nebula shines only by reflected starlight — blue, like our sky, because small grains scatter blue light best. ' +
        'The fine striations follow the interstellar magnetic field.',
    },
  },
};

/** Menu order. */
export const VARIANTS: NebulaVariant[] = ['pillars', 'horsehead', 'ring', 'helix', 'butterfly', 'crab', 'veil', 'pleiades'];

/** Default variant for each spec type. */
export const DEFAULT_VARIANT: Record<NebulaType, NebulaVariant> = {
  emission: 'pillars',
  planetary: 'ring',
  remnant: 'crab',
  dark: 'horsehead',
  reflection: 'pleiades',
};

export function getPreset(v: NebulaVariant): NebulaPreset {
  return PRESETS[v] ?? PRESETS.pillars;
}
