/**
 * Physics of the interstellar medium used by the nebula renderer.
 *
 * Everything here is a pure function of physical inputs so it can be unit-tested and so the
 * GPU only ever receives numbers that came from real equations:
 *
 *  - Photoionization: blackbody ionizing photon rates, hardness fractions above the ionization
 *    thresholds of O⁺ and He⁺, Case-B recombination, Strömgren radius, Spitzer D-type expansion.
 *    Osterbrock & Ferland (2006) "Astrophysics of Gaseous Nebulae and AGN", 2nd ed.;
 *    Hui & Gnedin (1997) MNRAS 292, 27 (α_B fit); Strömgren (1939) ApJ 89, 526;
 *    Spitzer (1978) "Physical Processes in the Interstellar Medium".
 *  - Emission lines: Case-B Balmer ratios (O&F Table 4.4), fixed doublet ratios from atomic
 *    transition probabilities ([OIII] 5007/4959 ≈ 2.98, [NII] 6584/6548 ≈ 3.05),
 *    [SII] 6716/6731 density diagnostic (McCall 1984, MNRAS 208, 253).
 *  - Dust: Cardelli, Clayton & Mathis (1989) ApJ 345, 245 extinction law; gas-to-dust
 *    N_H/E(B−V) = 5.8 × 10²¹ cm⁻² mag⁻¹ (Bohlin, Savage & Drake 1978); albedo and
 *    Henyey–Greenstein asymmetry g of Milky Way dust (Draine 2003, ARA&A 41, 241).
 *  - Shocks and expansion: Sedov–Taylor blast wave (Sedov 1959; Taylor 1950), free expansion,
 *    homologous (Hubble-like) flows of planetary nebulae and young remnants.
 *  - Stars: ionizing fluxes of O dwarfs (Martins, Schaerer & Hillier 2005, A&A 436, 1049).
 */
import { C, H_PLANCK, K_B, PC, YEAR } from './constants';
import { cieXYZ, xyzToLinearSRGB } from './blackbody';
import { LINES, wavelengthToRGB, luminousEfficiency } from './spectrum';

/** Electron-volt in joules. */
export const EV = 1.602176634e-19;
/** Parsec in centimetres (the ISM's natural length unit pairs pc with cm⁻³ densities). */
export const PC_CM = PC * 100;
/** Hydrogen mass in grams. */
export const M_H_G = 1.6735575e-24;

/** Ionization potentials in eV (NIST). */
export const IONIZATION_EV = {
  H: 13.598,
  He: 24.587,
  /** He⁺ → He²⁺ (He II emission comes from recombining He²⁺). */
  HeII: 54.418,
  /** O⁺ → O²⁺: photons above this make the [OIII] zone. */
  OII: 35.121,
  /** O²⁺ → O³⁺: inside the He²⁺ zone oxygen is mostly O³⁺, so [OIII] weakens. */
  OIII: 54.936,
  N: 14.534,
  S: 10.36,
  SII: 23.338,
} as const;

// ——— Recombination ———————————————————————————————————————————————————————————

/** Case-B hydrogen recombination coefficient α_B(T) in cm³ s⁻¹ (Hui & Gnedin 1997, eq. A2). */
export function alphaB(T = 1e4): number {
  const lam = (2 * 157807) / T;
  return (2.753e-14 * Math.pow(lam, 1.5)) / Math.pow(1 + Math.pow(lam / 2.74, 0.407), 2.242);
}

/** Case-B Balmer line energy ratios relative to Hβ at T = 10⁴ K, n_e = 100 cm⁻³ (O&F Table 4.4). */
export const BALMER_CASE_B = { Ha: 2.86, Hb: 1.0, Hg: 0.468 } as const;

/** Hβ emission coefficient 4πj/(n_e n_p) in erg cm³ s⁻¹ (O&F Table 4.4, 10⁴ K). */
export const HBETA_EMISSIVITY = 1.24e-25;

/** Hα photons emitted per Case-B recombination at 10⁴ K (α_eff(Hα)/α_B ≈ 1.17e-13 / 2.59e-13). */
export const HALPHA_PER_RECOMBINATION = 0.45;

