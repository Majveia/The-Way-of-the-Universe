# Credits & data sources

- three.js (MIT) — rendering.
- Simplex noise: Stefan Gustavson & Ian McEwan / Ashima Arts (MIT); "Hash without Sine" by Dave
  Hoskins (MIT).
- CIE colour-matching fit: Wyman, Sloan & Shirley (2013), JCGT 2(2).
- Planckian locus approximation: Krystek (1985).
- Cosmological parameters: Planck Collaboration (2018), Paper VI.

## Planets module (Pale Blue Dot) — imagery under `src/worlds/planet/textures/`

All NASA imagery is in the public domain (NASA media usage guidelines); downscaled to ≤ 4096 × 2048
WebP with ffmpeg.

- Earth day: **Blue Marble Next Generation** (MODIS, R. Stöckli et al., NASA Earth Observatory,
  2004–2005) monthly mosaics for January, April, July and October (blended by date for seasons).
- Earth night lights: **Black Marble 2016** (Suomi NPP VIIRS Day/Night Band, M. Román et al.,
  NASA Earth Observatory / GSFC).
- Earth clouds: Blue Marble cloud composite (NASA Earth Observatory / Visible Earth).
- Earth elevation and bathymetry: **GEBCO 2008** 30″ grid (via NASA Visible Earth), packed with a
  MODIS-derived land/water mask.
- Moon: **LRO WAC** colour mosaic and **LOLA** elevation (NASA Scientific Visualization Studio,
  "CGI Moon Kit", E. Wright, 2019).
- Voyager 1 "Pale Blue Dot" geometry: NASA/JPL-Caltech (PIA00452) mission description.

## Planets module — physics references

- Atmospheric scattering: Bruneton & Neyret (2008); Bruneton (2017, "Precomputed Atmospheric
  Scattering: a New Implementation"); Hillaire (2020, EGSR, multiple-scattering LUT).
- Rayleigh coefficients: Bucholtz (1995); ozone cross-sections: Serdyuchenko/Gorshelev et al. (2014).
- Mars dust optics: Ockert-Bell et al. (1997); blue sunsets: Ehlers et al. (2014).
- Ocean glint: Cox & Munk (1954) slope statistics with a GGX microfacet BRDF.
- Sun, Moon, sidereal time, equation of time: J. Meeus, *Astronomical Algorithms* (2nd ed., 1998).
- Stellar limb darkening: Eddington grey atmosphere / Eddington–Barbier relation; solar
  differential rotation: Snodgrass & Ulrich (1990).
- Saturn ring optical depths: Cassini UVIS/RSS profiles (Colwell et al. 2009) — smoothed.
- Aurora emission lines and altitudes: O I 557.7 nm, O I 630.0 nm, N₂⁺ 427.8 nm (e.g. Chamberlain,
  *Physics of the Aurora and Airglow*, 1961).

## Voyage module (Starflight) — real sky, relativity, the Ship of the Imagination

- Star catalogue `src/worlds/sky/data/stars.ts`: derived from the **HYG database v4.4**
  (Hipparcos–Yale–Gliese; David Nash / astronexus, https://codeberg.org/astronexus/hyg), licensed
  **CC BY-SA 4.0**. The packed derivative (11 598 stars: V ≤ 6.5 plus every star within 25 pc, with
  positions, distances, space velocities, M_V, B−V, names) is shared under the same licence. Build
  script: `src/worlds/sky/data/build/build-catalog.mjs`. HYG itself compiles Hipparcos (ESA 1997; van
  Leeuwen 2007), the Yale Bright Star Catalogue 5th ed. (Hoffleit & Warren 1991) and the Gliese
  Catalogue of Nearby Stars 3rd ed. (Gliese & Jahreiß 1991).
- Luhman 16 and TRAPPIST-1 positions/distances: Luhman (2013); Gillon et al. (2017); Gaia DR3.
- Constellation stick figures (`src/worlds/sky/data/build/figures.mjs`): drawn for this project after
  the common IAU-chart conventions (MIT, no third-party line data).
- Curated stellar parameters and binary orbits (`src/experiences/voyage/targets.ts`): Akeson et al.
  (2021) and Kervella et al. (2016) for α Cen AB; Ribas et al. (2017), Faria et al. (2022) for Proxima;
  Bond et al. (2017) for Sirius AB; Boyajian et al. (2012, 2013) interferometric radii; Agol et al. (2021)
  TRAPPIST-1; Zechmeister et al. (2019) Teegarden's Star; Joyce et al. (2020) Betelgeuse; Monnier et al.
  (2007) Altair; Peterson et al. (2006) Vega; NASA Exoplanet Archive.
- Relativistic optics: aberration, Doppler factor and δ⁴ bolometric / band-integrated beaming —
  McKinley & Doherty (1979, Am. J. Phys. 47, 309); Weiskopf, Kraus & Ruder (1999, "Searchlight and
  Doppler effects in the visualization of special relativity"); CMB temperature Fixsen (2009).
- Relativistic rocket (constant proper acceleration, flip-and-burn): Rindler, *Relativity: Special,
  General and Cosmological* (2006) §3; Baez & Gibbs, "The Relativistic Rocket" (Usenet Physics FAQ).
- Hydrogen recombination (Balmer) line ratios for the drive plume: Osterbrock & Ferland (2006),
  *Astrophysics of Gaseous Nebulae and AGN*, case B.
- Limb darkening (linear law, u ≈ 0.6 in V): Cox (ed., 2000), *Allen's Astrophysical Quantities*.
- Split-sum environment BRDF approximation: Karis (2014), Unreal Engine 4 mobile shading notes.
