/**
 * Low-precision ephemerides for the Earth–Moon–Sun system (planets module).
 *
 *  - Sun: Meeus, "Astronomical Algorithms" (2nd ed., 1998), ch. 25 (low accuracy, ~0.01°),
 *    apparent coordinates with nutation in longitude and aberration.
 *  - Equation of time: Meeus ch. 28 (via the Sun's mean longitude and apparent right ascension).
 *  - Greenwich mean sidereal time: IAU 1982 expression, Meeus eq. 12.4.
 *  - Moon: Meeus ch. 47 (ELP-2000/82 truncated to the largest periodic terms: ≲ 0.05° in
 *    longitude, ≲ 0.02° in latitude, ≲ 100 km in distance).
 *
 * Angles are radians unless a name says otherwise. Time is a Julian Date (UT ≈ TT here;
 * the ~69 s difference is below this module's accuracy).
 */
import { DEG, J2000_JD } from './constants';

const TAU = Math.PI * 2;
const wrap = (a: number) => ((a % TAU) + TAU) % TAU;
const wrapPi = (a: number) => {
  const w = wrap(a);
  return w > Math.PI ? w - TAU : w;
};

/** Julian centuries since J2000.0. */
export const centuriesSinceJ2000 = (jd: number) => (jd - J2000_JD) / 36525;

/** Julian Date from a UTC timestamp in milliseconds. */
export const msToJD = (ms: number) => ms / 86_400_000 + 2_440_587.5;
export const jdToMs = (jd: number) => (jd - 2_440_587.5) * 86_400_000;

/** Mean obliquity of the ecliptic (IAU 1980, Meeus eq. 22.2), radians. */
export function meanObliquity(jd: number): number {
  const T = centuriesSinceJ2000(jd);
  const sec = 21.448 - T * (46.815 + T * (0.00059 - T * 0.001813));
  return (23 + (26 + sec / 60) / 60) * DEG;
}

/** Greenwich mean sidereal time (IAU 1982, Meeus eq. 12.4), radians in [0, 2π). */
export function gmst(jd: number): number {
  const T = centuriesSinceJ2000(jd);
  const deg = 280.46061837 + 360.98564736629 * (jd - J2000_JD) + T * T * (0.000387933 - T / 38710000);
  return wrap(deg * DEG);
}

export interface SunState {
  jd: number;
  /** Geometric mean longitude L0 (rad). */
  meanLongitude: number;
  /** Mean anomaly M (rad). */
  meanAnomaly: number;
  /** Apparent ecliptic longitude λ (rad, true equinox of date). */
  longitude: number;
  /** Earth–Sun distance, AU. */
  distanceAU: number;
  /** True obliquity ε used for the equatorial conversion (rad). */
  obliquity: number;
  /** Apparent right ascension α and declination δ (rad). */
  ra: number;
  dec: number;
  /** Equation of time, minutes (apparent − mean solar time; + means sundials run fast). */
  equationOfTime: number;
  /** Greenwich mean sidereal time (rad). */
  gmst: number;
  /** Geographic latitude/longitude (rad, east +) where the Sun is at the zenith. */
  subsolarLat: number;
  subsolarLon: number;
}

/** Apparent position of the Sun (Meeus ch. 25, low accuracy). */
export function sunState(jd: number): SunState {
  const T = centuriesSinceJ2000(jd);
  const L0 = wrap((280.46646 + T * (36000.76983 + T * 0.0003032)) * DEG);
  const M = wrap((357.52911 + T * (35999.05029 - T * 0.0001537)) * DEG);
  const e = 0.016708634 - T * (0.000042037 + T * 0.0000001267);
  const C =
    ((1.914602 - T * (0.004817 + T * 0.000014)) * Math.sin(M) +
      (0.019993 - T * 0.000101) * Math.sin(2 * M) +
      0.000289 * Math.sin(3 * M)) *
    DEG;
  const trueLong = L0 + C;
  const nu = M + C;
  const R = (1.000001018 * (1 - e * e)) / (1 + e * Math.cos(nu));
  const omega = (125.04 - 1934.136 * T) * DEG;
  const lambda = wrap(trueLong - 0.00569 * DEG - 0.00478 * DEG * Math.sin(omega));
  const eps = meanObliquity(jd) + 0.00256 * DEG * Math.cos(omega);
  const ra = wrap(Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda)));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  // Equation of time (Meeus eq. 28.1): E = L0 − 0.0057183° − α + Δψ cos ε.
  const dpsi = -17.2 / 3600 * DEG * Math.sin(omega);
  const E = wrapPi(L0 - 0.0057183 * DEG - ra + dpsi * Math.cos(eps));
  const g = gmst(jd);
  return {
    jd,
    meanLongitude: L0,
    meanAnomaly: M,
    longitude: lambda,
    distanceAU: R,
    obliquity: eps,
    ra,
    dec,
    equationOfTime: (E / DEG) * 4,
    gmst: g,
    subsolarLat: dec,
    subsolarLon: wrapPi(ra - g),
  };
}

