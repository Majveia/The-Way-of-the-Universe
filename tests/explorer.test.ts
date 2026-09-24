import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Frame, UNIT, commonAncestor, convertPoint, convertDirection, distanceMetres, makeNav, rebase, settleFrame } from '../src/worlds/explorer/frames';
import { Trip, autoSpeed, niceScaleBar, smoother, tripDistances, tripLogLength, SPEED_OF_LIGHT } from '../src/worlds/explorer/navigation';
import { M31, VIRGO, boxToGalactic, chooseHome, diskOrientation, equatorialDir, galacticDir, wrapNear } from '../src/worlds/explorer/universe';

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
