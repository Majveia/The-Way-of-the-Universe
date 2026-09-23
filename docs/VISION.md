# The Way of the Universe — Vision

A real-time universe in the browser that you can *explore*, built from physics rather than
from pictures. It should feel like stepping into *Cosmos: Possible Worlds* and *Planet Earth III*,
with the freedom of *No Man's Sky* / *Starfield*, the playful multiverse energy of *Rick and Morty*
and the cool of *Cowboy Bebop* — and every image on screen should be something a physicist would
nod at.

## The experience

- **One universe, many scales.** From the cosmic web (hundreds of megaparsecs) to a galaxy, a
  star system, a planet's sky — ultimately without seams (the *Voyage* experience).
- **Showcase worlds.** Each module is also a curated, self-contained experience that is gorgeous
  on its own: *Gargantua* (black hole), *Cosmic Web* (structure formation), *The Milky Way*,
  *Collision* (galaxy merger), *Nebulae*, *Solar System*, *Pale Blue Dot* (Earth),
  *Possible Worlds* (procedural exoplanet systems), *Voyage* (the ship).
- **Real-time interaction.** Everything responds: orbit, fly, scrub cosmic time, change the
  laws (Ωm, ΩΛ, spin, mass, dark matter on/off) and watch the consequences.
- **Honest physics.** Real equations, real constants, real data where it exists. Where we
  exaggerate for visibility (enlarged planets, time warp), the UI says so.

## The quality bar

Every screenshot should look like a still from a high-budget science documentary.

- **OLED first.** Backgrounds are true black `(0,0,0)`. No gray haze, no lifted blacks, no
  full-screen fog. Light comes from things that emit it. The post chain dithers only where there
  is signal, so black pixels stay off.
- **Linear HDR light.** Render physical radiance in linear space; let exposure, bloom and the tone
  mapper (ACES/AgX) turn it into an image. Emission colours come from physics: blackbody
  temperatures, emission-line wavelengths (Hα 656 nm red, [OIII] 501 nm teal), Rayleigh blue.
- **No artifacts.** No banding (use dithering/blue noise), no shimmering aliasing on stars
  (sub-pixel stars fade, not flicker), no NaN pixels, no precision jitter, no popping LOD.
- **Restraint.** Minimal interface, generous negative space, thin type. The universe is the
  hero; chrome fades away when idle.
- **Smooth.** 60 fps on a mid-range laptop GPU at 1080p (dynamic resolution helps), graceful on
  phones via quality tiers. No per-frame garbage.
- **Depth and nuance.** Add the details real astronomers love: Doppler beaming, the photon ring,
  Kirkwood gaps, dust lanes on the inner edge of spiral arms, the Great Rift, Rayleigh-scattered
  limbs, ring shadows, tidal tails, baryon acoustic wiggles, the Cosmic Calendar.

## Interface language

- Type: **Jost** (geometric, Futura lineage — Apollo-era space type) for UI; **IBM Plex Mono**
  with tabular figures for numbers.
- Colour: ground `#000`; ink `#ece8e1`; one warm accent `#ffc690` (≈ 4200 K blackbody) and a
  cool counterpart `#aecbff` (≈ 10 000 K). Hairline rules, not boxes.
- Units: human-readable and correct (km, AU, light-years, Mly, Gyr, M☉, K, c). Use
  `src/physics/units.ts`.
- Copy: short, precise, wonder without hype. Name things as astronomers do, then explain.
