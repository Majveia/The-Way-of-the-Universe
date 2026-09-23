/**
 * Initial conditions for the cosmic-web simulation (module: cosmos).
 *
 * 1. A Gaussian random field δ(k) on an n³ periodic mesh with ⟨|δ_k|²⟩ = n⁶ P(k)/V (DFT convention),
 *    drawn mode by mode from a hash of the integer wavevector and the seed. The draw for a
 *    given (kx, ky, kz) does not depend on n, so every resolution of the same seed shares its
 *    large-scale structure (the low-quality and high-quality universes are the same universe).
 *    Hermitian symmetry δ(−k) = δ(k)* is imposed explicitly on the kz = 0 plane (the only plane
 *    of the half-spectrum that contains ±k pairs); Nyquist planes and k = 0 are zeroed.
 * 2. Lagrangian perturbation theory displacements (Buchert 1989; Bouchet et al. 1995;
 *    Scoccimarro 1998, MNRAS 299, 1097; Crocce, Pueblas & Scoccimarro 2006):
 *      x = q + D1 Ψ1 + D2 Ψ2,   Ψ1 = −∇φ1,  ∇²φ1 = δ          (Zel'dovich)
 *      Ψ2 = ∇φ2,  ∇²φ2 = Σ_{i<j} [φ1,ii φ1,jj − (φ1,ij)²],     D2 ≈ −(3/7) D1²   (2LPT)
 *    In Fourier space Ψ1(k) = i k δ(k)/k², φ1,ij(k) = k_i k_j δ(k)/k², Ψ2(k) = −i k S2(k)/k².
 *
 * Lengths in h⁻¹ Mpc, k in h Mpc⁻¹. Fields are normalised to z = 0 linear theory (D1 = 1).
 */
import { RealFFT3D } from './cosmosFFT';
import { hashInts } from './random';

export interface GaussianFieldParams {
  /** Mesh cells per side (power of two). */
  n: number;
  /** Box side, h⁻¹ Mpc. */
  box: number;
  seed: number;
  /** Linear power spectrum at z = 0, (h⁻¹Mpc)³, k in h Mpc⁻¹. */
  power: (k: number) => number;
  /** Fix |δ_k| to its rms (Angulo & Pontzen 2016 "fixed" fields) — suppresses cosmic variance. */
  fixedAmplitude?: boolean;
}

/** The linear density field at z = 0 in Fourier space (half-spectrum layout of RealFFT3D). */
export class GaussianField {
  readonly n: number;
  readonly nzc: number;
  readonly box: number;
  /** Fundamental wavenumber 2π/L. */
  readonly kf: number;
  readonly re: Float64Array;
  readonly im: Float64Array;

  constructor(p: GaussianFieldParams) {
    const n = p.n, nzc = (n >> 1) + 1, half = n >> 1;
    this.n = n;
    this.nzc = nzc;
    this.box = p.box;
    this.kf = (2 * Math.PI) / p.box;
    this.re = new Float64Array(n * n * nzc);
    this.im = new Float64Array(n * n * nzc);
    const V = p.box ** 3;
    const n6 = (n * n * n) ** 2;
    // P(k) depends only on the integer |k|² → cache.
    const maxN2 = 3 * half * half + 1;
    const amp = new Float64Array(maxN2);
    for (let q = 1; q < maxN2; q++) {
      const k = this.kf * Math.sqrt(q);
      amp[q] = Math.sqrt(Math.max(p.power(k), 0) * n6 / V / 2);
    }
    const seed = p.seed | 0;
    const fixed = !!p.fixedAmplitude;
    const draw = (kx: number, ky: number, kz: number, out: { r: number; i: number }) => {
      const h1 = hashInts(kx, ky, kz, seed);
      const h2 = hashInts(kx, ky, kz, seed ^ 0x5bd1e995);
      const u1 = (h1 + 0.5) / 4294967296;
      const u2 = (h2 + 0.5) / 4294967296;
      const r = fixed ? Math.SQRT2 : Math.sqrt(-2 * Math.log(u1));
      out.r = r * Math.cos(2 * Math.PI * u2);
      out.i = r * Math.sin(2 * Math.PI * u2);
    };
    const g = { r: 0, i: 0 };
    for (let ix = 0; ix < n; ix++) {
      const kx = ix < half ? ix : ix - n;
      for (let iy = 0; iy < n; iy++) {
        const ky = iy < half ? iy : iy - n;
        for (let iz = 0; iz < nzc; iz++) {
          const kz = iz;
          const idx = (ix * n + iy) * nzc + iz;
          if (ix === half || iy === half || iz === half || (kx === 0 && ky === 0 && kz === 0)) {
            this.re[idx] = 0;
            this.im[idx] = 0;
            continue;
          }
          const q = kx * kx + ky * ky + kz * kz;
          const A = amp[q];
          if (kz === 0) {
            // Canonical member of the ±k pair: kx > 0, or kx = 0 and ky > 0.
            const canonical = kx > 0 || (kx === 0 && ky > 0);
            if (canonical) {
              draw(kx, ky, 0, g);
              this.re[idx] = A * g.r;
              this.im[idx] = A * g.i;
            } else {
              draw(-kx, -ky, 0, g);
              this.re[idx] = A * g.r;
              this.im[idx] = -A * g.i;
            }
          } else {
            draw(kx, ky, kz, g);
            this.re[idx] = A * g.r;
            this.im[idx] = A * g.i;
          }
        }
      }
    }
  }

