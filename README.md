# The Way of the Universe

A real-time universe in the browser, built from physics rather than pictures. Fly from the cosmic
web into a galaxy, around a black hole, through nebulae and down to the sky of a world — with
gravity, cosmic expansion, relativistic light and real ephemerides doing the work.

Designed for OLED displays: true blacks, linear HDR light, physically motivated colour.

## Worlds

| # | World | What's simulated |
|---|-------|------------------|
| 1 | **Voyage** | The Ship of the Imagination: relativistic flight through a real sky |
| 2 | **Cosmic Web** | ΛCDM structure formation: particle-mesh N-body in an expanding universe |
| 3 | **Gargantua** | A Kerr black hole ray-traced along null geodesics, Doppler-beamed disk |
| 4 | **The Milky Way** | Density-wave spiral arms, dust lanes, dark-matter rotation curve |
| 5 | **Collision** | GPU N-body galaxy merger: tidal tails, rings, Milkomeda |
| 6 | **Nebulae** | Volumetric emission nebulae in true emission-line colours |
| 7 | **Solar System** | Real orbital elements, Kirkwood gaps, Trojans, comets |
| 8 | **Pale Blue Dot** | Earth under a physically scattered atmosphere |
| 9 | **Possible Worlds** | Procedural star systems born from physics and a seed |

## Run

```bash
npm install
npm run dev          # http://127.0.0.1:5173/#gargantua
npm run build        # static site in dist/
npm test             # physics unit tests
npm run typecheck
```

Controls: drag to look/orbit · scroll or pinch to zoom · `P` controls · `M` menu · `H` hide interface.

## How it's built

TypeScript + three.js (WebGL2) + Vite, no other runtime dependencies. Every experience renders
linear HDR radiance into a shared target; one post chain (energy-conserving bloom, ACES/AgX tone
mapping, black-preserving dither) turns it into pixels. See [`docs/ENGINEERING.md`](docs/ENGINEERING.md)
and [`docs/VISION.md`](docs/VISION.md).

Physics lives in `src/physics/` (cosmology, Kepler orbits, blackbody and emission-line colour,
seeded randomness) and is unit-tested in `tests/`.