/** Fixed doublet ratios set by the Einstein A-values of the shared upper level. */
export const DOUBLET = { OIII_5007_4959: 2.98, NII_6584_6548: 3.05 } as const;

// ——— Blackbody ionizing photons ————————————————————————————————————————————————

/**
 * ∫_{x0}^{∞} x² / (eˣ − 1) dx — the dimensionless blackbody photon-number integral above
 * x0 = hν₀/kT, by the exact series Σ_k e^{−k x0}(x0²/k + 2x0/k² + 2/k³).
 */
export function photonIntegral(x0: number): number {
  if (x0 <= 0) return 2.4041138063191885; // 2ζ(3)
  let sum = 0;
  for (let k = 1; k <= 400; k++) {
    const e = Math.exp(-k * x0);
    const term = e * ((x0 * x0) / k + (2 * x0) / (k * k) + 2 / (k * k * k));
    sum += term;
    if (term < sum * 1e-12) break;
  }
  return sum;
}

/**
 * Photons per second above the energy `eV` emitted by a spherical blackbody of effective
 * temperature T (K) and radius R (m): Q = 4πR² · (2π/c²)(kT/h)³ · ∫x²/(eˣ−1)dx.
 */
export function blackbodyPhotonRate(T: number, radiusM: number, eV = IONIZATION_EV.H): number {
  const kT = K_B * T;
  const x0 = (eV * EV) / kT;
  const perArea = ((2 * Math.PI) / (C * C)) * Math.pow(kT / H_PLANCK, 3) * photonIntegral(x0);
  return 4 * Math.PI * radiusM * radiusM * perArea;
}

/**
 * Hardness: fraction of hydrogen-ionizing photons (> 13.6 eV) that are also above `eV`.
 * For a 40 kK O star the O²⁺-making fraction (> 35 eV) is ~5 %; for a 120 kK planetary-nebula
 * nucleus it is ~40 %, which is why planetary nebulae glow in [OIII].
 */
export function photonFractionAbove(T: number, eV: number): number {
  const kT = (K_B * T) / EV;
  return photonIntegral(eV / kT) / photonIntegral(IONIZATION_EV.H / kT);
}

/** Helium abundance by number, y = n_He / n_H. */
export const Y_HE = 0.1;
/** Case-B recombination coefficients of He⁰ and He⁺ relative to H at 10⁴ K (hydrogenic scaling for He⁺). */
export const ALPHA_HEI_OVER_H = 1.05;
export const ALPHA_HEII_OVER_H = 5.3;

export type Zone = 'He+' | 'O++' | 'He++';

/**
 * Where an ionization zone ends, expressed as the fraction of the *hydrogen* photon budget C_H
 * (0 < C ≤ 1, see photonBudgetK). Photons harder than 24.6 eV are eaten mainly by helium
 * (abundance y = 0.1), so a zone ends where C_H = f_X / (y a_X): f_X is the hardness fraction
 * above the ion's threshold and a_X its recombination rate relative to hydrogen.
 * Reproduces Osterbrock & Ferland §2.5: the He⁺ zone fills the H⁺ zone for T* ≳ 40 kK, and
 * [OIII]/He II cores grow as the star heats up. A value of 1 means "fills the H⁺ zone".
 */
export function zoneThreshold(T: number, zone: Zone): number {
  let c: number;
  if (zone === 'He+') c = photonFractionAbove(T, IONIZATION_EV.He) / (Y_HE * ALPHA_HEI_OVER_H);
  else if (zone === 'O++') c = photonFractionAbove(T, IONIZATION_EV.OII) / (Y_HE * ALPHA_HEI_OVER_H);
  else c = photonFractionAbove(T, IONIZATION_EV.HeII) / (Y_HE * ALPHA_HEII_OVER_H);
  return Math.min(1, Math.max(1e-6, c));
}

// ——— H II regions ————————————————————————————————————————————————————————————