  /** Integer frequency of index i. */
  freq(i: number): number {
    return i < this.n >> 1 ? i : i - this.n;
  }

  /**
   * Fill `fft`'s spectrum with δ(k)·K(kx, ky, kz) where K returns a complex multiplier
   * (physical k in h/Mpc), then inverse-transform into `out`.
   */
  realise(
    fft: RealFFT3D,
    out: Float32Array | Float64Array,
    kernel: (kx: number, ky: number, kz: number, k2: number, res: { r: number; i: number }) => void,
  ): void {
    const n = this.n, nzc = this.nzc, kf = this.kf;
    const res = { r: 0, i: 0 };
    for (let ix = 0; ix < n; ix++) {
      const kx = this.freq(ix) * kf;
      for (let iy = 0; iy < n; iy++) {
        const ky = this.freq(iy) * kf;
        const base = (ix * n + iy) * nzc;
        for (let iz = 0; iz < nzc; iz++) {
          const kz = iz * kf;
          const idx = base + iz;
          const dr = this.re[idx], di = this.im[idx];
          if (dr === 0 && di === 0) {
            fft.re[idx] = 0;
            fft.im[idx] = 0;
            continue;
          }
          kernel(kx, ky, kz, kx * kx + ky * ky + kz * kz, res);
          fft.re[idx] = dr * res.r - di * res.i;
          fft.im[idx] = dr * res.i + di * res.r;
        }
      }
    }
    fft.inverse(out);
  }
}

/** Measured power spectrum of a real field in logarithmic k bins. */
export interface PowerMeasurement {
  k: Float64Array;
  P: Float64Array;
  modes: Float64Array;
}

/**
 * Measure P(k) from a spectrum in RealFFT3D layout (unnormalised DFT of a density contrast).
 * `window(kx,ky,kz)` optionally divides out a mass-assignment window (squared), e.g. CIC.
 * Counts kz > 0 modes twice (their −k partners are implicit).
 */
