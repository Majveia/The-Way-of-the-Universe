/**
 * Depth-slice planning for the close-up (pure functions, no rendering).
 *
 * The close-up spans 10⁻³ to 10⁷ planet radii, far beyond one 24-bit depth buffer, so bodies are
 * drawn far → near in "slices", each with its own near/far planes and a depth clear between them.
 * But every `renderer.render()` into the multisampled HDR target ends with a full-screen MSAA
 * resolve blit (≈ 80 MB of traffic per pass at 1080p with 4× RGBA16F), so slices are not free:
 * bodies whose depth ranges fit in one buffer (the planet and its moons, typically) share a slice.
 * Sharing is also *more* correct when their depth intervals overlap: separate slices sorted by
 * distance cannot interleave two bodies, one depth buffer can.
 *
 * Near planes: a body's bounding sphere gives near = z − R, useless once the camera is inside it
 * (low orbit: z − R < 0 → near ≈ 10⁻⁶ and the depth buffer collapses; a 10 km ice shell then
 * z-fights with the ground). The distance to the nearest actual geometry (spherical shells, the
 * ring annulus) bounds the view depth of anything inside the frustum from below, via the cosine of
 * the frustum's widest corner ray.
 */

/** Depth-buffer dynamic range allowed in one slice (far / near). 24-bit depth keeps ≈ 10⁻³
 * relative precision at the far end for 2·10⁴ (Δz/z ≈ (far/near)·2⁻²⁴). */
export const MAX_SLICE_RATIO = 2e4;

export interface SliceItem {
  /** View-space depth interval of the body's bounding volume (near may be refined, see below). */
  near: number;
  far: number;
  /** Distance of the body's centre from the camera (painter's order). */
  dist: number;
  /** Never shares a slice (stars: their glare quads ignore depth and rely on slice order). */
  solo: boolean;
  /** Output: slice index, 0 = drawn first (farthest). */
  slice: number;
}

/**
 * Assign slices to items that are already sorted far → near (by `dist`, descending). Consecutive
 * non-solo items share a slice while the merged far/near stays within `maxRatio`.
 * Returns the number of slices, and each slice's merged [near, far] in `ranges` (2 per slice).
 */
export function planSlices(items: SliceItem[], ranges: number[], maxRatio = MAX_SLICE_RATIO): number {
  ranges.length = 0;
  let n = 0;
  let prevSolo = true;
  for (const it of items) {
    if (n > 0 && !it.solo && !prevSolo) {
      const k = (n - 1) * 2;
      const lo = Math.min(ranges[k], it.near);
      const hi = Math.max(ranges[k + 1], it.far);
      if (hi / lo <= maxRatio) {
        ranges[k] = lo;
        ranges[k + 1] = hi;
        it.slice = n - 1;
        continue;
      }
    }
    ranges.push(it.near, it.far);
    it.slice = n++;
    prevSolo = it.solo;
  }
  return n;
}

/**
 * Distance from a point at radius `d` to a shell whose surface lies between radii `lo` and `hi`
 * (an ellipsoidal proxy, a sphere): 0 if the point may touch it.
 */
export function shellDistance(d: number, lo: number, hi: number): number {
  return d > hi ? d - hi : d < lo ? lo - d : 0;
}

/**
 * Distance from a point (x, y, z) — in the ring's frame, ring in the y = 0 plane — to a flat annulus
 * [inner, outer] about the origin.
 */
export function ringDistance(x: number, y: number, z: number, inner: number, outer: number): number {
  const rho = Math.hypot(x, z);
  const dr = rho < inner ? inner - rho : rho > outer ? rho - outer : 0;
  return Math.hypot(dr, y);
}

/**
 * Smallest cosine between the view axis and the four corner rays of a perspective frustum, from
 * the projection matrix elements (column-major, three.js): handles view offsets (P[8], P[9] ≠ 0).
 * Any point inside the frustum at distance r has view depth ≥ r · cornerCos.
 */
export function cornerCos(p: ArrayLike<number>): number {
  let c = 1;
  for (let sx = -1; sx <= 1; sx += 2) {
    for (let sy = -1; sy <= 1; sy += 2) {
      const x = (sx + p[8]) / p[0];
      const y = (sy + p[9]) / p[5];
      c = Math.min(c, 1 / Math.sqrt(1 + x * x + y * y));
    }
  }
  return c;
}