/** Strömgren radius R_S = (3Q / (4π n² α_B))^{1/3}, in parsecs (n in cm⁻³, Q in s⁻¹). */
export function stromgrenRadiusPc(Q: number, n: number, T = 1e4): number {
  const r3 = (3 * Q) / (4 * Math.PI * n * n * alphaB(T));
  return Math.cbrt(r3) / PC_CM;
}

/**
 * The constant K of the photon-budget integral used by the volume bake:
 * along a ray from the star, the fraction of ionizing photons already used up at radius r is
 *   C(r) = K ∫₀ʳ n(s)² s² ds   (s in pc, n in cm⁻³),   K = 4π α_B pc³ / Q.
 * The ionization front sits where C = 1 (Strömgren's balance, direction by direction), which
 * is what carves pillars: dense clumps use up photons and leave neutral shadows behind them.
 */
export function photonBudgetK(Q: number, T = 1e4): number {
  return (4 * Math.PI * alphaB(T) * Math.pow(PC_CM, 3)) / Q;
}

/**
 * Spitzer's D-type expansion of an H II region: R(t) = R_S (1 + 7 c_i t / (4 R_S))^{4/7},
 * with c_i ≈ 10 km/s the sound speed of the ionized gas. t in years, radii in pc.
 */
export function spitzerRadiusPc(rsPc: number, tYears: number, ciKmS = 10): number {
  const ciPcPerYr = (ciKmS * 1e3 * YEAR) / PC;
  return rsPc * Math.pow(1 + (7 * ciPcPerYr * tYears) / (4 * rsPc), 4 / 7);
}

/** Surface brightness of Hα in rayleighs for an emission measure EM (pc cm⁻⁶) at T = 10⁴ K. */
export const halphaRayleighs = (emPcCm6: number, T = 1e4) => 0.361 * emPcCm6 * Math.pow(T / 1e4, -0.9);

// ——— O stars ————————————————————————————————————————————————————————————————

export interface IonizingStarType {
  /** MK spectral type. */
  type: string;
  /** Effective temperature (K). */
  teff: number;
  /** log10 of the H-ionizing photon rate (s⁻¹). */
  logQ: number;
  /** Absolute visual magnitude. */
  mv: number;
}

/**
 * O dwarf calibration, rounded from the observational T_eff scale of Martins, Schaerer &
 * Hillier (2005, Table 4); B0 V extrapolated. Good to ~0.1 dex in Q — ample for a label.
 */
export const O_DWARFS: readonly IonizingStarType[] = [
  { type: 'O3 V', teff: 44850, logQ: 49.64, mv: -5.78 },
  { type: 'O4 V', teff: 42860, logQ: 49.47, mv: -5.55 },
  { type: 'O5 V', teff: 40860, logQ: 49.26, mv: -5.33 },
  { type: 'O6 V', teff: 38870, logQ: 49.02, mv: -5.11 },
  { type: 'O7 V', teff: 36870, logQ: 48.75, mv: -4.88 },
  { type: 'O8 V', teff: 34880, logQ: 48.44, mv: -4.66 },
  { type: 'O9 V', teff: 32880, logQ: 48.08, mv: -4.43 },
  { type: 'O9.5 V', teff: 31880, logQ: 47.88, mv: -4.32 },
  { type: 'B0 V', teff: 30000, logQ: 47.4, mv: -4.0 },
];

/** Describe an ionizing photon rate as an equivalent number of O dwarfs of the nearest type. */
export function describeIonizingFlux(Q: number): string {
  const lq = Math.log10(Q);
  if (lq < O_DWARFS[O_DWARFS.length - 1].logQ - 0.3) return 'weaker than one B0 V star';
  // Prefer the hottest type whose count is at least one.
  for (const s of O_DWARFS) {
    const n = Q / Math.pow(10, s.logQ);
    if (n >= 0.8) {
      const k = Math.round(n);
      return k <= 1 ? `≈ one ${s.type} star` : k < 100 ? `≈ ${k} × ${s.type}` : `≈ ${Math.round(n / 10) * 10} × ${s.type}`;
    }
  }
  return `≈ one ${O_DWARFS[O_DWARFS.length - 1].type} star`;
}

// ——— Emission-line diagnostics ————————————————————————————————————————————————

