/**
 * Statistical small-body populations (deterministic from a seed) — orbital elements for tens of
 * thousands of asteroids and Kuiper-belt objects that move on Kepler orbits on the GPU.
 *
 * Main belt. Semi-major axes follow the observed three-zone structure (inner 2.1–2.5 AU, middle
 * 2.5–2.82, pristine 2.82–2.96, outer 2.96–3.28) with the Kirkwood gaps carved at Jupiter's
 * mean-motion resonances a = a♃ (q/p)^{2/3} (1 + m♃)^{−1/3}: 4:1 (2.06, inner edge with ν6),
 * 3:1 (2.50), 5:2 (2.82), 7:3 (2.95), 9:4 (3.03), 2:1 (3.28, the Hecuba gap). Proper e ~ Rayleigh(0.1),
 * sin i ~ Rayleigh(0.12) (Knežević & Milani 2003 proper elements), perihelion kept outside
 * Mars' aphelion. Collisional families (Nesvorný et al. 2015): Flora, Vesta, Nysa–Polana, Eunomia,
 * Koronis, Eos, Themis, Hygiea, Hungaria, Phocaea. Taxonomy gradient S → C with distance (Gradie &
 * Tedesco 1982; DeMeo & Carry 2014). Sizes: N(>D) ∝ D^−2.3.
 *
 * Resonant groups share the planet's mean motion exactly so they stay locked over any time warp:
 * Hildas (3:2, σ = 3λ♃ − 2λ − ϖ librating about 0° → the triangle with vertices at L3/L4/L5),
 * Jupiter Trojans (1:1 at L4/L5, tadpole libration, L4:L5 ≈ 1.6), plutinos (Neptune 3:2,
 * σ = 3λ − 2λ♆ − ϖ about 180°: perihelia 90° from Neptune), twotinos (2:1).
 * Kuiper belt: cold classical (42.4–47 AU, e < 0.1, i ~ 2°, "kernel" at 44 AU, very red), hot
 * classical (i ~ 12°), scattered disc (q 30–40 AU), detached objects. Oort cloud (hypothetical).
 */
import { Rng } from '../../physics/random';
import { meanLongitudeDeg, meanMotionDegPerDay, semiMajorAxis } from './ephem/standish';
import { GAUSS_K } from './ephem/conic';

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
export const BELT_EPOCH = 2451545.0;
/** Jupiter/Sun and Neptune/Sun mass ratios. */
const M_JUP = 1 / 1047.3486;

export enum Taxon {
  C = 0,
  S = 1,
  X = 2,
  V = 3,
  D = 4,
  KboRed = 5,
  KboNeutral = 6,
  E = 7,
  Icy = 8,
}

/** Reflectance colour (linear RGB, normalised to mean 1) of each taxon. */
export const TAXON_COLOR: ReadonlyArray<readonly [number, number, number]> = [
  [0.96, 0.99, 1.05], // C: flat, slightly blue
  [1.22, 1.0, 0.78], // S: reddish silicates
  [1.05, 1.0, 0.95], // X
  [1.18, 1.03, 0.79], // V: basaltic
  [1.35, 0.98, 0.67], // D: very red, dark (Trojans, Hildas)
  [1.45, 0.96, 0.59], // cold classical: ultra-red
  [1.12, 1.0, 0.88], // hot classical: grey–red
  [1.0, 1.0, 1.0], // E: bright enstatite
  [1.05, 1.0, 0.95], // icy scattered objects
];

export interface Resonance {
  label: string;
  /** The small body completes p orbits while the planet completes q. */
  p: number;
  q: number;
  a: number;
  planet: 'jupiter' | 'neptune';
}

export function resonanceA(planetA: number, p: number, q: number, planetMass = M_JUP): number {
  return planetA * Math.pow(q / p, 2 / 3) * Math.pow(1 + planetMass, -1 / 3);
}

const A_JUP = semiMajorAxis('jupiter');
const A_NEP = semiMajorAxis('neptune');
const M_NEP = 1 / 19412.26;

