import { cieXYZ } from './blackbody';
import { LINES, wavelengthToRGB } from './spectrum';

/**
 * Stellar populations for the galaxy module: the initial mass function, main-sequence
 * relations and lifetimes, interstellar extinction and the colours of ionised gas.
 * Masses in M☉, luminosities in L☉, temperatures in K, times in Myr, lengths in pc.
 */

// ——— Initial mass function ———————————————————————————————————————————————

/**
 * Kroupa (2001, MNRAS 322, 231) IMF ξ(m) ∝ m^−1.3 (0.08–0.5 M☉), m^−2.3 (> 0.5 M☉).
 * Inverse-CDF sample on [mMin, mMax] from a uniform u ∈ [0, 1).
 */
export function sampleKroupa(u: number, mMin = 0.08, mMax = 120): number {
  const segs: Array<[number, number, number, number]> = []; // [lo, hi, alpha, coefficient]
  const k1 = 1;
  const k2 = k1 * 0.5; // continuity at 0.5 M☉: k1·0.5^−1.3 = k2·0.5^−2.3
  if (mMin < 0.5) segs.push([mMin, Math.min(0.5, mMax), 1.3, k1]);
  if (mMax > 0.5) segs.push([Math.max(0.5, mMin), mMax, 2.3, k2]);
  const integ = (lo: number, hi: number, a: number, k: number) => (k * (Math.pow(hi, 1 - a) - Math.pow(lo, 1 - a))) / (1 - a);
  const w = segs.map((s) => integ(s[0], s[1], s[2], s[3]));
  const total = w.reduce((a, b) => a + b, 0);
  let x = u * total;
  for (let i = 0; i < segs.length; i++) {
    const [lo, hi, a, k] = segs[i];
    if (x <= w[i] || i === segs.length - 1) {
      const p = Math.pow(lo, 1 - a) + (Math.min(x, w[i]) * (1 - a)) / k;
      return Math.min(hi, Math.max(lo, Math.pow(p, 1 / (1 - a))));
    }
    x -= w[i];
  }
  return mMin;
}

// ——— Main sequence ———————————————————————————————————————————————————————

/** Main-sequence luminosity (L☉): textbook mass–luminosity relation, softened above 10 M☉. */
export function msLuminosity(m: number): number {
  if (m < 0.43) return 0.23 * Math.pow(m, 2.3);
  if (m < 2) return Math.pow(m, 4);
  if (m < 10) return 1.4 * Math.pow(m, 3.5);
  return 1.4 * Math.pow(10, 3.5) * Math.pow(m / 10, 2.7); // ≈ 5 × 10⁵ L☉ at 60 M☉ (Martins et al. 2005)
}

/** Main-sequence radius (R☉), Demircan & Kahraman (1991). */
export function msRadius(m: number): number {
  return m < 1.66 ? 1.06 * Math.pow(m, 0.945) : 1.33 * Math.pow(m, 0.555);
}

/** Effective temperature from L = 4πR²σT⁴ in solar units (T☉ = 5772 K). */
export function msTemperature(m: number): number {
  return 5772 * Math.pow(msLuminosity(m), 0.25) / Math.sqrt(msRadius(m));
}

/**
 * Main-sequence lifetime (Myr) for solar metallicity, log–log interpolated from the
 * Geneva grids (Schaller et al. 1992; Ekström et al. 2012).
 */
const LIFETIME_TABLE: ReadonlyArray<[number, number]> = [
  [0.6, 90000], [0.8, 25000], [1.0, 10000], [1.25, 4500], [1.5, 2700], [2.0, 1160], [2.5, 650],
  [3.0, 380], [4.0, 170], [5.0, 100], [7.0, 45], [9.0, 27], [12, 17], [15, 12], [20, 8.9],
  [25, 7.3], [40, 4.7], [60, 3.7], [85, 3.3], [120, 3.0],
];
export function msLifetime(m: number): number {
  const t = LIFETIME_TABLE;
  if (m <= t[0][0]) return t[0][1] * Math.pow(m / t[0][0], -2.5);
  for (let i = 1; i < t.length; i++) {
    if (m <= t[i][0]) {
      const [m0, l0] = t[i - 1];
      const [m1, l1] = t[i];
      const f = Math.log(m / m0) / Math.log(m1 / m0);
      return Math.exp(Math.log(l0) + f * (Math.log(l1) - Math.log(l0)));
    }
  }
  return t[t.length - 1][1];
}

/**
 * Hydrogen-ionising photon rate Q_H (photons/s) of an O/B main-sequence star, piecewise fit to
 * Martins, Schaerer & Hillier (2005) and Sternberg et al. (2003).
 */
export function ionisingPhotonRate(m: number): number {
  let lq: number;
  if (m < 20) lq = 48 + 8 * Math.log10(m / 20);
  else if (m < 30) lq = 48 + 5.1 * Math.log10(m / 20);
  else lq = 48.9 + 3.2 * Math.log10(m / 30);
  return Math.pow(10, lq);
}

