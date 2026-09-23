import { C, GYR, MPC, PLANCK18 } from './constants';

export interface CosmologyParams {
  /** Hubble constant, km/s/Mpc. */
  H0: number;
  /** Matter density today (CDM + baryons). */
  Om0: number;
  /** Dark-energy (Λ) density today. If omitted, set for flatness. */
  Ode0?: number;
  /** Radiation density today (photons + massless ν). If omitted, derived from Tcmb0/Neff. */
  Or0?: number;
  Ob0?: number;
  Tcmb0?: number;
  Neff?: number;
}

const KM_S_MPC_TO_SI = 1e3 / MPC; // (km/s/Mpc) → 1/s

/**
 * Friedmann–Lemaître–Robertson–Walker background for a ΛCDM-family universe.
 * a = scale factor (1 today), z = 1/a − 1.
 *   H(a) = H0 · E(a),  E² = Ωr a⁻⁴ + Ωm a⁻³ + Ωk a⁻² + ΩΛ
 * Cosmic time and the linear growth factor are tabulated once at construction.
 */
export class Cosmology {
  readonly H0: number;
  readonly h: number;
  readonly Om0: number;
  readonly Ob0: number;
  readonly Or0: number;
  readonly Ode0: number;
  readonly Ok0: number;
  readonly Tcmb0: number;
  /** Hubble time 1/H0 in seconds. */
  readonly hubbleTime: number;
  /** Hubble distance c/H0 in Mpc. */
  readonly hubbleDistanceMpc: number;

  // tables in ln a
  private static readonly LNA_MIN = -16; // a ≈ 1.1e-7
  private static readonly LNA_MAX = 2.5; // a ≈ 12 (the far future)
  private static readonly N = 6000;
  private tTable: Float64Array; // cosmic time [s]
  private dTable: Float64Array; // growth factor, D(1) = 1
  private readonly dlna: number;

  constructor(p: Partial<CosmologyParams> = {}) {
    this.H0 = p.H0 ?? PLANCK18.H0;
    this.h = this.H0 / 100;
    this.Om0 = p.Om0 ?? PLANCK18.Om0;
    this.Ob0 = p.Ob0 ?? PLANCK18.Ob0;
    this.Tcmb0 = p.Tcmb0 ?? PLANCK18.Tcmb0;
    const Neff = p.Neff ?? PLANCK18.Neff;
    // Ω_γ h² = 2.4728e-5 (Tcmb/2.7255)^4 ; massless neutrinos add 0.22710·Neff of that.
    const Og = (2.4728e-5 * Math.pow(this.Tcmb0 / 2.7255, 4)) / (this.h * this.h);
    this.Or0 = p.Or0 ?? Og * (1 + 0.2271 * Neff);
    this.Ode0 = p.Ode0 ?? 1 - this.Om0 - this.Or0;
    this.Ok0 = 1 - this.Om0 - this.Or0 - this.Ode0;
    this.hubbleTime = 1 / (this.H0 * KM_S_MPC_TO_SI);
    this.hubbleDistanceMpc = C / 1e3 / this.H0;

    const N = Cosmology.N;
    this.dlna = (Cosmology.LNA_MAX - Cosmology.LNA_MIN) / (N - 1);
    this.tTable = new Float64Array(N);
    this.dTable = new Float64Array(N);
    this.buildTables();
  }

  E(a: number): number {
    const e2 = this.Or0 / (a * a * a * a) + this.Om0 / (a * a * a) + this.Ok0 / (a * a) + this.Ode0;
    return Math.sqrt(Math.max(e2, 0));
  }
  /** H(a) in km/s/Mpc. */
  H(a: number): number {
    return this.H0 * this.E(a);
  }
  /** H(a) in 1/s. */
  Hsi(a: number): number {
    return this.H0 * KM_S_MPC_TO_SI * this.E(a);
  }
  Om(a: number): number {
    const e = this.E(a);
    return this.Om0 / (a * a * a * e * e);
  }
  Ode(a: number): number {
    const e = this.E(a);
    return this.Ode0 / (e * e);
  }
  Or(a: number): number {
    const e = this.E(a);
    return this.Or0 / (a * a * a * a * e * e);
  }
  /** Deceleration parameter q = −ä a / ȧ². */
  q(a: number): number {
    return 0.5 * this.Om(a) + this.Or(a) - this.Ode(a);
  }

