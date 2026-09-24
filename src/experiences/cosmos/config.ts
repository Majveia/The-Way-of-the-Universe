/** Presets and quality-tier simulation settings for the Cosmic Web experience. */
import type { QualityProfile } from '../../core/Engine';
import { PLANCK_COSMO, type CosmoParams, type SimConfig } from '../../worlds/cosmicweb/types';

export type PresetId = 'planck' | 'eds' | 'lambda' | 'closed';

export const PRESETS: Record<PresetId, { label: string; cosmo: CosmoParams; blurb: string }> = {
  planck: {
    label: 'Planck 2018',
    cosmo: { ...PLANCK_COSMO },
    blurb: 'Our universe: 31 % matter (mostly dark), 69 % dark energy, flat.',
  },
  eds: {
    label: 'Einstein–de Sitter',
    cosmo: { ...PLANCK_COSMO, Om0: 1, Ode0: 0, norm: 'As' },
    blurb: 'All matter, no Λ: structure keeps growing, and the universe would be only 9.6 billion years old — younger than its oldest stars.',
  },
  lambda: {
    label: 'Λ-dominated',
    cosmo: { ...PLANCK_COSMO, Om0: 0.1, Ode0: 0.9, norm: 'As' },
    blurb: 'Too little matter: dark energy takes over early and freezes the web before it can grow.',
  },
  closed: {
    label: 'Closed',
    cosmo: { ...PLANCK_COSMO, Om0: 2.5, Ode0: 0, norm: 'As' },
    blurb: 'Dense enough to be spatially closed: expansion halts, reverses, and everything falls toward a Big Crunch.',
  },
};

/** Simulation size per quality tier (tuned by measured step times; see docs in Simulation.ts). */
export function simConfigFor(q: QualityProfile, cosmo: CosmoParams, box: number, seed: number, params?: URLSearchParams): SimConfig {
  const tier = q.tier;
  let np = tier === 'low' ? 64 : tier === 'medium' ? 96 : 128;
  let nm = tier === 'low' ? 64 : 128;
  const pNp = Number(params?.get('np'));
  const pNm = Number(params?.get('nm'));
  if (pNp >= 16 && pNp <= 256) np = Math.round(pNp / 16) * 16;
  if (pNm >= 16 && pNm <= 256 && (pNm & (pNm - 1)) === 0) nm = pNm;
  if (nm < np && (pNm || 0) === 0) nm = np;
  return {
    cosmo,
    box,
    np,
    nm,
    seed,
    aInit: 0.02,
    aFuture: 2.6,
    stepsEarly: 6,
    stepsMain: tier === 'low' ? 24 : 30,
    stepsFuture: 8,
    stepsCollapse: 14,
    keyEvery: np >= 128 ? 2 : 1,
    zHalos: 6,
    fofMin: 20,
    fofB: 0.2,
    deconvolve: 2,
  };
}
