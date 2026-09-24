import type { PlanetSpec } from './types';
import { Planet, type PlanetRenderer } from './Planet';

export type * from './types';
export type { PlanetRenderer, PlanetOptions } from './Planet';
export { Planet } from './Planet';
export { PLANET_PRESETS, planetSpec, type PlanetPreset, type PlanetPresetName } from './presets';

/**
 * Create a planet (planets module): a ray-traced sphere/ellipsoid with a physically scattered
 * atmosphere (Rayleigh + Mie + ozone, multiple scattering), clouds that cast shadows, real Earth
 * imagery or a GPU-baked procedural surface per kind, city lights, aurora and airglow, rings with
 * single-scattering photometry and mutual shadows, and a flux-conserving point when sub-pixel.
 *
 * Usage (unchanged contract): add `view.object` to your scene, call `view.update({...})` each frame
 * with the star position, and `view.setRotation(angle)`. Optionally call `view.prepare(renderer)`
 * during loading so GPU baking does not happen on the first visible frame.
 */
export function createPlanet(spec: PlanetSpec): PlanetRenderer {
  return new Planet(spec);
}
