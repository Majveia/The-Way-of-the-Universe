import { describe, expect, it } from 'vitest';
import {
  alphaB,
  avFromBalmerDecrement,
  blackbodyPhotonRate,
  BALMER_CASE_B,
  ccm89,
  coastRadiusPc,
  CRAB_PULSAR,
  densityFromSii,
  describeIonizingFlux,
  IONIZATION_EV,
  kinematicAgeYears,
  NEBULA_LINES,
  paletteLineColours,
  photonBudgetK,
  photonFractionAbove,
  photonIntegral,
  powerLawRGB,
  pulsarExposure,
  sedovRadiusPc,
  sedovVelocityKmS,
  siiRatio,
  spitzerRadiusPc,
  stromgrenRadiusPc,
  tauVPerPc,
  trueLineRGB,
  zoneThreshold,
} from '../src/physics/nebulae';
import { LINES } from '../src/physics/spectrum';
import { R_SUN } from '../src/physics/constants';

describe('photoionization', () => {
  it('Case-B recombination coefficient is 2.59e-13 cm³/s at 10⁴ K and falls with T', () => {
    expect(alphaB(1e4)).toBeCloseTo(2.59e-13, 15);
    expect(alphaB(5000)).toBeGreaterThan(alphaB(1e4));
    expect(alphaB(2e4)).toBeLessThan(alphaB(1e4));
  });

  it('photon integral tends to 2ζ(3) and decays like x² e^{-x}', () => {
    expect(photonIntegral(1e-6)).toBeCloseTo(2.4041, 3);
    const x = 20;
    expect(photonIntegral(x) / (x * x * Math.exp(-x))).toBeCloseTo(1.1, 1);
  });

  it('a 37 kK, 8.5 R☉ O7 V blackbody emits ~10^48.7 ionizing photons/s', () => {
    const q = blackbodyPhotonRate(36870, 8.5 * R_SUN);
    expect(Math.log10(q)).toBeGreaterThan(48.5);
    expect(Math.log10(q)).toBeLessThan(49.0);
  });

  it('Strömgren radius: 3.15 pc for Q = 10⁴⁹ s⁻¹, n = 100 cm⁻³, and ∝ Q^{1/3} n^{-2/3}', () => {
    const r = stromgrenRadiusPc(1e49, 100);
    expect(r).toBeCloseTo(3.15, 2);
    expect(stromgrenRadiusPc(8e49, 100) / r).toBeCloseTo(2, 6);
    expect(stromgrenRadiusPc(1e49, 800) / r).toBeCloseTo(0.25, 6);
  });

  it('photon-budget integral reaches exactly 1 at the Strömgren radius (uniform gas)', () => {
    const Q = 3e49;
    const n = 250;
    const K = photonBudgetK(Q);
    const rs = stromgrenRadiusPc(Q, n);
    // C(r) = K n² r³/3 for uniform density.
    expect((K * n * n * rs * rs * rs) / 3).toBeCloseTo(1, 10);
  });

  it('hot planetary-nebula nuclei are far harder than O stars', () => {
    const oStar = photonFractionAbove(40000, IONIZATION_EV.OII);
    const pnn = photonFractionAbove(125000, IONIZATION_EV.OII);
    expect(oStar).toBeLessThan(0.02);
    expect(pnn).toBeGreaterThan(0.3);
    expect(photonFractionAbove(40000, IONIZATION_EV.HeII)).toBeLessThan(1e-3);
  });

  it('zones: He⁺ fills the H⁺ zone for T* ≥ 40 kK but not at 30 kK (O&F §2.5); He II needs a PN nucleus', () => {
    expect(zoneThreshold(40000, 'He+')).toBeCloseTo(1, 5);
    expect(zoneThreshold(30000, 'He+')).toBeLessThan(0.5);
    expect(zoneThreshold(38000, 'O++')).toBeLessThan(zoneThreshold(38000, 'He+'));
    expect(zoneThreshold(40000, 'He++')).toBeLessThan(1e-3);
    expect(zoneThreshold(125000, 'He++')).toBeGreaterThan(0.1);
    expect(zoneThreshold(125000, 'He++')).toBeLessThan(1);
  });

  it('Spitzer expansion starts at R_S and grows as t^{4/7}', () => {
    expect(spitzerRadiusPc(3, 0)).toBeCloseTo(3, 10);
    const r1 = spitzerRadiusPc(0.1, 1e7);
    const r2 = spitzerRadiusPc(0.1, 2e7);
    expect(r2 / r1).toBeCloseTo(Math.pow(2, 4 / 7), 2);
  });

  it('labels ionizing flux in O-star equivalents', () => {
    expect(describeIonizingFlux(1.05e49)).toContain('O6 V');
    expect(describeIonizingFlux(10 ** 49.64 * 5)).toContain('5 × O3 V');
  });
});

