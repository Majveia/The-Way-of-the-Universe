import { describe, expect, it } from 'vitest';
import { Rng } from '../src/physics/random';
import {
  generateSystem, findSeed, massForTeff, sampleKroupa, kroupaIntegral, kroupaXi, habitableZone, hzStatus,
  msLuminosity, msRadius, effectiveTemperature, holmanWiegertS, holmanWiegertP, massRadius, CK_TERRAN_MAX,
  CK_NEPTUNIAN_MAX, equilibriumTemperature, tidalLockTimeYears, keepsAtmosphere, nextHillSpacedOrbit, hillSeparation,
  hillRadius, spectralClass, snowLineAU, periodDays, semiMajorAxisAU, eyeballOpening, M_JUP_EARTH, R_JUP_EARTH,
  catalogueName, givenName, GM_SUN_AU_DAY, HOT_JUPITER_CLEAR_P, insolation, type SystemData,
} from '../src/worlds/systems';
import { cornerCos, planSlices, ringDistance, shellDistance, MAX_SLICE_RATIO, type SliceItem } from '../src/worlds/systems/slices';
import { glareStrength } from '../src/worlds/systems/glare';
import { poleAzimuth, spinAxis } from '../src/worlds/systems/SystemLayer';
import * as THREE from 'three';

const systems = (n: number, start = 1): SystemData[] => Array.from({ length: n }, (_, i) => generateSystem(start + i));

describe('Kroupa IMF', () => {
  it('is continuous at the break masses', () => {
    for (const m of [0.08, 0.5]) expect(kroupaXi(m * (1 - 1e-9)) / kroupaXi(m * (1 + 1e-9))).toBeCloseTo(1, 5);
  });

  it('samples match the analytic distribution', () => {
    const rng = new Rng(42);
    const N = 40000;
    let low = 0, mid = 0;
    for (let i = 0; i < N; i++) {
      const m = sampleKroupa(rng.next(), 0.08, 8);
      expect(m).toBeGreaterThanOrEqual(0.08);
      expect(m).toBeLessThanOrEqual(8);
      if (m < 0.5) low++;
      else if (m < 1) mid++;
    }
    const tot = kroupaIntegral(0.08, 8);
    expect(low / N).toBeCloseTo(kroupaIntegral(0.08, 0.5) / tot, 2);
    expect(mid / N).toBeCloseTo(kroupaIntegral(0.5, 1) / tot, 2);
    // Most stars are M dwarfs (≈ 3/4), as in the solar neighbourhood.
    expect(kroupaIntegral(0.08, 0.6) / tot).toBeGreaterThan(0.7);
  });

  it('makes most generated systems orbit M dwarfs', () => {
    const s = systems(1500);
    const mDwarfs = s.filter((x) => x.star.stage === 'main-sequence' && x.star.teff < 3900).length / s.length;
    expect(mDwarfs).toBeGreaterThan(0.6);
    expect(mDwarfs).toBeLessThan(0.85);
    // Giants and white dwarfs are rare.
    const evolved = s.filter((x) => x.star.stage !== 'main-sequence').length / s.length;
    expect(evolved).toBeGreaterThan(0.02);
    expect(evolved).toBeLessThan(0.1);
  });
});

describe('Main sequence', () => {
  it('reproduces the Sun', () => {
    expect(msLuminosity(1)).toBeGreaterThan(0.95);
    expect(msLuminosity(1)).toBeLessThan(1.05);
    expect(msRadius(1)).toBeCloseTo(1, 5);
    expect(Math.abs(effectiveTemperature(msLuminosity(1), msRadius(1)) - 5772)).toBeLessThan(60);
    expect(massForTeff(5772)).toBeCloseTo(1, 1);
    expect(spectralClass(5772)).toBe('G2');
  });
  it('gives plausible M dwarfs (Proxima, TRAPPIST-1)', () => {
    // Proxima Cen: 0.122 M☉, 0.154 R☉, 0.0017 L☉, 3040 K
    expect(msRadius(0.122)).toBeGreaterThan(0.13);
    expect(msRadius(0.122)).toBeLessThan(0.18);
    const T = effectiveTemperature(msLuminosity(0.122), msRadius(0.122));
    expect(T).toBeGreaterThan(2700);
    expect(T).toBeLessThan(3300);
    expect(spectralClass(2566)).toMatch(/^M8/);
  });
  it('is monotonic in mass', () => {
    let L = 0, R = 0;
    for (let m = 0.08; m < 8; m *= 1.05) {
      expect(msLuminosity(m)).toBeGreaterThan(L);
      expect(msRadius(m)).toBeGreaterThan(R);
      L = msLuminosity(m);
      R = msRadius(m);
    }
  });
});

