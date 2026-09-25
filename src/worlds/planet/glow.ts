/**
 * Photometry of the night-side glows (planets module): city lights, aurora and airglow share one
 * night-vision gain, so their brightness relative to each other is physical. Pure functions, mirrored
 * by the GLSL in glsl.ts (AURORA_GLSL) and unit-tested in tests/planets.test.ts.
 *
 * Renderer radiance unit: a white Lambertian surface in full sunlight at 1 AU, ≈ E☉/π with
 * E☉ ≈ 1.12 × 10⁵ lx, i.e. ≈ 3.56 × 10⁴ cd m⁻².
 *
 * Night-vision gain: every night image of Earth is exposed ~10⁵× longer than a daylight one. We fix it
 * by the city lights: a saturated city pixel (VIIRS Day/Night Band ≈ 100 nW cm⁻² sr⁻¹ over 500–900 nm,
 * ≈ 0.3 cd m⁻² for sodium/LED light at ~300 lm W⁻¹) is drawn at LIGHTS_SCALE.
 *
 * Aurora (Chamberlain 1961; Rees 1989): column emission rates of a bright arc (IBC III) are ≈ 100 kR in
 * O I 557.7 nm, ~20 kR in the O I 630.0 nm red line at the top, ~25 kR in N₂⁺ 427.8 nm at the bottom.
 * 1 rayleigh = 10¹⁰/4π photons s⁻¹ m⁻² sr⁻¹ (column-integrated).
 */
import { luminousEfficiency } from '../../physics/spectrum';

/** Radiance of a saturated city-light pixel (renderer units). */
export const LIGHTS_SCALE = 0.9;
/** Renderer unit radiance in cd m⁻² (white surface in full sunlight at 1 AU). */
export const UNIT_LUMINANCE = 1.12e5 / Math.PI;
/** Luminance of a saturated city pixel seen from orbit, cd m⁻². */
export const CITY_LUMINANCE = 0.3;
/** Night-vision gain shared by all night glows. */
export const NIGHT_GAIN = LIGHTS_SCALE / (CITY_LUMINANCE / UNIT_LUMINANCE);

const H = 6.62607015e-34;
const C = 299792458;

/** Luminance (cd m⁻²) of a line of column emission rate 1 kR at wavelength nm. */
export function kiloRayleighLuminance(nm: number): number {
  const photons = 1e13 / (4 * Math.PI); // 1 kR, photons s⁻¹ m⁻² sr⁻¹
  const watts = photons * ((H * C) / (nm * 1e-9));
  return 683 * luminousEfficiency(nm) * watts;
}

/** Radiance (renderer units, with the night-vision gain) of 1 kR at wavelength nm. */
export const kiloRayleighRadiance = (nm: number) => (kiloRayleighLuminance(nm) / UNIT_LUMINANCE) * NIGHT_GAIN;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
// Vertical emission profiles (altitude km → relative volume emission), exactly as in AURORA_GLSL.
export const auroraGreenProfile = (h: number) => smooth(88, 102, h) * Math.exp(-Math.max(h - 112, 0) / 38) * Math.exp(-Math.max(108 - h, 0) / 6);
export const auroraRedProfile = (h: number) => smooth(150, 230, h) * Math.exp(-Math.max(h - 260, 0) / 90);
export const auroraBlueProfile = (h: number) => smooth(88, 102, h) * Math.exp(-Math.abs(h - 100) / 9);

/** Altitude range of the auroral emitting shell, km. */
export const AURORA_SHELL_KM: readonly [number, number] = [88, 420];

/** ∫ profile dh over the auroral shell, km (vertical column of a unit-strength curtain). */
export function profileColumnKm(f: (h: number) => number, h0 = AURORA_SHELL_KM[0], h1 = AURORA_SHELL_KM[1], n = 4000): number {
  let s = 0;
  const dh = (h1 - h0) / n;
  for (let i = 0; i < n; i++) s += f(h0 + (i + 0.5) * dh);
  return s * dh;
}

/** Column emission rates of a bright auroral arc (curtain strength 1), kR. */
export const AURORA_BRIGHT_KR = { green: 100, red: 20, blue: 25 } as const;

export const AURORA_LINES_NM = { green: 557.73, red: 630.03, blue: 427.81 } as const;

/**
 * Luminance gain of each auroral line per unit profile per planet radius of path, so that looking
 * straight down through a curtain of strength 1 gives the bright-arc column rates above.
 */
export function auroraLineGains(radiusKm: number): { green: number; red: number; blue: number } {
  const g = (line: 'green' | 'red' | 'blue', f: (h: number) => number) =>
    (AURORA_BRIGHT_KR[line] * kiloRayleighRadiance(AURORA_LINES_NM[line])) / (profileColumnKm(f) / radiusKm);
  return { green: g('green', auroraGreenProfile), red: g('red', auroraRedProfile), blue: g('blue', auroraBlueProfile) };
}

/** Sample counts for the planet's ray integrals at a quality detail level (QualityProfile.detail). */
export interface PlanetSteps {
  /** Atmosphere samples above the cloud deck (whole ray without clouds: above + below). */
  above: number;
  /** Atmosphere samples from the cloud deck to the ground. */
  below: number;
  /** Atmosphere samples along limb rays. */
  limb: number;
  /** Aurora samples below / above 200 km, airglow samples. */
  auroraLow: number;
  auroraHigh: number;
  airglow: number;
  /** Runtime procedural detail: 0 none, 1 reduced, 2 full. */
  detailLevel: 0 | 1 | 2;
}

const clampRound = (x: number, lo: number, hi: number) => Math.round(Math.min(hi, Math.max(lo, x)));

export function planetSteps(detail: number): PlanetSteps {
  return {
    above: clampRound(10 * detail, 4, 16),
    below: detail >= 0.9 ? 4 : 3,
    limb: clampRound(16 * detail, 8, 24),
    auroraLow: clampRound(10 * detail, 4, 16),
    auroraHigh: clampRound(6 * detail, 3, 10),
    airglow: clampRound(14 * detail, 5, 20),
    detailLevel: detail < 0.5 ? 0 : detail < 0.9 ? 1 : 2,
  };
}
