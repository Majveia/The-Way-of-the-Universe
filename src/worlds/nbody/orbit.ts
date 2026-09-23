import { G_SIM } from './units';

/**
 * Two-body encounter geometry.
 *
 * The galaxies start on the nominal Keplerian conic of two point masses M₁ + M₂ with pericentre
 * r_p and eccentricity e (e = 1 parabolic — the classic choice for first encounters, since
 * galaxies fall in from large distances nearly at escape speed; Toomre & Toomre 1972). Extended
 * halos make the real pericentre somewhat larger, and dynamical friction then shrinks the orbit;
 * the simulation reports what actually happens.
 *
 * Orbit frame: x toward pericentre, z along the orbital angular momentum.
 */
export interface OrbitSpec {
  /** Pericentre distance (kpc). */
  rp: number;
  /** Eccentricity: < 1 bound, 1 parabolic, > 1 hyperbolic. */
  e: number;
  /** Initial separation (kpc). */
  r0: number;
}

export interface RelativeState {
  /** Separation vector r₂ − r₁ and relative velocity v₂ − v₁ (orbit frame). */
  r: [number, number, number];
  v: [number, number, number];
  /** True anomaly at the start (rad, negative = approaching). */
  f0: number;
  /** Time until pericentre on the Keplerian conic (Myr). */
  tPeri: number;
}

export function keplerStart(m1: number, m2: number, o: OrbitSpec): RelativeState {
  const mu = G_SIM * (m1 + m2);
  const e = Math.max(0, o.e);
  const p = o.rp * (1 + e);
  let r0 = o.r0;
  if (e < 1) r0 = Math.min(r0, 0.999 * (p / (1 - e))); // cannot start beyond apocentre
  r0 = Math.max(r0, o.rp * 1.0001);
  const cosf = Math.max(-1, Math.min(1, (p / r0 - 1) / Math.max(e, 1e-9)));
  const f0 = e < 1e-9 ? -Math.PI / 2 : -Math.acos(cosf);
  const h = Math.sqrt(mu / p);
  const vr = h * e * Math.sin(f0);
  const vt = h * (1 + e * Math.cos(f0));
  const c = Math.cos(f0), s = Math.sin(f0);
  const rr = p / (1 + e * c);
  return {
    r: [rr * c, rr * s, 0],
    v: [vr * c - vt * s, vr * s + vt * c, 0],
    f0,
    tPeri: timeToPericentre(mu, o.rp, e, f0),
  };
}

/** Time from true anomaly f (< 0) to pericentre on a conic (Myr). */
export function timeToPericentre(mu: number, rp: number, e: number, f: number): number {
  if (Math.abs(e - 1) < 1e-6) {
    // Barker's equation for the parabola.
    const p = 2 * rp;
    const D = Math.tan(f / 2);
    return -0.5 * Math.sqrt((p * p * p) / mu) * (D + (D * D * D) / 3);
  }
  if (e < 1) {
    const a = rp / (1 - e);
    const E = 2 * Math.atan(Math.sqrt((1 - e) / (1 + e)) * Math.tan(f / 2));
    const M = E - e * Math.sin(E);
    return -M / Math.sqrt(mu / (a * a * a));
  }
  const a = rp / (e - 1);
  const H = 2 * Math.atanh(Math.sqrt((e - 1) / (e + 1)) * Math.tan(f / 2));
  const M = e * Math.sinh(H) - H;
  return -M / Math.sqrt(mu / (a * a * a));
}

/**
 * Disk orientation from Toomre & Toomre (1972) angles: inclination i of the disk to the orbital
 * plane (0° = prograde, spin parallel to the orbital angular momentum; 180° = retrograde) and
 * argument ω of the line of nodes relative to pericentre. Returns the 3×3 rotation (row-major)
 * taking the galaxy's local frame (spin +z) into the orbit frame.
 */
export function diskRotation(iDeg: number, wDeg: number): number[] {
  const i = (iDeg * Math.PI) / 180;
  const w = (-wDeg * Math.PI) / 180;
  const ci = Math.cos(i), si = Math.sin(i), cw = Math.cos(w), sw = Math.sin(w);
  // R = Rz(w) · Rx(i)
  return [cw, -sw * ci, sw * si, sw, cw * ci, -cw * si, 0, si, ci];
}

export const rotate = (R: number[], x: number, y: number, z: number, out: number[], o = 0): void => {
  out[o] = R[0] * x + R[1] * y + R[2] * z;
  out[o + 1] = R[3] * x + R[4] * y + R[5] * z;
  out[o + 2] = R[6] * x + R[7] * y + R[8] * z;
};
