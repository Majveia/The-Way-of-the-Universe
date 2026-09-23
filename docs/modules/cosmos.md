# Module: cosmos — the cosmic web (structure formation)

- Experience id: `cosmos` · Port: **5203**
- Owns: `src/experiences/cosmos/**`, `src/worlds/cosmicweb/**` (reusable sim + layer),
  `tests/cosmos.test.ts`, new `src/physics/cosmos*.ts` files (e.g. FFT, power spectrum).

## Goal
Watch gravity build the cosmic web in an expanding ΛCDM universe, in real time, from nearly smooth
initial conditions (z ≈ 50) to today — and into the future. The Millennium-simulation look: dark
voids, glowing filaments, bright knots where galaxy clusters form.

## Physics (required)
- Background: `Cosmology` (src/physics/cosmology.ts): H(a), D(a), f(a), t(a), lookback, Ωm(a), q(a).
- Linear power spectrum: P(k) = A kⁿˢ T²(k) with the **Eisenstein & Hu (1998)** transfer function
  (with baryon acoustic wiggles; the zero-baryon fit acceptable as a toggle), normalised to σ8 via
  the top-hat window at R = 8 h⁻¹Mpc. Use Planck 2018 defaults (PLANCK18 in constants.ts).
- Initial conditions: Gaussian random field on an N³ grid (Hermitian symmetry!), Zel'dovich
  displacement ψ = −∇∇⁻²δ, plus **2LPT** (second-order) displacement; velocities from f(a).
  Start near a = 0.02.
- Evolution: **Particle-Mesh N-body** in comoving coordinates: CIC mass assignment, FFT Poisson
  solve (Green's function −1/k² with CIC deconvolution / optional smoothing), finite-difference or
  spectral gradient, CIC force interpolation, **FastPM**-style kick-drift-kick in the scale factor
  (Feng et al. 2016) so ~30–60 steps give correct large-scale growth. Periodic box.
- Write your own fast radix-2 FFT (3D, Float32/Float64Array); run the simulation in a **Web
  Worker**, streaming snapshots (transferable buffers) to the main thread; main thread
  interpolates between snapshots for smooth playback. Main-thread fallback if workers fail.
- Halo/galaxy finding: approximate Friends-of-Friends (b = 0.2) or density-peak finder on the
  mesh; galaxies "light up" after z ≈ 10–20 (first stars), luminosity ∝ halo mass, colour bluer at
  high z / low mass and redder in massive late-time halos (morphology–density relation).
- Validate: measured P(k) of the initial field matches the input spectrum; linear growth of
  large-scale modes follows D(a) (unit tests on small grids).

## Visuals
- 64³ particles on low, 96³–128³ on high (choose by measured step time). Additive point sprites
  in HDR with colour by local density (log): deep indigo in voids → magenta/orange in filaments →
  white-gold in nodes; size attenuation; no gray haze — voids must read as black.
- Galaxies as tiny bright sprites (optionally shaped: spiral disks / ellipticals) in halos.
- Toggle **comoving ↔ physical** coordinates: in physical mode the box grows with a(t), making
  cosmic expansion visible; show periodic replicas faintly to suggest an infinite universe.
- Intro option: the CMB era (z ≈ 1100: uniform orange-red plasma glow cooling and fading to the
  dark ages), first light, reionization, cosmic noon, dark-energy domination.

## Interaction
- Timeline in `ctx.ui.corner(...)`: play/pause, scrub redshift/time (scrubbing uses stored
  quantized snapshots), speed.
- Readouts: z, a, cosmic age (Gyr), lookback time, H(z), T_CMB(z), **Cosmic Calendar** date
  (`cosmicCalendar()`), Ωm(a)/ΩΛ(a), and the epoch name.
- Small a(t) plot (canvas, house style) marking now and the deceleration→acceleration transition.
- Cosmology panel with presets: Planck 2018; Einstein–de Sitter (Ωm=1, no Λ); Λ-dominated
  (Ωm=0.1, ΩΛ=0.9); Closed recollapsing (Ωm=2.5, ΩΛ=0 — show the a(t) turnaround, the Big
  Crunch); free sliders Ωm, ΩΛ, σ8, ns, h, box size, seed; "Re-run" button.
- Orbit/fly camera; click a halo → info card (mass, virial radius, velocity dispersion).

## Exports for Voyage
`src/worlds/cosmicweb/CosmicWebLayer.ts`: renders a (cached) z = 0 web in Mpc units with its
galaxy list: `halos: Array<{ position: Vector3 (Mpc), mass: number (M☉), seed: number }>`,
`render(renderer, camera)`, `setOpacity()`.

## Acceptance
Screenshots: z ≈ 20 (smooth), z ≈ 3 (filaments), z = 0 (web + clusters), physical-mode
expansion, a non-Planck cosmology. Tests: FFT round trip, P(k) of ICs, growth factor match.
