import { KIND_BULGE, smoothAccel, updateSmoothDisk, type SmoothModel } from './galaxy';
import { diskMomentRadius, type ScenarioData } from './scenario';
import { G_SIM } from './units';

/**
 * Reference implementation of the hybrid integrator, in float64 on the CPU. The GPU version
 * (NBodySystem) runs the identical algorithm in float32 fragment shaders:
 *
 *  1. Skeleton — kick-drift-kick leapfrog (Verlet; symplectic, time-reversible) with direct
 *     Plummer-softened summation, ε_ij² = ½(ε_i² + ε_j²) (keeps forces pairwise-antisymmetric,
 *     so momentum is conserved to round-off).
 *  2. Centre tracking — each galaxy's centre is the Gaussian-weighted "shrinking sphere" centroid
 *     of its skeleton bulge particles (Power et al. 2003-style), from the previous centre.
 *  3. Tracers — K leapfrog sub-steps per skeleton step in the smooth field of both galaxies,
 *     whose centres are interpolated linearly across the step.
 *  4. Disk refit — the smooth disk of each galaxy is re-derived from its own disk tracers:
 *     orientation from their angular momentum, mass from the fraction still inside 5 R_d, and
 *     scale length/height from their second moments (so disks that are torn apart hand their
 *     mass to a spheroid).
 */
export interface IntegratorOptions {
  /** Skeleton time step (Myr). */
  dt: number;
  /** Tracer sub-steps per skeleton step. */
  substeps: number;
}

export interface Diagnostics {
  kinetic: number;
  potential: number;
  energy: number;
  momentum: [number, number, number];
  angularMomentum: [number, number, number];
}

/** Smoothing time for the refit disk parameters (Myr). */
export const DISK_REFIT_TAU = 25;
/** Shrinking-sphere radii (kpc, multiples of the bulge scale). */
export const TRACK_RADII = [3, 1.6, 1];

export class CpuNBody {
  time = 0;
  readonly nS: number;
  readonly nT: number;
  readonly x: Float64Array;
  readonly v: Float64Array;
  readonly a: Float64Array;
  readonly phi: Float64Array;
  readonly m: Float64Array;
  readonly eps2: Float64Array;
  readonly code: Uint8Array;
  readonly tx: Float64Array;
  readonly tv: Float64Array;
  readonly kind: Uint8Array;
  readonly gal: Uint8Array;
  readonly weight: Float64Array;
  readonly models: SmoothModel[];
  readonly centers: number[][];
  readonly centerVel: number[][];
  readonly spins: number[][];
  private prevCenters: number[][];

  constructor(
    readonly data: ScenarioData,
    readonly opts: IntegratorOptions,
  ) {
    const S = data.skeleton, T = data.tracers;
    this.nS = S.n;
    this.nT = T.n;
    this.x = new Float64Array(S.n * 3);
    this.v = new Float64Array(S.n * 3);
    this.a = new Float64Array(S.n * 3);
    this.phi = new Float64Array(S.n);
    this.m = new Float64Array(S.n);
    this.eps2 = new Float64Array(S.n);
    this.code = new Uint8Array(S.n);
    for (let i = 0; i < S.n; i++) {
      for (let k = 0; k < 3; k++) {
        this.x[i * 3 + k] = S.pos[i * 4 + k];
        this.v[i * 3 + k] = S.vel[i * 4 + k];
      }
      this.m[i] = S.pos[i * 4 + 3];
      this.code[i] = S.vel[i * 4 + 3];
    }
    for (const seg of S.segments) for (let i = seg.start; i < seg.start + seg.count; i++) this.eps2[i] = seg.eps * seg.eps;
    this.tx = new Float64Array(T.n * 3);
    this.tv = new Float64Array(T.n * 3);
    this.kind = new Uint8Array(T.n);
    this.gal = new Uint8Array(T.n);
    this.weight = new Float64Array(T.n);
    for (let i = 0; i < T.n; i++) {
      for (let k = 0; k < 3; k++) {
        this.tx[i * 3 + k] = T.pos[i * 4 + k];
        this.tv[i * 3 + k] = T.vel[i * 4 + k];
      }
      this.kind[i] = T.attr[i * 4];
      this.gal[i] = T.attr[i * 4 + 1];
      this.weight[i] = T.attr[i * 4 + 3];
    }
    this.models = data.galaxies.map((g) => structuredClone(g.model));
    this.centers = data.galaxies.map((g) => [...g.center]);
    this.centerVel = data.galaxies.map((g) => [...g.velocity]);
    this.spins = data.galaxies.map((g) => [...g.spin]);
    this.prevCenters = this.centers.map((c) => [...c]);
    this.skeletonForces();
    this.track();
  }

