/**
 * Planetary atmospheres for rendering (planets module).
 *
 * Single-scattering model with exponential Rayleigh and Mie layers and a tent-shaped absorbing
 * layer (ozone on Earth), as in Bruneton & Neyret (2008) / Bruneton (2017, "Precomputed Atmospheric
 * Scattering: a New Implementation") and Hillaire (2020, "A Scalable and Production Ready Sky and
 * Atmosphere Rendering Technique", EGSR). Multiple scattering is added on the GPU with Hillaire's
 * isotropic second-order LUT. These CPU functions are the reference the shaders mirror and the
 * unit tests check.
 *
 * Units: SI (metres, 1/m) here. The renderer works in planet radii: multiply coefficients by R and
 * divide lengths by R (`toRendererUnits`).
 */
import type { AtmosphereSpec } from '../worlds/planet/types';

export type RGB = [number, number, number];

export interface AtmosphereParams {
  /** Planet (ground) radius, m. */
  radius: number;
  /** Height of the top of the atmosphere above the ground, m. */
  height: number;
  /** Rayleigh scattering at the ground, 1/m (per channel ≈ 680, 550, 440 nm). */
  rayleigh: RGB;
  rayleighScaleHeight: number;
  /** Mie (aerosol/dust/haze) scattering and absorption at the ground, 1/m. */
  mieScattering: RGB;
  mieAbsorption: RGB;
  mieScaleHeight: number;
  /** Henyey–Greenstein asymmetry per channel. */
  mieG: RGB;
  /** Absorbing layer (e.g. ozone): peak absorption 1/m, centre altitude and half-width (m). */
  absorption: RGB;
  absorptionCenter: number;
  absorptionWidth: number;
  /** Mean ground albedo seen by multiply-scattered light. */
  groundAlbedo: RGB;
}

const E6 = 1e-6;

/**
 * Earth: Rayleigh from Bucholtz (1995) at 680/550/440 nm; Mie β = 21e-6 /m (β_ext = β/0.9),
 * H_M = 1.2 km, g = 0.76 (Bruneton 2008); ozone absorption cross-sections (Gorshelev 2014/Serdyuchenko)
 * × a 25 km-centred profile, as in Bruneton (2017).
 */
export const EARTH_ATMOSPHERE: AtmosphereParams = {
  radius: 6_371e3,
  height: 100e3,
  rayleigh: [5.802 * E6, 13.558 * E6, 33.1 * E6],
  rayleighScaleHeight: 8e3,
  mieScattering: [21 * E6, 21 * E6, 21 * E6],
  mieAbsorption: [2.33 * E6, 2.33 * E6, 2.33 * E6],
  mieScaleHeight: 1.2e3,
  mieG: [0.76, 0.76, 0.76],
  absorption: [0.65 * E6, 1.881 * E6, 0.085 * E6],
  absorptionCenter: 25e3,
  absorptionWidth: 15e3,
  groundAlbedo: [0.3, 0.3, 0.3],
};

/**
 * Mars: 6 mbar CO₂ (Rayleigh ≈ 1/60 of Earth's column, CO₂ cross-section ≈ 2.5× N₂) and suspended
 * ~1.5 µm dust with scale height ≈ 11 km, optical depth τ ≈ 0.5. Dust absorbs blue (iron oxides;
 * ϖ₀ ≈ 0.97 red, 0.62 blue — Ockert-Bell et al. 1997) → butterscotch sky; its diffraction peak is
 * narrower in the blue (larger size parameter) → blue sunsets (Ehlers et al. 2014).
 */
export const MARS_ATMOSPHERE: AtmosphereParams = {
  radius: 3_389.5e3,
  height: 90e3,
  rayleigh: [0.19 * E6, 0.44 * E6, 1.08 * E6],
  rayleighScaleHeight: 11.1e3,
  mieScattering: [43 * E6, 37 * E6, 24 * E6],
  mieAbsorption: [1.5 * E6, 5.5 * E6, 15 * E6],
  mieScaleHeight: 11e3,
  mieG: [0.63, 0.7, 0.83],
  absorption: [0, 0, 0],
  absorptionCenter: 25e3,
  absorptionWidth: 10e3,
  groundAlbedo: [0.35, 0.2, 0.12],
};

/**
 * Venus above the cloud deck (the visible "surface" is the cloud top at ~70 km): a sulphuric-acid
 * haze with H ≈ 5 km that scatters strongly and absorbs slightly in the blue/UV (the unknown UV
 * absorber), giving the creamy-yellow colour; the upper haze makes the limb glow when backlit.
 */