describe('Habitable zone (Kopparapu et al. 2014)', () => {
  it('matches the conservative limits for the Sun (~0.95–1.67 AU)', () => {
    const hz = habitableZone(1, 5780);
    expect(hz.runaway).toBeGreaterThan(0.93);
    expect(hz.runaway).toBeLessThan(0.97);
    expect(hz.maxGreenhouse).toBeGreaterThan(1.65);
    expect(hz.maxGreenhouse).toBeLessThan(1.7);
    expect(hz.recentVenus).toBeCloseTo(0.75, 2);
    expect(hz.earlyMars).toBeCloseTo(1.77, 2);
    expect(hzStatus(1, 5780)).toBe('habitable zone');
    expect(hzStatus(1.9, 5780)).toBe('too hot');
  });
  it('moves inward and shifts to lower fluxes for cool stars', () => {
    const hzM = habitableZone(0.0005, 2560);
    expect(hzM.runaway).toBeLessThan(0.03);
    expect(hzM.maxGreenhouse).toBeGreaterThan(0.04);
    // Red-dwarf light is absorbed more efficiently: the inner edge needs less flux.
    expect(0.0005 / hzM.runaway ** 2).toBeLessThan(1.107);
  });
  it('places the snow line at 2.7 AU for the Sun', () => {
    expect(snowLineAU(1)).toBeCloseTo(2.7, 5);
  });
});

describe('Planets', () => {
  it('Chen & Kipping mass–radius is continuous and sane', () => {
    expect(massRadius(1)).toBeCloseTo(1, 6);
    for (const m of [CK_TERRAN_MAX, CK_NEPTUNIAN_MAX]) expect(massRadius(m * 0.9999) / massRadius(m * 1.0001)).toBeCloseTo(1, 3);
    // Neptune 17.1 M⊕ → 3.9 R⊕ within the forecaster's scatter.
    expect(massRadius(17.1)).toBeGreaterThan(3.3);
    expect(massRadius(17.1)).toBeLessThan(4.6);
    const rJ = massRadius(M_JUP_EARTH, true) / R_JUP_EARTH;
    expect(rJ).toBeGreaterThan(0.9);
    expect(rJ).toBeLessThan(1.2);
  });
  it('gives the Earth T_eq ≈ 255 K', () => {
    expect(equilibriumTemperature(5772, 1, 1, 0.3)).toBeGreaterThan(252);
    expect(equilibriumTemperature(5772, 1, 1, 0.3)).toBeLessThan(257);
  });
  it('locks close-in planets and not the Earth', () => {
    expect(tidalLockTimeYears(1, 1, 1, 1, false)).toBeGreaterThan(1e10);
    expect(tidalLockTimeYears(1, 1, 0.03, 0.1, false)).toBeLessThan(1e6);
    // Hot Jupiters lock quickly even with Q ~ 1e5.
    expect(tidalLockTimeYears(318, 11, 0.05, 1, true)).toBeLessThan(1e9);
  });
  it('follows the cosmic shoreline for the Solar System', () => {
    expect(keepsAtmosphere(1, 1, 1)).toBe(true); // Earth
    expect(keepsAtmosphere(0.815, 0.95, 1.91)).toBe(true); // Venus
    expect(keepsAtmosphere(0.107, 0.532, 0.43)).toBe(true); // Mars (thin)
    expect(keepsAtmosphere(0.0553, 0.383, 6.67)).toBe(false); // Mercury
    expect(keepsAtmosphere(0.0123, 0.273, 1)).toBe(false); // Moon
  });
  it('spaces planets by mutual Hill radii exactly', () => {
    for (const delta of [10, 17, 25]) {
      const a2 = nextHillSpacedOrbit(0.1, 3, 5, delta, 0.5);
      expect(hillSeparation(0.1, 3, a2, 5, 0.5)).toBeCloseTo(delta, 6);
    }
  });
  it('opens an eyeball pupil that widens with temperature', () => {
    expect(eyeballOpening(260)).toBeGreaterThan(eyeballOpening(200));
    expect(eyeballOpening(150)).toBeCloseTo(Math.acos(0.94), 5);
  });
});