describe('emission lines', () => {
  it('[SII] 6716/6731 runs from 1.49 (low density) to 0.44 (high density) and inverts', () => {
    expect(siiRatio(1)).toBeCloseTo(1.49, 2);
    expect(siiRatio(1e6)).toBeCloseTo(0.44, 2);
    expect(siiRatio(1000)).toBeGreaterThan(0.85);
    expect(siiRatio(1000)).toBeLessThan(0.95);
    for (const n of [30, 300, 3000, 30000]) expect(densityFromSii(siiRatio(n)) / n).toBeCloseTo(1, 6);
  });

  it('true-colour lines carry photopic luminance: [OIII] outshines Hα per watt, Hα is red', () => {
    const y = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    const ha = trueLineRGB(LINES.H_ALPHA);
    const o3 = trueLineRGB(LINES.OIII_5007);
    expect(y(o3) / y(ha)).toBeGreaterThan(3);
    expect(ha[0]).toBeGreaterThan(10 * ha[1]);
  });

  it('a Case-B H II region is pink in true colour (red + blue, little green)', () => {
    const p = paletteLineColours('true');
    const rgb = [0, 1, 2].map((i) => BALMER_CASE_B.Ha * p.Ha[i] + BALMER_CASE_B.Hb * p.Hb[i] + BALMER_CASE_B.Hg * p.Hg[i]);
    expect(rgb[0]).toBeGreaterThan(rgb[1] * 2);
    expect(rgb[2]).toBeGreaterThan(rgb[1]);
  });

  it('Hubble palette maps [SII] → red, Hα → green, [OIII] → blue', () => {
    const p = paletteLineColours('sho');
    const argmax = (c: number[]) => c.indexOf(Math.max(...c));
    expect(argmax(p.SII)).toBe(0);
    expect(argmax(p.Ha)).toBe(1);
    expect(argmax(p.OIII)).toBe(2);
    expect(p.Hb.every((v) => v === 0)).toBe(true);
    expect(NEBULA_LINES.map((l) => l.id)).toEqual(['Ha', 'Hb', 'Hg', 'OIII', 'NII', 'SII', 'HeI', 'HeII']);
  });

  it('Crab synchrotron (α ≈ 0.6) is bluish white', () => {
    const [r, g, b] = powerLawRGB(0.6);
    expect(b).toBeGreaterThan(r);
    expect(Math.abs(r - g)).toBeLessThan(0.1);
  });
});

describe('dust', () => {
  it('CCM89 is normalised at V and gives R_V = A_V/E(B−V) = 3.1', () => {
    expect(ccm89(549)).toBeCloseTo(1, 2);
    const ab = ccm89(440);
    expect(1 / (ab - ccm89(549))).toBeCloseTo(3.1, 1);
    expect(ccm89(LINES.H_ALPHA)).toBeLessThan(ccm89(LINES.OIII_5007));
    expect(ccm89(217.5)).toBeGreaterThan(ccm89(160)); // 2175 Å bump region vs. far-UV minimum shape
  });

  it('A_V per pc: n = 1000 cm⁻³ gives τ_V ≈ 1.5 per parsec', () => {
    expect(tauVPerPc(1000)).toBeGreaterThan(1.4);
    expect(tauVPerPc(1000)).toBeLessThan(1.65);
  });

  it('recovers A_V from a reddened Balmer decrement', () => {
    const av = 2;
    const reddened = BALMER_CASE_B.Ha * Math.pow(10, -0.4 * av * (ccm89(LINES.H_ALPHA) - ccm89(LINES.H_BETA)));
    expect(avFromBalmerDecrement(reddened)).toBeCloseTo(av, 6);
    expect(avFromBalmerDecrement(2.86)).toBeCloseTo(0, 6);
  });
});

