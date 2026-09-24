/**
 * Possible Worlds — procedural star systems (module `worlds`).
 *
 *   generateSystem(seed, hint?)  → SystemData (pure, deterministic)
 *   findSeed(feature, start)     → first seed with a feature ('habitable', 'binary-sunset', …)
 *   new SystemLayer(sys, opts)   → renders a system in (mapped) AU with picking
 *   new WorldCloseup(layer, i, renderer) → one planet at true scale, star(s) at true size/distance
 */
export * from './generate';
export * from './stellar';
export * from './planets';
export { SystemLayer, starIntensity, adaptedLight, ADAPTATION, type SystemLayerOptions, type BodyEntry } from './SystemLayer';
export { WorldCloseup } from './Closeup';
export { EyeballIce, eyeballOpening } from './eyeball';
export { catalogueName, givenName } from './names';