/**
 * [SII] λ6716/λ6731 doublet ratio as a function of electron density (McCall 1984):
 * R = 1.49 (1 + 3.77x)/(1 + 12.8x), x = 10⁻⁴ n_e (T/10⁴ K)^{−1/2}.
 * 1.49 in the low-density limit, 0.44 at high density — the classic density probe.
 */
export function siiRatio(ne: number, T = 1e4): number {
  const x = 1e-4 * ne * Math.pow(T / 1e4, -0.5);
  return (1.49 * (1 + 3.77 * x)) / (1 + 12.8 * x);
}

/** Inverse of siiRatio: electron density (cm⁻³) from the observed doublet ratio. */
export function densityFromSii(R: number, T = 1e4): number {
  const r = Math.min(1.489, Math.max(0.441, R));
  const x = (1.49 - r) / (12.8 * r - 5.6173);
  return (x / 1e-4) * Math.pow(T / 1e4, 0.5);
}

// ——— Dust ————————————————————————————————————————————————————————————————————

/** Total-to-selective extinction of diffuse Milky Way dust. */
export const RV_MILKY_WAY = 3.1;
/** A_V per hydrogen column (mag cm²): N_H/E(B−V) = 5.8e21 (Bohlin+ 1978) with R_V = 3.1. */
export const AV_PER_NH = RV_MILKY_WAY / 5.8e21;
/** Dust single-scattering albedo and HG asymmetry in the V band (Draine 2003). */
export const DUST_ALBEDO_V = 0.6;
export const DUST_HG_G = 0.6;

/**
 * Cardelli, Clayton & Mathis (1989) extinction law A_λ/A_V for 0.3 ≤ 1/λ[µm] ≤ 8
 * (IR power law, optical/NIR polynomial, UV with the 2175 Å bump).
 */
export function ccm89(nm: number, Rv = RV_MILKY_WAY): number {
  const x = 1000 / nm; // µm⁻¹
  let a: number;
  let b: number;
  if (x < 1.1) {
    const p = Math.pow(Math.max(x, 0.3), 1.61);
    a = 0.574 * p;
    b = -0.527 * p;
  } else if (x <= 3.3) {
    const y = x - 1.82;
    a = 1 + y * (0.17699 + y * (-0.50447 + y * (-0.02427 + y * (0.72085 + y * (0.01979 + y * (-0.7753 + y * 0.32999))))));
    b = y * (1.41338 + y * (2.28305 + y * (1.07233 + y * (-5.38434 + y * (-0.62251 + y * (5.3026 + y * -2.09002))))));
  } else {
    const xx = Math.min(x, 8);
    let fa = 0;
    let fb = 0;
    if (xx >= 5.9) {
      const d = xx - 5.9;
      fa = -0.04473 * d * d - 0.009779 * d * d * d;
      fb = 0.213 * d * d + 0.1207 * d * d * d;
    }
    a = 1.752 - 0.316 * xx - 0.104 / ((xx - 4.67) * (xx - 4.67) + 0.341) + fa;
    b = -3.09 + 1.825 * xx + 1.206 / ((xx - 4.62) * (xx - 4.62) + 0.263) + fb;
  }
  return a + b / Rv;
}

/** V-band optical depth per parsec of gas with hydrogen density n (cm⁻³). */
export const tauVPerPc = (n: number, dustToGas = 1) => (n * AV_PER_NH * PC_CM * dustToGas) / 1.0857;

/**
 * Extinction from the Balmer decrement: A_V = R_V · 2.5 log10((Hα/Hβ)_obs / 2.86) / (k(Hβ) − k(Hα)),
 * k(λ) = R_V A_λ/A_V.
 */
export function avFromBalmerDecrement(haOverHb: number, Rv = RV_MILKY_WAY): number {
  const kb = Rv * ccm89(LINES.H_BETA, Rv);
  const ka = Rv * ccm89(LINES.H_ALPHA, Rv);
  const ebv = (2.5 / (kb - ka)) * Math.log10(haOverHb / BALMER_CASE_B.Ha);
  return Math.max(0, Rv * ebv);
}

// ——— Colour of lines and continua ————————————————————————————————————————————