/**
 * Strömgren radius (pc) of an HII region: R_S = (3 Q / (4π n² α_B))^{1/3},
 * case-B recombination α_B = 2.6 × 10⁻¹³ cm³ s⁻¹ at 10⁴ K (Osterbrock & Ferland 2006).
 */
export function stromgrenRadius(qH: number, nH = 30): number {
  const alphaB = 2.6e-13;
  const rcm = Math.cbrt((3 * qH) / (4 * Math.PI * nH * nH * alphaB));
  return rcm / 3.0856775814913673e18;
}

/** Spitzer (1978) D-type expansion: R(t) = R_S (1 + 7 c_i t / 4R_S)^{4/7}, c_i ≈ 10 km/s ≈ 10.2 pc/Myr. */
export function hiiRadius(rS: number, ageMyr: number, ci = 10.2): number {
  return rS * Math.pow(1 + (7 * ci * Math.max(0, ageMyr)) / (4 * Math.max(rS, 1e-3)), 4 / 7);
}

// ——— Interstellar extinction —————————————————————————————————————————————

/**
 * Cardelli, Clayton & Mathis (1989, ApJ 345, 245) extinction curve A_λ/A_V,
 * optical/near-IR branch (0.3–1.1 µm), for total-to-selective ratio R_V (3.1 diffuse ISM).
 */
export function ccmExtinction(lambdaNm: number, Rv = 3.1): number {
  const x = 1000 / lambdaNm; // µm⁻¹
  if (x < 1.1) {
    const a = 0.574 * Math.pow(x, 1.61);
    const b = -0.527 * Math.pow(x, 1.61);
    return a + b / Rv;
  }
  const y = x - 1.82;
  const a = 1 + y * (0.17699 + y * (-0.50447 + y * (-0.02427 + y * (0.72085 + y * (0.01979 + y * (-0.7753 + y * 0.32999))))));
  const b = y * (1.41338 + y * (2.28305 + y * (1.07233 + y * (-5.38434 + y * (-0.62251 + y * (5.3026 + y * -2.09002))))));
  return a + b / Rv;
}

/** Effective wavelengths (nm) used for the linear-sRGB channels. */
export const RGB_EFFECTIVE_NM = [612, 549, 465] as const;

/** Relative optical depth per RGB channel, τ_c/τ_V (reddening: blue is absorbed more). */
export function extinctionRGB(Rv = 3.1): [number, number, number] {
  return [ccmExtinction(RGB_EFFECTIVE_NM[0], Rv), ccmExtinction(RGB_EFFECTIVE_NM[1], Rv), ccmExtinction(RGB_EFFECTIVE_NM[2], Rv)];
}

// ——— Emission-line colours ———————————————————————————————————————————————

/** Linear-sRGB colour of a set of emission lines [nm, relative energy flux], luminance-normalised. */
export function lineBlendRGB(lines: ReadonlyArray<[number, number]>): [number, number, number] {
  let r = 0,
    g = 0,
    b = 0;
  for (const [nm, e] of lines) {
    const v = cieXYZ(nm)[1]; // luminous efficiency: luminance per unit energy
    const [cr, cg, cb] = wavelengthToRGB(nm);
    r += cr * v * e;
    g += cg * v * e;
    b += cb * v * e;
  }
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return [r / y, g / y, b / y];
}

/**
 * Colour of an HII region. Balmer lines at case-B ratios (Hα/Hβ = 2.86), [NII] and [SII] typical
 * of Galactic HII regions, and [OIII] 5007+4959 scaled by `excitation` (0 = low, 1 ≈ Orion-like core).
 * The mix of red Hα and blue-green Hβ/[OIII] is why star-forming regions look pink.
 */
export function hiiRGB(excitation = 0.3): [number, number, number] {
  const e = Math.max(0, excitation);
  return lineBlendRGB([
    [LINES.H_ALPHA, 2.86],
    [LINES.H_BETA, 1],
    [LINES.H_GAMMA, 0.47],
    [LINES.NII_6584, 0.55],
    [LINES.SII_6716, 0.18],
    [LINES.SII_6731, 0.14],
    [LINES.OIII_5007, 3.6 * e],
    [LINES.OIII_4959, 1.2 * e],
  ]);
}

/** Pure [OIII] 500.7 nm colour (teal), luminance-normalised. */
export function oiiiRGB(): [number, number, number] {
  return lineBlendRGB([
    [LINES.OIII_5007, 3],
    [LINES.OIII_4959, 1],
  ]);
}

// ——— Clusters ——————————————————————————————————————————————————————————————

/**
 * Radius (in units of the core radius) inside a King-like cluster, sampled from a Plummer
 * distribution truncated at the tidal radius c = r_t/r_c: M(<r) ∝ r³/(1 + r²)^{3/2}.
 */
export function sampleClusterRadius(u: number, concentration: number): number {
  const mt = Math.pow(concentration, 3) / Math.pow(1 + concentration * concentration, 1.5);
  const m = u * mt;
  // invert m = r³/(1+r²)^{3/2}  →  r = (m^{-2/3} − 1)^{-1/2}
  const q = Math.pow(Math.max(m, 1e-12), -2 / 3) - 1;
  return q > 0 ? 1 / Math.sqrt(q) : concentration;
}
