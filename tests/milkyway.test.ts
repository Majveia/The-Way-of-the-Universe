import { describe, expect, it } from 'vitest';
import {
  GalaxyPotential,
  milkyWayComponents,
  kmsKpcFromRadMyr,
  kmsFromPcMyr,
  leapfrogStep,
  radMyrFromKmsKpc,
  G_GAL,
  PCMYR_PER_KMS,
} from '../src/physics/galaxyPotential';
import { ccmExtinction, msLifetime, sampleKroupa, hiiRGB, visualEfficacy, visualEfficacyFit, stromgrenRadius, hiiLineLuminosity } from '../src/physics/galaxyStars';
import { densityParams, lumDensity, mwReference, nearestLocalStars, LOCAL_TIERS } from '../src/worlds/galaxy/localStars';
import { generateParticles, GalaxyModel, Kinematics, particleState, KIND_DISK, STRIDE, KIND_YOUNG, type ParticleState } from '../src/worlds/galaxy/model';
import { milkyWay, preset, armPhi, wrapPi } from '../src/worlds/galaxy/params';
import { pcg, hash2u, u01 } from '../src/worlds/galaxy/hash';

const mw = () => new GalaxyPotential(milkyWayComponents());

describe('units', () => {
  it('G in pc³ M☉⁻¹ Myr⁻² and km/s ↔ pc/Myr', () => {
    expect(G_GAL).toBeCloseTo(4.4985e-3, 6);
    expect(PCMYR_PER_KMS).toBeCloseTo(1.0227, 4);
    expect(kmsKpcFromRadMyr(radMyrFromKmsKpc(25))).toBeCloseTo(25, 10);
  });
});

describe('Milky Way rotation curve', () => {
  const p = mw();
  it('v_c at the Sun (8.2 kpc) ≈ 230 km/s', () => {
    const v = p.vcKms(8200);
    expect(v).toBeGreaterThan(225);
    expect(v).toBeLessThan(236);
  });
  it('is flat with dark matter and Keplerian-falling without it', () => {
    expect(Math.abs(p.vcKms(20000) - p.vcKms(8200))).toBeLessThan(15);
    const b8 = p.vcKms(8200, false);
    const b20 = p.vcKms(20000, false);
    const b40 = p.vcKms(40000, false);
    expect(b8).toBeLessThan(190);
    expect(b20).toBeLessThan(b8 * 0.8);
    // Far outside the baryons v ∝ r^−1/2.
    expect(b40 / b20).toBeGreaterThan(0.68);
    expect(b40 / b20).toBeLessThan(0.8);
  });
  it('orbital period at R⊙ ≈ 220 Myr (the galactic year)', () => {
    const T = p.period(8200);
    expect(T).toBeGreaterThan(205);
    expect(T).toBeLessThan(240);
  });
  it('epicyclic and vertical frequencies near the Sun', () => {
    const kappa = kmsKpcFromRadMyr(p.kappa(8200));
    expect(kappa).toBeGreaterThan(33);
    expect(kappa).toBeLessThan(42);
    // Vertical oscillation period of the Sun ≈ 80–90 Myr.
    const Tz = (2 * Math.PI) / p.nu(8200);
    expect(Tz).toBeGreaterThan(65);
    expect(Tz).toBeLessThan(100);
    const { A, B } = p.oort(8200);
    expect(A).toBeGreaterThan(12);
    expect(A).toBeLessThan(17);
    expect(B).toBeLessThan(-10);
    expect(B).toBeGreaterThan(-15);
  });
  it('escape speed at the Sun ≈ 530–600 km/s (Piffl 2014; Monari 2018)', () => {
    const v = kmsFromPcMyr(p.escapeSpeed(8200));
    expect(v).toBeGreaterThan(500);
    expect(v).toBeLessThan(650);
  });
  it('κ matches the numerical derivative of the rotation curve', () => {
    for (const R of [2000, 6000, 12000]) {
      const h = 1;
      const d = (p.omega(R + h) ** 2 * (R + h) ** 4 - p.omega(R - h) ** 2 * (R - h) ** 4) / (2 * h);
      const k2 = d / R ** 3; // κ² = R⁻³ d(R⁴Ω²)/dR
      expect(Math.sqrt(k2) / p.kappa(R)).toBeCloseTo(1, 4);
    }
  });
  it('bar and spiral resonances', () => {
    const cr = p.resonance(radMyrFromKmsKpc(39), 'CR');
    expect(cr).toBeGreaterThan(5000);
    expect(cr).toBeLessThan(7000);
    const olr = p.resonance(radMyrFromKmsKpc(39), 'OLR');
    expect(olr).toBeGreaterThan(8500); // the bar's OLR lies near the Sun (Hercules stream)
    expect(olr).toBeLessThan(11500);
  });
  it('leapfrog conserves energy on a disk orbit', () => {
    const pos = { x: 8200, y: 0, z: 50 };
    const v0 = p.vc(8200);
    const vel = { x: 10, y: v0 * 1.05, z: 5 };
    const E = () => 0.5 * (vel.x ** 2 + vel.y ** 2 + vel.z ** 2) + p.phi(Math.hypot(pos.x, pos.y), pos.z);
    const e0 = E();
    const s = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 20000; i++) leapfrogStep(p, pos, vel, 0.1, s); // 2 Gyr
    expect(Math.abs((E() - e0) / e0)).toBeLessThan(1e-4);
  });
  it('without dark matter the outer disk is unbound at its observed speed', () => {
    const R = 20000;
    const v = p.vc(R, true);
    expect(v).toBeGreaterThan(p.escapeSpeed(R, 0, false));
  });
});