export const RESONANCES: Resonance[] = [
  { label: '4:1', p: 4, q: 1, a: resonanceA(A_JUP, 4, 1), planet: 'jupiter' },
  { label: '3:1', p: 3, q: 1, a: resonanceA(A_JUP, 3, 1), planet: 'jupiter' },
  { label: '5:2', p: 5, q: 2, a: resonanceA(A_JUP, 5, 2), planet: 'jupiter' },
  { label: '7:3', p: 7, q: 3, a: resonanceA(A_JUP, 7, 3), planet: 'jupiter' },
  { label: '9:4', p: 9, q: 4, a: resonanceA(A_JUP, 9, 4), planet: 'jupiter' },
  { label: '2:1', p: 2, q: 1, a: resonanceA(A_JUP, 2, 1), planet: 'jupiter' },
  { label: '3:2', p: 3, q: 2, a: resonanceA(A_JUP, 3, 2), planet: 'jupiter' },
  { label: '4:3', p: 4, q: 3, a: resonanceA(A_JUP, 4, 3), planet: 'jupiter' },
  { label: '3:2 ♆', p: 2, q: 3, a: resonanceA(A_NEP, 2, 3, M_NEP), planet: 'neptune' },
  { label: '2:1 ♆', p: 1, q: 2, a: resonanceA(A_NEP, 1, 2, M_NEP), planet: 'neptune' },
  { label: '5:2 ♆', p: 2, q: 5, a: resonanceA(A_NEP, 2, 5, M_NEP), planet: 'neptune' },
];

/** Kirkwood gap profile: [a_res, half-width (AU), depth 0..1]. */
const GAPS: ReadonlyArray<readonly [number, number, number]> = [
  [resonanceA(A_JUP, 3, 1), 0.016, 0.985],
  [resonanceA(A_JUP, 5, 2), 0.012, 0.96],
  [resonanceA(A_JUP, 7, 3), 0.008, 0.85],
  [resonanceA(A_JUP, 9, 4), 0.005, 0.55],
  [resonanceA(A_JUP, 11, 5), 0.004, 0.35],
  [resonanceA(A_JUP, 2, 1), 0.03, 0.97],
];

/** Product of the Kirkwood notches at a (1 = no resonance, → 0 inside a gap). */
export function gapFactor(a: number): number {
  let g = 1;
  for (const [a0, w, depth] of GAPS) {
    const x = (a - a0) / w;
    g *= 1 - depth * Math.exp(-x * x);
  }
  return g;
}

/** Relative density of the background main belt at semi-major axis a (0..1), gaps included. */
export function mainBeltDensity(a: number): number {
  if (a < 2.08 || a > 3.7) return 0;
  const edge = (x: number, x0: number, w: number) => 1 / (1 + Math.exp(-(x - x0) / w));
  let d: number;
  if (a < 2.5) d = 1.0;
  else if (a < 2.825) d = 0.95;
  else if (a < 2.957) d = 0.42;
  else if (a < 3.28) d = 0.78;
  else d = 0.07; // Cybele group 3.3–3.7 AU
  return d * edge(a, 2.14, 0.012) * gapFactor(a);
}

export interface Population {
  name: string;
  count: number;
  /** a (AU), e, i (rad), Ω (rad) per particle. */
  orbitA: Float32Array;
  /** ω (rad), M at BELT_EPOCH (rad), n (rad/day), libration amplitude (rad) per particle. */
  orbitB: Float32Array;
  /** diameter (km), geometric albedo, taxon, libration phase (rad) per particle. */
  phys: Float32Array;
  /** Libration angular frequency (rad/day) shared by the population (0 = none). */
  libOmega: number;
  /** Double-precision copies of M0, n and the libration phase at BELT_EPOCH (never re-based). */
  M0: Float64Array;
  n: Float64Array;
  libPhase: Float64Array;
}

function alloc(name: string, count: number, libOmega = 0): Population {
  return {
    name,
    count,
    orbitA: new Float32Array(count * 4),
    orbitB: new Float32Array(count * 4),
    phys: new Float32Array(count * 4),
    libOmega,
    M0: new Float64Array(count),
    n: new Float64Array(count),
    libPhase: new Float64Array(count),
  };
}

