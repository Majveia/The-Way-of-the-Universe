import * as THREE from 'three';
import { Rng, hash01 } from '../../physics/random';
import type { MorphologyId } from '../galaxy/params';

/**
 * Where we live in the simulated universe, and the real geometry of the Local Group.
 *
 * The cosmic web is a z = 0 ΛCDM particle-mesh simulation (src/worlds/cosmicweb); its smallest
 * resolved halos are groups of ~10¹³ M☉ — the Local Group itself (≈ 3–5 × 10¹² M☉, van der Marel
 * et al. 2012) is just below that. We place home in a *low-mass* halo that has a massive cluster
 * 10–30 Mpc away — our Virgo analogue (the Virgo cluster: 1.2 × 10¹⁵ M☉ at 16.5 Mpc, Mei et al.
 * 2007) — and rotate the simulation so that neighbour lies in the true direction of Virgo (M87,
 * l = 283.8°, b = +74.5°). Everything else in the box is a statistically faithful, but not real,
 * universe.
 *
 * The explorer's ROOT frame is Local-Group-centred, in Mpc, with the Milky Way's Galactic axes
 * (three.js convention of the sky catalogue: +x → Galactic centre, +y → north Galactic pole,
 * +z = −(l = 90°)). The Milky Way galaxy frame then needs no rotation, and the sky of Starflight,
 * the Galaxy and the cosmic web all agree.
 */

export const DEG = Math.PI / 180;

/** Galactic (l, b) → unit vector in the galactic three.js frame. */
export function galacticDir(lDeg: number, bDeg: number, out = new THREE.Vector3()): THREE.Vector3 {
  const l = lDeg * DEG, b = bDeg * DEG;
  return out.set(Math.cos(b) * Math.cos(l), Math.sin(b), -Math.cos(b) * Math.sin(l));
}

/** Equatorial J2000 (RA, Dec in degrees) → galactic three.js unit vector (Hipparcos A_G, ESA 1997). */
export function equatorialDir(raDeg: number, decDeg: number, out = new THREE.Vector3()): THREE.Vector3 {
  const ra = raDeg * DEG, dec = decDeg * DEG;
  return eqVecToGal(Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec), out);
}

const EQ_TO_GAL = [-0.0548755604, -0.8734370902, -0.4838350155, 0.4941094279, -0.44482963, 0.7469822445, -0.867666149, -0.1980763734, 0.4559837762];
function eqVecToGal(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
  const M = EQ_TO_GAL;
  const gx = M[0] * x + M[1] * y + M[2] * z;
  const gy = M[3] * x + M[4] * y + M[5] * z;
  const gz = M[6] * x + M[7] * y + M[8] * z;
  return out.set(gx, gz, -gy);
}

/**
 * Sagittarius A*: mass 4.30 × 10⁶ M☉ (GRAVITY Collaboration 2022), so r_g = GM/c² = 6.35 × 10⁹ m
 * (0.042 AU) and t_g = r_g/c = 21.2 s. The explorer's black-hole frame is measured in r_g.
 */
export const SGRA = { massSun: 4.3e6, rgMetres: 6.35e9, tgSeconds: 21.2 };

/** Virgo cluster centre (M87): direction and distance. */
export const VIRGO = { l: 283.78, b: 74.49, distanceMpc: 16.5 };

/**
 * Andromeda (M31). Position: RA 00h 42m 44.3s, Dec +41° 16′ 09″ (l = 121.17°, b = −21.57°); distance
 * 0.78 Mpc (McConnell et al. 2005: 785 ± 25 kpc; Riess et al. 2012: 765 kpc). Disk: major-axis
 * position angle 38°, inclination 77° (de Vaucouleurs 1958; Walterbos & Kennicutt 1987); the NW
 * side is the near side. Disk scale length ≈ 5.3 kpc (Courteau et al. 2011) — larger than ours.
 */
export const M31 = { raDeg: 10.6847, decDeg: 41.2687, distanceMpc: 0.78, paDeg: 38, inclinationDeg: 77 };

/**
 * Orientation of a disk galaxy from its sky position, major-axis position angle (east of north) and
 * inclination: returns the rotation that takes the galaxy's own frame (disk in x–z, spin axis +y,
 * major axis +x) into galactic axes, and the line-of-sight unit vector.
 */
