import type { NebulaPreset, NebulaType, NebulaVariant } from './types';

/**
 * The nebula catalogue. Physical numbers are those of the real reference objects (sources in
 * each info card); geometry is procedural and seeded. Lengths in parsecs, densities in cm⁻³,
 * ionizing fluxes in photons s⁻¹, luminosities in L☉.
 */
export const PRESETS: Record<NebulaVariant, NebulaPreset> = {
  pillars: {
    variant: 'pillars',
    type: 'emission',
    label: 'Pillars',
    title: 'Pillars of Creation',
    subtitle: 'Emission nebula · stellar nursery',
    half: 4,
    layout: 'photo',
    // NGC 6611: a handful of O4–O7 stars, ≈ 2 × 10⁵⁰ ionizing photons/s (Hester et al. 1996).
    source: { pos: [1.5, 2.3, -0.9], Q: 2e50, teff: 42000, lum: 1.2e6 },
    scatter: [],
    // Orion/Eagle-like H II region line strengths relative to Hβ in each ion's zone.
    lines: { O3: 3.4, N2: 1.15, S2: 1.1, He1: 0.12, He2: 0 },
    dustToGas: 1,
    ionDust: 0.45,
    turbulence: 0.95,
    detailScale: [2.2, 0.62],
    frontNoise: 0.7,
    gain: 1 / 42000,
    palette: 'true',
    views: {
      default: { distance: 10.5, yaw: 0.32, pitch: 0.1, target: [0.1, -0.2, 0] },
      pillars: { distance: 5.2, yaw: 0.12, pitch: 0.05, target: [-0.6, -0.6, -0.2] },
      cluster: { distance: 7.5, yaw: 2.4, pitch: 0.55, target: [1.2, 1.6, -0.6] },
      edge: { distance: 11, yaw: 1.57, pitch: 0.0, target: [0, 0, 0] },
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
} as Record<NebulaVariant, NebulaPreset>;

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
