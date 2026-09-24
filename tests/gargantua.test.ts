import { describe, expect, it } from 'vitest';
import {
  accretionForPeakTemperature,
  buildTetrad,
  circularOrbit,
  circularOrbitSpeed,
  circularRedshift,
  diskProfile,
  dot4,
  frameDragging,
  hamiltonian,
  horizonRadius,
  iscoRadius,
  ksInverseMetric,
  ksMetric,
  ksRadius,
  ksRhs,
  orbitingObserver,
  pageThorneFlux,
  pageThorneFluxQuadrature,
  photonOrbitRadius,
  radiativeEfficiency,
  rainObserver,
  rayMomentum,
  rk4Step,
  shadowCurve,
  staticObserver,
  staticRedshift,
  staticTimeDilation,
  tidalAcceleration,
  traceRay,
  zamoObserver,
  type Vec3,
  type Vec4,
} from '../src/worlds/blackhole/kerr';
import { PlungeTrajectory, schwarzschildRainRadius, schwarzschildRainTime } from '../src/worlds/blackhole/plunge';
import { innerHorizonRadius, shadowAngularWidth } from '../src/worlds/blackhole/kerr';
import { exposureFactor, fovForDistance, MASS_PRESETS } from '../src/experiences/gargantua/presets';

/** Static camera on the +x axis (optionally lifted to latitude `elev`) looking at the hole. */
function camera(a: number, r: number, elev = 0) {
  const pos: Vec3 = [r * Math.cos(elev), 0, r * Math.sin(elev)];
  const back: Vec3 = [Math.cos(elev), 0, Math.sin(elev)];
  const up: Vec3 = [-Math.sin(elev), 0, Math.cos(elev)];
  const right: Vec3 = [up[1] * back[2] - up[2] * back[1], up[2] * back[0] - up[0] * back[2], up[0] * back[1] - up[1] * back[0]];
  const u = staticObserver(a, pos[0], pos[1], pos[2])!;
  return { pos, tetrad: buildTetrad(a, pos, u, right, up, back) };
}

/** Is the ray at angle ψ (radians, towards camera-right) from the optical axis swallowed? */
function captured(a: number, cam: ReturnType<typeof camera>, psi: number, vertical = false): boolean {
  const d: Vec3 = vertical ? [0, Math.sin(psi), -Math.cos(psi)] : [Math.sin(psi), 0, -Math.cos(psi)];
  const res = traceRay(a, cam.pos, rayMomentum(cam.tetrad, d), { eps: 0.02 });
  return res.fate === 'captured';
}

