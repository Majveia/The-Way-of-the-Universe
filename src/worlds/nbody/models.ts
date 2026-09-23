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
  // ratio,   a1,       a2,       a3,       b,        M1,       M2,       M3
  [0.1, 0.30743, 4.85723, 1.55113, 0.09775, 0.04093, -0.74746, 1.64007],
];

export interface MN3 {
  /** Scale lengths a_k (kpc). */
  a: [number, number, number];
  /** Shared thickness b (kpc). */
  b: number;
  /** Component masses (sim units; may be negative). */
  m: [number, number, number];
}

/** Interpolate the 3MN fit for an exponential disk (mass M, scale R_d, sech² height z₀). */
export function disk3MN(mass: number, rd: number, z0: number, out?: MN3): MN3 {
  const t = DISK_3MN_TABLE;
  const ratio = z0 / rd;
  let row: number[];
  if (ratio <= t[0][0] || t.length === 1) row = t[0].slice();
  else if (ratio >= t[t.length - 1][0]) row = t[t.length - 1].slice();
  else {
    let i = 0;
    while (i < t.length - 2 && t[i + 1][0] < ratio) i++;
    const r0 = t[i], r1 = t[i + 1];
    // Interpolate in log(ratio); scale lengths in log space, masses linearly.
    const f = Math.log(ratio / r0[0]) / Math.log(r1[0] / r0[0]);
    row = r0.map((v, k) => {
      if (k >= 1 && k <= 4) return Math.exp(Math.log(v) + f * (Math.log(r1[k]) - Math.log(v)));
      return v + f * (r1[k] - v);
    });
  }
  // When extrapolating in thickness, b tracks z₀ proportionally.
  const bScale = ratio > t[t.length - 1][0] ? ratio / t[t.length - 1][0] : ratio < t[0][0] ? ratio / t[0][0] : 1;
  const o = out ?? { a: [0, 0, 0], b: 0, m: [0, 0, 0] };
  o.a[0] = row[1] * rd;
  o.a[1] = row[2] * rd;
  o.a[2] = row[3] * rd;
  o.b = row[4] * rd * bScale;
  o.m[0] = row[5] * mass;
  o.m[1] = row[6] * mass;
  o.m[2] = row[7] * mass;
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
