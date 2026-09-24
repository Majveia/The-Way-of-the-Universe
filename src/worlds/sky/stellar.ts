import * as THREE from 'three';
import { blackbodyLuminance } from '../../physics/voyage-relativity';
import { solveKepler } from '../../physics/kepler';

/** 1 R☉ in parsecs and in AU (IAU 2015 nominal R☉ = 695 700 km). */
export const R_SUN_PC = 6.957e8 / 3.0856775814913673e16;
export const R_SUN_AU = 6.957e8 / 1.495978707e11;
export const AU_PC = 1.495978707e11 / 3.0856775814913673e16;

/**
 * Stellar radius (R☉) from absolute visual magnitude and effective temperature.
 * Default: a blackbody with the star's V-band luminance, R = √(ℓ_V / s_V(T)), where
 * ℓ_V = 10^(−0.4 (M_V − 4.83)) and s_V is the photopic surface brightness relative to the Sun.
 * This is good to ~5 % for AFGK stars and white dwarfs (Sirius B → 0.009 R☉), but M dwarfs are
 * much fainter in V than a blackbody (TiO bands), so for cool dwarfs we use an empirical fit to
 * interferometric radii (Boyajian et al. 2012; Mann et al. 2015): R ≈ 0.1 + 0.37 e^{−(M_V − 8.9)/2.8}.
 */
export function estimateRadius(absMagV: number, teff: number): number {
  if (teff < 4000 && absMagV > 8.5) return 0.1 + 0.37 * Math.exp(-(absMagV - 8.9) / 2.8);
  const lv = Math.pow(10, -0.4 * (absMagV - 4.83));
  return Math.sqrt(lv / Math.max(blackbodyLuminance(teff), 1e-30));
}

/**
 * Visual binary orbit (Campbell elements of the secondary relative to the primary).
 * a in arcseconds (with the system parallax in mas) or directly in AU.
 */
export interface VisualOrbit {
  /** Period, years. */
  P: number;
  /** Epoch of periastron, decimal year. */
  T: number;
  e: number;
  /** Semi-major axis, AU. */
  aAU: number;
  /** Inclination, ascending node (PA, from north through east), argument of periastron — degrees. */
  i: number;
  node: number;
  omega: number;
  /** Mass fraction of the secondary, M2 / (M1 + M2): the primary sits at −q · r from the barycentre. */
  q: number;
}

/**
 * Relative position of the secondary (AU) in the tangent-plane frame of the system at a decimal year:
 * returns [north, east, recession] components (Thiele–Innes / Heintz 1978 conventions; the third
 * component uses the usual convention that the ascending node is where the companion recedes).
 */
export function visualOrbitOffset(o: VisualOrbit, year: number): [number, number, number] {
  const n = (2 * Math.PI) / o.P;
  const M = n * (year - o.T);
  const E = solveKepler(M, o.e);
  const nu = 2 * Math.atan2(Math.sqrt(1 + o.e) * Math.sin(E / 2), Math.sqrt(1 - o.e) * Math.cos(E / 2));
  const r = o.aAU * (1 - o.e * Math.cos(E));
  const d2r = Math.PI / 180;
  const w = o.omega * d2r, W = o.node * d2r, inc = o.i * d2r;
  const u = w + nu;
  const north = r * (Math.cos(u) * Math.cos(W) - Math.sin(u) * Math.sin(W) * Math.cos(inc));
  const east = r * (Math.cos(u) * Math.sin(W) + Math.sin(u) * Math.cos(W) * Math.cos(inc));
  const rec = r * Math.sin(u) * Math.sin(inc);
  return [north, east, rec];
}

/**
 * Tangent-plane basis at a star (equatorial RA/Dec, radians) expressed in the galactic three.js frame:
 * north (toward the NCP), east, and the line of sight (away from the Sun).
 */
export function tangentBasis(
  ra: number,
  dec: number,
  toGal: (x: number, y: number, z: number, out: THREE.Vector3) => THREE.Vector3,
): { north: THREE.Vector3; east: THREE.Vector3; los: THREE.Vector3 } {
  const cr = Math.cos(ra), sr = Math.sin(ra), cd = Math.cos(dec), sd = Math.sin(dec);
  const los = toGal(cd * cr, cd * sr, sd, new THREE.Vector3());
  const east = toGal(-sr, cr, 0, new THREE.Vector3());
  const north = toGal(-sd * cr, -sd * sr, cd, new THREE.Vector3());
  return { north, east, los };
}
