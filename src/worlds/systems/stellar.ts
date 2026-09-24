/**
 * Stellar physics for Possible Worlds: pure functions, no rendering.
 *
 * Units: masses in M☉, radii in R☉, luminosities in L☉, temperatures in K, distances in AU,
 * ages in Gyr, periods in days — unless a name says otherwise.
 *
 * References
 *  - Kroupa, P. 2001, MNRAS 322, 231 — the initial mass function (broken power law).
 *  - Eker, Z. et al. 2015, AJ 149, 131 — main-sequence mass–luminosity relation (six segments).
 *  - Boyajian, T. et al. 2012, ApJ 757, 112 — interferometric radii of K/M dwarfs (R(M) fit).
 *  - Pecaut, M. & Mamajek, E. 2013, ApJS 208, 9 — T_eff ↔ spectral type table.
 *  - Raghavan, D. et al. 2010, ApJS 190, 1; Duchêne, G. & Kraus, A. 2013, ARA&A 51, 269 —
 *    multiplicity fractions and the log-normal period distribution.
 *  - Holman, M. & Wiegert, P. 1999, AJ 117, 621 — orbital stability in binaries (S and P type).
 *  - Kopparapu, R. et al. 2013, ApJ 765, 131; 2014, ApJL 787, L29 — habitable-zone fluxes.
 */

export const T_SUN_K = 5772;
/** Solar radius in AU. */
export const R_SUN_AU = 6.957e8 / 1.495978707e11;

/* ——— Initial mass function ——— */

/** Kroupa (2001) segments: ξ(m) ∝ m^−α. Continuous at the break masses. */
const KROUPA = [
  { lo: 0.01, hi: 0.08, alpha: 0.3 },
  { lo: 0.08, hi: 0.5, alpha: 1.3 },
  { lo: 0.5, hi: 150, alpha: 2.3 },
];

/** Unnormalised Kroupa IMF ξ(m) = dN/dm. */
export function kroupaXi(m: number): number {
  // Continuity constants: k1 m^-0.3 = k2 m^-1.3 at 0.08; k2 m^-1.3 = k3 m^-2.3 at 0.5.
  if (m < 0.08) return m ** -0.3 * 0.08 ** -1;
  if (m < 0.5) return m ** -1.3;
  return 0.5 * m ** -2.3;
}

/** ∫ ξ dm over [a, b] (analytic, piecewise). */
export function kroupaIntegral(a: number, b: number): number {
  let s = 0;
  for (const seg of KROUPA) {
    const lo = Math.max(a, seg.lo), hi = Math.min(b, seg.hi);
    if (hi <= lo) continue;
    const k = kroupaXi(seg.lo) * seg.lo ** seg.alpha;
    const p = 1 - seg.alpha;
    s += (k * (hi ** p - lo ** p)) / p;
  }
  return s;
}

/**
 * Draw a stellar mass from the Kroupa IMF restricted to [mMin, mMax] by exact inversion of the
 * piecewise power law. `u` is a uniform deviate in [0, 1).
 */
export function sampleKroupa(u: number, mMin = 0.08, mMax = 8): number {
  const total = kroupaIntegral(mMin, mMax);
  let target = u * total;
  for (const seg of KROUPA) {
    const lo = Math.max(mMin, seg.lo), hi = Math.min(mMax, seg.hi);
    if (hi <= lo) continue;
    const w = kroupaIntegral(lo, hi);
    if (target <= w || seg === KROUPA[KROUPA.length - 1]) {
      const k = kroupaXi(seg.lo) * seg.lo ** seg.alpha;
      const p = 1 - seg.alpha;
      const v = lo ** p + (Math.min(target, w) * p) / k;
      return Math.min(hi, Math.max(lo, v ** (1 / p)));
    }
    target -= w;
  }
  return mMax;
}

/* ——— Main sequence ——— */

/** Eker et al. (2015) main-sequence mass–luminosity relation, L in L☉ (extrapolated below 0.179 M☉). */
export function msLuminosity(m: number): number {
  const lm = Math.log10(m);
  let ll: number;
  if (m <= 0.45) ll = 2.028 * lm - 0.976;
  else if (m <= 0.72) ll = 4.572 * lm - 0.102;
  else if (m <= 1.05) ll = 5.743 * lm - 0.007;
  else if (m <= 2.4) ll = 4.329 * lm + 0.01;
  else if (m <= 7) ll = 3.967 * lm + 0.093;
  else ll = 2.865 * lm + 1.105;
  return 10 ** ll;
}

