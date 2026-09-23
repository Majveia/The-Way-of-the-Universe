/**
 * Expansion history and linear growth integrated in cosmic time (module: cosmos).
 *
 * Unlike physics/cosmology.ts (tabulated in ln a, which cannot pass a turnaround), this solves
 * the Friedmann acceleration equation in time, so closed universes expand, turn around and
 * recollapse toward a Big Crunch. Units: H0 = 1 (time in Hubble times 1/H0).
 *
 *   ä  = −Ωr/a³ − Ωm/(2a²) + ΩΛ a                      (acceleration equation)
 *   ȧ² = Ωr/a² + Ωm/a + Ωk + ΩΛ a²                     (first integral; initial condition)
 *   D̈ + 2(ȧ/a) Ḋ − (3/2) Ωm D / a³ = 0                (linear growth of CDM, sub-horizon)
 *
 * Initial conditions deep in the radiation era use the exact radiation+matter solutions:
 *   t(a) = (2/3) a_eq^{3/2} Ωm^{−1/2} [ (y − 2)√(1 + y) + 2 ],  y = a/a_eq, a_eq = Ωr/Ωm
 *   D(a) ∝ 1 + 3y/2  (Mészáros 1974), i.e. D = a + 2a_eq/3 normalised to D → a in the matter era.
 *
 * FastPM (Feng et al. 2016, MNRAS 463, 2273) needs the momentum and force growth functions
 * for canonical momentum p = a² dx/dt:
 *   G_p(t) = a² Ḋ,   G_f(t) = dG_p/dt = (3/2) Ωm D / a.
 */

export interface ExpansionParams {
  /** km/s/Mpc */
  H0: number;
  Om0: number;
  Ode0: number;
  /** Radiation (photons + massless ν). Derived from Tcmb0/Neff when omitted. */
  Or0?: number;
  Tcmb0?: number;
  Neff?: number;
}

const MPC_KM = 3.0856775814913673e19;
const GYR_S = 3.15576e16;

export class Expansion {
  readonly H0: number;
  readonly h: number;
  readonly Om0: number;
  readonly Ode0: number;
  readonly Or0: number;
  readonly Ok0: number;
  /** 1/H0 in Gyr. */
  readonly hubbleTimeGyr: number;
  /** False when E²(a) ≤ 0 somewhere in (0, 1]: no Big Bang leads to today (a bounce/loitering universe). */
  readonly bigBang: boolean;
  readonly recollapses: boolean;
  /** Maximum scale factor and the time it is reached (recollapsing universes), else Infinity/NaN. */
  readonly aMax: number;
  readonly tTurn: number;
  /** Time of the Big Crunch (recollapsing), else Infinity. */
  readonly tCrunch: number;
  /** Time at which a = 1 (on the expanding branch). */
  readonly tToday: number;
  /** Time at which the expansion starts to accelerate (ä > 0), NaN if never. */
  readonly tAccel: number;
  /** End of the tabulated range (H0 units). */
  readonly tEnd: number;
  /** D_md(a=1): growth today, normalised to D = a in the matter era. */
  readonly growthMDToday: number;

  // Tables (H0 units), strictly increasing t.
  readonly t: Float64Array;
  readonly a: Float64Array;
  readonly adot: Float64Array;
  /** Growth factor normalised to D(tToday) = 1. */
  readonly D: Float64Array;
  readonly Ddot: Float64Array;
  private readonly n: number;