describe('stellar populations', () => {
  it('main-sequence lifetimes', () => {
    expect(msLifetime(1)).toBeCloseTo(10000, -2);
    expect(msLifetime(20)).toBeGreaterThan(7);
    expect(msLifetime(20)).toBeLessThan(11);
    expect(msLifetime(60)).toBeLessThan(5);
  });
  it('Kroupa IMF: about a quarter of stars above 0.5 M☉', () => {
    let hi = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) if (sampleKroupa((i + 0.5) / n) > 0.5) hi++;
    expect(hi / n).toBeGreaterThan(0.2);
    expect(hi / n).toBeLessThan(0.3);
  });
  it('CCM extinction: A_B/A_V ≈ 1.32, A_V/A_V = 1, redder is less', () => {
    expect(ccmExtinction(440)).toBeCloseTo(1.32, 1);
    expect(ccmExtinction(549)).toBeCloseTo(1.0, 1);
    expect(ccmExtinction(650)).toBeLessThan(0.9);
  });
  it('HII regions are pink (red and blue exceed green)', () => {
    const [r, g, b] = hiiRGB(0.2);
    expect(r).toBeGreaterThan(g);
    expect(b).toBeGreaterThan(g * 0.9);
  });
});

describe('hashing is stable (CPU mirror of the GPU)', () => {
  it('known PCG values', () => {
    expect(pcg(0)).toBe(129708002);
    expect(pcg(1)).toBe(2831084092);
    expect(hash2u(-1, 5)).toBe(hash2u(0xffffffff, 5));
    expect(u01(0xffffffff)).toBeLessThan(1);
  });
});

