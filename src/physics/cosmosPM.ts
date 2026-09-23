/**
 * Particle-Mesh gravity in comoving coordinates (module: cosmos).
 *
 * Positions live in mesh-cell units on the periodic cube [0, n)³. Each force evaluation:
 *   1. cloud-in-cell (CIC) mass assignment → density contrast δ on the mesh,
 *   2. FFT, Poisson solve ψ(k) = −δ(k)/k² · W_CIC(k)^(−p) (deconvolution, p = 0–2) with an optional
 *      Gaussian smoothing, inverse FFT → potential ψ with ∇²ψ = δ,
 *   3. four-point finite-difference gradient F = −∇ψ (Hockney & Eastwood 1988, §5),
 *   4. CIC interpolation of F back to the particles (same kernel as the assignment, so there is
 *      no self-force and momentum is conserved).
 * The acceleration of canonical momentum p = a² dx/dt (H0 = 1) is dp/dt = (3/2) Ωm F / a.
 *
 * Time integration is FastPM kick–drift–kick (Feng, Chu, Seljak & McDonald 2016): the kick and
 * drift factors are modified so linear growth is exact with few, large time steps
 * (see cosmosExpansion.ts fastpmKick/fastpmDrift).
 */
import { RealFFT3D } from './cosmosFFT';

export interface PMOptions {
  /** Power of the CIC window to deconvolve in the Green's function (0 = none, 2 = assignment+interpolation). */
  deconvolve?: number;
  /** Gaussian force smoothing radius in cells (0 = none). */
  smoothing?: number;
}

export class ParticleMesh {
  readonly n: number;
  readonly fft: RealFFT3D;
  /** Density contrast δ after deposit(); overwritten by the potential during solve(). */
  readonly grid: Float32Array;
  readonly fx: Float32Array;
  readonly fy: Float32Array;
  readonly fz: Float32Array;
  /** Real Green's-function multiplier per half-spectrum mode. */
  private readonly green: Float32Array;
  private readonly shift: number;
  /** The last density spectrum (copy, before the Green's function) for P(k) measurement. */
  readonly deltaRe: Float64Array;
  readonly deltaIm: Float64Array;
  /** Mean particles per cell of the last deposit. */
  meanCount = 1;

  constructor(n: number, opts: PMOptions = {}) {
    this.n = n;
    this.shift = Math.round(Math.log2(n));
    this.fft = new RealFFT3D(n);
    const N3 = n * n * n;
    this.grid = new Float32Array(N3);
    this.fx = new Float32Array(N3);
    this.fy = new Float32Array(N3);
    this.fz = new Float32Array(N3);
    this.deltaRe = new Float64Array(this.fft.re.length);
    this.deltaIm = new Float64Array(this.fft.im.length);
    this.green = new Float32Array(this.fft.re.length);
    const nzc = this.fft.nzc, half = n >> 1;
    const p = opts.deconvolve ?? 1;
    const rs = opts.smoothing ?? 0;
    const w = (2 * Math.PI) / n;
    const sinc = (x: number) => (x === 0 ? 1 : Math.sin(x) / x);
    for (let ix = 0; ix < n; ix++) {
      const fx = ix < half ? ix : ix - n;
      for (let iy = 0; iy < n; iy++) {
        const fy = iy < half ? iy : iy - n;
        for (let iz = 0; iz < nzc; iz++) {
          const idx = (ix * n + iy) * nzc + iz;
          if (fx === 0 && fy === 0 && iz === 0) {
            this.green[idx] = 0;
            continue;
          }
          const kx = fx * w, ky = fy * w, kz = iz * w;
          const k2 = kx * kx + ky * ky + kz * kz;
          let g = -1 / k2;
          if (p > 0) {
            // CIC window per axis: sinc²(k Δ/2)
            const W = (sinc(kx / 2) * sinc(ky / 2) * sinc(kz / 2)) ** 2;
            g /= Math.pow(Math.max(W, 0.05), p);
          }
          if (rs > 0) g *= Math.exp(-k2 * rs * rs);
          this.green[idx] = g;
        }
      }
    }
  }