describe('Binary stability (Holman & Wiegert 1999)', () => {
  it('matches the published fits for equal masses on circular orbits', () => {
    expect(holmanWiegertS(0.5, 0)).toBeCloseTo(0.274, 3);
    expect(holmanWiegertP(0.5, 0)).toBeCloseTo(2.39, 2);
  });
  it('keeps every generated planet in its stable region', () => {
    let S = 0, P = 0;
    for (const s of systems(3000)) {
      const c = s.companion;
      if (!c) continue;
      for (const p of s.planets) {
        const apo = p.orbit.a * (1 + p.orbit.e), peri = p.orbit.a * (1 - p.orbit.e);
        if (c.config === 'S') expect(apo).toBeLessThan(c.critical);
        else expect(peri).toBeGreaterThan(c.critical);
      }
      if (c.config === 'S') S++;
      else P++;
    }
    expect(S).toBeGreaterThan(50);
    expect(P).toBeGreaterThan(10);
  });
  it('has more companions for Sun-like stars than for M dwarfs', () => {
    const s = systems(4000, 5000);
    const frac = (f: (x: SystemData) => boolean) => {
      const g = s.filter(f);
      return g.filter((x) => x.companion).length / g.length;
    };
    expect(frac((x) => x.star.teff > 5000 && x.star.stage === 'main-sequence')).toBeGreaterThan(frac((x) => x.star.teff < 3900 && x.star.stage === 'main-sequence'));
  });
});

describe('Generated systems', () => {
  it('are deterministic from the seed', () => {
    for (const seed of [1, 42, 60372, 123456789]) {
      const a = generateSystem(seed), b = generateSystem(seed);
      expect(JSON.stringify({ ...a, tags: [...a.tags] })).toBe(JSON.stringify({ ...b, tags: [...b.tags] }));
    }
    expect(catalogueName(60372)).toBe(catalogueName(60372));
    expect(givenName(new Rng(3))).toBe(givenName(new Rng(3)));
  });

  it('are dynamically stable: ordered, non-crossing, well spaced', () => {
    for (const s of systems(1500)) {
      expect(s.planets.length).toBeGreaterThan(0);
      const M = s.companion?.config === 'P' ? s.star.mass + s.companion.star.mass : s.star.mass;
      for (let i = 0; i < s.planets.length - 1; i++) {
        const A = s.planets[i], B = s.planets[i + 1];
        expect(B.orbit.a).toBeGreaterThan(A.orbit.a);
        // No orbit crossing, with at least ~3 Hill radii of clearance at closest approach.
        const gap = B.orbit.a * (1 - B.orbit.e) - A.orbit.a * (1 + A.orbit.e);
        const rh = hillRadius(A.orbit.a, 0, A.mass, M) + hillRadius(B.orbit.a, 0, B.mass, M);
        expect(gap).toBeGreaterThan((B.resonance ? 2 : 2.9) * rh);
        // Hill spacing ≥ ~8 R_H except resonant chains (protected by resonance, like TRAPPIST-1).
        if (!B.resonance) expect(hillSeparation(A.orbit.a, A.mass, B.orbit.a, B.mass, M)).toBeGreaterThan(7.5);
      }
    }
  });

  it('respect Kepler’s third law', () => {
    const s = generateSystem(60372);
    for (const p of s.planets) expect(p.periodDays).toBeCloseTo(periodDays(p.orbit.a, s.star.mass), 6);
    expect(semiMajorAxisAU(365.25, 1)).toBeCloseTo(1, 10);
  });

  it('produce physically consistent planets', () => {
    for (const s of systems(800)) {
      for (const p of s.planets) {
        expect(p.radius).toBeGreaterThan(0.1);
        expect(p.radius).toBeLessThan(25);
        expect(p.teq).toBeGreaterThan(5);
        expect(Number.isFinite(p.teq)).toBe(true);
        if (p.kind === 'lava') expect(p.teq).toBeGreaterThan(500);
        if (p.kind === 'terrestrial' || p.kind === 'ocean') expect(p.atmosphere).toBe(true);
        if (p.eyeball) expect(p.spinOrbit).toBe('1:1');
        if (p.spec.rings) expect(p.orbit.a).toBeGreaterThan(0.3);
        for (const m of p.moons) expect(m.a).toBeGreaterThan(2);
      }
    }
  });

  it('can find every advertised feature', () => {
    for (const f of ['habitable', 'binary-sunset', 'hot-jupiter', 'ringed-giant', 'resonant-chain', 'eyeball', 'giant-star', 'white-dwarf'] as const) {
      const seed = findSeed(f, 7);
      expect(generateSystem(seed).tags.has(f)).toBe(true);
    }
  });
});