// ——— Moon (Meeus ch. 47) ———
// Rows: D, M, M′, F, Σl (1e-6 °), Σr (1e-3 km).
const LR: ReadonlyArray<readonly [number, number, number, number, number, number]> = [
  [0, 0, 1, 0, 6288774, -20905355], [2, 0, -1, 0, 1274027, -3699111], [2, 0, 0, 0, 658314, -2955968],
  [0, 0, 2, 0, 213618, -569925], [0, 1, 0, 0, -185116, 48888], [0, 0, 0, 2, -114332, -3149],
  [2, 0, -2, 0, 58793, 246158], [2, -1, -1, 0, 57066, -152138], [2, 0, 1, 0, 53322, -170733],
  [2, -1, 0, 0, 45758, -204586], [0, 1, -1, 0, -40923, -129620], [1, 0, 0, 0, -34720, 108743],
  [0, 1, 1, 0, -30383, 104755], [2, 0, 0, -2, 15327, 10321], [0, 0, 1, 2, -12528, 0],
  [0, 0, 1, -2, 10980, 79661], [4, 0, -1, 0, 10675, -34782], [0, 0, 3, 0, 10034, -23210],
  [4, 0, -2, 0, 8548, -21636], [2, 1, -1, 0, -7888, 24208], [2, 1, 0, 0, -6766, 30824],
  [1, 0, -1, 0, -5163, -8379], [1, 1, 0, 0, 4987, -16675], [2, -1, 1, 0, 4036, -12831],
  [2, 0, 2, 0, 3994, -10445], [4, 0, 0, 0, 3861, -11650], [2, 0, -3, 0, 3665, 14403],
  [0, 1, -2, 0, -2689, -7003], [2, 0, -1, 2, -2602, 0], [2, -1, -2, 0, 2390, 10056],
  [1, 0, 1, 0, -2348, 6322], [2, -2, 0, 0, 2236, -9884], [0, 1, 2, 0, -2120, 5751],
  [0, 2, 0, 0, -2069, 0], [2, -2, -1, 0, 2048, -4950], [2, 0, 1, -2, -1773, 4130],
  [2, 0, 0, 2, -1595, 0], [4, -1, -1, 0, 1215, -3958], [0, 0, 2, 2, -1110, 0],
  [3, 0, -1, 0, -892, 3258], [2, 1, 1, 0, -810, 2616], [4, -1, -2, 0, 759, -1897],
  [0, 2, -1, 0, -713, -2117], [2, 2, -1, 0, -700, 2354], [2, 1, -2, 0, 691, 0],
  [2, -1, 0, -2, 596, 0], [4, 0, 1, 0, 549, -1423], [0, 0, 4, 0, 537, -1117],
  [4, -1, 0, 0, 520, -1571], [1, 0, -2, 0, -487, -1739], [2, 1, 0, -2, -399, 0],
  [0, 0, 2, -2, -381, -4421], [1, 1, 1, 0, 351, 0], [3, 0, -2, 0, -340, 0],
  [4, 0, -3, 0, 330, 0], [2, -1, 2, 0, 327, 0], [0, 2, 1, 0, -323, 1165],
  [1, 1, -1, 0, 299, 0], [2, 0, 3, 0, 294, 0], [2, 0, -1, -2, 0, 8752],
];
// Rows: D, M, M′, F, Σb (1e-6 °).
const B: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [0, 0, 0, 1, 5128122], [0, 0, 1, 1, 280602], [0, 0, 1, -1, 277693], [2, 0, 0, -1, 173237],
  [2, 0, -1, 1, 55413], [2, 0, -1, -1, 46271], [2, 0, 0, 1, 32573], [0, 0, 2, 1, 17198],
  [2, 0, 1, -1, 9266], [0, 0, 2, -1, 8822], [2, -1, 0, -1, 8216], [2, 0, -2, -1, 4324],
  [2, 0, 1, 1, 4200], [2, 1, 0, -1, -3359], [2, -1, -1, 1, 2463], [2, -1, 0, 1, 2211],
  [2, -1, -1, -1, 2065], [0, 1, -1, -1, -1870], [4, 0, -1, -1, 1828], [0, 1, 0, 1, -1794],
  [0, 0, 0, 3, -1749], [0, 1, -1, 1, -1565], [1, 0, 0, 1, -1491], [0, 1, 1, 1, -1475],
  [0, 1, 1, -1, -1410], [0, 1, 0, -1, -1344], [1, 0, 0, -1, -1335], [0, 0, 3, 1, 1107],
  [4, 0, 0, -1, 1021], [4, 0, -1, 1, 833], [0, 0, 1, -3, 777], [4, 0, -2, 1, 671],
  [2, 0, 0, -3, 607], [2, 0, 2, -1, 596], [2, -1, 1, -1, 491], [2, 0, -2, 1, -451],
  [0, 0, 3, -1, 439], [2, 0, 2, 1, 422], [2, 0, -3, -1, 421], [2, 1, -1, 1, -366],
];

