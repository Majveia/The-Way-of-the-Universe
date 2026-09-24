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