  /** Direct-summation accelerations and potentials of the skeleton. */
  skeletonForces(): void {
    const { x, m, eps2, a, phi, nS } = this;
    a.fill(0);
    phi.fill(0);
    for (let i = 0; i < nS; i++) {
      const xi = x[i * 3], yi = x[i * 3 + 1], zi = x[i * 3 + 2];
      let ax = 0, ay = 0, az = 0, p = 0;
      for (let j = i + 1; j < nS; j++) {
        const dx = x[j * 3] - xi, dy = x[j * 3 + 1] - yi, dz = x[j * 3 + 2] - zi;
        const r2 = dx * dx + dy * dy + dz * dz + 0.5 * (eps2[i] + eps2[j]);
        const inv = 1 / Math.sqrt(r2);
        const inv3 = inv * inv * inv;
        const fj = m[j] * inv3, fi = m[i] * inv3;
        ax += dx * fj;
        ay += dy * fj;
        az += dz * fj;
        a[j * 3] -= dx * fi;
        a[j * 3 + 1] -= dy * fi;
        a[j * 3 + 2] -= dz * fi;
        p -= m[j] * inv;
        phi[j] -= m[i] * inv;
      }
      a[i * 3] += ax;
      a[i * 3 + 1] += ay;
      a[i * 3 + 2] += az;
      phi[i] += p;
    }
    for (let i = 0; i < nS * 3; i++) a[i] *= G_SIM;
    for (let i = 0; i < nS; i++) phi[i] *= G_SIM;
  }

  /** Shrinking-sphere centres of each galaxy's bulge. */
  track(): void {
    this.data.galaxies.forEach((g, gi) => {
      const seg = g.bulge;
      const c = this.centers[gi];
      const ab = g.spec.bulge.scale;
      let wS = 0;
      for (const rk of TRACK_RADII) {
        const s2 = 2 * (rk * Math.max(0.5, ab)) ** 2;
        let sx = 0, sy = 0, sz = 0;
        wS = 0;
        for (let i = seg.start; i < seg.start + seg.count; i++) {
          const dx = this.x[i * 3] - c[0], dy = this.x[i * 3 + 1] - c[1], dz = this.x[i * 3 + 2] - c[2];
          const w = this.m[i] * Math.exp(-(dx * dx + dy * dy + dz * dz) / s2);
          wS += w;
          sx += w * this.x[i * 3];
          sy += w * this.x[i * 3 + 1];
          sz += w * this.x[i * 3 + 2];
        }
        if (wS > 0) {
          c[0] = sx / wS;
          c[1] = sy / wS;
          c[2] = sz / wS;
        }
      }
      // Velocity of the centre: same weights at the final radius.
      const s2 = 2 * (TRACK_RADII[TRACK_RADII.length - 1] * Math.max(0.5, ab)) ** 2;
      let vx = 0, vy = 0, vz = 0;
      wS = 0;
      for (let i = seg.start; i < seg.start + seg.count; i++) {
        const dx = this.x[i * 3] - c[0], dy = this.x[i * 3 + 1] - c[1], dz = this.x[i * 3 + 2] - c[2];
        const w = this.m[i] * Math.exp(-(dx * dx + dy * dy + dz * dz) / s2);
        wS += w;
        vx += w * this.v[i * 3];
        vy += w * this.v[i * 3 + 1];
        vz += w * this.v[i * 3 + 2];
      }
      if (wS > 0) this.centerVel[gi] = [vx / wS, vy / wS, vz / wS];
    });
  }

