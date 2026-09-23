import type { Rng } from '../../physics/random';

/**
 * Isotropic distribution functions by Eddington inversion (Binney & Tremaine 2008, eq. 4.46b):
 *
 *   f(ℰ) = 1/(√8 π²) [ ∫₀^ℰ (d²ρ/dΨ²) dΨ / √(ℰ − Ψ)  +  (1/√ℰ) (dρ/dΨ)|_{Ψ=0} ]
 *
 * for a density component ρ(r) living in a (possibly composite) spherical relative potential
 * Ψ(r) = −Φ(r). Using the component's own density in the *total* potential yields equilibrium
 * velocities for multi-component galaxies (halo + bulge + spherically averaged disk); see
 * Kazantzidis, Magorrian & Moore 2004 (ApJ 601, 37) on why this beats Maxwellian (Jeans) sampling.
 *
 * Numerics: everything is tabulated on a logarithmic radius grid; the singular Abel kernel is
 * removed with Ψ = ℰ − t², so the integral becomes ∫₀^√ℰ 2 g(ℰ − t²) dt (Simpson rule).
 */
export interface EddingtonInput {
  rho: (r: number) => number;
  /** dρ/dr and d²ρ/dr² (analytic is best). */
  drho: (r: number) => number;
  d2rho: (r: number) => number;
  /** Relative potential Ψ(r) > 0, decreasing to 0 at infinity. */
  psi: (r: number) => number;
  rMin: number;
  rMax: number;
  nR?: number;
  nE?: number;
}

export class EddingtonDF {
  /** Table of ℰ (ascending) and ln f(ℰ). */
  readonly E: Float64Array;
  readonly f: Float64Array;
  private readonly lnE: Float64Array;
  private readonly lnf: Float64Array;
  private readonly psiFn: (r: number) => number;
  /** Number of E samples where the inversion went negative (clamped to 0). */
  readonly negatives: number;

  constructor(inp: EddingtonInput) {
    const nR = inp.nR ?? 1600;
    const nE = inp.nE ?? 420;
    this.psiFn = inp.psi;
    const lr0 = Math.log(inp.rMin), lr1 = Math.log(inp.rMax);
    const h = (lr1 - lr0) / (nR - 1);
    const r = new Float64Array(nR);
    const psi = new Float64Array(nR);
    for (let i = 0; i < nR; i++) {
      r[i] = Math.exp(lr0 + h * i);
      psi[i] = inp.psi(r[i]);
    }
    // Ψ' and Ψ'' via 5-point stencils in ln r.
    const dpsi = new Float64Array(nR);
    const d2psi = new Float64Array(nR);
    for (let i = 0; i < nR; i++) {
      const lnr = lr0 + h * i;
      const P = (k: number) => inp.psi(Math.exp(lnr + k * h));
      const p2 = P(2), p1 = P(1), p0 = psi[i], m1 = P(-1), m2 = P(-2);
      const dl = (-p2 + 8 * p1 - 8 * m1 + m2) / (12 * h);
      const d2l = (-p2 + 16 * p1 - 30 * p0 + 16 * m1 - m2) / (12 * h * h);
      dpsi[i] = dl / r[i];
      d2psi[i] = (d2l - dl) / (r[i] * r[i]);
    }
    // g(Ψ) = d²ρ/dΨ² = (ρ''Ψ' − ρ'Ψ'') / Ψ'³, tabulated along r (Ψ descending with r).
    const g = new Float64Array(nR);
    for (let i = 0; i < nR; i++) {
      const rp = inp.drho(r[i]);
      const rpp = inp.d2rho(r[i]);
      const d1 = dpsi[i];
      g[i] = (rpp * d1 - rp * d2psi[i]) / (d1 * d1 * d1);
    }
    // Ascending-Ψ arrays for interpolation.
    const P = new Float64Array(nR), Gv = new Float64Array(nR);
    for (let i = 0; i < nR; i++) {
      P[i] = psi[nR - 1 - i];
      Gv[i] = g[nR - 1 - i];
    }
    const gAt = (ps: number): number => {
      if (ps <= P[0]) return Gv[0] * Math.max(0, ps / P[0]);
      if (ps >= P[nR - 1]) return Gv[nR - 1];
      let lo = 0, hi = nR - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (P[mid] <= ps) lo = mid;
        else hi = mid;
      }
      const t = (ps - P[lo]) / (P[hi] - P[lo]);
      return Gv[lo] + t * (Gv[hi] - Gv[lo]);
    };
    // Boundary term dρ/dΨ at Ψ→0 (evaluated at rMax).
    const drhodpsi0 = inp.drho(r[nR - 1]) / dpsi[nR - 1];

