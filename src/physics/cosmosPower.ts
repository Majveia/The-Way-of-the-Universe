/**
 * Linear matter power spectrum for the cosmic-web simulation (module: cosmos).
 *
 * Transfer function: Eisenstein & Hu (1998), ApJ 496, 605, "Baryonic features in the matter
 * transfer function" — the full fit with baryon acoustic oscillations (their eqs. 2–24) and the
 * smooth "no-wiggle" fit (eqs. 26–31). Valid to a few per cent for 0.025 ≲ Ωm h² ≲ 0.25;
 * outside that range (e.g. an Einstein–de Sitter universe) it is still smooth and well behaved.
 *
 * Units: wavenumbers k in h Mpc⁻¹, lengths in h⁻¹ Mpc, P(k) in (h⁻¹ Mpc)³, masses in h⁻¹ M☉.
 *
 * Normalisation, either
 *   σ8  — rms linear overdensity in top-hat spheres of R = 8 h⁻¹ Mpc at z = 0, or
 *   A_s — the primordial curvature amplitude at k_p = 0.05 Mpc⁻¹ (Planck convention), through
 *         Δ²(k) = (4/25) A_s (k/k_p)^(ns−1) (ck/H0)⁴ T²(k) D_md(1)² / Ωm²
 *         (matter-era Poisson equation; D_md is the growth factor normalised to D = a deep in the
 *         matter era, e.g. Dodelson & Schmidt, Modern Cosmology, ch. 8).
 */

const E = Math.E;
/** Present-day critical density, h² M☉ Mpc⁻³ (= 3H0²/8πG). */
export const RHO_CRIT_H2 = 2.77536627e11;
const C_KMS = 299792.458;

export interface TransferParams {
  h: number;
  Om0: number;
  Ob0: number;
  Tcmb0?: number;
}

/** Eisenstein & Hu (1998) transfer functions; k in Mpc⁻¹ (NOT h/Mpc) for the raw methods. */
export class EisensteinHu {
  readonly h: number;
  readonly om: number;
  readonly ob: number;
  readonly fb: number;
  readonly fc: number;
  readonly theta: number;
  readonly zeq: number;
  readonly keq: number;
  readonly zd: number;
  /** Sound horizon at the drag epoch, Mpc (EH98 eq. 6). */
  readonly s: number;
  readonly ksilk: number;
  private readonly alphaC: number;
  private readonly betaC: number;
  private readonly alphaB: number;
  private readonly betaB: number;
  private readonly betaNode: number;
  private readonly sApprox: number;
  private readonly alphaGamma: number;
  readonly hasBaryons: boolean;

  constructor(p: TransferParams) {
    const h = p.h;
    this.h = h;
    const Ob0 = Math.max(0, Math.min(p.Ob0, p.Om0 * 0.9));
    this.om = p.Om0 * h * h;
    this.ob = Ob0 * h * h;
    this.fb = Ob0 / p.Om0;
    this.fc = 1 - this.fb;
    this.hasBaryons = this.fb > 1e-4;
    const theta = (p.Tcmb0 ?? 2.7255) / 2.7;
    this.theta = theta;
    const om = this.om, ob = Math.max(this.ob, 1e-8);
    const t4 = theta ** -4;
    this.zeq = 2.5e4 * om * t4;
    this.keq = 7.46e-2 * om * theta ** -2;
    const b1 = 0.313 * om ** -0.419 * (1 + 0.607 * om ** 0.674);
    const b2 = 0.238 * om ** 0.223;
    this.zd = ((1291 * om ** 0.251) / (1 + 0.659 * om ** 0.828)) * (1 + b1 * ob ** b2);
    const R = (z: number) => 31.5 * ob * t4 * (1000 / z);
    const Rd = R(this.zd);
    const Req = R(this.zeq);
    this.s =
      ((2 / (3 * this.keq)) * Math.sqrt(6 / Req) * Math.log((Math.sqrt(1 + Rd) + Math.sqrt(Rd + Req)) / (1 + Math.sqrt(Req))));
    this.ksilk = 1.6 * ob ** 0.52 * om ** 0.73 * (1 + (10.4 * om) ** -0.95);
    const fb = this.fb, fc = this.fc;
    const a1 = (46.9 * om) ** 0.67 * (1 + (32.1 * om) ** -0.532);
    const a2 = (12.0 * om) ** 0.424 * (1 + (45.0 * om) ** -0.582);
    this.alphaC = a1 ** -fb * a2 ** -(fb ** 3);
    const bb1 = 0.944 / (1 + (458 * om) ** -0.708);
    const bb2 = (0.395 * om) ** -0.0266;
    this.betaC = 1 / (1 + bb1 * (fc ** bb2 - 1));
    const y = (1 + this.zeq) / (1 + this.zd);
    const sy = Math.sqrt(1 + y);
    const G = y * (-6 * sy + (2 + 3 * y) * Math.log((sy + 1) / (sy - 1)));
    this.alphaB = 2.07 * this.keq * this.s * (1 + Rd) ** -0.75 * G;
    this.betaNode = 8.41 * om ** 0.435;
    this.betaB = 0.5 + fb + (3 - 2 * fb) * Math.sqrt((17.2 * om) ** 2 + 1);
    // No-wiggle fit (eqs. 26, 31).
    this.sApprox = (44.5 * Math.log(9.83 / om)) / Math.sqrt(1 + 10 * ob ** 0.75);
    this.alphaGamma = 1 - 0.328 * Math.log(431 * om) * fb + 0.38 * Math.log(22.3 * om) * fb * fb;
  }

