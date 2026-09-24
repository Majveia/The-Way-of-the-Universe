import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  C_PC_PER_YEAR,
  G_IN_C_PER_YEAR,
  aberrateCos,
  aberrateDirection,
  addVelocities,
  blackbodyLuminance,
  deaberrateCos,
  deaberrateDirection,
  dopplerFromObserved,
  dopplerFromRest,
  gammaOf,
  intensityBoost,
  logBlackbodyLuminance,
  magnitudeShift,
  planTrip,
  pointFluxBoost,
  rocketAtProperTime,
  rocketProperTimeForDistance,
  stepProperVelocity,
  visualFluxRatio,
} from '../src/physics/voyage-relativity';
import { C, LY, YEAR, PC } from '../src/physics/constants';
import { decodeStarCatalog, raDecToGalacticThree } from '../src/worlds/sky/catalog';
import { STAR_DATA_B64, STAR_NAMES } from '../src/worlds/sky/data/stars';
import { CONSTELLATION_FIGURES } from '../src/worlds/sky/data/constellations';
import { bayerToGreek, parseBayerQuery } from '../src/worlds/sky/constellationNames';
import { StarshipFlight } from '../src/worlds/ship/flight';
import { FlyRig } from '../src/core/rigs/FlyRig';

const G0 = 9.80665;

describe('special relativity: aberration and Doppler', () => {
  it('aberration crowds directions forward and is invertible', () => {
    for (const b of [0.1, 0.5, 0.9, 0.99]) {
      for (const c of [-1, -0.5, 0, 0.3, 0.9, 1]) {
        const co = aberrateCos(c, b);
        expect(co).toBeGreaterThanOrEqual(c - 1e-12); // moves toward the apex
        expect(deaberrateCos(co, b)).toBeCloseTo(c, 12);
      }
    }
    // A star at 90° in the rest frame appears at cos θ' = β.
    expect(aberrateCos(0, 0.9)).toBeCloseTo(0.9, 12);
  });
  it('the Doppler factor agrees in both frames and matches γ(1±β) on axis', () => {
    for (const b of [0.2, 0.9, 0.999]) {
      const g = gammaOf(b);
      expect(dopplerFromRest(1, b)).toBeCloseTo(Math.sqrt((1 + b) / (1 - b)), 9);
      expect(dopplerFromRest(-1, b)).toBeCloseTo(Math.sqrt((1 - b) / (1 + b)), 9);
      for (const c of [-0.7, 0, 0.4]) {
        expect(dopplerFromObserved(aberrateCos(c, b), b)).toBeCloseTo(dopplerFromRest(c, b), 9);
      }
      // Transverse (rest-frame 90°) Doppler: δ = γ — a blueshift, unlike the naive expectation.
      expect(dopplerFromRest(0, b)).toBeCloseTo(g, 12);
    }
  });
  it('vector aberration preserves unit length and inverts', () => {
    const beta = new THREE.Vector3(0.3, -0.5, 0.6);
    const d = new THREE.Vector3(-0.2, 0.9, 0.4).normalize();
    const o = new THREE.Vector3(), back = new THREE.Vector3();
    const delta = aberrateDirection(d, beta, o);
    expect(o.length()).toBeCloseTo(1, 12);
    const delta2 = deaberrateDirection(o, beta, back);
    expect(back.distanceTo(d)).toBeLessThan(1e-12);
    expect(delta2).toBeCloseTo(delta, 12);
    // The direction moves toward β.
    expect(o.dot(beta.clone().normalize())).toBeGreaterThan(d.dot(beta.clone().normalize()));
  });
  it('solid angles shrink by δ²: point sources gain δ², surface brightness δ⁴', () => {
    // Numerically: a ring of rest-frame directions around θ maps to a ring whose area ratio is 1/δ².
    const b = 0.8;
    const th = 1.1, dth = 1e-5;
    const c0 = Math.cos(th), c1 = Math.cos(th + dth);
    const area = c0 - c1; // ∝ dΩ for a ring
    const areaObs = aberrateCos(c0, b) - aberrateCos(c1, b);
    const delta = dopplerFromRest(Math.cos(th + dth / 2), b);
    expect(areaObs / area).toBeCloseTo(1 / (delta * delta), 6);
    expect(pointFluxBoost(delta)).toBeCloseTo(delta * delta, 12);
    expect(intensityBoost(delta)).toBeCloseTo(delta ** 4, 12);
  });
  it('relativistic velocity addition never exceeds c and reduces to the collinear formula', () => {
    const u = new THREE.Vector3(0.9, 0, 0), v = new THREE.Vector3(0.9, 0, 0), out = new THREE.Vector3();
    addVelocities(u, v, out);
    expect(out.x).toBeCloseTo(1.8 / 1.81, 12);
    addVelocities(new THREE.Vector3(0.99, 0, 0), new THREE.Vector3(0, 0.99, 0), out);
    expect(out.length()).toBeLessThan(1);
  });
});

