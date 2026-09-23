import { Rng } from '../../physics/random';
import { EddingtonDF, hernquistDensityDerivs } from './eddington';
import {
  DISK_3MN_MAX_RATIO,
  disk3MN,
  expDiskInverse,
  expDiskSigma,
  hernquistInverseMass,
  hernquistMass,
  type MN3,
} from './models';
import { G_SIM, kmsToSim } from './units';

/**
 * A disk galaxy: Hernquist dark halo + Hernquist bulge + exponential stellar disk + gas disk.
 * Units: kpc, Myr, 10¹⁰ M☉. Local frame: centre at the origin, disk spin along +z.
 *
 * Two particle families are realised (see NBodySystem for how they are evolved):
 *  • the SKELETON — halo, bulge and disk mass carriers that attract each other by direct
 *    summation (a true self-gravitating N-body system, softened);
 *  • the TRACERS (stars and gas) — many light particles that move in a smooth version of the
 *    skeleton's field, so their thin cold disks are not heated by the skeleton's graininess
 *    (two-body heating by 10⁸ M☉ halo particles would thicken a disk within ~1 Gyr; Lacey &
 *    Ostriker 1985).
 */
export interface GalaxySpec {
  name: string;
  /** Hernquist halo: total mass, scale radius a, sampling truncation radius. */
  halo: { mass: number; scale: number; rmax: number };
  bulge: { mass: number; scale: number };
  /** Stellar + gas disk mass; exponential scale length R_d; sech² scale height z₀. */
  disk: { mass: number; scale: number; height: number; Q: number };
  /** Gas (part of disk.mass): fraction, scale length in units of R_d, height in units of z₀. */
  gas: { fraction: number; scaleFactor: number; heightFactor: number; sigmaKms: number };
  /** Stellar population look. */
  pop: {
    /** Mean age of the bulge population (Gyr). */
    bulgeAgeGyr: number;
    /** e-folding time of the disk star-formation history (Gyr; large = constant SFR). */
    sfhTauGyr: number;
    /** Fraction of gas particles caught in a recent burst at t = 0 (HII regions). */
    activeGas: number;
  };
}

/** Smooth-field parameters of one galaxy, i.e. what the tracer particles feel. */
export interface SmoothModel {
  halo: { mass: number; scale: number; eps: number };
  bulge: { mass: number; scale: number; eps: number };
  disk: { mass: number; rd: number; z0: number };
  /** Derived 3MN disk (recomputed from disk). */
  mn: MN3;
  /** 0 → pure disk; 1 → the disk mass is fully spheroidal (after violent relaxation). */
  sphere: number;
}

export const COMP_HALO = 0;
export const COMP_BULGE = 1;
export const COMP_DISK = 2;

export const KIND_BULGE = 0;
export const KIND_DISK = 1;
export const KIND_GAS = 2;

/** Core softening of the smooth field (kpc). */
export const SMOOTH_EPS = 0.05;

export function smoothModelFor(spec: GalaxySpec): SmoothModel {
  const m: SmoothModel = {
    halo: { mass: spec.halo.mass, scale: spec.halo.scale, eps: SMOOTH_EPS },
    bulge: { mass: spec.bulge.mass, scale: spec.bulge.scale, eps: SMOOTH_EPS },
    disk: { mass: spec.disk.mass, rd: spec.disk.scale, z0: spec.disk.height },
    mn: { a: [0, 0, 0], b: 0, m: [0, 0, 0] },
    sphere: 0,
  };
  updateSmoothDisk(m);
  return m;
}

/** Recompute the 3MN coefficients (and the spheroid share) from disk mass, R_d and z₀. */
export function updateSmoothDisk(m: SmoothModel): void {
  const ratio = m.disk.z0 / m.disk.rd;
  // Beyond the thickest tabulated disk, hand mass over smoothly to a spheroid.
  m.sphere = Math.min(1, Math.max(0, (ratio - DISK_3MN_MAX_RATIO) / (1.2 - DISK_3MN_MAX_RATIO)));
  disk3MN(m.disk.mass * (1 - m.sphere), m.disk.rd, Math.min(m.disk.z0, DISK_3MN_MAX_RATIO * m.disk.rd), m.mn);
}

/** Hernquist scale of the spheroid that the disk mass turns into (same half-mass radius). */
export const sphereScale = (rd: number): number => (1.678 * rd) / (1 + Math.SQRT2);

