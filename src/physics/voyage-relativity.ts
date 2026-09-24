import * as THREE from 'three';
import { C, H_PLANCK, K_B, LY, PC, YEAR } from './constants';
import { cieXYZ } from './blackbody';

/**
 * Special relativity for a moving observer (the Ship of the Imagination) and the relativistic rocket.
 *
 * Conventions. β = v/c is the observer's velocity in the rest frame S of the stars. Directions are unit
 * vectors pointing FROM the observer TOWARD a source. θ is the angle between β and a source direction in
 * S; θ' is the same angle measured by the moving observer (frame S').
 *
 *   Aberration   cos θ' = (cos θ + β) / (1 + β cos θ)                      (Einstein 1905, §7)
 *   Doppler      δ = ν'/ν = γ (1 + β cos θ) = 1 / (γ (1 − β cos θ'))
 *   Blackbody    a blackbody at T is seen as a blackbody at T' = δT, because I_ν/ν³ is invariant
 *                (Rybicki & Lightman 1979, §4.9; Peebles & Wilkinson 1968 for the CMB).
 *   Intensity    extended sources (Milky Way, CMB): I' = δ⁴ I (bolometric)
 *   Point flux   solid angles shrink as dΩ' = dΩ/δ², so a star's bolometric flux F' = δ² F
 *                (McKinley & Doherty 1979, Am. J. Phys. 47, 309; Weiskopf et al. 1999).
 *   Visual band  stars:    F'_V / F_V = L(δT) / (L(T) δ²)
 *                extended: I'_V / I_V = L(δT) / L(T)
 *                where L(T) = ∫ B_λ(λ,T) ȳ(λ) dλ is the photopic luminance of a blackbody surface.
 *
 * Relativistic rocket with constant proper acceleration α (Rindler 2006, §3.8; Baez & Gibbs, "The
 * Relativistic Rocket"): rapidity φ = ατ/c, t = (c/α) sinh φ, x = (c²/α)(cosh φ − 1), β = tanh φ, γ = cosh φ.
 */

/** Speed of light in parsecs per Julian year. */
export const C_PC_PER_YEAR = (C * YEAR) / PC;
/** Speed of light in light-years per Julian year (exactly 1 by definition of the light-year). */
export const C_LY_PER_YEAR = (C * YEAR) / LY;
/** Standard gravity, m/s². */
export const G0 = 9.80665;
/** 1 g of proper acceleration in units of c per year (≈ 1.0323). */
export const G_IN_C_PER_YEAR = (G0 * YEAR) / C;
/** CMB temperature today (Fixsen 2009). */
export const T_CMB = 2.7255;
/**
 * Velocity of the Sun relative to the CMB rest frame (Planck 2018 I, Table 3): 369.82 km/s toward
 * galactic (l, b) = (264.021°, 48.253°).
 */
export const SUN_CMB_DIPOLE = { speed: 369.82e3, l: (264.021 * Math.PI) / 180, b: (48.253 * Math.PI) / 180 };

export const gammaOf = (beta: number): number => 1 / Math.sqrt(Math.max(1e-300, 1 - beta * beta));
/** Rapidity φ = artanh β. */
export const rapidityOf = (beta: number): number => Math.atanh(Math.min(beta, 1 - 1e-16));
/** β for a proper velocity u = γβ. */
export const betaFromProperSpeed = (u: number): number => u / Math.sqrt(1 + u * u);
export const gammaFromProperSpeed = (u: number): number => Math.sqrt(1 + u * u);

/** Aberration: rest-frame cos θ → observed cos θ'. */
export function aberrateCos(cosTheta: number, beta: number): number {
  return (cosTheta + beta) / (1 + beta * cosTheta);
}
/** Inverse aberration: observed cos θ' → rest-frame cos θ. */
export function deaberrateCos(cosThetaObs: number, beta: number): number {
  return (cosThetaObs - beta) / (1 - beta * cosThetaObs);
}
/** Doppler factor δ = ν_obs/ν_emit from the rest-frame angle. */
export function dopplerFromRest(cosTheta: number, beta: number): number {
  return gammaOf(beta) * (1 + beta * cosTheta);
}
/** Doppler factor δ from the observed angle. */
export function dopplerFromObserved(cosThetaObs: number, beta: number): number {
  return 1 / (gammaOf(beta) * (1 - beta * cosThetaObs));
}

