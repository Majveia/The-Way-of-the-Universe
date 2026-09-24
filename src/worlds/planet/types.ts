import type * as THREE from 'three';

/**
 * CONTRACT between the planet renderer (owned by the `planets` module) and every world that
 * shows planets (solar, worlds, earth, voyage). Keep this stable; extend only additively.
 *
 * Extensions added by the planets module are all optional and marked "(ext)".
 */
export type PlanetKind =
  | 'earth' // real Earth imagery
  | 'terrestrial' // procedural Earth-like: oceans, continents, biomes
  | 'ocean' // global ocean, scattered islands
  | 'desert' // Mars/Tatooine-like
  | 'lava' // young/tidally heated, glowing cracks
  | 'ice' // Europa/Enceladus/snowball
  | 'barren' // cratered, airless (Moon, Mercury)
  | 'venus' // thick sulphuric clouds
  | 'gas-giant' // Jupiter/Saturn-like banded
  | 'ice-giant'; // Uranus/Neptune-like

/** (ext) Physical atmosphere presets (see src/physics/planets-atmosphere.ts). */
export type AtmospherePreset = 'earth' | 'mars' | 'venus' | 'titan' | 'jupiter' | 'ice-giant';

export interface AtmosphereSpec {
  /** Rayleigh scattering coefficients at sea level, per planet radius (Earth ≈ (5.8,13.5,33.1)e-6 /m × R). */
  rayleigh?: [number, number, number];
  /** Mie scattering coefficient at sea level, per planet radius. */
  mie?: number;
  /** Mie anisotropy g (0.7–0.85 for haze). */
  mieG?: number;
  /** Rayleigh scale height as a fraction of radius (Earth 8 km / 6371 km ≈ 0.00126). */
  scaleHeight?: number;
  /** Atmosphere top as a fraction of radius above the surface (Earth ≈ 0.0157 for 100 km). */
  thickness?: number;
  /** Optional absorption (e.g. ozone) coefficients per radius. */
  absorption?: [number, number, number];
  /** Artistic tint multiplier (defaults to physical). */
  tint?: [number, number, number];

  /** (ext) Start from a physical preset; any field given here overrides it. */
  preset?: AtmospherePreset;
  /** (ext) Per-channel multiplier on `mie` (coloured dust or haze). */
  mieColor?: [number, number, number];
  /** (ext) Mie absorption per radius (scalar or per channel). Default: mie / 9 (ϖ₀ ≈ 0.9). */
  mieAbsorption?: number | [number, number, number];
  /** (ext) Per-channel Mie asymmetry (overrides mieG) — e.g. Martian dust, bluer forward peak. */
  mieGRGB?: [number, number, number];
  /** (ext) Mie scale height as a fraction of radius. */
  mieScaleHeight?: number;
  /** (ext) Absorbing layer centre altitude and half-width, fractions of radius (ozone: 25 km, 15 km). */
  absorptionCenter?: number;
  absorptionWidth?: number;
  /** (ext) Mean surface albedo seen by multiply-scattered light. */
  groundAlbedo?: [number, number, number];
  /** (ext) Scale of the scattered light (1 = physical). */
  intensity?: number;
}

export interface RingSpec {
  /** Inner/outer radius in planet radii (Saturn ≈ 1.24 → 2.27). */
  inner: number;
  outer: number;
  /** Base colour (linear RGB 0..1). */
  color?: [number, number, number];
  opacity?: number;
  seed?: number;
  /** (ext) Use Saturn's measured optical-depth profile (C, B, Cassini Division, A, Encke gap). */
  saturn?: boolean;
  /** (ext) Fraction of fine dust (0..1): forward-scattering glow when backlit. */
  dust?: number;
}