function put(p: Population, k: number, a: number, e: number, i: number, node: number, peri: number, M0: number, n: number, D: number, albedo: number, taxon: number, libAmp = 0, libPhase = 0): void {
  p.orbitA[k * 4] = a;
  p.orbitA[k * 4 + 1] = e;
  p.orbitA[k * 4 + 2] = i;
  p.orbitA[k * 4 + 3] = node;
  const m0 = ((M0 % TAU) + TAU) % TAU;
  p.orbitB[k * 4] = peri;
  p.orbitB[k * 4 + 1] = m0;
  p.orbitB[k * 4 + 2] = n;
  p.orbitB[k * 4 + 3] = libAmp;
  p.phys[k * 4] = D;
  p.phys[k * 4 + 1] = albedo;
  p.phys[k * 4 + 2] = taxon;
  p.phys[k * 4 + 3] = libPhase;
  p.M0[k] = m0;
  p.n[k] = n;
  p.libPhase[k] = libPhase;
}

const kepN = (a: number) => GAUSS_K / Math.pow(a, 1.5); // rad/day
const rayleigh = (rng: Rng, s: number) => s * Math.sqrt(-2 * Math.log(1 - rng.next()));
const sizeD = (rng: Rng, dMin: number, dMax: number, q = 2.3) => {
  // N(>D) ∝ D^−q between dMin and dMax.
  const u = rng.next();
  const a = Math.pow(dMin, -q), b = Math.pow(dMax, -q);
  return Math.pow(a + u * (b - a), -1 / q);
};

interface Family {
  a: number;
  sa: number;
  e: number;
  se: number;
  i: number;
  si: number;
  w: number;
  taxon: Taxon;
  albedo: number;
}
const FAMILIES: Family[] = [
  { a: 2.24, sa: 0.05, e: 0.145, se: 0.018, i: 5.5, si: 1.4, w: 0.055, taxon: Taxon.S, albedo: 0.29 }, // Flora
  { a: 2.36, sa: 0.045, e: 0.1, se: 0.012, i: 6.5, si: 0.7, w: 0.045, taxon: Taxon.V, albedo: 0.35 }, // Vesta
  { a: 2.4, sa: 0.04, e: 0.165, se: 0.015, i: 2.8, si: 0.8, w: 0.045, taxon: Taxon.C, albedo: 0.06 }, // Nysa–Polana
  { a: 2.63, sa: 0.05, e: 0.15, se: 0.012, i: 13.1, si: 0.9, w: 0.035, taxon: Taxon.S, albedo: 0.25 }, // Eunomia
  { a: 2.88, sa: 0.025, e: 0.047, se: 0.006, i: 2.1, si: 0.25, w: 0.03, taxon: Taxon.S, albedo: 0.23 }, // Koronis
  { a: 3.02, sa: 0.03, e: 0.075, se: 0.008, i: 10.0, si: 0.6, w: 0.035, taxon: Taxon.X, albedo: 0.14 }, // Eos
  { a: 3.14, sa: 0.05, e: 0.153, se: 0.015, i: 1.1, si: 0.4, w: 0.055, taxon: Taxon.C, albedo: 0.07 }, // Themis
  { a: 3.14, sa: 0.04, e: 0.117, se: 0.01, i: 5.1, si: 0.4, w: 0.03, taxon: Taxon.C, albedo: 0.06 }, // Hygiea
  { a: 1.94, sa: 0.04, e: 0.075, se: 0.03, i: 22, si: 3.5, w: 0.02, taxon: Taxon.E, albedo: 0.4 }, // Hungaria
  { a: 2.36, sa: 0.05, e: 0.2, se: 0.035, i: 23, si: 2.2, w: 0.012, taxon: Taxon.S, albedo: 0.22 }, // Phocaea
];