/**
 * Main-sequence radius (R☉): Boyajian et al. (2012) quadratic for K/M dwarfs, blended to the
 * classical R ∝ M^0.8 → M^0.57 homology relations above; continuous at 0.7 and 1 M☉.
 */
export function msRadius(m: number): number {
  const low = (x: number) => 0.0906 + 0.6063 * x + 0.32 * x * x;
  if (m <= 0.7) return low(m);
  if (m <= 1) {
    const t = (m - 0.7) / 0.3;
    return low(0.7) * (1 - t) + m ** 0.8 * t;
  }
  return m ** 0.57;
}

/** Stefan–Boltzmann: T_eff = T☉ (L / R²)^¼. */
export const effectiveTemperature = (L: number, R: number) => T_SUN_K * Math.pow(L / (R * R), 0.25);
/** Inverse: L = R² (T/T☉)⁴. */
export const luminosityFrom = (R: number, T: number) => R * R * Math.pow(T / T_SUN_K, 4);

/** Main-sequence lifetime t ≈ 10 Gyr · M / L (fuel ∝ M, burn rate ∝ L). */
export const msLifetimeGyr = (m: number) => (10 * m) / msLuminosity(m);

/* ——— Spectral types ——— */

const SPT: Array<[string, number]> = [
  ['B0', 31400], ['B5', 15700], ['A0', 9700], ['A5', 8080], ['F0', 7220], ['F5', 6510], ['G0', 5920],
  ['G2', 5770], ['G5', 5660], ['K0', 5280], ['K5', 4440], ['M0', 3850], ['M2', 3560], ['M4', 3210],
  ['M5', 3060], ['M6', 2810], ['M7', 2680], ['M8', 2570], ['M9', 2380], ['L0', 2270],
];

/** Spectral class letter + subclass from T_eff (Pecaut & Mamajek 2013), e.g. "G2", "M5.5". */
export function spectralClass(T: number): string {
  if (T >= SPT[0][1]) return 'B0';
  for (let i = 0; i < SPT.length - 1; i++) {
    const [s0, t0] = SPT[i];
    const [s1, t1] = SPT[i + 1];
    if (T <= t0 && T >= t1) {
      const n0 = sptNumber(s0), n1 = sptNumber(s1);
      const n = n0 + ((t0 - T) / (t0 - t1)) * (n1 - n0);
      return sptName(Math.round(n * 2) / 2);
    }
  }
  return 'L0';
}
const LETTERS = 'OBAFGKML';
const sptNumber = (s: string) => LETTERS.indexOf(s[0]) * 10 + Number(s.slice(1));
function sptName(n: number): string {
  const L = LETTERS[Math.floor(n / 10)] ?? 'L';
  const sub = n - Math.floor(n / 10) * 10;
  return `${L}${Number.isInteger(sub) ? sub : sub.toFixed(1)}`;
}

/* ——— Multiplicity ——— */

/** Fraction of primaries of mass m with at least one stellar companion (Raghavan 2010; Duchêne & Kraus 2013). */
export function multiplicityFraction(m: number): number {
  if (m < 0.1) return 0.22;
  if (m < 0.6) return 0.27;
  if (m < 1.3) return 0.44;
  if (m < 2.5) return 0.5;
  return 0.6;
}

/** Log-normal orbital period distribution: mean and σ of log10(P / day). M dwarfs are more compact. */
export function periodDistribution(m: number): { mu: number; sigma: number } {
  return m < 0.6 ? { mu: 4.4, sigma: 2.0 } : { mu: 5.03, sigma: 2.28 };
}

/** Kepler III in solar units: a [AU] from P [days] and total mass [M☉]. */
export const semiMajorAxisAU = (Pdays: number, Mtot: number) => Math.cbrt(Mtot * (Pdays / 365.25) ** 2);
/** Period [days] from a [AU] and total mass [M☉]. */
export const periodDays = (aAU: number, Mtot: number) => 365.25 * Math.sqrt((aAU * aAU * aAU) / Mtot);

