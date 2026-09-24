/**
 * generateSystem(seed, hint?) → a physically plausible star system as pure data.
 *
 * Recipe (every step documented in stellar.ts / planets.ts, deterministic via Rng.fork):
 *  1. Host star: mass from the Kroupa IMF (so ~¾ of systems orbit M dwarfs), main-sequence
 *     L(M) (Eker 2015), R(M) (Boyajian 2012), T_eff from Stefan–Boltzmann, an age within the MS
 *     lifetime; ~3% red giants and ~3% white dwarfs.
 *  2. Companion (multiplicity rises with mass, Raghavan 2010): log-normal period, flat q,
 *     circular below 12 d (tides). Planets must satisfy Holman & Wiegert (1999): S-type inside
 *     a_c,S around the primary, or P-type (circumbinary) outside a_c,P.
 *  3. Planets form between an inner edge (P ≈ 1–4 d, the magnetospheric truncation radius) and
 *     the disk's outer edge; each new orbit is Δ = 10–25 mutual Hill radii beyond the last
 *     (Chambers 1996: dynamically stable for Gyr). Masses: super-Earths / sub-Neptunes inside the
 *     snow line (Kepler occurrence), giants beyond it with the Johnson (2010) M★–[Fe/H]
 *     dependence. Occasional hot Jupiters (~1% of FGK stars, lonely) and TRAPPIST-like resonant
 *     chains around M dwarfs.
 *  4. Each planet gets R(M) (Chen & Kipping 2017), T_eq, an HZ status (Kopparapu 2014), an
 *     atmosphere verdict (cosmic shoreline), tidal locking (Gladman 1996), spin, tilt, moons, rings,
 *     and a PlanetSpec for the renderer.
 *
 * We only visit systems that have planets (a selection effect, like any survey).
 */

import { Rng } from '../../physics/random';
import type { OrbitalElements } from '../../physics/kepler';
import type { PlanetKind, PlanetSpec, RingSpec } from '../planet/types';
import {
  giantPlanetOccurrence, habitableZone, holmanWiegertP, holmanWiegertS, hzFlux, hzStatus, luminosityFrom,
  msLifetimeGyr, msLuminosity, msRadius, multiplicityFraction, periodDays, periodDistribution, R_SUN_AU,
  sampleKroupa, semiMajorAxisAU, snowLineAU, spectralClass, effectiveTemperature, type HabitableZone, type HZStatus,
} from './stellar';
import {
  bulkDensity, equilibriumTemperature, escapeVelocity, flattening, hillRadius, insolation, keepsAtmosphere,
  massRadius, M_JUP_EARTH, nextHillSpacedOrbit, R_EARTH_KM, solarDay, substellarTemperature, sudarskyClass,
  SUDARSKY_ALBEDO, SUDARSKY_TEXT, surfaceGravity, tidalLockTimeYears, type SudarskyClass,
} from './planets';
import { catalogueName, givenName, PLANET_LETTERS } from './names';

const DEG = Math.PI / 180;
/** GM☉ in AU³/day² (Gaussian gravitational constant squared). */
export const GM_SUN_AU_DAY = 0.01720209895 ** 2;

export type StellarStage = 'main-sequence' | 'giant' | 'white-dwarf';

export interface StarData {
  name: string;
  /** M☉ */
  mass: number;
  /** R☉ */
  radius: number;
  /** L☉ */
  luminosity: number;
  /** K */
  teff: number;
  ageGyr: number;
  stage: StellarStage;
  /** e.g. "M5.5 V", "G2 V", "K1 III", "DA3" */
  spectralType: string;
  /** 0..1 magnetic activity (spots, flares). */
  activity: number;
}

export interface CompanionData {
  star: StarData;
  /** Relative orbit of the companion about the primary (AU, days). */
  orbit: OrbitalElements;
  periodDays: number;
  /** Mass ratio μ = m₂/(m₁+m₂). */
  mu: number;
  /** 'S' = planets orbit the primary; 'P' = circumbinary. */
  config: 'S' | 'P';
  /** Holman–Wiegert critical semi-major axis (AU). */
  critical: number;
}

export type PlanetClass = 'rocky' | 'icy' | 'super-earth' | 'water-world' | 'sub-neptune' | 'ice-giant' | 'gas-giant';

export interface MoonData {
  name: string;
  /** M⊕ */
  mass: number;
  /** R⊕ */
  radius: number;
  /** Orbit radius in planet radii. */
  a: number;
  periodDays: number;
  M0: number;
  inclination: number;
  kind: PlanetKind;
  spec: Omit<PlanetSpec, 'radius'>;
  note: string;
}

export interface PlanetData {
  index: number;
  letter: string;
  designation: string;
  givenName: string;
  class: PlanetClass;
  kind: PlanetKind;
  /** M⊕ */
  mass: number;
  /** R⊕ */
  radius: number;
  density: number;
  gravity: number;
  escapeVelocity: number;
  /** Orbit (AU, days) about the primary (S-type) or the barycentre (P-type). */
  orbit: OrbitalElements;
  /** GM of the central mass, AU³/day². */
  mu: number;
  periodDays: number;
  /** S⊕ */
  insolation: number;
  albedo: number;
  teq: number;
  /** Mean surface temperature estimate including greenhouse warming (K). */
  surfaceTemp: number;
  hz: HZStatus;
  atmosphere: boolean;
  tidallyLocked: boolean;
  /** '1:1' synchronous, '3:2' Mercury-like, or null. */
  spinOrbit: '1:1' | '3:2' | null;
  lockTimeYears: number;
  /** Sidereal rotation period, hours (negative = retrograde). */
  rotationHours: number;
  /** Solar day, hours (Infinity when synchronous). */
  dayHours: number;
  axialTilt: number;
  eyeball: boolean;
  resonance: string | null;
  sudarsky: SudarskyClass | null;
  composition: string;
  description: string;
  moons: MoonData[];
  /** Renderer spec without the scene radius. */
  spec: Omit<PlanetSpec, 'radius'>;
  /** Formed beyond the snow line (volatile-rich). */
  waterRich: boolean;
}