  private buildTables(): void {
    const N = Cosmology.N;
    const lnaMin = Cosmology.LNA_MIN;
    const h = this.dlna;
    const H0 = this.H0 * KM_S_MPC_TO_SI;
    // t(a): radiation-dominated start t = a²/(2 H0 √Ωr), then trapezoid in ln a of dt = dlna / H.
    const a0 = Math.exp(lnaMin);
    this.tTable[0] = (a0 * a0) / (2 * H0 * Math.sqrt(Math.max(this.Or0, 1e-12)));
    let prev = 1 / (H0 * this.E(a0));
    for (let i = 1; i < N; i++) {
      const a = Math.exp(lnaMin + i * h);
      const cur = 1 / (H0 * this.E(a));
      this.tTable[i] = this.tTable[i - 1] + 0.5 * h * (prev + cur);
      prev = cur;
    }
    // Linear growth: D'' + (2 + dlnH/dlna) D' − 1.5 Ωm(a) D = 0 in ln a, from deep matter era (D ∝ a).
    // Integrated with RK4 including radiation's effect on H. Normalised to D(a=1) = 1.
    const f = (lna: number, D: number, dD: number): [number, number] => {
      const a = Math.exp(lna);
      const e2 = this.E(a) ** 2;
      const dlnH =
        (-4 * this.Or0 / a ** 4 - 3 * this.Om0 / a ** 3 - 2 * this.Ok0 / a ** 2) / (2 * e2);
      const om = this.Om0 / (a ** 3 * e2);
      return [dD, -(2 + dlnH) * dD + 1.5 * om * D];
    };
    // start well after equality where D ∝ a is a good approximation of the growing mode
    const startIdx = Math.max(0, Math.round((Math.log(1e-3) - lnaMin) / h));
    for (let i = 0; i <= startIdx; i++) this.dTable[i] = Math.exp(lnaMin + i * h);
    let D = this.dTable[startIdx];
    let dD = D;
    for (let i = startIdx + 1; i < N; i++) {
      const x = lnaMin + (i - 1) * h;
      const [k1a, k1b] = f(x, D, dD);
      const [k2a, k2b] = f(x + h / 2, D + (h / 2) * k1a, dD + (h / 2) * k1b);
      const [k3a, k3b] = f(x + h / 2, D + (h / 2) * k2a, dD + (h / 2) * k2b);
      const [k4a, k4b] = f(x + h, D + h * k3a, dD + h * k3b);
      D += (h / 6) * (k1a + 2 * k2a + 2 * k3a + k4a);
      dD += (h / 6) * (k1b + 2 * k2b + 2 * k3b + k4b);
      this.dTable[i] = D;
    }
    const D1 = this.interp(this.dTable, 0);
    for (let i = 0; i < N; i++) this.dTable[i] /= D1;
  }

  private interp(table: Float64Array, lna: number): number {
    const x = (lna - Cosmology.LNA_MIN) / this.dlna;
    if (x <= 0) return table[0];
    if (x >= Cosmology.N - 1) return table[Cosmology.N - 1];
    const i = Math.floor(x);
    const t = x - i;
    return table[i] * (1 - t) + table[i + 1] * t;
  }