    // ℰ grid follows the radius grid (ℰ_k = Ψ(r_k)), so resolution is logarithmic both in
    // ℰ → 0 (large r) and in Ψ₀ − ℰ → 0 (the cusp), where f diverges.
    const E = new Float64Array(nE);
    const f = new Float64Array(nE);
    const NS = 512; // Simpson intervals (even)
    let neg = 0;
    const lq0 = Math.log(inp.rMin * 1.02), lq1 = Math.log(inp.rMax * 0.98);
    for (let k = 0; k < nE; k++) {
      // k = 0 → largest radius (smallest ℰ); ascending ℰ.
      const rr = Math.exp(lq1 + ((lq0 - lq1) * k) / (nE - 1));
      const En = inp.psi(rr);
      const T = Math.sqrt(En);
      // Concentrate Simpson nodes near t = 0 (Ψ → ℰ), where g peaks: t = T·u².
      let s = 0;
      const du = 1 / NS;
      for (let j = 0; j <= NS; j++) {
        const u = j * du;
        const t = T * u * u;
        const w = j === 0 || j === NS ? 1 : j % 2 ? 4 : 2;
        s += w * 2 * gAt(En - t * t) * 2 * T * u;
      }
      s *= du / 3;
      s += drhodpsi0 / Math.sqrt(En);
      let fv = s / (Math.sqrt(8) * Math.PI * Math.PI);
      if (!(fv > 0)) {
        neg++;
        fv = 0;
      }
      E[k] = En;
      f[k] = fv;
    }
    this.negatives = neg;
    this.E = E;
    this.f = f;
    this.lnE = E.map(Math.log);
    // Replace zeros by a floor well below the smallest positive value to keep log-interpolation sane.
    let minPos = Infinity;
    for (const v of f) if (v > 0 && v < minPos) minPos = v;
    this.lnf = f.map((v) => Math.log(v > 0 ? v : minPos * 1e-6));
  }

  /** Distribution function f(ℰ) (log-log interpolation; 0 for unbound ℰ ≤ 0). */
  df(E: number): number {
    if (E <= 0) return 0;
    const Et = this.E, lnE = this.lnE, lnf = this.lnf;
    const n = Et.length;
    if (E <= Et[0]) {
      // Power-law extrapolation toward ℰ → 0.
      const slope = (lnf[1] - lnf[0]) / (lnE[1] - lnE[0]);
      return Math.exp(lnf[0] + slope * (Math.log(E) - lnE[0]));
    }
    if (E >= Et[n - 1]) return Math.exp(lnf[n - 1]);
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (Et[mid] <= E) lo = mid;
      else hi = mid;
    }
    // Interpolate ln f linearly in ln(Ψ₀ − ℰ) near the top, ln ℰ elsewhere: use the local
    // variable with the larger relative change between the bracketing nodes.
    const top = Et[n - 1] * 1.000001;
    const a0 = Math.log(top - Et[lo]), a1 = Math.log(top - Et[hi]);
    const b0 = lnE[lo], b1 = lnE[hi];
    const useTop = Math.abs(a1 - a0) > Math.abs(b1 - b0);
    const t = useTop ? (Math.log(top - E) - a0) / (a1 - a0) : (Math.log(E) - b0) / (b1 - b0);
    return Math.exp(lnf[lo] + t * (lnf[hi] - lnf[lo]));
  }

  /**
   * Draw an isotropic velocity at radius r from p(v) ∝ v² f(Ψ(r) − v²/2) by rejection sampling.
   * Returns speed; direction is up to the caller.
   */
  sampleSpeed(rng: Rng, r: number): number {
    const psi = this.psiFn(r);
    const vmax = Math.sqrt(2 * psi);
    let pmax = 0;
    for (let k = 1; k <= 48; k++) {
      const v = (vmax * k) / 49;
      const p = v * v * this.df(psi - 0.5 * v * v);
      if (p > pmax) pmax = p;
    }
    pmax *= 1.25;
    for (let tries = 0; tries < 10000; tries++) {
      const v = rng.next() * vmax;
      const p = v * v * this.df(psi - 0.5 * v * v);
      if (rng.next() * pmax <= p) return v;
    }
    return 0.5 * vmax;
  }

  /** Relative potential at r used to build the DF. */
  psi(r: number): number {
    return this.psiFn(r);
  }
}

/** Analytic isotropic Hernquist DF (Hernquist 1990, eq. 17) for testing, G = given. */
export function hernquistDFAnalytic(E: number, M: number, a: number, G: number): number {
  const vg = Math.sqrt((G * M) / a);
  const q = Math.sqrt((E * a) / (G * M));
  if (q <= 0 || q >= 1) return 0;
  const q2 = q * q;
  const pre = M / (8 * Math.SQRT2 * Math.pow(Math.PI, 3) * a * a * a * vg * vg * vg);
  return (
    (pre / Math.pow(1 - q2, 2.5)) *
    (3 * Math.asin(q) + q * Math.sqrt(1 - q2) * (1 - 2 * q2) * (8 * q2 * q2 - 8 * q2 - 3))
  );
}

/** Hernquist density derivatives (for Eddington input). */
export function hernquistDensityDerivs(M: number, a: number) {
  const rho = (r: number) => (M * a) / (2 * Math.PI * r * Math.pow(r + a, 3));
  const dlog = (r: number) => -1 / r - 3 / (r + a);
  return {
    rho,
    drho: (r: number) => rho(r) * dlog(r),
    d2rho: (r: number) => {
      const d = dlog(r);
      return rho(r) * (d * d + 1 / (r * r) + 3 / ((r + a) * (r + a)));
    },
  };
}
