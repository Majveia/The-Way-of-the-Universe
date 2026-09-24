import { G_SIM } from './units';

/**
 * Mass models of a disk galaxy (units: kpc, Myr, 10¹⁰ M☉).
 *
 *  • Dark halo and bulge: Hernquist (1990, ApJ 356, 359) spheres,
 *      ρ(r) = M a / (2π r (r + a)³),   M(<r) = M r² / (r + a)²,   Φ(r) = −GM / (r + a).
 *    A tiny "core softening" s = √(r² + ε²) replaces r in Φ for the smooth field the star particles
 *    feel, keeping the force finite at the centre (ε ≪ a).
 *  • Disk: exponential in radius × sech² in height (Spitzer's isothermal sheet),
 *      ρ(R, z) = M / (4π R_d² z₀) · e^{−R/R_d} · sech²(z / z₀).
 *    Its potential is approximated by the sum of three Miyamoto–Nagai (1975) disks with a shared
 *    thickness b, following Smith et al. 2015 (MNRAS 448, 2934). The coefficients below were
 *    fitted (least squares on F_R and F_z over 0.05 < R/R_d < 30, 0 ≤ z ≤ 10 z₀, with Σ M_k = M)
 *    against the exact disk forces from the Hankel-transform solution of Poisson's equation
 *    (Binney & Tremaine 2008, eq. 2.170, generalised to finite thickness). RMS force error ≈ 2 %.
 */

export interface HernquistParams {
  mass: number;
  scale: number;
}

export const hernquistMass = (p: HernquistParams, r: number): number => {
  const q = r / (r + p.scale);
  return p.mass * q * q;
};
export const hernquistDensity = (p: HernquistParams, r: number): number =>
  (p.mass * p.scale) / (2 * Math.PI * r * Math.pow(r + p.scale, 3));
/** Core-softened potential −GM/(√(r²+ε²) + a). */
export const hernquistPotential = (p: HernquistParams, r: number, eps = 0): number =>
  (-G_SIM * p.mass) / (Math.sqrt(r * r + eps * eps) + p.scale);
/** Magnitude of the inward radial acceleration of the core-softened Hernquist potential. */
export const hernquistAccel = (p: HernquistParams, r: number, eps = 0): number => {
  const s = Math.sqrt(r * r + eps * eps);
  return (G_SIM * p.mass * r) / (Math.max(s, 1e-12) * (s + p.scale) * (s + p.scale));
};
/** Radius enclosing mass fraction u of a Hernquist sphere. */
export const hernquistInverseMass = (a: number, u: number): number => {
  const s = Math.sqrt(u);
  return (a * s) / (1 - s);
};

/**
 * 3MN coefficients per disk thickness ratio z₀/R_d: [ratio, a1, a2, a3, b, M1, M2, M3]
 * in units of R_d and M_disk. Filled from scripts in the collision module's fit (see header).
 */
export const DISK_3MN_TABLE: ReadonlyArray<readonly number[]> = [
  // z0/Rd,  a1,      a2,      a3,      b,       M1,      M2,      M3      (units of R_d, M_d)
  [0.02, 0.32384, 1.57130, 4.33727, 0.01892, 0.03627, 1.68171, -0.71829], // rms 0.021, max 0.111
  [0.035, 0.32734, 1.58453, 4.24949, 0.03334, 0.03882, 1.70692, -0.74604], // rms 0.020, max 0.100
  [0.05, 0.32836, 1.59356, 4.18519, 0.04794, 0.04089, 1.72607, -0.76723], // rms 0.020, max 0.091
  [0.07, 0.32643, 1.59993, 4.12578, 0.06769, 0.04296, 1.74328, -0.78650], // rms 0.019, max 0.083
  [0.1, 0.31755, 1.59933, 4.07542, 0.09785, 0.04470, 1.75444, -0.79938], // rms 0.019, max 0.075
  [0.13, 0.30286, 1.58971, 4.05307, 0.12864, 0.04514, 1.75330, -0.79867], // rms 0.019, max 0.069
  [0.17, 0.27653, 1.56801, 4.04411, 0.17059, 0.04436, 1.74140, -0.78596], // rms 0.019, max 0.062
  [0.22, 0.23592, 1.53288, 4.04346, 0.22438, 0.04218, 1.71989, -0.76227], // rms 0.020, max 0.056
  [0.3, 0.15958, 1.46838, 4.03337, 0.31330, 0.03782, 1.68463, -0.72263], // rms 0.021, max 0.057
  [0.4, 0.05212, 1.38222, 3.97828, 0.42905, 0.03267, 1.64873, -0.68157], // rms 0.022, max 0.060
  [0.55, 0.00000, 1.48921, 2.99998, 0.61155, 0.05921, 2.10911, -1.16846], // rms 0.025, max 0.066
];