describe('photometry of thermal light', () => {
  it('luminance rises steeply with temperature, is 1 at the Sun, and finite for the CMB', () => {
    expect(blackbodyLuminance(5772)).toBeCloseTo(1, 10);
    expect(blackbodyLuminance(10000)).toBeGreaterThan(5);
    expect(blackbodyLuminance(3000)).toBeLessThan(0.1);
    const cmb = logBlackbodyLuminance(2.7255) / Math.LN10;
    expect(cmb).toBeLessThan(-900); // invisible at rest…
    expect(isFinite(cmb)).toBe(true);
    // …but a 2000× Doppler boost makes it a 5450 K glow, like a photosphere.
    expect(blackbodyLuminance(2.7255 * 2000)).toBeGreaterThan(0.5);
  });
  it('a Doppler-boosted star brightens ahead only moderately, then fades into the ultraviolet', () => {
    const T = 5772;
    expect(visualFluxRatio(T, 1)).toBeCloseTo(1, 12);
    expect(visualFluxRatio(T, 2)).toBeGreaterThan(1.5);
    // At extreme δ the visible band sits on the Rayleigh–Jeans tail: flux ∝ δT/δ² → falls as 1/δ.
    expect(visualFluxRatio(T, 100)).toBeLessThan(visualFluxRatio(T, 10));
    // Behind the ship a red dwarf redshifts out of sight.
    expect(magnitudeShift(3200, 0.2)).toBeGreaterThan(8);
  });
});

describe('relativistic rocket', () => {
  it('1 g for one year of ship time reaches 0.77 c', () => {
    // 1 g × 1 Julian year = 1.0323 c: rapidity 1.0323, β = tanh 1.0323 = 0.7748, t = sinh(φ)/φ yr.
    const s = rocketAtProperTime(G0, YEAR);
    expect(s.beta).toBeCloseTo(0.7748, 4);
    expect(s.t / YEAR).toBeCloseTo(1.1873, 3);
  });
  it('α Centauri (4.344 ly) at 1 g, flip at midpoint: 3.6 yr ship time, 5.9 yr Earth time', () => {
    const p = planTrip(4.344 * LY, G0);
    expect(p.tau / YEAR).toBeGreaterThan(3.5);
    expect(p.tau / YEAR).toBeLessThan(3.7);
    expect(p.t / YEAR).toBeGreaterThan(5.8);
    expect(p.t / YEAR).toBeLessThan(6.0);
    expect(p.betaPeak).toBeGreaterThan(0.94);
    expect(p.betaPeak).toBeLessThan(0.96);
    // Proper time from the analytic inverse matches.
    expect(rocketProperTimeForDistance(G0, 2.172 * LY) * 2).toBeCloseTo(p.tau, -4);
  });
  it('a speed cap turns long trips into accelerate–coast–decelerate', () => {
    const p = planTrip(500 * LY, G0, 0.999);
    expect(p.betaPeak).toBe(0.999);
    expect(p.tauCoast).toBeGreaterThan(0);
    expect(p.t / YEAR).toBeGreaterThan(500);
    expect(p.tau / YEAR).toBeLessThan(40);
  });
  it('the 4-acceleration integrator reproduces rapidity = ατ for straight-line thrust', () => {
    const u = new THREE.Vector3();
    const a = new THREE.Vector3(G_IN_C_PER_YEAR, 0, 0); // 1 g in c/yr
    for (let i = 0; i < 1000; i++) stepProperVelocity(u, a, 0.002);
    expect(Math.asinh(u.x)).toBeCloseTo(G_IN_C_PER_YEAR * 2, 9);
  });
  it('a perpendicular proper acceleration turns the velocity without changing the speed much', () => {
    const u = new THREE.Vector3(2, 0, 0);
    const a = new THREE.Vector3(0, 0.001, 0);
    stepProperVelocity(u, a, 1);
    expect(u.y).toBeCloseTo(0.001, 9); // a⊥ is not boosted
  });
});

