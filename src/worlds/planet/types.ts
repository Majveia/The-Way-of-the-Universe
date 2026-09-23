import type * as THREE from 'three';

/**
 * CONTRACT between the planet renderer (owned by the `planets` module) and every world that
 * shows planets (solar, worlds, earth, voyage). Keep this stable; extend only additively.
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
}

export interface RingSpec {
  /** Inner/outer radius in planet radii (Saturn ≈ 1.24 → 2.27). */
  inner: number;
  outer: number;
  /** Base colour (linear RGB 0..1). */
  color?: [number, number, number];
  opacity?: number;
  seed?: number;
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
}

export interface PlanetUpdate {
  /** Seconds (drives cloud motion, rotation of banding, lava flicker). */
  time: number;
  /** Star position in the same world space as the planet object. */
  sunPosition: THREE.Vector3;
  /** Star colour × intensity (linear). Defaults to white 1. */
  sunColor?: THREE.Color;
  camera: THREE.Camera;
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
}

export interface StarView {
  readonly object: THREE.Object3D;
  readonly spec: StarSpec;
  update(u: { time: number; camera: THREE.Camera }): void;
  dispose(): void;
}