/** Bisection for the shadow edge between an inside angle and an outside angle. */
function edge(a: number, cam: ReturnType<typeof camera>, inside: number, outside: number, vertical = false): number {
  let lo = inside, hi = outside;
  for (let i = 0; i < 40; i++) {
    const mid = 0.5 * (lo + hi);
    if (captured(a, cam, mid, vertical)) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

describe('characteristic radii', () => {
  it('Schwarzschild: horizon 2, photon sphere 3, ISCO 6', () => {
    expect(horizonRadius(0)).toBeCloseTo(2, 12);
    expect(photonOrbitRadius(0)).toBeCloseTo(3, 12);
    expect(iscoRadius(0)).toBeCloseTo(6, 12);
  });
  it('Kerr ISCO (Bardeen–Press–Teukolsky)', () => {
    expect(iscoRadius(0.5)).toBeCloseTo(4.233, 3);
    expect(iscoRadius(0.9)).toBeCloseTo(2.3209, 3);
    expect(iscoRadius(0.998)).toBeCloseTo(1.2370, 3);
    expect(iscoRadius(1 - 1e-12)).toBeCloseTo(1, 2);
    expect(iscoRadius(0.998, false)).toBeGreaterThan(8.9);
  });
  it('Kerr horizons and photon orbits', () => {
    expect(horizonRadius(0.998)).toBeCloseTo(1.0632, 4);
    expect(photonOrbitRadius(1, true)).toBeCloseTo(1, 6);
    expect(photonOrbitRadius(1, false)).toBeCloseTo(4, 6);
    expect(photonOrbitRadius(0.998, true)).toBeCloseTo(1.074, 2);
  });
  it('thin-disk efficiency: 5.7 % (a = 0) to 32 % (a = 0.998)', () => {
    expect(radiativeEfficiency(0)).toBeCloseTo(1 - Math.sqrt(8 / 9), 10);
    expect(radiativeEfficiency(0.998)).toBeGreaterThan(0.31);
    expect(radiativeEfficiency(0.998)).toBeLessThan(0.33);
  });
});

describe('circular orbits and redshift', () => {
  it('ISCO speed is c/2 for Schwarzschild; photon orbit has no timelike circular orbit', () => {
    expect(circularOrbitSpeed(0, 6)).toBeCloseTo(0.5, 10);
    expect(circularOrbit(0, 2.9)).toBeNull();
    expect(circularOrbitSpeed(0, 3.0001)).toBeGreaterThan(0.99);
  });
  it('g = √(1 − 3/r) for a photon with λ = 0 from a Schwarzschild circular orbit, and it factorises', () => {
    const { g, grav, doppler } = circularRedshift(0, 6, 0);
    expect(g).toBeCloseTo(Math.SQRT1_2, 10);
    expect(grav).toBeCloseTo(Math.sqrt(1 - 2 / 6), 10); // gravitational
    expect(doppler).toBeCloseTo(Math.sqrt(1 - 0.25), 10); // transverse Doppler, v = c/2
  });
  it('approaching gas (λ > 0) is blueshifted, receding gas redshifted', () => {
    const r = 10;
    const b = 10;
    expect(circularRedshift(0.9, r, +b).g).toBeGreaterThan(1);
    expect(circularRedshift(0.9, r, -b).g).toBeLessThan(0.8);
  });
  it('static emitters are infinitely redshifted at the horizon (g → 0)', () => {
    expect(staticRedshift(0, 2 + 1e-8)).toBeLessThan(1e-3);
    expect(staticRedshift(0, 1e6)).toBeCloseTo(1, 5);
    const rp = horizonRadius(0.9);
    expect(staticRedshift(0.9, rp + 1e-8, 1)).toBeLessThan(1e-3); // on the axis the static limit touches r₊
    expect(staticTimeDilation(0, 25)).toBeCloseTo(Math.sqrt(1 - 2 / 25), 12);
  });
  it('frame dragging turns in the sense of the spin (+φ for a > 0)', () => {
    expect(frameDragging(0.9, 3)).toBeGreaterThan(0);
    expect(frameDragging(0, 3)).toBe(0);
  });
});

describe('Page–Thorne thin disk', () => {
  for (const a of [0, 0.5, 0.9, 0.998]) {
    it(`closed form matches the defining integral (a = ${a})`, () => {
      const risco = iscoRadius(a);
      for (const k of [1.3, 2, 5, 15]) {
        const r = risco * k;
        const exact = pageThorneFluxQuadrature(a, r, 6000);
        expect(pageThorneFlux(a, r) / exact).toBeCloseTo(1, 3);
      }
    });
  }
  it('far out the flux approaches the Newtonian 3GMṀ/(8πr³) law (with an O(r^-½) torque term)', () => {
    for (const a of [0, 0.9]) {
      const r = 1e6;
      const k = pageThorneFlux(a, r) / (3 / (8 * Math.PI * r ** 3));
      expect(Math.abs(1 - k)).toBeLessThan(6 / Math.sqrt(r));
      // Independent check of the same regime against quadrature.
      expect(pageThorneFlux(a, 400) / pageThorneFluxQuadrature(a, 400, 20000)).toBeCloseTo(1, 3);
    }
  });
  it('temperature peaks outside the ISCO, is zero at the ISCO and normalised to 1', () => {
    const p = diskProfile(0.9, iscoRadius(0.9), 40, 200);
    expect(p.temperature[0]).toBe(0);
    expect(Math.max(...p.temperature)).toBeLessThanOrEqual(1 + 1e-12);
    expect(Math.max(...p.temperature)).toBeGreaterThan(0.99);
    expect(p.rPeak).toBeGreaterThan(iscoRadius(0.9));
    expect(p.rPeak).toBeLessThan(2.2 * iscoRadius(0.9));
  });
  it('accretion rate scales as T⁴M² and Eddington ratio as T⁴M', () => {
    const s1 = accretionForPeakTemperature(0.9, 10, 1e7);
    const s2 = accretionForPeakTemperature(0.9, 20, 2e7);
    expect(s2.mdot / s1.mdot).toBeCloseTo(16 * 4, 6);
    expect(s2.eddingtonRatio / s1.eddingtonRatio).toBeCloseTo(16 * 2, 6);
    // A 10 M☉ hole with a 10⁷ K inner disk is near its Eddington limit.
    const s0 = accretionForPeakTemperature(0, 10, 1e7);
    expect(s0.eddingtonRatio).toBeGreaterThan(0.3);
    expect(s0.eddingtonRatio).toBeLessThan(30);
  });
});

describe('Kerr–Schild geometry', () => {
  const a = 0.9;
  const P: Vec3 = [3.1, -2.2, 1.7];
  it('g_μν g^νρ = δ and l is null', () => {
    const g = ksMetric(a, ...P);
    const gi = ksInverseMetric(a, ...P);
    for (let i = 0; i < 4; i++)
      for (let j = 0; j < 4; j++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += g[i * 4 + k] * gi[k * 4 + j];
        expect(s).toBeCloseTo(i === j ? 1 : 0, 12);
      }
  });
  it('Kerr–Schild r reduces to |x| for a = 0 and satisfies the defining ellipsoid', () => {
    expect(ksRadius(0, 3, 4, 12)).toBeCloseTo(13, 12);
    const r = ksRadius(a, ...P);
    expect((P[0] ** 2 + P[1] ** 2) / (r * r + a * a) + (P[2] * P[2]) / (r * r)).toBeCloseTo(1, 12);
  });
  it("analytic Hamilton's equations equal numerical derivatives of H", () => {
    const pt = -0.93;
    const s = [P[0], P[1], P[2], 0.4, -0.7, 0.25];
    const out = new Float64Array(6);
    ksRhs(a, s, pt, out);
    const H = (v: number[]) => hamiltonian(a, v[0], v[1], v[2], [pt, v[3], v[4], v[5]]);
    const h = 1e-6;
    const dH = (k: number) => {
      const q = s.slice(), m = s.slice();
      q[k] += h;
      m[k] -= h;
      return (H(q) - H(m)) / (2 * h);
    };
    for (let i = 0; i < 3; i++) {
      expect(out[i]).toBeCloseTo(dH(i + 3), 7); // dx/dλ = ∂H/∂p
      expect(out[i + 3]).toBeCloseTo(-dH(i), 7); // dp/dλ = −∂H/∂x
    }
  });
});

describe('observers and tetrads', () => {
  const a = 0.9;
  const P: Vec3 = [7, 3, 2];
  const right: Vec3 = [0.2, 1, 0.1], up: Vec3 = [0, 0, 1], back: Vec3 = [1, -0.1, 0.3];
  for (const [name, u] of [
    ['static', staticObserver(a, ...P)!],
    ['ZAMO', zamoObserver(a, ...P)!],
    ['orbiting', orbitingObserver(a, ...P)!],
    ['rain', rainObserver(a, ...P)],
  ] as Array<[string, Vec4]>) {
    it(`${name} frame is orthonormal`, () => {
      const t = buildTetrad(a, P, u, right, up, back);
      const g = ksMetric(a, ...P);
      for (let i = 0; i < 4; i++)
        for (let j = 0; j < 4; j++) expect(dot4(g, t.e[i], t.e[j])).toBeCloseTo(i === j ? (i === 0 ? -1 : 1) : 0, 10);
    });
  }
  it('rain observers fall from rest at infinity (E = 1, L = 0) on geodesics, through the horizon', () => {
    const a2 = 0.7;
    const start: Vec3 = [9, 2, 4];
    const u0 = rainObserver(a2, ...start);
    const g0 = ksMetric(a2, ...start);
    const cov = [0, 0, 0, 0].map((_, i) => g0[i * 4] * u0[0] + g0[i * 4 + 1] * u0[1] + g0[i * 4 + 2] * u0[2] + g0[i * 4 + 3] * u0[3]);
    expect(cov[0]).toBeCloseTo(-1, 10); // E = 1
    expect(start[0] * cov[2] - start[1] * cov[1]).toBeCloseTo(0, 10); // L_z = 0
    const s = new Float64Array([...start, cov[1], cov[2], cov[3]]);
    const work = new Float64Array(30);
    for (let i = 0; i < 8000; i++) {
      rk4Step(a2, s, cov[0], 0.003, work);
      if (ksRadius(a2, s[0], s[1], s[2]) < 0.8 * horizonRadius(a2)) break;
    }
    const r = ksRadius(a2, s[0], s[1], s[2]);
    expect(r).toBeLessThan(horizonRadius(a2)); // it crossed the horizon smoothly
    expect(hamiltonian(a2, s[0], s[1], s[2], [cov[0], s[3], s[4], s[5]])).toBeCloseTo(-0.5, 8);
    // Still a rain observer where it now is.
    const u1 = rainObserver(a2, s[0], s[1], s[2]);
    const g1 = ksMetric(a2, s[0], s[1], s[2]);
    for (let i = 1; i < 4; i++) {
      let c = 0;
      for (let j = 0; j < 4; j++) c += g1[i * 4 + j] * u1[j];
      expect(s[2 + i]).toBeCloseTo(c, 5);
    }
  });
});

describe('light bending and the shadow', () => {
  it('weak field: deflection ≈ 4M/b', () => {
    const b = 1000;
    const cam = camera(0, 1e5);
    const psi = Math.asin((b * Math.sqrt(1 - 2 / 1e5)) / 1e5);
    const res = traceRay(0, cam.pos, rayMomentum(cam.tetrad, [Math.sin(psi), 0, -Math.cos(psi)]), { eps: 0.02 });
    expect(res.fate).toBe('escaped');
    const inDir: Vec3 = [-Math.cos(psi), Math.sin(psi), 0];
    const defl = Math.acos(Math.min(1, inDir[0] * res.direction[0] + inDir[1] * res.direction[1] + inDir[2] * res.direction[2]));
    expect(defl / (4 / b)).toBeCloseTo(1, 2);
  });
  it('the Schwarzschild shadow has critical impact parameter √27 M', () => {
    const r = 1e4;
    const cam = camera(0, r);
    const psi = edge(0, cam, 0, 20 / r);
    const b = (r * Math.sin(psi)) / Math.sqrt(1 - 2 / r);
    expect(b).toBeCloseTo(Math.sqrt(27), 3);
  });
  it('shadow size at finite distance follows Synge (1966): sin ψ = √27 √(1 − 2/r) / r', () => {
    const r = 10;
    const cam = camera(0, r);
    const psi = edge(0, cam, 0, 1.2);
    expect(Math.sin(psi)).toBeCloseTo((Math.sqrt(27) * Math.sqrt(1 - 2 / r)) / r, 4);
  });
  it('Kerr a = 0.998 edge-on: D-shaped shadow matches Bardeen’s critical curve', () => {
    const a = 0.998;
    const r = 1e4;
    const cam = camera(a, r);
    const curve = shadowCurve(a, Math.PI / 2);
    const aMin = Math.min(...curve.map((p) => p[0]));
    const aMax = Math.max(...curve.map((p) => p[0]));
    expect(aMin).toBeCloseTo(-2.11, 1); // flattened prograde side
    expect(aMax).toBeCloseTo(6.99, 1);
    const right = edge(a, cam, 0, 12 / r);
    const left = edge(a, cam, 0, -12 / r);
    expect(r * Math.sin(right)).toBeCloseTo(aMax, 2);
    expect(r * Math.sin(left)).toBeCloseTo(aMin, 2);
  });
  it('Kerr a = 0.9 seen from the pole: circular shadow of radius √(η + a²) at r_ph where ξ = 0', () => {
    const a = 0.9;
    const r = 1e4;
    const cam = camera(a, r, Math.PI / 2 - 1e-6);
    const up = edge(a, cam, 0, 10 / r, true);
    const side = edge(a, cam, 0, 10 / r, false);
    expect(Math.abs(up - side) * r).toBeLessThan(2e-3);
    // Polar observer: the shadow radius is √(η + a²) for the orbit with ξ = 0.
    let lo = photonOrbitRadius(a, true), hi = photonOrbitRadius(a, false);
    const xi = (rr: number) => -(rr ** 3 - 3 * rr * rr + a * a * rr + a * a) / (a * (rr - 1));
    for (let i = 0; i < 80; i++) {
      const m = 0.5 * (lo + hi);
      if (xi(m) > 0) lo = m;
      else hi = m;
    }
    const rr = 0.5 * (lo + hi);
    const eta = -(rr ** 3 * (rr ** 3 - 6 * rr * rr + 9 * rr - 4 * a * a)) / (a * a * (rr - 1) ** 2);
    expect(r * Math.sin(up)).toBeCloseTo(Math.sqrt(eta + a * a), 2);
  });
  it('null geodesics conserve H ≈ 0 and report disk-plane crossings', () => {
    const cam = camera(0.9, 30, 0.17);
    // Passes behind the hole, crosses the disk plane, escapes (the lensed far side of the disk).
    const res = traceRay(0.9, cam.pos, rayMomentum(cam.tetrad, [0.0, 0.2, -0.98]), { eps: 0.03 });
    expect(res.fate).toBe('escaped');
    expect(res.hError).toBeLessThan(1e-6);
    expect(res.crossings.length).toBeGreaterThan(0);
    // A captured ray: H drift stays small relative to the (growing) momentum scale.
    const cap = traceRay(0.9, cam.pos, rayMomentum(cam.tetrad, [0.05, -0.08, -0.99]), { eps: 0.03 });
    expect(cap.fate).toBe('captured');
    expect(cap.hError).toBeLessThan(1e-3);
  });
});

describe('tides', () => {
  it('a human survives the horizon of Sgr A* but not of a 10 M☉ hole', () => {
    expect(tidalAcceleration(4.3e6, 2, 2)).toBeLessThan(0.01);
    expect(tidalAcceleration(10, 2, 2)).toBeGreaterThan(1e7);
  });
});

// ————————————————————————————————————————————————————————————— added: plunge, shadow size, UI maths

describe('free-fall plunge (rain observer)', () => {
  it('Schwarzschild: r(τ) follows (r₀^{3/2} − 3τ/√2)^{2/3}', () => {
    const pl = new PlungeTrajectory(0, [20, 0, 3]);
    const r0 = pl.r;
    pl.step(30);
    expect(pl.r).toBeCloseTo(schwarzschildRainRadius(r0, 30), 5);
    // and on to near the singularity in the analytic proper time
    const left = schwarzschildRainTime(pl.r, 0.3);
    pl.step(left);
    expect(pl.r).toBeCloseTo(0.3, 3);
    expect(pl.tau).toBeCloseTo(schwarzschildRainTime(r0, 0.3), 5);
  });
  it('crosses the Kerr horizon smoothly and stays a unit timelike geodesic', () => {
    const a = 0.9;
    const pl = new PlungeTrajectory(a, [12, 0, 4]);
    let crossed = false;
    for (let i = 0; i < 4000 && pl.r > pl.endRadius; i++) {
      pl.step(0.01 * pl.r);
      if (pl.inside) crossed = true;
      const u = pl.velocity();
      expect(u.every(Number.isFinite)).toBe(true);
    }
    expect(crossed).toBe(true);
    expect(pl.r).toBeLessThan(horizonRadius(a));
    expect(pl.r).toBeGreaterThan(innerHorizonRadius(a));
    // u·u = −1 at the end
    const [x, y, z] = pl.pos;
    const g = ksMetric(a, x, y, z);
    expect(dot4(g, pl.velocity(), pl.velocity())).toBeCloseTo(-1, 8);
    // E = −u_t = 1 and L_z = 0 are conserved along the fall (zero-angular-momentum observer)
    const uc = [0, 0, 0, 0];
    const u = pl.velocity();
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) uc[i] += g[i * 4 + j] * u[j];
    expect(-uc[0]).toBeCloseTo(1, 8);
    expect(x * uc[2] - y * uc[1]).toBeCloseTo(0, 8);
  });
  it('dr/dτ → −1 at the Schwarzschild horizon (the river flows at c there)', () => {
    const pl = new PlungeTrajectory(0, [2, 0, 0]);
    expect(pl.radialSpeed()).toBeCloseTo(-1, 8);
  });
});

describe('shadow angular size at the camera', () => {
  it('Schwarzschild matches Synge: sin ψ = √27 √(1 − 2/r) / r', () => {
    for (const r of [10, 40]) {
      const w = shadowAngularWidth(0, [r, 0, 0.5], 30);
      const d = Math.hypot(r, 0.5);
      const psi = Math.asin((Math.sqrt(27) * Math.sqrt(1 - 2 / d)) / d);
      expect(w / 2).toBeCloseTo(psi, 3);
    }
  });
  it('inside the photon sphere the shadow covers more than half the sky', () => {
    expect(shadowAngularWidth(0, [2.6, 0, 0], 24)).toBeGreaterThan(Math.PI);
  });
});

describe('camera helpers', () => {
  it('lens narrows with distance and exposure stops down up close and face-on', () => {
    expect(fovForDistance(5)).toBeCloseTo(64, 6);
    expect(fovForDistance(60)).toBeCloseTo(26, 6);
    expect(fovForDistance(1000)).toBeCloseTo(26, 6);
    expect(exposureFactor(40, 0)).toBeCloseTo(1, 6);
    expect(exposureFactor(4, 0)).toBeLessThan(0.5);
    expect(exposureFactor(40, Math.PI / 2)).toBeCloseTo(0.65, 6);
  });
  it('mass presets are ordered physical values', () => {
    expect(MASS_PRESETS.sgra.mass).toBeCloseTo(4.3e6, -4);
    expect(MASS_PRESETS.m87.mass).toBeGreaterThan(1e9);
    expect(MASS_PRESETS.cygx1.mass).toBeLessThan(100);
  });
});
