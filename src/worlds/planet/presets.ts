import type { PlanetSpec } from './types';

const D = Math.PI / 180;

/** Everything except the caller-specific radius (scene units). */
export type PlanetPreset = Omit<PlanetSpec, 'radius' | 'seed'> & { seed?: number };

/**
 * Solar-system bodies and archetypal exoplanets, with physical radii, flattening, tilts and
 * atmosphere presets. Use `planetSpec('saturn', radiusInSceneUnits)`.
 */
export const PLANET_PRESETS = {
  earth: { kind: 'earth', radiusKm: 6371, axialTilt: 23.44 * D, clouds: 1, cityLights: 1, aurora: 0.7, airglow: 0.6 },
  moon: { kind: 'barren', texture: 'moon', radiusKm: 1737.4, axialTilt: 6.68 * D, atmosphere: null },
  mercury: { kind: 'barren', radiusKm: 2439.7, axialTilt: 0.03 * D, color: [1.08, 1.0, 0.92], craters: 1, atmosphere: null, seed: 11 },
  venus: { kind: 'venus', radiusKm: 6051.8, axialTilt: 177.4 * D, atmosphere: { preset: 'venus' }, seed: 2 },
  mars: { kind: 'desert', radiusKm: 3389.5, axialTilt: 25.19 * D, atmosphere: { preset: 'mars' }, ice: 0.25, craters: 0.5, seed: 4, oblateness: 0.00589 },
  jupiter: { kind: 'gas-giant', radiusKm: 69911, axialTilt: 3.13 * D, storm: true, oblateness: 0.06487, atmosphere: { preset: 'jupiter' }, seed: 5 },
  saturn: {
    kind: 'gas-giant',
    radiusKm: 58232,
    axialTilt: 26.73 * D,
    hexagon: true,
    oblateness: 0.09796,
    atmosphere: { preset: 'jupiter' },
    rings: { inner: 1.24, outer: 2.27, saturn: true, color: [0.93, 0.85, 0.72], dust: 0.3, seed: 6 },
    seed: 6,
  },
  uranus: {
    kind: 'ice-giant',
    radiusKm: 25362,
    axialTilt: 97.77 * D,
    oblateness: 0.02293,
    atmosphere: { preset: 'ice-giant' },
    bands: [[0.62, 0.8, 0.84], [0.57, 0.77, 0.81], [0.52, 0.73, 0.79], [0.48, 0.7, 0.77]],
    rings: { inner: 1.64, outer: 2.01, color: [0.35, 0.35, 0.36], dust: 0.15, opacity: 0.35, seed: 7 },
    seed: 7,
  },
  neptune: {
    kind: 'ice-giant',
    radiusKm: 24622,
    axialTilt: 28.32 * D,
    oblateness: 0.01708,
    atmosphere: { preset: 'ice-giant' },
    bands: [[0.32, 0.52, 0.86], [0.24, 0.42, 0.8], [0.17, 0.33, 0.7], [0.12, 0.25, 0.58]],
    storm: true,
    seed: 8,
  },
  titan: { kind: 'ice', radiusKm: 2574.7, atmosphere: { preset: 'titan' }, color: [0.8, 0.62, 0.4], seed: 9 },
  io: { kind: 'lava', radiusKm: 1821.6, temperatureK: 130, lavaTemperatureK: 1500, color: [1.4, 1.25, 0.6], seed: 10, atmosphere: null },
  europa: { kind: 'ice', radiusKm: 1560.8, seed: 12, atmosphere: null },
  // Archetypes for Possible Worlds.
  'terran': { kind: 'terrestrial', radiusKm: 6800, clouds: 0.6, cityLights: 0.7, oceanFraction: 0.64, atmosphere: {}, seed: 21 },
  'ocean-world': { kind: 'ocean', radiusKm: 9200, clouds: 0.75, oceanFraction: 0.97, atmosphere: { mie: 70 }, seed: 22 },
  'lava-world': { kind: 'lava', radiusKm: 7400, temperatureK: 1300, lavaTemperatureK: 1650, atmosphere: null, seed: 23 },
  'dune-world': { kind: 'desert', radiusKm: 5200, atmosphere: { preset: 'mars', mie: 120 }, ice: 0.1, color: [1.25, 1.05, 0.8], seed: 24 },
  'snowball': { kind: 'ice', radiusKm: 5900, atmosphere: {}, clouds: 0.25, seed: 25 },
  'hot-jupiter': {
    kind: 'gas-giant',
    radiusKm: 95000,
    temperatureK: 1400,
    bands: [[0.42, 0.33, 0.3], [0.3, 0.2, 0.18], [0.2, 0.12, 0.1], [0.12, 0.07, 0.06]],
    atmosphere: { preset: 'jupiter' },
    storm: true,
    seed: 26,
  },
} satisfies Record<string, PlanetPreset>;

export type PlanetPresetName = keyof typeof PLANET_PRESETS;

/** A full PlanetSpec from a preset, sized for the caller's scene. */
export function planetSpec(name: PlanetPresetName, radius: number, overrides: Partial<PlanetSpec> = {}): PlanetSpec {
  const p = PLANET_PRESETS[name] as PlanetPreset;
  return { seed: p.seed ?? 1, ...p, radius, ...overrides } as PlanetSpec;
}