describe('Surface classes', () => {
  it('keeps rust deserts to worlds warmer than ~100 K', () => {
    for (let seed = 0; seed < 300; seed++) {
      for (const p of generateSystem(seed * 104729 + 17).planets) if (p.kind === 'desert') expect(p.teq).toBeGreaterThan(100);
    }
  });
});

describe('Review: orbital mechanics and occurrence', () => {
  it('uses the enclosed mass for every orbit (circumbinary planets orbit both stars)', () => {
    let P = 0;
    for (const s of systems(2500)) {
      const M = s.star.mass + (s.companion?.config === 'P' ? s.companion.star.mass : 0);
      if (s.companion?.config === 'P') P++;
      for (const p of s.planets) {
        expect(p.periodDays / periodDays(p.orbit.a, M)).toBeCloseTo(1, 9);
        expect(p.mu / (GM_SUN_AU_DAY * M)).toBeCloseTo(1, 9);
        // The animation clock (Gaussian k, sidereal year) and the quoted period agree to < 10⁻⁴.
        const Panim = (2 * Math.PI) / Math.sqrt(p.mu / p.orbit.a ** 3);
        expect(Math.abs(Panim / p.periodDays - 1)).toBeLessThan(1e-4);
      }
    }
    expect(P).toBeGreaterThan(5);
  });

  it('keeps hot Jupiters lonely (Steffen et al. 2012): no neighbour within a factor ~5 in period', () => {
    let hj = 0;
    for (let seed = 1; seed < 12000; seed++) {
      const s = generateSystem(seed);
      for (const p of s.planets) {
        if (p.class !== 'gas-giant' || p.periodDays >= 10) continue;
        hj++;
        for (const q of s.planets) {
          if (q === p) continue;
          const r = q.periodDays / p.periodDays;
          expect(r > HOT_JUPITER_CLEAR_P * 0.97 || r < 1 / (HOT_JUPITER_CLEAR_P * 0.97)).toBe(true);
        }
      }
    }
    expect(hj).toBeGreaterThan(20);
  });

  it('gives insolation and T_eq consistent with the Stefan–Boltzmann definition', () => {
    for (const s of systems(300)) {
      for (const p of s.planets) {
        expect(p.insolation).toBeCloseTo(insolation(s.hzLuminosity, p.orbit.a), 9);
        // T_eq = 278.3 K · S^¼ (1 − A)^¼ (Earth: S = 1, A = 0.3 → 255 K).
        expect(p.teq / (278.3 * Math.pow(p.insolation, 0.25) * Math.pow(1 - p.albedo, 0.25))).toBeCloseTo(1, 6);
      }
    }
  });

  it('keeps the default seed (60372) the showcase it was designed as', () => {
    const s = generateSystem(60372);
    expect(s.star.spectralType).toBe('G6.5 V');
    expect(s.planets.map((p) => p.kind)).toEqual(['gas-giant', 'ocean', 'ice', 'gas-giant', 'ice-giant', 'gas-giant']);
  });
});