  private t0tilde(k: number, ac: number, bc: number): number {
    const q = k / (13.41 * this.keq);
    const C = 14.2 / ac + 386 / (1 + 69.9 * q ** 1.08);
    const L = Math.log(E + 1.8 * bc * q);
    return L / (L + C * q * q);
  }

  /** Full transfer function with baryon acoustic oscillations (k in Mpc⁻¹). */
  transfer(k: number): number {
    if (k <= 0) return 1;
    if (!this.hasBaryons) return this.transferNoWiggle(k);
    const s = this.s;
    const ks = k * s;
    const f = 1 / (1 + (ks / 5.4) ** 4);
    const Tc = f * this.t0tilde(k, 1, this.betaC) + (1 - f) * this.t0tilde(k, this.alphaC, this.betaC);
    const stilde = s / Math.cbrt(1 + (this.betaNode / ks) ** 3);
    const x = k * stilde;
    const j0 = x < 1e-6 ? 1 : Math.sin(x) / x;
    const Tb =
      (this.t0tilde(k, 1, 1) / (1 + (ks / 5.2) ** 2) +
        (this.alphaB / (1 + (this.betaB / ks) ** 3)) * Math.exp(-((k / this.ksilk) ** 1.4))) *
      j0;
    return this.fb * Tb + this.fc * Tc;
  }

  /** Smooth "no-wiggle" transfer function (EH98 §4.2), k in Mpc⁻¹. */
  transferNoWiggle(k: number): number {
    if (k <= 0) return 1;
    const Om0h = this.om / this.h; // Ω0 h
    const ag = this.alphaGamma;
    const gammaEff = Om0h * (ag + (1 - ag) / (1 + (0.43 * k * this.sApprox) ** 4));
    const q = ((k / this.h) * this.theta * this.theta) / gammaEff;
    const L0 = Math.log(2 * E + 1.8 * q);
    const C0 = 14.2 + 731 / (1 + 62.5 * q);
    return L0 / (L0 + C0 * q * q);
  }
}

/** Spherical top-hat window in Fourier space, W(x) = 3 (sin x − x cos x) / x³. */
export function topHatW(x: number): number {
  if (x < 1e-3) return 1 - (x * x) / 10;
  return (3 * (Math.sin(x) - x * Math.cos(x))) / (x * x * x);
}

/** Gaussian window W(x) = exp(−x²/2). */
export const gaussW = (x: number) => Math.exp(-0.5 * x * x);

export interface LinearPowerParams extends TransferParams {
  ns: number;
  /** Include baryon acoustic oscillations (default true). */
  wiggles?: boolean;
  /** Normalise to σ8 at z = 0 … */
  sigma8?: number;
  /** … or to the primordial amplitude A_s (k_p = 0.05 Mpc⁻¹); needs growthMD. */
  As?: number;
  /** D_md(a = 1): linear growth today normalised to D = a in the matter era. */
  growthMD?: number;
}

/** Linear matter power spectrum at z = 0 in h-units: P(k) = A k^ns T²(k). */
export class LinearPower {
  readonly eh: EisensteinHu;
  readonly p: LinearPowerParams;
  /** Amplitude A in P(k) = A k^ns T²(k), (h⁻¹Mpc)^(3+ns). */
  readonly amplitude: number;

