import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Frame, UNIT, commonAncestor, convertPoint, convertDirection, distanceMetres, makeNav, rebase, settleFrame } from '../src/worlds/explorer/frames';
import { Trip, autoSpeed, niceScaleBar, smoother, smootherDeriv, tripDistances, tripLogLength, tripSwitch, SPEED_OF_LIGHT } from '../src/worlds/explorer/navigation';
import { M31, SGRA, VIRGO, boxToGalactic, chooseHome, diskOrientation, equatorialDir, galacticDir, wrapNear } from '../src/worlds/explorer/universe';
import { classifyHost, procHostHint } from '../src/worlds/explorer/hosts';
import { generateSystem } from '../src/worlds/systems/generate';
import { decodeStarCatalog } from '../src/worlds/sky/catalog';
import { STAR_DATA_B64, STAR_NAMES } from '../src/worlds/sky/data/stars';
import { plumeConeInterval } from '../src/worlds/ship/Plume';
import { milkyWay } from '../src/worlds/galaxy/params';

/** A universe → galaxy → local → system → planet chain like the explorer's. */
function chain() {
  const universe = new Frame({ id: 'u', kind: 'universe', label: 'Universe', metres: UNIT.MPC });
  const galaxy = new Frame({ id: 'g', kind: 'galaxy', label: 'Galaxy', parent: universe, unit: 1e-6, origin: new THREE.Vector3(12.3456789, -3.21, 0.5), entry: 150_000, exit: 200_000 });
  const sun = new THREE.Vector3(-8178, 20.8, 0);
  const local = new Frame({ id: 'l', kind: 'local', label: 'Local', parent: galaxy, unit: 1, origin: sun, entry: 300, exit: 400 });
  const ecl = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0.3, 0.8, -0.2).normalize(), 1.1);
  const system = new Frame({ id: 's', kind: 'system', label: 'Sol', parent: local, unit: UNIT.AU / UNIT.PC, rotation: ecl, entry: 250, exit: 350 });
  const planet = new Frame({ id: 'p', kind: 'planet', label: 'Earth', parent: system, unit: UNIT.KM / UNIT.AU, origin: new THREE.Vector3(0.98, 0.01, -0.2), entry: 8e5, exit: 1e6 });
  return { universe, galaxy, local, system, planet };
}

describe('frame stack', () => {
  it('derives metres per unit through the chain', () => {
    const { galaxy, local, system, planet } = chain();
    expect(galaxy.metres / UNIT.PC).toBeCloseTo(1, 12);
    expect(local.metres / UNIT.PC).toBeCloseTo(1, 12);
    expect(system.metres / UNIT.AU).toBeCloseTo(1, 12);
    expect(planet.metres / UNIT.KM).toBeCloseTo(1, 10);
  });

  it('round-trips points between the deepest and the root frame in float64', () => {
    const { universe, planet, system } = chain();
    const p = new THREE.Vector3(6771.2345678, -12.25, 3.5); // 400 km above Earth (km)
    const u = convertPoint(p, planet, universe, new THREE.Vector3());
    const back = convertPoint(u, universe, planet, new THREE.Vector3());
    // Through Mpc and back: the absolute error is bounded by the root's float64 resolution
    // (≈ 1.1e-16 × 12 Mpc ≈ 4 × 10⁴ km) — which is exactly why state lives in the deepest frame.
    expect(back.distanceTo(p)).toBeLessThan(1e5);
    // Between neighbouring frames the round trip is essentially exact.
    const s = convertPoint(p, planet, system, new THREE.Vector3());
    const b2 = convertPoint(s, system, planet, new THREE.Vector3());
    expect(b2.distanceTo(p)).toBeLessThan(1e-6);
  });

  it('keeps metre precision for sibling conversions below the common ancestor', () => {
    const { system, planet } = chain();
    const moonFrame = new Frame({ id: 'm', kind: 'planet', label: 'Moon', parent: system, unit: UNIT.KM / UNIT.AU, origin: new THREE.Vector3(0.98 + 384400 / 1.495978707e8, 0.01, -0.2), entry: 5e4 });
    const p = new THREE.Vector3(1737.4 + 0.001, 0, 0); // 1 m above the Moon
    const q = convertPoint(p, moonFrame, planet, new THREE.Vector3());
    expect(q.x).toBeCloseTo(384400 + 1737.401, 3);
  });

  it('rotations compose and directions convert consistently with points', () => {
    const { universe, system } = chain();
    const a = new THREE.Vector3(1, 2, 3);
    const b = new THREE.Vector3(1.5, 2, 3);
    const da = convertPoint(a, system, universe, new THREE.Vector3());
    const db = convertPoint(b, system, universe, new THREE.Vector3());
    const dir = convertDirection(new THREE.Vector3(1, 0, 0), system, universe, new THREE.Vector3());
    const d = db.sub(da).normalize();
    expect(d.dot(dir)).toBeCloseTo(1, 6);
  });

  it('finds the lowest common ancestor', () => {
    const { universe, galaxy, local, system, planet } = chain();
    expect(commonAncestor(planet, local)).toBe(local);
    expect(commonAncestor(system, galaxy)).toBe(galaxy);
    const other = new Frame({ id: 'g2', kind: 'galaxy', label: 'M31', parent: universe, unit: 1e-6 });
    expect(commonAncestor(planet, other)).toBe(universe);
  });

  it('distanceMetres agrees across frames', () => {
    const { local, planet } = chain();
    // Earth frame origin in local = system origin + R·(0.98, 0.01, −0.2) AU ≈ 1 AU from the Sun.
    const d = distanceMetres(new THREE.Vector3(0, 0, 0), planet, new THREE.Vector3(0, 0, 0), local);
    const expected = Math.hypot(0.98, 0.01, -0.2) * UNIT.AU;
    expect(Math.abs(d - expected) / expected).toBeLessThan(1e-9);
  });
});

