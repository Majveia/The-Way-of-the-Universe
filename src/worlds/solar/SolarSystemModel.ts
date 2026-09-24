/**
 * SolarSystemModel — where every body is, how it is oriented, at any instant 3000 BC … AD 3000.
 *
 * Frame: heliocentric J2000 mean ecliptic & equinox, three.js axes (y = ecliptic north), AU, days.
 * Time: Julian date in TT (use time.ts utcToTT for clock times).
 *
 * Sources: Standish planet elements (ephem/standish.ts); ELP-2000/82 Moon (ephem/moon.ts); satellite
 * mean elements fitted to JPL Horizons (data/moons.ts); SBDB conics for small bodies and comets;
 * Horizons state vectors for spacecraft; IAU/WGCCRE 2015 rotation. Earth and Pluto are split out of
 * the Earth–Moon and Pluto–Charon barycentres using the mass ratios.
 *
 * Pure data + math: no rendering. Allocation-free `update()`.
 */
import * as THREE from 'three';
import type { BodyDef, BodyKind } from './data/types';
import { SUN, PLANETS } from './data/planets';
import { MOONS, CHARON_PLUTO_MASS_RATIO } from './data/moons';
import { COMETS, DWARFS_AND_ASTEROIDS, SPACECRAFT } from './data/small';
import { planetElements, planetPosition, type PlanetElements } from './ephem/standish';
import { EMB_MU, moonGeocentric } from './ephem/moon';
import { satelliteNormal, satellitePosition, type SatOrbitGeometry } from './ephem/satellite';
import { conicState, stateToConic, MU_SUN, type ConicElements } from './ephem/conic';
import { iauOrientation } from './ephem/rotation';
import { fromThree, lockedQuaternion, toThree } from './frames';
import { hashString } from '../../physics/random';

export const AU_KM = 149_597_870.7;
/** Earth+Moon GM in AU³/day² (for the Moon's osculating orbit). */
const MU_EARTH_MOON = 8.997011390199872e-10;

export interface SolarBody {
  readonly def: BodyDef;
  readonly id: string;
  readonly index: number;
  parent: SolarBody | null;
  readonly children: SolarBody[];
  /** Heliocentric position (three.js ecliptic axes, AU). */
  readonly position: THREE.Vector3;
  /** Heliocentric velocity (AU/day). */
  readonly velocity: THREE.Vector3;
  /** Position relative to the parent body (AU). */
  readonly local: THREE.Vector3;
  /** Velocity relative to the parent (AU/day). */
  readonly localVelocity: THREE.Vector3;
  /** Body-fixed base frame (local +Y = north pole, +X = prime-meridian node); spin applied separately. */
  readonly quaternion: THREE.Quaternion;
  /** Spin angle about local +Y (rad) — pass to PlanetView.setRotation. */
  spin: number;
  /** North pole unit vector (three.js frame). */
  readonly pole: THREE.Vector3;
  /** Mean radius (AU). */
  readonly radius: number;
  /** Triaxial radii (AU): x, y(=polar), z in the body frame. */
  readonly radii: THREE.Vector3;
  /** Distance from the Sun (AU). */
  sunDistance: number;
  /** False outside the body's valid interval (e.g. spacecraft before their last flyby). */
  active: boolean;
  /** Heliocentric conic for small bodies (null for planets/moons). */
  readonly conic: ConicElements | null;
}

export interface OrbitGeometry {
  /** 'ellipse' | 'hyperbola' */
  hyperbolic: boolean;
  /** Semi-major axis (AU, positive) and semi-minor axis (AU). */
  a: number;
  b: number;
  e: number;
  /** Unit vectors: toward pericentre, 90° ahead in the plane (three.js frame). */
  P: THREE.Vector3;
  Q: THREE.Vector3;
  /** Current eccentric (or hyperbolic) anomaly of the body. */
  anomaly: number;
  /** Period in days (Infinity for open orbits). */
  period: number;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _el: PlanetElements = { a: 1, e: 0, i: 0, node: 0, peri: 0, M: 0, n: 0 };
const _geom: SatOrbitGeometry = { a: 1, e: 0, P: new THREE.Vector3(), Q: new THREE.Vector3(), W: new THREE.Vector3(), E: 0 };
const Y_UP = new THREE.Vector3(0, 1, 0);

export interface ModelOptions {
  /** Include comets / spacecraft / minor asteroids (default all true). */
  comets?: boolean;
  spacecraft?: boolean;
  asteroids?: boolean;
}

export class SolarSystemModel {
  readonly bodies: SolarBody[] = [];
  readonly byId = new Map<string, SolarBody>();
  readonly sun: SolarBody;
  /** Julian date (TT) of the last update. */
  jd = NaN;
  private charonRatio = CHARON_PLUTO_MASS_RATIO / (1 + CHARON_PLUTO_MASS_RATIO);

