import { visualEfficacyFit } from '../../physics/galaxyStars';
import { hash3u, hash4u, next, u01 } from './hash';
import type { GalaxyParams } from './params';

/**
 * The local star field: individual stars around the viewer, generated procedurally and
 * deterministically from the galaxy's own stellar density, bit-identical on the CPU (here) and the
 * GPU (LOCAL_STAR_GLSL) so that `nearestStars` returns exactly the stars that are drawn.
 *
 * Stars live in cubic cells of a fixed world grid (model frame, pc), one grid per luminosity tier.
 * A tier's number density is the solar-neighbourhood value (the local luminosity function; Reid &
 * Hawley 2005, Bahcall & Soneira 1980) scaled by the galaxy's luminosity density relative to the
 * Milky Way at the Sun. Each cell holds floor(n·C³ + u) stars (a dithered Poisson draw).
 *
 *   tier  L (L☉)      n⊙ (pc⁻³)    β    ⟨L⟩   cell   drawn to   what
 *   0     100–10⁵     1.5 × 10⁻⁵  2.5   300    160    900 pc     K/M giants, B stars
 *   1     10–100      4 × 10⁻⁴    2.0    26     64    320 pc     red clump, A stars
 *   2     1–10        5 × 10⁻³    1.8   2.8     24    110 pc     F/G dwarfs, subgiants
 *   3     0.1–1       2 × 10⁻²    1.5   0.4     12     40 pc     G/K dwarfs
 *   4     0.001–0.1   8 × 10⁻²    1.2  0.03      8     (CPU)     M dwarfs (never visible from afar)
 * dN/dL ∝ L^−β within a tier. Together ≈ 0.04 L☉ pc⁻³ and 0.1 stars pc⁻³, the local values.
 */
export interface LocalTier {
  lLo: number;
  lHi: number;
  /** Number density at the Sun, pc⁻³. */
  n0: number;
  cell: number;
  /** Render radius (pc); 0 = CPU only. */
  radius: number;
  /** Fraction that are evolved giants. */
  giants: number;
  /** Slope β of the luminosity function inside the tier, dN/dL ∝ L^−β. */
  beta: number;
}

export const LOCAL_TIERS: readonly LocalTier[] = [
  { lLo: 100, lHi: 1e5, n0: 1.5e-5, cell: 160, radius: 900, giants: 0.65, beta: 2.5 },
  { lLo: 10, lHi: 100, n0: 4e-4, cell: 64, radius: 320, giants: 0.5, beta: 2.0 },
  { lLo: 1, lHi: 10, n0: 5e-3, cell: 24, radius: 110, giants: 0.08, beta: 1.8 },
  { lLo: 0.1, lHi: 1, n0: 2e-2, cell: 12, radius: 40, giants: 0, beta: 1.5 },
  { lLo: 0.001, lHi: 0.1, n0: 8e-2, cell: 8, radius: 0, giants: 0, beta: 1.2 },
];

/** Most stars a GPU cell may hold (brightness is conserved above it). */
export const LOCAL_MAX_PER_CELL = [64, 96, 96, 48, 0] as const;
/** Cells per side of the drawn cube for each tier (odd). */
export const LOCAL_CELLS = [13, 11, 11, 9, 0] as const;

/**
 * Luminosity density shape of the galaxy (thin + thick disk + bulge), L☉ pc⁻³, identical to the
 * GLSL `localLumDensity`. Model frame (x, y, h).
 */
export interface DensityParams {
  thin: [number, number, number]; // j0 (L☉ pc⁻³ at R = 0, h = 0), R_d, h_z
  thick: [number, number, number];
  bulge: [number, number, number]; // L, a, flatten
  flare: [number, number]; // e-fold length (0 = none), onset
  trunc: number;
  /** Milky Way luminosity density at the Sun (normaliser). */
  ref: number;
}

