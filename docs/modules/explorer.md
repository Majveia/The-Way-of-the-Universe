# Module: explorer — the seamless universe (Voyage phase 2)

- Experience id: `voyage` · Port: **5211**
- Owns: `src/experiences/voyage/**`, new `src/worlds/explorer/**`, `tests/explorer.test.ts`.
  Read-only (use their public APIs; do not edit): every other `src/worlds/*` module.
  If a module API truly lacks something, add the smallest additive method and report it.

## Goal
Turn Starflight into the flagship: one continuous, flyable universe. Start among the stars
near the Sun (as Starflight does now), and let the traveller rise out of the galaxy to the
cosmic web, dive into another galaxy, to one of its stars, and down to a planet — with no
loading screens and no seams. "No Man's Sky × Cosmos: Possible Worlds", but physically honest.

## Scale hierarchy (native units per layer, float64 camera state)
1. **Universe** (Mpc): `CosmicWebLayer` (src/worlds/cosmicweb) — dark-matter web at z = 0
   (fade it out as a "dark matter" overlay near galaxies; galaxies stay as sprites), halo list →
   galaxies. Pick a Milky-Way-mass halo in a filament as home; place Andromeda at 0.78 Mpc.
2. **Galaxy** (pc): `GalaxyLayer` (src/worlds/galaxy) for the nearest/entered galaxy; Milky Way
   preset for home (Sun at 8.2 kpc), seeded morphologies elsewhere (ellipticals in dense halos).
   Nebulae (`NebulaVolume`, src/worlds/nebula) at a few HII regions in the arms; Sgr A* at the
   centre → `BlackHoleRenderer` (src/worlds/blackhole) when close.
3. **Star system** (AU): at the Sun → `SolarSystemModel` + `SolarSystemLayer` (src/worlds/solar);
   at any other star → `generateSystem(seed, { mass, teff })` + `SystemLayer` (src/worlds/systems).
4. **Planet** (planet radii / km): `createPlanet` close-ups (as in worlds Closeup / earth).
- Camera: a frame stack (universe → galaxy → system → planet) holding position in the deepest
  frame in float64; convert up/down with each frame's origin, scale and orientation. Enter a
  child frame inside its entry radius, leave beyond an exit radius (hysteresis). Render
  back-to-front: sky/background → outer layers → inner layers, clearing depth between layers,
  each with its own near/far. Cross-fade layers over their transition band so nothing pops.
- Speed scales with distance to the nearest body (SpaceEngine-style), from km/s at a planet to
  Mpc/s between galaxies; label superluminal travel as the "imagination drive". Keep the ship
  (src/worlds/ship) and relativistic sky at sub-light speeds.

## Navigation & UI
- Destinations list / search (Earth, Moon, Mars, Jupiter, Saturn, Sun, Alpha Centauri, Sirius,
  Betelgeuse, Orion Nebula, Sgr A*, the Milky Way from outside, Andromeda, the cosmic web,
  "a random star system", "a random galaxy") → autopilot with smooth log-distance profile.
- Click objects (galaxy sprites, stars, planets) to target; double-click to travel.
- HUD: breadcrumb (Cosmic web › Local Group › Milky Way › Orion Spur › Sol › Earth), speed with
  auto units, distance to target, scale bar, current layer.
- Default first frame must be gorgeous (keep Starflight's opening); a "Grand tour" button runs
  a cinematic autopilot: Earth → Sun → out of the Milky Way → cosmic web → Andromeda → a random
  star → its planet, with short captions.

## Performance
Only the active 1–2 layers at full detail; others as sprites/points. Lazy-construct heavy layers
(galaxy generation, planet LUT bakes) with a brief in-flight fade, never a blank screen.
Dispose layers you leave far behind.

## Acceptance
Screenshots: opening shot; Earth close; the Sun's system from 50 AU; leaving the Milky Way
(whole galaxy with "you are here"); cosmic web with galaxy sprites; approaching Andromeda;
a procedural star's planet; mid-transition frames without pops. Tests: frame conversions
(round trip float64), entry/exit hysteresis, speed scaling.
