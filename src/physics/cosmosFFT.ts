/**
 * Fast Fourier transforms for the cosmic-web simulation (module: cosmos).
 *
 * Iterative radix-2 Cooley–Tukey on split real/imaginary Float64Arrays.
 *   forward:  X[k] = Σ_j x[j] · exp(−2πi·jk/n)      (unnormalised)
 *   inverse:  x[j] = (1/n) Σ_k X[k] · exp(+2πi·jk/n)
 *
 * 3D real-to-complex layout (n³ real grid, n a power of two):
 *   real     r[(x·n + y)·n + z]
 *   complex  c[(kx·n + ky)·nzc + kz],  nzc = n/2 + 1, kz ∈ [0, n/2]
 * The kz < 0 half follows from Hermitian symmetry F(−k) = F(k)*.
 *
 * The z (contiguous) axis is done two real lines at a time packed into one complex FFT
 * ("two for the price of one"); the y and x axes are done as *column* transforms whose
 * butterflies sweep whole contiguous rows, which keeps memory access sequential.
 */

export function isPowerOfTwo(n: number): boolean {
  return n >= 1 && (n & (n - 1)) === 0;
}

export class FFT {
  readonly n: number;
  private readonly rev: Uint32Array;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly bits: number;

  constructor(n: number) {
    if (!isPowerOfTwo(n)) throw new Error(`FFT size must be a power of two (got ${n})`);
    this.n = n;
    this.bits = Math.round(Math.log2(n));
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < this.bits; b++) r |= ((i >> b) & 1) << (this.bits - 1 - b);
      this.rev[i] = r;
    }
    const h = Math.max(1, n >> 1);
    this.cos = new Float64Array(h);
    this.sin = new Float64Array(h);
    for (let k = 0; k < h; k++) {
      this.cos[k] = Math.cos((2 * Math.PI * k) / n);
      this.sin[k] = Math.sin((2 * Math.PI * k) / n);
    }
  }

  /** In-place transform of the contiguous line re/im[offset … offset+n). sign −1 = forward. */
  line(re: Float64Array, im: Float64Array, offset: number, sign: -1 | 1): void {
    const n = this.n;
    if (n === 1) return;
    const rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        const a = offset + i, b = offset + j;
        let t = re[a]; re[a] = re[b]; re[b] = t;
        t = im[a]; im[a] = im[b]; im[b] = t;
      }
    }
    // Stage 1 (size 2): twiddle = 1.
    for (let a = offset; a < offset + n; a += 2) {
      const br = re[a + 1], bi = im[a + 1];
      re[a + 1] = re[a] - br; im[a + 1] = im[a] - bi;
      re[a] += br; im[a] += bi;
    }
    const cos = this.cos, sin = this.sin;
    for (let size = 4; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = offset; start < offset + n; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = cos[k * step], wi = sign * sin[k * step];
          const a = start + k, b = a + half;
          const br = re[b], bi = im[b];
          const xr = br * wr - bi * wi;
          const xi = br * wi + bi * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  }

  /**
   * In-place transform along the "row" index of n rows of length rowLen starting at base:
   * element (row r, column j) lives at base + r·rowLen + j. Every column is transformed.
   */
  columns(re: Float64Array, im: Float64Array, base: number, rowLen: number, sign: -1 | 1): void {
    const n = this.n;
    if (n === 1) return;
    const rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        const a = base + i * rowLen, b = base + j * rowLen;
        for (let c = 0; c < rowLen; c++) {
          let t = re[a + c]; re[a + c] = re[b + c]; re[b + c] = t;
          t = im[a + c]; im[a + c] = im[b + c]; im[b + c] = t;
        }
      }
    }
    const cos = this.cos, sin = this.sin;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const ra = base + (start + k) * rowLen;
          const rb = ra + half * rowLen;
          if (k === 0) {
            for (let c = 0; c < rowLen; c++) {
              const br = re[rb + c], bi = im[rb + c], ar = re[ra + c], ai = im[ra + c];
              re[rb + c] = ar - br; im[rb + c] = ai - bi;
              re[ra + c] = ar + br; im[ra + c] = ai + bi;
            }
          } else {
            const wr = cos[k * step], wi = sign * sin[k * step];
            for (let c = 0; c < rowLen; c++) {
              const br = re[rb + c], bi = im[rb + c];
              const xr = br * wr - bi * wi;
              const xi = br * wi + bi * wr;
              const ar = re[ra + c], ai = im[ra + c];
              re[rb + c] = ar - xr; im[rb + c] = ai - xi;
              re[ra + c] = ar + xr; im[ra + c] = ai + xi;
            }
          }
        }
      }
    }
  }
}

/** 1D complex transform convenience (allocates nothing but the plan cache). */
const plans = new Map<number, FFT>();
export function fftPlan(n: number): FFT {
  let p = plans.get(n);
  if (!p) {
    p = new FFT(n);
    plans.set(n, p);
  }
  return p;
}

export function fft1d(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  fftPlan(n).line(re, im, 0, inverse ? 1 : -1);
  if (inverse) {
    const s = 1 / n;
    for (let i = 0; i < n; i++) {
      re[i] *= s;
      im[i] *= s;
    }
  }
}