export type SystemFeature = 'habitable' | 'binary-sunset' | 'hot-jupiter' | 'ringed-giant' | 'resonant-chain' | 'eyeball' | 'm-dwarf' | 'sun-like' | 'giant-star' | 'white-dwarf';

export interface StarHint {
  /** Host mass, M☉ (e.g. from a catalogue star in Voyage). */
  mass?: number;
  /** Host T_eff (K) — used to infer a main-sequence mass when `mass` is absent. */
  teff?: number;
  stage?: StellarStage;
  /** false = single, true = binary (random config). */
  binary?: boolean;
  feh?: number;
}

export interface SystemData {
  seed: number;
  catalogue: string;
  name: string;
  star: StarData;
  companion: CompanionData | null;
  /** [Fe/H], dex */
  metallicity: number;
  /** Luminosity and T_eff used for the HZ (sum of both stars for P-type). */
  hzLuminosity: number;
  hzTeff: number;
  hz: HabitableZone;
  snowLine: number;
  planets: PlanetData[];
  /** Distance from the Sun (pc), for flavour. */
  distancePc: number;
  tags: Set<SystemFeature | 'binary' | 'circumbinary' | 'k-dwarf'>;
  /** Engulfed / cleared region (AU) for evolved hosts, else 0. */
  clearedInside: number;
  summary: string;
}

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const rayleigh = (rng: Rng, sigma: number) => sigma * Math.sqrt(-2 * Math.log(1 - rng.next() * 0.9999));

/* ——— Stars ——— */

function msStar(mass: number, age: number, rng: Rng): StarData {
  const tMS = msLifetimeGyr(mass);
  const x = clamp(age / tMS, 0, 1);
  // Slow brightening along the main sequence (the Sun: 0.7 L☉ at ZAMS → 1 L☉ today).
  const L = msLuminosity(mass) * (0.8 + 0.45 * x);
  const R = msRadius(mass) * (0.92 + 0.18 * x);
  const T = effectiveTemperature(L, R);
  const activity = clamp(0.25 + 0.55 * Math.exp(-age / 1.5) + (mass < 0.5 ? 0.25 : 0) + rng.range(-0.1, 0.1), 0.1, 1);
  return { name: '', mass, radius: R, luminosity: L, teff: T, ageGyr: age, stage: 'main-sequence', spectralType: `${spectralClass(T)} V`, activity };
}

/** Main-sequence mass whose T_eff matches `teff` (bisection on the relations above). */
export function massForTeff(teff: number): number {
  let lo = 0.08, hi = 8;
  for (let i = 0; i < 50; i++) {
    const m = Math.sqrt(lo * hi);
    const T = effectiveTemperature(msLuminosity(m), msRadius(m));
    if (T < teff) lo = m;
    else hi = m;
  }
  return Math.sqrt(lo * hi);
}

function makePrimary(rng: Rng, hint: StarHint): StarData {
  const u = rng.next();
  const stage: StellarStage = hint.stage ?? (u < 0.03 ? 'giant' : u < 0.06 ? 'white-dwarf' : 'main-sequence');
  if (stage === 'giant') {
    // A first-ascent red giant: 1–2.2 M☉ that has left the main sequence.
    const mass = hint.mass ?? rng.range(1, 2.2);
    const R = rng.logRange(6, 30);
    const T = 5000 - 800 * (Math.log10(R / 6) / Math.log10(5));
    const L = luminosityFrom(R, T);
    return { name: '', mass, radius: R, luminosity: L, teff: T, ageGyr: msLifetimeGyr(mass) * 1.08, stage, spectralType: `${spectralClass(T)} III`, activity: 0.2 };
  }
  if (stage === 'white-dwarf') {
    // Initial–final mass relation (Kalirai et al. 2008): M_WD = 0.109 M_i + 0.394.
    const mi = rng.range(1, 4);
    const mass = 0.109 * mi + 0.394;
    const R = 0.0127 * Math.pow(mass / 0.6, -1 / 3);
    // Mestel cooling: L ∝ t^−7/5 at fixed R → T ∝ t^−0.35.
    const tCool = rng.logRange(0.1, 6);
    const T = clamp(30000 * Math.pow(tCool / 0.1, -0.35), 4000, 30000);
    const L = luminosityFrom(R, T);
    return { name: '', mass, radius: R, luminosity: L, teff: T, ageGyr: msLifetimeGyr(mi) + tCool, stage, spectralType: `DA${(50400 / T).toFixed(1)}`, activity: 0 };
  }
  const mass = hint.mass ?? (hint.teff ? massForTeff(hint.teff) : sampleKroupa(rng.next(), 0.08, 3));
  const tMS = msLifetimeGyr(mass);
  const age = rng.range(0.4, Math.min(12, tMS * 0.9));
  return msStar(mass, age, rng);
}

/* ——— Planet classification and specs ——— */

const GIANT_BANDS: Record<SudarskyClass, Array<[number, number, number]>> = {
  I: [[0.86, 0.78, 0.64], [0.74, 0.6, 0.44], [0.58, 0.42, 0.3], [0.4, 0.28, 0.2]],
  II: [[0.93, 0.93, 0.94], [0.84, 0.85, 0.88], [0.72, 0.75, 0.8], [0.6, 0.63, 0.7]],
  III: [[0.38, 0.52, 0.78], [0.3, 0.44, 0.7], [0.22, 0.35, 0.6], [0.15, 0.25, 0.48]],
  IV: [[0.32, 0.24, 0.22], [0.24, 0.17, 0.16], [0.17, 0.11, 0.11], [0.1, 0.07, 0.07]],
  V: [[0.6, 0.5, 0.42], [0.5, 0.39, 0.31], [0.4, 0.29, 0.22], [0.28, 0.2, 0.15]],
};

