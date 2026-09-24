import type { PlanetPresetName } from '../../worlds/planet';

/**
 * "Other worlds": the same renderer on every kind of planet (and a star), for comparison with the
 * Earth. Each entry names a preset from src/worlds/planet/presets.ts plus the facts shown in the
 * info card and a default lighting geometry.
 */
export type Lighting = 'day' | 'terminator' | 'crescent' | 'backlit';

export interface GalleryWorld {
  id: string;
  label: string;
  /** Planet preset, or 'sun' for the star close-up. */
  preset: PlanetPresetName | 'sun';
  subtitle: string;
  body: string;
  rows: Array<[string, string]>;
  lighting: Lighting;
  /** Camera distance in body radii, and elevation above the equator (rad). */
  distance: number;
  pitch?: number;
  /** Framing offset (rad, + moves the body right). */
  frameX?: number;
  /** Rotation period (hours, negative = retrograde) for the spin animation. */
  rotationHours: number;
}

export const GALLERY: GalleryWorld[] = [
  {
    id: 'moon',
    label: 'The Moon',
    preset: 'moon',
    subtitle: 'LRO colour · LOLA relief',
    body: 'Airless regolith scatters light back toward the Sun (Lommel–Seeliger law with an opposition surge), so the full Moon looks flat and its terminator is sharp: no air to soften it.',
    rows: [['Radius', '1 737 km'], ['Albedo', '0.12'], ['Day', '29.5 d']],
    lighting: 'terminator',
    distance: 5.0,
    rotationHours: 655.7,
  },
  {
    id: 'mars',
    label: 'Mars',
    preset: 'mars',
    subtitle: 'Thin CO₂, suspended dust',
    body: 'Iron-oxide dust absorbs blue light, giving a butterscotch sky by day; its forward-scattering peak is narrower in the blue, so Martian sunsets are blue.',
    rows: [['Radius', '3 390 km'], ['Surface pressure', '6 mbar'], ['Dust τ', '≈ 0.5']],
    lighting: 'terminator',
    distance: 5.0,
    rotationHours: 24.62,
  },
  {
    id: 'venus',
    label: 'Venus',
    preset: 'venus',
    subtitle: 'Sulphuric-acid cloud deck',
    body: 'We see the cloud tops at ~70 km. An unidentified ultraviolet absorber tints them cream; the whole deck super-rotates around the planet every four days.',
    rows: [['Radius', '6 052 km'], ['Bond albedo', '0.76'], ['Cloud rotation', '≈ 4 d']],
    lighting: 'crescent',
    distance: 5.0,
    rotationHours: -96,
  },
  {
    id: 'jupiter',
    label: 'Jupiter',
    preset: 'jupiter',
    subtitle: 'Belts, zones, the Great Red Spot',
    body: 'Alternating jets shear the clouds into bright ammonia-ice zones and darker belts; vortices roll between them. The Great Red Spot is an anticyclone wider than the Earth.',
    rows: [['Radius', '69 911 km'], ['Flattening', '0.065'], ['Day', '9 h 56 m']],
    lighting: 'day',
    distance: 5.0,
    rotationHours: 9.93,
  },
  {
    id: 'saturn',
    label: 'Saturn',
    preset: 'saturn',
    subtitle: 'Rings in their own light',
    body: 'Measured optical depths: the faint C ring, the dense B ring, the Cassini Division, the A ring and Encke gap. The planet shadows the rings and the rings shadow the planet.',
    rows: [['Radius', '58 232 km'], ['Rings', '1.24 – 2.27 R'], ['Tilt', '26.7°']],
    lighting: 'terminator',
    distance: 7.4,
    pitch: 0.32,
    rotationHours: 10.56,
  },
  {
    id: 'saturn-backlit',
    label: 'Saturn, backlit',
    preset: 'saturn',
    subtitle: 'In Saturn’s shadow',
    body: 'With the Sun behind the planet, fine dust in the rings scatters light forward and the unlit face of the rings glows — as Cassini saw in 2006 and 2013.',
    rows: [['Phase angle', '≈ 170°'], ['Seen from', 'the night side'], ['Ring particles', 'µm dust to 10 m ice']],
    lighting: 'backlit',
    distance: 7.2,
    pitch: -0.05,
    rotationHours: 10.56,
  },
  {
    id: 'neptune',
    label: 'Neptune',
    preset: 'neptune',
    subtitle: 'Methane blue',
    body: 'Methane absorbs red light deep in a clear hydrogen atmosphere, leaving blue; haze layers soften the bands. A dark vortex drifts in the south.',
    rows: [['Radius', '24 622 km'], ['Distance', '30 AU'], ['Winds', 'up to 2 100 km/h']],
    lighting: 'terminator',
    distance: 5.0,
    rotationHours: 16.11,
  },
  {
    id: 'io',
    label: 'Io',
    preset: 'io',
    subtitle: 'Tidally heated volcanism',
    body: 'Jupiter’s tides flex Io by ~100 m, heating its interior: lava lakes glow at up to ~1 600 K on the night side, rendered as blackbody emission.',
    rows: [['Radius', '1 822 km'], ['Lava', '≈ 1 500 K'], ['Heat flow', '2.5 W/m²']],
    lighting: 'terminator',
    distance: 5.0,
    rotationHours: 42.46,
  },
  {
    id: 'terran',
    label: 'Possible Earth',
    preset: 'terran',
    subtitle: 'Procedural terrestrial world',
    body: 'Continents from domain-warped noise, mountain belts from ridged multifractals, biomes from latitude, altitude and moisture, oceans with Fresnel glint — under the same scattered sky as ours.',
    rows: [['Ocean', '64 %'], ['Atmosphere', 'Earth-like'], ['Clouds', 'advected']],
    lighting: 'terminator',
    distance: 5.0,
    rotationHours: 26,
  },
  {
    id: 'lava',
    label: 'Lava world',
    preset: 'lava-world',
    subtitle: 'A young or tidally heated surface',
    body: 'Cooled crust breaks into plates; the cracks and lakes glow with the blackbody colour of molten rock, 1 000 – 1 650 K. Emission is in physical proportion to the daylight.',
    rows: [['Crust', 'basaltic'], ['Melt', '≈ 1 650 K'], ['Atmosphere', 'none']],
    lighting: 'crescent',
    distance: 5.0,
    rotationHours: 30,
  },
  {
    id: 'dune',
    label: 'Dune world',
    preset: 'dune-world',
    subtitle: 'Desert under a dusty sky',
    body: 'A Mars-like atmosphere with more dust: the sky is ochre by day, the sunset is blue.',
    rows: [['Ocean', 'none'], ['Dust', 'high'], ['Ice caps', 'small']],
    lighting: 'terminator',
    distance: 5.0,
    rotationHours: 20,
  },
  {
    id: 'ocean',
    label: 'Ocean world',
    preset: 'ocean-world',
    subtitle: 'A global ocean',
    body: 'Almost no land: the planet is the colour of deep water and cloud, with the Sun’s glint moving across it.',
    rows: [['Ocean', '97 %'], ['Radius', '9 200 km'], ['Clouds', '75 %']],
    lighting: 'terminator',
    distance: 5.0,
    rotationHours: 22,
  },
  {
    id: 'sun',
    label: 'The Sun',
    preset: 'sun',
    subtitle: 'A G2V star, 5 772 K',
    body: 'Limb darkening from the grey atmosphere (Eddington–Barbier: we see to τ ≈ μ, cooler toward the limb, so it is dimmer and redder). Granulation, spots with filamentary penumbrae, faculae, Hα prominences and the white corona.',
    rows: [['T_eff', '5 772 K'], ['Radius', '695 700 km'], ['Granules', '≈ 1 000 km']],
    lighting: 'day',
    distance: 1.9,
    pitch: 0.05,
    frameX: 0.4,
    rotationHours: 609,
  },
];

/** Phase angle (Sun–planet–camera, rad) for a lighting preset. */
export function phaseFor(l: Lighting): number {
  switch (l) {
    case 'day':
      return (28 * Math.PI) / 180;
    case 'terminator':
      return (82 * Math.PI) / 180;
    case 'crescent':
      return (138 * Math.PI) / 180;
    case 'backlit':
      return (177 * Math.PI) / 180;   // the Sun just hidden behind the planet
  }
}