  constructor(o: ModelOptions = {}) {
    const defs: BodyDef[] = [SUN, ...PLANETS, ...MOONS, ...DWARFS_AND_ASTEROIDS];
    if (o.comets !== false) defs.push(...COMETS);
    if (o.spacecraft !== false) defs.push(...SPACECRAFT);
    for (const def of defs) {
      if (o.asteroids === false && def.kind === 'asteroid') continue;
      const rk = def.radiiKm ?? [def.radiusKm, def.radiusKm, def.radiusKm];
      let conic: ConicElements | null = null;
      if (def.orbit.type === 'conic') conic = def.orbit.el;
      else if (def.orbit.type === 'state') {
        const r = new THREE.Vector3(...def.orbit.r);
        const v = new THREE.Vector3(...def.orbit.v);
        conic = stateToConic(r, v, def.orbit.jd, MU_SUN);
      }
      const b: SolarBody = {
        def,
        id: def.id,
        index: this.bodies.length,
        parent: null,
        children: [],
        position: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
        local: new THREE.Vector3(),
        localVelocity: new THREE.Vector3(),
        quaternion: new THREE.Quaternion(),
        spin: 0,
        pole: new THREE.Vector3(0, 1, 0),
        radius: def.radiusKm / AU_KM,
        // Body frame: x = a (equatorial), y = c (polar), z = b (equatorial).
        radii: new THREE.Vector3(rk[0] / AU_KM, rk[2] / AU_KM, rk[1] / AU_KM),
        sunDistance: 1,
        active: true,
        conic,
      };
      this.bodies.push(b);
      this.byId.set(def.id, b);
    }
    for (const b of this.bodies) {
      if (b.def.parent) {
        const p = this.byId.get(b.def.parent) ?? null;
        b.parent = p;
        p?.children.push(b);
      }
    }
    this.sun = this.byId.get('sun')!;
  }

  get(id: string): SolarBody | undefined {
    return this.byId.get(id);
  }

  /** Bodies of a kind (allocates; for set-up code). */
  ofKind(kind: BodyKind): SolarBody[] {
    return this.bodies.filter((b) => b.def.kind === kind);
  }

  /** Recompute every body's state at jd (TT). Allocation-free. */
  update(jd: number): void {
    this.jd = jd;
    const sun = this.sun;
    sun.position.set(0, 0, 0);
    sun.velocity.set(0, 0, 0);
    // 1. Heliocentric primaries (planets, barycentres, small bodies).
    for (const b of this.bodies) {
      const o = b.def.orbit;
      switch (o.type) {
        case 'planet':
          planetPosition(o.key, jd, _a, _b);
          toThree(_a.x, _a.y, _a.z, b.position);
          toThree(_b.x, _b.y, _b.z, b.velocity);
          break;
        case 'earth':
        case 'pluto': {
          // Barycentre for now; resolved after the moons.
          planetPosition(o.type === 'earth' ? 'emb' : 'pluto', jd, _a, _b);
          toThree(_a.x, _a.y, _a.z, b.position);
          toThree(_b.x, _b.y, _b.z, b.velocity);
          break;
        }
        case 'conic':
        case 'state':
          if (b.conic) {
            conicState(b.conic, jd, _a, _b);
            toThree(_a.x, _a.y, _a.z, b.position);
            toThree(_b.x, _b.y, _b.z, b.velocity);
          }
          b.active = b.def.visibleFrom === undefined || jd >= b.def.visibleFrom;
          break;
        default:
          break;
      }
    }
    // 2. Moons relative to their parents (parents still at barycentres for Earth/Pluto).
    const earth = this.byId.get('earth');
    const pluto = this.byId.get('pluto');
    const moon = this.byId.get('moon');
    const charon = this.byId.get('charon');
    if (moon && earth) {
      // Moon velocity by central difference (1 h) — the series has no analytic derivative.
      moonGeocentric(jd, moon.local);
      moonGeocentric(jd + 1 / 24, _a);
      moonGeocentric(jd - 1 / 24, _b);
      moon.localVelocity.subVectors(_a, _b).multiplyScalar(12);
      // Earth = EMB − µ·r, Moon = Earth + r.
      earth.position.addScaledVector(moon.local, -EMB_MU);
      earth.velocity.addScaledVector(moon.localVelocity, -EMB_MU);
    }
    if (charon && pluto && charon.def.orbit.type === 'sat') {
      satellitePosition(charon.def.orbit.fit, jd, charon.local, charon.localVelocity);
      pluto.position.addScaledVector(charon.local, -this.charonRatio);
      pluto.velocity.addScaledVector(charon.localVelocity, -this.charonRatio);
    }
    for (const b of this.bodies) {
      const o = b.def.orbit;
      if (o.type === 'sat' && b !== charon) {
        satellitePosition(o.fit, jd, b.local, b.localVelocity);
        if (o.barycentric && charon) {
          // Pluto's small moons orbit the Pluto–Charon barycentre: express them relative to Pluto.
          b.local.addScaledVector(charon.local, this.charonRatio);
          b.localVelocity.addScaledVector(charon.localVelocity, this.charonRatio);
        }
      } else if (o.type === 'sat-conic') {
        conicState(o.el, jd, _a, _b);
        toThree(_a.x, _a.y, _a.z, b.local);
        toThree(_b.x, _b.y, _b.z, b.localVelocity);
      }
    }
    // 3. Absolute positions for children (parents are resolved first: all moons orbit primaries).
    for (const b of this.bodies) {
      const p = b.parent;
      if (!p || p === sun) {
        if (p === sun) {
          b.local.copy(b.position);
          b.localVelocity.copy(b.velocity);
        }
        continue;
      }
      b.position.copy(p.position).add(b.local);
      b.velocity.copy(p.velocity).add(b.localVelocity);
    }
    // 4. Orientation.
    for (const b of this.bodies) {
      b.sunDistance = b.position.length();
      this.orient(b, jd);
    }
  }

