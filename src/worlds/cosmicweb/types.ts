/**
 * Shared types for the cosmic-web simulation, its worker protocol and renderers.
 * Units: comoving lengths in h⁻¹ Mpc inside the simulation; positions are shipped as
 * 16-bit fractions of the periodic box. Time `t` is cosmic time in Hubble times (H0 = 1).
 */
import { PLANCK18 } from '../../physics/constants';
import { PLANCK18_AS } from '../../physics/cosmosPower';

export interface CosmoParams {
  /** Matter density today (CDM + baryons). */
  Om0: number;
  /** Dark-energy (Λ) density today; curvature Ωk = 1 − Ωm − ΩΛ − Ωr. */
  Ode0: number;
  /** H0 / (100 km s⁻¹ Mpc⁻¹). */
  h: number;
  Ob0: number;
  ns: number;
  /** Normalise the linear spectrum to σ8 today, or to the primordial amplitude A_s. */
  norm: 'sigma8' | 'As';
  sigma8: number;
  As: number;
  /** Baryon acoustic oscillations in the transfer function. */
  wiggles: boolean;
}

export const PLANCK_COSMO: CosmoParams = {
  Om0: PLANCK18.Om0,
  Ode0: 1 - PLANCK18.Om0,
  h: PLANCK18.H0 / 100,
  Ob0: PLANCK18.Ob0,
  ns: PLANCK18.ns,
  norm: 'sigma8',
  sigma8: PLANCK18.sigma8,
  As: PLANCK18_AS,
  wiggles: true,
};

export interface SimConfig {
  cosmo: CosmoParams;
  /** Comoving box side, h⁻¹ Mpc. */
  box: number;
  /** Particles per side (any size); mesh cells per side (power of two). */
  np: number;
  nm: number;
  seed: number;
  /** Starting scale factor of the N-body run (2LPT initial conditions). */
  aInit: number;
  /** Last scale factor simulated for ever-expanding universes. */
  aFuture: number;
  /** Log-spaced steps from aInit to 0.1, linear-in-a steps to a = 1, and beyond. */
  stepsEarly: number;
  stepsMain: number;
  stepsFuture: number;
  /** Steps after turnaround (recollapsing universes). */
  stepsCollapse: number;
  /** Store a keyframe every k steps (plus the first, today and the last). */
  keyEvery: number;
  /** Run the friends-of-friends halo finder and galaxy model at keyframes below this redshift. */
  zHalos: number;
  /** Minimum particles per FoF group. */
  fofMin: number;
  /** FoF linking parameter b (× mean interparticle separation). */
  fofB: number;
  /** CIC window power deconvolved in the Green's function. */
  deconvolve: number;
}

export interface HaloCatalog {
  count: number;
  /** Particle index of the central galaxy (the densest member). */
  host: Uint32Array;
  /** M☉ (not h⁻¹). */
  mass: Float32Array;
  /** Physical kpc. */
  r200: Float32Array;
  /** 1D velocity dispersion, km/s. */
  sigma: Float32Array;
  npart: Uint32Array;
  /** Centre of mass, fraction of the box (x, y, z interleaved). */
  center: Float32Array;
  /** Galaxies (central + satellites) currently in the halo. */
  ngal: Uint16Array;
  /** Mean peculiar velocity km/s (x, y, z interleaved). */
  vel: Float32Array;
}

export interface GalaxyCatalog {
  count: number;
  /** Persistent identifier across keyframes. */
  id: Uint32Array;
  /** Particle that carries the galaxy. */
  host: Uint32Array;
  /** Stellar mass, M☉. */
  mstar: Float32Array;
  /** 1 = star-forming (blue), 0 = quenched (red). */
  blue: Float32Array;
  /** 1 = satellite, 0 = central. */
  sat: Uint8Array;
  /** Index into the keyframe's halo catalog, −1 if none. */
  halo: Int32Array;
  /** Cosmic time the galaxy first appeared (H0 units). */
  born: Float32Array;
}

