import type { PlanetSpec } from '../../planet/types';
import type { PlanetKey } from '../ephem/standish';
import type { ConicElements } from '../ephem/conic';

export type BodyKind = 'star' | 'planet' | 'dwarf' | 'moon' | 'asteroid' | 'comet' | 'spacecraft';

/**
 * IAU/WGCCRE rotational elements (Archinal et al. 2018, Celest. Mech. 130:22): pole (α0, δ0) in ICRF
 * degrees with rates per Julian century, prime meridian W = W0 + Wd·d (deg, deg/day; negative =
 * retrograde). `model` selects extra periodic terms (Neptune's pole wobble, the Moon's physical libration).
 */
export interface RotationModel {
  ra: number;
  dec: number;
  raRate?: number;
  decRate?: number;
  W0: number;
  Wd: number;
  model?: 'neptune' | 'moon';
}

/** Satellite mean elements fitted to JPL Horizons over 2006–2046 (see data/moons.ts). */
export interface FittedSatellite {
  /** Reference (Laplace) plane pole, ICRF RA/Dec, degrees. */
  pole: readonly [number, number];
  /** Inclination to the reference plane, deg. */
  i: number;
  /** Ascending node on the reference plane (from its node on the ICRF equator) at SAT_EPOCH, deg; rate deg/day. */
  node0: number;
  nodeRate: number;
  /** Mean argument of latitude at SAT_EPOCH (deg) and its rate (deg/day). */
  L0: number;
  n: number;
  e: number;
  /** Argument of pericentre (from the node) at SAT_EPOCH (deg) and its rate (deg/day). */
  w0: number;
  wRate: number;
  /** Mean orbital radius, km. */
  aKm: number;
  /** Libration terms added to the mean argument of latitude: [period (d), cos coeff (deg), sin coeff (deg)]. */
  libs?: ReadonlyArray<readonly [number, number, number]>;
  /** RMS residual of the fit against Horizons, deg (documentation). */
  rms: number;
}

export type OrbitSource =
  | { type: 'sun' }
  | { type: 'planet'; key: PlanetKey }
  | { type: 'earth' }
  | { type: 'moon' }
  | { type: 'pluto' }
  | { type: 'sat'; fit: FittedSatellite; barycentric?: boolean }
  | { type: 'sat-conic'; el: ConicElements }
  | { type: 'conic'; el: ConicElements }
  | { type: 'state'; jd: number; r: readonly [number, number, number]; v: readonly [number, number, number]; validFrom?: number };

export type ShapeKind = 'sphere' | 'ellipsoid' | 'irregular' | 'bilobed';

export interface CometPhysics {
  /** Total absolute magnitude and slope: m = M1 + 5 log Δ + K1 log r (JPL SBDB). */
  M1: number;
  K1: number;
  /** Heliocentric distance (AU) where activity switches off (water ~3 AU, CO-driven comets further). */
  rCut: number;
  /** Relative dust-to-gas production (0..1): dusty comets have bright curved dust tails. */
  dust: number;
  /** Nucleus radius, km. */
  nucleusKm: number;
}

export interface BodyDef {
  id: string;
  name: string;
  kind: BodyKind;
  /** Parent body id ('sun' for heliocentric orbits, null for the Sun). */
  parent: string | null;
  /** Mean radius, km. */
  radiusKm: number;
  /** Triaxial radii (a ≥ b equatorial, c polar), km, for oblate/irregular bodies. */
  radiiKm?: readonly [number, number, number];
  massKg?: number;
  /** Geometric albedo (V). */
  albedo: number;
  /** Representative colour (sRGB hex) for labels, orbit lines and distant point sprites. */
  color: string;
  rotation?: RotationModel;
  /** Synchronous rotation (sub-parent meridian faces the parent). */
  locked?: boolean;
  /** Rotation period for bodies without an IAU model, hours (negative = retrograde). */
  spinHours?: number;
  orbit: OrbitSource;
  /** Render hints for createPlanet (radius and seed are supplied by the layer). */
  planet?: Omit<PlanetSpec, 'radius' | 'seed'>;
  shape?: ShapeKind;
  comet?: CometPhysics;
  /** 0 Sun · 1 planets · 2 dwarf planets · 3 major moons · 4 minor bodies · 5 tiny. */
  priority: number;
  subtitle: string;
  blurb: string;
  facts?: Record<string, string>;
  /** First/last date (JD) this body is shown (spacecraft after launch/last flyby). */
  visibleFrom?: number;
}