/**
 * Acceleration of the smooth model at offset d from the galaxy centre, disk axis n (unit),
 * written into out[0..2] (added to existing values when `add` is true).
 */
export function smoothAccel(
  m: SmoothModel,
  dx: number,
  dy: number,
  dz: number,
  nx: number,
  ny: number,
  nz: number,
  out: number[],
  add = false,
): number[] {
  let ax = 0, ay = 0, az = 0;
  const r2 = dx * dx + dy * dy + dz * dz;
  // Halo and bulge: core-softened Hernquist.
  for (const h of [m.halo, m.bulge]) {
    const s = Math.sqrt(r2 + h.eps * h.eps);
    const k = (G_SIM * h.mass) / (s * (s + h.scale) * (s + h.scale));
    ax -= k * dx;
    ay -= k * dy;
    az -= k * dz;
  }
  // Disk: 3MN around axis n.  a = −Σ G m_k (d + (a_k z / s) n) / D_k³
  const z = dx * nx + dy * ny + dz * nz;
  const R2 = r2 - z * z;
  const s = Math.sqrt(z * z + m.mn.b * m.mn.b);
  for (let k = 0; k < 3; k++) {
    const as = m.mn.a[k] + s;
    const D2 = R2 + as * as;
    const f = (G_SIM * m.mn.m[k]) / (D2 * Math.sqrt(D2));
    const zz = (m.mn.a[k] * z) / s;
    ax -= f * (dx + zz * nx);
    ay -= f * (dy + zz * ny);
    az -= f * (dz + zz * nz);
  }
  if (m.sphere > 0) {
    const ms = m.disk.mass * m.sphere, as = sphereScale(m.disk.rd);
    const ss = Math.sqrt(r2 + SMOOTH_EPS * SMOOTH_EPS);
    const k = (G_SIM * ms) / (ss * (ss + as) * (ss + as));
    ax -= k * dx;
    ay -= k * dy;
    az -= k * dz;
  }
  if (add) {
    out[0] += ax;
    out[1] += ay;
    out[2] += az;
  } else {
    out[0] = ax;
    out[1] = ay;
    out[2] = az;
  }
  return out;
}

/** Potential of the smooth model at offset d (disk axis n). */
export function smoothPotential(m: SmoothModel, dx: number, dy: number, dz: number, nx: number, ny: number, nz: number): number {
  const r2 = dx * dx + dy * dy + dz * dz;
  let p = 0;
  for (const h of [m.halo, m.bulge]) p -= (G_SIM * h.mass) / (Math.sqrt(r2 + h.eps * h.eps) + h.scale);
  const z = dx * nx + dy * ny + dz * nz;
  const R2 = r2 - z * z;
  const s = Math.sqrt(z * z + m.mn.b * m.mn.b);
  for (let k = 0; k < 3; k++) {
    const as = m.mn.a[k] + s;
    p -= (G_SIM * m.mn.m[k]) / Math.sqrt(R2 + as * as);
  }
  if (m.sphere > 0) p -= (G_SIM * m.disk.mass * m.sphere) / (Math.sqrt(r2 + SMOOTH_EPS * SMOOTH_EPS) + sphereScale(m.disk.rd));
  return p;
}

/** Relative potential Ψ = −Φ of the spherically averaged smooth model (for Eddington DFs). */
function sphericalPsi(m: SmoothModel, epsHalo: number, epsBulge: number) {
  const { halo, bulge, disk } = m;
  return (r: number) => {
    const sh = Math.sqrt(r * r + epsHalo * epsHalo);
    const sb = Math.sqrt(r * r + epsBulge * epsBulge);
    // Monopole of an exponential disk: Φ = −G M (1 − e^{−r/R_d}) / r.
    const pd = r < 1e-6 * disk.rd ? disk.mass / disk.rd : (disk.mass * -Math.expm1(-r / disk.rd)) / r;
    return G_SIM * (halo.mass / (sh + halo.scale) + bulge.mass / (sb + bulge.scale) + pd);
  };
}

const tmp3 = [0, 0, 0];

/** Circular speed of the smooth model in the disk plane. */
export function smoothVc(m: SmoothModel, R: number): number {
  smoothAccel(m, R, 0, 0, 0, 0, 1, tmp3);
  return Math.sqrt(Math.max(0, -tmp3[0] * R));
}

