/**
 * Comet physics for rendering: activity, the Finson–Probstein dust tail, the ion (plasma) tail and
 * the coma. Pure functions (astro axes: J2000 ecliptic, z-up; AU, days) — unit-tested.
 *
 * Dust tail — Finson & Probstein (1968, ApJ 154:327): a grain released at time t_e with (almost)
 * the nucleus' velocity feels gravity reduced by radiation pressure, a_rad/a_grav = β
 * (β ≈ 0.57 Q_pr / (ρ[g cm⁻³] · s[µm]); Burns, Lamy & Soter 1979). It then moves on a Kepler
 * conic with µ' = µ(1 − β). The tail is the locus of all (β, τ = t − t_e):
 *   · syndynes  — fixed β, all ages: grains of one size, curving away from the orbital motion;
 *   · synchrones — fixed age, all β: a burst released at one moment (the striae of McNaught 2007).
 * We propagate an exact (β, τ) grid with universal variables and let the GPU fill in between.
 *
 * Ion tail — CO⁺, H₂O⁺ ions are picked up by the solar wind (Biermann 1951; Alfvén 1957) and
 * accelerate to ~u_sw ≈ 400 km/s within about a day; their heliocentric paths are nearly radial
 * from the point of release, so the tail points anti-sunward, aberrated by the comet's own motion:
 * tan ψ ≈ v⊥ / u_sw (a few degrees). Colour: CO⁺ comet-tail band system (≈ 400–430 nm) — blue.
 *
 * Coma — isotropic outflow at v_gas ≈ 0.85 r^−0.5 km/s (Delsemme 1982) with photodissociation
 * lifetimes (Haser 1957): uniform emission gives a column density ∝ 1/ρ; radiation pressure bends
 * the outflow into a paraboloid of apex distance v²/(2βg) on the sunward side ("fountain model",
 * Eddington 1910).
 *
 * Brightness — total visual magnitude m = M1 + 5 log Δ + K1 log r (JPL SBDB, M1/K1 per comet),
 * i.e. surface brightness of gas and dust ∝ r^(−K1/2.5): sunlight (r⁻²) × production Q(r).
 */
import * as THREE from 'three';
import { conicState, propagateUniversal, MU_SUN, type ConicElements } from './ephem/conic';
import type { CometPhysics } from './data/types';

export const KM_PER_AU = 149_597_870.7;
/** AU/day per km/s. */
export const KMS_TO_AUD = 86400 / KM_PER_AU;
/** Slow solar wind speed (km/s). */
export const SOLAR_WIND_KMS = 400;

/**
 * Relative production/brightness factor of the comet at heliocentric distance r (AU), 0 when
 * inactive. 10^(−0.4·(M1 + K1 log r)) is the heliocentric part of the SBDB total-magnitude law;
 * `soft` compresses it for display (0.3 → one decade in flux = ×2 on screen).
 */
export function cometActivity(c: CometPhysics, r: number, soft = 0.3): number {
  if (!(r > 0)) return 0;
  const m = c.M1 + c.K1 * Math.log10(Math.max(r, 0.005));
  const on = 1 - smooth(c.rCut * 0.65, c.rCut, r);
  if (on <= 0) return 0;
  // Normalised so that 1P/Halley at 1 AU (M1 = 5.5) is 1.
  return Math.pow(10, -0.4 * soft * (m - 5.5)) * on;
}

/** Gas outflow speed (km/s) at r AU (Delsemme 1982). */
export function gasSpeedKms(r: number): number {
  return 0.85 / Math.sqrt(Math.max(r, 0.05));
}