function jitterBands(bands: Array<[number, number, number]>, rng: Rng, amt = 0.08): Array<[number, number, number]> {
  const h = [rng.range(-amt, amt), rng.range(-amt, amt), rng.range(-amt, amt)];
  return bands.map((b) => [clamp(b[0] * (1 + h[0]), 0, 1), clamp(b[1] * (1 + h[1]), 0, 1), clamp(b[2] * (1 + h[2]), 0, 1)] as [number, number, number]);
}

function iceGiantBands(T: number, rng: Rng): Array<[number, number, number]> {
  // Cold: methane-absorbed azure (Neptune) → cyan (Uranus); warm sub-Neptunes: photochemical haze.
  let b: Array<[number, number, number]>;
  if (T < 90) b = [[0.32, 0.52, 0.86], [0.24, 0.42, 0.8], [0.17, 0.33, 0.7], [0.12, 0.25, 0.58]];
  else if (T < 250) b = [[0.62, 0.8, 0.84], [0.56, 0.76, 0.81], [0.5, 0.72, 0.78], [0.46, 0.68, 0.76]];
  else if (T < 700) b = [[0.74, 0.76, 0.7], [0.66, 0.69, 0.64], [0.58, 0.61, 0.57], [0.5, 0.52, 0.5]];
  else b = [[0.55, 0.45, 0.38], [0.46, 0.37, 0.31], [0.38, 0.3, 0.25], [0.3, 0.23, 0.2]];
  return jitterBands(b, rng, 0.06);
}

interface Embryo {
  a: number;
  mass: number;
  e: number;
  inc: number;
  giant: boolean;
  hot?: boolean;
  resonance?: string;
  formedOut: boolean;
}

function drawInnerMass(rng: Rng, Mstar: number): number {
  // Kepler occurrence peaks at 1–4 R⊕ (≈ 2–10 M⊕); smaller around M dwarfs.
  const mu = Math.log10(3.2) + 0.35 * Math.log10(Math.max(Mstar, 0.08));
  return clamp(10 ** rng.normal(mu, 0.42), 0.04, 28);
}

function drawGiantMass(rng: Rng, Mstar: number): number {
  // dN/dM ∝ M^−1.3 between 0.1 and 10 M♃ (Cumming et al. 2008); the disk's mass budget (∝ M★)
  // caps the largest giants around small stars.
  const hi = Math.max(0.3, Math.min(10, 6 * Mstar)) * M_JUP_EARTH;
  return rng.powerLaw(-1.3, 0.1 * M_JUP_EARTH, hi);
}

/* ——— Main entry ——— */

