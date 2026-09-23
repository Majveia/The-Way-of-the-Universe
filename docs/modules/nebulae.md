# Module: nebulae — the interstellar medium

- Experience id: `nebulae` · Port: **5208**
- Owns: `src/experiences/nebulae/**`, `src/worlds/nebula/**` (reusable volume renderer),
  `tests/nebulae.test.ts`, new `src/shaders/lib/nebula*.ts`.

## Goal
Volumetric nebulae you can fly through, lit and coloured by real atomic physics: stellar
nurseries with pillars and ionization fronts, planetary nebulae, supernova remnants, dark clouds.

## Physics & look (required)
- Emission-line colours from `src/physics/spectrum.ts` (`LINES`, `wavelengthToRGB`): Hα 656.3
  (red), Hβ 486.1 (blue-green), [OIII] 500.7 (teal), [NII] 658.4, [SII] 671.6/673.1 (deep red).
  Line ratios vary with ionization: [OIII] near hot central stars, Hα/[NII]/[SII] in outer, lower-
  ionization gas. Provide a **"Hubble palette" (SHO)** toggle mapping SII→red, Hα→green,
  OIII→blue, as in Hubble/JWST press images, next to **true colour**.
- Ionizing stars: Strömgren sphere logic (ionized radius ∝ (Q/n²)^{1/3}) — ionization fronts
  where light meets neutral dust; dust absorbs (and reddens) and scatters (Henyey–Greenstein,
  blue reflection near bright stars).
- Types (presets), each procedural + seeded:
  1. **Emission nebula / stellar nursery** (Orion / Eagle-like): a cavity blown by an O-star
     cluster, bright rims, dark **pillars** with glowing tips (ionization fronts), Bok globules.
  2. **Planetary nebula** (Ring / Helix / bipolar Butterfly): shells with [OIII] inner and Hα/[NII]
     outer layers, a white-dwarf central star.
  3. **Supernova remnant** (Crab / Veil): thin filamentary shock shells (Hα/[SII]), a synchrotron
     blue-white inner glow and a pulsar (Crab) — optionally a flickering pulsar with period 33 ms.
  4. **Dark nebula + reflection** (Horsehead / Pleiades-like).
- Embedded stars as points with optional **diffraction spikes** (JWST 6+2 or Hubble 4 — toggle).

## Rendering
- Ray-marched volume (density from warped fbm / worley / signed-distance shells), emission and
  absorption integrated front-to-back, blue-noise/IGN jitter, low-res (½–¼) target + temporal
  accumulation/reprojection + bilateral upsample. Precompute 3D noise into `Data3DTexture` for
  speed. Depth-correct composition with stars.
- OLED: nebula emission against true black; no fog outside the volume bounds.

## Interaction
- Orbit and fly-through; presets; palette toggle; density, ionizing flux, dust amount, seed;
  time evolution (slow turbulence / expansion of PN and SNR shells at their real km/s rates,
  scaled).
- Info card per preset with real reference objects and distances.

## Exports for Voyage
`src/worlds/nebula/NebulaVolume.ts`: `new NebulaVolume({ type, seed, radius })`,
`render(renderer, camera, target)`.

## Acceptance
Screenshots of each preset (true colour + SHO), a fly-through view from inside.
