/**
 * Planetary physics for Possible Worlds: pure functions, no rendering.
 *
 * Units: planet masses in M⊕, radii in R⊕, stellar masses in M☉, radii in R☉, distances in AU.
 *
 * References
 *  - Chen, J. & Kipping, D. 2017, ApJ 834, 17 — probabilistic mass–radius relation ("Forecaster"):
 *    Terran R ∝ M^0.279 (< 2.04 M⊕), Neptunian R ∝ M^0.589 (< 0.414 M♃), Jovian R ∝ M^−0.044.
 *  - Gladman, B. et al. 1996, Icarus 122, 166 — tidal despinning (locking) timescale.
 *  - Zahnle, K. & Catling, D. 2017, ApJ 843, 122 — the "cosmic shoreline" I ∝ v_esc⁴ that separates
 *    worlds with and without atmospheres.
 *  - Sudarsky, D., Burrows, A. & Pinto, P. 2000, ApJ 538, 885 — giant-planet albedo classes I–V.
 *  - Fulton, B. et al. 2017, AJ 154, 109; Owen & Wu 2017 — the radius valley (photoevaporation).
 *  - Chambers, J. et al. 1996, Icarus 119, 261 — spacing in mutual Hill radii and stability.
 */

import { R_SUN_AU } from './stellar';

export const M_EARTH_KG = 5.9722e24;
export const R_EARTH_KM = 6371;
export const M_JUP_EARTH = 317.83;
export const R_JUP_EARTH = 11.209;
const G = 6.6743e-11;
const M_SUN_KG = 1.98847e30;
const AU_M = 1.495978707e11;

/* ——— Mass–radius ——— */

/** Chen & Kipping (2017) transition masses (M⊕). */
export const CK_TERRAN_MAX = 2.04;
export const CK_NEPTUNIAN_MAX = 0.414 * M_JUP_EARTH;

/**
 * Mean radius (R⊕) from mass (M⊕), Chen & Kipping (2017) continuous broken power law.
 * The Jovian branch is normalised to the forecaster's fit, so a 1 M♃ cold planet comes out
 * ≈ 1.1–1.2 R♃ (their mean includes inflated hot Jupiters); `coldGiant` removes that bias.
 */
export function massRadius(m: number, coldGiant = false): number {
  const rT = (x: number) => Math.pow(x, 0.279);
  if (m <= CK_TERRAN_MAX) return rT(m);
  const r2 = rT(CK_TERRAN_MAX);
  if (m <= CK_NEPTUNIAN_MAX) return r2 * Math.pow(m / CK_TERRAN_MAX, 0.589);
  const r3 = r2 * Math.pow(CK_NEPTUNIAN_MAX / CK_TERRAN_MAX, 0.589);
  const r = r3 * Math.pow(m / CK_NEPTUNIAN_MAX, -0.044);
  return coldGiant ? r * 0.85 : r;
}

/** Bulk density (g/cm³) from M (M⊕) and R (R⊕). Earth = 5.51. */
export const bulkDensity = (m: number, r: number) => (5.514 * m) / (r * r * r);
/** Surface gravity in g⊕. */
export const surfaceGravity = (m: number, r: number) => m / (r * r);
/** Escape velocity, km/s (Earth 11.19). */
export const escapeVelocity = (m: number, r: number) => 11.186 * Math.sqrt(m / r);

/* ——— Irradiation ——— */

/** Bolometric flux relative to Earth's: S = L / a² (L in L☉, a in AU). */
export const insolation = (L: number, a: number) => L / (a * a);

/**
 * Equilibrium temperature with full heat redistribution:
 * T_eq = T★ √(R★ / 2a) (1 − A)^¼   (R★ and a in the same units).
 */
export function equilibriumTemperature(Tstar: number, RstarSun: number, aAU: number, albedo: number): number {
  return Tstar * Math.sqrt((RstarSun * R_SUN_AU) / (2 * aAU)) * Math.pow(Math.max(0, 1 - albedo), 0.25);
}

/** Sub-stellar-point temperature of an airless, locked, zero-redistribution world: √2 × T_eq. */
export const substellarTemperature = (Teq: number) => Math.SQRT2 * Teq;

/* ——— Orbits ——— */

/** Mutual Hill radius (Chambers et al. 1996), AU: R_H = ((m₁+m₂)/3M★)^⅓ (a₁+a₂)/2. */
export function mutualHillRadius(m1: number, m2: number, a1: number, a2: number, Mstar: number): number {
  const q = ((m1 + m2) * M_EARTH_KG) / (3 * Mstar * M_SUN_KG);
  return Math.cbrt(q) * 0.5 * (a1 + a2);
}

/**
 * Semi-major axis of the next planet so that (a₂ − a₁) = Δ · R_H,mutual.
 * Solving a₂ − a₁ = Δ k (a₁+a₂)/2 with k = ((m₁+m₂)/3M★)^⅓ gives a₂ = a₁ (1 + Δk/2)/(1 − Δk/2).
 */