export function generateSystem(seed: number, hint: StarHint = {}): SystemData {
  seed = Math.floor(Math.abs(seed)) % 4294967296;
  const root = new Rng(seed + 1);
  const rs = root.fork('star');
  const feh = hint.feh ?? clamp(rs.normal(-0.05, 0.2), -0.8, 0.45);
  const star = makePrimary(rs, hint);
  const catalogue = catalogueName(seed);
  star.name = givenName(root.fork('star-name'));

  /* Companion */
  let companion: CompanionData | null = null;
  const rb = root.fork('binary');
  const Mstar = star.mass;
  const Pin = rb.logRange(1.1, 4);
  let aIn = Math.max(semiMajorAxisAU(Pin, Mstar), 3 * star.radius * R_SUN_AU);
  let aOut = 32 * Math.sqrt(Mstar) * rb.range(0.6, 1.3);
  let clearedInside = 0;
  if (star.stage === 'giant') {
    clearedInside = Math.max(1, 4 * star.radius * R_SUN_AU);
    aIn = clearedInside * 1.3;
  } else if (star.stage === 'white-dwarf') {
    // Planets inside ~2–3 AU were engulfed on the AGB; survivors' orbits grew as the star lost mass.
    clearedInside = 3;
    aIn = 3.5;
    aOut *= 2;
  }
  const wantsBinary = hint.binary ?? rb.chance(multiplicityFraction(Mstar));
  if (wantsBinary && star.stage === 'main-sequence') {
    const m2 = Math.max(0.08, Mstar * rb.range(0.1, 1));
    const comp = msStar(m2, star.ageGyr, rb.fork('comp'));
    comp.name = givenName(root.fork('comp-name'));
    const { mu: lpMu, sigma } = periodDistribution(Mstar);
    for (let tries = 0; tries < 16 && !companion; tries++) {
      const logP = clamp(rb.normal(lpMu, sigma), 0.3, 7.5);
      const P = 10 ** logP;
      const a = semiMajorAxisAU(P, Mstar + m2);
      const e = P < 12 ? 0 : P < 1000 ? rb.range(0, 0.45) : rb.range(0, 0.7);
      const mu = m2 / (Mstar + m2);
      const aS = holmanWiegertS(mu, e) * a;
      const aP = holmanWiegertP(mu, e) * a;
      const orbit: OrbitalElements = { a, e, i: rb.range(0, 3) * DEG, node: rb.range(0, 2 * Math.PI), peri: rb.range(0, 2 * Math.PI), M0: rb.range(0, 2 * Math.PI), epoch: 0 };
      if (aP * 1.15 < aOut * 0.35 && a < 1.5) {
        companion = { star: comp, orbit, periodDays: P, mu, config: 'P', critical: aP };
        aIn = Math.max(aIn, aP * rb.range(1.12, 1.5));
      } else if (aS * 0.85 > aIn * 5) {
        companion = { star: comp, orbit, periodDays: P, mu, config: 'S', critical: aS };
        aOut = Math.min(aOut, aS * 0.85);
      }
    }
  }

  /* Irradiation reference for the HZ */
  let hzL = star.luminosity;
  let hzT = star.teff;
  if (companion?.config === 'P') {
    const c = companion.star;
    hzL = star.luminosity + c.luminosity;
    hzT = (star.teff * star.luminosity + c.teff * c.luminosity) / hzL;
  }
  const hz = habitableZone(hzL, hzT);
  // The snow line is set in the young disk; for evolved hosts use the main-sequence luminosity.
  const Lform = star.stage === 'main-sequence' ? hzL : msLuminosity(star.stage === 'giant' ? star.mass : 2);
  const snow = snowLineAU(Lform) * (star.stage === 'white-dwarf' ? 2 : 1);

  /* Architecture */
  const ra = root.fork('architecture');
  const embryos: Embryo[] = [];
  const isM = star.stage === 'main-sequence' && Mstar < 0.45;
  const pGiant = giantPlanetOccurrence(Mstar, feh);
  const hotJ = star.stage === 'main-sequence' && Mstar > 0.55 && companion?.config !== 'P' && ra.chance(Math.min(0.05, 0.012 * 10 ** (2 * feh)));
  const chain = !hotJ && isM && companion?.config !== 'P' && ra.chance(0.3);
  const MstarPlanets = companion?.config === 'P' ? Mstar + companion.star.mass : Mstar;

  if (chain) {
    // TRAPPIST-1-like resonant chain: period ratios of small integers, migrated in the disk.
    const n = 4 + ra.int(4);
    const ratios: Array<[number, number]> = [[3, 2], [3, 2], [4, 3], [4, 3], [5, 3], [8, 5], [5, 4], [2, 1]];
    let P = ra.logRange(1.3, 2.6);
    let prevM = 0;
    for (let i = 0; i < n; i++) {
      const m = clamp(10 ** ra.normal(Math.log10(0.8), 0.22), 0.2, 3);
      let res: string | undefined;
      if (i > 0) {
        const [p, q] = ra.pick(ratios);
        P *= p / q;
        res = `${p}:${q}`;
      }
      const a = semiMajorAxisAU(P, MstarPlanets);
      if (a > aOut) break;
      embryos.push({ a, mass: m, e: rayleigh(ra, 0.005), inc: rayleigh(ra, 0.25 * DEG), giant: false, resonance: res, formedOut: ra.chance(0.3) });
      prevM = m;
    }
    void prevM;
    // Sometimes a cold giant far out.
    if (ra.chance(pGiant * 1.5)) {
      const a = Math.max(snow * ra.range(1, 3), embryos[embryos.length - 1].a * 4);
      if (a < aOut) embryos.push({ a, mass: drawGiantMass(ra, Mstar), e: rayleigh(ra, 0.15), inc: rayleigh(ra, 1.5 * DEG), giant: true, formedOut: true });
    }
  } else {
    let a = aIn;
    let prev: Embryo | null = null;
    if (hotJ) {
      const P = ra.logRange(2.4, 6);
      const m = ra.powerLaw(-1.3, 0.3 * M_JUP_EARTH, 5 * M_JUP_EARTH);
      prev = { a: semiMajorAxisAU(P, MstarPlanets), mass: m, e: 0, inc: rayleigh(ra, 1 * DEG), giant: true, hot: true, formedOut: true };
      embryos.push(prev);
      // Hot Jupiters are lonely: high-eccentricity migration clears the inner system.
      a = Math.max(snow * 0.6, 0.8);
      prev = null;
    }
    const nMax = hotJ ? ra.int(3) : isM ? 2 + ra.int(6) : 2 + ra.int(7);
    let giantMade = false;
    const Delta = () => ra.range(10, 25);
    for (let guard = 0; guard < 30 && embryos.length < nMax + (hotJ ? 1 : 0); guard++) {
      const outer = (prev ? prev.a : a) > snow * 0.9;
      let m: number;
      let giant = false;
      if (outer) {
        const pg = giantMade ? 0.45 : clamp(pGiant * 2.2, 0.05, 0.85);
        if (ra.chance(pg)) {
          m = drawGiantMass(ra, Mstar);
          giant = true;
        } else if (ra.chance(0.45)) m = ra.logRange(6, 30);
        else m = clamp(10 ** ra.normal(0.1, 0.45), 0.05, 12);
      } else if (ra.chance(pGiant * 0.25)) {
        m = drawGiantMass(ra, Mstar); // warm Jupiter
        giant = true;
      } else m = drawInnerMass(ra, Mstar);
      let na = prev ? nextHillSpacedOrbit(prev.a, prev.mass, m, Delta(), MstarPlanets) : a;
      if (prev && ra.chance(0.2)) na *= ra.range(1.1, 1.8); // gaps happen
      if (na > aOut) break;
      const emb: Embryo = { a: na, mass: m, e: 0, inc: rayleigh(ra, 1.2 * DEG), giant, formedOut: na > snow };
      giantMade ||= giant;
      embryos.push(emb);
      prev = emb;
    }
    // Eccentricities: compact multis are nearly circular; lonely giants are eccentric.
    const lonely = embryos.length <= 2;
    for (const e of embryos) if (!e.hot) e.e = rayleigh(ra, e.giant ? (lonely ? 0.22 : 0.08) : 0.025);
  }
  if (embryos.length === 0) {
    // Degenerate draw (e.g. binary truncation): one planet at the inner edge.
    embryos.push({ a: aIn * 1.2, mass: drawInnerMass(ra, Mstar), e: 0.01, inc: 0, giant: false, formedOut: false });
  }
  embryos.sort((x, y) => x.a - y.a);
  // Binary stability applies to the whole orbit: pericentre beyond a_c (P-type), apocentre inside (S-type).
  if (companion) {
    const c = companion.critical;
    for (const e of embryos) {
      if (companion.config === 'P') e.e = Math.min(e.e, Math.max(0, 1 - (1.05 * c) / e.a));
      else e.e = Math.min(e.e, Math.max(0, (0.95 * c) / e.a - 1));
    }
  }
  // Orbits must not cross: pericentre of the outer beyond apocentre of the inner by ≥ 3 Hill radii.
  for (let i = 0; i < embryos.length - 1; i++) {
    const A = embryos[i], B = embryos[i + 1];
    for (let k = 0; k < 20; k++) {
      const gap = B.a * (1 - B.e) - A.a * (1 + A.e) - 3 * (hillRadius(A.a, 0, A.mass, MstarPlanets) + hillRadius(B.a, 0, B.mass, MstarPlanets));
      if (gap > 0) break;
      A.e *= 0.6;
      B.e *= 0.6;
    }
  }

  /* Planets */
  const planets: PlanetData[] = [];
  const muC = GM_SUN_AU_DAY * MstarPlanets;
  const xuv = star.teff < 3900 ? 5 : star.teff < 5000 ? 2 : 1;
  const sysNode = ra.range(0, 2 * Math.PI);
  embryos.forEach((emb, index) => {
    const rp = root.fork('planet', index);
    const S = insolation(hzL, emb.a);
    const Pdays = periodDays(emb.a, MstarPlanets);
    const m = emb.mass;
    const waterRich = emb.formedOut || rp.chance(m > 2 ? 0.2 : 0.08);
    // Class
    let cls: PlanetClass;
    if (m >= 50) cls = 'gas-giant';
    else if (m >= 2.04) {
      if (emb.formedOut && m >= 6 && emb.a > snow * 0.5) cls = 'ice-giant';
      else {
        // Radius valley: strong irradiation strips the H/He envelopes of low-mass cores.
        const stripped = S > 60 * (m / 4) ** 2 * rp.range(0.5, 1.5);
        cls = stripped ? 'super-earth' : waterRich && rp.chance(0.5) ? 'water-world' : 'sub-neptune';
      }
    } else cls = waterRich && emb.a > snow ? 'icy' : 'rocky';

    // Albedo guess by class (refined below for kind), T_eq, radius.
    const T0 = 278.3 * Math.pow(S, 0.25); // zero-albedo T_eq; T_eq = T0 (1−A)^¼
    const sud = cls === 'gas-giant' ? sudarskyClass(T0 * Math.pow(0.7, 0.25)) : null;
    let R: number;
    const scatter = 1 + rp.normal(0, 0.035);
    if (cls === 'gas-giant') {
      R = massRadius(m, true);
      const Tq = T0 * 0.9;
      if (Tq > 1000) R *= 1 + 0.35 * clamp((Tq - 1000) / 1000, 0, 1); // inflated hot Jupiters
    } else if (cls === 'sub-neptune') {
      // A few % of H/He by mass puffs a rocky core up to 2–3 R⊕ (Lopez & Fortney 2014); the
      // forecaster's mean is continuous with rocky planets at 2 M⊕ and under-predicts that.
      R = Math.max(massRadius(m), 2.2 * Math.pow(m / 6, 0.25));
    } else if (cls === 'ice-giant') R = massRadius(m);
    else if (cls === 'water-world') R = 1.25 * Math.pow(m, 0.27);
    else if (cls === 'icy') R = 1.15 * Math.pow(m, 0.279);
    else R = Math.pow(m, 0.279);
    R *= scatter;

    const atmosphere = cls === 'gas-giant' || cls === 'ice-giant' || cls === 'sub-neptune' || (m > 0.06 && keepsAtmosphere(m, R, S, xuv));
    const gaseous = cls === 'gas-giant' || cls === 'ice-giant' || cls === 'sub-neptune';
    const lockT = tidalLockTimeYears(m, R, emb.a, MstarPlanets, gaseous);
    const locked = lockT < star.ageGyr * 1e9;
    const status = hzStatus(S, hzT);
    // Tidal circularisation (Goldreich & Soter 1966): τ_e = (4/63) (Q/k₂) (m/M★) (a/R)⁵ / n.
    {
      const Qk = gaseous ? 1e5 / 0.4 : 100 / 0.3;
      const aR = (emb.a * 1.495978707e8) / (R * R_EARTH_KM);
      const n = (2 * Math.PI) / (Pdays * 86400);
      const tauYears = ((4 / 63) * Qk * ((m * 3.003e-6) / MstarPlanets) * Math.pow(aR, 5)) / n / 3.156e7;
      emb.e *= Math.exp(-Math.min(50, (star.ageGyr * 1e9) / tauYears));
    }

    // Kind
    let kind: PlanetKind;
    let albedo: number;
    let surfaceTemp: number;
    const spec: Omit<PlanetSpec, 'radius'> = { seed: (seed * 31 + index * 7919) % 100000, kind: 'barren', radiusKm: R * R_EARTH_KM, detail: 1 };
    let composition = '';
    if (cls === 'gas-giant') {
      kind = 'gas-giant';
      albedo = SUDARSKY_ALBEDO[sud!];
      composition = `H/He envelope · ${SUDARSKY_TEXT[sud!]}`;
    } else if (cls === 'ice-giant' || cls === 'sub-neptune') {
      kind = 'ice-giant';
      albedo = 0.3;
      composition = cls === 'ice-giant' ? 'Water–ammonia–methane mantle under H/He' : 'Rocky core, a few % H/He by mass';
    } else {
      const Teq0 = T0 * Math.pow(0.7, 0.25);
      if (!atmosphere) {
        kind = Teq0 > 750 ? 'lava' : (cls === 'icy' || waterRich) && Teq0 < 180 ? 'ice' : 'barren';
      } else if (Teq0 > 900) kind = 'lava';
      else if (status === 'too hot') kind = 'venus';
      else if (status === 'optimistic inner HZ') kind = !waterRich && rp.chance(0.5) ? 'desert' : 'venus';
      else if (status === 'habitable zone') kind = cls === 'water-world' || (waterRich && rp.chance(0.6)) ? 'ocean' : m < 0.25 ? 'desert' : 'terrestrial';
      else if (status === 'optimistic outer HZ') kind = m > 0.4 && waterRich ? 'terrestrial' : rp.chance(0.5) ? 'desert' : 'ice';
      // Cold and dry: a Mars-like rust desert down to ~120 K; colder, volatile frosts and a
      // collapsed atmosphere leave bare, dark rock (Pluto/Triton-like surfaces are 'ice').
      else kind = waterRich || rp.chance(0.5) ? 'ice' : Teq0 > 120 ? 'desert' : 'barren';
      albedo = { lava: 0.1, ice: 0.62, barren: 0.12, venus: 0.75, desert: 0.25, terrestrial: 0.3, ocean: 0.28 }[kind as 'lava'] ?? 0.3;
      composition =
        cls === 'water-world' ? 'Rock and iron under a deep global water layer'
        : cls === 'icy' ? 'Rock and water ice'
        : cls === 'super-earth' ? 'Bare rocky core (envelope photo-evaporated)'
        : 'Iron core, silicate mantle';
    }
    const teq = T0 * Math.pow(1 - albedo, 0.25);
    const greenhouse = !atmosphere ? 0 : kind === 'terrestrial' || kind === 'ocean' ? 33 * Math.pow(Math.max(m, 0.2), 0.25) : kind === 'venus' ? teq * 1.9 : kind === 'desert' ? 6 : kind === 'ice' ? 8 : 0;
    surfaceTemp = teq + greenhouse;
    if (atmosphere && (kind === 'terrestrial' || kind === 'ocean') && status === 'habitable zone') {
      // Inside the HZ the carbonate–silicate cycle regulates CO₂ (Walker, Hays & Kasting 1981):
      // the Kopparapu limits assume ~273 K at the outer edge rising toward the inner one.
      const x = clamp((S - hzFlux('maxGreenhouse', hzT)) / (hzFlux('runaway', hzT) - hzFlux('maxGreenhouse', hzT)), 0, 1);
      surfaceTemp = 273 + 25 * Math.pow(x, 1.5) + rp.range(-3, 3);
    }

    // Spin
    let rotationHours: number;
    let spinOrbit: PlanetData['spinOrbit'] = null;
    if (locked) {
      if (!gaseous && emb.e > 0.1) {
        spinOrbit = '3:2';
        rotationHours = (Pdays * 24 * 2) / 3;
      } else {
        spinOrbit = '1:1';
        rotationHours = Pdays * 24;
      }
    } else if (kind === 'venus' && rp.chance(0.5)) rotationHours = -rp.logRange(600, 6000);
    else rotationHours = gaseous ? rp.logRange(8, 18) : rp.logRange(10, 60);
    const dayHours = spinOrbit === '1:1' ? Infinity : solarDay(rotationHours, Pdays * 24);
    const axialTilt = locked ? rp.range(0, 1.5) * DEG : rp.chance(0.06) ? rp.range(60, 110) * DEG : Math.min(Math.abs(rp.normal(0, 22)), 50) * DEG;
    const eyeball = spinOrbit === '1:1' && (kind === 'terrestrial' || kind === 'ocean' || (kind === 'ice' && status !== 'too cold'));
    if (eyeball && kind === 'ice') kind = 'ocean';
    if (eyeball) surfaceTemp = Math.max(surfaceTemp, 278); // the open pupil is liquid water

    // Spec
    spec.kind = kind;
    spec.temperatureK = surfaceTemp;
    spec.axialTilt = axialTilt;
    switch (kind) {
      case 'gas-giant': {
        spec.atmosphere = { preset: 'jupiter' };
        spec.bands = jitterBands(GIANT_BANDS[sud!], rp);
        spec.storm = rp.chance(0.5);
        spec.temperatureK = teq;
        spec.oblateness = flattening(m, R, rotationHours);
        break;
      }
      case 'ice-giant':
        spec.atmosphere = { preset: 'ice-giant' };
        spec.bands = iceGiantBands(teq, rp);
        spec.storm = rp.chance(0.4);
        spec.temperatureK = teq;
        spec.oblateness = Math.min(0.05, flattening(m, R, rotationHours));
        break;
      case 'terrestrial':
        spec.atmosphere = {};
        spec.oceanFraction = rp.range(0.35, 0.85);
        spec.clouds = rp.range(0.4, 0.75);
        spec.vegetation = star.ageGyr > 1 && surfaceTemp > 255 && surfaceTemp < 315 ? rp.range(0.25, 0.9) : 0;
        spec.cityLights = spec.vegetation > 0.3 && rp.chance(0.04) ? rp.range(0.35, 0.8) : 0;
        spec.ice = 0.3;
        break;
      case 'ocean':
        spec.atmosphere = { mie: 70 };
        spec.oceanFraction = rp.range(0.94, 0.995);
        spec.clouds = eyeball ? rp.range(0.25, 0.4) : rp.range(0.5, 0.8);
        spec.ice = 0.3;
        break;
      case 'desert':
        spec.atmosphere = { preset: 'mars', mie: rp.range(40, 140) };
        spec.ice = rp.range(0, 0.35);
        spec.color = rp.chance(0.7) ? [rp.range(1.1, 1.3), rp.range(0.95, 1.08), rp.range(0.72, 0.86)] : [rp.range(0.9, 1.05), rp.range(0.9, 1.0), rp.range(0.88, 0.98)];
        spec.craters = rp.range(0.2, 0.6);
        break;
      case 'venus':
        spec.atmosphere = { preset: 'venus' };
        break;
      case 'lava':
        spec.atmosphere = null;
        spec.lavaTemperatureK = clamp(1200 + teq * 0.5, 1300, 2200);
        spec.temperatureK = Math.max(teq, 800);
        break;
      case 'ice':
        if (!atmosphere) spec.atmosphere = null;
        else if (teq < 110 && m > 0.08 && rp.chance(0.4)) {
          spec.atmosphere = { preset: 'titan' };
          spec.color = [0.8, 0.62, 0.4];
        } else {
          spec.atmosphere = {};
          spec.clouds = rp.range(0.1, 0.35);
        }
        spec.color ??= [rp.range(0.92, 1.05), rp.range(0.95, 1.02), rp.range(0.98, 1.08)];
        break;
      default:
        spec.atmosphere = null;
        spec.craters = rp.range(0.4, 1);
        spec.color = [rp.range(0.9, 1.15), rp.range(0.88, 1.05), rp.range(0.82, 1.0)];
    }

    // Rings: icy rings need a cold planet (T < ~200 K); rocky dust rings are darker.
    const rr = rp.fork('rings');
    let rings: RingSpec | null = null;
    // Close-in rings are short-lived (sublimation, Poynting–Robertson drag, small Hill spheres).
    const ringable = emb.a > 0.3 && teq < 700;
    if (ringable && ((kind === 'gas-giant' && rr.chance(teq < 200 ? 0.4 : 0.1)) || (cls === 'ice-giant' && rr.chance(0.2)))) {
      const icy = teq < 200;
      const inner = rr.range(1.25, 1.6);
      rings = {
        inner,
        outer: inner + rr.range(0.5, 1.1),
        color: icy ? [rr.range(0.85, 0.95), rr.range(0.78, 0.88), rr.range(0.66, 0.78)] : [0.5, 0.42, 0.36],
        opacity: kind === 'ice-giant' ? rr.range(0.3, 0.6) : rr.range(0.7, 1),
        dust: rr.range(0.1, 0.4),
        seed: rr.int(1000),
      };
      spec.rings = rings;
    }

    // Moons (inside 0.4 Hill radii for prograde stability; outside the Roche limit).
    const moons: MoonData[] = [];
    const rm = rp.fork('moons');
    const rHill = hillRadius(emb.a, emb.e, m, MstarPlanets) * 1.495978707e8 / (R * R_EARTH_KM); // planet radii
    const nMoons = kind === 'gas-giant' ? 1 + rm.int(4) : kind === 'ice-giant' ? rm.int(3) : rm.chance(0.25) && m > 0.3 ? 1 : 0;
    let am = gaseous ? rm.range(5, 8) : rm.range(20, 45);
    const roman = ['I', 'II', 'III', 'IV', 'V'];
    for (let k = 0; k < nMoons; k++) {
      if (am > 0.4 * rHill) break;
      const mm = gaseous ? rm.logRange(0.002, 0.025) : m * rm.range(0.004, 0.015);
      const icyMoon = teq < 200 && gaseous;
      const rMoon = Math.pow(mm, 0.3) * (icyMoon ? 1.3 : 1);
      const PmDays = (2 * Math.PI * Math.sqrt(Math.pow(am * R * R_EARTH_KM * 1e3, 3) / (6.6743e-11 * m * 5.9722e24))) / 86400;
      const heated = gaseous && am < 8 && rm.chance(0.55);
      const mk: PlanetKind = heated ? 'lava' : icyMoon ? 'ice' : 'barren';
      const mspec: Omit<PlanetSpec, 'radius'> = {
        seed: (spec.seed * 13 + k * 101) % 100000,
        kind: mk,
        radiusKm: rMoon * R_EARTH_KM,
        atmosphere: null,
        temperatureK: heated ? 130 : teq,
        lavaTemperatureK: heated ? 1500 : undefined,
        craters: mk === 'barren' ? rm.range(0.6, 1) : 0.15,
        color: mk === 'barren' ? [rm.range(0.9, 1.1), rm.range(0.9, 1.02), rm.range(0.85, 1)] : undefined,
        detail: 1,
      };
      moons.push({
        name: `${PLANET_LETTERS[index]} ${roman[k]}`,
        mass: mm,
        radius: rMoon,
        a: am,
        periodDays: PmDays,
        M0: rm.range(0, 2 * Math.PI),
        inclination: rayleigh(rm, 0.5 * DEG),
        kind: mk,
        spec: mspec,
        note: heated ? 'Tidally heated: volcanic, like Io' : icyMoon ? 'Icy crust, perhaps an ocean beneath' : 'Cratered and airless',
      });
      am *= gaseous ? rm.range(1.55, 2.3) : 1.8;
    }

    const letter = PLANET_LETTERS[index];
    const pd: PlanetData = {
      index,
      letter,
      designation: `${catalogue} ${letter}`,
      givenName: givenName(rp.fork('name')),
      class: cls,
      kind,
      mass: m,
      radius: R,
      density: bulkDensity(m, R),
      gravity: surfaceGravity(m, R),
      escapeVelocity: escapeVelocity(m, R),
      orbit: { a: emb.a, e: emb.e, i: emb.inc, node: sysNode + rp.range(-0.3, 0.3), peri: rp.range(0, 2 * Math.PI), M0: rp.range(0, 2 * Math.PI), epoch: 0 },
      mu: muC,
      periodDays: Pdays,
      insolation: S,
      albedo,
      teq,
      surfaceTemp,
      hz: status,
      atmosphere,
      tidallyLocked: locked,
      spinOrbit,
      lockTimeYears: lockT,
      rotationHours,
      dayHours,
      axialTilt,
      eyeball,
      resonance: emb.resonance ?? null,
      sudarsky: sud,
      composition,
      description: '',
      moons,
      spec,
      waterRich,
    };
    pd.description = describePlanet(pd, star, companion);
    planets.push(pd);
  });

  /* Tags and summary */
  const tags: SystemData['tags'] = new Set();
  if (star.stage === 'main-sequence') {
    if (star.teff < 3900) tags.add('m-dwarf');
    else if (star.teff < 5300) tags.add('k-dwarf');
    else if (star.teff < 6300) tags.add('sun-like');
  }
  if (star.stage === 'giant') tags.add('giant-star');
  if (star.stage === 'white-dwarf') tags.add('white-dwarf');
  if (companion) tags.add('binary');
  if (companion?.config === 'P') {
    tags.add('circumbinary');
    if (planets.some((p) => p.atmosphere && (p.kind === 'desert' || p.kind === 'terrestrial' || p.kind === 'ocean' || p.kind === 'ice'))) tags.add('binary-sunset');
  }
  if (planets.some((p) => p.class === 'gas-giant' && p.orbit.a < 0.1)) tags.add('hot-jupiter');
  if (planets.some((p) => p.spec.rings)) tags.add('ringed-giant');
  if (planets.filter((p) => p.resonance).length >= 3) tags.add('resonant-chain');
  if (planets.some((p) => p.hz === 'habitable zone' && (p.kind === 'terrestrial' || p.kind === 'ocean'))) tags.add('habitable');
  if (planets.some((p) => p.eyeball)) tags.add('eyeball');

  const sys: SystemData = {
    seed,
    catalogue,
    name: star.name,
    star,
    companion,
    metallicity: feh,
    hzLuminosity: hzL,
    hzTeff: hzT,
    hz,
    snowLine: snow,
    planets,
    distancePc: Math.round(root.fork('dist').logRange(4, 400) * 10) / 10,
    tags,
    clearedInside,
    summary: '',
  };
  sys.summary = describeSystem(sys);
  return sys;
}

