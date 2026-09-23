/**
 * Two-body motion for every conic (ellipse, parabola, hyperbola) with the universal-variable
 * formulation (Bate, Mueller & White 1971 §4.3; Vallado, "Fundamentals of Astrodynamics", alg. 8),
 * plus classical-element helpers. Units: AU, days; µ in AU³/day².
 */
import * as THREE from 'three';
import { solveKepler } from '../../../physics/kepler';

/** Gaussian gravitational constant k (IAU 1976) and the Sun's µ = k² in AU³/day². */
export const GAUSS_K = 0.01720209895;
export const MU_SUN = GAUSS_K * GAUSS_K;

/** Stumpff functions C(z), S(z). */
export function stumpffC(z: number): number {
  if (z > 1e-6) return (1 - Math.cos(Math.sqrt(z))) / z;
  if (z < -1e-6) return (Math.cosh(Math.sqrt(-z)) - 1) / -z;
  return 1 / 2 - z / 24 + (z * z) / 720;
}
export function stumpffS(z: number): number {
  if (z > 1e-6) {
    const s = Math.sqrt(z);
    return (s - Math.sin(s)) / (s * s * s);
  }
  if (z < -1e-6) {
    const s = Math.sqrt(-z);
    return (Math.sinh(s) - s) / (s * s * s);
  }
  return 1 / 6 - z / 120 + (z * z) / 5040;
}

/**
 * Propagate a state (r0, v0) by dt under µ with universal variables. Writes r (and v) — both may
 * alias nothing else. Robust for e from 0 to ≫ 1 and for |dt| of many periods (elliptic dt is
 * reduced modulo the period first).
 */
export function propagateUniversal(
  r0: THREE.Vector3,
  v0: THREE.Vector3,
  dt: number,
  mu: number,
  outR: THREE.Vector3,
  outV?: THREE.Vector3,
): THREE.Vector3 {
  const r0n = r0.length();
  const v0sq = v0.lengthSq();
  const rv = r0.dot(v0);
  const sqmu = Math.sqrt(mu);
  const alpha = 2 / r0n - v0sq / mu; // 1/a
  let t = dt;
  if (alpha > 1e-12) {
    const period = (2 * Math.PI) / (sqmu * Math.pow(alpha, 1.5));
    t = dt - period * Math.round(dt / period);
  }
  // Initial guess (Vallado).
  let chi: number;
  if (alpha > 1e-12) chi = sqmu * t * alpha;
  else if (alpha < -1e-12) {
    const a = 1 / alpha;
    const s = Math.sign(t) || 1;
    const arg = (-2 * mu * alpha * t) / (rv + s * Math.sqrt(-mu * a) * (1 - r0n * alpha));
    chi = arg > 0 ? s * Math.sqrt(-a) * Math.log(arg) : s * Math.sqrt(Math.abs(t)) * 0.1;
  } else {
    // Near-parabolic: Barker-like guess.
    const h = new THREE.Vector3().crossVectors(r0, v0);
    const p = h.lengthSq() / mu;
    const s = 0.5 * Math.atan(1 / (3 * Math.sqrt(mu / (p * p * p)) * t));
    const w = Math.atan(Math.cbrt(Math.tan(s)));
    chi = (Math.sqrt(p) * 2) / Math.tan(2 * w);
  }
  if (!isFinite(chi)) chi = sqmu * t / Math.max(r0n, 1e-9);
  let r = r0n;
  let C = 0.5;
  let S = 1 / 6;
  let z = 0;
  for (let k = 0; k < 60; k++) {
    z = chi * chi * alpha;
    C = stumpffC(z);
    S = stumpffS(z);
    const chi2 = chi * chi;
    r = chi2 * C + (rv / sqmu) * chi * (1 - z * S) + r0n * (1 - z * C);
    const f = (chi2 * chi * S + (rv / sqmu) * chi2 * C + r0n * chi * (1 - z * S)) - sqmu * t;
    const d = f / r;
    chi -= d;
    if (Math.abs(d) < 1e-13 * Math.max(1, Math.abs(chi))) break;
  }
  const chi2 = chi * chi;
  z = chi2 * alpha;
  C = stumpffC(z);
  S = stumpffS(z);
  const fL = 1 - (chi2 / r0n) * C;
  const g = t - (chi2 * chi / sqmu) * S;
  const rx = fL * r0.x + g * v0.x;
  const ry = fL * r0.y + g * v0.y;
  const rz = fL * r0.z + g * v0.z;
  if (outV) {
    const rn = Math.sqrt(rx * rx + ry * ry + rz * rz);
    const fd = (sqmu / (rn * r0n)) * (z * S - 1) * chi;
    const gd = 1 - (chi2 / rn) * C;
    outV.set(fd * r0.x + gd * v0.x, fd * r0.y + gd * v0.y, fd * r0.z + gd * v0.z);
  }
  return outR.set(rx, ry, rz);
}

/** Classical elements of a heliocentric conic, angles in radians, times in JD (TT). */
export interface ConicElements {
  /** Perihelion distance (AU). */
  q: number;
  e: number;
  i: number;
  node: number;
  peri: number;
  /** Time of perihelion passage (JD TT). */
  tp: number;
  /** Gravitational parameter, AU³/day². */
  mu: number;
}