describe('Review: close-up depth slices', () => {
  const item = (near: number, far: number, dist: number, solo = false): SliceItem => ({ near, far, dist, solo, slice: -1 });

  it('merges the planet and its moons into one slice but keeps stars apart', () => {
    const ranges: number[] = [];
    // Star far away, a moon at ~40 radii, the planet at 3 radii (sorted far → near).
    const items = [item(2.3e4, 2.4e4, 2.35e4, true), item(38, 42, 40), item(1.8, 4.2, 3)];
    expect(planSlices(items, ranges)).toBe(2);
    expect(items.map((i) => i.slice)).toEqual([0, 1, 1]);
    expect(ranges).toEqual([2.3e4, 2.4e4, 1.8, 42]);
  });

  it('splits bodies whose merged depth range would exceed one buffer', () => {
    const ranges: number[] = [];
    const items = [item(300, 310, 305), item(1e-3, 2, 1)];
    expect(300 / 1e-3).toBeGreaterThan(MAX_SLICE_RATIO);
    expect(planSlices(items, ranges)).toBe(2);
  });

  it('never merges two solo items (each star glare needs its own slice)', () => {
    const ranges: number[] = [];
    const items = [item(100, 110, 105, true), item(90, 99, 95, true)];
    expect(planSlices(items, ranges)).toBe(2);
  });

  it('measures distances to shells and to a ring annulus', () => {
    expect(shellDistance(1.04, 0.999, 1.0015)).toBeCloseTo(0.0385, 9);
    expect(shellDistance(1.0, 0.999, 1.0015)).toBe(0);
    expect(shellDistance(0.5, 0.999, 1.0015)).toBeCloseTo(0.499, 9);
    expect(ringDistance(0, 0.5, 0, 1.25, 2.5)).toBeCloseTo(Math.hypot(1.25, 0.5), 9);
    expect(ringDistance(2, 0.1, 0, 1.25, 2.5)).toBeCloseTo(0.1, 9);
    expect(ringDistance(0, 0, 3, 1.25, 2.5)).toBeCloseTo(0.5, 9);
  });

  it('bounds view depth by the frustum corner cosine (incl. a view offset)', () => {
    // Symmetric 60° vertical fov, 16:9.
    const t = Math.tan(Math.PI / 6);
    const P = [1 / (t * 16 / 9), 0, 0, 0, 0, 1 / t, 0, 0, 0, 0, -1, -1, 0, 0, 0, 0];
    const c = cornerCos(P);
    expect(c).toBeCloseTo(1 / Math.sqrt(1 + (t * 16 / 9) ** 2 + t * t), 9);
    // Shift the window sideways: the far corner is more oblique.
    const Q = P.slice();
    Q[8] = 0.26;
    expect(cornerCos(Q)).toBeLessThan(c);
  });
});

describe('Review: glare', () => {
  it('is full for unresolved stars and gone once the disk is several degrees wide', () => {
    expect(glareStrength(0.05)).toBe(1);
    expect(glareStrength(2.4)).toBe(0);
    expect(glareStrength(1)).toBeGreaterThan(glareStrength(1.5));
  });
});

describe('Review: spin axes', () => {
  it('tilts each pole by its obliquity, toward azimuths spread around the orbit normal', () => {
    const v = new THREE.Vector3();
    const az: number[] = [];
    for (const s of systems(60)) {
      for (const p of s.planets) {
        spinAxis(p, v);
        expect(v.length()).toBeCloseTo(1, 9);
        expect(Math.acos(v.y)).toBeCloseTo(p.axialTilt, 6);
        az.push(poleAzimuth(p));
      }
    }
    // Not all leaning the same way: the azimuths fill the circle.
    const q = [0, 0, 0, 0];
    for (const a of az) q[Math.floor((a / (2 * Math.PI)) * 4) % 4]++;
    for (const c of q) expect(c).toBeGreaterThan(az.length / 8);
  });
});