/** Main belt: background with Kirkwood gaps + families. */
export function sampleMainBelt(count: number, seed = 1): Population {
  const rng = new Rng(`main-belt-${seed}`);
  const p = alloc('main belt', count);
  const famTotal = FAMILIES.reduce((s, f) => s + f.w, 0);
  let k = 0;
  let guard = 0;
  while (k < count && guard++ < count * 200) {
    let a: number, e: number, inc: number, taxon: Taxon, albedo: number;
    const u = rng.next();
    if (u < famTotal) {
      // Family member.
      let acc = 0;
      let f = FAMILIES[0];
      for (const fam of FAMILIES) {
        acc += fam.w;
        if (u < acc) {
          f = fam;
          break;
        }
      }
      a = rng.normal(f.a, f.sa);
      e = Math.max(0, rng.normal(f.e, f.se));
      inc = Math.abs(rng.normal(f.i, f.si)) * DEG;
      taxon = f.taxon;
      albedo = f.albedo * (0.8 + 0.4 * rng.next());
      // Resonances cut through families too (not the Hungarias, which live inside the 4:1).
      if (f.a > 2.1 && rng.next() > gapFactor(a)) continue;
    } else {
      a = rng.range(2.06, 3.7);
      if (rng.next() > mainBeltDensity(a)) continue;
      e = Math.min(0.34, rayleigh(rng, 0.1));
      inc = Math.asin(Math.min(0.55, rayleigh(rng, 0.12)));
      // Compositional gradient: S-types dominate inside 2.5 AU, C-types outside 2.8 AU.
      const pS = Math.min(0.78, Math.max(0.12, 0.78 - 0.62 * (a - 2.2)));
      const r = rng.next();
      taxon = r < pS ? Taxon.S : r < pS + 0.1 ? Taxon.X : Taxon.C;
      albedo = taxon === Taxon.S ? 0.24 : taxon === Taxon.X ? 0.12 : 0.06;
      albedo *= 0.7 + 0.6 * rng.next();
    }
    // Stability: perihelion outside Mars' aphelion (1.666 AU), aphelion inside ~4.4 AU.
    if (a * (1 - e) < 1.67 && a > 2.1) continue;
    if (a * (1 + e) > 4.5) continue;
    const node = rng.next() * TAU;
    const peri = rng.next() * TAU;
    const M0 = rng.next() * TAU;
    const D = sizeD(rng, 5, 600, 2.3);
    put(p, k, a, e, inc, node, peri, M0, kepN(a), D, albedo, taxon);
    k++;
  }
  p.count = k;
  return p;
}

/** Hildas: locked to Jupiter's mean motion ×3/2; resonant angle 3λ♃ − 2λ − ϖ librates about 0°. */
export function sampleHildas(count: number, seed = 1): Population {
  const rng = new Rng(`hildas-${seed}`);
  const p = alloc('Hildas', count, TAU / (270 * 365.25));
  const nJ = meanMotionDegPerDay('jupiter') * DEG;
  const n = 1.5 * nJ;
  const a = Math.pow(GAUSS_K / n, 2 / 3);
  const lamJ = meanLongitudeDeg('jupiter', BELT_EPOCH) * DEG;
  for (let k = 0; k < count; k++) {
    const e = Math.min(0.32, Math.max(0.04, rng.normal(0.17, 0.06)));
    const inc = Math.min(20, rayleigh(rng, 6.5)) * DEG;
    const varpi = rng.next() * TAU;
    const amp = rng.range(5, 40) * DEG;
    const ph = rng.next() * TAU;
    // Resonance centre σ = 0; the libration σ = amp·sin(φ + ωt) enters λ as −σ/2 (added on the GPU).
    const lam = (3 * lamJ - varpi) / 2 + (rng.next() < 0.5 ? Math.PI : 0);
    const node = rng.next() * TAU;
    const peri = varpi - node;
    const M0 = lam - varpi;
    // Libration is in σ, i.e. −σ/2 in λ: amplitude amp/2.
    put(p, k, a + rng.normal(0, 0.012), e, inc, node, peri, M0, n, sizeD(rng, 5, 170, 2.0), 0.055, Taxon.D, amp / 2, ph);
  }
  return p;
}

/** Jupiter Trojans at L4 (60° ahead) and L5 (60° behind), tadpole libration period ~150 yr. */
export function sampleTrojans(count: number, seed = 1): Population {
  const rng = new Rng(`trojans-${seed}`);
  const p = alloc('Jupiter Trojans', count, TAU / (150 * 365.25));
  const nJ = meanMotionDegPerDay('jupiter') * DEG;
  const a = Math.pow(GAUSS_K / nJ, 2 / 3) * Math.pow(1 + M_JUP, 1 / 3);
  const lamJ = meanLongitudeDeg('jupiter', BELT_EPOCH) * DEG;
  for (let k = 0; k < count; k++) {
    const l4 = rng.next() < 1.6 / 2.6;
    const e = Math.min(0.2, rayleigh(rng, 0.065));
    const inc = Math.min(40, rayleigh(rng, 13)) * DEG;
    const varpi = rng.next() * TAU;
    const amp = Math.min(38, rayleigh(rng, 11)) * DEG;
    const ph = rng.next() * TAU;
    const lam = lamJ + (l4 ? 60 : -60) * DEG;
    const node = rng.next() * TAU;
    put(p, k, a, e, inc, node, varpi - node, lam - varpi, nJ, sizeD(rng, 5, 225, 2.0), 0.06, Taxon.D, amp, ph);
  }
  return p;
}