/**
 * Aberrate a rest-frame direction for an observer moving with velocity `beta` (vector, |β| < 1).
 * Writes the observed unit direction into `out` and returns the Doppler factor δ.
 */
export function aberrateDirection(dir: THREE.Vector3, beta: THREE.Vector3, out: THREE.Vector3): number {
  const b = beta.length();
  if (b < 1e-12) {
    out.copy(dir).normalize();
    return 1;
  }
  const bx = beta.x / b, by = beta.y / b, bz = beta.z / b;
  const len = dir.length() || 1;
  const dx = dir.x / len, dy = dir.y / len, dz = dir.z / len;
  const mu = dx * bx + dy * by + dz * bz;
  const muObs = aberrateCos(mu, b);
  let px = dx - mu * bx, py = dy - mu * by, pz = dz - mu * bz;
  const pl = Math.hypot(px, py, pz);
  const s = Math.sqrt(Math.max(0, 1 - muObs * muObs));
  if (pl > 1e-15) {
    px /= pl; py /= pl; pz /= pl;
  } else {
    px = py = pz = 0;
  }
  out.set(muObs * bx + s * px, muObs * by + s * py, muObs * bz + s * pz);
  return gammaOf(b) * (1 + b * mu);
}

/** The inverse map: observed direction → rest-frame direction (returns δ of that direction). */
export function deaberrateDirection(dirObs: THREE.Vector3, beta: THREE.Vector3, out: THREE.Vector3): number {
  const b = beta.length();
  if (b < 1e-12) {
    out.copy(dirObs).normalize();
    return 1;
  }
  const minus = _tmpBeta.copy(beta).multiplyScalar(-1);
  aberrateDirection(dirObs, minus, out);
  const mu = out.dot(beta) / b;
  return gammaOf(b) * (1 + b * mu);
}
const _tmpBeta = new THREE.Vector3();

/** Bolometric flux boost of a point source (δ²) and intensity boost of an extended source (δ⁴). */
export const pointFluxBoost = (delta: number): number => delta * delta;
export const intensityBoost = (delta: number): number => delta * delta * delta * delta;

/**
 * Relativistic velocity addition u ⊕ v (both as fractions of c): the velocity of an object moving at
 * v in a frame that itself moves at u. Returns a new vector in `out`.
 */
export function addVelocities(u: THREE.Vector3, v: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  const u2 = u.lengthSq();
  if (u2 < 1e-30) return out.copy(v);
  const gu = 1 / Math.sqrt(1 - u2);
  const uv = u.dot(v);
  const k = 1 / (1 + uv);
  // (u + v/γu + (γu/(1+γu)) (u·v) u) / (1 + u·v)
  const a = gu / (1 + gu);
  const x = u.x + v.x / gu + a * uv * u.x;
  const y = u.y + v.y / gu + a * uv * u.y;
  const z = u.z + v.z / gu + a * uv * u.z;
  return out.set(x * k, y * k, z * k);
}

// ——— Photometry of thermal light ———

const HC_K = (H_PLANCK * C) / K_B; // m·K

/** Planck B_λ up to a constant: λ⁻⁵ / (exp(hc/λkT) − 1), λ in nm; computed in log space. */
function logPlanckNm(nm: number, T: number): number {
  const lam = nm * 1e-9;
  const x = HC_K / (lam * T);
  // log(1/(e^x − 1)) = −x − log(1 − e^−x), stable for large x; for small x use −log(expm1(x)).
  const tail = x > 1e-3 ? -x - Math.log1p(-Math.exp(-x)) : -Math.log(Math.expm1(x));
  return -5 * Math.log(lam) + tail;
}