/** Rotation-curve table with Ω and κ (epicyclic frequency) for disk kinematics. */
export class RotationCurve {
  readonly R: Float64Array;
  readonly vc: Float64Array;
  readonly kappa2: Float64Array;
  constructor(vcAt: (R: number) => number, rMax: number, n = 256) {
    this.R = new Float64Array(n);
    this.vc = new Float64Array(n);
    this.kappa2 = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const R = (rMax * (i + 0.5)) / n;
      this.R[i] = R;
      this.vc[i] = vcAt(R);
    }
    // κ² = R dΩ²/dR + 4Ω² = (2 v/R)(v/R + dv/dR)
    for (let i = 0; i < n; i++) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
      const dv = (this.vc[i1] - this.vc[i0]) / (this.R[i1] - this.R[i0]);
      const v = this.vc[i], R = this.R[i];
      this.kappa2[i] = Math.max(1e-12, ((2 * v) / R) * (v / R + dv));
    }
  }
  private idx(R: number): [number, number] {
    const n = this.R.length;
    const dr = this.R[1] - this.R[0];
    const u = Math.min(n - 1.0001, Math.max(0, R / dr - 0.5));
    const i = Math.floor(u);
    return [i, u - i];
  }
  vcAt(R: number): number {
    const [i, t] = this.idx(R);
    return this.vc[i] + t * (this.vc[i + 1] - this.vc[i]);
  }
  kappa2At(R: number): number {
    const [i, t] = this.idx(R);
    return this.kappa2[i] + t * (this.kappa2[i + 1] - this.kappa2[i]);
  }
}

/**
 * Vertical Jeans equation for a sech²(z/z₀) tracer in the smooth potential:
 *   σ_z²(R, z) = (1/ρ(z)) ∫_z^∞ ρ(z') |F_z(R, z')| dz'.
 * Tabulated on (R, z) for fast lookup.
 */
export class VerticalJeans {
  private readonly nR = 48;
  private readonly nZ = 32;
  private readonly table: Float64Array;
  constructor(
    m: SmoothModel,
    private z0: number,
    private rMax: number,
  ) {
    const { nR, nZ } = this;
    this.table = new Float64Array(nR * nZ);
    const zTop = 10 * z0;
    const NI = 400;
    const acc = [0, 0, 0];
    for (let i = 0; i < nR; i++) {
      const R = (rMax * i) / (nR - 1) + 1e-3;
      // cumulative ∫_z^zTop ρ|F_z| dz on a fine grid, from the top down
      const zs = new Float64Array(NI + 1), cum = new Float64Array(NI + 1);
      let s = 0;
      let prev = 0;
      for (let k = NI; k >= 0; k--) {
        const z = (zTop * k) / NI;
        zs[k] = z;
        smoothAccel(m, R, 0, z, 0, 0, 1, acc);
        const rho = 1 / Math.cosh(z / z0) ** 2;
        const f = rho * Math.abs(acc[2]);
        if (k < NI) s += 0.5 * (f + prev) * (zTop / NI);
        prev = f;
        cum[k] = s;
      }
      for (let j = 0; j < nZ; j++) {
        const z = (6 * z0 * j) / (nZ - 1);
        const u = (z / zTop) * NI;
        const k = Math.min(NI - 1, Math.floor(u));
        const c = cum[k] + (u - k) * (cum[k + 1] - cum[k]);
        const rho = 1 / Math.cosh(z / z0) ** 2;
        this.table[i * nZ + j] = c / rho;
      }
    }
  }
  sigma2(R: number, z: number): number {
    const { nR, nZ } = this;
    const u = Math.min(nR - 1.0001, Math.max(0, (R / this.rMax) * (nR - 1)));
    const v = Math.min(nZ - 1.0001, Math.max(0, (Math.abs(z) / (6 * this.z0)) * (nZ - 1)));
    const i = Math.floor(u), j = Math.floor(v);
    const a = u - i, b = v - j;
    const T = this.table;
    const t00 = T[i * nZ + j], t01 = T[i * nZ + j + 1], t10 = T[(i + 1) * nZ + j], t11 = T[(i + 1) * nZ + j + 1];
    return (1 - a) * ((1 - b) * t00 + b * t01) + a * ((1 - b) * t10 + b * t11);
  }
}

