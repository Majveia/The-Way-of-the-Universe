# Module: planets — planet & star renderer + the Earth experience ("Pale Blue Dot")

- Experience id: `earth` · Port: **5205**
- Owns: `src/worlds/planet/**` (implement the contract in `types.ts`; keep it backward compatible;
  you may extend it additively), `src/worlds/star/**`, `src/experiences/earth/**`,
  `tests/planets.test.ts`, textures under `src/worlds/planet/textures/`.
- Used by (in parallel!): `solar`, `worlds`, `voyage` — they code against `createPlanet(spec)` /
  `createStar(spec)` right now using the stub. Keep the API; make it spectacular.

## Goal
Planets that look like *Planet Earth III* from orbit: physically based atmospheres, oceans that
glint, clouds that cast shadows, city lights on the night side, rings that shadow and glow — for
Earth (real imagery) and for any procedural world.

## Renderer requirements (`createPlanet(spec)`)
- **Atmosphere:** single-scattering Rayleigh + Mie (+ ozone absorption) ray-marched over the
  atmosphere shell (e.g. 12–16 view samples × 6–8 light samples, or precomputed transmittance
  LUT). Earth defaults: β_R = (5.8, 13.5, 33.1)×10⁻⁶ m⁻¹, H_R = 8 km, β_M = 21×10⁻⁶ m⁻¹,
  H_M = 1.2 km, g = 0.76, ozone absorption (0.65, 1.881, 0.085)×10⁻⁶ m⁻¹ around 25 km. Blue limb,
  orange terminator, sunlight reddened through the atmosphere. Presets for Mars (thin dusty,
  butterscotch sky, **blue sunsets**), Venus/Titan (thick hazes).
- **Surfaces by kind:** terrestrial (continents via domain-warped fbm; ridged mountains; biomes
  from latitude/altitude/temperature/moisture; polar ice; ocean with Fresnel + sun glint and
  depth colour), ocean, desert, lava (blackbody-glowing cracks), ice (cracked Europa-like),
  barren (craters via cellular noise; Moon/Mercury), venus (cloud deck), gas-giant (zonal jets and
  bands, turbulent vortices from curl/advected noise, optional storm like the Great Red Spot, polar
  hexagon option), ice-giant (soft banding, haze). Normal perturbation from noise derivatives for
  relief lighting. Per-pixel detail so close-ups hold up (quad-sphere or high-res sphere).
- **Clouds:** separate shell, animated (advected), shadows on the surface, lit through the
  atmosphere; storms on gas giants.
- **Night side:** city lights (procedural along coasts/plains) with `cityLights`; aurora optional.
- **Rings:** radial density structure (procedural gaps; a Cassini-like division), lit by the star,
  shadowed by the planet, casting a shadow on the planet, forward-scattering brightening when
  backlit, translucent.
- Terminator must be soft and physically plausible; eclipses (sun hidden by planet) keep blacks black.
- `createStar(spec)`: limb darkening (e.g. Eddington/quadratic law), animated granulation,
  sunspots/faculae, subtle corona glow and prominences; colour from blackbody temperature;
  bright enough to bloom.

## Earth ("earth" experience)
- Real Earth: fetch public-domain NASA imagery once (e.g. Blue Marble Next Generation, Black
  Marble night lights, a cloud map, a land/water mask or specular map, topography/bathymetry for
  bump), downscale with ffmpeg (`/opt/pw-browsers/ffmpeg-1011/ffmpeg-linux`) to ≤ 4096×2048 (JPG/
  WebP-quality JPG; total ≤ 6 MB), commit under `src/worlds/planet/textures/earth/`, import via
  Vite asset URLs. Record sources/licences in `docs/CREDITS.md`. (`three-globe`'s npm package
  also ships NASA-derived earth images via jsdelivr if NASA hosts are slow.)
- Physically placed Sun for the current date/time (subsolar point from solar declination and
  equation of time), Moon (with its own phase), stars (`Sky` in equatorial frame), real axial tilt.
- Cinematic default: Earth large in frame, sunrise terminator across an ocean with glint, city
  lights on the night side, the thin blue limb. Controls: time of day/date (seasons), clouds,
  atmosphere, city lights, "Pale Blue Dot" (pull back to Voyager 1's 6 billion km: Earth becomes a
  0.12-pixel point in a sunbeam), orbit views (ISS altitude 400 km, geostationary, lunar distance).

## Acceptance
Screenshots: Earth default; Earth night side; Earth limb at ISS altitude; a procedural terrestrial,
a gas giant with storm, a ringed planet backlit, a lava world, Mars-like; the star close-up.
