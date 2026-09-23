# Module: worlds — Possible Worlds (procedural star systems)

- Experience id: `worlds` · Port: **5207**
- Owns: `src/experiences/worlds/**`, `src/worlds/systems/**` (generator + layer),
  `tests/worlds.test.ts`.
- Uses: `createPlanet` / `createStar` (contract in `src/worlds/planet/types.ts`, upgraded in
  parallel by `planets`).

## Goal
Every seed is a new, physically plausible star system. Jump through a portal and land somewhere
no one has seen: a red dwarf with a tidally locked eyeball world, a hot Jupiter skimming a
yellow star, a circumbinary desert planet with two sunsets, a resonant chain of seven rocky worlds.

## Physics (required)
- Primary star mass from the **Kroupa IMF** (so most systems are M dwarfs, as in reality); main-
  sequence relations for L, R, T_eff (piecewise mass–luminosity; T from Stefan–Boltzmann); ages;
  occasional giants/white dwarfs. **Binaries** (~ 35–50% for Sun-like stars, fewer for M dwarfs):
  S-type and P-type (circumbinary) configurations with stability limits (Holman & Wiegert 1999).
- Planets: disk mass ∝ M★; snow line ≈ 2.7 AU (L/L☉)^{1/2}; spacing by mutual Hill radii
  (Δ ≈ 10–25 R_H) → stable; masses drawn from Kepler-like occurrence (super-Earths / sub-Neptunes
  most common, giants beyond the snow line more likely for metal-rich/massive stars), occasional
  migration (hot Jupiters), resonant chains around M dwarfs (TRAPPIST-1-like period ratios).
- Radius from mass (Chen & Kipping 2017 forecaster regimes), equilibrium temperature
  T_eq = T★ √(R★/2a) (1−A)^{1/4}; habitable zone from **Kopparapu et al. 2013/2014**; tidal locking
  for close-in planets (locking timescale) → eyeball worlds (day side hot, night side ice).
- Map physics to `PlanetSpec.kind` + parameters (ocean fraction, ice, clouds, atmosphere
  presets, rings for some giants, moons for giants).
- Deterministic from the seed via `Rng.fork` (src/physics/random.ts). Procedural names
  (catalogue-style "TWU-48213 b" + an evocative given name).

## Visuals & interaction
- System view: star(s) (`createStar`), planets on Kepler orbits (animated), orbit lines, the
  habitable zone as a faint green-teal annulus, snow line, labels. Click a planet → fly to it,
  planet close-up with `createPlanet`, info card (mass, radius, period, T_eq, HZ status,
  composition guess, day length, tidal lock).
- **Portal jump** ("Next world"): a tasteful swirling portal transition (green, Rick-and-Morty
  wink, still elegant) into a new seed; seed shown and editable; "surprise me" filters (habitable
  world, binary sunset, hot Jupiter, ringed giant, resonant chain).
- From a planet's surface/low orbit: its star(s) in the sky at correct angular size and colour.

## Exports for Voyage
`src/worlds/systems/`: `generateSystem(seed, starHint?)` → pure data;
`SystemLayer` renders a generated system in AU (camera-relative), with picking.

## Acceptance
Screenshots: 5 different seeds covering an M-dwarf system, a binary, a Sun-like system with a
temperate world, a hot Jupiter, a ringed giant close-up; portal mid-transition. Tests: IMF
distribution, HZ boundaries for the Sun (~0.95–1.67 AU conservative), stability spacing.