/** Solar radiation-pressure β for a grain of radius s (µm), density ρ (g/cm³), Q_pr ≈ 1. */
export function betaForGrain(sMicron: number, rho = 1, qpr = 1): number {
  return (0.57 * qpr) / (rho * sMicron);
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Position (astro axes, heliocentric AU) at time jd of a grain with radiation-pressure parameter β
 * released `age` days earlier from a comet on conic `el` with zero relative velocity.
 */
export function dustGrainPosition(el: ConicElements, jd: number, beta: number, age: number, out: THREE.Vector3): THREE.Vector3 {
  conicState(el, jd - age, _r0, _v0);
  if (age <= 0) return out.copy(_r0);
  return propagateUniversal(_r0, _v0, age, el.mu * (1 - beta), out);
}

/** Ion pickup and acceleration: distance travelled along the release radius after `age` days (AU). */
export function ionTravel(age: number, uKms = SOLAR_WIND_KMS, accelDays = 0.35): number {
  if (age <= 0) return 0;
  // Velocity relaxes to u_sw with an e-folding time `accelDays` (observed tail accelerations
  // ~100× solar gravity near the nucleus; Brandt 1968): s = u (τ − τa (1 − e^{−τ/τa})).
  const u = uKms * KMS_TO_AUD;
  return u * (age - accelDays * (1 - Math.exp(-age / accelDays)));
}

/** Ion position (astro axes, heliocentric AU) at jd for ions released `age` days earlier. */
export function ionPosition(el: ConicElements, jd: number, age: number, out: THREE.Vector3): THREE.Vector3 {
  conicState(el, jd - age, _r0);
  const s = ionTravel(age);
  const rn = _r0.length();
  return out.copy(_r0).multiplyScalar(1 + s / rn);
}

/**
 * Direction of the ion tail (unit, astro axes): the solar wind as seen from the moving comet,
 * u_sw r̂ − v. Returns the aberration angle (rad) between it and the anti-solar direction.
 */
export function ionTailAxis(r: THREE.Vector3, v: THREE.Vector3, out: THREE.Vector3, uKms = SOLAR_WIND_KMS): number {
  const u = uKms * KMS_TO_AUD;
  _a.copy(r).normalize();
  out.copy(_a).multiplyScalar(u).sub(v).normalize();
  return Math.acos(Math.min(1, Math.max(-1, out.dot(_a))));
}

/** The β samples of the dust grid (from millimetre grains to sub-micron smoke). */
export function dustBetas(n: number, bMin = 0.004, bMax = 0.9): Float64Array {
  const out = new Float64Array(n);
  for (let j = 0; j < n; j++) out[j] = bMin * Math.pow(bMax / bMin, j / (n - 1));
  return out;
}

/** Age samples (days), denser near the nucleus: τ_i = maxAge (i/(n−1))^p. */
export function tailAges(n: number, maxAge: number, p = 1.7): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = maxAge * Math.pow(i / (n - 1), p);
  return out;
}

export interface CometTailGrid {
  /** Dust: nAge × nBeta positions relative to the nucleus (astro axes, AU), row-major by age. */
  dust: Float32Array;
  /** Ion: nIon positions relative to the nucleus (astro axes, AU). */
  ion: Float32Array;
  /** Heliocentric distance (AU) of the nucleus at each dust age (for production at release). */
  releaseR: Float32Array;
  /** Heliocentric distance at each ion age. */
  ionReleaseR: Float32Array;
}

export function makeTailGrid(nAge: number, nBeta: number, nIon: number): CometTailGrid {
  return {
    dust: new Float32Array(nAge * nBeta * 3),
    ion: new Float32Array(nIon * 3),
    releaseR: new Float32Array(nAge),
    ionReleaseR: new Float32Array(nIon),
  };
}

const _r0 = new THREE.Vector3();
const _v0 = new THREE.Vector3();
const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _a = new THREE.Vector3();

/**
 * Fill a Finson–Probstein grid at jd: `ages` × `betas` dust positions and `ionAges` ion positions,
 * all relative to the nucleus. Positions are exact two-body solutions (no integration error).
 */
export function computeTailGrid(
  el: ConicElements,
  jd: number,
  ages: Float64Array,
  betas: Float64Array,
  ionAges: Float64Array,
  g: CometTailGrid,
): void {
  conicState(el, jd, _n);
  const nb = betas.length;
  for (let i = 0; i < ages.length; i++) {
    const age = ages[i];
    conicState(el, jd - age, _r0, _v0);
    g.releaseR[i] = _r0.length();
    for (let j = 0; j < nb; j++) {
      const k = (i * nb + j) * 3;
      if (age <= 0) {
        g.dust[k] = g.dust[k + 1] = g.dust[k + 2] = 0;
        continue;
      }
      propagateUniversal(_r0, _v0, age, el.mu * (1 - betas[j]), _p);
      g.dust[k] = _p.x - _n.x;
      g.dust[k + 1] = _p.y - _n.y;
      g.dust[k + 2] = _p.z - _n.z;
    }
  }
  for (let i = 0; i < ionAges.length; i++) {
    const age = ionAges[i];
    conicState(el, jd - age, _r0);
    const rn = _r0.length();
    g.ionReleaseR[i] = rn;
    const s = 1 + ionTravel(age) / rn;
    g.ion[i * 3] = _r0.x * s - _n.x;
    g.ion[i * 3 + 1] = _r0.y * s - _n.y;
    g.ion[i * 3 + 2] = _r0.z * s - _n.z;
  }
}

/** Oldest dust (days) worth drawing: dusty comets keep long tails. */
export function dustMaxAge(c: CometPhysics): number {
  return 18 + 42 * c.dust;
}

/** Ion lifetime to show (days). */
export const ION_MAX_AGE = 2.6;

export { MU_SUN };
