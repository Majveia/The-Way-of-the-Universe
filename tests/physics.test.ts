import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Cosmology, cosmicCalendar } from '../src/physics/cosmology';
import { orbitState, solveKepler, orbitalPeriod } from '../src/physics/kepler';
import { blackbodyRGB } from '../src/physics/blackbody';
import { wavelengthToRGB, LINES } from '../src/physics/spectrum';
import { GM_SUN, AU, YEAR } from '../src/physics/constants';
import { Rng } from '../src/physics/random';

describe('cosmology (Planck 2018)', () => {
  const c = new Cosmology();
  it('age of the universe ≈ 13.79 Gyr', () => {
    expect(c.ageGyr(1)).toBeGreaterThan(13.7);
    expect(c.ageGyr(1)).toBeLessThan(13.85);
  });
  it('recombination happens ~370 kyr after the Big Bang', () => {
    const t = c.ageGyr(1 / 1090) * 1e6; // kyr
    expect(t).toBeGreaterThan(330);
    expect(t).toBeLessThan(420);
  });
  it('growth factor is normalised and suppressed by Λ', () => {
    expect(c.growth(1)).toBeCloseTo(1, 6);
    // In EdS D ∝ a; with Λ, D(0.5)/D(1) > 0.5
    expect(c.growth(0.5)).toBeGreaterThan(0.5);
    expect(c.growth(0.5)).toBeLessThan(0.65);
    expect(c.growthRate(1)).toBeGreaterThan(0.5); // f ≈ Ωm^0.55 ≈ 0.53
    expect(c.growthRate(1)).toBeLessThan(0.56);
  });
  it('Einstein–de Sitter: D = a, age = 2/(3H0)', () => {
    const eds = new Cosmology({ Om0: 1, Ode0: 0, Or0: 0 });
    expect(eds.growth(0.25)).toBeCloseTo(0.25, 3);
    const tH = eds.hubbleTime / (365.25 * 86400 * 1e9);
    expect(eds.ageGyr(1)).toBeCloseTo((2 / 3) * tH, 2);
  });
  it('aAtTime inverts time', () => {
    for (const a of [1e-4, 0.01, 0.3, 1, 2]) expect(c.aAtTime(c.time(a)) / a).toBeCloseTo(1, 4);
  });
  it('dark energy starts accelerating the expansion near z ≈ 0.6', () => {
    const zAcc = 1 / 0.61 - 1;
    expect(c.q(1 / (1 + zAcc - 0.2))).toBeLessThan(0);
    expect(c.q(1 / (1 + zAcc + 0.2))).toBeGreaterThan(0);
  });
  it('comoving distance to z=1 ≈ 3.4 Gpc', () => {
    const d = c.comovingDistanceMpc(1);
    expect(d).toBeGreaterThan(3300);
    expect(d).toBeLessThan(3450);
  });
  it('cosmic calendar ends on Dec 31', () => {
    expect(cosmicCalendar(1).month).toBe('December');
    expect(cosmicCalendar(0).label.startsWith('January 1')).toBe(true);
  });
});

describe('Kepler', () => {
  it('solves Kepler’s equation to machine precision', () => {
    for (const e of [0, 0.1, 0.5, 0.9, 0.99]) {
      for (const M of [0.1, 1, 3, 5.5]) {
        const E = solveKepler(M, e);
        const Mn = ((M + Math.PI) % (2 * Math.PI)) - Math.PI;
        expect(E - e * Math.sin(E)).toBeCloseTo(Mn, 10);
      }
    }
  });
  it('Earth’s period is one year and energy is conserved', () => {
    expect(orbitalPeriod(AU, GM_SUN) / YEAR).toBeCloseTo(1.0000, 3);
    const el = { a: AU, e: 0.0167, i: 0, node: 0, peri: 1.8, M0: 0.3, epoch: 0 };
    const p = new THREE.Vector3(), v = new THREE.Vector3();
    const energy = (t: number) => {
      orbitState(el, t, GM_SUN, p, v);
      return 0.5 * v.lengthSq() - GM_SUN / p.length();
    };
    const e0 = energy(0);
    expect(Math.abs(energy(1e7) - e0) / Math.abs(e0)).toBeLessThan(1e-10);
    expect(e0).toBeCloseTo(-GM_SUN / (2 * AU), -3);
  });
});

describe('colour science', () => {
  it('the Sun (5772 K) is nearly white; 3000 K is orange; 20000 K is blue', () => {
    const [r, g, b] = blackbodyRGB(5772);
    expect(Math.abs(r - b) / g).toBeLessThan(0.35);
    const [r3, , b3] = blackbodyRGB(3000);
    expect(r3).toBeGreaterThan(b3 * 3);
    const [r2, , b2] = blackbodyRGB(20000);
    expect(b2).toBeGreaterThan(r2);
  });
  it('Hα is red, [OIII] is teal', () => {
    const [r, g, b] = wavelengthToRGB(LINES.H_ALPHA);
    expect(r).toBeGreaterThan(g * 3);
    expect(r).toBeGreaterThan(b * 3);
    const [r2, g2, b2] = wavelengthToRGB(LINES.OIII_5007);
    expect(g2).toBeGreaterThan(r2);
    expect(b2).toBeGreaterThan(r2);
  });
});

describe('seeded randomness', () => {
  it('is deterministic and forks are order-independent', () => {
    const a = new Rng('andromeda');
    const b = new Rng('andromeda');
    expect(a.next()).toBe(b.next());
    const f1 = a.fork('planet', 2).next();
    a.next();
    expect(a.fork('planet', 2).next()).toBe(f1);
  });
});