/** In-place 3D complex transform of an n³ grid, index (x·n + y)·n + z. */
export function fft3dComplex(re: Float64Array, im: Float64Array, n: number, inverse = false): void {
  const f = fftPlan(n);
  const sign = inverse ? 1 : -1;
  const n2 = n * n;
  for (let l = 0; l < n2; l++) f.line(re, im, l * n, sign);
  for (let x = 0; x < n; x++) f.columns(re, im, x * n2, n, sign);
  f.columns(re, im, 0, n2, sign);
  if (inverse) {
    const s = 1 / (n2 * n);
    for (let i = 0; i < re.length; i++) {
      re[i] *= s;
      im[i] *= s;
    }
  }
}

/**
 * Real-to-complex / complex-to-real 3D transforms on an n³ periodic grid with reusable
 * scratch memory. Holds its own complex spectrum buffers (re, im) of n·n·(n/2+1).
 */
export class RealFFT3D {
  readonly n: number;
  readonly nzc: number;
  /** Spectrum (real and imaginary parts), layout (kx·n + ky)·nzc + kz. */
  readonly re: Float64Array;
  readonly im: Float64Array;
  private readonly plan: FFT;
  private readonly lre: Float64Array;
  private readonly lim: Float64Array;

  constructor(n: number) {
    if (!isPowerOfTwo(n) || n < 2) throw new Error(`RealFFT3D size must be a power of two ≥ 2 (got ${n})`);
    this.n = n;
    this.nzc = (n >> 1) + 1;
    this.re = new Float64Array(n * n * this.nzc);
    this.im = new Float64Array(n * n * this.nzc);
    this.plan = fftPlan(n);
    this.lre = new Float64Array(n);
    this.lim = new Float64Array(n);
  }

  /** Signed integer frequency for index i ∈ [0, n): 0 … n/2−1, −n/2 … −1. */
  freq(i: number): number {
    return i < this.n >> 1 ? i : i - this.n;
  }

  /** Forward transform of a real grid into this.re/this.im (unnormalised). */
  forward(input: ArrayLike<number>): void {
    const n = this.n, nzc = this.nzc, half = n >> 1, mask = n - 1;
    const lre = this.lre, lim = this.lim, re = this.re, im = this.im, plan = this.plan;
    for (let x = 0; x < n; x++) {
      for (let y = 0; y < n; y += 2) {
        const i1 = (x * n + y) * n;
        const i2 = i1 + n;
        for (let j = 0; j < n; j++) {
          lre[j] = input[i1 + j];
          lim[j] = input[i2 + j];
        }
        plan.line(lre, lim, 0, -1);
        const o1 = (x * n + y) * nzc;
        const o2 = o1 + nzc;
        for (let k = 0; k <= half; k++) {
          const kr = (n - k) & mask;
          const zr = lre[k], zi = lim[k];
          const cr = lre[kr], ci = -lim[kr];
          re[o1 + k] = 0.5 * (zr + cr);
          im[o1 + k] = 0.5 * (zi + ci);
          re[o2 + k] = 0.5 * (zi - ci);
          im[o2 + k] = -0.5 * (zr - cr);
        }
      }
    }
    const slab = n * nzc;
    for (let x = 0; x < n; x++) plan.columns(re, im, x * slab, nzc, -1);
    plan.columns(re, im, 0, slab, -1);
  }

  /**
   * Inverse transform of this.re/this.im (destroyed) into a real grid, normalised by 1/n³.
   * The spectrum must be Hermitian on the kz = 0 and kz = n/2 planes (true for any real field
   * multiplied by an even kernel, or by an odd one with the Nyquist planes zeroed).
   */
  inverse(output: { [i: number]: number; length: number }, scale = 1): void {
    const n = this.n, nzc = this.nzc, half = n >> 1;
    const lre = this.lre, lim = this.lim, re = this.re, im = this.im, plan = this.plan;
    const slab = n * nzc;
    plan.columns(re, im, 0, slab, 1);
    for (let x = 0; x < n; x++) plan.columns(re, im, x * slab, nzc, 1);
    const s = scale / (n * n * n);
    for (let x = 0; x < n; x++) {
      for (let y = 0; y < n; y += 2) {
        const o1 = (x * n + y) * nzc;
        const o2 = o1 + nzc;
        for (let k = 0; k <= half; k++) {
          // Z = F1 + i F2
          lre[k] = re[o1 + k] - im[o2 + k];
          lim[k] = im[o1 + k] + re[o2 + k];
        }
        for (let k = half + 1; k < n; k++) {
          const kk = n - k;
          // F(k) = conj F(n−k):  Z = conj F1 + i conj F2
          const f1r = re[o1 + kk], f1i = -im[o1 + kk];
          const f2r = re[o2 + kk], f2i = -im[o2 + kk];
          lre[k] = f1r - f2i;
          lim[k] = f1i + f2r;
        }
        plan.line(lre, lim, 0, 1);
        const i1 = (x * n + y) * n;
        const i2 = i1 + n;
        for (let j = 0; j < n; j++) {
          output[i1 + j] = lre[j] * s;
          output[i2 + j] = lim[j] * s;
        }
      }
    }
  }
}
