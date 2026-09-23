# Module: voyage (phase 1) — sky, relativity and the Ship of the Imagination

- Experience id: `voyage` · Port: **5209**
- Owns: `src/worlds/sky/**` (keep `Sky`'s existing constructor/`render()` API backward
  compatible — others use it), `src/worlds/ship/**`, `src/experiences/voyage/**`,
  `src/core/rigs/FlyRig.ts` (keep its API; extend), `tests/voyage.test.ts`, `docs/CREDITS.md`
  (append your data sources).

## Goal (phase 1)
Build the components the seamless universe will ride on, and a first standalone experience:
**Starflight** — fly a ship through the real solar neighbourhood at relativistic speeds.

## Requirements
1. **Real sky.** Ship a compact star catalogue built from a permissive/public-domain source (e.g.
   Yale Bright Star Catalogue 5th ed. or HYG (CC BY-SA 4.0 — attribute) — ~9 000 stars to V ≈ 6.5
   plus nearby stars to ~50 ly with distances). Store compactly (binary or packed JSON under
   `src/worlds/sky/data/`), document in `docs/CREDITS.md`. Colours from B−V → T
   (`bvToTemperature`). The `Sky` class gains an option to use the real catalogue (default for
   solar-system/Earth views) with the procedural stars filling in fainter magnitudes. Optional IAU
   constellation lines toggle (public-domain line data).
2. **3D stars + parallax.** Nearby catalogue stars are positioned in 3D (pc). As the observer moves
   (tens of light-years), directions and apparent magnitudes update — constellations distort.
3. **Special relativity (accurate).** For observer velocity β: aberration
   cos θ' = (cos θ + β)/(1 + β cos θ), Doppler factor δ = 1/(γ(1 − β cos θ')) shifting each star's
   temperature (T' = δT, i.e. blackbody colour shift), and intensity boost ∝ δ⁴ (bolometric).
   Implement in the sky/star shaders (uniform: velocity vector). Unit tests for the formulas.
4. **Ship of the Imagination.** A procedural ship model (elegant, minimal: a sleek hull, subtle
   panel lines, emissive engine glow; Cowboy-Bebop-meets-Cosmos, not a copy of any design),
   chase camera (smooth), cockpit/free view toggle, engine plume, warp effect (star streaks,
   blue-shifted ahead) for faster-than-light "imagination" travel (label it as such).
5. **Flight model.** Extend `FlyRig` (keep API): inertia, throttle, auto speed scaling via a
   distance-to-nearest-object callback, velocity-matched autopilot `travelTo(target)` with a
   smooth acceleration/deceleration profile, gamepad support optional.
6. **Starflight experience** (`voyage`): start near the Sun (as a bright star; planets not needed
   here), fly to nearby stars (α Centauri, Barnard's Star, Sirius, Wolf 359, Epsilon Eridani …)
   with a target list, distances in ly, speed readout in c, γ, time dilation (ship vs Earth time),
   relativistic effects toggle and a "sub-light cap at 0.999c" vs "imagination drive" mode.

## Phase 2 note
Later this experience becomes the seamless explorer (cosmic web → galaxy → star → planet), built
on these components. Keep them modular and documented.

## Acceptance
Screenshots: sky from Earth with real constellations (Orion recognisable); relativistic view at
0.9c (aberration + colour shift); the ship in chase view with engine glow; approaching α Centauri.
