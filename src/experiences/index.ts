import type { ExperienceDef } from '../core/types';

/**
 * The catalogue of worlds. Order = menu order (keys 1–9).
 * Each module lives in src/experiences/<id>/index.ts and default-exports a factory.
 */
export const EXPERIENCES: ExperienceDef[] = [
  {
    id: 'voyage',
    title: 'Voyage',
    kicker: 'Ship of the Imagination',
    blurb: 'Fly without seams from the cosmic web into a galaxy, a star system and the sky of a world.',
    load: () => import('./voyage'),
  },
  {
    id: 'cosmos',
    title: 'Cosmic Web',
    kicker: 'Structure formation',
    blurb: 'Gravity and dark energy sculpt 13.8 billion years of structure in an expanding ΛCDM universe.',
    load: () => import('./cosmos'),
  },
  {
    id: 'gargantua',
    title: 'Gargantua',
    kicker: 'General relativity',
    blurb: 'A black hole ray-traced along exact light paths: lensing, photon ring, Doppler-beamed disk.',
    load: () => import('./gargantua'),
  },
  {
    id: 'milkyway',
    title: 'The Milky Way',
    kicker: 'Galactic dynamics',
    blurb: 'Hundreds of billions of suns turning to the rhythm of a density wave, held by dark matter.',
    load: () => import('./milkyway'),
  },
  {
    id: 'collision',
    title: 'Collision',
    kicker: 'N-body gravity',
    blurb: 'Two galaxies meet; tidal tails and bridges unfold from nothing but Newton’s law.',
    load: () => import('./collision'),
  },
  {
    id: 'nebulae',
    title: 'Nebulae',
    kicker: 'Interstellar medium',
    blurb: 'Stellar nurseries and death shrouds glowing in the true colours of ionised gas.',
    load: () => import('./nebulae'),
  },
  {
    id: 'solar',
    title: 'Solar System',
    kicker: 'Celestial mechanics',
    blurb: 'Our home system on real orbital elements, from the Sun’s surface to the Kuiper belt.',
    load: () => import('./solar'),
  },
  {
    id: 'earth',
    title: 'Pale Blue Dot',
    kicker: 'Planet Earth',
    blurb: 'Home, beneath a physically scattered sky: oceans, clouds, city lights and aurorae.',
    load: () => import('./earth'),
  },
  {
    id: 'worlds',
    title: 'Possible Worlds',
    kicker: 'Exoplanets',
    blurb: 'Star systems born from physics and a seed — every jump through the portal, a new world.',
    load: () => import('./worlds'),
  },
  {
    id: 'prelude',
    title: 'Prelude',
    kicker: 'The Way of the Universe',
    blurb: 'The night sky.',
    load: () => import('./prelude'),
    hidden: true,
  },
];

export const DEFAULT_EXPERIENCE = 'prelude';