describe('GalaxyModel', () => {
  it('generation is deterministic for a seed and changes with the seed', () => {
    const a = generateParticles(milkyWay(7), 20000);
    const b = generateParticles(milkyWay(7), 20000);
    const c = generateParticles(milkyWay(8), 20000);
    expect(a.count).toBe(b.count);
    expect(a.data).toEqual(b.data);
    expect(a.data).not.toEqual(c.data);
    expect(a.count).toBeGreaterThan(19000);
    expect(a.count).toBeLessThan(21000);
    for (const v of a.data) expect(Number.isFinite(v)).toBe(true);
  });

  it('every preset generates finite particles and positions', () => {
    for (const id of ['milkyway', 'E0', 'E5', 'S0', 'Sa', 'Sb', 'Sc', 'SBb', 'SBc', 'Irr'] as const) {
      const p = preset(id, 3);
      const g = generateParticles(p, 6000);
      const k = new Kinematics(p);
      const s: ParticleState = { x: 0, y: 0, z: 0, lum: 0, temperature: 0 };
      for (let i = 0; i < g.count; i += 7) {
        particleState(k, g.data, i, 123.4, s);
        expect(Number.isFinite(s.x + s.y + s.z + s.lum + s.temperature)).toBe(true);
      }
    }
  });

  it('the density wave crowds disk stars onto the arm loci (Kalnajs kinematic spiral)', () => {
    const p = milkyWay(1);
    const g = generateParticles(p, 250000);
    const k = new Kinematics(p);
    const s: ParticleState = { x: 0, y: 0, z: 0, lum: 0, temperature: 0 };
    const cot = 1 / Math.tan((p.spiral.pitchDeg * Math.PI) / 180);
    for (const t of [0, 60, 300]) {
      // m = 2 Fourier component of the old-star surface density at 5–8 kpc, measured in the frame
      // of the kinematic arm locus (pattern frame, φ_arm(R) = phase − cot(i) ln(R/r0)).
      // A histogram argmax is noise-dominated; the Fourier phase and amplitude are robust.
      let C = 0;
      let S = 0;
      let n = 0;
      for (let i = 0; i < g.count; i++) {
        if (g.data[i * STRIDE] !== KIND_DISK) continue;
        particleState(k, g.data, i, t, s);
        const R = Math.hypot(s.x, s.z);
        if (R < 5000 || R > 8000) continue;
        const phi = Math.atan2(-p.spin * s.z, s.x) - k.omegaP * t;
        const d = 2 * (phi - (p.spiral.phase - Math.log(R / p.spiral.r0) * cot));
        C += Math.cos(d);
        S += Math.sin(d);
        n++;
      }
      const amp = (2 * Math.hypot(C, S)) / n; // δΣ/Σ
      const phase = Math.atan2(S, C) / 2; // offset of the density maximum from the locus (rad)
      expect(Math.abs(wrapPi(2 * phase) / 2)).toBeLessThan(0.15); // within ~9° of the arm
      // Arm/inter-arm (1 + δ)/(1 − δ) ≈ 1.2–1.4: K-band contrasts of real spirals (Rix & Zaritsky 1995).
      expect(amp).toBeGreaterThan(0.08);
      expect(amp).toBeLessThan(0.3);
    }
  });

  it('young clusters are born in the arms and age', () => {
    const p = milkyWay(1);
    const g = generateParticles(p, 60000);
    const k = new Kinematics(p);
    const s: ParticleState = { x: 0, y: 0, z: 0, lum: 0, temperature: 0 };
    let near = 0;
    let bright = 0;
    for (let i = 0; i < g.count; i++) {
      if (g.data[i * STRIDE] !== KIND_YOUNG) continue;
      particleState(k, g.data, i, 0, s);
      if (s.lum <= 0) continue;
      // Only stars younger than ~8 Myr (the O stars that make HII regions) hug the arms.
      const tau = g.data[i * STRIDE + 5];
      if (tau > 12) continue;
      bright++;
      const R = Math.hypot(s.x, s.z);
      const phi = Math.atan2(-p.spin * s.z, s.x);
      let dmin = Infinity;
      for (const a of k.arms) {
        if (R < a.rStart || R > a.rEnd) continue;
        const dp = Math.abs(wrapPi(phi - armPhi(a, R)));
        dmin = Math.min(dmin, dp * R * Math.sin((a.pitchDeg * Math.PI) / 180));
      }
      if (dmin < 900) near++;
    }
    expect(bright).toBeGreaterThan(20);
    expect(near / bright).toBeGreaterThan(0.6);
  });
});