  constructor(p: LinearPowerParams) {
    this.p = p;
    this.eh = new EisensteinHu(p);
    if (p.As !== undefined) {
      // P(k) = (2π²/k³) Δ²(k) with k in h/Mpc, c/H0 = 2997.9 h⁻¹Mpc and k_p = 0.05/h h/Mpc:
      // the k-dependence collects into k^ns T²(k), leaving the constant amplitude below.
      const gmd = p.growthMD ?? 1;
      const c100 = C_KMS / 100;
      const kp = 0.05 / p.h;
      this.amplitude = (2 * Math.PI * Math.PI * (4 / 25) * p.As * kp ** (1 - p.ns) * c100 ** 4 * gmd * gmd) / (p.Om0 * p.Om0);
    } else {
      this.amplitude = 1;
      this.amplitude = ((p.sigma8 ?? 0.8102) / this.sigmaR(8)) ** 2;
    }
  }

  /** Transfer function for k in h Mpc⁻¹. */
  transfer(k: number): number {
    const kM = k * this.p.h;
    return this.p.wiggles === false ? this.eh.transferNoWiggle(kM) : this.eh.transfer(kM);
  }

  /** Linear P(k) at z = 0, (h⁻¹Mpc)³, k in h Mpc⁻¹. */
  P(k: number): number {
    if (k <= 0) return 0;
    const t = this.transfer(k);
    return this.amplitude * k ** this.p.ns * t * t;
  }

  /** Dimensionless power Δ²(k) = k³P/2π². */
  Delta2(k: number): number {
    return (k * k * k * this.P(k)) / (2 * Math.PI * Math.PI);
  }

  /** σ(R) with a top-hat (default) or Gaussian window, R in h⁻¹ Mpc, at z = 0. */
  sigmaR(R: number, window: 'tophat' | 'gauss' = 'tophat'): number {
    // σ² = ∫ dlnk Δ²(k) W²(kR), Simpson in ln k.
    const W = window === 'tophat' ? topHatW : gaussW;
    const lo = Math.log(1e-5), hi = Math.log(Math.max(1e3, 200 / R));
    const n = 4000;
    const dl = (hi - lo) / n;
    let s = 0;
    for (let i = 0; i <= n; i++) {
      const k = Math.exp(lo + i * dl);
      const w = W(k * R);
      const f = this.Delta2(k) * w * w;
      s += f * (i === 0 || i === n ? 1 : i % 2 ? 4 : 2);
    }
    return Math.sqrt((s * dl) / 3);
  }

  sigma8(): number {
    return this.sigmaR(8);
  }

  /** Lagrangian radius (h⁻¹ Mpc) of mass M (h⁻¹ M☉). */
  lagrangianRadius(M: number): number {
    return Math.cbrt((3 * M) / (4 * Math.PI * this.p.Om0 * RHO_CRIT_H2));
  }

  /** σ(M) for a top-hat of mass M (h⁻¹ M☉) at z = 0. */
  sigmaM(M: number): number {
    return this.sigmaR(this.lagrangianRadius(M));
  }
}

/** Critical linear overdensity for spherical collapse in Einstein–de Sitter, δc = 3(12π)^(2/3)/20. */
export const DELTA_C = (3 * (12 * Math.PI) ** (2 / 3)) / 20;

/**
 * Conditional collapsed fraction (extended Press–Schechter; Bond et al. 1991, Lacey & Cole 1993):
 * fraction of the mass of a region with linear overdensity δR (today's normalisation, variance
 * σR² on its scale) that sits in halos above a mass with variance σmin², when the linear growth
 * factor is D:  f = erfc[(δc/D − δR) / √(2(σmin² − σR²))].
 * This is the source term used by semi-numerical reionization codes (e.g. 21cmFAST).
 */
export function collapsedFraction(deltaR: number, sigmaR2: number, sigmaMin2: number, D: number): number {
  const v = Math.max(1e-6, sigmaMin2 - sigmaR2);
  const x = (DELTA_C / Math.max(D, 1e-9) - deltaR) / Math.sqrt(2 * v);
  return Math.min(1, Math.max(0, erfc(x)));
}

/** Complementary error function (Numerical Recipes erfcc, |error| < 1.2e-7). */
export function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r =
    t *
    Math.exp(
      -z * z - 1.26551223 +
        t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? r : 2 - r;
}