export function nextHillSpacedOrbit(a1: number, m1: number, m2: number, delta: number, Mstar: number): number {
  const k = Math.cbrt(((m1 + m2) * M_EARTH_KG) / (3 * Mstar * M_SUN_KG));
  const x = (delta * k) / 2;
  if (x >= 0.95) return a1 * 40; // pathological (enormous planet around a tiny star)
  return (a1 * (1 + x)) / (1 - x);
}

/** Separation of neighbours in mutual Hill radii. */
export const hillSeparation = (a1: number, m1: number, a2: number, m2: number, Mstar: number) =>
  (a2 - a1) / mutualHillRadius(m1, m2, a1, a2, Mstar);

/** Planet's own Hill radius (AU), with pericentre distance: r_H = a(1−e) (m/3M★)^⅓. */
export const hillRadius = (a: number, e: number, m: number, Mstar: number) =>
  a * (1 - e) * Math.cbrt((m * M_EARTH_KG) / (3 * Mstar * M_SUN_KG));

/* ——— Spin ——— */

/**
 * Tidal locking (despinning) time in years, Gladman et al. (1996):
 *   t = ω a⁶ I Q / (3 G M★² k₂ R⁵),  I = α m R²
 * with ω the initial spin rate (P₀ = 12 h), Q/k₂ the tidal dissipation of the body.
 */
export function tidalLockTimeYears(mEarth: number, rEarth: number, aAU: number, MstarSun: number, gaseous: boolean): number {
  const omega = (2 * Math.PI) / (12 * 3600);
  const a = aAU * AU_M;
  const m = mEarth * M_EARTH_KG;
  const R = rEarth * R_EARTH_KM * 1e3;
  const alpha = gaseous ? 0.25 : 0.33;
  const Q = gaseous ? 1e5 : 100;
  const k2 = gaseous ? 0.4 : 0.3;
  const M = MstarSun * M_SUN_KG;
  const t = (omega * a ** 6 * alpha * m * Q) / (3 * G * M * M * k2 * R * R * R);
  return t / (365.25 * 86400);
}

/** Synodic (solar) day from sidereal rotation and orbital period (same units; prograde spin). */
export function solarDay(Prot: number, Porb: number): number {
  const f = 1 / Prot - 1 / Porb;
  return Math.abs(f) < 1e-12 ? Infinity : 1 / Math.abs(f);
}

/**
 * Rotational flattening f ≈ 0.68 q, q = ω²R³/GM (fits Jupiter 0.065 and Saturn 0.098 to ~10%;
 * the Darwin–Radau relation with realistic central condensation).
 */
export function flattening(mEarth: number, rEarth: number, ProtHours: number): number {
  const w = (2 * Math.PI) / (ProtHours * 3600);
  const R = rEarth * R_EARTH_KM * 1e3;
  const q = (w * w * R * R * R) / (G * mEarth * M_EARTH_KG);
  return Math.min(0.2, 0.68 * q);
}

/* ——— Atmospheres ——— */

/**
 * Zahnle & Catling (2017) cosmic shoreline: a body keeps an atmosphere if its cumulative
 * (XUV-weighted) insolation is below I_crit ∝ v_esc⁴. Normalised so that Earth, Venus, Mars and
 * Titan keep theirs and Mercury and the Moon do not. `xuv` multiplies the bolometric flux for
 * active M dwarfs (their XUV output per bolometric flux is 10–100× the Sun's over a Gyr).
 */
export function keepsAtmosphere(mEarth: number, rEarth: number, S: number, xuv = 1): boolean {
  const v = escapeVelocity(mEarth, rEarth);
  const Scrit = 25 * Math.pow(v / 11.186, 4);
  return S * xuv < Scrit;
}

/** Sudarsky (2000) giant-planet class from T_eq. */
export type SudarskyClass = 'I' | 'II' | 'III' | 'IV' | 'V';
export function sudarskyClass(Teq: number): SudarskyClass {
  if (Teq < 150) return 'I';
  if (Teq < 350) return 'II';
  if (Teq < 800) return 'III';
  if (Teq < 1400) return 'IV';
  return 'V';
}
export const SUDARSKY_TEXT: Record<SudarskyClass, string> = {
  I: 'Class I · ammonia clouds',
  II: 'Class II · water clouds',
  III: 'Class III · cloudless, Rayleigh-blue',
  IV: 'Class IV · alkali-metal absorbers',
  V: 'Class V · silicate clouds',
};
/** Typical Bond albedo per Sudarsky class. */
export const SUDARSKY_ALBEDO: Record<SudarskyClass, number> = { I: 0.34, II: 0.8, III: 0.12, IV: 0.03, V: 0.4 };
