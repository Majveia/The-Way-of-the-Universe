import { KIND_BULGE, updateSmoothDisk, type SmoothModel } from './galaxy';

/**
 * Smooth-disk refits from tracer moments (shared by the CPU reference and the GPU system).
 *
 * The disk potential that star and gas particles feel is re-derived from those particles: the
 * disk's orientation from their angular momentum, its mass from the fraction still within 5 R_d,
 * and its scale length / height from their (Gaussian-weighted, so returning debris and warps do
 * not dominate) second moments relative to t = 0. Disks torn apart by a merger thus hand their
 * mass to a spheroid instead of keeping a phantom thin-disk potential.
 */

/** Relaxation time for the refit disk parameters (Myr). */
export const DISK_REFIT_TAU = 25;

export interface DiskMoments {
  /** Σ w of disk tracers inside the hard radius 5 R_d (mass still in the disk region). */
  wIn: number;
  /** Σ w·g with Gaussian radial weight g = exp(−r²/2(2.5 R_d)²). */
  w: number;
  /** Σ w·g (d × u) — angular momentum about the centre. */
  L: [number, number, number];
  /** Σ w·g d_a d_b: xx, yy, zz, xy, xz, yz. */
  S: [number, number, number, number, number, number];
}

/** Gaussian scale (in R_d) of the moment weights; hard mass radius (in R_d). */
export const MOMENT_SIGMA = 2.5;
export const MOMENT_HARD = 5;

/** Moments of one galaxy's disk tracers (kinds disk + gas) about centre c, velocity cv. */
export function diskMoments(
  tx: ArrayLike<number>,
  tv: ArrayLike<number>,
  kind: ArrayLike<number>,
  gal: ArrayLike<number>,
  weight: ArrayLike<number>,
  gi: number,
  c: number[],
  cv: number[],
  rd: number,
): DiskMoments {
  const hard2 = (MOMENT_HARD * rd) ** 2;
  const s2 = 2 * (MOMENT_SIGMA * rd) ** 2;
  const out: DiskMoments = { wIn: 0, w: 0, L: [0, 0, 0], S: [0, 0, 0, 0, 0, 0] };
  const n = kind.length;
  for (let i = 0; i < n; i++) {
    if (gal[i] !== gi || kind[i] === KIND_BULGE) continue;
    const dx = tx[i * 3] - c[0], dy = tx[i * 3 + 1] - c[1], dz = tx[i * 3 + 2] - c[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    const wi = weight[i];
    if (d2 < hard2) out.wIn += wi;
    const w = wi * Math.exp(-d2 / s2);
    const ux = tv[i * 3] - cv[0], uy = tv[i * 3 + 1] - cv[1], uz = tv[i * 3 + 2] - cv[2];
    out.w += w;
    out.L[0] += w * (dy * uz - dz * uy);
    out.L[1] += w * (dz * ux - dx * uz);
    out.L[2] += w * (dx * uy - dy * ux);
    out.S[0] += w * dx * dx;
    out.S[1] += w * dy * dy;
    out.S[2] += w * dz * dz;
    out.S[3] += w * dx * dy;
    out.S[4] += w * dx * dz;
    out.S[5] += w * dy * dz;
  }
  return out;
}

/** Reference moments of the initial disk (for calibrating refits), in any frame. */
export interface DiskMomentsRef {
  wIn: number;
  R2: number;
  z2: number;
}

/**
 * Refit a smooth disk from its tracer moments, relaxing toward the new values with weight k.
 * Mass follows the fraction of disk tracers still within 5 R_d; orientation their angular
 * momentum; scale length and height their Gaussian-weighted second moments (relative to t = 0).
 * Shared by the CPU reference and the GPU system (which reads the moments back asynchronously).
 */
export function applyDiskMoments(
  model: SmoothModel,
  spin: number[],
  g: { spec: { disk: { mass: number; scale: number; height: number } }; moments0: DiskMomentsRef },
  mo: DiskMoments,
  k: number,
): void {
  if (!(mo.w > 0) || !(g.moments0.wIn > 0)) return;
  const Lm = Math.hypot(mo.L[0], mo.L[1], mo.L[2]);
  if (Lm > 0) {
    spin[0] += k * (mo.L[0] / Lm - spin[0]);
    spin[1] += k * (mo.L[1] / Lm - spin[1]);
    spin[2] += k * (mo.L[2] / Lm - spin[2]);
    const s = Math.hypot(spin[0], spin[1], spin[2]) || 1;
    spin[0] /= s;
    spin[1] /= s;
    spin[2] /= s;
  }
  const [nx, ny, nz] = spin;
  const [Sxx, Syy, Szz, Sxy, Sxz, Syz] = mo.S;
  const zz = nx * nx * Sxx + ny * ny * Syy + nz * nz * Szz + 2 * (nx * ny * Sxy + nx * nz * Sxz + ny * nz * Syz);
  const tr = Sxx + Syy + Szz;
  const z2 = Math.max(1e-12, zz / mo.w);
  const R2 = Math.max(1e-9, (tr - zz) / mo.w);
  const d = g.spec.disk;
  const mass = d.mass * Math.min(1, mo.wIn / g.moments0.wIn);
  const rd = d.scale * Math.sqrt(R2 / g.moments0.R2);
  const z0 = d.height * Math.sqrt(z2 / g.moments0.z2);
  model.disk.mass += k * (mass - model.disk.mass);
  model.disk.rd += k * (rd - model.disk.rd);
  model.disk.z0 += k * (z0 - model.disk.z0);
  updateSmoothDisk(model);
}