describe('entry / exit hysteresis', () => {
  it('enters inside the entry radius, leaves only beyond the exit radius', () => {
    const { universe, galaxy, local } = chain();
    const nav = makeNav(universe);
    const kids = (f: Frame) => (f === universe ? [galaxy] : f === galaxy ? [local] : []);
    // 170 kpc from the galaxy centre: outside entry (150 kpc) → stays in the universe frame.
    nav.position.copy(galaxy.origin).add(new THREE.Vector3(0.17, 0, 0));
    settleFrame(nav, kids);
    expect(nav.frame).toBe(universe);
    // Move to 140 kpc: enters.
    nav.position.copy(galaxy.origin).add(new THREE.Vector3(0.14, 0, 0));
    settleFrame(nav, kids);
    expect(nav.frame).toBe(galaxy);
    // Back out to 170 kpc (between entry and exit): stays inside the galaxy frame.
    nav.position.set(170_000, 0, 0);
    settleFrame(nav, kids);
    expect(nav.frame).toBe(galaxy);
    // Beyond 200 kpc: leaves.
    nav.position.set(210_000, 0, 0);
    settleFrame(nav, kids);
    expect(nav.frame).toBe(universe);
  });

  it('descends several levels at once and climbs back', () => {
    const { universe, galaxy, local, system, planet } = chain();
    const kids = (f: Frame) => (f === universe ? [galaxy] : f === galaxy ? [local] : f === local ? [system] : f === system ? [planet] : []);
    const nav = makeNav(universe);
    // A point 7000 km from Earth's centre, expressed in the universe frame.
    convertPoint(new THREE.Vector3(7000, 0, 0), planet, universe, nav.position);
    settleFrame(nav, kids);
    expect(nav.frame).toBe(planet);
    // (the start point came through the Mpc frame: tens of thousands of km of rounding, see above)
    expect(Math.abs(nav.position.length() - 7000)).toBeLessThan(1e5);
    // Jump to 2 000 AU from the Sun (outside the system's exit): climbs to the local frame.
    rebase(nav, system);
    nav.position.set(2000, 0, 0);
    settleFrame(nav, kids);
    expect(nav.frame).toBe(local);
  });
});