  private orient(b: SolarBody, jd: number): void {
    const def = b.def;
    if (def.rotation) {
      b.spin = iauOrientation(def.rotation, jd, b.quaternion);
      b.pole.copy(Y_UP).applyQuaternion(b.quaternion);
      return;
    }
    if (def.locked && b.parent && def.orbit.type === 'sat') {
      satelliteNormal(def.orbit.fit, jd, b.pole);
      _c.copy(b.local).negate();
      lockedQuaternion(b.pole, _c, b.quaternion);
      b.spin = 0;
      return;
    }
    // Free rotators without an IAU model: a stable pseudo-random pole, spin from the period.
    const h = hashString(def.id);
    const obl = ((h % 1000) / 1000) * 0.9 + 0.1; // 6°–57° from the orbit normal
    const lon = (((h >>> 10) % 1000) / 1000) * Math.PI * 2;
    // Orbit normal from r × v (fall back to ecliptic north).
    _a.crossVectors(b.local, b.localVelocity);
    if (_a.lengthSq() < 1e-40) _a.set(0, 1, 0);
    _a.normalize();
    _b.set(Math.cos(lon), 0, Math.sin(lon));
    _b.addScaledVector(_a, -_b.dot(_a)).normalize();
    b.pole.copy(_a).multiplyScalar(Math.cos(obl)).addScaledVector(_b, Math.sin(obl)).normalize();
    if (def.id === 'hyperion') {
      // Chaotic tumbling: the spin axis wanders (illustrative, not predictive).
      const t = (jd - 2451545) / 13;
      b.pole.set(Math.sin(t * 0.71) + 0.3, Math.cos(t * 0.37), Math.sin(t * 0.53 + 1)).normalize();
    }
    _q.setFromUnitVectors(Y_UP, b.pole);
    b.quaternion.copy(_q);
    const hours = def.spinHours ?? 24;
    b.spin = ((((jd - 2451545) * 24) / hours) % 1) * Math.PI * 2;
  }

  /** Heliocentric position of a body at another time, without disturbing the model state. */
  positionAt(id: string, jd: number, out: THREE.Vector3): THREE.Vector3 {
    const saved = this.jd;
    const b = this.byId.get(id);
    if (!b) return out.set(0, 0, 0);
    // Cheap paths for heliocentric bodies.
    const o = b.def.orbit;
    if (o.type === 'planet') {
      planetPosition(o.key, jd, _a);
      return toThree(_a.x, _a.y, _a.z, out);
    }
    if ((o.type === 'conic' || o.type === 'state') && b.conic) {
      conicState(b.conic, jd, _a);
      return toThree(_a.x, _a.y, _a.z, out);
    }
    // General path: full update, then restore.
    this.update(jd);
    out.copy(b.position);
    if (isFinite(saved)) this.update(saved);
    return out;
  }

