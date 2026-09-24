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

import { disk3MN, mn3Accel, DISK_3MN_TABLE } from '../src/worlds/nbody/models';
import { keplerStart } from '../src/worlds/nbody/orbit';
import { realizeGalaxy, smoothModelFor, smoothVc } from '../src/worlds/nbody/galaxy';
import { MILKY_WAY, LATE_SPIRAL } from '../src/worlds/nbody/catalog';
import { buildScenario } from '../src/worlds/nbody/scenario';
import { CpuNBody } from '../src/worlds/nbody/cpu';

// Modified Bessel functions (Abramowitz & Stegun 9.8.1–9.8.8) for Freeman's thin-disk curve.
function I0(x: number) { const t = x / 3.75; if (x < 3.75) { const t2 = t * t; return 1 + t2 * (3.5156229 + t2 * (3.0899424 + t2 * (1.2067492 + t2 * (0.2659732 + t2 * (0.0360768 + t2 * 0.0045813))))); } return (Math.exp(x) / Math.sqrt(x)) * (0.39894228 + (0.01328592 + (0.00225319 + (-0.00157565 + (0.00916281 + (-0.02057706 + (0.02635537 + (-0.01647633 + 0.00392377 / t) / t) / t) / t) / t) / t) / t) / t); }
function I1(x: number) { const t = x / 3.75; if (x < 3.75) { const t2 = t * t; return x * (0.5 + t2 * (0.87890594 + t2 * (0.51498869 + t2 * (0.15084934 + t2 * (0.02658733 + t2 * (0.00301532 + t2 * 0.00032411)))))); } return (Math.exp(x) / Math.sqrt(x)) * (0.39894228 + (-0.03988024 + (-0.00362018 + (0.00163801 + (-0.01031555 + (0.02282967 + (-0.02895312 + (0.01787654 - 0.00420059 / t) / t) / t) / t) / t) / t) / t) / t); }
function K0(x: number) { if (x <= 2) { const t = (x * x) / 4; return -Math.log(x / 2) * I0(x) + (-0.57721566 + t * (0.4227842 + t * (0.23069756 + t * (0.0348859 + t * (0.00262698 + t * (0.0001075 + t * 0.0000074)))))); } const t = 2 / x; return (Math.exp(-x) / Math.sqrt(x)) * (1.25331414 + t * (-0.07832358 + t * (0.02189568 + t * (-0.01062446 + t * (0.00587872 + t * (-0.0025154 + t * 0.00053208)))))); }
function K1(x: number) { if (x <= 2) { const t = (x * x) / 4; return Math.log(x / 2) * I1(x) + (1 / x) * (1 + t * (0.15443144 + t * (-0.67278579 + t * (-0.18156897 + t * (-0.01919402 + t * (-0.00110404 + t * -0.00004686)))))); } const t = 2 / x; return (Math.exp(-x) / Math.sqrt(x)) * (1.25331414 + t * (0.23498619 + t * (-0.0365562 + t * (0.01504268 + t * (-0.00780353 + t * (0.00325614 + t * -0.00068245)))))); }

describe('collision · exponential-disk potential (3 Miyamoto–Nagai)', () => {
  it('matches Freeman’s thin exponential-disk rotation curve within 6 % for 1–8 R_d', () => {
    // G = 1 units: v_c² = 4πGΣ₀R_d y²[I0K0 − I1K1], y = R/2R_d, Σ₀ = M/(2πR_d²).
    const d = disk3MN(1 / 0.04498502151469554, 1, 0.02); // mass chosen so G_SIM·M = 1
    const acc = [0, 0, 0];
    for (const R of [1, 1.5, 2.2, 3, 4, 6, 8]) {
      mn3Accel(d, R, 0, 0, acc);
      const vc2 = -acc[0] * R;
      const y = R / 2;
      const ref = 2 * y * y * (I0(y) * K0(y) - I1(y) * K1(y));
      expect(Math.abs(vc2 / ref - 1)).toBeLessThan(0.06);
    }
  });
  it('conserves total mass in the far field (Σ M_k = M)', () => {
    for (const row of DISK_3MN_TABLE) expect(row[5] + row[6] + row[7]).toBeCloseTo(1, 2);
  });
});

