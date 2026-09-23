import type { GalaxySpec } from './galaxy';

/**
 * Galaxy templates (units: 10¹⁰ M☉, kpc). Halo masses are total Hernquist masses; the halo scale
 * follows the NFW→Hernquist matching of Springel, Di Matteo & Hernquist 2005 (MNRAS 361, 776)
 * for concentrations c ≈ 10–12. Values are rounded, representative, and documented per entry.
 */

/** The Milky Way today — Bland-Hawthorn & Gerhard 2016 (ARA&A 54, 529); McMillan 2017 (MNRAS 465, 76).
 * v_c(8.2 kpc) ≈ 235 km/s; stellar disk ≈ 4.3×10¹⁰ M☉ + gas; bulge/bar ≈ 0.9×10¹⁰ M☉. */
export const MILKY_WAY: GalaxySpec = {
  name: 'Milky Way',
  halo: { mass: 110, scale: 28, rmax: 260 },
  bulge: { mass: 0.9, scale: 0.6 },
  disk: { mass: 5.0, scale: 2.6, height: 0.3, Q: 1.5 },
  gas: { fraction: 0.14, scaleFactor: 1.8, heightFactor: 0.4, sigmaKms: 9 },
  pop: { bulgeAgeGyr: 10, sfhTauGyr: 7, activeGas: 0.06 },
};

/** Andromeda (M31) — Geehan et al. 2006 (MNRAS 366, 996); Tamm et al. 2012 (A&A 546, A4).
 * Larger, older, more bulge-dominated, relatively gas-poor with an HI ring near 10 kpc. */
export const ANDROMEDA: GalaxySpec = {
  name: 'Andromeda',
  halo: { mass: 150, scale: 32, rmax: 280 },
  bulge: { mass: 3.0, scale: 1.0 },
  disk: { mass: 7.0, scale: 5.3, height: 0.4, Q: 1.6 },
  gas: { fraction: 0.08, scaleFactor: 2.0, heightFactor: 0.4, sigmaKms: 9 },
  pop: { bulgeAgeGyr: 11, sfhTauGyr: 4, activeGas: 0.03 },
};

/** A gas-rich late-type spiral (Sc), e.g. the Antennae progenitors (NGC 4038/9 before contact). */
export const LATE_SPIRAL: GalaxySpec = {
  name: 'Sc spiral',
  halo: { mass: 60, scale: 22, rmax: 200 },
  bulge: { mass: 0.4, scale: 0.4 },
  disk: { mass: 4.0, scale: 3.2, height: 0.3, Q: 1.4 },
  gas: { fraction: 0.22, scaleFactor: 2.0, heightFactor: 0.4, sigmaKms: 8 },
  pop: { bulgeAgeGyr: 9, sfhTauGyr: 12, activeGas: 0.1 },
};

/** An early-type spiral with a prominent bulge (Sab), e.g. the Mice (NGC 4676 A/B). */
export const EARLY_SPIRAL: GalaxySpec = {
  name: 'Sab spiral',
  halo: { mass: 70, scale: 24, rmax: 210 },
  bulge: { mass: 1.6, scale: 0.8 },
  disk: { mass: 4.0, scale: 2.8, height: 0.3, Q: 1.5 },
  gas: { fraction: 0.12, scaleFactor: 1.8, heightFactor: 0.4, sigmaKms: 9 },
  pop: { bulgeAgeGyr: 10, sfhTauGyr: 5, activeGas: 0.05 },
};

/** A large, gas-rich disk: the Cartwheel's progenitor (ESO 350-40), ≈ 1.5× the Milky Way disk. */
export const CARTWHEEL_TARGET: GalaxySpec = {
  name: 'Cartwheel progenitor',
  halo: { mass: 90, scale: 26, rmax: 220 },
  bulge: { mass: 0.8, scale: 0.6 },
  disk: { mass: 5.5, scale: 4.2, height: 0.3, Q: 1.4 },
  gas: { fraction: 0.25, scaleFactor: 1.9, heightFactor: 0.4, sigmaKms: 8 },
  pop: { bulgeAgeGyr: 9, sfhTauGyr: 10, activeGas: 0.06 },
};

/** A compact gas-rich dwarf companion (the Cartwheel's intruder G3; minor-merger satellites). */
export const DWARF: GalaxySpec = {
  name: 'Dwarf companion',
  halo: { mass: 18, scale: 10, rmax: 110 },
  bulge: { mass: 0.5, scale: 0.35 },
  disk: { mass: 0.7, scale: 1.2, height: 0.15, Q: 1.5 },
  gas: { fraction: 0.35, scaleFactor: 1.6, heightFactor: 0.5, sigmaKms: 8 },
  pop: { bulgeAgeGyr: 8, sfhTauGyr: 20, activeGas: 0.12 },
};

export const GALAXY_TEMPLATES = { MILKY_WAY, ANDROMEDA, LATE_SPIRAL, EARLY_SPIRAL, CARTWHEEL_TARGET, DWARF } as const;