describe('expansion and pulsar', () => {
  it('Sedov–Taylor: 1e51 erg into n = 1 cm⁻³ reaches 12.5 pc at 10 kyr; v = 2R/5t', () => {
    expect(sedovRadiusPc(1e51, 1, 1e4)).toBeCloseTo(12.5, 1);
    const v = sedovVelocityKmS(1e51, 1, 1e4);
    expect(v).toBeGreaterThan(450);
    expect(v).toBeLessThan(520);
  });

  it('Crab: 1500 km/s for 972 years ≈ 1.5 pc; kinematic ages invert', () => {
    expect(coastRadiusPc(1500, 972)).toBeCloseTo(1.49, 1);
    expect(kinematicAgeYears(coastRadiusPc(25, 4000), 25)).toBeCloseTo(4000, 6);
  });

  it('pulsar exposure conserves the time-averaged light curve and resolves pulses in slow motion', () => {
    const P = CRAB_PULSAR.period;
    // Averaging over many periods gives the same mean regardless of phase.
    const a = pulsarExposure(0.0123, 50 * P);
    const b = pulsarExposure(0.0371, 50 * P);
    expect(a).toBeCloseTo(b, 2);
    // A short exposure at the main pulse is near its peak; between pulses it is dark.
    expect(pulsarExposure(-0.00005, 1e-4)).toBeGreaterThan(0.9);
    expect(pulsarExposure(0.2 * P, 1e-4)).toBeLessThan(0.05);
  });
});

// ——— Catalogue, layouts and stellar populations ————————————————————————————————————

import { PRESETS, VARIANTS, blackbodyQ, DEFAULT_VARIANT } from '../src/worlds/nebula/presets';
import { buildLayout } from '../src/worlds/nebula/layouts';
import { absoluteMagnitude, msLuminosity, msTemperature, plummerPoint, sampleKroupa } from '../src/worlds/nebula/stars';
import { Rng } from '../src/physics/random';

describe('nebula catalogue', () => {
  it('has every spec type, a default view and an info card for each object', () => {
    expect(new Set(VARIANTS)).toEqual(new Set(Object.keys(PRESETS)));
    for (const t of ['emission', 'planetary', 'remnant', 'dark', 'reflection'] as const) expect(PRESETS[DEFAULT_VARIANT[t]].type).toBe(t);
    for (const v of VARIANTS) {
      const p = PRESETS[v];
      expect(p.views.default).toBeDefined();
      expect(p.info.rows.length).toBeGreaterThanOrEqual(4);
      expect(p.gain).toBeGreaterThan(0);
      expect(p.half).toBeGreaterThan(0);
    }
  });

  it('planetary-nebula nuclei: blackbody Q from (T, L) — M57 ≈ 10^46 photons/s, hotter → more per watt', () => {
    const q = blackbodyQ(125000, 200);
    expect(Math.log10(q)).toBeGreaterThan(45.9);
    expect(Math.log10(q)).toBeLessThan(46.6);
    // Photons per unit luminosity fall as the mean photon energy (∝ T) rises.
    const r = blackbodyQ(220000, 1) / blackbodyQ(110000, 1);
    expect(r).toBeGreaterThan(0.5);
    expect(r).toBeLessThan(0.7);
  });

  it('kinematic ages of the expanding presets agree with their quoted ages to within a factor ~2', () => {
    for (const v of ['ring', 'helix', 'butterfly', 'crab'] as const) {
      const p = PRESETS[v];
      const age = kinematicAgeYears(p.shellRadius, p.expansionKmS);
      expect(age / p.ageYears).toBeGreaterThan(0.5);
      expect(age / p.ageYears).toBeLessThan(2);
    }
    // Veil: Sedov–Taylor, v = (2/5) R / t.
    const veil = PRESETS.veil;
    const vST = (0.4 * veil.shellRadius * 3.0857e13) / (veil.ageYears * 3.15576e7);
    expect(vST / veil.expansionKmS).toBeGreaterThan(0.8);
    expect(vST / veil.expansionKmS).toBeLessThan(1.25);
  });

  it('M57: the main ring sits near the Strömgren radius of its nucleus', () => {
    const rs = stromgrenRadiusPc(PRESETS.ring.source.Q, 600);
    expect(rs).toBeGreaterThan(0.06);
    expect(rs).toBeLessThan(0.2);
  });
});