/* ——— Descriptions ——— */

function starWord(s: StarData): string {
  if (s.stage === 'giant') return 'red giant';
  if (s.stage === 'white-dwarf') return 'white dwarf';
  if (s.teff < 3900) return 'red dwarf';
  if (s.teff < 5300) return 'orange dwarf';
  if (s.teff < 6000) return 'yellow dwarf';
  if (s.teff < 7500) return 'yellow-white star';
  return 'white star';
}

function describePlanet(p: PlanetData, star: StarData, comp: CompanionData | null): string {
  const sun = comp?.config === 'P' ? 'two suns' : `its ${starWord(star)}`;
  const parts: string[] = [];
  switch (p.kind) {
    case 'gas-giant':
      parts.push(p.orbit.a < 0.1 ? `A hot Jupiter, ${p.periodDays < 4 ? 'whipping' : 'racing'} around ${sun} every ${p.periodDays.toFixed(1)} days` : p.teq < 150 ? 'A cold gas giant banded with ammonia clouds' : `A gas giant (${SUDARSKY_TEXT[p.sudarsky!]})`);
      break;
    case 'ice-giant':
      parts.push(p.class === 'sub-neptune' ? 'A sub-Neptune — the most common kind of planet in the Galaxy, and absent from ours' : 'An ice giant veiled in methane');
      break;
    case 'terrestrial':
      parts.push(p.hz === 'habitable zone' ? 'A temperate rocky world with oceans and weather' : 'A cold rocky world, oceans locked under broad ice sheets');
      break;
    case 'ocean':
      parts.push(p.class === 'water-world' ? 'A water world: a global ocean hundreds of kilometres deep' : 'An ocean planet with scattered islands');
      break;
    case 'desert':
      parts.push('A dry, dusty world under a thin sky');
      break;
    case 'venus':
      parts.push('A runaway greenhouse: its oceans boiled away beneath sulphuric clouds');
      break;
    case 'lava':
      parts.push(p.teq > 900 ? 'A lava world whose day side is a magma ocean' : 'A volcanic world, resurfaced by its own heat');
      break;
    case 'ice':
      parts.push(p.spec.atmosphere && (p.spec.atmosphere as { preset?: string }).preset === 'titan' ? 'A frozen world under orange hydrocarbon haze, like Titan' : p.atmosphere ? 'A snowball: water frozen from pole to pole' : 'An airless ball of ice and rock');
      break;
    default:
      parts.push('An airless, cratered world');
  }
  if (p.eyeball) parts.push(`Tidally locked, it is an "eyeball": open water beneath a fixed noon, ice across the night side`);
  else if (p.spinOrbit === '3:2') parts.push('Tides hold it in a 3:2 spin–orbit resonance, like Mercury');
  else if (p.spinOrbit === '1:1' && p.kind !== 'gas-giant') parts.push('One face always turned to the star');
  if (p.resonance) parts.push(`In a ${p.resonance} resonance with its inner neighbour`);
  if (p.spec.rings) parts.push('Ringed');
  if (p.moons.length) parts.push(`${p.moons.length} large moon${p.moons.length > 1 ? 's' : ''}`);
  if (p.spec.cityLights) parts.push('Its night side glows with lights no geology explains');
  return parts.join('. ') + '.';
}