  /** CIC mass assignment of `count` particles (positions in cells, interleaved xyz) → δ in grid. */
  deposit(pos: Float32Array, count: number): void {
    const n = this.n, mask = n - 1, s = this.shift, s2 = 2 * s;
    const g = this.grid;
    g.fill(0);
    for (let p = 0; p < count; p++) {
      const x = pos[3 * p], y = pos[3 * p + 1], z = pos[3 * p + 2];
      const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
      const dx = x - ix, dy = y - iy, dz = z - iz;
      const tx = 1 - dx, ty = 1 - dy, tz = 1 - dz;
      const x0 = (ix & mask) << s2, x1 = ((ix + 1) & mask) << s2;
      const y0 = (iy & mask) << s, y1 = ((iy + 1) & mask) << s;
      const z0 = iz & mask, z1 = (iz + 1) & mask;
      g[x0 | y0 | z0] += tx * ty * tz;
      g[x0 | y0 | z1] += tx * ty * dz;
      g[x0 | y1 | z0] += tx * dy * tz;
      g[x0 | y1 | z1] += tx * dy * dz;
      g[x1 | y0 | z0] += dx * ty * tz;
      g[x1 | y0 | z1] += dx * ty * dz;
      g[x1 | y1 | z0] += dx * dy * tz;
      g[x1 | y1 | z1] += dx * dy * dz;
    }
    const mean = count / (n * n * n);
    this.meanCount = mean;
    const inv = 1 / mean;
    for (let i = 0; i < g.length; i++) g[i] = g[i] * inv - 1;
  }

  /** Poisson solve and force grids from the δ currently in `grid`. Keeps a copy of δ(k). */
  solve(): void {
    const fft = this.fft, g = this.green;
    fft.forward(this.grid);
    this.deltaRe.set(fft.re);
    this.deltaIm.set(fft.im);
    const re = fft.re, im = fft.im;
    for (let i = 0; i < re.length; i++) {
      re[i] *= g[i];
      im[i] *= g[i];
    }
    fft.inverse(this.grid); // grid now holds ψ (∇²ψ = δ, cell units)
    this.gradient();
  }

  /** F = −∇ψ with the 4-point stencil  f'(i) ≈ [8(f(i+1) − f(i−1)) − (f(i+2) − f(i−2))] / 12. */
  private gradient(): void {
    const n = this.n, mask = n - 1, s = this.shift;
    const psi = this.grid, fx = this.fx, fy = this.fy, fz = this.fz;
    const c1 = 8 / 12, c2 = 1 / 12;
    for (let x = 0; x < n; x++) {
      const xp1 = ((x + 1) & mask) << (2 * s), xm1 = ((x - 1) & mask) << (2 * s);
      const xp2 = ((x + 2) & mask) << (2 * s), xm2 = ((x - 2) & mask) << (2 * s);
      const xc = x << (2 * s);
      for (let y = 0; y < n; y++) {
        const yc = y << s;
        const yp1 = ((y + 1) & mask) << s, ym1 = ((y - 1) & mask) << s;
        const yp2 = ((y + 2) & mask) << s, ym2 = ((y - 2) & mask) << s;
        for (let z = 0; z < n; z++) {
          const i = xc | yc | z;
          fx[i] = -(c1 * (psi[xp1 | yc | z] - psi[xm1 | yc | z]) - c2 * (psi[xp2 | yc | z] - psi[xm2 | yc | z]));
          fy[i] = -(c1 * (psi[xc | yp1 | z] - psi[xc | ym1 | z]) - c2 * (psi[xc | yp2 | z] - psi[xc | ym2 | z]));
          const zp1 = (z + 1) & mask, zm1 = (z - 1) & mask, zp2 = (z + 2) & mask, zm2 = (z - 2) & mask;
          fz[i] = -(c1 * (psi[xc | yc | zp1] - psi[xc | yc | zm1]) - c2 * (psi[xc | yc | zp2] - psi[xc | yc | zm2]));
        }
      }
    }
  }

