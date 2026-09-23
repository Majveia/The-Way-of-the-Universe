# Module: milkyway — a living spiral galaxy

- Experience id: `milkyway` · Port: **5204**
- Owns: `src/experiences/milkyway/**`, `src/worlds/galaxy/**` (reusable generator + layer),
  `tests/milkyway.test.ts`, new `src/physics/galaxy*.ts`.

## Goal
A breathtaking, dynamically honest spiral galaxy you can orbit and fly into: hundreds of thousands
to millions of stars moving on real orbits, arms made by a **density wave**, dark dust lanes, pink
star-forming regions, a glowing bulge and bar — and the Sun, 8.2 kpc from the centre.

## Physics (required)
- Units: parsecs, Myr. Mass model: Hernquist/Sérsic bulge + exponential disk (Miyamoto–Nagai
  potential acceptable) + NFW dark halo; derive the circular speed curve v_c(R) (≈ 230 km/s at the
  Sun) and the angular frequencies Ω(R), κ(R). Unit-test v_c at R⊙.
- **Density-wave spiral structure** (Lin–Shu) via the kinematic ellipse model (Kalnajs 1973):
  each star moves on an ellipse (epicycle) whose orientation angle varies with radius
  (logarithmic spiral, pitch ~12° for the Milky Way), so stars crowd into arms that rotate at a
  pattern speed Ω_p ≠ Ω(R). Evaluate star positions **on the GPU** from per-star orbit parameters
  and time (no CPU per-frame work).
- Bar (Milky Way is SBbc): x1-orbit stars in a rotating bar of ~5 kpc half-length.
- Stellar populations: young OB stars concentrated in arms (blue, bright, short-lived — fade them
  out of inter-arm regions), old disk and bulge stars (yellow/red), halo stars and globular clusters.
  Colours via blackbody temperatures (BLACKBODY_GLSL / physics/blackbody).
- **Dark matter demonstration:** toggle the halo off → rotation curve becomes Keplerian-falling,
  and the outer disk visibly flies apart / winds up. Show the rotation curve plot (with/without DM).
- Vertical structure: thin disk scale height ~300 pc, thick disk ~1 kpc, dust ~100 pc.

## Visuals
- 250k stars low → 1M+ ultra. Point sprites with energy-conserving sizes (see Sky star shader).
- Interstellar medium: dust lanes on the **inner (concave) edge** of arms, absorbing starlight;
  HII regions (Hα pink/red, [OIII]-teal cores), blue reflection nebulae; diffuse unresolved
  starlight glow. Recommended: a low-res volumetric pass (ray-march a procedural density field
  following the arm function, with emission + absorption) composited with the stars.
- Bulge: warm, dense; central supermassive black hole (Sgr A*) marker.
- Default view: 3/4 view from ~30 kpc, slow rotation; OLED-black intergalactic space.
- Also: morphology presets across the Hubble sequence (E0, E5, S0, Sa, Sb, Sc, SBb, SBc, Irr)
  generated from parameters + seed — ellipticals red/smooth, late spirals blue/open-armed.

## Interaction
- Orbit/zoom from 100 kpc down into the disk; fly mode within the disk.
- Time warp (Myr per second) to watch differential rotation vs. pattern speed.
- Controls: morphology preset, arms count, pitch angle, bar strength, dust, star formation,
  dark-matter halo on/off, show rotation curve, "You are here" (Sun) marker, seed.
- Readouts: time (Myr), galactocentric radius under the cursor or camera, v_c there, rotation
  period there (≈ 230 Myr at the Sun).

## Exports for Voyage
`src/worlds/galaxy/`: `GalaxyModel` (params + seed → deterministic stars), `GalaxyLayer`
(render in pc; `render(renderer, camera)`; `nearestStars(posPc, k)` → star records with
{ id, position, temperatureK, luminosity, massSun, seed }), and a milkyWay preset with the Sun.

## Acceptance
Screenshots: default 3/4 view; face-on; edge-on (dust lane!); inside the disk near the Sun;
an elliptical and a barred preset; dark matter off after some Myr. Tests: rotation curve, orbit
period at R⊙, deterministic generation.
