import type { VisualOrbit } from '../../worlds/sky/stellar';

/**
 * Destinations for Starflight. Distances come from the catalogue (Gaia DR3 / Hipparcos parallaxes);
 * the physical properties below override the B−V–based estimates where modern measurements exist.
 * Sources: Akeson et al. 2021 and Kervella et al. 2016 (α Cen AB), Ribas et al. 2017 and
 * Faria et al. 2022 (Proxima), Bond et al. 2017 (Sirius AB), Boyajian et al. 2012/2013
 * (interferometric radii), Gillon et al. 2017 & Agol et al. 2021 (TRAPPIST-1), Zechmeister et al.
 * 2019 (Teegarden's Star), Luhman 2013 & Biller et al. 2024 (Luhman 16), González Hernández et al.
 * 2024 / Basant et al. 2025 (Barnard's Star planets), Joyce et al. 2020 (Betelgeuse),
 * Monnier et al. 2007 (Altair), Peterson et al. 2006 (Vega), NASA Exoplanet Archive (planet counts).
 */
export interface Destination {
  id: string;
  name: string;
  /** Catalogue query for the (primary) star. */
  star: string;
  /** Short line under the name. */
  kicker: string;
  /** Effective temperature (K) and radius (R☉) overrides. */
  teff?: number;
  radius?: number;
  /** Visual companion drawn from its orbit (secondary relative to primary). */
  companion?: { star: string; name: string; teff: number; radius: number; orbit: VisualOrbit };
  /** Arrival distance from the star (or from the barycentre of a binary), AU. */
  standoffAU: number;
  facts: Array<[string, string]>;
  body: string;
}

export const ALPHA_CEN_ORBIT: VisualOrbit = { P: 79.929, T: 1955.604, e: 0.5208, aAU: 23.5, i: 79.243, node: 205.073, omega: 231.519, q: 0.4574 };
export const SIRIUS_ORBIT: VisualOrbit = { P: 50.1284, T: 1994.5715, e: 0.59142, aAU: 19.9, i: 136.336, node: 45.4, omega: 149.161, q: 0.3304 };

/** Other curated stellar parameters (not destinations themselves). */
export const STAR_OVERRIDES: Record<string, { teff?: number; radius?: number }> = {
  Sun: { teff: 5772, radius: 1 },
  'Rigil Kentaurus': { teff: 5790, radius: 1.2175 },
  Toliman: { teff: 5260, radius: 0.8591 },
  'Proxima Centauri': { teff: 2900, radius: 0.1542 },
  "Barnard's Star": { teff: 3195, radius: 0.187 },
  'Wolf 359': { teff: 2749, radius: 0.144 },
  'Lalande 21185': { teff: 3601, radius: 0.392 },
  Sirius: { teff: 9940, radius: 1.711 },
  'Sirius B': { teff: 25000, radius: 0.0084 },
  Ran: { teff: 5084, radius: 0.735 },
  'Ross 128': { teff: 3192, radius: 0.197 },
  '61 Cygni A': { teff: 4526, radius: 0.665 },
  '61 Cygni B': { teff: 4077, radius: 0.595 },
  Procyon: { teff: 6530, radius: 2.048 },
  'Procyon B': { teff: 7740, radius: 0.0123 },
  'τ Ceti': { teff: 5344, radius: 0.793 },
  'ε Indi': { teff: 4649, radius: 0.711 },
  "Teegarden's Star": { teff: 2904, radius: 0.107 },
  'TRAPPIST-1': { teff: 2566, radius: 0.1192 },
  'Luhman 16': { teff: 1300, radius: 0.1 },
  Altair: { teff: 7550, radius: 1.8 },
  Vega: { teff: 9600, radius: 2.5 },
  Fomalhaut: { teff: 8590, radius: 1.84 },
  Arcturus: { teff: 4286, radius: 25.4 },
  Pollux: { teff: 4586, radius: 9.1 },
  Aldebaran: { teff: 3900, radius: 45.1 },
  Betelgeuse: { teff: 3600, radius: 764 },
  Rigel: { teff: 12100, radius: 78.9 },
  Deneb: { teff: 8525, radius: 203 },
  Polaris: { teff: 6015, radius: 37.5 },
  Capella: { teff: 4970, radius: 11.98 },
  Regulus: { teff: 12460, radius: 4.35 },
};

