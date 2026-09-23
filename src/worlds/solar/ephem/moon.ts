/**
 * Geocentric Moon from the truncated ELP-2000/82 lunar theory as given by J. Meeus,
 * "Astronomical Algorithms" (2nd ed., 1998), chapter 47: tables 47.A (longitude, distance) and
 * 47.B (latitude), 60 periodic terms each, plus the additive Venus/Jupiter/flattening terms.
 * Accuracy ≈ 10″ in longitude, 4″ in latitude. Output is referred to the mean ecliptic and
 * equinox *of date*; `moonGeocentric` precesses it to J2000 (Meeus 21.5) to match the model frame.
 */
import * as THREE from 'three';
import { DEG, norm360, precessEcliptic, toThree } from '../frames';

const KM_PER_AU = 149_597_870.7;

// D, M, M′, F, Σl (1e-6 deg), Σr (1e-3 km)
// prettier-ignore
const LR: readonly number[] = [
  0, 0, 1, 0, 6288774, -20905355,  2, 0, -1, 0, 1274027, -3699111,  2, 0, 0, 0, 658314, -2955968,
  0, 0, 2, 0, 213618, -569925,  0, 1, 0, 0, -185116, 48888,  0, 0, 0, 2, -114332, -3149,
  2, 0, -2, 0, 58793, 246158,  2, -1, -1, 0, 57066, -152138,  2, 0, 1, 0, 53322, -170733,
  2, -1, 0, 0, 45758, -204586,  0, 1, -1, 0, -40923, -129620,  1, 0, 0, 0, -34720, 108743,
  0, 1, 1, 0, -30383, 104755,  2, 0, 0, -2, 15327, 10321,  0, 0, 1, 2, -12528, 0,
  0, 0, 1, -2, 10980, 79661,  4, 0, -1, 0, 10675, -34782,  0, 0, 3, 0, 10034, -23210,
  4, 0, -2, 0, 8548, -21636,  2, 1, -1, 0, -7888, 24208,  2, 1, 0, 0, -6766, 30824,
  1, 0, -1, 0, -5163, -8379,  1, 1, 0, 0, 4987, -16675,  2, -1, 1, 0, 4036, -12831,
  2, 0, 2, 0, 3994, -10445,  4, 0, 0, 0, 3861, -11650,  2, 0, -3, 0, 3665, 14403,
  0, 1, -2, 0, -2689, -7003,  2, 0, -1, 2, -2602, 0,  2, -1, -2, 0, 2390, 10056,
  1, 0, 1, 0, -2348, 6322,  2, -2, 0, 0, 2236, -9884,  0, 1, 2, 0, -2120, 5751,
  0, 2, 0, 0, -2069, 0,  2, -2, -1, 0, 2048, -4950,  2, 0, 1, -2, -1773, 4130,
  2, 0, 0, 2, -1595, 0,  4, -1, -1, 0, 1215, -3958,  0, 0, 2, 2, -1110, 0,
  3, 0, -1, 0, -892, 3258,  2, 1, 1, 0, -810, 2616,  4, -1, -2, 0, 759, -1897,
  0, 2, -1, 0, -713, -2117,  2, 2, -1, 0, -700, 2354,  2, 1, -2, 0, 691, 0,
  2, -1, 0, -2, 596, 0,  4, 0, 1, 0, 549, -1423,  0, 0, 4, 0, 537, -1117,
  4, -1, 0, 0, 520, -1571,  1, 0, -2, 0, -487, -1739,  2, 1, 0, -2, -399, 0,
  0, 0, 2, -2, -381, -4421,  1, 1, 1, 0, 351, 0,  3, 0, -2, 0, -340, 0,
  4, 0, -3, 0, 330, 0,  2, -1, 2, 0, 327, 0,  0, 2, 1, 0, -323, 1165,
  1, 1, -1, 0, 299, 0,  2, 0, 3, 0, 294, 0,  2, 0, -1, -2, 0, 8752,
];

// D, M, M′, F, Σb (1e-6 deg)
// prettier-ignore
const B: readonly number[] = [
  0, 0, 0, 1, 5128122,  0, 0, 1, 1, 280602,  0, 0, 1, -1, 277693,  2, 0, 0, -1, 173237,
  2, 0, -1, 1, 55413,  2, 0, -1, -1, 46271,  2, 0, 0, 1, 32573,  0, 0, 2, 1, 17198,
  2, 0, 1, -1, 9266,  0, 0, 2, -1, 8822,  2, -1, 0, -1, 8216,  2, 0, -2, -1, 4324,
  2, 0, 1, 1, 4200,  2, 1, 0, -1, -3359,  2, -1, -1, 1, 2463,  2, -1, 0, 1, 2211,
  2, -1, -1, -1, 2065,  0, 1, -1, -1, -1870,  4, 0, -1, -1, 1828,  0, 1, 0, 1, -1794,
  0, 0, 0, 3, -1749,  0, 1, -1, 1, -1565,  1, 0, 0, 1, -1491,  0, 1, 1, 1, -1475,
  0, 1, 1, -1, -1410,  0, 1, 0, -1, -1344,  1, 0, 0, -1, -1335,  0, 0, 3, 1, 1107,
  4, 0, 0, -1, 1021,  4, 0, -1, 1, 833,  0, 0, 1, -3, 777,  4, 0, -2, 1, 671,
  2, 0, 0, -3, 607,  2, 0, 2, -1, 596,  2, -1, 1, -1, 491,  2, 0, -2, 1, -451,
  0, 0, 3, -1, 439,  2, 0, 2, 1, 422,  2, 0, -3, -1, 421,  2, 1, -1, 1, -366,
  2, 1, 0, 1, -351,  4, 0, 0, 1, 331,  2, -1, 1, 1, 315,  2, -2, 0, -1, 302,
  0, 0, 1, 3, -283,  2, 1, 1, -1, -229,  1, 1, 0, -1, 223,  1, 1, 0, 1, 223,
  0, 1, -2, -1, -220,  2, 1, -1, -1, -220,  1, 0, 1, 1, -185,  2, -1, -2, -1, 181,
  0, 1, 2, 1, -177,  4, 0, -2, -1, 176,  4, -1, -1, -1, 166,  1, 0, 1, -1, -164,
  4, 0, 1, -1, 132,  1, 0, -1, -1, -119,  4, -1, 0, -1, 115,  2, -2, 0, 1, 107,
];