  constructor(p: ExpansionParams, opts: { tMax?: number; aMaxTable?: number } = {}) {
    this.H0 = p.H0;
    this.h = p.H0 / 100;
    this.Om0 = p.Om0;
    this.Ode0 = p.Ode0;
    const Tcmb = p.Tcmb0 ?? 2.7255;
    const Neff = p.Neff ?? 3.046;
    const Og = (2.4728e-5 * Math.pow(Tcmb / 2.7255, 4)) / (this.h * this.h);
    this.Or0 = p.Or0 ?? Og * (1 + 0.2271 * Neff);
    this.Ok0 = 1 - this.Om0 - this.Ode0 - this.Or0;
    this.hubbleTimeGyr = MPC_KM / p.H0 / GYR_S;

    // A Big Bang must connect to today: ȧ² > 0 for all a in (0, 1].
    let ok = this.Om0 > 0 || this.Or0 > 0;
    for (let i = 0; i <= 400 && ok; i++) {
      const a = Math.pow(10, -6 + (6 * i) / 400);
      if (this.E2(a) <= 0) ok = false;
    }
    this.bigBang = ok;

    const tMax = opts.tMax ?? 6;
    const aStop = opts.aMaxTable ?? 60;
    const Om = this.Om0, Or = this.Or0, Ol = this.Ode0;
    const acc = (a: number) => -Or / (a * a * a) - Om / (2 * a * a) + Ol * a;

    // Initial state deep in the radiation era.
    const aeq = Or > 0 && Om > 0 ? Or / Om : 0;
    const a0 = 1e-6;
    let t0: number;
    if (aeq > 0) {
      const y = a0 / aeq;
      t0 = ((2 / 3) * Math.pow(aeq, 1.5) / Math.sqrt(Om)) * ((y - 2) * Math.sqrt(1 + y) + 2);
    } else if (Om > 0) t0 = ((2 / 3) * Math.pow(a0, 1.5)) / Math.sqrt(Om);
    else t0 = (a0 * a0) / (2 * Math.sqrt(Or));
    const ts: number[] = [], as: number[] = [], ads: number[] = [], Ds: number[] = [], Dds: number[] = [];
    let a = a0;
    let ad = Math.sqrt(Math.max(this.E2(a0), 0)) * a0;
    let D = a0 + (2 / 3) * aeq;
    let Dd = ad; // dD/da = 1
    let t = t0;
    const push = () => {
      ts.push(t);
      as.push(a);
      ads.push(ad);
      Ds.push(D);
      Dds.push(Dd);
    };
    push();
    // State derivative for RK4: y = (a, ȧ, D, Ḋ)
    const deriv = (s: number[], out: number[]) => {
      const A = s[0], Ad = s[1], d = s[2], dd = s[3];
      out[0] = Ad;
      out[1] = acc(A);
      out[2] = dd;
      out[3] = -2 * (Ad / A) * dd + 1.5 * Om * d / (A * A * A);
    };
    const k1 = [0, 0, 0, 0], k2 = [0, 0, 0, 0], k3 = [0, 0, 0, 0], k4 = [0, 0, 0, 0];
    const s0 = [0, 0, 0, 0], tmp = [0, 0, 0, 0];
    let recollapse = false;
    let aMax = NaN, tTurn = NaN, tCrunch = Infinity, tAccel = NaN;
    let prevAcc = acc(a);
    for (let iter = 0; iter < 400000; iter++) {
      const timescale = Math.min(a / Math.max(Math.abs(ad), 1e-30), Math.sqrt(a / Math.max(Math.abs(acc(a)), 1e-30)));
      let dt = 0.004 * timescale;
      dt = Math.min(dt, 0.002);
      if (t + dt > tMax) dt = tMax - t;
      s0[0] = a; s0[1] = ad; s0[2] = D; s0[3] = Dd;
      deriv(s0, k1);
      for (let j = 0; j < 4; j++) tmp[j] = s0[j] + 0.5 * dt * k1[j];
      deriv(tmp, k2);
      for (let j = 0; j < 4; j++) tmp[j] = s0[j] + 0.5 * dt * k2[j];
      deriv(tmp, k3);
      for (let j = 0; j < 4; j++) tmp[j] = s0[j] + dt * k3[j];
      deriv(tmp, k4);
      const na = s0[0] + (dt / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);
      let nad = s0[1] + (dt / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
      // The acceleration equation alone lets truncation errors masquerade as curvature (ȧ² ~ 10⁸
      // in the radiation era). Project back onto the Friedmann constraint ȧ² = a²E²(a) except
      // in the neighbourhood of a turnaround, where ȧ → 0 and the second-order form carries us through.
      const e2a2 = this.E2(na) * na * na;
      if (e2a2 > 1e-4 && nad !== 0) nad = Math.sign(nad) * Math.sqrt(e2a2);
      const nD = s0[2] + (dt / 6) * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2]);
      const nDd = s0[3] + (dt / 6) * (k1[3] + 2 * k2[3] + 2 * k3[3] + k4[3]);
      if (!(na > 0) || !isFinite(nD)) {
        tCrunch = t + dt;
        break;
      }
      // Turnaround: ȧ changes sign.
      if (ad > 0 && nad <= 0) {
        recollapse = true;
        const f = ad / (ad - nad);
        tTurn = t + f * dt;
        aMax = a + (na - a) * f;
        // make sure the extremum is well represented
        aMax = Math.max(aMax, a, na);
      }
      const accNew = acc(na);
      if (isNaN(tAccel) && prevAcc < 0 && accNew >= 0 && nad > 0) tAccel = t + dt * (-prevAcc / (accNew - prevAcc));
      prevAcc = accNew;
      a = na; ad = nad; D = nD; Dd = nDd;
      t += dt;
      push();
      if (t >= tMax - 1e-12) break;
      if (a > aStop && ad > 0) break;
      if (recollapse && a < 2e-4) {
        // Close enough to the Big Crunch: radiation dominates again, a ∝ √(t_c − t),
        // so the remaining time is a / (2|ȧ|).
        tCrunch = t + a / (2 * Math.max(Math.abs(ad), 1e-30));
        break;
      }
    }
    this.recollapses = recollapse;
    this.aMax = recollapse ? aMax : Infinity;
    this.tTurn = recollapse ? tTurn : NaN;
    this.tCrunch = tCrunch;
    this.tAccel = tAccel;
    this.n = ts.length;
    this.t = Float64Array.from(ts);
    this.a = Float64Array.from(as);
    this.adot = Float64Array.from(ads);
    this.tEnd = ts[ts.length - 1];
    // today: first time a crosses 1
    let tToday = NaN;
    for (let i = 1; i < this.n; i++) {
      if (as[i - 1] < 1 && as[i] >= 1) {
        tToday = this.hermiteRoot(i - 1, 1);
        break;
      }
    }
    this.tToday = tToday;
    const Dtoday = isFinite(tToday) ? this.interpRaw(Ds, Dds, tToday) : Ds[Ds.length - 1];
    this.growthMDToday = Dtoday;
    this.D = Float64Array.from(Ds, (v) => v / Dtoday);
    this.Ddot = Float64Array.from(Dds, (v) => v / Dtoday);
  }

  /** E²(a) = (H/H0)². */
  E2(a: number): number {
    return this.Or0 / (a * a * a * a) + this.Om0 / (a * a * a) + this.Ok0 / (a * a) + this.Ode0;
  }

  private index(t: number): number {
    const T = this.t;
    if (t <= T[0]) return 0;
    if (t >= T[this.n - 1]) return this.n - 2;
    let lo = 0, hi = this.n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (T[m] <= t) lo = m;
      else hi = m;
    }
    return lo;
  }

  /** Cubic Hermite interpolation of y with derivative yd on interval i. */
  private hermite(y: ArrayLike<number>, yd: ArrayLike<number>, i: number, t: number): number {
    const t0 = this.t[i], t1 = this.t[i + 1];
    const h = t1 - t0;
    const s = Math.min(1, Math.max(0, (t - t0) / h));
    const s2 = s * s, s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * y[i] + (s3 - 2 * s2 + s) * h * yd[i] + (-2 * s3 + 3 * s2) * y[i + 1] + (s3 - s2) * h * yd[i + 1];
  }

  private interpRaw(y: number[], yd: number[], t: number): number {
    const i = this.index(t);
    return this.hermite(y, yd, i, t);
  }

  private hermiteRoot(i: number, target: number): number {
    let lo = this.t[i], hi = this.t[i + 1];
    for (let k = 0; k < 60; k++) {
      const m = 0.5 * (lo + hi);
      if (this.hermite(this.a, this.adot, i, m) < target) lo = m;
      else hi = m;
    }
    return 0.5 * (lo + hi);
  }

  /** Scale factor at time t (H0 units). */
  aAt(t: number): number {
    if (t <= this.t[0]) {
      // radiation era a ∝ √t
      return this.a[0] * Math.sqrt(Math.max(t, 0) / this.t[0]);
    }
    const i = this.index(t);
    return this.hermite(this.a, this.adot, i, Math.min(t, this.tEnd));
  }
  adotAt(t: number): number {
    const i = this.index(t);
    const t0 = this.t[i], t1 = this.t[i + 1];
    const s = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
    return this.adot[i] * (1 - s) + this.adot[i + 1] * s;
  }
  /** Hubble rate H/H0 (negative while contracting). */
  HAt(t: number): number {
    return this.adotAt(t) / this.aAt(t);
  }
  /** Linear growth factor D(t), D(today) = 1. */
  DAt(t: number): number {
    if (t <= this.t[0]) return this.D[0];
    const i = this.index(t);
    return this.hermite(this.D, this.Ddot, i, Math.min(t, this.tEnd));
  }
  DdotAt(t: number): number {
    const i = this.index(t);
    const t0 = this.t[i], t1 = this.t[i + 1];
    const s = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
    return this.Ddot[i] * (1 - s) + this.Ddot[i + 1] * s;
  }
  /** Growth rate f = dlnD/dlna = Ḋ a / (D ȧ). */
  fAt(t: number): number {
    return (this.DdotAt(t) * this.aAt(t)) / (this.DAt(t) * this.adotAt(t));
  }
  /** Deceleration parameter q = −ä a/ȧ². */
  qAt(t: number): number {
    const a = this.aAt(t), ad = this.adotAt(t);
    const acc = -this.Or0 / (a * a * a) - this.Om0 / (2 * a * a) + this.Ode0 * a;
    return (-acc * a) / (ad * ad);
  }
  /** Density parameters at time t. */
  OmAt(t: number): number {
    const a = this.aAt(t);
    return this.Om0 / (a * a * a * this.E2(a));
  }
  OdeAt(t: number): number {
    return this.Ode0 / this.E2(this.aAt(t));
  }
  OkAt(t: number): number {
    const a = this.aAt(t);
    return this.Ok0 / (a * a * this.E2(a));
  }

  /** FastPM momentum growth G_p = a² Ḋ. */
  Gp(t: number): number {
    const a = this.aAt(t);
    return a * a * this.DdotAt(t);
  }
  /** FastPM force growth G_f = dG_p/dt = (3/2) Ωm D/a. */
  Gf(t: number): number {
    return (1.5 * this.Om0 * this.DAt(t)) / this.aAt(t);
  }

  /**
   * Time at which the scale factor first reaches `a` (expanding branch), H0 units.
   * Returns NaN if never reached.
   */
  timeOfA(aTarget: number): number {
    const A = this.a;
    if (aTarget <= A[0]) {
      return this.t[0] * (aTarget / A[0]) ** 2;
    }
    for (let i = 1; i < this.n; i++) {
      if (A[i] >= aTarget) {
        if (A[i - 1] > aTarget) return this.t[i - 1];
        return this.hermiteRootGeneric(i - 1, aTarget);
      }
      if (this.adot[i] < 0) break; // started contracting before reaching aTarget
    }
    return NaN;
  }
  private hermiteRootGeneric(i: number, target: number): number {
    let lo = this.t[i], hi = this.t[i + 1];
    for (let k = 0; k < 60; k++) {
      const m = 0.5 * (lo + hi);
      if (this.hermite(this.a, this.adot, i, m) < target) lo = m;
      else hi = m;
    }
    return 0.5 * (lo + hi);
  }

  /** Convert H0-unit time to Gyr and back. */
  toGyr(t: number): number {
    return t * this.hubbleTimeGyr;
  }
  fromGyr(g: number): number {
    return g / this.hubbleTimeGyr;
  }

  /** Second-order (2LPT) growth factor at time t, Bouchet et al. (1995): D2 ≈ −(3/7) D² Ωm^(−1/143). */
  D2At(t: number): number {
    const D = this.DAt(t);
    return (-3 / 7) * D * D * Math.pow(Math.max(this.OmAt(t), 1e-6), -1 / 143);
  }
  /** Second-order growth rate f2 ≈ 2 Ωm^(6/11). */
  f2At(t: number): number {
    return 2 * Math.pow(Math.max(this.OmAt(t), 1e-6), 6 / 11);
  }
}

/**
 * FastPM kick/drift coefficients (Feng et al. 2016, eqs. 15–20) in cosmic time.
 * For canonical momentum p = a² dx/dt and acceleration dp/dt = (3/2) Ωm F / a with ∇²ψ = δ, F = −∇ψ:
 *   kick:  Δp = [G_p(t1) − G_p(t0)] / G_f(tc) · (3/2) Ωm F(tc) / a(tc)  =  [G_p(t1) − G_p(t0)] / D(tc) · F
 *   drift: Δx = [D(t1) − D(t0)] / G_p(tc) · p(tc)
 * Both reproduce the linear growing mode (Zel'dovich) exactly for any step size.
 */
export function fastpmKick(e: Expansion, t0: number, t1: number, tc: number): number {
  return (e.Gp(t1) - e.Gp(t0)) / e.DAt(tc);
}
export function fastpmDrift(e: Expansion, t0: number, t1: number, tc: number): number {
  return (e.DAt(t1) - e.DAt(t0)) / e.Gp(tc);
}