describe('layouts', () => {
  it('are deterministic per seed and differ between seeds', () => {
    for (const v of VARIANTS) {
      const a = buildLayout(PRESETS[v], 3);
      const b = buildLayout(PRESETS[v], 3);
      expect(a.stars.map((s) => s.pos)).toEqual(b.stars.map((s) => s.pos));
      expect(a.seedOffset).toEqual(b.seedOffset);
      const c = buildLayout(PRESETS[v], 4);
      expect(c.seedOffset).not.toEqual(a.seedOffset);
    }
  });

  it('pillars point at the ionizing cluster (photoevaporation shapes them radially)', () => {
    const L = buildLayout(PRESETS.pillars, 0);
    const A = L.densityUniforms.uPillarA.value as Array<{ x: number; y: number; z: number }>;
    const B = L.densityUniforms.uPillarB.value as Array<{ x: number; y: number; z: number }>;
    const n = L.densityUniforms.uPillarCount.value as number;
    for (let i = 0; i < n; i++) {
      const d = [L.source[0] - A[i].x, L.source[1] - A[i].y, L.source[2] - A[i].z];
      const len = Math.hypot(d[0], d[1], d[2]);
      const cos = (d[0] * B[i].x + d[1] * B[i].y + d[2] * B[i].z) / len;
      expect(cos).toBeGreaterThan(0.97);
    }
  });

  it('the Pleiades keep their real on-sky pattern: Alcyone brightest, Electra ≈ 1.4 pc west', () => {
    const L = buildLayout(PRESETS.pleiades, 0);
    const alc = L.stars[0];
    const ele = L.stars[2];
    expect(Math.min(...L.stars.map((s) => s.mv))).toBe(alc.mv);
    expect(ele.pos[0] - alc.pos[0]).toBeCloseTo(1.41, 1);
    expect(L.scatter.length).toBe(7);
  });

  it('the Crab carries a pulsar; planetary nebulae a hot nucleus at the centre', () => {
    expect(buildLayout(PRESETS.crab, 0).stars.some((s) => s.kind === 'pulsar')).toBe(true);
    for (const v of ['ring', 'helix', 'butterfly'] as const) {
      const s = buildLayout(PRESETS[v], 0).stars[0];
      expect(s.pos).toEqual([0, 0, 0]);
      expect(s.teff).toBeGreaterThan(9e4);
    }
  });
});

describe('stellar populations', () => {
  it('Kroupa IMF: median mass of 0.1–60 M☉ draws is ≈ 0.3 M☉ and O stars are rare', () => {
    const rng = new Rng(5);
    const m = Array.from({ length: 20000 }, () => sampleKroupa(rng, 0.1, 60)).sort((a, b) => a - b);
    const median = m[m.length >> 1];
    expect(median).toBeGreaterThan(0.2);
    expect(median).toBeLessThan(0.4);
    const massive = m.filter((x) => x > 15).length / m.length;
    expect(massive).toBeGreaterThan(0.0005);
    expect(massive).toBeLessThan(0.01);
  });

  it('Plummer sphere truncated at 5a: half the stars inside 1.24 a (1.305 a untruncated)', () => {
    const rng = new Rng(9);
    const r = Array.from({ length: 20000 }, () => Math.hypot(...plummerPoint(rng, 1))).sort((a, b) => a - b);
    // M(<r) = r³/(r²+a²)^{3/2}; truncation keeps (25/26)^{3/2} of the mass → median at M = 0.4715.
    const Mh = 0.5 * Math.pow(25 / 26, 1.5);
    expect(r[r.length >> 1]).toBeCloseTo(1 / Math.sqrt(Math.pow(Mh, -2 / 3) - 1), 1);
  });

  it('main sequence: the Sun comes out as a G dwarf of M_V ≈ 4.8', () => {
    expect(msLuminosity(1)).toBeCloseTo(1, 6);
    expect(msTemperature(1)).toBeCloseTo(5772, -1);
    expect(absoluteMagnitude(1, 5772)).toBeCloseTo(4.83, 2);
    expect(msTemperature(20)).toBeGreaterThan(30000);
  });
});
