/**
 * Time scales for the solar system.
 *
 * Ephemerides are evaluated in TT (≈ TDB to within 2 ms), clocks are shown in UTC.
 *  - 1972 … 2035: TT − UTC = 32.184 s + (TAI − UTC), the leap-second table (37 s since 2017).
 *  - otherwise:   ΔT = TT − UT from the polynomial expressions of Espenak & Meeus (2006),
 *                 "Five Millennium Canon of Solar Eclipses", NASA/TP-2006-214141.
 * Julian dates follow Meeus, "Astronomical Algorithms" (2nd ed.), ch. 7 (proleptic Gregorian).
 */
import { UNIX_EPOCH_JD, J2000_JD } from '../../physics/constants';

export const DAY_S = 86_400;
export const JULIAN_CENTURY = 36_525;

/** Leap seconds: [JD (UTC) at which TAI−UTC became `value`, value]. IERS Bulletin C. */
const LEAP: ReadonlyArray<readonly [number, number]> = [
  [2441317.5, 10], [2441499.5, 11], [2441683.5, 12], [2442048.5, 13], [2442413.5, 14], [2442778.5, 15],
  [2443144.5, 16], [2443509.5, 17], [2443874.5, 18], [2444239.5, 19], [2444786.5, 20], [2445151.5, 21],
  [2445516.5, 22], [2446247.5, 23], [2447161.5, 24], [2447892.5, 25], [2448257.5, 26], [2448804.5, 27],
  [2449169.5, 28], [2449534.5, 29], [2450083.5, 30], [2450630.5, 31], [2451179.5, 32], [2453736.5, 33],
  [2454832.5, 34], [2456109.5, 35], [2457204.5, 36], [2457754.5, 37],
];

/** Decimal year for a JD (good enough for ΔT). */
export const jdToYear = (jd: number) => 2000 + (jd - J2000_JD) / 365.25;

/** ΔT = TT − UT in seconds (Espenak & Meeus 2006 polynomials; leap-second table 1972–2035). */
export function deltaT(jdUT: number): number {
  if (jdUT >= LEAP[0][0] && jdUT < 2464328.5 /* 2035-01-01 */) {
    let tai = LEAP[0][1];
    for (let i = LEAP.length - 1; i >= 0; i--) {
      if (jdUT >= LEAP[i][0]) {
        tai = LEAP[i][1];
        break;
      }
    }
    return 32.184 + tai;
  }
  const y = jdToYear(jdUT);
  let t: number, u: number;
  if (y < -500) {
    u = (y - 1820) / 100;
    return -20 + 32 * u * u;
  }
  if (y < 500) {
    u = y / 100;
    return 10583.6 - 1014.41 * u + 33.78311 * u ** 2 - 5.952053 * u ** 3 - 0.1798452 * u ** 4 + 0.022174192 * u ** 5 + 0.0090316521 * u ** 6;
  }
  if (y < 1600) {
    u = (y - 1000) / 100;
    return 1574.2 - 556.01 * u + 71.23472 * u ** 2 + 0.319781 * u ** 3 - 0.8503463 * u ** 4 - 0.005050998 * u ** 5 + 0.0083572073 * u ** 6;
  }
  if (y < 1700) {
    t = y - 1600;
    return 120 - 0.9808 * t - 0.01532 * t * t + t ** 3 / 7129;
  }
  if (y < 1800) {
    t = y - 1700;
    return 8.83 + 0.1603 * t - 0.0059285 * t * t + 0.00013336 * t ** 3 - t ** 4 / 1174000;
  }
  if (y < 1860) {
    t = y - 1800;
    return 13.72 - 0.332447 * t + 0.0068612 * t ** 2 + 0.0041116 * t ** 3 - 0.00037436 * t ** 4 + 0.0000121272 * t ** 5 - 0.0000001699 * t ** 6 + 0.000000000875 * t ** 7;
  }
  if (y < 1900) {
    t = y - 1860;
    return 7.62 + 0.5737 * t - 0.251754 * t ** 2 + 0.01680668 * t ** 3 - 0.0004473624 * t ** 4 + t ** 5 / 233174;
  }
  if (y < 1920) {
    t = y - 1900;
    return -2.79 + 1.494119 * t - 0.0598939 * t ** 2 + 0.0061966 * t ** 3 - 0.000197 * t ** 4;
  }
  if (y < 1941) {
    t = y - 1920;
    return 21.2 + 0.84493 * t - 0.0761 * t ** 2 + 0.0020936 * t ** 3;
  }
  if (y < 1961) {
    t = y - 1950;
    return 29.07 + 0.407 * t - t * t / 233 + t ** 3 / 2547;
  }
  if (y < 1972) {
    t = y - 1975;
    return 45.45 + 1.067 * t - t * t / 260 - t ** 3 / 718;
  }
  if (y < 2150) {
    // After the leap-second table: continue smoothly from 69.184 s (2035) toward the long-term parabola.
    const a = 69.184;
    const far = -20 + 32 * ((y - 1820) / 100) ** 2 - 0.5628 * (2150 - y);
    const k = Math.min(1, Math.max(0, (y - 2035) / 115));
    return a + (far - a) * k * k;
  }
  u = (y - 1820) / 100;
  return -20 + 32 * u * u;
}