describe('Starship autopilot', () => {
  const fly = (distPc: number, accelG: number, cap = 0.999) => {
    const f = new StarshipFlight();
    f.accelG = accelG;
    f.betaCap = cap;
    const target = new THREE.Vector3(distPc, 0.1 * distPc, -0.3 * distPc).normalize().multiplyScalar(distPc);
    let arrived = false;
    f.onArrive = () => (arrived = true);
    f.engage(target, { arrive: 1e-5 });
    let peak = 0;
    let frames = 0;
    for (; frames < 60 * 600 && !arrived; frames++) {
      f.update(1 / 60);
      peak = Math.max(peak, f.beta);
    }
    return { f, arrived, peak, frames, target };
  };
  it('flies to α Centauri, flips, and arrives at rest at the standoff distance', () => {
    const d = (4.344 * LY) / PC;
    const { f, arrived, peak, frames, target } = fly(d, 1);
    expect(arrived).toBe(true);
    expect(f.u.length()).toBe(0);
    expect(f.position.distanceTo(target)).toBeCloseTo(1e-5, 7);
    expect(f.lastSnap).toBeLessThan(2e-7); // < 0.04 AU
    // Proper and coordinate times near the analytic brachistochrone (flip coasting adds a little).
    const plan = planTrip(d * PC, G0);
    expect(f.tau).toBeGreaterThan(plan.tau / YEAR);
    expect(f.tau).toBeLessThan((plan.tau / YEAR) * 1.08);
    expect(f.t).toBeGreaterThan(f.tau * 1.4); // time dilation
    expect(peak).toBeGreaterThan(0.93);
    expect(peak).toBeLessThan(0.96);
    // …and the trip is a watchable length in real time.
    expect(frames / 60).toBeGreaterThan(15);
    expect(frames / 60).toBeLessThan(90);
  });
  it('respects the 0.999 c cap on long trips and still arrives', () => {
    const { arrived, peak, f } = fly(150, 1, 0.999);
    expect(arrived).toBe(true);
    expect(peak).toBeLessThanOrEqual(0.999 + 1e-9);
    expect(peak).toBeGreaterThan(0.998);
    expect(f.t / f.tau).toBeGreaterThan(8);
  });
  it('arrives from a moving start (velocity matched)', () => {
    const f = new StarshipFlight();
    f.u.set(0.5, 0.2, 0); // already moving, mostly sideways
    const target = new THREE.Vector3(0, 0, -1);
    let arrived = false;
    f.onArrive = () => (arrived = true);
    f.engage(target, { arrive: 1e-4 });
    for (let i = 0; i < 60 * 600 && !arrived; i++) f.update(1 / 60);
    expect(arrived).toBe(true);
    expect(f.position.distanceTo(target)).toBeCloseTo(1e-4, 6);
    expect(f.lastSnap).toBeLessThan(1e-5); // the settle is a tiny correction, not a teleport
  });
  it('manual throttle holds the commanded speed along the nose', () => {
    const f = new StarshipFlight();
    f.warp = 0.05; // 40 s → 2 yr of ship time; 0.9 c needs artanh(0.9)/1.03 ≈ 1.43 yr at 1 g
    f.manualBeta = 0.9;
    for (let i = 0; i < 60 * 40; i++) f.update(1 / 60);
    expect(f.beta).toBeCloseTo(0.9, 3);
    expect(f.velocity().normalize().dot(f.forward())).toBeCloseTo(1, 6);
  });
  it('light-years per year: c in pc/yr', () => {
    expect(C_PC_PER_YEAR).toBeCloseTo((C * YEAR) / PC, 12);
    expect(C_PC_PER_YEAR * (PC / LY)).toBeCloseTo(1, 12);
  });
});

describe('FlyRig autopilot', () => {
  it('travelTo arrives at the standoff point at rest, matching the initial velocity', () => {
    const rig = new FlyRig(null);
    rig.velocity.set(3, 0, 0);
    rig.travelTo({ position: new THREE.Vector3(0, 0, -1000), arriveDistance: 10 }, { duration: 5 });
    const p0 = rig.position.clone();
    rig.update(1e-3);
    // Initial velocity is continuous (≈ v0 plus the quintic path's zero initial speed).
    const v = rig.position.clone().sub(p0).divideScalar(1e-3);
    expect(v.x).toBeCloseTo(3, 1);
    let arrived = false;
    rig.onArrive = () => (arrived = true);
    for (let i = 0; i < 400; i++) rig.update(1 / 60);
    expect(arrived).toBe(true);
    expect(rig.position.distanceTo(new THREE.Vector3(0, 0, -990))).toBeLessThan(1e-9);
    expect(rig.velocity.length()).toBe(0);
  });
  it('log profile covers many decades smoothly', () => {
    const rig = new FlyRig(null);
    rig.travelTo({ position: new THREE.Vector3(1e6, 0, 0), arriveDistance: 1 }, { profile: 'log', duration: 4 });
    let prev = Infinity;
    for (let i = 0; i < 240; i++) {
      rig.update(1 / 60);
      const d = rig.position.distanceTo(new THREE.Vector3(1e6, 0, 0));
      expect(d).toBeLessThanOrEqual(prev + 1e-6);
      prev = d;
    }
    expect(prev).toBeCloseTo(1, 6);
  });
});