export const VENUS_ATMOSPHERE: AtmosphereParams = {
  radius: 6_121.8e3,
  height: 60e3,
  rayleigh: [2.2 * E6, 5.1 * E6, 12.5 * E6],
  rayleighScaleHeight: 5e3,
  mieScattering: [60 * E6, 58 * E6, 50 * E6],
  mieAbsorption: [0.6 * E6, 1.6 * E6, 6 * E6],
  mieScaleHeight: 4.5e3,
  mieG: [0.74, 0.74, 0.76],
  absorption: [0, 0, 0],
  absorptionCenter: 20e3,
  absorptionWidth: 10e3,
  groundAlbedo: [0.85, 0.78, 0.6],
};

/**
 * Titan: an extended organic (tholin) haze, H ≈ 40–60 km, that absorbs strongly in the blue and
 * scatters red/orange; small haze particles high up scatter blue (the detached blue haze layer
 * seen by Cassini at the limb).
 */
export const TITAN_ATMOSPHERE: AtmosphereParams = {
  radius: 2_574.7e3,
  height: 600e3,
  rayleigh: [1.1 * E6, 3.0 * E6, 8.4 * E6],
  rayleighScaleHeight: 60e3,
  mieScattering: [9 * E6, 6.5 * E6, 3.2 * E6],
  mieAbsorption: [1.2 * E6, 3.6 * E6, 9.5 * E6],
  mieScaleHeight: 45e3,
  mieG: [0.62, 0.6, 0.55],
  absorption: [0, 0, 0],
  absorptionCenter: 100e3,
  absorptionWidth: 50e3,
  groundAlbedo: [0.2, 0.15, 0.1],
};

/** Jupiter's upper troposphere above the ammonia clouds: H₂ Rayleigh + thin haze (H ≈ 27 km). */
export const JUPITER_ATMOSPHERE: AtmosphereParams = {
  radius: 69_911e3,
  height: 700e3,
  rayleigh: [0.9 * E6, 2.1 * E6, 5.2 * E6],
  rayleighScaleHeight: 27e3,
  mieScattering: [2.2 * E6, 2.1 * E6, 1.8 * E6],
  mieAbsorption: [0.3 * E6, 0.5 * E6, 1.2 * E6],
  mieScaleHeight: 30e3,
  mieG: [0.7, 0.7, 0.7],
  absorption: [0, 0, 0],
  absorptionCenter: 100e3,
  absorptionWidth: 50e3,
  groundAlbedo: [0.5, 0.45, 0.38],
};

/** Neptune/Uranus: deep H₂–He–CH₄ with methane absorbing red → cyan/azure (Irwin et al. 2022). */
export const ICE_GIANT_ATMOSPHERE: AtmosphereParams = {
  radius: 24_622e3,
  height: 450e3,
  rayleigh: [0.8 * E6, 2.0 * E6, 4.8 * E6],
  rayleighScaleHeight: 20e3,
  mieScattering: [1.0 * E6, 1.0 * E6, 1.0 * E6],
  mieAbsorption: [1.6 * E6, 0.25 * E6, 0.1 * E6],
  mieScaleHeight: 25e3,
  mieG: [0.65, 0.65, 0.65],
  absorption: [3.0 * E6, 0.6 * E6, 0.05 * E6],
  absorptionCenter: 50e3,
  absorptionWidth: 60e3,
  groundAlbedo: [0.3, 0.5, 0.6],
};

export const ATMOSPHERE_PRESETS = {
  earth: EARTH_ATMOSPHERE,
  mars: MARS_ATMOSPHERE,
  venus: VENUS_ATMOSPHERE,
  titan: TITAN_ATMOSPHERE,
  jupiter: JUPITER_ATMOSPHERE,
  'ice-giant': ICE_GIANT_ATMOSPHERE,
} as const;
export type AtmospherePresetName = keyof typeof ATMOSPHERE_PRESETS;

// ——— Density profiles ———
export const rayleighDensity = (p: AtmosphereParams, h: number) => Math.exp(-h / p.rayleighScaleHeight);
export const mieDensity = (p: AtmosphereParams, h: number) => Math.exp(-h / p.mieScaleHeight);
export const absorptionDensity = (p: AtmosphereParams, h: number) =>
  Math.max(0, 1 - Math.abs(h - p.absorptionCenter) / p.absorptionWidth);

/** Extinction coefficient σ_t(h) per channel, 1/m. */
export function extinction(p: AtmosphereParams, h: number, out: RGB = [0, 0, 0]): RGB {
  const r = rayleighDensity(p, h), m = mieDensity(p, h), a = absorptionDensity(p, h);
  for (let c = 0; c < 3; c++) out[c] = p.rayleigh[c] * r + (p.mieScattering[c] + p.mieAbsorption[c]) * m + p.absorption[c] * a;
  return out;
}

