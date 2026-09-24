/**
 * Major-planet positions from E. M. Standish (JPL), "Keplerian Elements for Approximate Positions
 * of the Major Planets" (https://ssd.jpl.nasa.gov/planets/approx_pos.html):
 *   Table 1  — 1800 AD … 2050 AD, elements + linear rates (fit to DE405).
 *   Table 2a — 3000 BC … 3000 AD, elements + rates; Table 2b — extra mean-anomaly terms
 *              b·T² + c·cos(fT) + s·sin(fT) for Jupiter … Pluto.
 * Frame: J2000 mean ecliptic and equinox, heliocentric. "Earth" here is the Earth–Moon barycentre.
 * Algorithm (Standish §8): ω = ϖ − Ω, M = L − ϖ (+ Table 2b terms), solve Kepler, rotate
 * Rz(Ω)·Rx(I)·Rz(ω). Stated accuracy (Table 1): arcseconds to a few arcminutes (Saturn ~ 600″).
 */
import * as THREE from 'three';
import { solveKepler } from '../../../physics/kepler';
import { DEG } from '../frames';

export type PlanetKey = 'mercury' | 'venus' | 'emb' | 'mars' | 'jupiter' | 'saturn' | 'uranus' | 'neptune' | 'pluto';
export const PLANET_KEYS: readonly PlanetKey[] = ['mercury', 'venus', 'emb', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto'];

/** [a, e, I, L, ϖ, Ω] at J2000 followed by their rates per Julian century (AU, deg). */
type Row = readonly [number, number, number, number, number, number, number, number, number, number, number, number];

const TABLE1: Record<PlanetKey, Row> = {
  mercury: [0.38709927, 0.20563593, 7.00497902, 252.2503235, 77.45779628, 48.33076593, 0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081],
  venus: [0.72333566, 0.00677672, 3.39467605, 181.9790995, 131.60246718, 76.67984255, 0.0000039, -0.00004107, -0.0007889, 58517.81538729, 0.00268329, -0.27769418],
  emb: [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0, 0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0],
  mars: [1.52371034, 0.0933941, 1.84969142, -4.55343205, -23.94362959, 49.55953891, 0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343],
  jupiter: [5.202887, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909, -0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106],
  saturn: [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448, -0.0012506, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794],
  uranus: [19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.9542763, 74.01692503, -0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589],
  neptune: [30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574, 0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664],
  pluto: [39.48211675, 0.2488273, 17.14001206, 238.92903833, 224.06891629, 110.30393684, -0.00031596, 0.0000517, 0.00004818, 145.20780515, -0.04062942, -0.01183482],
};

const TABLE2: Record<PlanetKey, Row> = {
  mercury: [0.38709843, 0.20563661, 7.00559432, 252.25166724, 77.45771895, 48.33961819, 0.0, 0.00002123, -0.00590158, 149472.67486623, 0.15940013, -0.12214182],
  venus: [0.72332102, 0.00676399, 3.39777545, 181.9797085, 131.76755713, 76.67261496, -0.00000026, -0.00005107, 0.00043494, 58517.8156026, 0.05679648, -0.27274174],
  emb: [1.00000018, 0.01673163, -0.00054346, 100.46691572, 102.93005885, -5.11260389, -0.00000003, -0.00003661, -0.01337178, 35999.37306329, 0.3179526, -0.24123856],
  mars: [1.52371243, 0.09336511, 1.85181869, -4.56813164, -23.91744784, 49.71320984, 0.00000097, 0.00009149, -0.00724757, 19140.29934243, 0.45223625, -0.26852431],
  jupiter: [5.20248019, 0.0485359, 1.29861416, 34.33479152, 14.27495244, 100.29282654, -0.00002864, 0.00018026, -0.00322699, 3034.90371757, 0.18199196, 0.13024619],
  saturn: [9.54149883, 0.05550825, 2.49424102, 50.07571329, 92.86136063, 113.63998702, -0.00003065, -0.00032044, 0.00451969, 1222.11494724, 0.54179478, -0.25015002],
  uranus: [19.18797948, 0.0468574, 0.77298127, 314.20276625, 172.43404441, 73.96250215, -0.00020455, -0.0000155, -0.00180155, 428.49512595, 0.09266985, 0.05739699],
  neptune: [30.06952752, 0.00895439, 1.7700552, 304.22289287, 46.68158724, 131.78635853, 0.00006447, 0.00000818, 0.000224, 218.46515314, 0.01009938, -0.00606302],
  pluto: [39.48686035, 0.24885238, 17.1410426, 238.96535011, 224.09702598, 110.30167986, 0.00449751, 0.00006016, 0.00000501, 145.18042903, -0.00968827, -0.00809981],
};

/** Table 2b: [b, c, s, f] (deg, deg, deg, deg per century). */
const TABLE2B: Partial<Record<PlanetKey, readonly [number, number, number, number]>> = {
  jupiter: [-0.00012452, 0.0606406, -0.35635438, 38.35125],
  saturn: [0.00025899, -0.13434469, 0.87320147, 38.35125],
  uranus: [0.00058331, -0.97731848, 0.17689245, 7.67025],
  neptune: [-0.00041348, 0.68346318, -0.10162547, 7.67025],
  pluto: [-0.01262724, 0, 0, 0],
};

/** Table 1 validity in Julian centuries from J2000: 1800-01-01 … 2050-12-31. */
const T1_MIN = -2.0;
const T1_MAX = 0.51;
/** Blend width (centuries) when leaving Table 1, so positions never jump. */
const BLEND = 0.05;

export interface PlanetElements {
  /** AU */
  a: number;
  e: number;
  /** radians */
  i: number;
  node: number;
  peri: number;
  /** Mean anomaly, radians. */
  M: number;
  /** Mean motion, rad/day. */
  n: number;
}

function elementsFrom(row: Row, key: PlanetKey, T: number, useB: boolean, out: PlanetElements): PlanetElements {
  const a = row[0] + row[6] * T;
  const e = row[1] + row[7] * T;
  const I = row[2] + row[8] * T;
  const L = row[3] + row[9] * T;
  const varpi = row[4] + row[10] * T;
  const Om = row[5] + row[11] * T;
  let M = L - varpi;
  let dMdT = row[9] - row[10];
  if (useB) {
    const x = TABLE2B[key];
    if (x) {
      const [b, c, s, f] = x;
      M += b * T * T + c * Math.cos(f * T * DEG) + s * Math.sin(f * T * DEG);
      dMdT += 2 * b * T + (-c * Math.sin(f * T * DEG) + s * Math.cos(f * T * DEG)) * f * DEG;
    }
  }
  out.a = a;
  out.e = e;
  out.i = I * DEG;
  out.node = Om * DEG;
  out.peri = (varpi - Om) * DEG;
  out.M = M * DEG;
  // Anomalistic mean motion dM/dt (the slow rotation of the ellipse, ϖ̇ ≈ 10⁻⁵ of it, is neglected).
  out.n = (dMdT * DEG) / 36525;
  return out;
}

/** Osculating-like elements of a planet at jd (TT). Uses Table 1 within 1800–2050, Table 2 outside. */
export function planetElements(key: PlanetKey, jd: number, out: PlanetElements = { a: 1, e: 0, i: 0, node: 0, peri: 0, M: 0, n: 0 }): PlanetElements {
  const T = (jd - 2451545.0) / 36525;
  const inside = T >= T1_MIN && T <= T1_MAX;
  return inside ? elementsFrom(TABLE1[key], key, T, false, out) : elementsFrom(TABLE2[key], key, T, true, out);
}

const _el: PlanetElements = { a: 1, e: 0, i: 0, node: 0, peri: 0, M: 0, n: 0 };
const _el2: PlanetElements = { a: 1, e: 0, i: 0, node: 0, peri: 0, M: 0, n: 0 };
const _v2 = new THREE.Vector3();
const _p2 = new THREE.Vector3();

/** Heliocentric position (AU) and optional velocity (AU/day) from elements, astro axes. */
export function elementsToState(el: PlanetElements, out: THREE.Vector3, vel?: THREE.Vector3): THREE.Vector3 {
  const { a, e } = el;
  const E = solveKepler(el.M, e);
  const cE = Math.cos(E);
  const sE = Math.sin(E);
  const sq = Math.sqrt(1 - e * e);
  const xp = a * (cE - e);
  const yp = a * sq * sE;
  const cO = Math.cos(el.node), sO = Math.sin(el.node);
  const ci = Math.cos(el.i), si = Math.sin(el.i);
  const cw = Math.cos(el.peri), sw = Math.sin(el.peri);
  const r11 = cO * cw - sO * sw * ci, r12 = -cO * sw - sO * cw * ci;
  const r21 = sO * cw + cO * sw * ci, r22 = -sO * sw + cO * cw * ci;
  const r31 = sw * si, r32 = cw * si;
  out.set(r11 * xp + r12 * yp, r21 * xp + r22 * yp, r31 * xp + r32 * yp);
  if (vel) {
    const k = (a * el.n) / (1 - e * cE);
    const vx = -k * sE;
    const vy = k * sq * cE;
    vel.set(r11 * vx + r12 * vy, r21 * vx + r22 * vy, r31 * vx + r32 * vy);
  }
  return out;
}

/**
 * Heliocentric J2000-ecliptic position (astro axes, AU) of a planet (or the Earth–Moon barycentre)
 * at jd (TT), with optional velocity (AU/day). Continuous across the Table 1 / Table 2 boundary.
 */
export function planetPosition(key: PlanetKey, jd: number, out: THREE.Vector3, vel?: THREE.Vector3): THREE.Vector3 {
  const T = (jd - 2451545.0) / 36525;
  const inside = T >= T1_MIN && T <= T1_MAX;
  if (inside) {
    elementsFrom(TABLE1[key], key, T, false, _el);
    return elementsToState(_el, out, vel);
  }
  elementsFrom(TABLE2[key], key, T, true, _el);
  elementsToState(_el, out, vel);
  // Blend from Table 1 over BLEND centuries beyond its edges (both are fits to the same ephemeris).
  const d = T < T1_MIN ? T1_MIN - T : T - T1_MAX;
  if (d < BLEND) {
    const w = 1 - d / BLEND;
    const k = w * w * (3 - 2 * w);
    elementsFrom(TABLE1[key], key, T, false, _el2);
    elementsToState(_el2, _p2, vel ? _v2 : undefined);
    out.lerp(_p2, k);
    if (vel) vel.lerp(_v2, k);
  }
  return out;
}

/** Sidereal period in days implied by the mean-longitude rate of Table 1. */
export function siderealPeriodDays(key: PlanetKey): number {
  return (360 / TABLE1[key][9]) * 36525;
}

/** Semi-major axis (AU) at J2000 from Table 1. */
export function semiMajorAxis(key: PlanetKey): number {
  return TABLE1[key][0];
}

/** Mean motion (deg/day) of the mean longitude, Table 1. */
export function meanMotionDegPerDay(key: PlanetKey): number {
  return TABLE1[key][9] / 36525;
}

/** Mean longitude (deg) at jd from Table 1 (used to lock resonant populations to their planet). */
export function meanLongitudeDeg(key: PlanetKey, jd: number): number {
  const T = (jd - 2451545.0) / 36525;
  const r = TABLE1[key];
  return r[3] + r[9] * T;
}