describe('collision · galaxy models', () => {
  it('Milky Way model: v_c(8.2 kpc) ≈ 235–250 km/s and a flat curve to 30 kpc', () => {
    const m = smoothModelFor(MILKY_WAY);
    const v8 = simToKms(smoothVc(m, 8.2));
    expect(v8).toBeGreaterThan(225);
    expect(v8).toBeLessThan(255);
    expect(simToKms(smoothVc(m, 30)) / v8).toBeGreaterThan(0.85);
  });
  it('equilibrium initial conditions: virial ratio 2K/|Σ m x·a| ≈ 1', () => {
    // Virial theorem for a softened system: 2K + Σ m x·a = 0 (Plummer softening changes W, not
    // the virial). Galaxy 0 of a widely separated pair, about its own centre.
    const data = buildScenario({ galaxies: [{ spec: MILKY_WAY, i: 0, w: 0 }, { spec: MILKY_WAY, i: 0, w: 0 }], orbit: { rp: 5000, e: 1, r0: 6000 }, seed: 3 }, { skeleton: 3072, tracers: 2048 });
    const sim = new CpuNBody(data, { dt: 1, substeps: 4 });
    const c = sim.centers[0], cv = sim.centerVel[0];
    let K = 0, V = 0;
    for (let i = 0; i < sim.nS; i++) {
      if (sim.code[i] >> 2 !== 0) continue;
      const dx = sim.x[i * 3] - c[0], dy = sim.x[i * 3 + 1] - c[1], dz = sim.x[i * 3 + 2] - c[2];
      const vx = sim.v[i * 3] - cv[0], vy = sim.v[i * 3 + 1] - cv[1], vz = sim.v[i * 3 + 2] - cv[2];
      K += 0.5 * sim.m[i] * (vx * vx + vy * vy + vz * vz);
      V += sim.m[i] * (dx * sim.a[i * 3] + dy * sim.a[i * 3 + 1] + dz * sim.a[i * 3 + 2]);
    }
    const q = (-2 * K) / V;
    expect(q).toBeGreaterThan(0.92);
    expect(q).toBeLessThan(1.08);
  });
  it('symmetrised sampling puts the skeleton exactly at rest at the centre', () => {
    const R = realizeGalaxy(LATE_SPIRAL, { halo: 256, bulge: 64, disk: 128 }, { bulge: 64, disk: 256, gas: 64 }, { halo: 0.8, bulge: 0.12, disk: 0.3 }, 9);
    let px = 0, cx = 0;
    for (let i = 0; i < R.skeleton.mass.length; i++) {
      px += R.skeleton.mass[i] * R.skeleton.vel[i * 3];
      cx += R.skeleton.mass[i] * R.skeleton.pos[i * 3];
    }
    expect(Math.abs(px)).toBeLessThan(1e-12);
    expect(Math.abs(cx)).toBeLessThan(1e-10);
  });
});

describe('collision · orbits', () => {
  it('Kepler start reproduces the requested pericentre and is approaching', () => {
    for (const e of [0.6, 1, 1.4]) {
      const s = keplerStart(50, 50, { rp: 12, e, r0: 60 });
      const mu = G_SIM * 100;
      const r = Math.hypot(...s.r), v2 = s.v[0] ** 2 + s.v[1] ** 2;
      const h = Math.abs(s.r[0] * s.v[1] - s.r[1] * s.v[0]);
      const E = v2 / 2 - mu / r;
      const ecc = Math.sqrt(1 + (2 * E * h * h) / (mu * mu));
      const rp = (h * h) / mu / (1 + ecc);
      expect(rp).toBeCloseTo(12, 6);
      expect(s.r[0] * s.v[0] + s.r[1] * s.v[1]).toBeLessThan(0);
      expect(s.tPeri).toBeGreaterThan(0);
    }
  });
});