describe('speed scaling', () => {
  it('scales with the distance to the nearest body', () => {
    const near = autoSpeed(7e6, 1); // 7000 km from a planet centre
    const far = autoSpeed(3e22, 1); // 1 Mpc from a galaxy
    expect(near / 7e6).toBeCloseTo(far / 3e22, 6);
    expect(near).toBeLessThan(SPEED_OF_LIGHT);
    expect(far).toBeGreaterThan(1e6 * SPEED_OF_LIGHT);
  });
  it('is zero at zero throttle and monotonic', () => {
    expect(autoSpeed(1e9, 0)).toBe(0);
    expect(autoSpeed(1e9, 0.5)).toBeLessThan(autoSpeed(1e9, 0.8));
  });
});

describe('log-distance autopilot', () => {
  it('leaves the start and arrives at the end continuously', () => {
    const D = 1e20, L0 = 1e7, L1 = 1e18;
    const Lt = tripLogLength(D, L0, L1);
    const a = tripDistances(0, D, L0, L1);
    expect(a.fromStart).toBe(0);
    const b = tripDistances(Lt, D, L0, L1);
    expect(b.toEnd).toBeLessThan(1e-3);
    // Continuity (and continuous velocity dr/dΛ) at the departure/arrival switch.
    const lmax = Math.log1p(D / (2 * L0));
    const e = 1e-7;
    const before = tripDistances(lmax - e, D, L0, L1);
    const after = tripDistances(lmax + e, D, L0, L1);
    expect(Math.abs(before.fromStart - after.fromStart) / D).toBeLessThan(1e-6);
    const vBefore = (tripDistances(lmax, D, L0, L1).fromStart - tripDistances(lmax - 1e-4, D, L0, L1).fromStart) / 1e-4;
    const vAfter = (tripDistances(lmax + 1e-4, D, L0, L1).fromStart - tripDistances(lmax, D, L0, L1).fromStart) / 1e-4;
    // dr/dΛ = L₀ + D/2 before, L₁ + D/2 after: equal up to the end scales (L ≪ D).
    expect(Math.abs(vBefore - vAfter) / vBefore).toBeLessThan((2 * (L1 - L0)) / D + 1e-3);
  });

  it('is monotonic in distance to the target', () => {
    const D = 3e22, L0 = 6.4e6, L1 = 3e20;
    const Lt = tripLogLength(D, L0, L1);
    let prev = Infinity;
    for (let i = 0; i <= 200; i++) {
      const d = tripDistances((i / 200) * Lt, D, L0, L1).toEnd;
      expect(d).toBeLessThanOrEqual(prev + 1e-6 * D);
      prev = d;
    }
  });

  it('flies a trip across frames and lands in the destination frame', () => {
    const { universe, galaxy, local, system, planet } = chain();
    const m31 = new Frame({ id: 'm31', kind: 'galaxy', label: 'M31', parent: universe, unit: 1e-6, origin: new THREE.Vector3(12.8, -3.4, 0.9), entry: 150_000, exit: 200_000 });
    const kids = (f: Frame) => (f === universe ? [galaxy, m31] : f === galaxy ? [local] : f === local ? [system] : f === system ? [planet] : []);
    const nav = makeNav(planet);
    nav.position.set(20000, 0, 0);
    const trip = new Trip({ frame: planet, position: nav.position, scale: 6.4e6 }, { frame: m31, position: new THREE.Vector3(0, 60_000, 60_000), scale: 3e20 }, { lookAt: new THREE.Vector3() });
    // Early in the trip we are still in Earth's frame and close to the start.
    trip.step(0.1, nav);
    settleFrame(nav, kids);
    expect(nav.frame).toBe(planet);
    let prevRemaining = Infinity;
    for (let i = 0; i < 400 && !trip.done; i++) {
      trip.step(trip.duration / 300, nav);
      settleFrame(nav, kids);
      const r = trip.remaining();
      expect(r).toBeLessThanOrEqual(prevRemaining * (1 + 1e-9));
      prevRemaining = r;
    }
    expect(trip.done).toBe(true);
    expect(nav.frame).toBe(m31);
    expect(nav.position.distanceTo(new THREE.Vector3(0, 60_000, 60_000))).toBeLessThan(1e-3);
    // Arrival attitude faces the galaxy centre.
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(nav.quaternion);
    const want = new THREE.Vector3(0, -1, -1).normalize();
    expect(fwd.dot(want)).toBeGreaterThan(0.999);
  });

  it('arrives exactly at a destination whose frame moves during the trip', () => {
    const { local, system, planet } = chain();
    const kids = (f: Frame) => (f === local ? [system] : f === system ? [planet] : []);
    const nav = makeNav(local);
    nav.position.set(0.5, 0, 0); // 0.5 pc from the Sun
    const view = new THREE.Vector3(0, 0, 20000);
    const trip = new Trip({ frame: local, position: nav.position, scale: 1e15 }, { frame: planet, position: view, scale: 6.4e6 }, { lookAt: new THREE.Vector3() });
    for (let i = 0; i < 1000 && !trip.done; i++) {
      // The planet runs along its orbit (30 km/s × a time warp) while we fly.
      planet.origin.x += (30 * 3600) / 1.495978707e8;
      trip.step(trip.duration / 600, nav);
      settleFrame(nav, kids);
    }
    expect(trip.done).toBe(true);
    expect(nav.frame).toBe(planet);
    expect(nav.position.distanceTo(view)).toBeLessThan(1e-6);
  });

  it('smoother is 0 → 1 with flat ends', () => {
    expect(smoother(0)).toBe(0);
    expect(smoother(1)).toBe(1);
    expect(smoother(0.5)).toBeCloseTo(0.5, 12);
  });
});