function describeSystem(s: SystemData): string {
  const star = s.star;
  const host = `${star.spectralType} ${starWord(star)}`;
  const comp = s.companion;
  let pre = `A ${host}`;
  if (comp) pre += comp.config === 'P' ? ` in a ${comp.periodDays.toFixed(comp.periodDays < 10 ? 1 : 0)}-day embrace with a ${comp.star.spectralType} companion` : ` with a ${comp.star.spectralType} companion ${comp.orbit.a.toFixed(comp.orbit.a < 10 ? 1 : 0)} AU away`;
  const n = s.planets.length;
  const words = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  let tail = `, ${words[n] ?? n} planet${n === 1 ? '' : 's'}`;
  if (s.tags.has('resonant-chain')) tail += ' locked in a resonant chain';
  if (s.tags.has('hot-jupiter')) tail += ', one a hot Jupiter';
  if (s.tags.has('habitable')) tail += ', one in the habitable zone';
  if (star.stage === 'giant') tail += '; the inner system has been swallowed';
  if (star.stage === 'white-dwarf') tail += ' that survived their star’s death';
  return pre + tail + '.';
}

/* ——— Positions ——— */

/** Seed search: first seed ≥ start whose system carries `feature`. */
export function findSeed(feature: SystemFeature, start: number, maxTries = 4000): number {
  for (let k = 0; k < maxTries; k++) {
    const s = (start + k * 7919) % 4294967296;
    const sys = generateSystem(s);
    if (sys.tags.has(feature)) return s;
  }
  return start;
}

/** Stellar radius in AU. */
export const starRadiusAU = (s: StarData) => s.radius * R_SUN_AU;

/** Angular radius (rad) of a star seen from distance d (AU). */
export const angularRadius = (s: StarData, dAU: number) => Math.asin(Math.min(1, starRadiusAU(s) / dAU));

/** GM of both stars, AU³/day² (for the binary's relative orbit). */
export const binaryMu = (sys: SystemData) => GM_SUN_AU_DAY * (sys.star.mass + (sys.companion?.star.mass ?? 0));

export { substellarTemperature, hzFlux };