/** Near-Earth asteroids (Apollo/Aten/Amor mix, Granvik et al. 2018 debiased shape). */
export function sampleNEAs(count: number, seed = 1): Population {
  const rng = new Rng(`nea-${seed}`);
  const p = alloc('near-Earth asteroids', count);
  let k = 0;
  while (k < count) {
    const a = rng.range(0.7, 3.0);
    const q = rng.range(0.25, 1.3);
    if (q >= a) continue;
    const e = 1 - q / a;
    if (e > 0.85 || a * (1 + e) > 4.2) continue;
    const inc = Math.min(45, rayleigh(rng, 12)) * DEG;
    put(p, k, a, e, inc, rng.next() * TAU, rng.next() * TAU, rng.next() * TAU, kepN(a), sizeD(rng, 0.14, 30, 1.9), 0.15, rng.next() < 0.6 ? Taxon.S : Taxon.C);
    k++;
  }
  return p;
}

/** Kuiper belt and scattered disc. */
export function sampleKuiper(count: number, seed = 1): Population {
  const rng = new Rng(`kuiper-${seed}`);
  const p = alloc('Kuiper belt', count, TAU / (20000 * 365.25));
  const nN = meanMotionDegPerDay('neptune') * DEG;
  const lamN = meanLongitudeDeg('neptune', BELT_EPOCH) * DEG;
  for (let k = 0; k < count; k++) {
    const u = rng.next();
    const node = rng.next() * TAU;
    let a: number, e: number, inc: number, varpi: number, M0: number, n: number, taxon: Taxon, albedo: number;
    let amp = 0, ph = 0;
    if (u < 0.3) {
      // Cold classical: low e, low i, very red, with the 44 AU kernel.
      a = rng.next() < 0.25 ? rng.normal(44.0, 0.25) : rng.range(42.4, 47.0);
      e = Math.min(0.1, rayleigh(rng, 0.04));
      inc = rayleigh(rng, 1.9) * DEG;
      varpi = rng.next() * TAU;
      M0 = rng.next() * TAU;
      n = kepN(a);
      taxon = Taxon.KboRed;
      albedo = 0.15;
    } else if (u < 0.58) {
      // Hot classical.
      a = rng.range(40.5, 48);
      if (Math.abs(a - 43.7) < 0.2) a += 0.4; // 7:4 region thinned
      e = rng.range(0.02, Math.min(0.24, 1 - 35 / a));
      inc = Math.min(40, rayleigh(rng, 12)) * DEG;
      varpi = rng.next() * TAU;
      M0 = rng.next() * TAU;
      n = kepN(a);
      taxon = rng.next() < 0.5 ? Taxon.KboNeutral : Taxon.KboRed;
      albedo = 0.08;
    } else if (u < 0.8) {
      // Plutinos: n = (2/3) n♆ exactly; σ = 3λ − 2λ♆ − ϖ librates about 180°.
      n = (2 / 3) * nN;
      a = Math.pow(GAUSS_K / n, 2 / 3) + rng.normal(0, 0.15);
      e = rng.range(0.08, 0.3);
      inc = Math.min(35, rayleigh(rng, 10)) * DEG;
      varpi = rng.next() * TAU;
      amp = rng.range(20, 90) * DEG;
      ph = rng.next() * TAU;
      const lam = (Math.PI + 2 * lamN + varpi) / 3 + rng.int(3) * (TAU / 3);
      M0 = lam - varpi;
      amp /= 3;
      taxon = rng.next() < 0.5 ? Taxon.KboNeutral : Taxon.KboRed;
      albedo = 0.09;
    } else if (u < 0.85) {
      // Twotinos (2:1): σ = 2λ − λ♆ − ϖ librates about 180° (symmetric) or ±75° (asymmetric islands).
      n = 0.5 * nN;
      a = Math.pow(GAUSS_K / n, 2 / 3) + rng.normal(0, 0.2);
      e = rng.range(0.1, 0.35);
      inc = Math.min(30, rayleigh(rng, 8)) * DEG;
      varpi = rng.next() * TAU;
      const centre = rng.pick([Math.PI, (75 + 180) * DEG, (180 - 75) * DEG]);
      amp = rng.range(10, 40) * DEG;
      ph = rng.next() * TAU;
      const lam = (centre + lamN + varpi) / 2 + (rng.next() < 0.5 ? Math.PI : 0);
      M0 = lam - varpi;
      amp /= 2;
      taxon = Taxon.KboNeutral;
      albedo = 0.08;
    } else if (u < 0.985) {
      // Scattered disc: perihelia near Neptune (30–40 AU), a out to ~1000 AU.
      a = Math.exp(rng.range(Math.log(50), Math.log(900)));
      const q = rng.range(30, 40);
      e = 1 - q / a;
      inc = Math.min(60, rayleigh(rng, 16)) * DEG;
      varpi = rng.next() * TAU;
      M0 = rng.next() * TAU;
      n = kepN(a);
      taxon = Taxon.Icy;
      albedo = 0.07;
    } else {
      // Detached objects (Sedna-like): perihelia 50–80 AU.
      a = Math.exp(rng.range(Math.log(150), Math.log(1000)));
      const q = rng.range(50, 80);
      e = 1 - q / a;
      inc = Math.min(40, rayleigh(rng, 12)) * DEG;
      varpi = rng.next() * TAU;
      M0 = rng.next() * TAU;
      n = kepN(a);
      taxon = Taxon.KboRed;
      albedo = 0.15;
    }
    put(p, k, a, e, inc, node, varpi - node, M0, n, sizeD(rng, 50, 1200, 2.4), albedo, taxon, amp, ph);
  }
  return p;
}

