import { smoothAccel, type SmoothModel } from './galaxy';
import { applyDiskMoments, diskMoments, DISK_REFIT_TAU } from './moments';
import type { ScenarioData } from './scenario';
import { G_SIM } from './units';

/**
 * Reference implementation of the hybrid integrator, in float64 on the CPU. The GPU version
 * (NBodySystem) runs the identical algorithm in float32 fragment shaders:
 *
 *  1. Skeleton — kick-drift-kick leapfrog (Verlet; symplectic, time-reversible) with direct
 *     Plummer-softened summation, ε_ij² = ½(ε_i² + ε_j²) (keeps forces pairwise-antisymmetric,
 *     so momentum is conserved to round-off).
 *  2. Centre tracking — each galaxy's smooth-field centre follows its inner skeleton: a
 *     Gaussian-windowed centroid (shrinking-sphere style, Power et al. 2003) filtered by a
 *     ballistic predictor driven by the window's mean acceleration (see CENTER_TAU).
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

/** Shrinking window radii (multiples of the bulk window). */
export const TRACK_RADII = [2, 1];
/**
 * Centre filter time constants (Myr). The smooth-field centre moves ballistically under the mean
 * skeleton acceleration of the bulge (internal forces cancel pairwise, so this is smooth) and is
 * pulled gently toward the measured centroid: dc/dt = u + Δ/τ_x, du/dt = ā + Δ/τ_v² + (ū − u)/τ_u,
 * with Δ = c_meas − c. This removes the Brownian jitter a grainy skeleton bulge suffers from its
 * 10⁸–10⁹ M☉ halo particles (which would otherwise shake the thin tracer disks).
 */
export const CENTER_TAU = { x: 40, v: 60, u: 80 };
/** Gaussian window (kpc) for the bulk velocity/acceleration: max(8 kpc, 3 R_d). */
export const bulkWindow = (rd: number) => Math.max(8, 3 * rd);

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
  /** Mean skeleton acceleration of each bulge (drives the centre filter). */
  readonly centerAcc: number[][];
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
    this.centerAcc = data.galaxies.map(() => [0, 0, 0]);
    this.spins = data.galaxies.map((g) => [...g.spin]);
    this.prevCenters = this.centers.map((c) => [...c]);
    this.skeletonForces();
    this.measureCenters();
    this.data.galaxies.forEach((_, g) => {
      this.centers[g] = [...this.meas[g].c];
      this.centerVel[g] = [...this.meas[g].v];
      this.centerAcc[g] = [...this.meas[g].a];
    });
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

  /** Latest raw measurements (centroid, mean velocity, mean acceleration) per galaxy. */
  readonly meas = [0, 1].map(() => ({ c: [0, 0, 0], v: [0, 0, 0], a: [0, 0, 0] }));

  /**
   * Measure each galaxy's inner centroid, bulk velocity and bulk acceleration: Gaussian-weighted
   * means over ALL of the galaxy's skeleton particles (halo, bulge, disk) in a broad window around
   * the current centre (two shrinking passes). Averaging over ~10³ particles makes this far less
   * noisy than a bulge-only centroid, and internal forces cancel pairwise to first order, so the
   * mean acceleration traces the orbit (tides, dynamical friction) without the core's Brownian
   * sloshing inside a grainy halo.
   */
  measureCenters(): void {
    this.data.galaxies.forEach((g, gi) => {
      const c = [...this.centers[gi]];
      const win = bulkWindow(g.spec.disk.scale);
      const out = this.meas[gi];
      let sw2 = 0;
      for (const f of TRACK_RADII) {
        sw2 = 2 * (f * win) ** 2;
        let sx = 0, sy = 0, sz = 0, wS = 0;
        for (let i = 0; i < this.nS; i++) {
          if (this.code[i] >> 2 !== gi) continue;
          const dx = this.x[i * 3] - c[0], dy = this.x[i * 3 + 1] - c[1], dz = this.x[i * 3 + 2] - c[2];
          const w = this.m[i] * Math.exp(-(dx * dx + dy * dy + dz * dz) / sw2);
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
      out.c = c;
      let vx = 0, vy = 0, vz = 0, ax = 0, ay = 0, az = 0, wS = 0;
      for (let i = 0; i < this.nS; i++) {
        if (this.code[i] >> 2 !== gi) continue;
        const dx = this.x[i * 3] - c[0], dy = this.x[i * 3 + 1] - c[1], dz = this.x[i * 3 + 2] - c[2];
        const w = this.m[i] * Math.exp(-(dx * dx + dy * dy + dz * dz) / sw2);
        wS += w;
        vx += w * this.v[i * 3];
        vy += w * this.v[i * 3 + 1];
        vz += w * this.v[i * 3 + 2];
        ax += w * this.a[i * 3];
        ay += w * this.a[i * 3 + 1];
        az += w * this.a[i * 3 + 2];
      }
      if (wS > 0) {
        out.v = [vx / wS, vy / wS, vz / wS];
        out.a = [ax / wS, ay / wS, az / wS];
      }
    });
  }

  /** Advance the filtered centres by one step (leapfrog with the mean acceleration + corrections). */
  filterCenters(dt: number): void {
    const T = CENTER_TAU;
    const n = this.data.galaxies.length;
    // Predict: kick–drift with the previous mean acceleration.
    for (let g = 0; g < n; g++) {
      const c = this.centers[g], u = this.centerVel[g], a0 = this.centerAcc[g];
      for (let k = 0; k < 3; k++) {
        u[k] += 0.5 * dt * a0[k];
        c[k] += dt * u[k];
      }
    }
    this.measureCenters();
    // Correct: second half-kick with the new mean acceleration, plus gentle pulls toward the
    // measured centroid and mean velocity.
    for (let g = 0; g < n; g++) {
      const c = this.centers[g], u = this.centerVel[g], a0 = this.centerAcc[g];
      const m = this.meas[g];
      for (let k = 0; k < 3; k++) {
        const d = m.c[k] - c[k];
        u[k] += 0.5 * dt * m.a[k] + (dt * d) / (T.v * T.v) + (dt * (m.v[k] - u[k])) / T.u;
        c[k] += (dt * d) / T.x;
        a0[k] = m.a[k];
      }
    }
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
      const mo = diskMoments(this.tx, this.tv, this.kind, this.gal, this.weight, gi, this.centers[gi], this.centerVel[gi], g.spec.disk.scale);
      applyDiskMoments(this.models[gi], this.spins[gi], g, mo, k);
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
    this.filterCenters(dt);
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
