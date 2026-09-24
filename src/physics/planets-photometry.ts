/**
 * Photometry of planets, rings, clouds and stars (planets module). Pure functions, unit-tested;
 * the GLSL in src/worlds/planet and src/worlds/star mirrors them.
 *
 * Radiance convention used by the renderers: a white Lambertian surface lit at normal incidence by
 * a star of irradiance `E` (the `sunColor` of PlanetUpdate) has radiance `E` (i.e. E already
 * contains the 1/π). With the Sun at 1 AU, E = 1 and the solar disk radiance is 1/Ω☉·π ≈ 46 200.
 */
import { blackbodyRGB } from './blackbody';
import { wavelengthToRGB } from './spectrum';

/** Solid angle of the Sun's disk at 1 AU, sr. */
export const SUN_SOLID_ANGLE_1AU = Math.PI * Math.pow(6.957e8 / 1.495978707e11, 2);
/** Disk radiance of the Sun in renderer units when E(1 AU) = 1. */
export const SUN_RADIANCE_1AU = Math.PI / SUN_SOLID_ANGLE_1AU;

// ——— Stars ———

/**
 * Eddington grey atmosphere + Eddington–Barbier relation: the intensity leaving the photosphere at
 * direction cosine μ is ≈ the source function at optical depth τ = μ, with
 * T⁴(τ) = ¾ T_eff⁴ (τ + ⅔). Returns T(μ).
 */
export const limbTemperature = (Teff: number, mu: number) => Teff * Math.pow(0.75 * (Math.max(0, mu) + 2 / 3), 0.25);

/** Eddington bolometric limb darkening I(μ)/I(1) = (2 + 3μ)/5. */
export const eddingtonLimbDarkening = (mu: number) => (2 + 3 * Math.max(0, mu)) / 5;

/** Quadratic limb-darkening law I(μ)/I(1) = 1 − u₁(1−μ) − u₂(1−μ)². */
export const quadraticLimbDarkening = (mu: number, u1: number, u2: number) => {
  const m = 1 - Math.max(0, mu);
  return 1 - u1 * m - u2 * m * m;
};

/** hc/(λ k) for λ = 555 nm (peak of photopic vision), K. */
export const C2_555 = 6.62607015e-34 * 299792458 / (555e-9 * 1.380649e-23);

/** Planck radiance at 555 nm relative to a reference temperature: B₅₅₅(T)/B₅₅₅(T_ref). */
export function planckRatio555(T: number, Tref = 5772): number {
  return Math.expm1(C2_555 / Tref) / Math.expm1(C2_555 / Math.max(T, 1));
}

/**
 * Radiance of a blackbody at T in renderer units (linear RGB, luminance ≈ visible brightness),
 * scaled so the Sun's photosphere (5772 K) at 1 AU irradiance E = 1 gives SUN_RADIANCE_1AU.
 * Used for lava, glowing cracks and hot night sides.
 */
export function thermalRadiance(T: number): [number, number, number] {
  const k = SUN_RADIANCE_1AU * planckRatio555(T);
  const [r, g, b] = blackbodyRGB(T);
  return [r * k, g * k, b * k];
}

/**
 * Colour of starlight relative to the Sun's, white-balanced to the Sun (like NASA true-colour
 * imagery): the Sun → (1,1,1); a 3000 K M dwarf → orange-red; a 10 000 K A star → blue-white.
 * Luminance normalised to 1.
 */
export function starlightTint(T: number): [number, number, number] {
  const s = blackbodyRGB(5772);
  const c = blackbodyRGB(T);
  const t: [number, number, number] = [c[0] / s[0], c[1] / s[1], c[2] / s[2]];
  const y = 0.2126 * t[0] + 0.7152 * t[1] + 0.0722 * t[2];
  return [t[0] / y, t[1] / y, t[2] / y];
}

/** Irradiance (renderer units, 1 = Sun at 1 AU) from a star of luminance L (L☉) at distance d (AU). */
export const stellarIrradiance = (luminositySun: number, distanceAU: number) => luminositySun / (distanceAU * distanceAU);

// ——— Planetary disks ———

/** Lambert-sphere phase function Φ(α) = [sin α + (π − α) cos α]/π (Φ(0) = 1). */
export const lambertPhase = (alpha: number) => (Math.sin(alpha) + (Math.PI - alpha) * Math.cos(alpha)) / Math.PI;

/**
 * Disk-averaged radiance of a Lambertian sphere of albedo A lit by irradiance E, seen at phase angle α:
 * the full disk averages ⅔·A·E at α = 0 (∫cos θ over the disk = ⅔), times Φ(α).
 */
export const diskAverageRadiance = (albedo: number, E: number, alpha: number) => (2 / 3) * albedo * E * lambertPhase(alpha);

/**
 * Lommel–Seeliger law for dark, airless regoliths (Moon, Mercury): radiance ∝ μ₀/(μ₀ + μ).
 * Normalised so a surface at μ₀ = μ = 1 returns 1 (then multiply by albedo · E).
 */
export const lommelSeeliger = (mu0: number, mu: number) => (mu0 <= 0 ? 0 : (2 * mu0) / (mu0 + Math.max(mu, 1e-4)));

/** Minnaert limb darkening for giant-planet cloud decks: μ₀^k μ^(k−1). */
export const minnaert = (mu0: number, mu: number, k: number) => (mu0 <= 0 ? 0 : Math.pow(mu0, k) * Math.pow(Math.max(mu, 1e-3), k - 1));

