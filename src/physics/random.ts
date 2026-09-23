/**
 * Deterministic, seedable randomness. Every procedural thing in the universe derives
 * from a seed so the same seed always yields the same galaxy, star or world.
 */

/** 53-bit string hash (cyrb53). */
export function hashString(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Integer hash of up to four integers → uint32. */
export function hashInts(a: number, b = 0, c = 0, d = 0): number {
  let h = 0x9e3779b9 ^ Math.imul(a | 0, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) ^ Math.imul(b | 0, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) ^ Math.imul(c | 0, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) ^ Math.imul(d | 0, 0x165667b1);
  h ^= h >>> 15;
  return h >>> 0;
}

/** Uniform [0,1) from integer coordinates (stateless). */
export function hash01(a: number, b = 0, c = 0, d = 0): number {
  return hashInts(a, b, c, d) / 4294967296;
}

/** Small fast counter PRNG (sfc32) with helpers. */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  private spare: number | null = null;
  /** The numeric seed this generator was created from. */
  readonly seed: number;

  constructor(seed: number | string = 1) {
    const s = typeof seed === 'string' ? hashString(seed) : seed;
    this.seed = s;
    // splitmix32 to expand the seed into 128 bits of state
    let x = (s >>> 0) ^ Math.floor(s / 4294967296);
    const sm = () => {
      x = (x + 0x9e3779b9) | 0;
      let z = x;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.a = sm();
    this.b = sm();
    this.c = sm();
    this.d = sm();
    for (let i = 0; i < 12; i++) this.u32();
  }

  u32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }
  /** Uniform [0,1). */
  next(): number {
    return this.u32() / 4294967296;
  }
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)];
  }
  /** Standard normal via Marsaglia polar method. */
  normal(mean = 0, sd = 1): number {
    if (this.spare !== null) {
      const s = this.spare;
      this.spare = null;
      return mean + sd * s;
    }
    let u: number, v: number, s: number;
    do {
      u = this.next() * 2 - 1;
      v = this.next() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const m = Math.sqrt((-2 * Math.log(s)) / s);
    this.spare = v * m;
    return mean + sd * u * m;
  }
  /** Log-uniform in [lo, hi). */
  logRange(lo: number, hi: number): number {
    return Math.exp(this.range(Math.log(lo), Math.log(hi)));
  }
  /** Power-law sample p(x) ∝ x^alpha on [lo, hi]. */
  powerLaw(alpha: number, lo: number, hi: number): number {
    const u = this.next();
    if (Math.abs(alpha + 1) < 1e-9) return lo * Math.pow(hi / lo, u);
    const a1 = alpha + 1;
    return Math.pow(Math.pow(lo, a1) + u * (Math.pow(hi, a1) - Math.pow(lo, a1)), 1 / a1);
  }
  /** Exponential with given mean. */
  exponential(mean: number): number {
    return -mean * Math.log(1 - this.next());
  }
  /** Uniform point on the unit sphere. */
  onSphere(out: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 }) {
    const z = this.next() * 2 - 1;
    const t = this.next() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    out.x = r * Math.cos(t);
    out.y = r * Math.sin(t);
    out.z = z;
    return out;
  }
  /**
   * Deterministic child generator derived from this generator's seed only (not its
   * current state), so rng.fork('planet', 3) is stable regardless of call order.
   */
  fork(label: string | number, index = 0): Rng {
    const l = typeof label === 'string' ? hashString(label) : label;
    return new Rng(hashInts(this.seed >>> 0, Math.floor(this.seed / 4294967296), l >>> 0, index));
  }
}