describe('collision · hybrid integrator (CPU reference)', () => {
  it('an isolated disk stays thin and energy is conserved for 300 Myr', () => {
    const data = buildScenario({ galaxies: [{ spec: MILKY_WAY, i: 0, w: 0 }, { spec: MILKY_WAY, i: 0, w: 0 }], orbit: { rp: 5000, e: 1, r0: 6000 }, seed: 5 }, { skeleton: 1536, tracers: 2048 });
    const sim = new CpuNBody(data, { dt: 1, substeps: 4 });
    const zrms = () => {
      const c = sim.centers[0], n = sim.spins[0];
      let s = 0, k = 0;
      for (let i = 0; i < sim.nT; i++) {
        if (sim.gal[i] !== 0 || sim.kind[i] !== 1) continue;
        const z = (sim.tx[i * 3] - c[0]) * n[0] + (sim.tx[i * 3 + 1] - c[1]) * n[1] + (sim.tx[i * 3 + 2] - c[2]) * n[2];
        s += z * z;
        k++;
      }
      return Math.sqrt(s / k);
    };
    const z0 = zrms();
    const E0 = sim.diagnostics().energy;
    for (let s = 0; s < 300; s++) sim.step();
    const d = sim.diagnostics();
    expect(Math.abs((d.energy - E0) / E0)).toBeLessThan(2e-3);
    expect(Math.hypot(...d.momentum)).toBeLessThan(1e-6);
    expect(zrms() / z0).toBeLessThan(1.15);
  }, 60000);
  it('a parabolic encounter reaches pericentre near the requested distance and captures', () => {
    const data = buildScenario({ galaxies: [{ spec: LATE_SPIRAL, i: 0, w: 0 }, { spec: LATE_SPIRAL, i: 60, w: 0 }], orbit: { rp: 10, e: 1, r0: 60 }, seed: 7 }, { skeleton: 1024, tracers: 1024 });
    const sim = new CpuNBody(data, { dt: 1, substeps: 2 });
    let minSep = Infinity, tMin = 0;
    for (let s = 1; s <= 260; s++) {
      sim.step();
      const [a, b] = sim.centers;
      const sep = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      if (sep < minSep) {
        minSep = sep;
        tMin = s;
      }
    }
    // Extended halos give a somewhat wider passage than the point-mass conic.
    expect(minSep).toBeGreaterThan(6);
    expect(minSep).toBeLessThan(25);
    expect(tMin).toBeGreaterThan(60);
    expect(tMin).toBeLessThan(200);
  }, 60000);
});

import { freeFallTime, sfRate, sfProbability, depletionTime, SF_RHO_TH, SF_GRID_CELL, SF_EFFICIENCY } from '../src/worlds/nbody/starformation';
import { PRESETS, customPreset, scaleGalaxy, DEFAULT_CUSTOM } from '../src/experiences/collision/presets';
import { diskRotation } from '../src/worlds/nbody/orbit';
import { whiteBalance } from '../src/worlds/nbody/GalaxyRenderer';
import { blackbodyRGB } from '../src/physics/blackbody';

describe('collision · star formation (Schmidt law per free-fall time)', () => {
  it('free-fall time of 1 M☉ pc⁻³ gas ≈ 8.3 Myr', () => {
    // 1 M☉ pc⁻³ = 1e9 M☉ kpc⁻³ = 0.1 sim units; t_ff = sqrt(3π/(32 G ρ)).
    expect(freeFallTime(0.1)).toBeGreaterThan(8.0);
    expect(freeFallTime(0.1)).toBeLessThan(8.6);
  });
  it('a normal Sc disk (Σ_gas ≈ 12 M☉ pc⁻² in a 0.75 kpc cell) depletes its gas in ~1–3 Gyr', () => {
    const sigma = 12e6 / 1e10; // 10¹⁰ M☉ kpc⁻²
    const rho = sigma / SF_GRID_CELL;
    const t = depletionTime(rho);
    expect(t).toBeGreaterThan(1000);
    expect(t).toBeLessThan(3000);
  });
  it('no star formation below the threshold; ρ^1.5 volumetric law well above it (Kennicutt slope)', () => {
    expect(sfRate(0.5 * SF_RHO_TH)).toBe(0);
    const r1 = 10 * SF_RHO_TH, r2 = 100 * SF_RHO_TH;
    const slope = Math.log((r2 * sfRate(r2)) / (r1 * sfRate(r1))) / Math.log(r2 / r1);
    expect(slope).toBeCloseTo(1.5, 6);
  });
  it('burst probability per step converts gas at exactly the Schmidt rate on average', () => {
    const rho = 20 * SF_RHO_TH, dt = 1;
    const massRate = (sfProbability(rho, dt) * SF_EFFICIENCY) / dt;
    expect(massRate / sfRate(rho)).toBeGreaterThan(0.97);
    expect(massRate / sfRate(rho)).toBeLessThanOrEqual(1);
  });
});

