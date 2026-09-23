import * as THREE from 'three';
import { cieXYZ, planck, xyzToLinearSRGB } from '../../physics/blackbody';

/**
 * Colour science for relativistic thermal emission.
 *
 * A blackbody at temperature T seen with frequency ratio g = ν_obs/ν_emit is again a blackbody,
 * at T_obs = g·T: I_ν/ν³ is invariant, and g³ B_{ν/g}(T) = B_ν(gT). So the colour AND brightness a
 * camera records are simply those of a Planck spectrum at g·T — no separate g³/g⁴ beaming factor
 * is needed (bolometrically this reproduces the familiar g⁴). We tabulate the CIE-integrated
 * Planck spectrum once, in absolute terms:
 *
 *   XYZ(T) = ∫ B_λ(T) (x̄, ȳ, z̄)(λ) dλ   (CIE 1931 2°, Wyman–Sloan–Shirley fit), → linear sRGB.
 *
 * Texture layout (log-spaced in T): rgb = chromaticity normalised to luminance Y = 1,
 * a = log₂(Y(T) / Y(T_REF)). GLSL: radiance = rgb · exp2(a). Half floats, linearly filterable.
 */
export const PLANCK_T_MIN = 400;
export const PLANCK_T_MAX = 3.0e6;
export const PLANCK_T_REF = 6500;
const PLANCK_N = 512;

function integrateXYZ(T: number): [number, number, number] {
  let X = 0, Y = 0, Z = 0;
  for (let nm = 360; nm <= 830; nm += 2) {
    const p = planck(nm * 1e-9, T);
    const [x, y, z] = cieXYZ(nm);
    X += p * x;
    Y += p * y;
    Z += p * z;
  }
  return [X, Y, Z];
}

/** Luminance of a Planck spectrum at T relative to T_REF (visible-band brightness law). */
export function planckLuminance(T: number): number {
  return integrateXYZ(T)[1] / integrateXYZ(PLANCK_T_REF)[1];
}

/** Linear-sRGB chromaticity (Y = 1) of a Planck spectrum, clipped to the gamut. */
export function planckChromaticity(T: number): [number, number, number] {
  const [X, Y, Z] = integrateXYZ(T);
  const [r, g, b] = xyzToLinearSRGB(X / Y, 1, Z / Y);
  return [Math.max(r, 0), Math.max(g, 0), Math.max(b, 0)];
}

export function createPlanckTexture(): THREE.DataTexture {
  const yRef = integrateXYZ(PLANCK_T_REF)[1];
  const data = new Uint16Array(PLANCK_N * 4);
  const l0 = Math.log(PLANCK_T_MIN), l1 = Math.log(PLANCK_T_MAX);
  for (let i = 0; i < PLANCK_N; i++) {
    const T = Math.exp(l0 + ((l1 - l0) * i) / (PLANCK_N - 1));
    const [X, Y, Z] = integrateXYZ(T);
    const [r, g, b] = xyzToLinearSRGB(X / Y, 1, Z / Y);
    const lg = Math.max(-60, Math.log2(Math.max(Y / yRef, 1e-300)));
    data[i * 4] = THREE.DataUtils.toHalfFloat(Math.max(r, 0));
    data[i * 4 + 1] = THREE.DataUtils.toHalfFloat(Math.max(g, 0));
    data[i * 4 + 2] = THREE.DataUtils.toHalfFloat(Math.max(b, 0));
    data[i * 4 + 3] = THREE.DataUtils.toHalfFloat(lg);
  }
  const tex = new THREE.DataTexture(data, PLANCK_N, 1, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Inverse lookup "colour → temperature" for Doppler-shifting an RGB sky: for thermal light the
 * blue/red ratio is monotonic in T. Index q = ln(b/r) mapped over [Q_MIN, Q_MAX]; value ln T.
 */
export const CT_T_MIN = 1600;
export const CT_T_MAX = 40000;
const CT_N = 256;

export function colorTemperatureRange(): { qMin: number; qMax: number } {
  const q = (T: number) => {
    const [r, , b] = planckChromaticity(T);
    return Math.log(Math.max(b, 1e-6) / Math.max(r, 1e-6));
  };
  return { qMin: q(CT_T_MIN), qMax: q(CT_T_MAX) };
}

export function createColorTemperatureTexture(): { texture: THREE.DataTexture; qMin: number; qMax: number } {
  const q = (T: number) => {
    const [r, , b] = planckChromaticity(T);
    return Math.log(Math.max(b, 1e-6) / Math.max(r, 1e-6));
  };
  const { qMin, qMax } = colorTemperatureRange();
  const data = new Uint16Array(CT_N * 4);
  for (let i = 0; i < CT_N; i++) {
    const target = qMin + ((qMax - qMin) * i) / (CT_N - 1);
    let lo = Math.log(CT_T_MIN), hi = Math.log(CT_T_MAX);
    for (let k = 0; k < 50; k++) {
      const mid = 0.5 * (lo + hi);
      if (q(Math.exp(mid)) < target) lo = mid;
      else hi = mid;
    }
    const lnT = 0.5 * (lo + hi);
    data[i * 4] = THREE.DataUtils.toHalfFloat(lnT);
    data[i * 4 + 1] = data[i * 4 + 2] = 0;
    data[i * 4 + 3] = THREE.DataUtils.toHalfFloat(1);
  }
  const texture = new THREE.DataTexture(data, CT_N, 1, THREE.RGBAFormat, THREE.HalfFloatType);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return { texture, qMin, qMax };
}

/**
 * Mean chromaticity and flux of a stellar population (for the "unresolved stars" limit of the
 * lensed star field): flux-weighted average of Planck chromaticities over the temperature mix.
 */
export function populationColor(temps: number[], weights: number[]): [number, number, number] {
  let r = 0, g = 0, b = 0, w = 0;
  temps.forEach((T, i) => {
    const c = planckChromaticity(T);
    r += c[0] * weights[i];
    g += c[1] * weights[i];
    b += c[2] * weights[i];
    w += weights[i];
  });
  return [r / w, g / w, b / w];
}
