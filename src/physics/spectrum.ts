import { cieXYZ, xyzToLinearSRGB } from './blackbody';

/** Rest wavelengths (nm, air) of the emission lines that colour nebulae. */
export const LINES = {
  H_ALPHA: 656.28,
  H_BETA: 486.13,
  H_GAMMA: 434.05,
  OIII_5007: 500.68,
  OIII_4959: 495.89,
  NII_6584: 658.35,
  SII_6716: 671.64,
  SII_6731: 673.08,
  HEII_4686: 468.57,
  HEI_5876: 587.56,
  OI_6300: 630.03,
} as const;

/**
 * Linear sRGB colour of monochromatic light, luminance-normalised (Y = 1) and
 * desaturated toward white just enough to fit inside the sRGB gamut
 * (spectral colours lie outside every RGB gamut).
 */
export function wavelengthToRGB(nm: number): [number, number, number] {
  const [x, y, z] = cieXYZ(nm);
  const Y = Math.max(y, 1e-6);
  let [r, g, b] = xyzToLinearSRGB(x / Y, 1, z / Y);
  const m = Math.min(r, g, b);
  if (m < 0) {
    // Mix with equal-luminance white until the most negative channel reaches 0.
    const t = -m / (1 - m);
    r = r + (1 - r) * t;
    g = g + (1 - g) * t;
    b = b + (1 - b) * t;
  }
  return [r, g, b];
}

/** Photometric luminous efficiency V(λ) (≈ CIE ȳ). */
export function luminousEfficiency(nm: number): number {
  return cieXYZ(nm)[1];
}

/** Relativistic Doppler: observed wavelength for emitted λ and Doppler factor δ = ν_obs/ν_emit. */
export const dopplerShift = (nm: number, delta: number) => nm / delta;