export type LineId = 'Ha' | 'Hb' | 'Hg' | 'OIII' | 'NII' | 'SII' | 'HeI' | 'HeII';

/**
 * The emission lines the renderer carries, in the order of the GPU accumulators.
 * `nm` is the (flux-weighted) wavelength; doublets are folded into their strong member.
 */
export const NEBULA_LINES: ReadonlyArray<{ id: LineId; nm: number; label: string }> = [
  { id: 'Ha', nm: LINES.H_ALPHA, label: 'Hα 656' },
  { id: 'Hb', nm: LINES.H_BETA, label: 'Hβ 486' },
  { id: 'Hg', nm: LINES.H_GAMMA, label: 'Hγ 434' },
  { id: 'OIII', nm: (LINES.OIII_5007 * DOUBLET.OIII_5007_4959 + LINES.OIII_4959) / (DOUBLET.OIII_5007_4959 + 1), label: '[OIII] 501' },
  { id: 'NII', nm: LINES.NII_6584, label: '[NII] 658' },
  { id: 'SII', nm: (LINES.SII_6716 + LINES.SII_6731) / 2, label: '[SII] 672' },
  { id: 'HeI', nm: LINES.HEI_5876, label: 'He I 588' },
  { id: 'HeII', nm: LINES.HEII_4686, label: 'He II 469' },
];

export type Palette = 'true' | 'sho' | 'hoo';

/**
 * Linear-sRGB contribution per unit *energy* of a monochromatic line: the gamut-mapped
 * spectral chromaticity scaled by the photopic efficiency ȳ(λ). This is what an eye or a
 * colour camera integrates, so a watt of [OIII] 501 nm looks ~4× brighter than a watt of Hα.
 */
export function trueLineRGB(nm: number): [number, number, number] {
  const [r, g, b] = wavelengthToRGB(nm);
  const v = luminousEfficiency(nm);
  return [r * v, g * v, b * v];
}

/**
 * Display colour (linear sRGB per unit line energy) of each carried line in a palette.
 * - 'true': physical colour (trueLineRGB) — H II regions come out pink (Hα + Hβ + Hγ), [OIII]
 *           cores greenish-white, exactly as the eye/a colour camera would record them.
 * - 'sho':  the Hubble palette: [SII] → red, Hα → green, [OIII] → blue (HST F673N/F656N/F502N).
 *           Press images stretch each narrowband channel independently; the gains below do
 *           the same for typical line ratios (Hα : [OIII] : [SII] ≈ 2.9 : 1.5 : 0.3 in Hβ
 *           units), so H II interiors come out teal and ionization fronts gold.
 * - 'hoo':  amateur bicolour Hα → red, [OIII] → teal (green + blue).
 * Narrowband colours carry roughly the same luminance as true colour so one exposure fits all.
 */
export function paletteLineColours(p: Palette): Record<LineId, [number, number, number]> {
  const out = {} as Record<LineId, [number, number, number]>;
  for (const l of NEBULA_LINES) out[l.id] = p === 'true' ? trueLineRGB(l.nm) : [0, 0, 0];
  if (p === 'sho') {
    out.SII = [1.25, 0.12, 0.0];
    out.Ha = [0.02, 0.26, 0.035];
    out.OIII = [0.0, 0.11, 0.62];
  } else if (p === 'hoo') {
    out.Ha = [0.36, 0.02, 0.025];
    out.NII = [0.18, 0.01, 0.012]; // leaks into a typical 7 nm Hα filter
    out.OIII = [0.0, 0.36, 0.5];
  }
  return out;
}

/** Linear-sRGB chromaticity (Y = 1) of a power-law continuum F_ν ∝ ν^{−α} (synchrotron). */
export function powerLawRGB(alpha: number): [number, number, number] {
  let X = 0;
  let Y = 0;
  let Z = 0;
  for (let nm = 380; nm <= 780; nm += 5) {
    const fl = Math.pow(nm / 550, alpha - 2); // F_λ ∝ λ^{α−2}
    const [x, y, z] = cieXYZ(nm);
    X += fl * x;
    Y += fl * y;
    Z += fl * z;
  }
  const [r, g, b] = xyzToLinearSRGB(X / Y, 1, Z / Y);
  return [Math.max(0, r), Math.max(0, g), Math.max(0, b)];
}