/** Distance from radius r along direction cosine μ (w.r.t. local vertical) to the sphere of radius R (outside hit), or −1. */
export function distanceToSphere(r: number, mu: number, R: number): number {
  const disc = r * r * (mu * mu - 1) + R * R;
  if (disc < 0) return -1;
  return -r * mu + Math.sqrt(disc);
}

/** True if the ray from radius r with direction cosine μ hits the ground (radius R). */
export function rayHitsGround(r: number, mu: number, R: number): boolean {
  return mu < 0 && r * r * (mu * mu - 1) + R * R >= 0;
}

/**
 * Optical depth (per channel) from altitude h0 along a ray with zenith cosine μ to the top of the
 * atmosphere. Returns Infinity if the ray hits the ground. Midpoint rule with `steps` samples.
 */
export function opticalDepthToTop(p: AtmosphereParams, h0: number, mu: number, steps = 256): RGB {
  const r = p.radius + h0;
  const top = p.radius + p.height;
  if (rayHitsGround(r, mu, p.radius)) return [Infinity, Infinity, Infinity];
  const d = distanceToSphere(r, mu, top);
  const tau: RGB = [0, 0, 0];
  const e: RGB = [0, 0, 0];
  const dt = d / steps;
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * dt;
    const ri = Math.sqrt(r * r + t * t + 2 * r * mu * t);
    extinction(p, ri - p.radius, e);
    tau[0] += e[0] * dt;
    tau[1] += e[1] * dt;
    tau[2] += e[2] * dt;
  }
  return tau;
}

/** Transmittance to the top of the atmosphere (per channel). */
export function transmittanceToTop(p: AtmosphereParams, h0: number, mu: number, steps = 256): RGB {
  const t = opticalDepthToTop(p, h0, mu, steps);
  return [Math.exp(-t[0]), Math.exp(-t[1]), Math.exp(-t[2])];
}

/** Vertical optical depth of the whole column (zenith), per channel. */
export const zenithOpticalDepth = (p: AtmosphereParams) => opticalDepthToTop(p, 0, 1);

/**
 * Rayleigh scattering coefficient of a gas: β = 8π³(n²−1)² / (3 N λ⁴) · (6+3ρ)/(6−7ρ)
 * (King correction ρ = depolarisation ratio). n: refractive index, N: molecules per m³, λ: m.
 */
export function rayleighCoefficient(lambda: number, n: number, N: number, depolarization = 0.0279): number {
  const n2 = n * n - 1;
  const king = (6 + 3 * depolarization) / (6 - 7 * depolarization);
  return ((8 * Math.PI ** 3 * n2 * n2) / (3 * N * lambda ** 4)) * king;
}

/** Henyey–Greenstein phase function (normalised over 4π sr). */
export function phaseHG(cosTheta: number, g: number): number {
  const g2 = g * g;
  return (1 - g2) / (4 * Math.PI * Math.pow(1 + g2 - 2 * g * cosTheta, 1.5));
}
/** Rayleigh phase function (normalised over 4π sr). */
export const phaseRayleigh = (cosTheta: number) => (3 / (16 * Math.PI)) * (1 + cosTheta * cosTheta);

/**
 * Cox & Munk (1954) mean-square sea-surface slope for wind speed U (m/s, 12.5 m above the sea):
 * σ² = 0.003 + 5.12·10⁻³ U (clean surface). Used as the GGX roughness² of the ocean glint.
 */
export const coxMunkSlopeVariance = (windSpeed: number) => 0.003 + 5.12e-3 * windSpeed;

/** Schlick's approximation of Fresnel reflectance for an interface with normal-incidence reflectance F0. */
export const fresnelSchlick = (cosTheta: number, F0: number) => F0 + (1 - F0) * Math.pow(1 - Math.max(0, cosTheta), 5);
/** Normal-incidence reflectance between media of index 1 and n. */
export const fresnelF0 = (n: number) => ((n - 1) / (n + 1)) ** 2;

// ——— Contract bridge ———

/** Atmosphere in renderer units (lengths in planet radii, coefficients per radius). */
export interface AtmosphereRenderParams {
  top: number; // radius of the atmosphere top (ground = 1)
  rayleigh: RGB;
  rayleighH: number;
  mieScattering: RGB;
  mieExtinction: RGB;
  mieH: number;
  mieG: RGB;
  absorption: RGB;
  absorptionCenter: number;
  absorptionWidth: number;
  groundAlbedo: RGB;
  tint: RGB;
  /** Multiplier on scattered light (1 = physical). */
  intensity: number;
}