describe('Local Group geometry', () => {
  it('places Andromeda at the right galactic coordinates', () => {
    const d = equatorialDir(M31.raDeg, M31.decDeg);
    const g = galacticDir(121.17, -21.57);
    expect(d.dot(g)).toBeGreaterThan(Math.cos((0.05 * Math.PI) / 180));
  });
  it('orients the M31 disk at 77° to the line of sight', () => {
    const o = diskOrientation(M31.raDeg, M31.decDeg, M31.paDeg, M31.inclinationDeg);
    const cosI = Math.abs(o.normal.dot(o.los));
    expect(Math.acos(cosI) * (180 / Math.PI)).toBeCloseTo(77, 3);
    // The rotation maps the galaxy's spin axis (+y) onto the disk normal.
    const y = new THREE.Vector3(0, 1, 0).applyQuaternion(o.rotation);
    expect(y.dot(o.normal)).toBeCloseTo(1, 9);
    // Major axis lies in the sky plane (perpendicular to the line of sight).
    expect(Math.abs(o.major.dot(o.los))).toBeLessThan(0.23);
  });
  it('chooses a light home halo with a Virgo-like neighbour and aligns it', () => {
    const halos = [
      { position: new THREE.Vector3(0, 0, 0), mass: 2e13, seed: 1 },
      { position: new THREE.Vector3(16, 0, 0), mass: 8e14, seed: 2 },
      { position: new THREE.Vector3(-60, 10, 0), mass: 1.5e13, seed: 3 },
      { position: new THREE.Vector3(40, 40, 40), mass: 3e14, seed: 4 },
    ];
    const c = chooseHome(halos, 300);
    expect(c.home).toBe(0);
    expect(c.virgo).toBe(1);
    expect(c.virgoDistance).toBeCloseTo(16, 6);
    const q = boxToGalactic(new THREE.Vector3(1, 0, 0));
    const v = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    expect(v.dot(galacticDir(VIRGO.l, VIRGO.b))).toBeCloseTo(1, 9);
  });
  it('wraps periodic images to the nearest copy', () => {
    const out = wrapNear(new THREE.Vector3(140, -140, 10), new THREE.Vector3(-140, 140, 0), 300, new THREE.Vector3());
    expect(out.x).toBeCloseTo(-160, 9);
    expect(out.y).toBeCloseTo(160, 9);
    expect(out.z).toBeCloseTo(10, 9);
  });
});

describe('scale bar', () => {
  it('rounds to 1, 2, 5 × 10ⁿ', () => {
    expect(niceScaleBar(730)).toBe(500);
    expect(niceScaleBar(2.3e16)).toBe(2e16);
    expect(niceScaleBar(1)).toBe(1);
  });
});