export const DESTINATIONS: Destination[] = [
  {
    id: 'sun',
    name: 'The Sun',
    star: 'Sun',
    kicker: 'Home · G2V',
    standoffAU: 1.6,
    facts: [
      ['Type', 'G2V main-sequence star'],
      ['Temperature', '5 772 K'],
      ['Age', '4.6 Gyr'],
    ],
    body: 'An ordinary star, one of some two hundred billion in the Milky Way. Seen from the nearest stars it is a bright but unremarkable point of light.',
  },
  {
    id: 'alpha-cen',
    name: 'α Centauri',
    star: 'Rigil Kentaurus',
    kicker: 'Nearest Sun-like stars · 4.34 ly',
    companion: { star: 'Toliman', name: 'α Centauri B', teff: 5260, radius: 0.8591, orbit: ALPHA_CEN_ORBIT },
    standoffAU: 55,
    facts: [
      ['A', 'G2V · 1.11 M☉ · 1.22 R☉'],
      ['B', 'K1V · 0.91 M☉ · 0.86 R☉'],
      ['Orbit', '79.9 yr · 11–36 AU apart'],
      ['From here', 'the Sun shines at mag 0.5 in Cassiopeia'],
    ],
    body: 'Two suns circling each other every eighty years. From their neighbourhood our Sun is just another bright star, making the W of Cassiopeia a zig-zag of six.',
  },
  {
    id: 'proxima',
    name: 'Proxima Centauri',
    star: 'Proxima Centauri',
    kicker: 'Nearest star to the Sun · 4.25 ly',
    standoffAU: 0.055,
    facts: [
      ['Type', 'M5.5V red dwarf, flare star'],
      ['Mass', '0.12 M☉ · 0.15 R☉'],
      ['Planets', 'b (1.07 M⊕, 11.2 d, habitable zone), d'],
      ['Orbit', '≈ 13 000 AU from α Cen AB'],
    ],
    body: 'A small, cool, violently flaring star bound loosely to α Centauri. We stop near the orbit of Proxima b, a rocky world in the star’s temperate zone.',
  },
  {
    id: 'barnard',
    name: 'Barnard’s Star',
    star: "Barnard's Star",
    kicker: 'Fastest-moving star in our sky · 5.96 ly',
    standoffAU: 0.07,
    facts: [
      ['Type', 'M4V red dwarf, ~10 Gyr old'],
      ['Proper motion', '10.4″ per year'],
      ['Planets', 'four small rocky worlds (2024–25)'],
    ],
    body: 'An ancient red dwarf crossing our sky faster than any other star. In about 10 000 years it will pass within 3.8 ly of the Sun.',
  },
  {
    id: 'luhman16',
    name: 'Luhman 16',
    star: 'Luhman 16',
    kicker: 'Nearest brown dwarfs · 6.5 ly',
    teff: 1300,
    radius: 0.1,
    standoffAU: 0.012,
    facts: [
      ['Type', 'L7.5 + T0.5 brown-dwarf pair'],
      ['Size', 'about Jupiter’s'],
      ['Found', '2013, by WISE'],
    ],
    body: 'Failed stars, too light to fuse hydrogen, glowing a dull red at 1 300 K. Invisible to the naked eye from Earth; JWST has mapped their patchy clouds.',
  },
  {
    id: 'wolf359',
    name: 'Wolf 359',
    star: 'Wolf 359',
    kicker: 'Red dwarf · 7.86 ly',
    standoffAU: 0.05,
    facts: [
      ['Type', 'M6V flare star'],
      ['Luminosity', '0.1 % of the Sun'],
    ],
    body: 'One of the faintest stars known when Max Wolf catalogued it in 1918. From Earth it needs a telescope; up close it is a smouldering coal.',
  },
  {
    id: 'lalande',
    name: 'Lalande 21185',
    star: 'Lalande 21185',
    kicker: 'Brightest red dwarf in the northern sky · 8.3 ly',
    standoffAU: 0.12,
    facts: [
      ['Type', 'M2V red dwarf'],
      ['Planets', 'b (≈ 2.7 M⊕), c'],
    ],
    body: 'A quiet red dwarf in Ursa Major, visible in binoculars from Earth.',
  },
  {
    id: 'sirius',
    name: 'Sirius',
    star: 'Sirius',
    kicker: 'Brightest star in Earth’s night sky · 8.6 ly',
    companion: { star: 'Sirius B', name: 'Sirius B', teff: 25000, radius: 0.0084, orbit: SIRIUS_ORBIT },
    standoffAU: 60,
    facts: [
      ['A', 'A1V · 2.06 M☉ · 1.71 R☉ · 9 940 K'],
      ['B', 'white dwarf · 1.02 M☉ · Earth-sized'],
      ['Orbit', '50.1 yr · 8–31 AU apart'],
    ],
    body: 'A hot blue-white star with a dead companion: Sirius B packs the mass of the Sun into a sphere the size of the Earth, the first white dwarf ever found.',
  },
  {
    id: 'eps-eri',
    name: 'ε Eridani',
    star: 'Ran',
    kicker: 'Young Sun-like star · 10.5 ly',
    standoffAU: 0.45,
    facts: [
      ['Type', 'K2V, ~0.5 Gyr old'],
      ['Planets', 'ε Eri b, a Jupiter-mass giant'],
      ['Disk', 'dusty belts like our Kuiper belt'],
    ],
    body: 'A younger, more active cousin of the Sun, ringed by belts of dust.',
  },
  {
    id: 'ross128',
    name: 'Ross 128',
    star: 'Ross 128',
    kicker: 'Quiet red dwarf · 11.0 ly',
    standoffAU: 0.06,
    facts: [
      ['Type', 'M4V'],
      ['Planet', 'b (1.4 M⊕, 9.9 d)'],
    ],
    body: 'An unusually calm red dwarf; its planet Ross 128 b is one of the nearest temperate worlds.',
  },
  {
    id: '61cyg',
    name: '61 Cygni',
    star: '61 Cygni A',
    kicker: 'First star with a measured distance · 11.4 ly',
    standoffAU: 40,
    facts: [
      ['A, B', 'K5V + K7V orange dwarfs'],
      ['Separation', '≈ 84 AU, orbit ≈ 700 yr'],
      ['Parallax', 'Bessel, 1838'],
    ],
    body: 'In 1838 Friedrich Bessel measured its tiny yearly shift against the background stars — the first distance to a star, and the first proof of how vast the gaps between them are.',
  },
  {
    id: 'procyon',
    name: 'Procyon',
    star: 'Procyon',
    kicker: 'The Little Dog star · 11.5 ly',
    standoffAU: 0.7,
    facts: [
      ['A', 'F5IV–V, leaving the main sequence'],
      ['B', 'white dwarf'],
    ],
    body: 'A slightly evolved star beginning to swell, with a white-dwarf companion like Sirius B.',
  },
  {
    id: 'tau-ceti',
    name: 'τ Ceti',
    star: 'τ Ceti',
    kicker: 'Nearest single Sun-like star · 11.9 ly',
    standoffAU: 0.4,
    facts: [
      ['Type', 'G8V, metal-poor, ~9 Gyr'],
      ['Planets', 'four candidates'],
    ],
    body: 'Similar to the Sun, but older and poorer in heavy elements. A classic target in the search for life.',
  },
  {
    id: 'teegarden',
    name: 'Teegarden’s Star',
    star: "Teegarden's Star",
    kicker: 'Ultracool dwarf · 12.5 ly',
    standoffAU: 0.03,
    facts: [
      ['Type', 'M7V, found in 2003'],
      ['Planets', 'b, c — Earth-mass, temperate'],
    ],
    body: 'So faint it was only discovered in 2003, yet it hosts two of the most Earth-like planets known.',
  },
  {
    id: 'trappist1',
    name: 'TRAPPIST-1',
    star: 'TRAPPIST-1',
    kicker: 'Seven Earth-sized worlds · 40.7 ly',
    standoffAU: 0.03,
    facts: [
      ['Type', 'M8V ultracool dwarf, 2 566 K'],
      ['Planets', 'b–h, all within 0.063 AU'],
      ['Orbits', '1.5 to 18.8 days, in resonance'],
    ],
    body: 'A star barely larger than Jupiter with seven rocky planets packed closer than Mercury is to the Sun.',
  },
  {
    id: 'altair',
    name: 'Altair',
    star: 'Altair',
    kicker: 'A star spinning near break-up · 16.7 ly',
    standoffAU: 0.5,
    facts: [
      ['Type', 'A7V'],
      ['Rotation', '≈ 9 hours, equator bulging 20 %'],
    ],
    body: 'Altair spins so fast it is flattened into an oblate spheroid, hotter at its poles than at its equator.',
  },
  {
    id: 'vega',
    name: 'Vega',
    star: 'Vega',
    kicker: 'The zero-point of magnitudes · 25 ly',
    standoffAU: 0.8,
    facts: [
      ['Type', 'A0V, seen nearly pole-on'],
      ['Temperature', '≈ 9 600 K'],
    ],
    body: 'The standard star of astronomical photometry, and the pole star of 12 000 years from now.',
  },
  {
    id: 'arcturus',
    name: 'Arcturus',
    star: 'Arcturus',
    kicker: 'Orange giant · 36.7 ly',
    standoffAU: 8,
    facts: [
      ['Type', 'K1.5III red giant'],
      ['Radius', '25 R☉'],
    ],
    body: 'An old star that has exhausted the hydrogen in its core and swollen to twenty-five times the Sun’s size — a preview of the Sun in 5 billion years.',
  },
  {
    id: 'aldebaran',
    name: 'Aldebaran',
    star: 'Aldebaran',
    kicker: 'The eye of Taurus · 65 ly',
    standoffAU: 14,
    facts: [
      ['Type', 'K5III giant'],
      ['Radius', '45 R☉'],
    ],
    body: 'Not part of the Hyades cluster it appears to sit in — it is less than half as far away.',
  },
  {
    id: 'betelgeuse',
    name: 'Betelgeuse',
    star: 'Betelgeuse',
    kicker: 'Red supergiant · ≈ 550 ly',
    standoffAU: 120,
    facts: [
      ['Type', 'M1–2Ia-ab supergiant'],
      ['Radius', '≈ 760 R☉ — past the orbit of Mars'],
      ['Fate', 'a core-collapse supernova within ~100 000 yr'],
    ],
    body: 'A star so large it would engulf the inner Solar System. In 2019–20 it dimmed dramatically behind a cloud of its own dust.',
  },
  {
    id: 'rigel',
    name: 'Rigel',
    star: 'Rigel',
    kicker: 'Blue supergiant · ≈ 860 ly',
    standoffAU: 25,
    facts: [
      ['Type', 'B8Ia supergiant'],
      ['Luminosity', '≈ 120 000 L☉'],
    ],
    body: 'A young, massive star burning through its fuel at a prodigious rate.',
  },
  {
    id: 'deneb',
    name: 'Deneb',
    star: 'Deneb',
    kicker: 'One of the most luminous stars known · ≈ 2 600 ly',
    standoffAU: 60,
    facts: [
      ['Type', 'A2Ia supergiant'],
      ['Luminosity', '≈ 200 000 L☉'],
    ],
    body: 'Among the brightest stars in our sky despite being thousands of light-years away.',
  },
];