describe('real star catalogue', () => {
  const cat = decodeStarCatalog(STAR_DATA_B64, STAR_NAMES);
  it('decodes ~11 600 stars with the Sun first and Sirius the brightest star in the night sky', () => {
    expect(cat.count).toBeGreaterThan(11000);
    expect(cat.info(0).name).toBe('Sun');
    expect(cat.info(1).name).toBe('Sirius');
    expect(cat.mag[1]).toBeCloseTo(-1.44, 2);
  });
  it('places stars at the right distance and direction', () => {
    const acen = cat.find('α Centauri');
    expect(cat.info(acen).proper).toBe('Rigil Kentaurus');
    expect(cat.distance[acen] * (PC / LY)).toBeCloseTo(4.344, 2);
    const prox = cat.find('Proxima Centauri');
    expect(cat.distance[prox] * (PC / LY)).toBeCloseTo(4.2465, 3);
    // α Cen lies at galactic (l, b) ≈ (315.7°, −0.7°).
    const p = new THREE.Vector3(cat.position[acen * 3], cat.position[acen * 3 + 1], cat.position[acen * 3 + 2]).normalize();
    const l = (Math.atan2(-p.z, p.x) * 180) / Math.PI + 360;
    expect(l).toBeCloseTo(315.7, 0);
    expect((Math.asin(p.y) * 180) / Math.PI).toBeCloseTo(-0.68, 0);
    // RA/Dec decode round trip for Betelgeuse (5h55m10s, +7°24′25″).
    const bet = cat.find('Betelgeuse');
    expect((cat.ra[bet] * 12) / Math.PI).toBeCloseTo(5.9195, 3);
    expect((cat.dec[bet] * 180) / Math.PI).toBeCloseTo(7.407, 3);
    const dir = raDecToGalacticThree(cat.ra[bet], cat.dec[bet]);
    const pb = new THREE.Vector3(cat.position[bet * 3], cat.position[bet * 3 + 1], cat.position[bet * 3 + 2]).normalize();
    expect(dir.distanceTo(pb)).toBeLessThan(1e-6);
  });
  it('colours come from B−V: Betelgeuse is cool, Rigel hot', () => {
    expect(cat.temperature[cat.find('Betelgeuse')]).toBeLessThan(4000);
    expect(cat.temperature[cat.find('Rigel')]).toBeGreaterThan(9000);
  });
  it('from α Centauri the Sun is a 0.5-magnitude star in Cassiopeia', () => {
    const acen = cat.find('α Centauri');
    const d = cat.distance[acen];
    const mSun = 4.83 + 5 * Math.log10(d / 10);
    expect(mSun).toBeCloseTo(0.45, 1);
    // Direction to the Sun from α Cen is the antipode of α Cen's direction: RA ≈ 2h40m, Dec ≈ +60.8°.
    const ra = cat.ra[acen] + Math.PI, dec = -cat.dec[acen];
    expect((((ra * 12) / Math.PI) + 24) % 24).toBeCloseTo(2.66, 1);
    expect((dec * 180) / Math.PI).toBeCloseTo(60.83, 1);
  });
  it('finds stars by name and Bayer designation in several spellings', () => {
    expect(cat.find('alpha Centauri')).toBe(cat.find('Rigil Kentaurus'));
    expect(cat.find('Alp1 Cen')).toBe(cat.find('Rigil Kentaurus'));
    expect(cat.find('bet ori')).toBe(cat.find('Rigel'));
    expect(cat.find('no such star')).toBe(-1);
    expect(bayerToGreek('Kap-1')).toBe('κ¹');
    expect(parseBayerQuery('epsilon Eridani')).toEqual({ bayer: 'Eps', con: 'Eri' });
  });
  it('has 88 constellation figures made of valid star pairs, Orion included', () => {
    expect(CONSTELLATION_FIGURES.length).toBe(88);
    for (const [, segs] of CONSTELLATION_FIGURES) {
      expect(segs.length % 2).toBe(0);
      for (const i of segs) expect(i).toBeGreaterThanOrEqual(0), expect(i).toBeLessThan(cat.count);
    }
    const ori = CONSTELLATION_FIGURES.find(([c]) => c === 'Ori')![1];
    const has = (a: string, b: string) => {
      const ia = cat.find(a), ib = cat.find(b);
      for (let k = 0; k < ori.length; k += 2) if ((ori[k] === ia && ori[k + 1] === ib) || (ori[k] === ib && ori[k + 1] === ia)) return true;
      return false;
    };
    expect(has('Alnilam', 'Mintaka')).toBe(true); // the belt
    expect(has('Alnitak', 'Alnilam')).toBe(true);
    expect(has('Betelgeuse', 'Alnitak')).toBe(true);
  });
});
