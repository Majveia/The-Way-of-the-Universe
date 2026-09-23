import * as THREE from 'three';
import { C, H_PLANCK, K_B } from './constants';

/**
 * Colour of thermal radiation.
 *
 * cieXYZ(λ): CIE 1931 2° colour matching functions via the multi-lobe Gaussian fit of
 *   Wyman, Sloan & Shirley (2013), "Simple Analytic Approximations to the CIE XYZ
 *   Color Matching Functions", JCGT 2(2).
 * blackbodyRGB(T): ∫ Planck(λ,T) · cmf(λ) dλ → XYZ → linear sRGB (D65), normalised to Y = 1.
 */

function g(x: number, mu: number, s1: number, s2: number): number {
  const t = (x - mu) / (x < mu ? s1 : s2);
  return Math.exp(-0.5 * t * t);
}

/** CIE 1931 2° observer, λ in nanometres. */
export function cieXYZ(nm: number): [number, number, number] {
  const x = 1.056 * g(nm, 599.8, 37.9, 31.0) + 0.362 * g(nm, 442.0, 16.0, 26.7) - 0.065 * g(nm, 501.1, 20.4, 26.2);
  const y = 0.821 * g(nm, 568.8, 46.9, 40.5) + 0.286 * g(nm, 530.9, 16.3, 31.1);
  const z = 1.217 * g(nm, 437.0, 11.8, 36.0) + 0.681 * g(nm, 459.0, 26.0, 13.8);
  return [x, y, z];
}

/** XYZ → linear sRGB (D65). */
export function xyzToLinearSRGB(X: number, Y: number, Z: number): [number, number, number] {
  return [
    3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z,
    -0.969266 * X + 1.8760108 * Y + 0.041556 * Z,
    0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z,
  ];
}

/** Planck spectral radiance B_λ(T) in W·sr⁻¹·m⁻³ (λ in metres). */
export function planck(lambdaM: number, T: number): number {
  const a = (2 * H_PLANCK * C * C) / Math.pow(lambdaM, 5);
  const b = (H_PLANCK * C) / (lambdaM * K_B * T);
  return a / Math.expm1(b);
}

const cache = new Map<number, [number, number, number]>();

/**
 * Linear sRGB chromaticity of a blackbody at T kelvin, normalised to luminance Y = 1.
 * Out-of-gamut components are clipped at 0 (very cool stars are redder than sRGB red).
 */
export function blackbodyRGB(T: number): [number, number, number] {
  const key = Math.round(T);
  const hit = cache.get(key);
  if (hit) return hit;
  let X = 0,
    Y = 0,
    Z = 0;
  for (let nm = 360; nm <= 830; nm += 5) {
    const p = planck(nm * 1e-9, Math.max(T, 100));
    const [x, y, z] = cieXYZ(nm);
    X += p * x;
    Y += p * y;
    Z += p * z;
  }
  const [r, gg, b] = xyzToLinearSRGB(X / Y, 1, Z / Y);
  const out: [number, number, number] = [Math.max(0, r), Math.max(0, gg), Math.max(0, b)];
  if (cache.size > 4096) cache.clear();
  cache.set(key, out);
  return out;
}

/** Same as blackbodyRGB but scaled so the largest channel is 1 (display "star colour"). */
export function blackbodyColor(T: number, target = new THREE.Color()): THREE.Color {
  const [r, g2, b] = blackbodyRGB(T);
  const m = Math.max(r, g2, b, 1e-9);
  return target.setRGB(r / m, g2 / m, b / m, THREE.LinearSRGBColorSpace);
}

/**
 * 1D lookup texture of blackbody chromaticity (Y = 1) over [minT, maxT], log-spaced.
 * GLSL: see BLACKBODY_GLSL `blackbodyLUT(lut, T, minT, maxT)`.
 */
export function createBlackbodyTexture(minT = 1000, maxT = 40000, n = 256): THREE.DataTexture {
  const data = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const T = Math.exp(Math.log(minT) + ((Math.log(maxT) - Math.log(minT)) * i) / (n - 1));
    const [r, g2, b] = blackbodyRGB(T);
    data.set([r, g2, b, 1], i * 4);
  }
  const tex = new THREE.DataTexture(data, n, 1, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Wien peak wavelength in nm. */
export const wienPeakNm = (T: number) => (2.897771955e-3 / T) * 1e9;

/** Approximate effective temperature from B−V colour index (Ballesteros 2012). */
export function bvToTemperature(bv: number): number {
  return 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
}
