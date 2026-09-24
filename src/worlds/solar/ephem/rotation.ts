/**
 * Body orientation from IAU/WGCCRE rotational elements (Archinal et al. 2018): pole (α0, δ0)
 * with secular rates, prime meridian W(d). Includes Neptune's pole nutation and the Moon's
 * physical libration series (13 arguments E1…E13).
 */
import type * as THREE from 'three';
import type { RotationModel } from '../data/types';
import { DEG, iauBaseQuaternion } from '../frames';

export interface Orientation {
  /** Pole right ascension / declination (ICRF, degrees). */
  ra: number;
  dec: number;
  /** Prime meridian angle (degrees, unwrapped). */
  W: number;
}

/** Evaluate an IAU rotation model at jd (TDB). */
export function iauRotation(m: RotationModel, jd: number, out: Orientation = { ra: 0, dec: 0, W: 0 }): Orientation {
  const d = jd - 2451545.0;
  const T = d / 36525;
  let ra = m.ra + (m.raRate ?? 0) * T;
  let dec = m.dec + (m.decRate ?? 0) * T;
  let W = m.W0 + m.Wd * d;
  if (m.model === 'neptune') {
    const N = (357.85 + 52.316 * T) * DEG;
    ra += 0.7 * Math.sin(N);
    dec -= 0.51 * Math.cos(N);
    W -= 0.48 * Math.sin(N);
  } else if (m.model === 'moon') {
    const E = (k: number, a: number, b: number) => (a + b * d) * DEG * k;
    const E1 = E(1, 125.045, -0.0529921), E2 = E(1, 250.089, -0.1059842), E3 = E(1, 260.008, 13.0120009);
    const E4 = E(1, 176.625, 13.3407154), E5 = E(1, 357.529, 0.9856003), E6 = E(1, 311.589, 26.4057084);
    const E7 = E(1, 134.963, 13.064993), E8 = E(1, 276.617, 0.3287146), E9 = E(1, 34.226, 1.7484877);
    const E10 = E(1, 15.134, -0.1589763), E11 = E(1, 119.743, 0.0036096), E12 = E(1, 239.961, 0.1643573);
    const E13 = E(1, 25.053, 12.9590088);
    ra += -3.8787 * Math.sin(E1) - 0.1204 * Math.sin(E2) + 0.07 * Math.sin(E3) - 0.0172 * Math.sin(E4) + 0.0072 * Math.sin(E6)
      - 0.0052 * Math.sin(E10) + 0.0043 * Math.sin(E13);
    dec += 1.5419 * Math.cos(E1) + 0.0239 * Math.cos(E2) - 0.0278 * Math.cos(E3) + 0.0068 * Math.cos(E4) - 0.0029 * Math.cos(E6)
      + 0.0009 * Math.cos(E7) + 0.0008 * Math.cos(E10) - 0.0009 * Math.cos(E13);
    W += 3.561 * Math.sin(E1) + 0.1208 * Math.sin(E2) - 0.0642 * Math.sin(E3) + 0.0158 * Math.sin(E4) + 0.0252 * Math.sin(E5)
      - 0.0066 * Math.sin(E6) - 0.0047 * Math.sin(E7) - 0.0046 * Math.sin(E8) + 0.0028 * Math.sin(E9) + 0.0052 * Math.sin(E10)
      + 0.004 * Math.sin(E11) + 0.0019 * Math.sin(E12) - 0.0044 * Math.sin(E13) - 1.4e-12 * d * d;
  }
  out.ra = ra;
  out.dec = dec;
  out.W = W;
  return out;
}

const _o: Orientation = { ra: 0, dec: 0, W: 0 };

/**
 * Base quaternion (local +Y = north pole, local +X = node Q) and spin angle W in radians, so that
 * `object.quaternion = base` and `planetView.setRotation(W)` reproduce the IAU orientation.
 */
export function iauOrientation(m: RotationModel, jd: number, outBase: THREE.Quaternion): number {
  iauRotation(m, jd, _o);
  iauBaseQuaternion(_o.ra, _o.dec, outBase);
  const w = _o.W % 360;
  return w * DEG;
}
