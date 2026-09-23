import { AU, C, DAY, GPC, GYR, HOUR, KPC, LY, M_EARTH, M_JUPITER, M_SUN, MINUTE, MPC, MYR, PC, YEAR } from './constants';

export interface Formatted {
  value: string;
  unit: string;
}

const THIN = ' ';

/** Group thousands with thin spaces; `digits` significant figures for small numbers. */
export function formatNumber(x: number, digits = 3): string {
  if (!isFinite(x)) return x > 0 ? '∞' : x < 0 ? '−∞' : '—';
  const ax = Math.abs(x);
  if (ax !== 0 && (ax >= 1e15 || ax < 1e-3)) return formatScientific(x, digits);
  let s: string;
  if (ax >= 10 ** digits) s = Math.round(x).toString();
  else s = Number(x.toPrecision(digits)).toString();
  const [int, frac] = s.split('.');
  const neg = int.startsWith('-');
  const digitsOnly = neg ? int.slice(1) : int;
  const grouped = digitsOnly.length > 4 ? digitsOnly.replace(/\B(?=(\d{3})+(?!\d))/g, THIN) : digitsOnly;
  return (neg ? '−' : '') + grouped + (frac ? '.' + frac : '');
}

const SUP: Record<string, string> = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };

/** 1.23 × 10⁴⁵ */
export function formatScientific(x: number, digits = 3): string {
  if (x === 0) return '0';
  const e = Math.floor(Math.log10(Math.abs(x)));
  const m = x / 10 ** e;
  const exp = String(e)
    .split('')
    .map((c) => SUP[c] ?? c)
    .join('');
  return `${m < 0 ? '−' : ''}${Math.abs(m).toFixed(Math.max(0, digits - 1))} × 10${exp}`;
}

/** Choose a human unit for a distance in metres (m → km → AU → ly → kly → Mly → Gly). */
export function formatDistance(m: number, digits = 3): Formatted {
  const a = Math.abs(m);
  if (a < 1e3) return { value: formatNumber(m, digits), unit: 'm' };
  if (a < 0.05 * AU) return { value: formatNumber(m / 1e3, digits), unit: 'km' };
  if (a < 0.1 * LY) return { value: formatNumber(m / AU, digits), unit: 'AU' };
  if (a < 1e4 * LY) return { value: formatNumber(m / LY, digits), unit: 'ly' };
  if (a < 1e6 * LY) return { value: formatNumber(m / (1e3 * LY), digits), unit: 'kly' };
  if (a < 1e9 * LY) return { value: formatNumber(m / (1e6 * LY), digits), unit: 'Mly' };
  return { value: formatNumber(m / (1e9 * LY), digits), unit: 'Gly' };
}

/** Astronomer's units (pc, kpc, Mpc, Gpc) for distances in metres. */
export function formatParsecs(m: number, digits = 3): Formatted {
  const a = Math.abs(m);
  if (a < 1e3 * PC) return { value: formatNumber(m / PC, digits), unit: 'pc' };
  if (a < 1e3 * KPC) return { value: formatNumber(m / KPC, digits), unit: 'kpc' };
  if (a < 1e3 * MPC) return { value: formatNumber(m / MPC, digits), unit: 'Mpc' };
  return { value: formatNumber(m / GPC, digits), unit: 'Gpc' };
}

export function formatDuration(s: number, digits = 3): Formatted {
  const a = Math.abs(s);
  if (a < MINUTE) return { value: formatNumber(s, digits), unit: 's' };
  if (a < HOUR) return { value: formatNumber(s / MINUTE, digits), unit: 'min' };
  if (a < DAY) return { value: formatNumber(s / HOUR, digits), unit: 'h' };
  if (a < YEAR) return { value: formatNumber(s / DAY, digits), unit: 'd' };
  if (a < 1e3 * YEAR) return { value: formatNumber(s / YEAR, digits), unit: 'yr' };
  if (a < MYR) return { value: formatNumber(s / (1e3 * YEAR), digits), unit: 'kyr' };
  if (a < GYR) return { value: formatNumber(s / MYR, digits), unit: 'Myr' };
  return { value: formatNumber(s / GYR, digits), unit: 'Gyr' };
}

/** m/s → m/s, km/s, fraction of c; beyond c shows multiples of c. */
export function formatSpeed(v: number, digits = 3): Formatted {
  const a = Math.abs(v);
  if (a < 1e3) return { value: formatNumber(v, digits), unit: 'm/s' };
  if (a < 0.01 * C) return { value: formatNumber(v / 1e3, digits), unit: 'km/s' };
  return { value: formatNumber(v / C, digits), unit: 'c' };
}

export function formatMass(kg: number, digits = 3): Formatted {
  const a = Math.abs(kg);
  if (a < 1e20) return { value: formatNumber(kg, digits), unit: 'kg' };
  if (a < 0.05 * M_JUPITER) return { value: formatNumber(kg / M_EARTH, digits), unit: 'M⊕' };
  if (a < 0.01 * M_SUN) return { value: formatNumber(kg / M_JUPITER, digits), unit: 'M♃' };
  return { value: formatNumber(kg / M_SUN, digits), unit: 'M☉' };
}

export function formatTemperature(k: number, digits = 4): Formatted {
  return { value: formatNumber(k, digits), unit: 'K' };
}

export const joinFormatted = (f: Formatted) => `${f.value}${THIN}${f.unit}`;