  /** p += factor · F(x) with CIC-interpolated forces. */
  kick(pos: Float32Array, mom: Float32Array, count: number, factor: number): void {
    const n = this.n, mask = n - 1, s = this.shift, s2 = 2 * s;
    const Fx = this.fx, Fy = this.fy, Fz = this.fz;
    for (let p = 0; p < count; p++) {
      const x = pos[3 * p], y = pos[3 * p + 1], z = pos[3 * p + 2];
      const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
      const dx = x - ix, dy = y - iy, dz = z - iz;
      const tx = 1 - dx, ty = 1 - dy, tz = 1 - dz;
      const x0 = (ix & mask) << s2, x1 = ((ix + 1) & mask) << s2;
      const y0 = (iy & mask) << s, y1 = ((iy + 1) & mask) << s;
      const z0 = iz & mask, z1 = (iz + 1) & mask;
      const w000 = tx * ty * tz, w001 = tx * ty * dz, w010 = tx * dy * tz, w011 = tx * dy * dz;
      const w100 = dx * ty * tz, w101 = dx * ty * dz, w110 = dx * dy * tz, w111 = dx * dy * dz;
      const i000 = x0 | y0 | z0, i001 = x0 | y0 | z1, i010 = x0 | y1 | z0, i011 = x0 | y1 | z1;
      const i100 = x1 | y0 | z0, i101 = x1 | y0 | z1, i110 = x1 | y1 | z0, i111 = x1 | y1 | z1;
      mom[3 * p] += factor * (w000 * Fx[i000] + w001 * Fx[i001] + w010 * Fx[i010] + w011 * Fx[i011] + w100 * Fx[i100] + w101 * Fx[i101] + w110 * Fx[i110] + w111 * Fx[i111]);
      mom[3 * p + 1] += factor * (w000 * Fy[i000] + w001 * Fy[i001] + w010 * Fy[i010] + w011 * Fy[i011] + w100 * Fy[i100] + w101 * Fy[i101] + w110 * Fy[i110] + w111 * Fy[i111]);
      mom[3 * p + 2] += factor * (w000 * Fz[i000] + w001 * Fz[i001] + w010 * Fz[i010] + w011 * Fz[i011] + w100 * Fz[i100] + w101 * Fz[i101] + w110 * Fz[i110] + w111 * Fz[i111]);
    }
  }

  /** x += factor · p, wrapped periodically into [0, n). */
  drift(pos: Float32Array, mom: Float32Array, count: number, factor: number): void {
    const n = this.n;
    for (let i = 0; i < 3 * count; i++) {
      let x = pos[i] + factor * mom[i];
      if (x >= n) x -= n * Math.floor(x / n);
      else if (x < 0) x -= n * Math.floor(x / n);
      if (x >= n) x = 0; // float32 rounding guard
      pos[i] = x;
    }
  }

  /** CIC-interpolated 1+δ at each particle from the δ currently in `grid` (call after deposit()). */
  densityAt(pos: Float32Array, count: number, out: Float32Array): void {
    const n = this.n, mask = n - 1, s = this.shift, s2 = 2 * s;
    const g = this.grid;
    for (let p = 0; p < count; p++) {
      const x = pos[3 * p], y = pos[3 * p + 1], z = pos[3 * p + 2];
      const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
      const dx = x - ix, dy = y - iy, dz = z - iz;
      const tx = 1 - dx, ty = 1 - dy, tz = 1 - dz;
      const x0 = (ix & mask) << s2, x1 = ((ix + 1) & mask) << s2;
      const y0 = (iy & mask) << s, y1 = ((iy + 1) & mask) << s;
      const z0 = iz & mask, z1 = (iz + 1) & mask;
      out[p] =
        1 +
        tx * ty * tz * g[x0 | y0 | z0] + tx * ty * dz * g[x0 | y0 | z1] + tx * dy * tz * g[x0 | y1 | z0] + tx * dy * dz * g[x0 | y1 | z1] +
        dx * ty * tz * g[x1 | y0 | z0] + dx * ty * dz * g[x1 | y0 | z1] + dx * dy * tz * g[x1 | y1 | z0] + dx * dy * dz * g[x1 | y1 | z1];
    }
  }

  /** Squared CIC window for integer frequencies (for P(k) measurement). */
  static cicWindow2(n: number): (fx: number, fy: number, fz: number) => number {
    const sinc = (x: number) => (x === 0 ? 1 : Math.sin(x) / x);
    return (fx, fy, fz) => {
      const w = (sinc((Math.PI * fx) / n) * sinc((Math.PI * fy) / n) * sinc((Math.PI * fz) / n)) ** 2;
      return w * w;
    };
  }
}