/** Perifocal → reference-frame rotation rows for (Ω, i, ω). */
function rot(el: { node: number; i: number; peri: number }): [number, number, number, number, number, number] {
  const cO = Math.cos(el.node), sO = Math.sin(el.node);
  const ci = Math.cos(el.i), si = Math.sin(el.i);
  const cw = Math.cos(el.peri), sw = Math.sin(el.peri);
  return [cO * cw - sO * sw * ci, -cO * sw - sO * cw * ci, sO * cw + cO * sw * ci, -sO * sw + cO * cw * ci, sw * si, cw * si];
}

/** Perihelion state of a conic (position, velocity) in the reference frame (astro axes). */
export function periapsisState(el: ConicElements, r: THREE.Vector3, v: THREE.Vector3): void {
  const [r11, r12, r21, r22, r31, r32] = rot(el);
  const vp = Math.sqrt((el.mu * (1 + el.e)) / el.q);
  r.set(r11 * el.q, r21 * el.q, r31 * el.q);
  v.set(r12 * vp, r22 * vp, r32 * vp);
}

const _r0 = new THREE.Vector3();
const _v0 = new THREE.Vector3();

/**
 * State of a conic at jd, astro axes (AU, AU/day). Elliptic orbits (e < 0.97) use Kepler's
 * equation directly; the rest use universal variables from perihelion.
 */
export function conicState(el: ConicElements, jd: number, out: THREE.Vector3, vel?: THREE.Vector3): THREE.Vector3 {
  const dt = jd - el.tp;
  if (el.e < 0.97) {
    const a = el.q / (1 - el.e);
    const n = Math.sqrt(el.mu / (a * a * a));
    const E = solveKepler(n * dt, el.e);
    const cE = Math.cos(E), sE = Math.sin(E);
    const sq = Math.sqrt(1 - el.e * el.e);
    const xp = a * (cE - el.e);
    const yp = a * sq * sE;
    const [r11, r12, r21, r22, r31, r32] = rot(el);
    out.set(r11 * xp + r12 * yp, r21 * xp + r22 * yp, r31 * xp + r32 * yp);
    if (vel) {
      const k = (a * n) / (1 - el.e * cE);
      const vx = -k * sE, vy = k * sq * cE;
      vel.set(r11 * vx + r12 * vy, r21 * vx + r22 * vy, r31 * vx + r32 * vy);
    }
    return out;
  }
  periapsisState(el, _r0, _v0);
  return propagateUniversal(_r0, _v0, dt, el.mu, out, vel);
}

/** Classical elements from a state vector (astro axes). Returns tp relative to `jd`. */
export function stateToConic(r: THREE.Vector3, v: THREE.Vector3, jd: number, mu: number): ConicElements {
  const h = new THREE.Vector3().crossVectors(r, v);
  const rn = r.length();
  const evec = new THREE.Vector3().crossVectors(v, h).multiplyScalar(1 / mu).addScaledVector(r, -1 / rn);
  const e = evec.length();
  const hn = h.length();
  const i = Math.acos(Math.max(-1, Math.min(1, h.z / hn)));
  const nvec = new THREE.Vector3(-h.y, h.x, 0);
  const nn = nvec.length();
  let node = nn > 1e-14 ? Math.atan2(nvec.y, nvec.x) : 0;
  if (node < 0) node += 2 * Math.PI;
  let peri: number;
  if (nn > 1e-14 && e > 1e-12) {
    peri = Math.acos(Math.max(-1, Math.min(1, nvec.dot(evec) / (nn * e))));
    if (evec.z < 0) peri = 2 * Math.PI - peri;
  } else peri = e > 1e-12 ? Math.atan2(evec.y, evec.x) : 0;
  const p = (hn * hn) / mu;
  const q = p / (1 + e);
  // True anomaly → time since perihelion.
  let nu = e > 1e-12 ? Math.acos(Math.max(-1, Math.min(1, evec.dot(r) / (e * rn)))) : 0;
  if (r.dot(v) < 0) nu = -nu;
  let dtp: number;
  if (e < 1 - 1e-9) {
    const a = q / (1 - e);
    const E = 2 * Math.atan(Math.sqrt((1 - e) / (1 + e)) * Math.tan(nu / 2));
    const M = E - e * Math.sin(E);
    dtp = M / Math.sqrt(mu / (a * a * a));
  } else if (e > 1 + 1e-9) {
    const a = q / (1 - e); // negative
    const H = 2 * Math.atanh(Math.sqrt((e - 1) / (e + 1)) * Math.tan(nu / 2));
    const M = e * Math.sinh(H) - H;
    dtp = M / Math.sqrt(mu / (-a * a * a));
  } else {
    const D = Math.tan(nu / 2);
    dtp = (D + (D * D * D) / 3) * Math.sqrt((2 * q * q * q) / mu);
  }
  return { q, e, i, node, peri, tp: jd - dtp, mu };
}

/** Orbital period (days) of an elliptic conic, Infinity otherwise. */
export function conicPeriod(el: ConicElements): number {
  if (el.e >= 1) return Infinity;
  const a = el.q / (1 - el.e);
  return 2 * Math.PI * Math.sqrt((a * a * a) / el.mu);
}