/**
 * Natural log of the photopic luminance of a blackbody surface at T, relative to T = 5772 K (the Sun):
 * ln( ∫B_λ(T) ȳ dλ / ∫B_λ(5772 K) ȳ dλ ). Uses the CIE 1931 ȳ fit (Wyman et al. 2013), 360–830 nm.
 * Log space keeps it finite for the 2.7 K CMB (≈ e^−4000).
 */
export function logBlackbodyLuminance(T: number): number {
  return logLumRaw(Math.max(T, 0.5)) - LOG_LUM_SUN;
}
function logLumRaw(T: number): number {
  // log-sum-exp over the wavelength grid
  let maxv = -Infinity;
  const vals: number[] = _vals;
  let n = 0;
  for (let nm = 360; nm <= 830; nm += 2.5) {
    const y = cieXYZ(nm)[1];
    if (y <= 1e-7) continue;
    const v = logPlanckNm(nm, T) + Math.log(y);
    vals[n++] = v;
    if (v > maxv) maxv = v;
  }
  let s = 0;
  for (let i = 0; i < n; i++) s += Math.exp(vals[i] - maxv);
  return maxv + Math.log(s);
}
const _vals: number[] = [];
const LOG_LUM_SUN = logLumRaw(5772);

/** Photopic luminance of a blackbody surface relative to the Sun's photosphere (5772 K). */
export const blackbodyLuminance = (T: number): number => Math.exp(logBlackbodyLuminance(T));

/** Visual flux ratio of a thermal point source seen with Doppler factor δ: L(δT) / (L(T) δ²). */
export function visualFluxRatio(T: number, delta: number): number {
  return Math.exp(logBlackbodyLuminance(T * delta) - logBlackbodyLuminance(T)) / (delta * delta);
}
/** Visual intensity ratio of thermal extended emission seen with Doppler factor δ: L(δT)/L(T). */
export function visualIntensityRatio(T: number, delta: number): number {
  return Math.exp(logBlackbodyLuminance(T * delta) - logBlackbodyLuminance(T));
}
/** Apparent-magnitude change of a thermal star under Doppler factor δ (negative = brighter). */
export function magnitudeShift(T: number, delta: number): number {
  return (-2.5 / Math.LN10) * (logBlackbodyLuminance(T * delta) - logBlackbodyLuminance(T) - 2 * Math.log(delta));
}

/**
 * GPU lookup table of log10 photopic luminance, L(T)/L(5772 K), for T log-spaced over [minT, maxT].
 * RGBA16F (filterable in WebGL2 core): r = log10 L. GLSL helper: RELATIVITY_GLSL `logLum(T)`.
 */
