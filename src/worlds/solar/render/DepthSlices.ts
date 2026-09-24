/**
 * Depth partitioning for scenes spanning 10⁻⁹ … 10⁵ AU (a 24-bit depth buffer resolves ~10⁴).
 * Resolved bodies contribute [d − R, d + R] intervals; overlapping intervals merge into clusters that
 * share one depth range (so rings, moons and planets depth-test correctly against each other).
 * The gaps between clusters become "filler" slices holding only lines and points. Slices are
 * drawn far → near with the depth buffer cleared in between; the rasteriser's near/far clipping
 * hands every fragment of a long line or orbit to exactly one slice.
 */
export interface Slice {
  near: number;
  far: number;
  /** True when the slice contains resolved bodies (depth precision matters). */
  solid: boolean;
}

const MAX_SOLID_RATIO = 2.0e4;
const MAX_FILL_RATIO = 1.0e7;

export class DepthSlicer {
  private iv: Array<[number, number]> = [];
  private ivN = 0;
  readonly slices: Slice[] = [];
  private pool: Slice[] = [];

  begin(): void {
    this.ivN = 0;
  }

  /** Add a solid interval at camera distance `d` with bounding radius `r` (same units). */
  add(d: number, r: number, minNear: number): void {
    let n = d - r;
    const f = d + r;
    if (n < minNear) n = minNear;
    if (f <= n) return;
    if (this.ivN >= this.iv.length) this.iv.push([0, 0]);
    const s = this.iv[this.ivN++];
    s[0] = n;
    s[1] = f;
  }

  private push(near: number, far: number, solid: boolean): void {
    const i = this.slices.length;
    const s = this.pool[i] ?? (this.pool[i] = { near: 0, far: 0, solid: false });
    s.near = near;
    s.far = far;
    s.solid = solid;
    this.slices.push(s);
  }

  /** Split [near, far] into far→near sub-slices with a bounded far/near ratio. */
  private range(near: number, far: number, ratio: number, solid: boolean): void {
    if (far <= near) return;
    const n = Math.max(1, Math.ceil(Math.log(far / near) / Math.log(ratio)));
    const step = Math.pow(far / near, 1 / n);
    let f = far;
    for (let k = 0; k < n; k++) {
      const nn = k === n - 1 ? near : f / step;
      // Overlap slightly so no fragment falls between slices.
      this.push(nn * (k === n - 1 ? 1 : 0.9999), f, solid);
      f = nn;
    }
  }

  /** Build slices (far → near) between `minNear` and `maxFar` (fill = also cover the gaps). Allocation-free. */
  build(minNear: number, maxFar: number, fill = false): Slice[] {
    this.slices.length = 0;
    const iv = this.iv;
    const n = this.ivN;
    // Insertion sort by far edge, descending (n is small).
    for (let i = 1; i < n; i++) {
      const x = iv[i];
      let j = i - 1;
      while (j >= 0 && iv[j][1] < x[1]) {
        iv[j + 1] = iv[j];
        j--;
      }
      iv[j + 1] = x;
    }
    // Merge overlapping (or nearly touching) intervals in place.
    let m = 0;
    for (let i = 0; i < n; i++) {
      const cur = iv[i];
      if (m > 0 && cur[1] >= iv[m - 1][0] * 0.8) {
        iv[m - 1][0] = Math.min(iv[m - 1][0], cur[0]);
      } else {
        const tmp = iv[m];
        iv[m] = cur;
        iv[i] = tmp;
        m++;
      }
    }
    let cursor = maxFar;
    for (let i = 0; i < m; i++) {
      const f = Math.min(iv[i][1] * 1.001, cursor);
      const nn = Math.max(iv[i][0] * 0.999, minNear);
      if (f <= nn) continue;
      if (fill && cursor > f) this.range(f, cursor, MAX_FILL_RATIO, false);
      this.range(nn, f, MAX_SOLID_RATIO, true);
      cursor = nn;
    }
    if (fill && cursor > minNear) this.range(minNear, cursor, MAX_FILL_RATIO, false);
    return this.slices;
  }
}
