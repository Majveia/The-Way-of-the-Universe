# Module: gargantua — the black hole

- Experience id: `gargantua` · Port: **5201**
- Owns: `src/experiences/gargantua/**`, `src/worlds/blackhole/**` (reusable renderer), `tests/gargantua.test.ts`,
  new `src/shaders/lib/gargantua*.ts` if needed.

## Goal
The single most visually striking *accurate* phenomenon we can render: a supermassive black hole
with a thin accretion disk, ray-traced through curved spacetime in real time. Think Interstellar's
Gargantua — but physically honest (the film switched Doppler beaming off; we show it, with a
toggle to compare).

## Physics (required)
- Units G = c = M = 1 (gravitational radius r_g = GM/c²). Event horizon r = 2 (Schwarzschild),
  photon sphere r = 3, ISCO r = 6, shadow (critical impact parameter) b_c = √27 ≈ 5.196.
- **Null geodesics, exact.** For Schwarzschild the spatial photon path obeys, in pseudo-Cartesian
  coordinates, d²x/dλ² = −(3/2) h² x / r⁵ with h = |x × dx/dλ| conserved (equivalent to the Binet
  equation d²u/dφ² = 3u² − u). Integrate per pixel (RK4 or velocity-Verlet; adaptive step ∝ r,
  finer near r ≈ 3). Terminate at r < 2 (captured → black) or when escaping beyond the start
  radius and moving outward (→ sample background with the final direction).
- **Kerr (spin a/M ∈ [0, 0.998]) — strongly desired.** Integrate the Kerr null geodesic with the
  Hamiltonian formalism (Boyer–Lindquist with Carter constant, or Kerr–Schild Cartesian form) so the
  shadow becomes D-shaped and frame dragging shifts the image; ISCO from Bardeen–Press–Teukolsky
  (prograde). If Kerr is too slow for some tiers, fall back to Schwarzschild on low.
- **Thin disk (Novikov–Thorne / Page–Thorne).** Emitted flux F(r) ∝ r⁻³ (1 − √(r_isco/r)) (Newtonian
  limit acceptable; full relativistic Page–Thorne preferred), T(r) ∝ F^{1/4}; peak temperature
  adjustable (accretion rate). Colour = blackbody(T_obs) with T_obs = g·T_emit.
- **Redshift factor** for gas on circular orbits: g = 1 / (u^t (1 − Ω λ)), with u^t = 1/√(1 − 3/r)
  (Schwarzschild; Kerr: u^t = (r^{3/2} + a)/(r^{3/4}√(r^{3/2} − 3r^{1/2} + 2a))),
  Ω = 1/(r^{3/2} + a), λ = L_z/E of the photon. Observed bolometric intensity ∝ g⁴ (use g³/g⁴
  consistently and document which). Approaching side brighter and bluer; receding dimmer and redder.
- **Higher-order images:** keep integrating after a disk crossing (optically thin blending or
  opaque with a secondary image) so the far side of the disk appears above and below the shadow,
  and the n ≥ 1 photon ring appears as a thin bright ring hugging the shadow.
- **Lensed background:** render the project's `Sky` (src/worlds/sky/Sky.ts) into a cubemap
  (`THREE.WebGLCubeRenderTarget` + `CubeCamera`, once or when settings change) and sample it with
  the final ray direction; stars should smear into arcs/Einstein rings near the shadow.
- Static-observer time dilation at the camera: √(1 − 2/r) (Schwarzschild) — readout.

## Visuals
- Default view: slightly above the disk plane (≈ 8–12° inclination), camera ~20–30 r_g, spin 0.9,
  disk inner edge at ISCO, outer ~20 r_g, peak T ~ 12 000–20 000 K rendered so the inner disk
  is near-white, outer amber; bloom lets the beamed side glow. True-black shadow.
- Disk texture: turbulent, sheared by differential rotation (Keplerian Ω(r)); animate so inner
  regions visibly orbit faster (use log-polar noise with phase-reset/crossfade to avoid over-winding).
- Optional volumetric thickness (thin, puffy corona) and relativistic jets along the spin axis,
  accumulated along the *curved* ray so they are lensed too.
- Anti-aliasing: jitter + temporal accumulation when the camera is still is welcome.

## Interaction
- Orbit (drag), zoom (wheel/pinch; ~3.5–2000 r_g), slow auto-orbit when idle.
- Controls: spin, disk inclination/tilt, accretion (peak temperature), inner/outer radius,
  Doppler beaming on/off, gravitational redshift on/off, lensing on/off (straight rays, to compare),
  "Interstellar look" preset, show photon sphere / ISCO rings (subtle overlays), mass (for physical
  unit readouts: e.g. Sgr A* 4.3×10⁶ M☉, M87* 6.5×10⁹ M☉, a 10 M☉ stellar BH), time scale.
- "Plunge": animate the camera falling in along a radial (or orbital) geodesic, with observer
  aberration; ends inside the horizon (the sky shrinks to a bright circle behind you) — then
  reset.
- Readouts: distance (r_g and km/AU for chosen mass), time dilation, orbital velocity of a
  circular orbit at camera radius (fraction of c), shadow angular size.

## Performance
Ray-march in its own low-res target (e.g. 0.5–1.0 × HDR size based on quality/dynamic budget)
and upsample. Step counts by tier. Target 60 fps at 1080p on a mid laptop on `high`.

## Exports for Voyage (later integration)
`src/worlds/blackhole/BlackHoleRenderer.ts`: `new BlackHoleRenderer(renderer, opts)` with
`setEnvironment(cubeTexture)`, `setParams({ spin, inclination, … })`,
`render(target, camera, camPosInRg)` — draws the full-screen black hole view into `target`.

## Acceptance
Screenshots: default view; edge-on; face-on; Doppler off vs on; near the photon sphere; mid-plunge.
Unit tests: shadow radius √27 (e.g. by integrating the photon orbit equation in TS), ISCO values,
redshift factor limits (g → 0 at the horizon for static emitters).