export interface MoonState {
  /** Geocentric ecliptic longitude/latitude (rad, mean equinox of date). */
  longitude: number;
  latitude: number;
  /** Centre-to-centre distance, km. */
  distanceKm: number;
  /** Equatorial coordinates (rad). */
  ra: number;
  dec: number;
  /** Elongation from the Sun (rad) and illuminated fraction of the disk (0..1). */
  elongation: number;
  illuminated: number;
}

/** Geocentric position of the Moon (Meeus ch. 47, truncated series). */
export function moonState(jd: number): MoonState {
  const T = centuriesSinceJ2000(jd);
  const T2 = T * T, T3 = T2 * T, T4 = T3 * T;
  const Lp = (218.3164477 + 481267.88123421 * T - 0.0015786 * T2 + T3 / 538841 - T4 / 65194000) * DEG;
  const D = (297.8501921 + 445267.1114034 * T - 0.0018819 * T2 + T3 / 545868 - T4 / 113065000) * DEG;
  const M = (357.5291092 + 35999.0502909 * T - 0.0001536 * T2 + T3 / 24490000) * DEG;
  const Mp = (134.9633964 + 477198.8675055 * T + 0.0087414 * T2 + T3 / 69699 - T4 / 14712000) * DEG;
  const F = (93.272095 + 483202.0175233 * T - 0.0036539 * T2 - T3 / 3526000 + T4 / 863310000) * DEG;
  const A1 = (119.75 + 131.849 * T) * DEG;
  const A2 = (53.09 + 479264.29 * T) * DEG;
  const A3 = (313.45 + 481266.484 * T) * DEG;
  const E = 1 - 0.002516 * T - 0.0000074 * T2;
  let sl = 0, sr = 0, sb = 0;
  for (const [d, m, mp, f, l, r] of LR) {
    const arg = d * D + m * M + mp * Mp + f * F;
    const e = m === 0 ? 1 : Math.abs(m) === 1 ? E : E * E;
    sl += l * e * Math.sin(arg);
    sr += r * e * Math.cos(arg);
  }
  for (const [d, m, mp, f, b] of B) {
    const e = m === 0 ? 1 : Math.abs(m) === 1 ? E : E * E;
    sb += b * e * Math.sin(d * D + m * M + mp * Mp + f * F);
  }
  sl += 3958 * Math.sin(A1) + 1962 * Math.sin(Lp - F) + 318 * Math.sin(A2);
  sb += -2235 * Math.sin(Lp) + 382 * Math.sin(A3) + 175 * Math.sin(A1 - F) + 175 * Math.sin(A1 + F) + 127 * Math.sin(Lp - Mp) - 115 * Math.sin(Lp + Mp);
  const longitude = wrap(Lp + (sl / 1e6) * DEG);
  const latitude = (sb / 1e6) * DEG;
  const distanceKm = 385000.56 + sr / 1000;
  const eps = meanObliquity(jd);
  const { ra, dec } = eclipticToEquatorial(longitude, latitude, eps);
  const sun = sunState(jd);
  const cosEl = Math.cos(latitude) * Math.cos(longitude - sun.longitude);
  const elongation = Math.acos(Math.max(-1, Math.min(1, cosEl)));
  // Phase angle i (Meeus eq. 48.3) and illuminated fraction k = (1 + cos i)/2.
  const sunKm = sun.distanceAU * 149_597_870.7;
  const i = Math.atan2(sunKm * Math.sin(elongation), distanceKm - sunKm * Math.cos(elongation));
  return { longitude, latitude, distanceKm, ra, dec, elongation, illuminated: (1 + Math.cos(i)) / 2 };
}

