import { Rng } from '../../physics/random';
import { blackbodyVisibleFraction, O_DWARFS } from '../../physics/nebulae';
import type { NebulaStar, Vec3 } from './types';

/**
 * Stellar populations for nebulae: embedded clusters drawn from the Kroupa (2001) IMF, placed
 * with a Plummer (1911) profile, and converted to observables with main-sequence relations.
 * Pure functions (seeded) so positions/brightnesses are reproducible and testable.
 */

const T_SUN = 5772;
const VF_SUN = blackbodyVisibleFraction(T_SUN);

/** Main-sequence luminosity (L☉) for mass M (M☉), piecewise power law (Duric 2004). */
export function msLuminosity(m: number): number {
  if (m < 0.43) return 0.23 * Math.pow(m, 2.3);
  if (m < 2) return Math.pow(m, 4);
  if (m < 55) return 1.4 * Math.pow(m, 3.5);
  return 32000 * m;
}

/** Main-sequence radius (R☉). */
export const msRadius = (m: number) => (m < 1 ? Math.pow(m, 0.8) : Math.pow(m, 0.57));

/** Effective temperature from L and R: T = T☉ (L / R²)^{1/4}, capped at the hottest O dwarfs. */
export function msTemperature(m: number): number {
  const L = msLuminosity(m);
  const R = msRadius(m);
  return Math.min(45000, T_SUN * Math.pow(L / (R * R), 0.25));
}

/**
 * Absolute visual magnitude from bolometric luminosity and temperature, with the bolometric
 * correction taken from the blackbody's photopic fraction (good to ~0.3 mag for 3–45 kK).
 */
export function absoluteMagnitude(lumSun: number, teff: number): number {
  const vf = blackbodyVisibleFraction(teff) / VF_SUN;
  return 4.83 - 2.5 * Math.log10(Math.max(1e-6, lumSun * vf));
}

/** Kroupa IMF sample in [lo, hi] M☉ (slopes −1.3 below 0.5 M☉, −2.3 above). */
export function sampleKroupa(rng: Rng, lo = 0.1, hi = 60): number {
  // Two segments weighted by their integrals (continuous at 0.5 M☉).
  const seg = (a: number, x0: number, x1: number) => (Math.pow(x1, a + 1) - Math.pow(x0, a + 1)) / (a + 1);
  const b = Math.min(Math.max(0.5, lo), hi);
  // dN/dM = A M^-1.3 below 0.5 M☉ and M^-2.3 above; continuity at 0.5 M☉ gives A = 0.5^-1 = 2.
  const w1 = lo < 0.5 ? 2 * seg(-1.3, lo, b) : 0;
  const w2 = hi > 0.5 ? seg(-2.3, Math.max(0.5, lo), hi) : 0;
  const pick = rng.next() * (w1 + w2);
  return pick < w1 ? rng.powerLaw(-1.3, lo, b) : rng.powerLaw(-2.3, Math.max(0.5, lo), hi);
}

/** Point inside a Plummer sphere of scale radius a (truncated at 5a). */
export function plummerPoint(rng: Rng, a: number): Vec3 {
  let r = 0;
  for (let k = 0; k < 8; k++) {
    const u = Math.max(1e-6, rng.next());
    r = a / Math.sqrt(Math.pow(u, -2 / 3) - 1);
    if (r < 5 * a) break;
  }
  const d = rng.onSphere();
  return [d.x * r, d.y * r, d.z * r];
}

export interface ClusterSpec {
  center: Vec3;
  /** Number of stars above `minMass`. */
  count: number;
  /** Plummer scale radius (pc). */
  radius: number;
  minMass?: number;
  maxMass?: number;
  /** Named O stars placed near the centre (spectral types from O_DWARFS). */
  oTypes?: string[];
  /** Radius (pc) within which the O stars sit. */
  coreRadius?: number;
}

/** A young cluster: its massive O stars near the centre plus an IMF-sampled population. */
export function makeCluster(rng: Rng, spec: ClusterSpec): NebulaStar[] {
  const out: NebulaStar[] = [];
  const [cx, cy, cz] = spec.center;
  for (const t of spec.oTypes ?? []) {
    const o = O_DWARFS.find((s) => s.type === t) ?? O_DWARFS[3];
    const p = plummerPoint(rng, spec.coreRadius ?? 0.12);
    out.push({ pos: [cx + p[0], cy + p[1], cz + p[2]], teff: o.teff, mv: o.mv, kind: 'ionizing' });
  }
  for (let i = 0; i < spec.count; i++) {
    const m = sampleKroupa(rng, spec.minMass ?? 0.6, spec.maxMass ?? 18);
    const L = msLuminosity(m);
    const T = msTemperature(m);
    const p = plummerPoint(rng, spec.radius);
    out.push({ pos: [cx + p[0], cy + p[1], cz + p[2]], teff: T, mv: absoluteMagnitude(L, T) });
  }
  return out;
}

/** Young stellar objects embedded in dense gas (pillar heads, globules): cool, faint, reddened. */
export function makeYSOs(rng: Rng, sites: Vec3[], perSite = 1, spread = 0.05): NebulaStar[] {
  const out: NebulaStar[] = [];
  for (const s of sites) {
    for (let k = 0; k < perSite; k++) {
      out.push({
        pos: [s[0] + rng.normal(0, spread), s[1] + rng.normal(0, spread), s[2] + rng.normal(0, spread)],
        teff: rng.range(3200, 4800),
        mv: rng.range(1.5, 5.5),
        kind: 'yso',
      });
    }
  }
  return out;
}