export const utcToTT = (jdUTC: number) => jdUTC + deltaT(jdUTC) / DAY_S;
/** Inverse of utcToTT (one fixed-point step is exact to < 1 µs). */
export const ttToUTC = (jdTT: number) => {
  const g = jdTT - deltaT(jdTT) / DAY_S;
  return jdTT - deltaT(g) / DAY_S;
};

/** JS Date (UTC) → JD (UTC). */
export const dateToJD = (d: Date) => d.getTime() / 86_400_000 + UNIX_EPOCH_JD;
/** JD (UTC) → JS Date. JS Dates span ±273 000 years, far beyond the ephemerides. */
export const jdToDate = (jd: number) => new Date((jd - UNIX_EPOCH_JD) * 86_400_000);

/** Julian date of a proleptic-Gregorian calendar date (Meeus 7.1). Month 1–12, fractional day allowed. */
export function calendarToJD(year: number, month: number, day: number): number {
  let y = year;
  let m = month;
  if (m <= 2) {
    y -= 1;
    m += 12;
  }
  const A = Math.floor(y / 100);
  const B = 2 - A + Math.floor(A / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + day + B - 1524.5;
}

/** Calendar date (proleptic Gregorian) from a JD (Meeus 7). */
export function jdToCalendar(jd: number): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const z = Math.floor(jd + 0.5);
  const f = jd + 0.5 - z;
  const alpha = Math.floor((z - 1867216.25) / 36524.25);
  const A = z + 1 + alpha - Math.floor(alpha / 4);
  const B = A + 1524;
  const C = Math.floor((B - 122.1) / 365.25);
  const D = Math.floor(365.25 * C);
  const E = Math.floor((B - D) / 30.6001);
  const dayF = B - D - Math.floor(30.6001 * E) + f;
  const month = E < 14 ? E - 1 : E - 13;
  const year = month > 2 ? C - 4716 : C - 4715;
  let day = Math.floor(dayF);
  let secs = Math.round((dayF - day) * DAY_S);
  if (secs >= DAY_S) {
    // Rounding carried into the next day: recompute from the rounded instant.
    return jdToCalendar(jd + 0.5 / DAY_S);
  }
  const hour = Math.floor(secs / 3600);
  secs -= hour * 3600;
  const minute = Math.floor(secs / 60);
  const second = secs - minute * 60;
  day = Math.max(1, day);
  return { year, month, day, hour, minute, second };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Astronomical year numbering (year 0 = 1 BC) shown as "1 BC" etc. */
export function formatYear(y: number): string {
  if (y > 0) return String(y);
  return `${1 - y} BC`;
}

/** "2026 Sep 23" and "14:05:12" for a UTC Julian date. */
export function formatUTC(jdUTC: number): { date: string; time: string } {
  const c = jdToCalendar(jdUTC);
  return { date: `${formatYear(c.year)} ${MONTHS[c.month - 1]} ${pad(c.day)}`, time: `${pad(c.hour)}:${pad(c.minute)}:${pad(c.second)}` };
}

/** Time-warp steps in simulated seconds per real second (signless; direction is separate). */
export const WARP_STEPS: ReadonlyArray<{ rate: number; label: string }> = [
  { rate: 1, label: 'real time' },
  { rate: 60, label: '1 min / s' },
  { rate: 600, label: '10 min / s' },
  { rate: 3600, label: '1 hour / s' },
  { rate: 6 * 3600, label: '6 hours / s' },
  { rate: DAY_S, label: '1 day / s' },
  { rate: 7 * DAY_S, label: '1 week / s' },
  { rate: 30.436875 * DAY_S, label: '1 month / s' },
  { rate: 0.25 * 365.25 * DAY_S, label: '3 months / s' },
  { rate: 365.25 * DAY_S, label: '1 year / s' },
  { rate: 10 * 365.25 * DAY_S, label: '10 years / s' },
  { rate: 100 * 365.25 * DAY_S, label: '100 years / s' },
];

/** Valid range of the ephemerides (Standish Table 2): 3000 BC … AD 3000. */
export const JD_MIN = calendarToJD(-2999, 1, 1);
export const JD_MAX = calendarToJD(3000, 1, 1);