export function measurePower(
  re: Float64Array,
  im: Float64Array,
  n: number,
  box: number,
  bins: number,
  opts: { kMin?: number; kMax?: number; window2?: (ix: number, iy: number, iz: number) => number; shotNoise?: number } = {},
): PowerMeasurement {
  const nzc = (n >> 1) + 1, half = n >> 1;
  const kf = (2 * Math.PI) / box;
  const kMin = opts.kMin ?? kf;
  const kMax = opts.kMax ?? kf * half;
  const lmin = Math.log(kMin), lmax = Math.log(kMax);
  const sumP = new Float64Array(bins), sumK = new Float64Array(bins), cnt = new Float64Array(bins);
  const V = box ** 3;
  const norm = V / (n * n * n) ** 2;
  for (let ix = 0; ix < n; ix++) {
    const fx = ix < half ? ix : ix - n;
    for (let iy = 0; iy < n; iy++) {
      const fy = iy < half ? iy : iy - n;
      for (let iz = 0; iz < nzc; iz++) {
        if (ix === half || iy === half || iz === half) continue;
        const q = fx * fx + fy * fy + iz * iz;
        if (q === 0) continue;
        const k = kf * Math.sqrt(q);
        const b = Math.floor(((Math.log(k) - lmin) / (lmax - lmin)) * bins);
        if (b < 0 || b >= bins) continue;
        const idx = (ix * n + iy) * nzc + iz;
        let p = (re[idx] * re[idx] + im[idx] * im[idx]) * norm;
        if (opts.window2) p /= opts.window2(fx, fy, iz);
        const w = iz === 0 ? 1 : 2;
        sumP[b] += w * p;
        sumK[b] += w * k;
        cnt[b] += w;
      }
    }
  }
  const out: PowerMeasurement = { k: new Float64Array(bins), P: new Float64Array(bins), modes: cnt };
  for (let b = 0; b < bins; b++) {
    out.k[b] = cnt[b] ? sumK[b] / cnt[b] : Math.exp(lmin + ((b + 0.5) / bins) * (lmax - lmin));
    out.P[b] = cnt[b] ? sumP[b] / cnt[b] - (opts.shotNoise ?? 0) : 0;
  }
  return out;
}

/** Output of the Lagrangian perturbation theory displacement computation. */
export interface LPTDisplacements {
  /** Particles per side. */
  np: number;
  /** First- and second-order displacements at z = 0 normalisation, h⁻¹ Mpc, interleaved xyz. */
  psi1: Float32Array;
  psi2: Float32Array;
  /** Linear overdensity at each particle's Lagrangian site, smoothed (Gaussian R), z = 0. */
  deltaL: Float32Array;
  /** rms of deltaL (the realised σ(R)). */
  sigmaL: number;
  /** rms of |Ψ1| per component, h⁻¹ Mpc. */
  psiRms: number;
}

/**
 * Compute Zel'dovich and 2LPT displacement fields on the mesh and sample them at the particle
 * lattice q = (i, j, k)·(L/np). With np = n the lattice sits exactly on mesh nodes; otherwise
 * the fields are trilinearly interpolated.
 */