// ——— Review additions (hardening pass) ————————————————————————————————————————————————

describe('autopilot: velocity continuity and exact speed', () => {
  // (D, L0, L1): trips whose end scales are comparable to the distance — e.g. from the Milky Way
  // (L ≈ 15 kpc) out to the cosmic web (L ≈ 90 Mpc, D ≈ 700 Mpc), or from the web into a galaxy.
  const cases: Array<[number, number, number]> = [
    [1e20, 1e7, 1e18],
    [2.1e25, 4.6e20, 2.8e24],
    [1e22, 3e21, 1e5],
    [5e21, 1e5, 4e21],
    [3e22, 6.4e6, 3e20],
  ];
  it('dr/dΛ is continuous where departure hands over to arrival, for any end scales', () => {
    for (const [D, L0, L1] of cases) {
      const X = tripSwitch(D, L0, L1);
      const lsw = Math.log1p(X / L0);
      const h = 1e-6;
      const before = tripDistances(lsw - h, D, L0, L1);
      const after = tripDistances(lsw + h, D, L0, L1);
      expect(before.departing).toBe(true);
      expect(after.departing).toBe(false);
      // Position continuous, and the rate: the old midpoint switch jumped by (L1 − L0)/(L0 + D/2),
      // 27 % for the web trip (case 2).
      expect(Math.abs(after.fromStart - before.fromStart) / D).toBeLessThan(1e-5);
      expect(Math.abs(after.rate - before.rate) / before.rate).toBeLessThan(1e-5);
      // The analytic rate is the derivative of the path (differenced on the near end's distance,
      // which is where float64 keeps its digits).
      for (const lam of [0.3 * lsw, 0.5 * (lsw + tripLogLength(D, L0, L1))]) {
        const e = 1e-5;
        const a = tripDistances(lam + e, D, L0, L1), b = tripDistances(lam - e, D, L0, L1);
        const num = a.departing ? (a.fromStart - b.fromStart) / (2 * e) : (b.toEnd - a.toEnd) / (2 * e);
        expect(Math.abs(num - tripDistances(lam, D, L0, L1).rate) / num).toBeLessThan(1e-6);
      }
    }
  });
  it('the whole trip is covered: 0 → D over Λ_tot, monotonic', () => {
    for (const [D, L0, L1] of cases) {
      const Lt = tripLogLength(D, L0, L1);
      expect(tripDistances(0, D, L0, L1).fromStart).toBe(0);
      expect(tripDistances(Lt, D, L0, L1).toEnd / D).toBeLessThan(1e-12);
      let prev = -1;
      for (let i = 0; i <= 400; i++) {
        const r = tripDistances((i / 400) * Lt, D, L0, L1).fromStart;
        expect(r).toBeGreaterThanOrEqual(prev - 1e-9 * D);
        prev = r;
      }
    }
  });
  it('reports an exact, noise-free speed next to a planet (no root-frame differencing)', () => {
    const { universe, galaxy, local, system, planet } = chain();
    const m31 = new Frame({ id: 'm31', kind: 'galaxy', label: 'M31', parent: universe, unit: 1e-6, origin: new THREE.Vector3(12.8, -3.4, 0.9), entry: 150_000, exit: 200_000 });
    const kids = (f: Frame) => (f === universe ? [galaxy, m31] : f === galaxy ? [local] : f === local ? [system] : f === system ? [planet] : []);
    const nav = makeNav(planet);
    nav.position.set(20000, 0, 0);
    const trip = new Trip({ frame: planet, position: nav.position, scale: 1e7 }, { frame: m31, position: new THREE.Vector3(0, 60_000, 60_000), scale: 3e20 }, { lookAt: new THREE.Vector3() });
    const dt = trip.duration / 4000;
    let prev = -1;
    for (let i = 0; i < 120; i++) {
      trip.step(dt, nav);
      settleFrame(nav, kids);
      // Early in the trip (still near Earth) the speed grows smoothly from zero: km/s, not the
      // ~10³ km/s jitter that differencing ~50 km-grained root-frame positions produced.
      expect(trip.speed).toBeGreaterThanOrEqual(prev);
      prev = trip.speed;
    }
    expect(nav.frame).toBe(planet);
    expect(prev).toBeLessThan(SPEED_OF_LIGHT * 0.01);
    // Speed = d(distance from start)/dt of the analytic path.
    const u = trip.progress;
    const lam = (x: number) => smoother(x) * trip.logLength;
    const e = 1e-6;
    const num = ((tripDistances(lam(u + e), trip.distance, 1e7, 3e20).fromStart - tripDistances(lam(u - e), trip.distance, 1e7, 3e20).fromStart) / (2 * e)) / trip.duration;
    expect(Math.abs(trip.speed - num) / num).toBeLessThan(1e-4);
    expect(smootherDeriv(0.5)).toBeCloseTo(1.875, 12);
  });
});