export interface PlanetSpec {
  seed: number;
  kind: PlanetKind;
  /** Radius in the caller's scene units. */
  radius: number;
  /** Physical radius (for detail scales/labels), km. */
  radiusKm?: number;
  /** Equilibrium temperature, K (drives biome colours, ice, lava glow). */
  temperatureK?: number;
  /** 0..1 fraction of surface under ocean (terrestrial/ocean). */
  oceanFraction?: number;
  /** 0..1 polar ice extent. */
  ice?: number;
  /** 0..1 vegetation cover. */
  vegetation?: number;
  /** 0..1 cloud cover (0 = none). */
  clouds?: number;
  /** 0..1 night-side city lights (inhabited worlds). */
  cityLights?: number;
  /** null = airless. */
  atmosphere?: AtmosphereSpec | null;
  rings?: RingSpec | null;
  /** Gas/ice giant band palette (linear RGB), light→dark. */
  bands?: Array<[number, number, number]>;
  /** Named storm (e.g. a Great Red Spot) on gas giants. */
  storm?: boolean;
  /** Axial tilt, radians (the caller orients `object`; stored for reference). */
  axialTilt?: number;

  /** (ext) Rendering detail multiplier like QualityProfile.detail (0.35–1.6): bake resolution, march steps. */
  detail?: number;
  /** (ext) Bundled real imagery for this body ('moon' → LRO colour + LOLA relief). */
  texture?: 'moon';
  /** (ext) Polar hexagon (Saturn) on gas giants. */
  hexagon?: boolean;
  /** (ext) 0..1 aurora on the night side (default 0.6 for kind 'earth'). */
  aurora?: number;
  /** (ext) 0..1 airglow layer (default 0.5 for kind 'earth'). */
  airglow?: number;
  /** (ext) Base albedo tint (linear RGB) for rocky/icy kinds. */
  color?: [number, number, number];
  /** (ext) Relief lighting exaggeration (1 = physical; default depends on kind). */
  relief?: number;
  /** (ext) Near-surface wind speed for the ocean glint roughness (Cox–Munk), m/s (default 7). */
  windSpeed?: number;
  /** (ext) Peak temperature of molten rock in lava cracks/lakes, K (default 1400). */
  lavaTemperatureK?: number;
  /** (ext) Polar flattening f = 1 − b/a (Jupiter 0.065, Saturn 0.098). */
  oblateness?: number;
  /** (ext) Crater density 0..1 for rocky kinds. */
  craters?: number;
}

export interface PlanetUpdate {
  /** Seconds (drives cloud motion, rotation of banding, lava flicker). */
  time: number;
  /** Star position in the same world space as the planet object. */
  sunPosition: THREE.Vector3;
  /** Star colour × intensity (linear). Defaults to white 1. */
  sunColor?: THREE.Color;
  camera: THREE.Camera;
  /** (ext) Angular radius of the star as seen from the planet, rad (default: the Sun from 1 AU, 0.00465). */
  sunAngularRadius?: number;
  /** (ext) Renderer, so GPU resources can be prepared outside the render pass. */
  renderer?: THREE.WebGLRenderer;
}

export interface PlanetView {
  /** Centered at its local origin, radius = spec.radius, spin axis = local +Y. */
  readonly object: THREE.Object3D;
  readonly spec: PlanetSpec;
  update(u: PlanetUpdate): void;
  /** Spin about the local +Y axis (radians). */
  setRotation(angle: number): void;
  dispose(): void;
}

export interface StarSpec {
  seed: number;
  /** Effective temperature, K. */
  temperatureK: number;
  /** Radius in the caller's scene units. */
  radius: number;
  /** Relative surface brightness multiplier (1 = default exposure-friendly). */
  intensity?: number;
  /** (ext) Magnetic activity 0..1: sunspots, faculae, prominences (default 0.5). */
  activity?: number;
  /** (ext) Corona brightness multiplier (default 1). */
  corona?: number;
  /** (ext) Rendering detail multiplier (0.35–1.6). */
  detail?: number;
}

export interface StarView {
  readonly object: THREE.Object3D;
  readonly spec: StarSpec;
  update(u: { time: number; camera: THREE.Camera }): void;
  dispose(): void;
}