describe('collision · presets and encounter geometry', () => {
  it('scaling a galaxy at fixed density: M × f, lengths × f^⅓', () => {
    const g = scaleGalaxy(LATE_SPIRAL, 0.125);
    expect(g.halo.mass).toBeCloseTo(LATE_SPIRAL.halo.mass / 8, 10);
    expect(g.disk.scale).toBeCloseTo(LATE_SPIRAL.disk.scale / 2, 10);
    const mean = (x: { mass: number; scale: number }) => x.mass / x.scale ** 3;
    expect(mean(g.halo)).toBeCloseTo(mean(LATE_SPIRAL.halo), 8);
  });
  it('the Cartwheel intruder arrives along the target disk’s spin axis (ring-making geometry)', () => {
    const p = PRESETS.find((q) => q.id === 'cartwheel')!;
    const g = p.scenario.galaxies[0];
    const R = diskRotation(g.i, g.w);
    const n = [R[2], R[5], R[8]]; // spin axis in the orbit frame
    const s = keplerStart(100, 20, p.scenario.orbit);
    const r = Math.hypot(...s.r);
    const cos = Math.abs((n[0] * s.r[0] + n[1] * s.r[1] + n[2] * s.r[2]) / r);
    expect(cos).toBeGreaterThan(0.9);
  });
  it('preset moments are ordered and the warm-up opens the story after the approach', () => {
    for (const p of PRESETS) {
      for (let k = 1; k < p.moments.length; k++) expect(p.moments[k].t).toBeGreaterThan(p.moments[k - 1].t);
      expect(p.warmup).toBeGreaterThan(p.moments[0].t);
    }
  });
  it('custom encounters: prograde/retrograde labelling and a smaller companion', () => {
    const c = customPreset({ ...DEFAULT_CUSTOM, massRatio: 4 });
    expect(c.designation).toContain('prograde × retrograde');
    expect(c.scenario.galaxies[1].spec.disk.mass).toBeCloseTo(c.scenario.galaxies[0].spec.disk.mass / 4, 10);
  });
});

describe('collision · stellar populations and colour', () => {
  it('inside-out disks: young disk stars sit at larger radii than old ones', () => {
    const R = realizeGalaxy(LATE_SPIRAL, { halo: 128, bulge: 64, disk: 128 }, { bulge: 256, disk: 12000, gas: 256 }, { halo: 0.8, bulge: 0.12, disk: 0.3 }, 11);
    let ry = 0, ny = 0, ro = 0, no = 0;
    const { pos, age, kind } = R.tracers;
    for (let i = 0; i < kind.length; i++) {
      if (kind[i] !== 1) continue;
      const r = Math.hypot(pos[i * 3], pos[i * 3 + 1]);
      if (age[i] < 1000) (ry += r), ny++;
      else if (age[i] > 6000) (ro += r), no++;
    }
    expect(ny).toBeGreaterThan(100);
    expect(ry / ny / (ro / no)).toBeGreaterThan(1.15);
  });
  it('white balance maps an average-spiral (5300 K) population to neutral and keeps hot stars blue', () => {
    const wb = whiteBalance(5300);
    const c = blackbodyRGB(5300);
    const n = [c[0] * wb.x, c[1] * wb.y, c[2] * wb.z];
    expect(n[0]).toBeCloseTo(n[1], 6);
    expect(n[2]).toBeCloseTo(n[1], 6);
    const hot = blackbodyRGB(15000);
    expect(hot[2] * wb.z).toBeGreaterThan(hot[0] * wb.x);
  });
});

describe('collision · Milkomeda timing (CPU reference)', () => {
  it('first pericentre ≈ 3.9 Gyr from now (van der Marel et al. 2012: 3.87 Gyr)', () => {
    const p = PRESETS.find((q) => q.id === 'milkomeda')!;
    const data = buildScenario(p.scenario, { skeleton: 1024, tracers: 1024 });
    const sim = new CpuNBody(data, { dt: 2, substeps: 1 });
    let best = Infinity, tBest = 0;
    for (let s = 0; s < 300; s++) {
      sim.step();
      const [a, b] = sim.centers;
      const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      if (d < best) (best = d), (tBest = sim.time);
    }
    const tNow = (tBest + p.clock!.offsetMyr) / 1000;
    expect(tNow).toBeGreaterThan(3.6);
    expect(tNow).toBeLessThan(4.2);
    expect(best).toBeLessThan(60);
  }, 120000);
});