  /** Cosmic time since the Big Bang at scale factor a, seconds. */
  time(a: number): number {
    const lna = Math.log(a);
    if (lna < Cosmology.LNA_MIN) {
      return (a * a) / (2 * this.H0 * KM_S_MPC_TO_SI * Math.sqrt(Math.max(this.Or0, 1e-12)));
    }
    return this.interp(this.tTable, lna);
  }
  /** Age of the universe at scale factor a, Gyr. */
  ageGyr(a = 1): number {
    return this.time(a) / GYR;
  }
  /** Inverse of time(): scale factor at cosmic time t (seconds). Monotonic bisection on the table. */
  aAtTime(t: number): number {
    const T = this.tTable;
    if (t <= T[0]) {
      return Math.sqrt(t * 2 * this.H0 * KM_S_MPC_TO_SI * Math.sqrt(Math.max(this.Or0, 1e-12)));
    }
    let lo = 0,
      hi = T.length - 1;
    if (t >= T[hi]) return Math.exp(Cosmology.LNA_MAX);
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (T[mid] < t) lo = mid;
      else hi = mid;
    }
    const f = (t - T[lo]) / (T[hi] - T[lo]);
    return Math.exp(Cosmology.LNA_MIN + (lo + f) * this.dlna);
  }
  lookbackTimeGyr(z: number): number {
    return this.ageGyr(1) - this.ageGyr(1 / (1 + z));
  }
  /** Linear growth factor D(a), normalised to D(1) = 1. */
  growth(a: number): number {
    return this.interp(this.dTable, Math.log(a));
  }
  /** Growth rate f = dlnD/dlna. */
  growthRate(a: number): number {
    const e = 1e-3;
    const lna = Math.log(a);
    return (Math.log(this.interp(this.dTable, lna + e)) - Math.log(this.interp(this.dTable, lna - e))) / (2 * e);
  }
  /** Second-order (2LPT) growth factor, D2 ≈ −3/7 D² Ωm^(−1/143) (Bouchet et al. 1995). */
  growth2(a: number): number {
    const D = this.growth(a);
    return (-3 / 7) * D * D * Math.pow(this.Om(a), -1 / 143);
  }
  /** Line-of-sight comoving distance to redshift z, Mpc (Simpson's rule). */
  comovingDistanceMpc(z: number, steps = 512): number {
    if (z <= 0) return 0;
    const n = steps + (steps % 2);
    const dz = z / n;
    let s = 1 / this.E(1) + 1 / this.E(1 / (1 + z));
    for (let i = 1; i < n; i++) s += (i % 2 ? 4 : 2) / this.E(1 / (1 + i * dz));
    return (this.hubbleDistanceMpc * dz * s) / 3;
  }
  /** Transverse comoving distance (accounts for curvature), Mpc. */
  transverseComovingDistanceMpc(z: number): number {
    const dc = this.comovingDistanceMpc(z);
    const ok = this.Ok0;
    if (Math.abs(ok) < 1e-8) return dc;
    const dh = this.hubbleDistanceMpc;
    const s = Math.sqrt(Math.abs(ok));
    return ok > 0 ? (dh / s) * Math.sinh((s * dc) / dh) : (dh / s) * Math.sin((s * dc) / dh);
  }
  luminosityDistanceMpc(z: number): number {
    return (1 + z) * this.transverseComovingDistanceMpc(z);
  }
  angularDiameterDistanceMpc(z: number): number {
    return this.transverseComovingDistanceMpc(z) / (1 + z);
  }
  /** CMB temperature at redshift z, K. */
  Tcmb(z: number): number {
    return this.Tcmb0 * (1 + z);
  }
  /** True if this universe eventually recollapses (checked numerically out to a = 12). */
  get recollapses(): boolean {
    for (let a = 1; a < 12; a *= 1.05) {
      const e2 = this.Or0 / a ** 4 + this.Om0 / a ** 3 + this.Ok0 / a ** 2 + this.Ode0;
      if (e2 <= 0) return true;
    }
    return false;
  }
}

/**
 * Carl Sagan's Cosmic Calendar: the age of the universe compressed into one year.
 * Returns month/day/time for a cosmic time fraction in [0,1].
 */
export function cosmicCalendar(fraction: number): { month: string; day: number; time: string; label: string } {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const f = Math.min(Math.max(fraction, 0), 1);
  let secs = f * 365 * 86400;
  let m = 0;
  while (m < 11 && secs >= days[m] * 86400) {
    secs -= days[m] * 86400;
    m++;
  }
  const day = Math.min(days[m], Math.floor(secs / 86400) + 1);
  const rem = secs - (day - 1) * 86400;
  const hh = Math.floor(rem / 3600);
  const mm = Math.floor((rem % 3600) / 60);
  const ss = Math.floor(rem % 60);
  const time = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return { month: months[m], day, time, label: `${months[m]} ${day}, ${time}` };
}
