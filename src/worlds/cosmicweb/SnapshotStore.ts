/**
 * Keyframe history of a simulation run, kept compactly so the timeline can be scrubbed.
 *
 * Positions are 16-bit box fractions (6 bytes per particle). Every IFRAME-th keyframe is
 * stored whole ("I-frame"); the others store int8 deltas from the previously *decoded* frame in
 * units of Q = 8 (1/8192 of the box), i.e. 3 bytes per particle. Encoding against the decoded
 * reference (closed loop, as in video codecs) keeps the error bounded by Q/2 at every frame.
 * Particles that moved further than 127·Q go to a small exception list.
 *
 * The encoding runs where the simulation runs (the Web Worker, see KeyframeEncoder), so a new
 * keyframe costs the main thread nothing; decoding the next keyframe can be spread over several
 * frames ahead of time (prefetch), so crossing a keyframe during playback does not stall a frame.
 */
import type { EncodedPositions, GalaxyCatalog, HaloCatalog, Keyframe, KeyframeStats, PowerSpectrumSample } from './types';

const Q = 8;
const IFRAME = 8;

/** Closed-loop delta encoder for a stream of keyframes (one per run, frames in order). */
export class KeyframeEncoder {
  private lastDecoded: Uint16Array | null = null;
  private frames = 0;

  encode(pos: Uint16Array): EncodedPositions {
    const out: EncodedPositions = { full: null, delta: null, excIdx: null, excVal: null };
    const ref = this.lastDecoded;
    if (!ref || this.frames % IFRAME === 0) {
      out.full = pos;
      this.lastDecoded = pos.slice();
    } else {
      const n3 = pos.length;
      const delta = new Int8Array(n3);
      let exc: number[] | null = null;
      const dec = ref; // updated in place into the new decoded frame
      for (let i = 0; i < n3; i++) {
        // shortest periodic difference in 16-bit arithmetic
        let d = (pos[i] - dec[i]) | 0;
        if (d > 32767) d -= 65536;
        else if (d < -32768) d += 65536;
        const q = Math.round(d / Q);
        if (q > 127 || q < -127) {
          (exc ??= []).push((i / 3) | 0);
          delta[i] = 0;
          dec[i] = pos[i];
        } else {
          delta[i] = q;
          dec[i] = (dec[i] + q * Q) & 0xffff;
        }
      }
      if (exc) {
        // de-duplicate particle indices; store all three components exactly
        const uniq = Array.from(new Set(exc));
        out.excIdx = Uint32Array.from(uniq);
        out.excVal = new Uint16Array(uniq.length * 3);
        for (let j = 0; j < uniq.length; j++) {
          const p = uniq[j];
          for (let c = 0; c < 3; c++) {
            out.excVal[3 * j + c] = pos[3 * p + c];
            dec[3 * p + c] = pos[3 * p + c];
          }
        }
      }
      out.delta = delta;
    }
    this.frames++;
    return out;
  }
}

/** Transferable buffers of an encoded frame (for postMessage). */
export function encodedTransferables(e: EncodedPositions): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const a of [e.full, e.delta, e.excIdx, e.excVal]) if (a) out.push(a.buffer as ArrayBuffer);
  return out;
}

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
  /** Encoder for frames that arrive un-encoded (main-thread fallback, tests). */
  private encoder: KeyframeEncoder | null = null;
  /** Incremental decode in progress (see prefetch). */
  private job: { index: number; src: Uint16Array; out: Uint16Array; i: number } | null = null;
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

  /** Store a keyframe (takes ownership of its buffers). Pre-encoded frames cost nothing here. */
  add(k: Keyframe): StoredFrame {
    let enc = k.enc;
    if (!enc) {
      if (!k.positions) throw new Error('Keyframe without positions');
      enc = (this.encoder ??= new KeyframeEncoder()).encode(k.positions);
    }
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
      full: enc.full,
      delta: enc.delta,
      excIdx: enc.excIdx,
      excVal: enc.excVal,
    };
    if (!base.full && !base.delta) throw new Error('Keyframe without positions');
    for (const a of [enc.full, enc.delta, enc.excIdx, enc.excVal]) if (a) this.bytes += a.byteLength;
    this.frames.push(base);
    return base;
  }

  /** Is keyframe `index` decoded and cached (positions() returns immediately)? */
  isDecoded(index: number): boolean {
    return this.cache.has(index);
  }

  /**
   * Decode keyframe `index` a slice at a time — at most `budget` values per call — from the cached
   * decode of `index − 1`. Call once per frame while playing towards it; returns true once
   * positions(index) is a cache hit. Does nothing (false) if the previous frame is not cached.
   */
  prefetch(index: number, budget: number): boolean {
    if (index < 0 || index >= this.frames.length) return false;
    if (this.cache.has(index)) return true;
    let job = this.job;
    if (!job || job.index !== index) {
      const fr = this.frames[index];
      if (fr.full) {
        this.put(index, fr.full.slice());
        return true;
      }
      const src = this.cache.get(index - 1);
      if (!src) return false;
      job = this.job = { index, src, out: new Uint16Array(src.length), i: 0 };
    }
    const d = this.frames[index].delta!;
    const { src, out } = job;
    const end = Math.min(d.length, job.i + budget);
    for (let i = job.i; i < end; i++) out[i] = (src[i] + d[i] * Q) & 0xffff;
    job.i = end;
    if (end < d.length) return false;
    const fr = this.frames[index];
    if (fr.excIdx) {
      const idx = fr.excIdx, val = fr.excVal!;
      for (let j = 0; j < idx.length; j++) {
        const p = idx[j];
        out[3 * p] = val[3 * j];
        out[3 * p + 1] = val[3 * j + 1];
        out[3 * p + 2] = val[3 * j + 2];
      }
    }
    this.job = null;
    this.put(index, out);
    return true;
  }

  /** Decoded positions of keyframe `index` (cached; do not modify). */
  positions(index: number): Uint16Array {
    const hit = this.cache.get(index);
    if (hit) {
      this.touch(index);
      return hit;
    }
    if (this.job && this.job.index === index) this.job = null;
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
    this.encoder = null;
    this.job = null;
    this.bytes = 0;
  }
}