/**
 * Holman & Wiegert (1999) critical semi-major axes, in units of the binary separation.
 * μ = m₂/(m₁+m₂), e = binary eccentricity.
 *  S-type (planet around one star): stable if a < a_c.
 *  P-type (circumbinary): stable if a > a_c.
 */
export function holmanWiegertS(mu: number, e: number): number {
  return 0.464 - 0.38 * mu - 0.631 * e + 0.586 * mu * e + 0.15 * e * e - 0.198 * mu * e * e;
}
export function holmanWiegertP(mu: number, e: number): number {
  return 1.6 + 5.1 * e - 2.22 * e * e + 4.12 * mu - 4.27 * e * mu - 5.09 * mu * mu + 4.61 * e * e * mu * mu;
}

/* ——— Habitable zone ——— */

export type HZLimit = 'recentVenus' | 'runaway' | 'maxGreenhouse' | 'earlyMars';

/** Kopparapu et al. (2014) coefficients for a 1 M⊕ planet: S_eff = S☉ + aT + bT² + cT³ + dT⁴, T = T_eff − 5780 K. */
const KOPPARAPU: Record<HZLimit, [number, number, number, number, number]> = {
  recentVenus: [1.776, 2.136e-4, 2.533e-8, -1.332e-11, -3.097e-15],
  runaway: [1.107, 1.332e-4, 1.58e-8, -8.308e-12, -1.931e-15],
  maxGreenhouse: [0.356, 6.171e-5, 1.698e-9, -3.198e-12, -5.575e-16],
  earlyMars: [0.32, 5.547e-5, 1.526e-9, -2.874e-12, -5.011e-16],
};

/** Effective stellar flux (S⊕) at an HZ limit; valid for 2600 K ≤ T_eff ≤ 7200 K (clamped). */
export function hzFlux(limit: HZLimit, Teff: number): number {
  const [s, a, b, c, d] = KOPPARAPU[limit];
  const T = Math.min(7200, Math.max(2600, Teff)) - 5780;
  return s + a * T + b * T * T + c * T ** 3 + d * T ** 4;
}

export interface HabitableZone {
  /** Optimistic inner edge (recent Venus), AU. */
  recentVenus: number;
  /** Conservative inner edge (runaway greenhouse), AU. */
  runaway: number;
  /** Conservative outer edge (maximum greenhouse), AU. */
  maxGreenhouse: number;
  /** Optimistic outer edge (early Mars), AU. */
  earlyMars: number;
}

/** HZ distances d = √(L / S_eff) in AU for a star of luminosity L (L☉) and T_eff. */
export function habitableZone(L: number, Teff: number): HabitableZone {
  const d = (k: HZLimit) => Math.sqrt(L / hzFlux(k, Teff));
  return { recentVenus: d('recentVenus'), runaway: d('runaway'), maxGreenhouse: d('maxGreenhouse'), earlyMars: d('earlyMars') };
}

/** Classify a flux S (S⊕) relative to the HZ. */
export type HZStatus = 'too hot' | 'optimistic inner HZ' | 'habitable zone' | 'optimistic outer HZ' | 'too cold';
export function hzStatus(S: number, Teff: number): HZStatus {
  if (S > hzFlux('recentVenus', Teff)) return 'too hot';
  if (S > hzFlux('runaway', Teff)) return 'optimistic inner HZ';
  if (S >= hzFlux('maxGreenhouse', Teff)) return 'habitable zone';
  if (S >= hzFlux('earlyMars', Teff)) return 'optimistic outer HZ';
  return 'too cold';
}

/** Snow (water-ice) line in the protoplanetary disk: 2.7 AU (L/L☉)^½ (Hayashi 1981 scaling). */
export const snowLineAU = (L: number) => 2.7 * Math.sqrt(L);

/**
 * Giant-planet occurrence (Johnson et al. 2010, PASP 122, 905): f = 0.07 (M★/M☉)^1.0 · 10^(1.2 [Fe/H]).
 */
export const giantPlanetOccurrence = (m: number, feh: number) => Math.min(0.9, 0.07 * m * Math.pow(10, 1.2 * feh));