/** Physical params (SI) → renderer units. */
export function toRendererUnits(p: AtmosphereParams, tint: RGB = [1, 1, 1]): AtmosphereRenderParams {
  const R = p.radius;
  const s = (v: RGB): RGB => [v[0] * R, v[1] * R, v[2] * R];
  return {
    top: 1 + p.height / R,
    rayleigh: s(p.rayleigh),
    rayleighH: p.rayleighScaleHeight / R,
    mieScattering: s(p.mieScattering),
    mieExtinction: s([p.mieScattering[0] + p.mieAbsorption[0], p.mieScattering[1] + p.mieAbsorption[1], p.mieScattering[2] + p.mieAbsorption[2]]),
    mieH: p.mieScaleHeight / R,
    mieG: [...p.mieG] as RGB,
    absorption: s(p.absorption),
    absorptionCenter: p.absorptionCenter / R,
    absorptionWidth: p.absorptionWidth / R,
    groundAlbedo: [...p.groundAlbedo] as RGB,
    tint,
    intensity: 1,
  };
}

/**
 * Resolve the contract's `AtmosphereSpec` (coefficients per planet radius, heights as fractions of
 * the radius) into renderer units. Missing fields fall back to an Earth-like atmosphere scaled to the
 * planet's physical radius (`radiusKm`, default Earth's), i.e. the same air on a different world.
 */
export function resolveAtmosphereSpec(spec: AtmosphereSpec, radiusKm = 6371): AtmosphereRenderParams {
  const base = spec.preset ? ATMOSPHERE_PRESETS[spec.preset] : EARTH_ATMOSPHERE;
  const R = spec.preset ? base.radius : radiusKm * 1e3;
  const p = toRendererUnits({ ...base, radius: R });
  const ray = spec.rayleigh ?? p.rayleigh;
  const rayleighH = spec.scaleHeight ?? p.rayleighH;
  const mieS = spec.mie !== undefined ? spec.mie : null;
  const mieColor = spec.mieColor ?? [1, 1, 1];
  const mieScattering: RGB = mieS !== null ? [mieS * mieColor[0], mieS * mieColor[1], mieS * mieColor[2]] : p.mieScattering;
  const mieAbs = spec.mieAbsorption;
  const mieAbsRGB: RGB =
    mieAbs === undefined
      ? mieS !== null
        ? [mieScattering[0] / 9, mieScattering[1] / 9, mieScattering[2] / 9]
        : [p.mieExtinction[0] - p.mieScattering[0], p.mieExtinction[1] - p.mieScattering[1], p.mieExtinction[2] - p.mieScattering[2]]
      : typeof mieAbs === 'number'
        ? [mieAbs, mieAbs, mieAbs]
        : mieAbs;
  const g = spec.mieG;
  const mieG: RGB = spec.mieGRGB ? ([...spec.mieGRGB] as RGB) : g === undefined ? p.mieG : [g, g, g];
  // Default Mie scale height keeps Earth's H_M/H_R ratio when only the Rayleigh height is given.
  const mieH = spec.mieScaleHeight ?? (spec.scaleHeight !== undefined ? spec.scaleHeight * (p.mieH / p.rayleighH) : p.mieH);
  const top = 1 + (spec.thickness ?? Math.max(p.top - 1, 12.5 * Math.max(rayleighH, mieH)));
  return {
    top,
    rayleigh: [...ray] as RGB,
    rayleighH,
    mieScattering,
    mieExtinction: [mieScattering[0] + mieAbsRGB[0], mieScattering[1] + mieAbsRGB[1], mieScattering[2] + mieAbsRGB[2]],
    mieH,
    mieG,
    absorption: spec.absorption ? ([...spec.absorption] as RGB) : p.absorption,
    absorptionCenter: spec.absorptionCenter ?? p.absorptionCenter,
    absorptionWidth: spec.absorptionWidth ?? p.absorptionWidth,
    groundAlbedo: spec.groundAlbedo ?? p.groundAlbedo,
    tint: spec.tint ?? [1, 1, 1],
    intensity: spec.intensity ?? 1,
  };
}

/** Transmittance in renderer units (reference for the GPU LUT). h0 and results in radii. */
export function transmittanceRenderUnits(a: AtmosphereRenderParams, h0: number, mu: number, steps = 128): RGB {
  const r = 1 + h0;
  if (rayHitsGround(r, mu, 1)) return [0, 0, 0];
  const d = distanceToSphere(r, mu, a.top);
  const tau: RGB = [0, 0, 0];
  const dt = d / steps;
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * dt;
    const h = Math.sqrt(r * r + t * t + 2 * r * mu * t) - 1;
    const dr = Math.exp(-h / a.rayleighH);
    const dm = Math.exp(-h / a.mieH);
    const da = Math.max(0, 1 - Math.abs(h - a.absorptionCenter) / a.absorptionWidth);
    for (let c = 0; c < 3; c++) tau[c] += (a.rayleigh[c] * dr + a.mieExtinction[c] * dm + a.absorption[c] * da) * dt;
  }
  return [Math.exp(-tau[0]), Math.exp(-tau[1]), Math.exp(-tau[2])];
}
