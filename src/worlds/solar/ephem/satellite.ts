/**
 * Satellite positions from the precessing mean elements fitted in data/moons.ts:
 *   Ω(t) = Ω0 + Ω̇ t,  ϖ(t) = ω0 + ω̇ t,  λ(t) = L0 + n t + Σ libration terms,
 *   M = λ − ϖ, Kepler's equation → true argument of latitude u = ϖ + ν,
 *   r = a(1 − e cos E), placed in the orbit plane (i, Ω) over the local Laplace plane.
 * Angles are measured in the Laplace plane from its ascending node on the ICRF equator, the
 * convention of the JPL SSD mean-element tables. Output: parent-centred, J2000 ecliptic, three.js
 * axes, AU (and AU/day when requested).
 */
import * as THREE from 'three';
import { solveKepler } from '../../../physics/kepler';
import type { FittedSatellite } from '../data/types';
import { DEG, eqToEcl, toThree } from '../frames';

export const SAT_EPOCH = 2461306.5;
const KM_AU = 1 / 149_597_870.7;

interface Frame {
  x: THREE.Vector3;
  y: THREE.Vector3;
  z: THREE.Vector3;
}
const frames = new WeakMap<FittedSatellite, Frame>();

/** Laplace-plane basis (ICRF equatorial): x = node on the ICRF equator, z = pole. */
function laplaceFrame(s: FittedSatellite): Frame {
  let f = frames.get(s);
  if (f) return f;
  const a = s.pole[0] * DEG;
  const d = s.pole[1] * DEG;
  const z = new THREE.Vector3(Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d));
  const x = new THREE.Vector3(-Math.sin(a), Math.cos(a), 0);
  const y = new THREE.Vector3().crossVectors(z, x);
  f = { x, y, z };
  frames.set(s, f);
  return f;
}

/** Orbit geometry at a time: everything needed to draw the osculating ellipse. */
export interface SatOrbitGeometry {
  /** Semi-major axis, AU. */
  a: number;
  e: number;
  /** Unit vectors (three.js ecliptic frame): pericentre direction, 90° ahead in the orbit plane, orbit normal. */
  P: THREE.Vector3;
  Q: THREE.Vector3;
  W: THREE.Vector3;
  /** Current eccentric anomaly (rad). */
  E: number;
}

const _v = new THREE.Vector3();

/**
 * Parent-centred position of a fitted satellite at jd (TT). Optionally returns the velocity
 * (AU/day, from the mean motion) and the instantaneous orbit geometry.
 */
export function satellitePosition(
  s: FittedSatellite,
  jd: number,
  out: THREE.Vector3,
  vel?: THREE.Vector3,
  geom?: SatOrbitGeometry,
): THREE.Vector3 {
  const t = jd - SAT_EPOCH;
  let lam = s.L0 + s.n * t;
  let lamRate = s.n;
  if (s.libs) {
    for (const [per, c, sn] of s.libs) {
      const w = (2 * Math.PI) / per;
      lam += c * Math.cos(w * t) + sn * Math.sin(w * t);
      lamRate += (-c * Math.sin(w * t) + sn * Math.cos(w * t)) * w;
    }
  }
  const varpi = s.w0 + s.wRate * t;
  const node = (s.node0 + s.nodeRate * t) * DEG;
  const inc = s.i * DEG;
  const e = s.e;
  const M = (lam - varpi) * DEG;
  const E = solveKepler(M, e);
  const cE = Math.cos(E), sE = Math.sin(E);
  const a = s.aKm * KM_AU;
  const sq = Math.sqrt(1 - e * e);
  // Perifocal coordinates, then rotate by ϖ (argument of pericentre from the node), i, Ω.
  const xp = a * (cE - e);
  const yp = a * sq * sE;
  const w = varpi * DEG;
  const cO = Math.cos(node), sO = Math.sin(node);
  const ci = Math.cos(inc), si = Math.sin(inc);
  const cw = Math.cos(w), sw = Math.sin(w);
  const r11 = cO * cw - sO * sw * ci, r12 = -cO * sw - sO * cw * ci;
  const r21 = sO * cw + cO * sw * ci, r22 = -sO * sw + cO * cw * ci;
  const r31 = sw * si, r32 = cw * si;
  const f = laplaceFrame(s);
  const toEcl = (lx: number, ly: number, lz: number, o: THREE.Vector3) => {
    const ex = f.x.x * lx + f.y.x * ly + f.z.x * lz;
    const ey = f.x.y * lx + f.y.y * ly + f.z.y * lz;
    const ez = f.x.z * lx + f.y.z * ly + f.z.z * lz;
    eqToEcl(ex, ey, ez, o);
    return toThree(o.x, o.y, o.z, o);
  };
  toEcl(r11 * xp + r12 * yp, r21 * xp + r22 * yp, r31 * xp + r32 * yp, out);
  if (vel) {
    const n = lamRate * DEG; // rad/day
    const k = (a * n) / (1 - e * cE);
    const vx = -k * sE, vy = k * sq * cE;
    toEcl(r11 * vx + r12 * vy, r21 * vx + r22 * vy, r31 * vx + r32 * vy, vel);
  }
  if (geom) {
    geom.a = a;
    geom.e = e;
    geom.E = E;
    toEcl(r11, r21, r31, geom.P);
    toEcl(r12, r22, r32, geom.Q);
    geom.W.crossVectors(geom.P, geom.Q).normalize();
  }
  return out;
}

/** Orbit normal of a fitted satellite (three.js frame) — the pole used for synchronous rotation. */
export function satelliteNormal(s: FittedSatellite, jd: number, out: THREE.Vector3): THREE.Vector3 {
  const t = jd - SAT_EPOCH;
  const node = (s.node0 + s.nodeRate * t) * DEG;
  const inc = s.i * DEG;
  const f = laplaceFrame(s);
  const lx = Math.sin(inc) * Math.sin(node);
  const ly = -Math.sin(inc) * Math.cos(node);
  const lz = Math.cos(inc);
  _v.set(f.x.x * lx + f.y.x * ly + f.z.x * lz, f.x.y * lx + f.y.y * ly + f.z.y * lz, f.x.z * lx + f.y.z * ly + f.z.z * lz);
  eqToEcl(_v.x, _v.y, _v.z, out);
  return toThree(out.x, out.y, out.z, out);
}

/** Sidereal orbital period in days implied by the fitted mean motion. */
export const satellitePeriodDays = (s: FittedSatellite) => 360 / Math.abs(s.n + s.nodeRate * Math.cos(s.i * DEG));