  /** Smooth-field acceleration on a tracer at fraction f of the current step. */
  private tracerAccel(px: number, py: number, pz: number, f: number, out: number[]): void {
    out[0] = out[1] = out[2] = 0;
    for (let g = 0; g < 2; g++) {
      const c0 = this.prevCenters[g], c1 = this.centers[g], n = this.spins[g];
      const cx = c0[0] + f * (c1[0] - c0[0]), cy = c0[1] + f * (c1[1] - c0[1]), cz = c0[2] + f * (c1[2] - c0[2]);
      smoothAccel(this.models[g], px - cx, py - cy, pz - cz, n[0], n[1], n[2], out, true);
    }
  }

  private stepTracers(): void {
    const K = this.opts.substeps;
    const h = this.opts.dt / K;
    const acc = [0, 0, 0];
    const { tx, tv } = this;
    for (let i = 0; i < this.nT; i++) {
      let px = tx[i * 3], py = tx[i * 3 + 1], pz = tx[i * 3 + 2];
      let vx = tv[i * 3], vy = tv[i * 3 + 1], vz = tv[i * 3 + 2];
      this.tracerAccel(px, py, pz, 0, acc);
      for (let k = 0; k < K; k++) {
        vx += 0.5 * h * acc[0];
        vy += 0.5 * h * acc[1];
        vz += 0.5 * h * acc[2];
        px += h * vx;
        py += h * vy;
        pz += h * vz;
        this.tracerAccel(px, py, pz, (k + 1) / K, acc);
        vx += 0.5 * h * acc[0];
        vy += 0.5 * h * acc[1];
        vz += 0.5 * h * acc[2];
      }
      tx[i * 3] = px;
      tx[i * 3 + 1] = py;
      tx[i * 3 + 2] = pz;
      tv[i * 3] = vx;
      tv[i * 3 + 1] = vy;
      tv[i * 3 + 2] = vz;
    }
  }

  /** Mass-weighted moments of each galaxy's disk tracers → smooth-disk refit. */
  refitDisks(dtMyr: number): void {
    const k = 1 - Math.exp(-dtMyr / DISK_REFIT_TAU);
    this.data.galaxies.forEach((g, gi) => {
      const c = this.centers[gi], cv = this.centerVel[gi];
      const rc2 = diskMomentRadius(g.spec) ** 2;
      let w = 0, Lx = 0, Ly = 0, Lz = 0;
      let Sxx = 0, Syy = 0, Szz = 0, Sxy = 0, Sxz = 0, Syz = 0;
      for (let i = 0; i < this.nT; i++) {
        if (this.gal[i] !== gi || this.kind[i] === KIND_BULGE) continue;
        const dx = this.tx[i * 3] - c[0], dy = this.tx[i * 3 + 1] - c[1], dz = this.tx[i * 3 + 2] - c[2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > rc2) continue;
        const wi = this.weight[i];
        const ux = this.tv[i * 3] - cv[0], uy = this.tv[i * 3 + 1] - cv[1], uz = this.tv[i * 3 + 2] - cv[2];
        w += wi;
        Lx += wi * (dy * uz - dz * uy);
        Ly += wi * (dz * ux - dx * uz);
        Lz += wi * (dx * uy - dy * ux);
        Sxx += wi * dx * dx;
        Syy += wi * dy * dy;
        Szz += wi * dz * dz;
        Sxy += wi * dx * dy;
        Sxz += wi * dx * dz;
        Syz += wi * dy * dz;
      }
      applyDiskMoments(this.models[gi], this.spins[gi], g, { w, L: [Lx, Ly, Lz], S: [Sxx, Syy, Szz, Sxy, Sxz, Syz] }, k);
    });
  }