/**
 * The Oort cloud: a hypothetical isotropic reservoir of comets from ~2 000 to 100 000 AU
 * (Öpik 1932, Oort 1950) — never observed directly. Particles are effectively static.
 */
export function sampleOort(count: number, seed = 1): Population {
  const rng = new Rng(`oort-${seed}`);
  const p = alloc('Oort cloud', count);
  for (let k = 0; k < count; k++) {
    // Inner (Hills) cloud 2 000–20 000 AU, outer to 100 000 AU; number density ∝ r^−3.5.
    const r = Math.min(100000, 2000 * Math.pow(1 - rng.next() * 0.98, -1 / 0.5));
    const a = r / (1 + rng.range(0, 0.6));
    const e = Math.min(0.95, rng.range(0.1, 0.95));
    const inc = Math.acos(rng.range(-1, 1));
    put(p, k, a, e, inc, rng.next() * TAU, rng.next() * TAU, rng.next() * TAU, kepN(a), sizeD(rng, 2, 50, 2), 0.04, Taxon.Icy);
  }
  return p;
}

/**
 * CPU position of particle k at jd (heliocentric, astro frame AU) — same model as the GPU shader,
 * used for tests and for promoting near-camera particles to meshes.
 */
export function particlePosition(p: Population, k: number, jd: number, out: { x: number; y: number; z: number }): void {
  const a = p.orbitA[k * 4], e = p.orbitA[k * 4 + 1], inc = p.orbitA[k * 4 + 2], node = p.orbitA[k * 4 + 3];
  const peri = p.orbitB[k * 4];
  const amp = p.orbitB[k * 4 + 3];
  const t = jd - BELT_EPOCH;
  let M = p.M0[k] + p.n[k] * t;
  if (amp) M += amp * Math.sin(p.libPhase[k] + p.libOmega * t);
  M = M % TAU;
  let E = M;
  for (let it = 0; it < 8; it++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const xp = a * (Math.cos(E) - e);
  const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const cO = Math.cos(node), sO = Math.sin(node), ci = Math.cos(inc), si = Math.sin(inc), cw = Math.cos(peri), sw = Math.sin(peri);
  out.x = (cO * cw - sO * sw * ci) * xp + (-cO * sw - sO * cw * ci) * yp;
  out.y = (sO * cw + cO * sw * ci) * xp + (-sO * sw + cO * cw * ci) * yp;
  out.z = sw * si * xp + cw * si * yp;
}