export interface LunarCoordinates {
  /** Geocentric ecliptic longitude / latitude, degrees, mean ecliptic & equinox of date. */
  lon: number;
  lat: number;
  /** Earth–Moon centre distance, km. */
  distanceKm: number;
  /** Mean arguments (deg): D elongation, M Sun anomaly, M′ Moon anomaly, F argument of latitude, Ω node. */
  D: number;
  M: number;
  Mp: number;
  F: number;
  node: number;
}

/** Meeus 47: geocentric Moon of date. `jd` is TT. */
export function moonOfDate(jd: number): LunarCoordinates {
  const T = (jd - 2451545.0) / 36525;
  const T2 = T * T, T3 = T2 * T, T4 = T3 * T;
  const Lp = norm360(218.3164477 + 481267.88123421 * T - 0.0015786 * T2 + T3 / 538841 - T4 / 65194000);
  const D = norm360(297.8501921 + 445267.1114034 * T - 0.0018819 * T2 + T3 / 545868 - T4 / 113065000);
  const M = norm360(357.5291092 + 35999.0502909 * T - 0.0001536 * T2 + T3 / 24490000);
  const Mp = norm360(134.9633964 + 477198.8675055 * T + 0.0087414 * T2 + T3 / 69699 - T4 / 14712000);
  const F = norm360(93.272095 + 483202.0175233 * T - 0.0036539 * T2 - T3 / 3526000 + T4 / 863310000);
  const A1 = norm360(119.75 + 131.849 * T);
  const A2 = norm360(53.09 + 479264.29 * T);
  const A3 = norm360(313.45 + 481266.484 * T);
  const E = 1 - 0.002516 * T - 0.0000074 * T2;
  const E2 = E * E;
  const d = D * DEG, m = M * DEG, mp = Mp * DEG, f = F * DEG;
  let sl = 0, sr = 0, sb = 0;
  for (let k = 0; k < LR.length; k += 6) {
    const cm = LR[k + 1];
    const arg = LR[k] * d + cm * m + LR[k + 2] * mp + LR[k + 3] * f;
    const e = cm === 0 ? 1 : cm === 1 || cm === -1 ? E : E2;
    if (LR[k + 4]) sl += LR[k + 4] * e * Math.sin(arg);
    if (LR[k + 5]) sr += LR[k + 5] * e * Math.cos(arg);
  }
  for (let k = 0; k < B.length; k += 5) {
    const cm = B[k + 1];
    const arg = B[k] * d + cm * m + B[k + 2] * mp + B[k + 3] * f;
    const e = cm === 0 ? 1 : cm === 1 || cm === -1 ? E : E2;
    sb += B[k + 4] * e * Math.sin(arg);
  }
  sl += 3958 * Math.sin(A1 * DEG) + 1962 * Math.sin((Lp - F) * DEG) + 318 * Math.sin(A2 * DEG);
  sb += -2235 * Math.sin(Lp * DEG) + 382 * Math.sin(A3 * DEG) + 175 * Math.sin((A1 - F) * DEG) + 175 * Math.sin((A1 + F) * DEG)
    + 127 * Math.sin((Lp - Mp) * DEG) - 115 * Math.sin((Lp + Mp) * DEG);
  const node = norm360(125.0445479 - 1934.1362891 * T + 0.0020754 * T2 + T3 / 467441 - T4 / 60616000);
  return { lon: norm360(Lp + sl / 1e6), lat: sb / 1e6, distanceKm: 385000.56 + sr / 1000, D, M, Mp, F, node };
}

/**
 * Geocentric Moon in the model frame: J2000 ecliptic, three.js axes, AU.
 * Returns the geometric position (no light-time), as JPL Horizons "geometric" vectors.
 */
export function moonGeocentric(jd: number, out: THREE.Vector3): THREE.Vector3 {
  const c = moonOfDate(jd);
  const p = precessEcliptic(c.lon, c.lat, jd, 2451545.0);
  const r = c.distanceKm / KM_PER_AU;
  const l = p.lon * DEG;
  const b = p.lat * DEG;
  const cb = Math.cos(b);
  return toThree(r * cb * Math.cos(l), r * cb * Math.sin(l), r * Math.sin(b), out);
}

/** Moon/Earth mass ratio (DE430): M☾/M⊕ = 1/81.300 569. The EMB lies μ·r from Earth's centre. */
export const MOON_EARTH_MASS_RATIO = 1 / 81.30056907;
export const EMB_MU = MOON_EARTH_MASS_RATIO / (1 + MOON_EARTH_MASS_RATIO);