export function lptDisplacements(
  field: GaussianField,
  np: number,
  opts: { smoothing?: number; secondOrder?: boolean; progress?: (f: number, label: string) => void } = {},
): LPTDisplacements {
  const n = field.n;
  const fft = new RealFFT3D(n);
  const N3 = n * n * n;
  const A = new Float32Array(N3);
  const B = new Float32Array(N3);
  const S = new Float32Array(N3);
  const count = np * np * np;
  const psi1 = new Float32Array(count * 3);
  const psi2 = new Float32Array(count * 3);
  const deltaL = new Float32Array(count);
  const prog = opts.progress ?? (() => undefined);
  const cell = field.box / n;

  const sample = (grid: Float32Array, out: Float32Array, comp: number, stride: number) => {
    const ratio = n / np;
    const mask = n - 1;
    if (ratio === 1) {
      for (let p = 0; p < count; p++) out[p * stride + comp] = grid[p];
      return;
    }
    let p = 0;
    for (let i = 0; i < np; i++) {
      const x = i * ratio, ix = Math.floor(x), fx = x - ix;
      for (let j = 0; j < np; j++) {
        const y = j * ratio, iy = Math.floor(y), fy = y - iy;
        for (let k = 0; k < np; k++, p++) {
          const z = k * ratio, iz = Math.floor(z), fz = z - iz;
          const x0 = ix & mask, x1 = (ix + 1) & mask, y0 = iy & mask, y1 = (iy + 1) & mask, z0 = iz & mask, z1 = (iz + 1) & mask;
          const g = (a: number, b: number, c: number) => grid[(a * n + b) * n + c];
          const v =
            (1 - fx) * ((1 - fy) * ((1 - fz) * g(x0, y0, z0) + fz * g(x0, y0, z1)) + fy * ((1 - fz) * g(x0, y1, z0) + fz * g(x0, y1, z1))) +
            fx * ((1 - fy) * ((1 - fz) * g(x1, y0, z0) + fz * g(x1, y0, z1)) + fy * ((1 - fz) * g(x1, y1, z0) + fz * g(x1, y1, z1)));
          out[p * stride + comp] = v;
        }
      }
    }
  };

  // Zel'dovich displacement Ψ1 = i k δ / k².
  const comps: Array<(kx: number, ky: number, kz: number) => number> = [(x) => x, (_x, y) => y, (_x, _y, z) => z];
  let psiVar = 0;
  for (let c = 0; c < 3; c++) {
    const kc = comps[c];
    field.realise(fft, A, (kx, ky, kz, k2, r) => {
      r.r = 0;
      r.i = kc(kx, ky, kz) / k2;
    });
    sample(A, psi1, c, 3);
    for (let i = 0; i < N3; i++) psiVar += A[i] * A[i];
    prog(0.1 + 0.1 * c, 'Zel’dovich displacements');
  }
  const psiRms = Math.sqrt(psiVar / (3 * N3));

  // Smoothed linear density at the Lagrangian sites (for biased galaxy formation).
  const R = opts.smoothing ?? 1.5 * cell;
  field.realise(fft, A, (_kx, _ky, _kz, k2, r) => {
    r.r = Math.exp(-0.5 * k2 * R * R);
    r.i = 0;
  });
  let dv = 0;
  for (let i = 0; i < N3; i++) dv += A[i] * A[i];
  const sigmaL = Math.sqrt(dv / N3);
  sample(A, deltaL, 0, 1);
  prog(0.45, 'Density peaks');

  if (opts.secondOrder !== false) {
    // S2 = φxx φyy + φxx φzz + φyy φzz − φxy² − φxz² − φyz²  (φ,ij = k_i k_j δ / k²)
    field.realise(fft, A, (kx, _ky, _kz, k2, r) => {
      r.r = (kx * kx) / k2;
      r.i = 0;
    });
    field.realise(fft, B, (_kx, ky, _kz, k2, r) => {
      r.r = (ky * ky) / k2;
      r.i = 0;
    });
    for (let i = 0; i < N3; i++) {
      S[i] = A[i] * B[i];
      A[i] += B[i];
    }
    field.realise(fft, B, (_kx, _ky, kz, k2, r) => {
      r.r = (kz * kz) / k2;
      r.i = 0;
    });
    for (let i = 0; i < N3; i++) S[i] += A[i] * B[i];
    prog(0.6, 'Second-order LPT');
    const off: Array<(kx: number, ky: number, kz: number) => number> = [(x, y) => x * y, (x, _y, z) => x * z, (_x, y, z) => y * z];
    for (const f of off) {
      field.realise(fft, B, (kx, ky, kz, k2, r) => {
        r.r = f(kx, ky, kz) / k2;
        r.i = 0;
      });
      for (let i = 0; i < N3; i++) S[i] -= B[i] * B[i];
    }
    prog(0.75, 'Second-order LPT');
    // Ψ2 = ∇φ2, φ2(k) = −S2(k)/k²  →  Ψ2(k) = −i k S2(k)/k²
    fft.forward(S);
    const sre = Float64Array.from(fft.re), sim = Float64Array.from(fft.im);
    const kf = field.kf, half = n >> 1, nzc = fft.nzc;
    for (let c = 0; c < 3; c++) {
      for (let ix = 0; ix < n; ix++) {
        const fx = ix < half ? ix : ix - n;
        for (let iy = 0; iy < n; iy++) {
          const fy = iy < half ? iy : iy - n;
          for (let iz = 0; iz < nzc; iz++) {
            const idx = (ix * n + iy) * nzc + iz;
            const q = fx * fx + fy * fy + iz * iz;
            if (q === 0 || ix === half || iy === half || iz === half) {
              fft.re[idx] = 0;
              fft.im[idx] = 0;
              continue;
            }
            const kc = (c === 0 ? fx : c === 1 ? fy : iz) * kf;
            const k2 = q * kf * kf;
            // (sre + i sim) · (−i kc/k²) = (sim·kc/k²) + i(−sre·kc/k²)
            fft.re[idx] = (sim[idx] * kc) / k2;
            fft.im[idx] = (-sre[idx] * kc) / k2;
          }
        }
      }
      fft.inverse(A);
      sample(A, psi2, c, 3);
      prog(0.8 + 0.06 * c, 'Second-order LPT');
    }
  }
  return { np, psi1, psi2, deltaL, sigmaL, psiRms };
}
