import * as THREE from 'three';
import { DAY, J2000_JD, UNIX_EPOCH_JD } from './constants';

/** Classical orbital elements. Angles in radians; `a` in any length unit (µ must match). */
export interface OrbitalElements {
  /** Semi-major axis (negative for hyperbolic orbits). */
  a: number;
  e: number;
  /** Inclination. */
  i: number;
  /** Longitude of the ascending node Ω. */
  node: number;
  /** Argument of periapsis ω. */
  peri: number;
  /** Mean anomaly at epoch. */
  M0: number;
  /** Epoch, in the same time unit as `t` passed to orbitState (seconds by convention). */
  epoch: number;
}

/** Solve Kepler's equation M = E − e sin E for elliptical orbits (e < 1). */
export function solveKepler(M: number, e: number): number {
  M = M % (2 * Math.PI);
  if (M > Math.PI) M -= 2 * Math.PI;
  else if (M < -Math.PI) M += 2 * Math.PI;
  let E = e < 0.8 ? M : M > 0 ? Math.PI : -Math.PI;
  for (let k = 0; k < 50; k++) {
    const f = E - e * Math.sin(E) - M;
    const fp = 1 - e * Math.cos(E);
    const d = f / fp;
    E -= d;
    if (Math.abs(d) < 1e-13) break;
  }
  return E;
}

/** Solve M = e sinh H − H for hyperbolic orbits (e > 1). */
export function solveKeplerHyperbolic(M: number, e: number): number {
  let H = Math.asinh(M / e);
  for (let k = 0; k < 60; k++) {
    const f = e * Math.sinh(H) - H - M;
    const d = f / (e * Math.cosh(H) - 1);
    H -= d;
    if (Math.abs(d) < 1e-13) break;
  }
  return H;
}

/** Mean motion n = √(µ/|a|³) (rad per time unit of µ). */
export const meanMotion = (a: number, mu: number) => Math.sqrt(mu / Math.abs(a * a * a));
/** Orbital period 2π√(a³/µ). */
export const orbitalPeriod = (a: number, mu: number) => (2 * Math.PI) / meanMotion(a, mu);

/**
 * Position (and optionally velocity) at time t in the reference frame of the elements
 * (x → reference direction, z → reference pole). µ in length³/time² of the same units.
 */
export function orbitState(
  el: OrbitalElements,
  t: number,
  mu: number,
  outPos: THREE.Vector3,
  outVel?: THREE.Vector3,
): THREE.Vector3 {
  const { a, e } = el;
  const n = meanMotion(a, mu);
  const M = el.M0 + n * (t - el.epoch);
  let x: number, y: number, vx: number, vy: number;
  if (e < 1) {
    const E = solveKepler(M, e);
    const cE = Math.cos(E);
    const sE = Math.sin(E);
    const b = a * Math.sqrt(1 - e * e);
    x = a * (cE - e);
    y = b * sE;
    const r = a * (1 - e * cE);
    const f = (n * a) / r;
    vx = -f * a * sE;
    vy = f * b * cE;
  } else {
    const H = solveKeplerHyperbolic(M, e);
    const cH = Math.cosh(H);
    const sH = Math.sinh(H);
    const aa = Math.abs(a);
    const b = aa * Math.sqrt(e * e - 1);
    x = aa * (e - cH);
    y = b * sH;
    const r = aa * (e * cH - 1);
    const f = (n * aa) / r;
    vx = -f * aa * sH;
    vy = f * b * cH;
  }
  // Rotate perifocal → reference frame: Rz(Ω) Rx(i) Rz(ω)
  const cO = Math.cos(el.node), sO = Math.sin(el.node);
  const ci = Math.cos(el.i), si = Math.sin(el.i);
  const cw = Math.cos(el.peri), sw = Math.sin(el.peri);
  const r11 = cO * cw - sO * sw * ci, r12 = -cO * sw - sO * cw * ci;
  const r21 = sO * cw + cO * sw * ci, r22 = -sO * sw + cO * cw * ci;
  const r31 = sw * si, r32 = cw * si;
  outPos.set(r11 * x + r12 * y, r21 * x + r22 * y, r31 * x + r32 * y);
  if (outVel) outVel.set(r11 * vx + r12 * vy, r21 * vx + r22 * vy, r31 * vx + r32 * vy);
  return outPos;
}

/** Sample an orbit as a closed polyline (for orbit lines). */
export function orbitPolyline(el: OrbitalElements, mu: number, segments = 256): Float32Array {
  const out = new Float32Array((segments + 1) * 3);
  const p = new THREE.Vector3();
  const n = meanMotion(el.a, mu);
  // Sample uniformly in eccentric anomaly for even spacing along highly eccentric orbits.
  for (let k = 0; k <= segments; k++) {
    const E = (k / segments) * 2 * Math.PI;
    const M = E - el.e * Math.sin(E);
    const t = el.epoch + (M - el.M0) / n;
    orbitState(el, t, mu, p);
    out[k * 3] = p.x;
    out[k * 3 + 1] = p.y;
    out[k * 3 + 2] = p.z;
  }
  return out;
}

/** Julian Date for a JS Date (UTC; the TT−UTC ≈ 69 s offset is ignored). */
export const dateToJD = (d: Date) => d.getTime() / 86_400_000 + UNIX_EPOCH_JD;
export const jdToDate = (jd: number) => new Date((jd - UNIX_EPOCH_JD) * 86_400_000);
/** Seconds since J2000.0 for a JD. */
export const jdToJ2000Seconds = (jd: number) => (jd - J2000_JD) * DAY;
export const j2000SecondsToJD = (s: number) => J2000_JD + s / DAY;

/**
 * Astronomy frame → three.js frame. Astronomical frames are z-up (ecliptic/equatorial
 * north); the project renders y-up. Mapping (x, y, z)_astro → (x, z, −y)_three keeps
 * right-handedness. Apply to every ephemeris position before rendering.
 */
export function astroToThree(v: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(v.x, v.z, -v.y);
}
export function threeToAstro(v: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(v.x, -v.z, v.y);
}