/**
 * Fraction of a blackbody's bolometric output that the eye weights as luminance:
 * ∫B_λ ȳ dλ / ∫B_λ dλ (ȳ peak-normalised to 1). Used to put scattered starlight and line
 * emission on the same radiometric footing.
 */
export function blackbodyVisibleFraction(T: number): number {
  let num = 0;
  for (let nm = 360; nm <= 830; nm += 2) {
    const l = nm * 1e-9;
    const bl = (2 * H_PLANCK * C * C) / Math.pow(l, 5) / Math.expm1((H_PLANCK * C) / (l * K_B * T));
    num += bl * cieXYZ(nm)[1] * 2e-9;
  }
  const total = (5.670374419e-8 * Math.pow(T, 4)) / Math.PI;
  return num / total;
}

// ——— Expansion and shocks —————————————————————————————————————————————————————

/** Sedov–Taylor blast-wave radius R = 1.15 (E t²/ρ)^{1/5} in pc (E erg, n cm⁻³, t yr; μ = 1.4). */
export function sedovRadiusPc(E: number, n: number, tYears: number): number {
  const rho = 1.4 * M_H_G * n;
  const t = tYears * YEAR;
  return (1.15 * Math.pow((E * t * t) / rho, 0.2)) / PC_CM;
}

/** Sedov–Taylor shock speed dR/dt = (2/5) R/t, in km/s. */
export function sedovVelocityKmS(E: number, n: number, tYears: number): number {
  const r = sedovRadiusPc(E, n, tYears) * PC;
  return (0.4 * r) / (tYears * YEAR) / 1e3;
}

/** Radius (pc) reached after t years at constant speed v (km/s): free or homologous expansion. */
export const coastRadiusPc = (vKmS: number, tYears: number) => (vKmS * 1e3 * tYears * YEAR) / PC;

/** Kinematic age (yr) of a shell of radius r (pc) expanding at v (km/s). */
export const kinematicAgeYears = (rPc: number, vKmS: number) => (rPc * PC) / (vKmS * 1e3) / YEAR;

// ——— Pulsar —————————————————————————————————————————————————————————————————

/** Crab pulsar: period (s), main-pulse and interpulse phase/width/height (optical light curve). */
export const CRAB_PULSAR = {
  period: 0.0337,
  pulses: [
    { phase: 0, width: 0.022, height: 1 },
    { phase: 0.4, width: 0.035, height: 0.45 },
  ],
  offPulse: 0.02,
} as const;

function erf(x: number): number {
  const s = Math.sign(x);
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
}

/**
 * Mean brightness of a pulsar over a camera exposure [t, t + dt] (seconds), relative to the
 * main-pulse peak. Integrating the light curve over the exposure is what a real camera sees:
 * at 60 fps a 33.7 ms pulsar is a gentle flicker, in slow motion it is a lighthouse.
 */
export function pulsarExposure(t: number, dt: number, P: number = CRAB_PULSAR.period): number {
  const e = Math.max(dt, 1e-6);
  let sum = CRAB_PULSAR.offPulse * e;
  const c0 = Math.floor(t / P) - 1;
  const c1 = Math.floor((t + e) / P) + 1;
  // Whole periods inside the window contribute their full area analytically.
  const periods = c1 - c0;
  const area = (w: number) => w * P * Math.sqrt(Math.PI);
  if (periods > 64) {
    let a = 0;
    for (const p of CRAB_PULSAR.pulses) a += p.height * area(p.width);
    return CRAB_PULSAR.offPulse + a / P;
  }
  for (let c = c0; c <= c1; c++) {
    for (const p of CRAB_PULSAR.pulses) {
      const center = (c + p.phase) * P;
      const w = p.width * P;
      sum += p.height * w * (Math.sqrt(Math.PI) / 2) * (erf((t + e - center) / w) - erf((t - center) / w));
    }
  }
  return sum / e;
}