// ——— Clouds ———

/**
 * Two-stream reflectance of a conservative (non-absorbing) scattering slab (Bohren 1987,
 * Am. J. Phys. 55, 524): R = (1−g)τ / (2 + (1−g)τ); transmittance T = 1 − R.
 */
export const cloudReflectance = (tau: number, g = 0.85) => {
  const t = (1 - g) * Math.max(0, tau);
  return t / (2 + t);
};

// ——— Planetary rings (single scattering in a thin layer, Chandrasekhar 1960; Cuzzi et al. 1984) ———

/**
 * Lambert-sphere particle phase function for macroscopic ring particles, normalised over 4π:
 * P(α) = 8/(3π) [sin α + (π − α) cos α], α = phase angle (0 = backscatter).
 */
export const ringParticlePhase = (alpha: number) => ((8 / (3 * Math.PI)) * (Math.sin(alpha) + (Math.PI - alpha) * Math.cos(alpha)));

/**
 * Reflected radiance (renderer units) of a ring of normal optical depth τ, viewer on the lit face.
 * I = E ϖ₀ P/4 · μ₀/(μ + μ₀) · [1 − exp(−τ(1/μ + 1/μ₀))].
 */
export function ringReflected(tau: number, mu0: number, mu: number, albedo: number, P: number, E = 1): number {
  if (mu0 <= 0 || mu <= 0) return 0;
  return ((E * albedo * P) / 4) * (mu0 / (mu + mu0)) * (1 - Math.exp(-tau * (1 / mu + 1 / mu0)));
}

/**
 * Diffusely transmitted radiance, viewer on the unlit face.
 * I = E ϖ₀ P/4 · μ₀/(μ − μ₀) · [exp(−τ/μ) − exp(−τ/μ₀)]  (limit μ → μ₀: E ϖ₀ P/4 · τ/μ₀ · e^{−τ/μ₀}).
 * Bright for moderate τ (C ring, Cassini division), dark for τ → 0 and τ → ∞ (B ring) — the
 * famous reversal between the lit and unlit faces of Saturn's rings.
 */
export function ringTransmitted(tau: number, mu0: number, mu: number, albedo: number, P: number, E = 1): number {
  if (mu0 <= 0 || mu <= 0) return 0;
  const k = (E * albedo * P) / 4;
  if (Math.abs(mu - mu0) < 1e-4) return k * (tau / mu0) * Math.exp(-tau / mu0);
  return k * (mu0 / (mu - mu0)) * (Math.exp(-tau / mu) - Math.exp(-tau / mu0));
}

/** Direct transmission of background light through a ring along a line of sight: exp(−τ/μ). */
export const ringOpacity = (tau: number, mu: number) => 1 - Math.exp(-tau / Math.max(mu, 1e-4));

/**
 * Saturn's main rings, normal optical depth vs radius (Saturn radii, 60 268 km), smoothed from
 * Voyager/Cassini occultation profiles (Colwell et al. 2009): C ring 1.24–1.53, B ring 1.53–1.95,
 * Cassini Division 1.95–2.03, A ring 2.03–2.27 with the Encke (2.214) and Keeler (2.265) gaps.
 */
export function saturnRingTau(r: number): number {
  if (r < 1.239 || r > 2.27) return 0;
  if (r < 1.527) {
    // C ring: faint with plateaus
    const plateau = [1.35, 1.38, 1.44, 1.47, 1.49].some((c) => Math.abs(r - c) < 0.008) ? 0.35 : 0;
    return 0.08 + 0.05 * (r - 1.239) / 0.29 + plateau;
  }
  if (r < 1.95) {
    // B ring: B1 (τ≈1–2) inner, B2–B3 core (τ > 3), B4 outer
    const x = (r - 1.527) / (1.95 - 1.527);
    return x < 0.15 ? 1.1 + 1.2 * x / 0.15 : x < 0.8 ? 3.2 + 1.0 * Math.sin(x * 23) * 0.5 : 2.2;
  }
  if (r < 2.028) {
    // Cassini Division: τ ≈ 0.1 with ringlets
    return 0.08 + ([1.99, 2.0, 2.01].some((c) => Math.abs(r - c) < 0.003) ? 0.25 : 0);
  }
  // A ring, with Encke and Keeler gaps
  if (Math.abs(r - 2.214) < 0.0027 || Math.abs(r - 2.265) < 0.0006) return 0.01;
  return 0.5 + 0.2 * (1 - (r - 2.028) / 0.24);
}

// ——— Aurora and airglow line colours ———

/**
 * Emission lines of the upper atmosphere (air wavelengths, nm): the auroral/airglow green line of
 * atomic oxygen O(¹S→¹D) at 557.7 nm (peaks ~100–150 km), the red doublet O(¹D→³P) at 630.0 nm
 * (above ~200 km, long radiative lifetime so it is quenched lower down), the violet-blue N₂⁺ first
 * negative band at 427.8 nm (lower edge of energetic aurora) and the sodium D lines at 589 nm
 * (mesospheric Na layer, ~92 km).
 */
export const AURORA_LINES = { OI_GREEN: 557.73, OI_RED: 630.03, N2_PLUS: 427.81, NA_D: 589.0 } as const;

/** Linear sRGB colour (luminance 1, gamut-mapped) of a spectral line. */
export const lineColor = (nm: number) => wavelengthToRGB(nm);