  step(): void {
    const { dt } = this.opts;
    const { x, v, a, nS } = this;
    for (let i = 0; i < nS * 3; i++) {
      v[i] += 0.5 * dt * a[i];
      x[i] += dt * v[i];
    }
    this.skeletonForces();
    for (let i = 0; i < nS * 3; i++) v[i] += 0.5 * dt * a[i];
    this.prevCenters = this.centers.map((c) => [...c]);
    this.track();
    this.stepTracers();
    this.refitDisks(dt);
    this.time += dt;
  }

  diagnostics(): Diagnostics {
    let K = 0, W = 0;
    const P: [number, number, number] = [0, 0, 0];
    const L: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < this.nS; i++) {
      const m = this.m[i];
      const vx = this.v[i * 3], vy = this.v[i * 3 + 1], vz = this.v[i * 3 + 2];
      const px = this.x[i * 3], py = this.x[i * 3 + 1], pz = this.x[i * 3 + 2];
      K += 0.5 * m * (vx * vx + vy * vy + vz * vz);
      W += 0.5 * m * this.phi[i];
      P[0] += m * vx;
      P[1] += m * vy;
      P[2] += m * vz;
      L[0] += m * (py * vz - pz * vy);
      L[1] += m * (pz * vx - px * vz);
      L[2] += m * (px * vy - py * vx);
    }
    return { kinetic: K, potential: W, energy: K + W, momentum: P, angularMomentum: L };
  }
}

export interface DiskMoments {
  /** Σ w inside the refit radius. */
  w: number;
  /** Σ w (d × u) — angular momentum about the centre. */
  L: [number, number, number];
  /** Σ w d_a d_b: xx, yy, zz, xy, xz, yz. */
  S: [number, number, number, number, number, number];
}

/**
 * Refit a smooth disk from its tracer moments, relaxing toward the new values with weight k.
 * Shared by the CPU reference and the GPU system (which reads the moments back asynchronously).
 */
export function applyDiskMoments(
  model: SmoothModel,
  spin: number[],
  g: { spec: { disk: { mass: number; scale: number; height: number } }; moments0: { R2: number; z2: number; weightIn: number } },
  mo: DiskMoments,
  k: number,
): void {
  if (!(mo.w > 0)) return;
  const Lm = Math.hypot(mo.L[0], mo.L[1], mo.L[2]);
  if (Lm > 0) {
    const nx = mo.L[0] / Lm, ny = mo.L[1] / Lm, nz = mo.L[2] / Lm;
    spin[0] += k * (nx - spin[0]);
    spin[1] += k * (ny - spin[1]);
    spin[2] += k * (nz - spin[2]);
    const s = Math.hypot(spin[0], spin[1], spin[2]) || 1;
    spin[0] /= s;
    spin[1] /= s;
    spin[2] /= s;
  }
  const [nx, ny, nz] = spin;
  const [Sxx, Syy, Szz, Sxy, Sxz, Syz] = mo.S;
  const zz = nx * nx * Sxx + ny * ny * Syy + nz * nz * Szz + 2 * (nx * ny * Sxy + nx * nz * Sxz + ny * nz * Syz);
  const tr = Sxx + Syy + Szz;
  const z2 = Math.max(0, zz / mo.w);
  const R2 = Math.max(1e-9, (tr - zz) / mo.w);
  const d = g.spec.disk;
  const mass = d.mass * Math.min(1, mo.w / g.moments0.weightIn);
  const rd = d.scale * Math.sqrt(R2 / g.moments0.R2);
  const z0 = d.height * Math.sqrt(Math.max(z2, 1e-12) / g.moments0.z2);
  model.disk.mass += k * (mass - model.disk.mass);
  model.disk.rd += k * (rd - model.disk.rd);
  model.disk.z0 += k * (z0 - model.disk.z0);
  updateSmoothDisk(model);
}