export interface MN3 {
  /** Scale lengths a_k (kpc). */
  a: [number, number, number];
  /** Shared thickness b (kpc). */
  b: number;
  /** Component masses (sim units; may be negative). */
  m: [number, number, number];
}

/** Thickest disk (z₀/R_d) the 3MN table covers; thicker mass is blended toward a sphere. */
export const DISK_3MN_MAX_RATIO = 0.55;

/**
 * Interpolate the 3MN fit for an exponential disk (mass M, scale R_d, sech² height z₀).
 * Linear in z₀/R_d between table rows; below the table b scales with z₀, above it is clamped.
 */
export function disk3MN(mass: number, rd: number, z0: number, out?: MN3): MN3 {
  const t = DISK_3MN_TABLE;
  const ratio = z0 / rd;
  const lo = t[0][0], hi = t[t.length - 1][0];
  const rc = Math.min(hi, Math.max(lo, ratio));
  let i = 0;
  while (i < t.length - 2 && t[i + 1][0] < rc) i++;
  const r0 = t[i], r1 = t[i + 1];
  const f = Math.min(1, Math.max(0, (rc - r0[0]) / (r1[0] - r0[0])));
  const col = (k: number) => r0[k] + f * (r1[k] - r0[k]);
  const bScale = ratio < lo ? ratio / lo : 1;
  const o = out ?? { a: [0, 0, 0], b: 0, m: [0, 0, 0] };
  o.a[0] = col(1) * rd;
  o.a[1] = col(2) * rd;
  o.a[2] = col(3) * rd;
  o.b = col(4) * rd * bScale;
  o.m[0] = col(5) * mass;
  o.m[1] = col(6) * mass;
  o.m[2] = col(7) * mass;
  return o;
}

/** Acceleration of a 3MN disk at (x, y, z) in the disk frame (z along the spin axis). */
export function mn3Accel(d: MN3, x: number, y: number, z: number, out: number[]): number[] {
  const R2 = x * x + y * y;
  const s = Math.sqrt(z * z + d.b * d.b);
  let ax = 0, ay = 0, az = 0;
  for (let k = 0; k < 3; k++) {
    const as = d.a[k] + s;
    const D2 = R2 + as * as;
    const inv3 = (G_SIM * d.m[k]) / (D2 * Math.sqrt(D2));
    ax -= x * inv3;
    ay -= y * inv3;
    az -= (z * as * inv3) / s;
  }
  out[0] = ax;
  out[1] = ay;
  out[2] = az;
  return out;
}

export function mn3Potential(d: MN3, x: number, y: number, z: number): number {
  const R2 = x * x + y * y;
  const s = Math.sqrt(z * z + d.b * d.b);
  let p = 0;
  for (let k = 0; k < 3; k++) {
    const as = d.a[k] + s;
    p -= (G_SIM * d.m[k]) / Math.sqrt(R2 + as * as);
  }
  return p;
}

/** Cylindrical mass of an exponential disk inside R. */
export const expDiskMass = (mass: number, rd: number, R: number): number => {
  const x = R / rd;
  return mass * (1 - (1 + x) * Math.exp(-x));
};
/** Inverse of the cumulative exponential-disk mass fraction (Newton iterations). */
export function expDiskInverse(u: number): number {
  let x = u < 0.5 ? Math.sqrt(2 * u) + 0.1 : 2 - Math.log(1 - u);
  for (let i = 0; i < 40; i++) {
    const e = Math.exp(-x);
    const f = 1 - (1 + x) * e - u;
    const fp = x * e;
    const dx = f / Math.max(fp, 1e-14);
    x = Math.max(1e-9, x - dx);
    if (Math.abs(dx) < 1e-12 * (1 + x)) break;
  }
  return x;
}

/** Surface density of the exponential disk. */
export const expDiskSigma = (mass: number, rd: number, R: number): number =>
  (mass / (2 * Math.PI * rd * rd)) * Math.exp(-R / rd);