export interface SkeletonCounts {
  halo: number;
  bulge: number;
  disk: number;
}
export interface TracerCounts {
  bulge: number;
  disk: number;
  gas: number;
}
export interface Softening {
  halo: number;
  bulge: number;
  disk: number;
}

/** Particles of one galaxy in its local frame (centre at rest at the origin, spin +z). */
export interface GalaxyRealization {
  spec: GalaxySpec;
  model: SmoothModel;
  skeleton: {
    pos: Float64Array;
    vel: Float64Array;
    mass: Float64Array;
    comp: Uint8Array;
    counts: SkeletonCounts;
  };
  tracers: {
    pos: Float64Array;
    vel: Float64Array;
    kind: Uint8Array;
    /** Stellar age (Myr) at t = 0 for stars; for gas, time since its last burst (Myr, large = none). */
    age: Float32Array;
    /** Rendering weight: stellar mass represented (10¹⁰ M☉). */
    weight: Float32Array;
    counts: TracerCounts;
  };
  /** Total skeleton mass (10¹⁰ M☉). */
  mass: number;
}

/** Writable numeric array (number[] or typed array). */
type Vec = { [index: number]: number };

function isotropic(rng: Rng, v: number, out: Vec, o: number): void {
  const z = rng.next() * 2 - 1;
  const t = rng.next() * 2 * Math.PI;
  const s = Math.sqrt(1 - z * z);
  out[o] = v * s * Math.cos(t);
  out[o + 1] = v * s * Math.sin(t);
  out[o + 2] = v * z;
}

/** Sample a sech²(z/z₀) height. */
const sech2Height = (rng: Rng, z0: number): number => {
  const u = Math.min(0.999999, Math.max(1e-6, rng.next()));
  return z0 * Math.atanh(2 * u - 1);
};

/**
 * Epicyclic disk kinematics (Hernquist 1993, ApJS 86, 389, §2.2.3):
 *   σ_R² ∝ e^{−R/R_σ}, normalised to Toomre Q at R_ref;  σ_φ² = σ_R² κ²/(4Ω²);
 *   v̄_φ² = v_c² + σ_R² [1 − κ²/(4Ω²) + d ln(ρσ_R²)/d ln R]  (asymmetric drift).
 */
export interface DiskKinematicsInput {
  curve: RotationCurve;
  jeans: VerticalJeans;
  /** Radial dispersion at R (kpc/Myr). */
  sigmaR: (R: number) => number;
  /** d ln(ρ σ_R²) / d ln R at R. */
  dlnRhoSigma2: (R: number) => number;
}

function diskVelocity(rng: Rng, inp: DiskKinematicsInput, x: number, y: number, z: number, out: Vec, o: number): void {
  const R = Math.max(1e-4, Math.hypot(x, y));
  const vc = inp.curve.vcAt(R);
  const k2 = inp.curve.kappa2At(R);
  const om2 = (vc * vc) / (R * R);
  const sR = Math.min(inp.sigmaR(R), 0.8 * vc + kmsToSim(10));
  const ratio = Math.min(1, k2 / (4 * om2));
  const sPhi = sR * Math.sqrt(ratio);
  const sZ = Math.sqrt(Math.max(0, inp.jeans.sigma2(R, z)));
  const vphi2 = vc * vc + sR * sR * (1 - ratio + inp.dlnRhoSigma2(R));
  const vphi = Math.sqrt(Math.max(0, vphi2)) + sPhi * rng.normal();
  const vR = sR * rng.normal();
  const vz = sZ * rng.normal();
  const c = x / R, s = y / R;
  out[o] = vR * c - vphi * s;
  out[o + 1] = vR * s + vphi * c;
  out[o + 2] = vz;
}

/** Toomre-Q normalisation: σ_R(R_ref) = Q · 3.36 G Σ(R_ref) / κ(R_ref). */
function sigmaRFromQ(spec: GalaxySpec, curve: RotationCurve, Q: number, Rsig: number) {
  const Rd = spec.disk.scale;
  const Rref = 2.4 * Rd;
  const sig = expDiskSigma(spec.disk.mass, Rd, Rref);
  const s0 = (Q * 3.36 * G_SIM * sig) / Math.sqrt(curve.kappa2At(Rref));
  return (R: number) => s0 * Math.exp(-(R - Rref) / (2 * Rsig));
}

/**
 * Realise one galaxy. Deterministic for a given rng seed.
 * `eps` is the skeleton's Plummer softening per component (used for its DF and v_c).
 */