export function diskOrientation(raDeg: number, decDeg: number, paDeg: number, incDeg: number, nearSideWest = true): { rotation: THREE.Quaternion; los: THREE.Vector3; normal: THREE.Vector3; major: THREE.Vector3 } {
  const ra = raDeg * DEG, dec = decDeg * DEG, pa = paDeg * DEG, inc = incDeg * DEG;
  // Tangent basis at (ra, dec) in equatorial astro axes.
  const n = [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
  const E = [-Math.sin(ra), Math.cos(ra), 0];
  const N = [-Math.sin(dec) * Math.cos(ra), -Math.sin(dec) * Math.sin(ra), Math.cos(dec)];
  const major = N.map((v, i) => Math.cos(pa) * v + Math.sin(pa) * E[i]);
  // Minor-axis direction on the sky (90° from the major axis, toward the west for PA ≈ 38°: −E side).
  const minor = N.map((v, i) => -Math.sin(pa) * v + Math.cos(pa) * E[i]);
  // The disk normal is tilted by the inclination from the line of sight toward the minor axis; the
  // sign chooses which side of the minor axis is nearer to us.
  const s = nearSideWest ? 1 : -1;
  const normal = n.map((v, i) => -Math.cos(inc) * v + s * Math.sin(inc) * minor[i]);
  const los = eqVecToGal(n[0], n[1], n[2], new THREE.Vector3());
  const nrm = eqVecToGal(normal[0], normal[1], normal[2], new THREE.Vector3()).normalize();
  const maj = eqVecToGal(major[0], major[1], major[2], new THREE.Vector3());
  maj.addScaledVector(nrm, -maj.dot(nrm)).normalize();
  const z = new THREE.Vector3().crossVectors(maj, nrm).normalize();
  const m = new THREE.Matrix4().makeBasis(maj, nrm, z);
  return { rotation: new THREE.Quaternion().setFromRotationMatrix(m), los, normal: nrm, major: maj };
}

export interface HaloLike {
  position: THREE.Vector3;
  mass: number;
  seed: number;
}

/** Periodic nearest image of `p` around `c` in a box of side `box` (all in the same units). */
export function wrapNear(p: THREE.Vector3, c: THREE.Vector3, box: number, out: THREE.Vector3): THREE.Vector3 {
  const f = (x: number, y: number) => x - box * Math.round((x - y) / box);
  return out.set(f(p.x, c.x), f(p.y, c.y), f(p.z, c.z));
}

export interface HomeChoice {
  /** Index of the home halo. */
  home: number;
  /** Index of the Virgo-analogue cluster (−1 if none). */
  virgo: number;
  /** Distance to it, Mpc. */
  virgoDistance: number;
}

/**
 * Choose home: among the low-mass halos (below ~4 × 10¹³ M☉, or the lightest decile), the one whose
 * nearest massive cluster (≥ 30× more massive, ≥ 10¹⁴ M☉) lies closest to the Virgo distance of
 * 16.5 Mpc. Ties (and the absence of clusters) fall back on the lightest halo.
 */
export function chooseHome(halos: readonly HaloLike[], boxMpc: number): HomeChoice {
  if (!halos.length) return { home: -1, virgo: -1, virgoDistance: 0 };
  const masses = halos.map((h) => h.mass).sort((a, b) => a - b);
  const light = Math.max(masses[Math.floor(masses.length * 0.15)] ?? masses[0], Math.min(4e13, masses[masses.length - 1]));
  let best = -1, bestScore = Infinity, bestV = -1, bestD = 0;
  const tmp = new THREE.Vector3();
  for (let i = 0; i < halos.length; i++) {
    const h = halos[i];
    if (h.mass > light) continue;
    let vi = -1, vd = Infinity;
    for (let j = 0; j < halos.length; j++) {
      const c = halos[j];
      if (c.mass < Math.max(1e14, 30 * h.mass)) continue;
      const d = wrapNear(c.position, h.position, boxMpc, tmp).distanceTo(h.position);
      if (d < vd) {
        vd = d;
        vi = j;
      }
    }
    const score = vi >= 0 ? Math.abs(Math.log(vd / VIRGO.distanceMpc)) : 10 + h.mass / 1e14;
    if (score < bestScore) {
      bestScore = score;
      best = i;
      bestV = vi;
      bestD = vi >= 0 ? vd : 0;
    }
  }
  if (best < 0) {
    let lo = 0;
    for (let i = 1; i < halos.length; i++) if (halos[i].mass < halos[lo].mass) lo = i;
    best = lo;
  }
  return { home: best, virgo: bestV, virgoDistance: bestD };
}

/**
 * Rotation from simulation-box axes to the explorer's galactic root axes that puts the Virgo
 * analogue (box-axis direction `virgoBox` from home) in the true direction of Virgo.
 */
export function boxToGalactic(virgoBox: THREE.Vector3 | null): THREE.Quaternion {
  const q = new THREE.Quaternion();
  if (!virgoBox || virgoBox.lengthSq() === 0) return q;
  return q.setFromUnitVectors(virgoBox.clone().normalize(), galacticDir(VIRGO.l, VIRGO.b));
}

/**
 * A plausible morphology for the central galaxy of a halo (morphology–density relation, Dressler
 * 1980): massive cluster halos host giant ellipticals; groups mix lenticulars, early spirals and
 * ellipticals; the lightest halos host spirals and irregulars.
 */
export function morphologyForHalo(massSun: number, seed: number): MorphologyId {
  const u = hash01(seed, 0x6a1a);
  if (massSun > 2e14) return u < 0.65 ? 'E0' : u < 0.9 ? 'E5' : 'S0';
  if (massSun > 5e13) return u < 0.3 ? 'E5' : u < 0.5 ? 'S0' : u < 0.7 ? 'Sa' : u < 0.85 ? 'SBb' : 'Sb';
  return u < 0.25 ? 'Sc' : u < 0.45 ? 'SBc' : u < 0.65 ? 'Sb' : u < 0.8 ? 'SBb' : u < 0.92 ? 'Sa' : 'Irr';
}

/** A random but repeatable orientation (seeded). */
export function randomOrientation(seed: number): THREE.Quaternion {
  const r = new Rng(seed >>> 0);
  // Uniform on SO(3) (Shoemake 1992).
  const u1 = r.next(), u2 = r.next(), u3 = r.next();
  const a = Math.sqrt(1 - u1), b = Math.sqrt(u1);
  return new THREE.Quaternion(a * Math.sin(2 * Math.PI * u2), a * Math.cos(2 * Math.PI * u2), b * Math.sin(2 * Math.PI * u3), b * Math.cos(2 * Math.PI * u3));
}

/** Map a morphology to a human label. */
export const MORPH_LABEL: Record<MorphologyId, string> = {
  milkyway: 'Barred spiral SBbc',
  E0: 'Giant elliptical E0',
  E5: 'Elliptical E5',
  S0: 'Lenticular S0',
  Sa: 'Spiral Sa',
  Sb: 'Spiral Sb',
  Sc: 'Spiral Sc',
  SBb: 'Barred spiral SBb',
  SBc: 'Barred spiral SBc',
  Irr: 'Irregular',
};