describe('local star field (procedural, CPU mirror of the GPU)', () => {
  const p = milkyWay(1);
  const dp = densityParams(p, mwReference(p));
  const sun = p.sun!;
  const sx = -sun.R; // model frame: the Sun at azimuth π
  it('is normalised to the solar neighbourhood', () => {
    expect(lumDensity(dp, sx, 0, sun.z) / dp.ref).toBeCloseTo(1, 6);
    // Local luminosity function: ≈ 0.1 stars pc⁻³ and ≈ 0.04 L☉ pc⁻³ (Reid & Hawley 2005).
    const n = LOCAL_TIERS.reduce((a, t) => a + t.n0, 0);
    expect(n).toBeGreaterThan(0.08);
    expect(n).toBeLessThan(0.14);
  });
  it('nearest stars are deterministic, sorted and at realistic distances', () => {
    const a = nearestLocalStars(dp, 1, sx, 0, sun.z, 40);
    const b = nearestLocalStars(dp, 1, sx, 0, sun.z, 40);
    expect(a.map((s) => s.id)).toEqual(b.map((s) => s.id));
    const d = a.map((s) => Math.hypot(s.x - sx, s.y, s.h - sun.z));
    for (let i = 1; i < d.length; i++) expect(d[i]).toBeGreaterThanOrEqual(d[i - 1]);
    // 40 stars at 0.1 pc⁻³ fill a sphere of ≈ 4.6 pc (the real count within 5 pc is ≈ 60–70 systems).
    expect(d[39]).toBeGreaterThan(3);
    expect(d[39]).toBeLessThan(7);
    for (const s of a) {
      expect(s.temperatureK).toBeGreaterThan(2000);
      expect(s.temperatureK).toBeLessThan(40000);
      expect(s.luminosity).toBeGreaterThan(0);
    }
    // Most nearby stars are M dwarfs.
    expect(a.filter((s) => s.luminosity < 0.1).length / a.length).toBeGreaterThan(0.5);
  });
  it('star density follows the disk: far fewer stars 1 kpc above the plane', () => {
    const inPlane = nearestLocalStars(dp, 1, sx, 0, 0, 30);
    const above = nearestLocalStars(dp, 1, sx, 0, 1000, 30);
    const r = (a: typeof inPlane, h: number) => Math.hypot(a[29].x - sx, a[29].y, a[29].h - h);
    expect(r(above, 1000)).toBeGreaterThan(1.8 * r(inPlane, 0));
  });
});

describe('visual efficacy', () => {
  it('matches the numerical integral and the Sun is 1', () => {
    for (const T of [3000, 4500, 5772, 9000, 15000, 30000]) {
      expect(Math.log10(visualEfficacyFit(T) / visualEfficacy(T))).toBeLessThan(0.02);
      expect(Math.log10(visualEfficacyFit(T) / visualEfficacy(T))).toBeGreaterThan(-0.02);
    }
    expect(visualEfficacy(5772)).toBeCloseTo(1, 6);
    // Hot stars emit mostly ultraviolet: a 35 000 K O star gives ~6% of the Sun's light per watt.
    expect(visualEfficacy(35000)).toBeLessThan(0.1);
  });
  it('HII regions: Strömgren radius and line luminosity', () => {
    // Q = 10⁴⁹ s⁻¹ (an O7 star) at n = 30 cm⁻³ → R_S ≈ 7 pc; Orion (Q ≈ 10⁴⁹) glows at ~10⁴ L☉ in lines.
    const r = stromgrenRadius(1e49, 30);
    expect(r).toBeGreaterThan(5);
    expect(r).toBeLessThan(9);
    const L = hiiLineLuminosity(1e49);
    expect(L).toBeGreaterThan(3e3);
    expect(L).toBeLessThan(1e4);
  });
});

describe('GalaxyModel facade', () => {
  it('wraps generation, kinematics and the potential', () => {
    const g = new GalaxyModel(milkyWay(2), 5000);
    expect(g.count).toBeGreaterThan(4500);
    const s = g.stateAt(0, 42);
    expect(Number.isFinite(s.x + s.y + s.z)).toBe(true);
    expect(g.potential.vcKms(8200)).toBeGreaterThan(220);
  });
});