describe('procedural planets only around hosts the generator can model', () => {
  it('classifies hosts on the HR diagram', () => {
    expect(classifyHost(4.83, 5772)).toBe('main-sequence'); // the Sun
    expect(classifyHost(15.5, 2900)).toBe('main-sequence'); // Proxima Centauri (M5.5 V)
    expect(classifyHost(11.18, 25000)).toBe('white-dwarf'); // Sirius B
    expect(classifyHost(-0.3, 4286)).toBe('giant'); // Arcturus
    expect(classifyHost(-5.85, 3600)).toBe('giant'); // Betelgeuse
    expect(procHostHint(4.83, 5772)).toEqual({ teff: 5772, stage: 'main-sequence', binary: false });
    expect(procHostHint(11.18, 25000)).toBeNull();
    expect(procHostHint(NaN, 5772)).toBeNull();
  });
  it('every modelled catalogue host within 30 pc gets a main-sequence star (the generator would otherwise draw giants and white dwarfs)', () => {
    const cat = decodeStarCatalog(STAR_DATA_B64, STAR_NAMES);
    let hosts = 0;
    let wrongWithoutStage = 0;
    for (let i = 1; i < cat.count; i++) {
      if (cat.distance[i] > 30) continue;
      const hint = procHostHint(cat.absMag[i], cat.temperature[i]);
      if (!hint) continue;
      hosts++;
      const seed = (i * 7919 + 13) >>> 0; // as the explorer seeds its systems
      const sys = generateSystem(seed, hint);
      expect(sys.star.stage).toBe('main-sequence');
      if (generateSystem(seed, { teff: hint.teff, binary: false }).star.stage !== 'main-sequence') wrongWithoutStage++;
    }
    expect(hosts).toBeGreaterThan(1000);
    // The bug this guards against: ~6 % of real stars used to host a random giant or white dwarf.
    expect(wrongWithoutStage).toBeGreaterThan(0);
  }, 60_000);
});

describe('engine plume: ray–jet interval (CPU twin of the shader)', () => {
  const R0 = 0.73, k = Math.tan((3.5 * Math.PI) / 180), zMax = 60;
  const inside = (p: THREE.Vector3) => p.z >= 0 && p.z <= zMax && Math.hypot(p.x, p.y) <= R0 + k * p.z;
  it('matches brute-force sampling along random rays (all quadratic branches)', () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
    const ro = new THREE.Vector3(), rd = new THREE.Vector3(), p = new THREE.Vector3();
    let hits = 0, steep = 0;
    for (let n = 0; n < 3000; n++) {
      ro.set(rnd() * 12, rnd() * 12, rnd() * 50 + 20);
      // Mix of shallow rays and rays nearly along the axis (steeper than the cone: A < 0).
      if (n % 3 === 0) rd.set(rnd() * 0.04, rnd() * 0.04, rnd() > 0 ? 1 : -1).normalize();
      else rd.set(rnd(), rnd(), rnd()).normalize();
      if (rd.x * rd.x + rd.y * rd.y < k * k * rd.z * rd.z) steep++;
      const iv = plumeConeInterval(ro, rd, R0, k, zMax);
      // Brute force over t ∈ [0, 200].
      let first = -1, last = -1;
      const dt = 0.01;
      for (let t = 0; t <= 200; t += dt) {
        if (inside(p.copy(ro).addScaledVector(rd, t))) {
          if (first < 0) first = t;
          last = t;
        }
      }
      if (first < 0) {
        // (a ray can graze the surface between samples)
        if (iv) expect(iv[1] - iv[0]).toBeLessThan(2 * dt);
        continue;
      }
      hits++;
      expect(iv).not.toBeNull();
      expect(Math.abs(iv![0] - first)).toBeLessThan(2 * dt);
      expect(Math.abs(Math.min(iv![1], 200) - last)).toBeLessThan(2 * dt);
    }
    expect(hits).toBeGreaterThan(200);
    expect(steep).toBeGreaterThan(200);
  });
});