export function realizeGalaxy(spec: GalaxySpec, sk: SkeletonCounts, tr: TracerCounts, eps: Softening, seed: number): GalaxyRealization {
  const rng = new Rng(seed);
  const model = smoothModelFor(spec);
  const Rd = spec.disk.scale, z0 = spec.disk.height;
  const diskRmax = 7 * Rd;

  // ——— Skeleton positions ———
  const nS = sk.halo + sk.bulge + sk.disk;
  const sPos = new Float64Array(nS * 3), sVel = new Float64Array(nS * 3), sMass = new Float64Array(nS);
  const sComp = new Uint8Array(nS);
  const hFrac = hernquistMass({ mass: 1, scale: spec.halo.scale }, spec.halo.rmax);
  const bRmax = 40 * spec.bulge.scale;
  const bFrac = hernquistMass({ mass: 1, scale: spec.bulge.scale }, bRmax);
  const mHalo = (spec.halo.mass * hFrac) / Math.max(1, sk.halo);
  const mBulge = (spec.bulge.mass * bFrac) / Math.max(1, sk.bulge);
  const dFrac = 1 - (1 + diskRmax / Rd) * Math.exp(-diskRmax / Rd);
  const mDisk = (spec.disk.mass * dFrac) / Math.max(1, sk.disk);
  let p = 0;
  const tmp = [0, 0, 0];
  const placeSphere = (n: number, a: number, frac: number, m: number, comp: number) => {
    for (let i = 0; i < n; i++, p++) {
      // Stratified in mass fraction for a quieter start.
      const u = ((i + rng.next()) / n) * frac;
      const r = hernquistInverseMass(a, u);
      isotropic(rng, r, tmp, 0);
      sPos[p * 3] = tmp[0];
      sPos[p * 3 + 1] = tmp[1];
      sPos[p * 3 + 2] = tmp[2];
      sMass[p] = m;
      sComp[p] = comp;
    }
  };
  placeSphere(sk.halo, spec.halo.scale, hFrac, mHalo, COMP_HALO);
  placeSphere(sk.bulge, spec.bulge.scale, bFrac, mBulge, COMP_BULGE);
  for (let i = 0; i < sk.disk; i++, p++) {
    const u = ((i + rng.next()) / sk.disk) * dFrac;
    const R = expDiskInverse(u) * Rd;
    const ph = rng.next() * 2 * Math.PI;
    sPos[p * 3] = R * Math.cos(ph);
    sPos[p * 3 + 1] = R * Math.sin(ph);
    sPos[p * 3 + 2] = sech2Height(rng, z0);
    sMass[p] = mDisk;
    sComp[p] = COMP_DISK;
  }

  // ——— Skeleton velocities: halo & bulge from Eddington DFs in the total (softened) potential ———
  const psiH = sphericalPsi(model, eps.halo, eps.bulge);
  const dfHalo = new EddingtonDF({
    ...hernquistDensityDerivs(spec.halo.mass, spec.halo.scale),
    psi: psiH,
    rMin: 1e-3,
    rMax: 1e3 * spec.halo.rmax,
  });
  const dfBulge = new EddingtonDF({
    ...hernquistDensityDerivs(spec.bulge.mass, spec.bulge.scale),
    psi: psiH,
    rMin: 1e-4,
    rMax: 1e3 * spec.halo.rmax,
  });
  for (let i = 0; i < sk.halo + sk.bulge; i++) {
    const x = sPos[i * 3], y = sPos[i * 3 + 1], z = sPos[i * 3 + 2];
    const r = Math.hypot(x, y, z);
    const v = (sComp[i] === COMP_HALO ? dfHalo : dfBulge).sampleSpeed(rng, r);
    isotropic(rng, v, sVel, i * 3);
  }

  // Skeleton disk: v_c from the actual softened field of the realised skeleton (azimuthal average).
  const nC = 64;
  const rc = new Float64Array(nC), vcS = new Float64Array(nC);
  const epsD2 = eps.disk * eps.disk;
  const e2 = (c: number) => (c === COMP_HALO ? eps.halo : c === COMP_BULGE ? eps.bulge : eps.disk) ** 2;
  for (let i = 0; i < nC; i++) {
    const R = (diskRmax * (i + 0.5)) / nC;
    rc[i] = R;
    let fr = 0;
    const NA = 12;
    for (let a = 0; a < NA; a++) {
      const ph = ((a + 0.5) / NA) * 2 * Math.PI;
      const px = R * Math.cos(ph), py = R * Math.sin(ph);
      let ax = 0, ay = 0;
      for (let j = 0; j < nS; j++) {
        const dx = sPos[j * 3] - px, dy = sPos[j * 3 + 1] - py, dz = sPos[j * 3 + 2];
        const d2 = dx * dx + dy * dy + dz * dz + 0.5 * (epsD2 + e2(sComp[j]));
        const inv = sMass[j] / (d2 * Math.sqrt(d2));
        ax += dx * inv;
        ay += dy * inv;
      }
      fr += (ax * Math.cos(ph) + ay * Math.sin(ph)) * G_SIM;
    }
    // fr is the outward radial acceleration (negative for attraction): v_c² = −R·a_R.
    vcS[i] = Math.sqrt(Math.max(0, (-R * fr) / NA));
  }
  // light smoothing of the measured curve
  const vcSm = new Float64Array(nC);
  for (let i = 0; i < nC; i++) {
    let s = 0, w = 0;
    for (let k = -2; k <= 2; k++) {
      const j = Math.min(nC - 1, Math.max(0, i + k));
      const wk = 3 - Math.abs(k);
      s += vcS[j] * wk;
      w += wk;
    }
    vcSm[i] = s / w;
  }
  const skelCurve = new RotationCurve((R) => {
    const u = Math.min(nC - 1.0001, Math.max(0, R / (diskRmax / nC) - 0.5));
    const i = Math.floor(u);
    return vcSm[i] + (u - i) * (vcSm[i + 1] - vcSm[i]);
  }, diskRmax, 200);
  const skelJeans = new VerticalJeans(model, z0, diskRmax);
  const skelDisk: DiskKinematicsInput = {
    curve: skelCurve,
    jeans: skelJeans,
    sigmaR: sigmaRFromQ(spec, skelCurve, spec.disk.Q, Rd),
    dlnRhoSigma2: (R) => -2 * (R / Rd),
  };
  for (let i = sk.halo + sk.bulge; i < nS; i++) {
    diskVelocity(rng, skelDisk, sPos[i * 3], sPos[i * 3 + 1], sPos[i * 3 + 2], sVel, i * 3);
  }
  // Remove net momentum / centre-of-mass offset (sampling noise).
  let M = 0, cx = 0, cy = 0, cz = 0, px = 0, py = 0, pz = 0;
  for (let i = 0; i < nS; i++) {
    const m = sMass[i];
    M += m;
    cx += m * sPos[i * 3];
    cy += m * sPos[i * 3 + 1];
    cz += m * sPos[i * 3 + 2];
    px += m * sVel[i * 3];
    py += m * sVel[i * 3 + 1];
    pz += m * sVel[i * 3 + 2];
  }
  for (let i = 0; i < nS; i++) {
    sPos[i * 3] -= cx / M;
    sPos[i * 3 + 1] -= cy / M;
    sPos[i * 3 + 2] -= cz / M;
    sVel[i * 3] -= px / M;
    sVel[i * 3 + 1] -= py / M;
    sVel[i * 3 + 2] -= pz / M;
  }

  // ——— Tracers (stars + gas) in the smooth model ———
  const nT = tr.bulge + tr.disk + tr.gas;
  const tPos = new Float64Array(nT * 3), tVel = new Float64Array(nT * 3);
  const kind = new Uint8Array(nT), age = new Float32Array(nT), weight = new Float32Array(nT);
  const psiT = sphericalPsi(model, SMOOTH_EPS, SMOOTH_EPS);
  const dfBulgeT = new EddingtonDF({
    ...hernquistDensityDerivs(spec.bulge.mass, spec.bulge.scale),
    psi: psiT,
    rMin: 1e-4,
    rMax: 1e3 * spec.halo.rmax,
  });
  const curve = new RotationCurve((R) => smoothVc(model, R), 12 * Rd, 256);
  let q = 0;
  const bulgeRmax = 25 * spec.bulge.scale;
  const bF = hernquistMass({ mass: 1, scale: spec.bulge.scale }, bulgeRmax);
  for (let i = 0; i < tr.bulge; i++, q++) {
    const u = ((i + rng.next()) / tr.bulge) * bF;
    const r = hernquistInverseMass(spec.bulge.scale, u);
    isotropic(rng, r, tPos, q * 3);
    isotropic(rng, dfBulgeT.sampleSpeed(rng, r), tVel, q * 3);
    kind[q] = KIND_BULGE;
    age[q] = 1000 * spec.pop.bulgeAgeGyr * (0.85 + 0.3 * rng.next());
    weight[q] = (spec.bulge.mass * bF) / tr.bulge;
  }

  // Disk stars: age from an exponentially declining SFH; thickness and dispersion grow with age
  // (age–velocity-dispersion relation σ ∝ age^⅓, e.g. Holmberg et al. 2009).
  const starMass = spec.disk.mass * (1 - spec.gas.fraction);
  const tau = spec.pop.sfhTauGyr;
  const ageBins = [0.15, 0.5, 1.5, 3.5, 7.5];
  const jeansByBin = ageBins.map((aG) => new VerticalJeans(model, z0 * Math.min(1, Math.max(0.3, Math.sqrt(aG / 7.5))), diskRmax));
  const sigOld = sigmaRFromQ(spec, curve, spec.disk.Q, Rd);
  for (let i = 0; i < tr.disk; i++, q++) {
    // Sample age in [0.1, 11] Gyr from SFR ∝ exp(−(11 − age)/τ) (declining in cosmic time → more old stars).
    const T = 11;
    const uA = rng.next();
    const lo = Math.exp(-(T - 0.1) / tau), hi = 1;
    const ageG = T + tau * Math.log(lo + uA * (hi - lo));
    const bin = ageG < 0.3 ? 0 : ageG < 1 ? 1 : ageG < 2.5 ? 2 : ageG < 5 ? 3 : 4;
    const hz = z0 * Math.min(1, Math.max(0.3, Math.sqrt(ageBins[bin] / 7.5)));
    const Rs = expDiskInverse(Math.min(0.9985, rng.next())) * Rd;
    const ph = rng.next() * 2 * Math.PI;
    const x = Rs * Math.cos(ph), y = Rs * Math.sin(ph), z = sech2Height(rng, hz);
    tPos[q * 3] = x;
    tPos[q * 3 + 1] = y;
    tPos[q * 3 + 2] = z;
    const sScale = Math.max(0.3, Math.pow(ageG / 7.5, 1 / 3));
    diskVelocity(
      rng,
      {
        curve,
        jeans: jeansByBin[bin],
        sigmaR: (R) => Math.max(kmsToSim(12), sigOld(R) * sScale),
        dlnRhoSigma2: (R) => -2 * (R / Rd),
      },
      x,
      y,
      z,
      tVel,
      q * 3,
    );
    kind[q] = KIND_DISK;
    age[q] = ageG * 1000;
    weight[q] = starMass / tr.disk;
  }

  // Gas: thinner, more extended, cold; a fraction has recently formed stars (HII regions).
  const Rg = Rd * spec.gas.scaleFactor;
  const zg = z0 * spec.gas.heightFactor;
  const gasJeans = new VerticalJeans(model, zg, 9 * Rd);
  const sigG = kmsToSim(spec.gas.sigmaKms);
  for (let i = 0; i < tr.gas; i++, q++) {
    const Rs = expDiskInverse(Math.min(0.997, rng.next())) * Rg;
    const ph = rng.next() * 2 * Math.PI;
    const x = Rs * Math.cos(ph), y = Rs * Math.sin(ph), z = sech2Height(rng, zg);
    tPos[q * 3] = x;
    tPos[q * 3 + 1] = y;
    tPos[q * 3 + 2] = z;
    diskVelocity(
      rng,
      { curve, jeans: gasJeans, sigmaR: () => sigG, dlnRhoSigma2: (R) => -R / Rg },
      x,
      y,
      z,
      tVel,
      q * 3,
    );
    kind[q] = KIND_GAS;
    // Burst clock: active HII regions have ages 0–60 Myr; the rest have no recent burst.
    age[q] = rng.next() < spec.pop.activeGas ? rng.next() * 60 : 1e4;
    weight[q] = (spec.disk.mass * spec.gas.fraction) / tr.gas;
  }

  return {
    spec,
    model,
    skeleton: { pos: sPos, vel: sVel, mass: sMass, comp: sComp, counts: { ...sk } },
    tracers: { pos: tPos, vel: tVel, kind, age, weight, counts: { ...tr } },
    mass: M,
  };
}