export const LUMINANCE_LUT = { minT: 10, maxT: 1e7, size: 1024 };
export function createLuminanceLUT(): THREE.DataTexture {
  const { minT, maxT, size } = LUMINANCE_LUT;
  const data = new Uint16Array(size * 4);
  const lmin = Math.log(minT), lmax = Math.log(maxT);
  for (let i = 0; i < size; i++) {
    const T = Math.exp(lmin + ((lmax - lmin) * i) / (size - 1));
    const l10 = logBlackbodyLuminance(T) / Math.LN10;
    data[i * 4] = THREE.DataUtils.toHalfFloat(Math.max(-60000, l10));
    data[i * 4 + 1] = 0;
    data[i * 4 + 2] = 0;
    data[i * 4 + 3] = THREE.DataUtils.toHalfFloat(1);
  }
  const tex = new THREE.DataTexture(data, size, 1, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

// ——— Relativistic rocket (constant proper acceleration from rest), SI units ———

export interface RocketState {
  /** Coordinate (Earth-frame) time, s. */
  t: number;
  /** Distance covered, m. */
  x: number;
  beta: number;
  gamma: number;
  rapidity: number;
}

/** State after proper time τ (s) at proper acceleration α (m/s²), starting from rest. */
export function rocketAtProperTime(alpha: number, tau: number): RocketState {
  const phi = (alpha * tau) / C;
  return { t: (C / alpha) * Math.sinh(phi), x: ((C * C) / alpha) * (Math.cosh(phi) - 1), beta: Math.tanh(phi), gamma: Math.cosh(phi), rapidity: phi };
}

/** Proper time (s) needed to cover distance x (m) from rest at proper acceleration α. */
export function rocketProperTimeForDistance(alpha: number, x: number): number {
  return (C / alpha) * Math.acosh(1 + (alpha * x) / (C * C));
}

export interface TripPlan {
  /** Total proper (ship) time, s. */
  tau: number;
  /** Total coordinate (Earth) time, s. */
  t: number;
  /** Peak speed as a fraction of c. */
  betaPeak: number;
  gammaPeak: number;
  /** Proper time spent accelerating (= decelerating), s. */
  tauBurn: number;
  /** Proper time coasting at the cap, s. */
  tauCoast: number;
}

/**
 * Accelerate–(coast)–decelerate trip of length `distance` (m) at proper acceleration α, optionally
 * capped at `betaMax`. Starts and ends at rest.
 */
export function planTrip(distance: number, alpha: number, betaMax = 1): TripPlan {
  const half = distance / 2;
  const phiHalf = Math.acosh(1 + (alpha * half) / (C * C));
  const phiCap = betaMax < 1 ? Math.atanh(betaMax) : Infinity;
  if (phiHalf <= phiCap) {
    const tauBurn = (C / alpha) * phiHalf;
    return {
      tau: 2 * tauBurn,
      t: 2 * (C / alpha) * Math.sinh(phiHalf),
      betaPeak: Math.tanh(phiHalf),
      gammaPeak: Math.cosh(phiHalf),
      tauBurn,
      tauCoast: 0,
    };
  }
  const tauBurn = (C / alpha) * phiCap;
  const xBurn = ((C * C) / alpha) * (Math.cosh(phiCap) - 1);
  const tBurn = (C / alpha) * Math.sinh(phiCap);
  const coast = distance - 2 * xBurn;
  const v = C * betaMax;
  const g = Math.cosh(phiCap);
  const tCoast = coast / v;
  return { tau: 2 * tauBurn + tCoast / g, t: 2 * tBurn + tCoast, betaPeak: betaMax, gammaPeak: g, tauBurn, tauCoast: tCoast / g };
}

/**
 * Advance a proper velocity u = γβ (c = 1) by a rest-frame (proper) acceleration `aRest` (c per unit
 * proper time) over proper time dτ. Uses the exact boost of the 4-acceleration:
 * du/dτ = γ a∥ + a⊥ (components relative to u), integrated with classical RK4.
 */
export function stepProperVelocity(u: THREE.Vector3, aRest: THREE.Vector3, dTau: number): THREE.Vector3 {
  const f = (uu: THREE.Vector3, out: THREE.Vector3) => {
    const um2 = uu.lengthSq();
    if (um2 < 1e-24) return out.copy(aRest);
    const g = Math.sqrt(1 + um2);
    // a⊥ = a − (a·n) n ;  du/dτ = γ (a·n) n + a⊥ = a + (γ − 1)(a·u) u / |u|²
    return out.copy(aRest).addScaledVector(uu, ((g - 1) * aRest.dot(uu)) / um2);
  };
  const h = dTau;
  f(u, _k1);
  f(_mid.copy(u).addScaledVector(_k1, h / 2), _k2);
  f(_mid.copy(u).addScaledVector(_k2, h / 2), _k3);
  f(_mid.copy(u).addScaledVector(_k3, h), _k4);
  return u.addScaledVector(_k1, h / 6).addScaledVector(_k2, h / 3).addScaledVector(_k3, h / 3).addScaledVector(_k4, h / 6);
}
const _k1 = new THREE.Vector3();
const _k2 = new THREE.Vector3();
const _k3 = new THREE.Vector3();
const _k4 = new THREE.Vector3();
const _mid = new THREE.Vector3();

/**
 * Brachistochrone guidance: the largest rapidity from which the ship can still stop within distance r
 * at proper acceleration α: cosh φ − 1 = α r / c²  (c = 1 units: φ = acosh(1 + α r)).
 */
export function stoppingRapidity(alpha: number, r: number): number {
  return Math.acosh(1 + Math.max(0, alpha * r));
}
