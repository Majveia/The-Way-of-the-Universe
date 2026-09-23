import { describe, expect, it } from 'vitest';
import { G_SIM, KMS_PER_SIM_VELOCITY, G_KPC_KMS2_MSUN, kmsToSim, simToKms, circularSpeed } from '../src/worlds/nbody/units';
import { EddingtonDF, hernquistDFAnalytic, hernquistDensityDerivs } from '../src/worlds/nbody/eddington';
import { Rng } from '../src/physics/random';

describe('collision · unit system (kpc, Myr, 1e10 Msun)', () => {
  it('G in kpc^3 Myr^-2 (1e10 Msun)^-1 ≈ 0.04498', () => {
    expect(G_SIM).toBeGreaterThan(0.04497);
    expect(G_SIM).toBeLessThan(0.04500);
  });
  it('G in kpc (km/s)^2 / Msun ≈ 4.3009e-6', () => {
    expect(G_KPC_KMS2_MSUN).toBeCloseTo(4.3009e-6, 9);
  });
  it('1 kpc/Myr ≈ 977.8 km/s and conversions round-trip', () => {
    expect(KMS_PER_SIM_VELOCITY).toBeCloseTo(977.79, 1);
    expect(simToKms(kmsToSim(220))).toBeCloseTo(220, 10);
  });
  it('a 1e12 Msun point mass has v_c ≈ 207 km/s at 100 kpc', () => {
    // sqrt(G M / r) with G = 4.3009e-6 kpc (km/s)^2/Msun: sqrt(4.3009e-6 * 1e12 / 100) = 207.4 km/s
    expect(simToKms(circularSpeed(100, 100))).toBeCloseTo(207.4, 0);
  });
});

describe('collision · Eddington inversion', () => {
  const M = 1, a = 1;
  const d = hernquistDensityDerivs(M, a);
  const df = new EddingtonDF({ ...d, psi: (r) => (G_SIM * M) / (r + a), rMin: 1e-4, rMax: 1e5 });
  it('reproduces the analytic Hernquist DF to < 2 % over 4 decades in f', () => {
    let worst = 0;
    for (const q of [0.1, 0.2, 0.35, 0.5, 0.65, 0.8, 0.9, 0.95]) {
      const E = (q * q * G_SIM * M) / a;
      const fa = hernquistDFAnalytic(E, M, a, G_SIM);
      const fn = df.df(E);
      worst = Math.max(worst, Math.abs(fn / fa - 1));
    }
    expect(df.negatives).toBe(0);
    expect(worst).toBeLessThan(0.02);
  });
  it('sampled speeds satisfy the Jeans equation <v²> = 3 σ²(r)', () => {
    // Isotropic Hernquist: σ_r² from Hernquist (1990) eq. 10 via numerical Jeans integral.
    const rng = new Rng(7);
    for (const r of [0.3, 1, 3]) {
      let s = 0;
      const n = 4000;
      for (let i = 0; i < n; i++) {
        const v = df.sampleSpeed(rng, r);
        s += v * v;
      }
      const v2 = s / n;
      // Jeans: ρσ² = ∫_r^∞ ρ GM(<r')/r'² dr'
      let integ = 0;
      const N = 20000;
      const lr0 = Math.log(r), lr1 = Math.log(1e5);
      const h = (lr1 - lr0) / N;
      for (let k = 0; k <= N; k++) {
        const rr = Math.exp(lr0 + k * h);
        const w = k === 0 || k === N ? 0.5 : 1;
        const m = (M * rr * rr) / ((rr + a) * (rr + a));
        integ += w * d.rho(rr) * ((G_SIM * m) / (rr * rr)) * rr * h;
      }
      const sig2 = integ / d.rho(r);
      expect(v2 / (3 * sig2)).toBeGreaterThan(0.95);
      expect(v2 / (3 * sig2)).toBeLessThan(1.05);
    }
  });
});