/** Ecliptic (λ, β) → equatorial (α, δ) for obliquity ε (Meeus eq. 13.3/13.4). */
export function eclipticToEquatorial(lambda: number, beta: number, eps: number): { ra: number; dec: number } {
  const sl = Math.sin(lambda), cl = Math.cos(lambda), sb = Math.sin(beta), cb = Math.cos(beta);
  const se = Math.sin(eps), ce = Math.cos(eps);
  const ra = wrap(Math.atan2(sl * ce - (sb / cb) * se, cl));
  const dec = Math.asin(Math.max(-1, Math.min(1, sb * ce + cb * se * sl)));
  return { ra, dec };
}

/**
 * Unit vector for (α, δ) in the astronomical equatorial frame (x → equinox, z → north pole),
 * written into `out` as a plain {x,y,z}. Convert to three.js with astroToThree.
 */
export function radecToVector<T extends { x: number; y: number; z: number }>(ra: number, dec: number, out: T): T {
  const cd = Math.cos(dec);
  out.x = cd * Math.cos(ra);
  out.y = cd * Math.sin(ra);
  out.z = Math.sin(dec);
  return out;
}

/** Unit vector from the Earth's centre through a geographic point, in the rotating (Earth-fixed) astro frame. */
export function geoToVector<T extends { x: number; y: number; z: number }>(lat: number, lon: number, out: T): T {
  return radecToVector(lon, lat, out);
}

/** Solar elevation angle (rad) seen from a geographic point (lat, lon east +) at Julian Date jd. */
export function solarElevation(lat: number, lon: number, jd: number): number {
  const s = sunState(jd);
  const H = s.gmst + lon - s.ra; // local hour angle
  const sinAlt = Math.sin(lat) * Math.sin(s.dec) + Math.cos(lat) * Math.cos(s.dec) * Math.cos(H);
  return Math.asin(Math.max(-1, Math.min(1, sinAlt)));
}

/** Day of the year (0-based, fractional) for a UTC timestamp. */
export function dayOfYear(ms: number): number {
  const d = new Date(ms);
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  return (ms - start) / 86_400_000;
}

/**
 * Voyager 1 when it took the "Pale Blue Dot" frame (14 February 1990, ~04:48 UTC), from the
 * mission's published geometry: 40.47 AU from the Sun, 32° above the ecliptic, travelling toward
 * RA 17ʰ13ᵐ, Dec +12° (Ophiuchus). Earth was ~0.12 pixel in the narrow-angle camera.
 */
export const VOYAGER1_PALE_BLUE_DOT = {
  utc: Date.UTC(1990, 1, 14, 4, 48, 0),
  distanceAU: 40.47,
  ra: (17 + 13 / 60) * 15 * DEG,
  dec: 12.4 * DEG,
  /** Narrow-angle camera: 0.424° field, 800 × 800 pixels. */
  nacFieldDeg: 0.424,
  nacPixels: 800,
} as const;
