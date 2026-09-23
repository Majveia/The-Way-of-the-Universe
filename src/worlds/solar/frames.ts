/**
 * Reference frames.
 *
 * Model frame: heliocentric **J2000 mean ecliptic and equinox** (as JPL Horizons "ECLIPTIC / ICRF"),
 * in AU, converted to three.js axes (y up = ecliptic north) with `astroToThree`: (x, y, z) → (x, z, −y).
 * Equatorial (ICRF) ↔ ecliptic uses the IAU 1976 obliquity ε = 84 381.448″, the same as Horizons.
 */
import * as THREE from 'three';
import { OBLIQUITY_J2000 } from '../../physics/constants';

export const DEG = Math.PI / 180;
const CE = Math.cos(OBLIQUITY_J2000);
const SE = Math.sin(OBLIQUITY_J2000);

/** ICRF equatorial vector → J2000 ecliptic (astro axes). In-place safe. */
export function eqToEcl(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(x, CE * y + SE * z, -SE * y + CE * z);
}
/** J2000 ecliptic (astro axes) → ICRF equatorial. */
export function eclToEq(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(x, CE * y - SE * z, SE * y + CE * z);
}
/** Astronomical (z-up) → three.js (y-up). */
export function toThree(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(x, z, -y);
}
/** three.js (y-up) → astronomical (z-up). */
export function fromThree(v: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  return out.set(v.x, -v.z, v.y);
}

/** Unit vector of an ICRF direction (RA, Dec in degrees), in the three.js ecliptic frame. */
export function raDecToThree(raDeg: number, decDeg: number, out: THREE.Vector3): THREE.Vector3 {
  const a = raDeg * DEG;
  const d = decDeg * DEG;
  const cd = Math.cos(d);
  eqToEcl(cd * Math.cos(a), cd * Math.sin(a), Math.sin(d), out);
  return toThree(out.x, out.y, out.z, out);
}

/** Unit vector from ecliptic longitude/latitude (degrees), three.js frame. */
export function lonLatToThree(lonDeg: number, latDeg: number, out: THREE.Vector3): THREE.Vector3 {
  const l = lonDeg * DEG;
  const b = latDeg * DEG;
  const cb = Math.cos(b);
  return toThree(cb * Math.cos(l), cb * Math.sin(l), Math.sin(b), out);
}

const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();

/**
 * Body-fixed orientation from IAU/WGCCRE rotational elements (Archinal et al. 2018): pole (α0, δ0) and
 * prime-meridian angle W. Returns the quaternion of the body's *base* frame (W = 0) in three.js
 * axes, with local +Y = north pole and local +X = the node Q of the body equator on the ICRF equator.
 * Spinning the base frame by +W about local +Y (three.js right-hand rotation) puts the prime meridian
 * at Q·cos W + (P×Q)·sin W, exactly the IAU definition — so a PlanetView uses `setRotation(W)`.
 */
export function iauBaseQuaternion(alpha0Deg: number, delta0Deg: number, out: THREE.Quaternion): THREE.Quaternion {
  const a = alpha0Deg * DEG;
  const d = delta0Deg * DEG;
  // Pole and node in ICRF equatorial coordinates.
  const cd = Math.cos(d);
  eqToEcl(cd * Math.cos(a), cd * Math.sin(a), Math.sin(d), _p);
  toThree(_p.x, _p.y, _p.z, _p);
  eqToEcl(-Math.sin(a), Math.cos(a), 0, _q);
  toThree(_q.x, _q.y, _q.z, _q);
  _z.crossVectors(_q, _p);
  _m.makeBasis(_q, _p, _z);
  return out.setFromRotationMatrix(_m);
}

/**
 * Orientation of a synchronously rotating moon: local +Y along `pole`, local +X toward `toParent`
 * (the sub-planet meridian, i.e. the IAU prime meridian of most tidally locked satellites).
 */
export function lockedQuaternion(pole: THREE.Vector3, toParent: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  _p.copy(pole).normalize();
  _q.copy(toParent).addScaledVector(_p, -toParent.dot(_p));
  if (_q.lengthSq() < 1e-30) _q.set(1, 0, 0).addScaledVector(_p, -_p.x);
  _q.normalize();
  _z.crossVectors(_q, _p);
  _m.makeBasis(_q, _p, _z);
  return out.setFromRotationMatrix(_m);
}

/**
 * Precession of ecliptic coordinates between two epochs (Meeus, Astronomical Algorithms, eq. 21.5,
 * Lieske et al. 1977 constants). Angles in degrees; jd0 → jd.
 */
export function precessEcliptic(lonDeg: number, latDeg: number, jd0: number, jd: number): { lon: number; lat: number } {
  const T = (jd0 - 2451545.0) / 36525;
  const t = (jd - jd0) / 36525;
  const AS = 1 / 3600;
  const eta = ((47.0029 - 0.06603 * T + 0.000598 * T * T) * t + (-0.03302 + 0.000598 * T) * t * t + 0.00006 * t ** 3) * AS;
  const Pi = 174.876384 + (3289.4789 * T + 0.60622 * T * T) * AS - (869.8089 + 0.50491 * T) * t * AS + 0.03536 * t * t * AS;
  const p = ((5029.0966 + 2.22226 * T - 0.000042 * T * T) * t + (1.11113 - 0.000042 * T) * t * t - 0.000006 * t ** 3) * AS;
  const l0 = lonDeg * DEG;
  const b0 = latDeg * DEG;
  const e = eta * DEG;
  const P = Pi * DEG;
  const A = Math.cos(e) * Math.cos(b0) * Math.sin(P - l0) - Math.sin(e) * Math.sin(b0);
  const B = Math.cos(b0) * Math.cos(P - l0);
  const C = Math.cos(e) * Math.sin(b0) + Math.sin(e) * Math.cos(b0) * Math.sin(P - l0);
  let lon = (p + Pi) - Math.atan2(A, B) / DEG;
  lon = ((lon % 360) + 360) % 360;
  return { lon, lat: Math.asin(Math.max(-1, Math.min(1, C))) / DEG };
}

/** Normalise degrees to [0, 360). */
export const norm360 = (x: number) => ((x % 360) + 360) % 360;
