/**
 * Pure helpers for the Earth experience (unit-tested in tests/planets.test.ts).
 */
import * as THREE from 'three';
import { AU } from '../../physics/constants';
import { radecToVector, sunState, msToJD, VOYAGER1_PALE_BLUE_DOT } from '../../physics/planets-ephemeris';

export const R_EARTH_KM = 6371;
/** 1 AU in Earth radii. */
export const AU_RE = AU / 1e3 / R_EARTH_KM;

export const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Pale-Blue-Dot progress (0 near the Earth → 1 at Voyager's 40 AU) from camera distance (R⊕). */
export const pbdProgress = (d: number) => smooth(Math.log(300), Math.log(9e5), Math.log(Math.max(d, 1)));

/** Angular size of one pixel of Voyager's narrow-angle camera, degrees (0.424° over 800 px). */
export const NAC_PIXEL_DEG = 0.424 / 800;

/**
 * Field of view (deg) across the narrow dimension of a viewport `viewportPx` CSS pixels wide: 34° near
 * the Earth, narrowing as the camera recedes until one CSS pixel spans one pixel of Voyager's
 * narrow-angle camera (0.424° / 800 px) — so the Earth ends as the same 0.12-pixel dot on any screen.
 */
export function fovForDistance(d: number, viewportPx = 720): number {
  const t = pbdProgress(d);
  const far = NAC_PIXEL_DEG * Math.max(viewportPx, 1);
  return Math.exp(Math.log(34) + (Math.log(far) - Math.log(34)) * smooth(0.25, 1, t));
}

/**
 * Geocentric position of Voyager 1 at the Pale Blue Dot exposure, astronomical equatorial frame
 * (x → equinox, z → north), in AU: Sun (geocentric) + 40.47 AU along Voyager's heliocentric direction.
 */
export function voyagerGeocentricAU(): { x: number; y: number; z: number } {
  const V = VOYAGER1_PALE_BLUE_DOT;
  const s = sunState(msToJD(V.utc));
  const sun = radecToVector(s.ra, s.dec, { x: 0, y: 0, z: 0 });
  const dir = radecToVector(V.ra, V.dec, { x: 0, y: 0, z: 0 });
  return {
    x: sun.x * s.distanceAU + dir.x * V.distanceAU,
    y: sun.y * s.distanceAU + dir.y * V.distanceAU,
    z: sun.z * s.distanceAU + dir.z * V.distanceAU,
  };
}

/** Angle Sun–Voyager–Earth (rad) at the Pale Blue Dot exposure. */
export function voyagerSunEarthAngle(): number {
  const v = voyagerGeocentricAU();
  const V = VOYAGER1_PALE_BLUE_DOT;
  const s = sunState(msToJD(V.utc));
  const sun = radecToVector(s.ra, s.dec, { x: 0, y: 0, z: 0 });
  // Vectors from Voyager to the Earth (−v) and to the Sun (sun·d − v).
  const ex = -v.x, ey = -v.y, ez = -v.z;
  const sx = sun.x * s.distanceAU - v.x, sy = sun.y * s.distanceAU - v.y, sz = sun.z * s.distanceAU - v.z;
  const c = (ex * sx + ey * sy + ez * sz) / (Math.hypot(ex, ey, ez) * Math.hypot(sx, sy, sz));
  return Math.acos(Math.max(-1, Math.min(1, c)));
}

/** Apparent diameter of a sphere of radius r at distance d, in pixels of a camera with angular pixel p (rad). */
export const apparentPixels = (r: number, d: number, pixelAngle: number) => (2 * Math.asin(Math.min(1, r / d))) / pixelAngle;

const mx = new THREE.Vector3();
const my = new THREE.Vector3();
const mz = new THREE.Vector3();
const mm = new THREE.Matrix4();

/**
 * Orientation of the tidally locked Moon (three.js frame): body +x (lunar longitude 0, the near side's
 * centre) toward the Earth, body +y (north pole) along the ecliptic pole (0, cos ε, sin ε) — the lunar
 * equator is within 1.5° of the ecliptic (Cassini's laws); libration is not modelled.
 */
export function moonOrientation(moonPos: THREE.Vector3, obliquity: number, out: THREE.Quaternion): THREE.Quaternion {
  my.set(0, Math.cos(obliquity), Math.sin(obliquity));
  mx.copy(moonPos).negate().normalize();
  mx.addScaledVector(my, -mx.dot(my)).normalize();
  mz.crossVectors(mx, my);
  return out.setFromRotationMatrix(mm.makeBasis(mx, my, mz));
}