  /**
   * Instantaneous (osculating) orbit about the parent, for drawing orbit lines analytically.
   * Returns false when the body has no meaningful orbit (the Sun).
   */
  orbitGeometry(b: SolarBody, out: OrbitGeometry): boolean {
    const o = b.def.orbit;
    const jd = this.jd;
    if (o.type === 'sun') return false;
    if (o.type === 'planet' || o.type === 'earth' || o.type === 'pluto') {
      const key = o.type === 'planet' ? o.key : o.type === 'earth' ? 'emb' : 'pluto';
      planetElements(key, jd, _el);
      return this.fromClassical(_el.a, _el.e, _el.i, _el.node, _el.peri, _el.M, _el.n, out);
    }
    if (o.type === 'sat') {
      satellitePosition(o.fit, jd, _a, undefined, _geom);
      out.hyperbolic = false;
      out.a = _geom.a;
      out.e = _geom.e;
      out.b = _geom.a * Math.sqrt(1 - _geom.e * _geom.e);
      out.P.copy(_geom.P);
      out.Q.copy(_geom.Q);
      out.anomaly = _geom.E;
      out.period = 360 / o.fit.n;
      return true;
    }
    if (o.type === 'moon') {
      // Osculating ellipse from the ELP state.
      fromThree(b.local, _a);
      fromThree(b.localVelocity, _b);
      const el = stateToConic(_a, _b, jd, MU_EARTH_MOON);
      return this.fromConic(el, jd, out);
    }
    if (o.type === 'sat-conic') return this.fromConic(o.el, jd, out);
    if (b.conic) return this.fromConic(b.conic, jd, out);
    return false;
  }

  private fromClassical(a: number, e: number, i: number, node: number, peri: number, M: number, n: number, out: OrbitGeometry): boolean {
    const cO = Math.cos(node), sO = Math.sin(node);
    const ci = Math.cos(i), si = Math.sin(i);
    const cw = Math.cos(peri), sw = Math.sin(peri);
    toThree(cO * cw - sO * sw * ci, sO * cw + cO * sw * ci, sw * si, out.P);
    toThree(-cO * sw - sO * cw * ci, -sO * sw + cO * cw * ci, cw * si, out.Q);
    out.hyperbolic = false;
    out.a = a;
    out.e = e;
    out.b = a * Math.sqrt(1 - e * e);
    // Eccentric anomaly from M.
    let E = M;
    for (let k = 0; k < 30; k++) {
      const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
      E -= d;
      if (Math.abs(d) < 1e-14) break;
    }
    out.anomaly = E;
    out.period = (2 * Math.PI) / n;
    return true;
  }

  private fromConic(el: ConicElements, jd: number, out: OrbitGeometry): boolean {
    const cO = Math.cos(el.node), sO = Math.sin(el.node);
    const ci = Math.cos(el.i), si = Math.sin(el.i);
    const cw = Math.cos(el.peri), sw = Math.sin(el.peri);
    toThree(cO * cw - sO * sw * ci, sO * cw + cO * sw * ci, sw * si, out.P);
    toThree(-cO * sw - sO * cw * ci, -sO * sw + cO * cw * ci, cw * si, out.Q);
    out.e = el.e;
    const dt = jd - el.tp;
    if (el.e < 1) {
      const a = el.q / (1 - el.e);
      const n = Math.sqrt(el.mu / (a * a * a));
      let M = (n * dt) % (2 * Math.PI);
      if (M > Math.PI) M -= 2 * Math.PI;
      if (M < -Math.PI) M += 2 * Math.PI;
      let E = el.e < 0.8 ? M : Math.sign(M) * Math.PI * 0.5 || 0.1;
      for (let k = 0; k < 60; k++) {
        const d = (E - el.e * Math.sin(E) - M) / (1 - el.e * Math.cos(E));
        E -= d;
        if (Math.abs(d) < 1e-14) break;
      }
      out.hyperbolic = false;
      out.a = a;
      out.b = a * Math.sqrt(1 - el.e * el.e);
      out.anomaly = E;
      out.period = (2 * Math.PI) / n;
    } else {
      const a = el.q / (el.e - 1);
      const n = Math.sqrt(el.mu / (a * a * a));
      const M = n * dt;
      let H = Math.asinh(M / el.e);
      for (let k = 0; k < 80; k++) {
        const d = (el.e * Math.sinh(H) - H - M) / (el.e * Math.cosh(H) - 1);
        H -= d;
        if (Math.abs(d) < 1e-14) break;
      }
      out.hyperbolic = true;
      out.a = a;
      out.b = a * Math.sqrt(el.e * el.e - 1);
      out.anomaly = H;
      out.period = Infinity;
    }
    return true;
  }
}

/** Build a fresh empty OrbitGeometry. */
export const makeOrbitGeometry = (): OrbitGeometry => ({
  hyperbolic: false,
  a: 1,
  b: 1,
  e: 0,
  P: new THREE.Vector3(1, 0, 0),
  Q: new THREE.Vector3(0, 0, -1),
  anomaly: 0,
  period: 365.25,
});
