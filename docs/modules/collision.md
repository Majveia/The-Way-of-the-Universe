# Module: collision — galaxies merging (N-body gravity)

- Experience id: `collision` · Port: **5202**
- Owns: `src/experiences/collision/**`, `src/worlds/nbody/**`, `tests/collision.test.ts`.

## Goal
Two disk galaxies falling together: tidal tails, bridges, rings, and a final merger — computed
live on the GPU from Newton's law. The Antennae, the Mice, the Cartwheel, and our own future:
the Milky Way–Andromeda collision in ~4.5 Gyr.

## Physics (required)
- GPU N-body with GPGPU ping-pong float textures (positions/velocities), Plummer softening,
  leapfrog (kick-drift-kick), physically consistent units (kpc, Myr, 10¹⁰ M☉; G ≈ 4.5×10⁻⁶ in
  kpc³/(Myr²·M☉)… verify!).
- Design choice (recommended): **self-gravitating heavy particles** (dark halo + bulge + disk
  mass tracers, N_h ≈ 4k–16k, direct O(N²) summation in a fragment shader) + **many light star
  particles** (64k–512k) that feel only the heavy particles. This gives live halos (dynamical
  friction → mergers actually happen) with rich visual detail.
- Equilibrium initial conditions: exponential disk in rotation matched to the combined
  potential (disk + Hernquist bulge + NFW/Hernquist halo), velocity dispersion from Toomre Q ≈ 1.2–1.5,
  halos sampled from the distribution function or Jeans equations. An isolated galaxy must stay
  stable for a few Gyr (test!).
- Orbits: set up with pericentre distance, eccentricity, and each disk's spin orientation
  (prograde vs retrograde encounters produce very different tails — Toomre & Toomre 1972).
- Diagnostics: total energy and momentum drift readouts (should stay small).

## Visuals
- Stars: old (yellow-red) vs young (blue); gas tracer particles (pink/Hα) that get brighter
  where compressed (a density-triggered star-formation flash: blue knots in tails and the overlap
  region — as in the Antennae). Dust: subtle absorption optional.
- Additive HDR sprites, colour by population; heavy particles invisible (toggle to show dark matter
  as faint violet).
- Default: a prograde encounter already forming tails at load; camera slowly orbiting.

## Interaction
- Presets: Antennae (NGC 4038/9), Mice (NGC 4676), Cartwheel (ring galaxy: a head-on
  small intruder), Milky Way + Andromeda ("Milkomeda"), plus custom.
- Custom: drag to set the approach vector/impact parameter (or sliders: pericentre, velocity,
  inclination of each disk, mass ratio), then Launch.
- Time controls (Myr/s), pause, reset. Toggle dark matter visibility.
- Readouts: time since start (Myr), separation (kpc), relative speed (km/s), energy drift %.

## Exports for Voyage
`src/worlds/nbody/`: the GPU integrator as a reusable class (`NBodySystem`) for other scenes.

## Acceptance
Screenshots: initial approach; first passage with tails; Antennae-like stage; Cartwheel ring;
final merged elliptical-like remnant. Tests: unit conversions, IC equilibrium (virial ratio ≈ 1).
