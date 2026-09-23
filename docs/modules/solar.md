# Module: solar — the Solar System on real ephemerides

- Experience id: `solar` · Port: **5206**
- Owns: `src/experiences/solar/**`, `src/worlds/solar/**` (reusable model + layer),
  `tests/solar.test.ts`.
- Uses: `createPlanet` / `createStar` from `src/worlds/planet` and `src/worlds/star` (being
  upgraded in parallel by the `planets` module — code against the contract in
  `src/worlds/planet/types.ts`; the stub works meanwhile).

## Goal
Our home system, accurate: planets where they really are today, moving on Kepler orbits, with
the belts, gaps and families astronomers know — from the solar surface to the Kuiper belt.

## Physics (required)
- Planets: JPL/Standish "Keplerian Elements for Approximate Positions of the Major Planets"
  (Table 1, 1800–2050 AD: a, e, I, L, ϖ, Ω and their per-century rates), J2000 ecliptic frame;
  solve Kepler (src/physics/kepler.ts); convert with `astroToThree`. Validate against known
  positions (e.g. JPL Horizons values for a few dates) in tests (tolerance ≲ 1°).
- Physical data: radii, axial tilts (and pole orientation), rotation periods (Venus retrograde,
  Uranus sideways), masses, albedos.
- Moons: the Moon (Keplerian with nodal/apsidal precession — or a truncated analytic lunar theory),
  Galilean moons, Titan, Triton, Phobos/Deimos, Charon — correct periods and radii.
- Small bodies: **asteroid belt** (instanced irregular rocks near the camera + many points)
  sampled so the **Kirkwood gaps** appear at Jupiter's mean-motion resonances (3:1 at 2.50 AU,
  5:2 at 2.82, 7:3 at 2.95, 2:1 at 3.27); Hildas (3:2, 3.97 AU); **Jupiter Trojans** at L4/L5;
  **Kuiper belt** (plutinos at 3:2 ≈ 39.4 AU, classical 42–48 AU, scattered disc); dwarf planets
  (Ceres, Pluto, Eris, Haumea, Makemake); comets (1P/Halley, Hale–Bopp, 67P) with **ion tail**
  (straight, anti-sunward, blue CO⁺) and **dust tail** (curved, yellow-white), brightening ∝ r⁻².
- Time: starts at *now* (real date); warp from real time up to ~1 year/s; readout date/time (UTC)
  and Julian date.

## Visuals
- Sun via `createStar` (the scene's light; bloom); planets via `createPlanet` with fitting kinds
  (Mercury barren, Venus venus, Earth earth, Mars desert w/ thin atmosphere, Jupiter gas-giant +
  storm, Saturn gas-giant + rings (1.24–2.27 R_S, Cassini division), Uranus/Neptune ice-giant,
  Uranus faint rings).
- Scale honesty: "true scale" vs "enlarged bodies" toggle (with a label saying ×N); orbit lines
  (thin, fading, coloured subtly), labels that declutter by distance.
- Depth: multi-pass/near-far layering so a close-up of Saturn and the full orbit of Neptune both
  render without z-fighting (e.g. render far layer, clear depth, render near layer).
- Background: `Sky` in the ecliptic frame.

## Interaction
- Click/tap a body → smooth flyTo + info card with real data; double-click to follow it.
- Time controls in `ctx.ui.corner()` (pause, reverse, warp steps, "Now").
- Toggles: orbits, labels, asteroid belt, Kuiper belt, comets, moons, scale mode.

## Exports for Voyage
`src/worlds/solar/`: `SolarSystemModel` (positions at time t for all bodies, physical data) and
`SolarSystemLayer` (render in AU with camera-relative precision, pick bodies, per-body detail
hooks).

## Acceptance
Screenshots: overview of the inner system today; Jupiter with Trojans + Kirkwood gaps visible
from above; Saturn close-up; a comet near perihelion with both tails; the Kuiper belt view.
Tests: positions vs reference, Kepler periods, resonance locations.
