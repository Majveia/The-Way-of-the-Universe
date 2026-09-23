/**
 * Keyframe history of a simulation run, kept compactly so the timeline can be scrubbed.
 *
 * Positions arrive as 16-bit box fractions (6 bytes per particle). Every IFRAME-th keyframe is
 * stored whole ("I-frame"); the others store int8 deltas from the previously *decoded* frame in
 * units of Q = 8 (1/8192 of the box), i.e. 3 bytes per particle. Encoding against the decoded
 * reference (closed loop, as in video codecs) keeps the error bounded by Q/2 at every frame.
 * Particles that moved further than 127·Q go to a small exception list.
 */
import type { GalaxyCatalog, HaloCatalog, Keyframe, KeyframeStats, PowerSpectrumSample } from './types';

const Q = 8;
const IFRAME = 8;

export interface StoredFrame {
  index: number;
  step: number;
  t: number;
  a: number;
  D: number;
  halos: HaloCatalog;
  galaxies: GalaxyCatalog;
  pk: PowerSpectrumSample | null;
  stats: KeyframeStats;
  /** Full frame (I) or int8 delta (P) against frame index − 1. */
  full: Uint16Array | null;
  delta: Int8Array | null;
  excIdx: Uint32Array | null;
  excVal: Uint16Array | null;
}

export class SnapshotStore {
  readonly frames: StoredFrame[] = [];
  readonly count: number;
  /** Most recently decoded frames (index → positions). */
  private cache = new Map<number, Uint16Array>();
  private cacheOrder: number[] = [];
  private readonly cacheSize = 4;
  /** Decoded copy of the last stored frame (the reference for the next P-frame). */
  private lastDecoded: Uint16Array | null = null;
  bytes = 0;

  constructor(count: number) {
    this.count = count;
  }

  get length(): number {
    return this.frames.length;
  }

  last(): StoredFrame | null {
    return this.frames.length ? this.frames[this.frames.length - 1] : null;
  }

  /** Store a keyframe (takes ownership of its positions buffer). */
  add(k: Keyframe): StoredFrame {
    const n3 = this.count * 3;
    const base: StoredFrame = {
      index: k.index,
      step: k.step,
      t: k.t,
      a: k.a,
      D: k.D,
      halos: k.halos,
      galaxies: k.galaxies,
      pk: k.pk,
      stats: k.stats,
      full: null,
      delta: null,
      excIdx: null,
      excVal: null,
    };
    const pos = k.positions;
    const ref = this.lastDecoded;
    if (!ref || this.frames.length % IFRAME === 0) {
      base.full = pos;
      this.bytes += pos.byteLength;
      this.lastDecoded = pos.slice();
    } else {
      const delta = new Int8Array(n3);
      const exc: number[] = [];
      const dec = ref; // updated in place into the new decoded frame
      for (let i = 0; i < n3; i++) {
        // shortest periodic difference in 16-bit arithmetic
        let d = (pos[i] - dec[i]) | 0;
        if (d > 32767) d -= 65536;
        else if (d < -32768) d += 65536;
        const q = Math.round(d / Q);
        if (q > 127 || q < -127) {
          exc.push(Math.floor(i / 3));
          delta[i] = 0;
          dec[i] = pos[i];
        } else {
          delta[i] = q;
          dec[i] = (dec[i] + q * Q) & 0xffff;
        }
      }
      if (exc.length) {
        // de-duplicate particle indices; store all three components exactly
        const uniq = Array.from(new Set(exc));
        base.excIdx = Uint32Array.from(uniq);
        base.excVal = new Uint16Array(uniq.length * 3);
        uniq.forEach((p, j) => {
          for (let c = 0; c < 3; c++) {
            base.excVal![3 * j + c] = pos[3 * p + c];
            dec[3 * p + c] = pos[3 * p + c];
          }
        });
        this.bytes += base.excIdx.byteLength + base.excVal.byteLength;
      }
      base.delta = delta;
      this.bytes += delta.byteLength;
    }
    this.frames.push(base);
    return base;
  }

  /** Decoded positions of keyframe `index` (cached; do not modify). */
  positions(index: number): Uint16Array {
    const hit = this.cache.get(index);
    if (hit) {
      this.touch(index);
      return hit;
    }
    // Find the nearest decodable start: a cached frame or the preceding I-frame.
    let start = index;
    while (start > 0 && !this.frames[start].full && !this.cache.has(start - 1)) start--;
    let cur: Uint16Array;
    let from: number;
    if (this.frames[start].full) {
      cur = this.frames[start].full!.slice();
      from = start + 1;
    } else {
      cur = this.cache.get(start - 1)!.slice();
      from = start;
    }
    for (let f = from; f <= index; f++) this.applyDelta(cur, this.frames[f]);
    this.put(index, cur);
    return cur;
  }

  private applyDelta(cur: Uint16Array, fr: StoredFrame): void {
    if (fr.full) {
      cur.set(fr.full);
      return;
    }
    const d = fr.delta!;
    const n = d.length;
    for (let i = 0; i < n; i++) cur[i] = (cur[i] + d[i] * Q) & 0xffff;
    if (fr.excIdx) {
      const idx = fr.excIdx, val = fr.excVal!;
      for (let j = 0; j < idx.length; j++) {
        const p = idx[j];
        cur[3 * p] = val[3 * j];
        cur[3 * p + 1] = val[3 * j + 1];
        cur[3 * p + 2] = val[3 * j + 2];
      }
    }
  }

  private touch(index: number): void {
    const i = this.cacheOrder.indexOf(index);
    if (i >= 0) this.cacheOrder.splice(i, 1);
    this.cacheOrder.push(index);
  }

  private put(index: number, v: Uint16Array): void {
    this.cache.set(index, v);
    this.touch(index);
    while (this.cacheOrder.length > this.cacheSize) {
      const old = this.cacheOrder.shift()!;
      this.cache.delete(old);
    }
  }

  /** Index of the last keyframe with t ≤ time (−1 if none). */
  frameAt(t: number): number {
    const f = this.frames;
    if (!f.length || t < f[0].t) return -1;
    let lo = 0, hi = f.length - 1;
    if (t >= f[hi].t) return hi;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (f[m].t <= t) lo = m;
      else hi = m;
    }
    return lo;
  }

  clear(): void {
    this.frames.length = 0;
    this.cache.clear();
    this.cacheOrder = [];
    this.lastDecoded = null;
    this.bytes = 0;
  }
}