export interface PowerSpectrumSample {
  /** h Mpc⁻¹ */
  k: Float32Array;
  /** Measured non-linear P(k), (h⁻¹Mpc)³ */
  P: Float32Array;
  /** Linear theory D² P_lin(k) at the same k. */
  Plin: Float32Array;
}

export interface KeyframeStats {
  stepMs: number;
  fofMs: number;
  /** Largest halo mass, M☉ (0 if none). */
  maxHaloMass: number;
  /** rms linear density contrast on 8 h⁻¹ Mpc at this time, σ8·D. */
  sigma8a: number;
  /** Deepest voids: centre (box fraction xyz) and smoothed 1+δ, up to 3. */
  voids: Float32Array;
}

/** Keyframe positions as stored: a whole frame, or int8 deltas (+ exceptions) from the previous one. */
export interface EncodedPositions {
  full: Uint16Array | null;
  delta: Int8Array | null;
  excIdx: Uint32Array | null;
  excVal: Uint16Array | null;
}

export interface Keyframe {
  index: number;
  step: number;
  t: number;
  a: number;
  D: number;
  /**
   * 16-bit box fractions, xyz interleaved (particle order = Lagrangian lattice order). The worker
   * sends `enc` instead (encoded off the main thread); decoded positions come from SnapshotStore.
   */
  positions: Uint16Array | null;
  enc?: EncodedPositions | null;
  halos: HaloCatalog;
  galaxies: GalaxyCatalog;
  pk: PowerSpectrumSample | null;
  stats: KeyframeStats;
}

export interface SimInfo {
  np: number;
  nm: number;
  count: number;
  box: number;
  /** Particle mass, M☉. */
  particleMass: number;
  /** Planned step times (H0 units) and which steps become keyframes. */
  stepT: Float64Array;
  stepA: Float64Array;
  keyStep: Uint8Array;
  /** Linear overdensity at each particle's Lagrangian site in units of σL, ×32 (int8). */
  deltaL: Int8Array;
  /** rms of the Lagrangian smoothed field (σ at the smoothing scale), today. */
  sigmaL: number;
  /** Smoothing radius of deltaL, h⁻¹ Mpc. */
  smoothingR: number;
  /** rms Zel'dovich displacement per axis today, h⁻¹ Mpc. */
  psiRms: number;
  /** Realised σ8 today of the linear spectrum. */
  sigma8: number;
  /** Linear σ² at the smallest (atomic-cooling) halo mass today — for collapsed fractions. */
  sigmaMin2: number;
  /** Linear σ² today at the deltaL smoothing scale (theory). */
  sigmaR2: number;
}

export type WorkerRequest = { type: 'run'; runId: number; config: SimConfig };

export type WorkerMessage =
  | { type: 'info'; runId: number; info: SimInfo }
  | { type: 'progress'; runId: number; fraction: number; label: string }
  | { type: 'keyframe'; runId: number; keyframe: Keyframe }
  | { type: 'done'; runId: number; ms: number }
  | { type: 'error'; runId: number; message: string };

/** Transferable buffers of a keyframe (for postMessage). */
export function keyframeTransferables(k: Keyframe): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  if (k.positions) out.push(k.positions.buffer as ArrayBuffer);
  if (k.enc) for (const a of [k.enc.full, k.enc.delta, k.enc.excIdx, k.enc.excVal]) if (a) out.push(a.buffer as ArrayBuffer);
  const h = k.halos, g = k.galaxies;
  for (const a of [h.host, h.mass, h.r200, h.sigma, h.npart, h.center, h.ngal, h.vel, g.id, g.host, g.mstar, g.blue, g.sat, g.halo, g.born])
    out.push(a.buffer as ArrayBuffer);
  if (k.pk) out.push(k.pk.k.buffer as ArrayBuffer, k.pk.P.buffer as ArrayBuffer, k.pk.Plin.buffer as ArrayBuffer);
  out.push(k.stats.voids.buffer as ArrayBuffer);
  return out;
}