const sech2 = (x: number) => {
  const c = Math.cosh(Math.min(30, Math.abs(x)));
  return 1 / (c * c);
};

export function densityParams(p: GalaxyParams, mwRef?: number): DensityParams {
  const d = p.disk;
  const b = p.bulge;
  const dp: DensityParams = {
    thin: [d.lum / (2 * Math.PI * d.scaleLength ** 2 * 2 * d.scaleHeight), d.scaleLength, d.scaleHeight],
    thick: [d.thickLum / (2 * Math.PI * d.thickScaleLength ** 2 * 2 * d.thickScaleHeight), d.thickScaleLength, d.thickScaleHeight],
    bulge: [b.lum, b.a, b.flatten],
    flare: [d.flare, 2.5 * d.scaleLength],
    trunc: d.lum > 0 ? d.truncation : p.rMax,
    ref: 1,
  };
  dp.ref = mwRef ?? 1;
  return dp;
}

export function lumDensity(dp: DensityParams, x: number, y: number, h: number): number {
  const R = Math.hypot(x, y);
  const fl = dp.flare[0] > 0 ? Math.exp(Math.max(0, R - dp.flare[1]) / dp.flare[0]) : 1;
  const tr = 1 - smoothstep(dp.trunc * 0.88, dp.trunc * 1.06, R);
  let j = dp.thin[0] * Math.exp(-R / dp.thin[1]) * sech2(h / (dp.thin[2] * fl)) / fl * tr;
  j += dp.thick[0] * Math.exp(-R / dp.thick[1]) * sech2(h / (dp.thick[2] * fl)) / fl * tr;
  const rb = Math.hypot(x, y, h / dp.bulge[2]);
  const a = dp.bulge[1];
  if (dp.bulge[0] > 0) j += (dp.bulge[0] * a) / (2 * Math.PI * Math.max(rb, 0.05 * a) * (rb + a) ** 3) / dp.bulge[2];
  return j;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Milky Way luminosity density at the Sun (normaliser for every galaxy). */
export function mwReference(mw: GalaxyParams): number {
  const s = mw.sun!;
  return lumDensity(densityParams(mw), s.R, 0, s.z);
}

export interface LocalStar {
  /** Stable id: tier, cell and slot packed into a safe integer. */
  id: number;
  /** Model-frame position (pc). */
  x: number;
  y: number;
  h: number;
  temperatureK: number;
  /** Bolometric luminosity, L☉. */
  luminosity: number;
  massSun: number;
  /** Per-star seed for further procedural detail (planets, spectra…). */
  seed: number;
  giant: boolean;
}

/**
 * Star `slot` of cell (ix, iy, iz) of `tier`, or null when the cell holds fewer stars.
 * GPU twin: LOCAL_STAR_GLSL `localStar`.
 */
export function cellCount(tierIdx: number, dp: DensityParams, seed: number, ix: number, iy: number, iz: number): { n: number; boost: number; h: number } {
  const t = LOCAL_TIERS[tierIdx];
  const C = t.cell;
  const h = hash4u(ix, iy, iz, (tierIdx * 7919 + seed * 104729) >>> 0);
  const j = lumDensity(dp, (ix + 0.5) * C, (iy + 0.5) * C, (iz + 0.5) * C) / dp.ref;
  const nExp = t.n0 * j * C * C * C;
  const nRaw = Math.floor(nExp + u01(h));
  const cap = LOCAL_MAX_PER_CELL[tierIdx] || 4096;
  const n = Math.min(nRaw, cap);
  return { n, boost: nRaw > cap ? nExp / cap : 1, h };
}

export function localStar(tierIdx: number, cellHash: number, ix: number, iy: number, iz: number, slot: number, boost: number): LocalStar {
  const t = LOCAL_TIERS[tierIdx];
  const C = t.cell;
  let s = hash3u(cellHash, slot, 0x51f15e);
  const fx = u01(s);
  s = next(s);
  const fy = u01(s);
  s = next(s);
  const fz = u01(s);
  s = next(s);
  const uL = u01(s);
  s = next(s);
  const uT = u01(s);
  s = next(s);
  const giant = u01(s) < t.giants;
  // Luminosity: dN/dL ∝ L^−β inside the tier (inverse CDF).
  const e = 1 - t.beta;
  const a = Math.pow(t.lLo, e);
  const b = Math.pow(t.lHi, e);
  const L = Math.pow(a + uL * (b - a), 1 / e);
  let T: number;
  let m: number;
  if (giant) {
    // Red clump / K giants (4500–5000 K) and, among the brightest, M giants (3400–3900 K).
    const cool = L > 400 ? 0.55 : 0.15;
    T = uT < cool ? 3400 + 500 * (uT / cool) : 4300 + 800 * ((uT - cool) / (1 - cool));
    m = 1.2 + 1.3 * uT;
  } else {
    // Main sequence: L ≈ m^4 (0.43–2 M☉), m^3.5 above; T from L = 4πR²σT⁴ with R ≈ m^0.8.
    m = L < 16 ? Math.pow(L, 0.25) : Math.pow(L / 1.4, 1 / 3.5);
    m = Math.max(0.08, m);
    const R = m < 1.66 ? 1.06 * Math.pow(m, 0.945) : 1.33 * Math.pow(m, 0.555);
    T = 5772 * Math.pow(L, 0.25) / Math.sqrt(R);
    T *= 0.97 + 0.06 * uT;
  }
  return {
    id: tierIdx * 2 ** 44 + ((cellHash >>> 0) % 2 ** 32) * 1024 + slot,
    x: (ix + fx) * C,
    y: (iy + fy) * C,
    h: (iz + fz) * C,
    temperatureK: T,
    luminosity: L * boost,
    massSun: m,
    seed: next(s),
    giant,
  };
}

/** Visible-light luminosity (L☉-equivalent) of a local star. */
export const visualLuminosity = (s: LocalStar) => s.luminosity * visualEfficacyFit(s.temperatureK);

/**
 * The k stars nearest to a model-frame point, from every tier (including the CPU-only M dwarfs).
 * Cells are searched in growing shells per tier until the k-th distance is inside the shell.
 */
export function nearestLocalStars(dp: DensityParams, seed: number, x: number, y: number, h: number, k: number, maxRadius = 2000): LocalStar[] {
  const best: Array<{ d2: number; s: LocalStar }> = [];
  const worst = () => (best.length < k ? Infinity : best[best.length - 1].d2);
  const push = (s: LocalStar) => {
    const d2 = (s.x - x) ** 2 + (s.y - y) ** 2 + (s.h - h) ** 2;
    if (d2 >= worst()) return;
    let i = best.length;
    while (i > 0 && best[i - 1].d2 > d2) i--;
    best.splice(i, 0, { d2, s });
    if (best.length > k) best.pop();
  };
  for (let t = 0; t < LOCAL_TIERS.length; t++) {
    const C = LOCAL_TIERS[t].cell;
    const cx = Math.floor(x / C), cy = Math.floor(y / C), cz = Math.floor(h / C);
    for (let r = 0; r * C < maxRadius; r++) {
      // Shell r: cells with Chebyshev distance r.
      const minD = Math.max(0, (r - 1) * C);
      if (minD * minD > worst()) break;
      for (let dx = -r; dx <= r; dx++)
        for (let dy = -r; dy <= r; dy++)
          for (let dz = -r; dz <= r; dz++) {
            if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
            const ix = cx + dx, iy = cy + dy, iz = cz + dz;
            const c = cellCount(t, dp, seed, ix, iy, iz);
            for (let j = 0; j < c.n; j++) push(localStar(t, c.h, ix, iy, iz, j, c.boost));
          }
      if (r > 64) break;
    }
  }
  return best.map((b) => b.s);
}