describe('frames agree with the sky and the Galaxy', () => {
  it('the Milky Way render frame is the sky catalogue\'s galactic frame (no rotation needed)', () => {
    const p = milkyWay(1);
    const sun = p.sun!;
    // Sun in the render frame (x = R cos φ, y = z, z = −spin R sin φ), as the explorer places it.
    const s = new THREE.Vector3(sun.R * Math.cos(sun.phi), sun.z, -p.spin * sun.R * Math.sin(sun.phi));
    // The Galactic centre is at l = 0, b ≈ 0 from the Sun: +x of the catalogue frame.
    const toGC = s.clone().negate().normalize();
    expect(toGC.dot(galacticDir(0, 0))).toBeGreaterThan(Math.cos((0.2 * Math.PI) / 180));
    // The Sun orbits toward l = 90° (Galactic rotation, e.g. Reid & Brunthaler 2004).
    const omega = new THREE.Vector3(0, p.spin, 0); // spin = −1: clockwise seen from the NGP (+y)
    const v = omega.clone().cross(s).normalize();
    expect(v.dot(galacticDir(90, 0))).toBeGreaterThan(0.999);
    expect(sun.z).toBeGreaterThan(0); // above the plane (≈ 20.8 pc, Bennett & Bovy 2019)
  });
  it('Sgr A*: r_g = GM/c² and t_g = r_g/c for 4.3 × 10⁶ M☉', () => {
    const GM_SUN = 1.32712440018e20; // m³ s⁻² (IAU 2015 nominal)
    const rg = (GM_SUN * SGRA.massSun) / 299792458 ** 2;
    expect(Math.abs(rg - SGRA.rgMetres) / rg).toBeLessThan(2e-3);
    expect(Math.abs(rg / 299792458 - SGRA.tgSeconds) / SGRA.tgSeconds).toBeLessThan(3e-3);
  });
  it('M31’s near side is the north-west and its disk spins so the north-east half recedes', () => {
    const o = diskOrientation(M31.raDeg, M31.decDeg, M31.paDeg, M31.inclinationDeg);
    // Tangent basis at M31 (galactic three.js axes via equatorialDir of small offsets).
    const n = equatorialDir(M31.raDeg, M31.decDeg);
    const north = equatorialDir(M31.raDeg, M31.decDeg + 0.01).sub(n).normalize();
    const east = equatorialDir(M31.raDeg + 0.01 / Math.cos((M31.decDeg * Math.PI) / 180), M31.decDeg).sub(n).normalize();
    // A disk point toward the NW (PA 308°, on the minor axis) is nearer to us than the centre.
    const pa = (308 * Math.PI) / 180;
    const sky = north.clone().multiplyScalar(Math.cos(pa)).addScaledVector(east, Math.sin(pa));
    const inDisk = sky.clone().addScaledVector(o.normal, -sky.dot(o.normal)).normalize();
    expect(inDisk.dot(n)).toBeLessThan(-0.5); // toward the observer (−line of sight)
    // With angular momentum along +y of the galaxy frame (params spin = +1), the NE end of the major
    // axis (PA 38°) moves away from us: observed redshifted, as in M31's rotation curve.
    const ne = o.major.clone(); // PA 38°
    const vNE = o.normal.clone().cross(ne);
    const pa38 = (38 * Math.PI) / 180;
    expect(ne.dot(north.clone().multiplyScalar(Math.cos(pa38)).addScaledVector(east, Math.sin(pa38)))).toBeGreaterThan(0.99);
    expect(vNE.dot(n)).toBeGreaterThan(0.2);
  });
});
