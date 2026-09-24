/**
 * Natural satellites.
 *
 * Orbits: precessing mean elements FITTED for this project to JPL Horizons state vectors
 * (satellite ephemerides MAR099, JUP365, SAT441, URA182, NEP097, PLU060 on DE440/441), sampled
 * every 9 days over 2006–2046 plus a dense arc for phase unwrapping. Each orbit lies in the
 * satellite's local Laplace plane (pole from JPL SSD "Planetary Satellite Mean Elements");
 * its node regresses, its pericentre advances, and resonant librations are included where they
 * matter (Mimas–Tethys 70.6 yr, Titan–Hyperion 640 d). `rms` is the fit residual in degrees of
 * orbital longitude — e.g. Io 0.33°, Titan 0.05°, Triton 0.002°. Epoch 2026-09-23.0 TDB.
 * The Moon uses the ELP-2000/82 series (ephem/moon.ts). Nereid and Phoebe (e = 0.75, 0.17) use
 * osculating elements from Horizons at the epoch.
 *
 * Physical data: JPL SSD "Planetary Satellite Physical Parameters" and mission results.
 */
import type { BodyDef, FittedSatellite } from './types';
import { MU_SUN } from '../ephem/conic';

export const SAT_EPOCH = 2461306.5;
const D2R = Math.PI / 180;
const KM_AU = 1 / 149_597_870.7;

// prettier-ignore
const FIT: Record<string, FittedSatellite> = {
  phobos: { pole: [317.700, 52.900], i: 1.07500, node0: 235.16547, nodeRate: -0.435793760, L0: 319.15355, n: 1129.280729135, e: 0.000250, w0: 258.6365, wRate: 0.896023894, aKm: 9375.9, rms: 1.234 },
  deimos: { pole: [316.600, 53.500], i: 1.78577, node0: 237.86988, nodeRate: -0.018146896, L0: 109.35717, n: 285.179988642, e: 0.000076, w0: 320.2264, wRate: 0, aKm: 23457.5, rms: 0.081 },
  io: { pole: [268.100, 64.500], i: 0.03940, node0: 44.73624, nodeRate: -0.132632968, L0: 212.63883, n: 203.621590986, e: 0.000229, w0: 129.8175, wRate: -0.739404564, aKm: 421771.9, rms: 0.334 },
  europa: { pole: [268.100, 64.500], i: 0.46299, node0: 225.37282, nodeRate: -0.032744093, L0: 278.46646, n: 101.407468730, e: 0.009281, w0: 344.8351, wRate: -0.707048984, aKm: 671090.0, rms: 0.060 },
  ganymede: { pole: [268.200, 64.600], i: 0.23352, node0: 343.25582, nodeRate: -0.005936772, L0: 13.72434, n: 50.323544267, e: 0.001930, w0: 357.1989, wRate: 0.014430627, aKm: 1070433.0, rms: 0.064 },
  callisto: { pole: [268.700, 64.800], i: 0.21852, node0: 281.63209, nodeRate: -0.001646498, L0: 124.78535, n: 21.572719087, e: 0.007255, w0: 90.0912, wRate: 0.003546426, aKm: 1882798.5, rms: 0.025 },
  amalthea: { pole: [268.100, 64.500], i: 0.37643, node0: 311.64231, nodeRate: -2.504861718, L0: 231.44851, n: 725.136594957, e: 0.002579, w0: 208.1935, wRate: 5.028705527, aKm: 181343.7, rms: 0.175 },
  mimas: { pole: [40.600, 83.500], i: 1.57563, node0: 136.50997, nodeRate: -0.999495896, L0: 342.68855, n: 382.994132568, e: 0.018852, w0: 82.7619, wRate: 1.999241954, aKm: 185571.6, libs: [[25772.0, -42.67911, 4.36831]], rms: 0.644 },
  enceladus: { pole: [40.600, 83.500], i: 0.03719, node0: 185.27510, nodeRate: 0.000341109, L0: 14.40367, n: 262.731561737, e: 0.004745, w0: 45.4451, wRate: 0.338006270, aKm: 238038.3, rms: 0.233 },
  tethys: { pole: [40.600, 83.500], i: 1.09229, node0: 128.51849, nodeRate: -0.197878745, L0: 357.54465, n: 190.895782128, e: 0.000001, w0: 304.0216, wRate: 0, aKm: 294673.3, libs: [[25772.0, 2.05825, -0.20845]], rms: 0.025 },
  dione: { pole: [40.600, 83.500], i: 0.04257, node0: 191.63434, nodeRate: 0.000286998, L0: 203.49298, n: 131.534642956, e: 0.002193, w0: 125.8075, wRate: 0.084255965, aKm: 377416.4, rms: 0.022 },
  rhea: { pole: [40.600, 83.500], i: 0.34056, node0: 81.21096, nodeRate: -0.028088413, L0: 265.33714, n: 79.718134087, e: 0.000960, w0: 137.1736, wRate: 0.029041112, aKm: 527074.4, rms: 0.015 },
  titan: { pole: [36.400, 84.000], i: 0.34927, node0: 10.70433, nodeRate: -0.001253314, L0: 66.17118, n: 22.578229129, e: 0.028691, w0: 211.3594, wRate: 0.002843043, aKm: 1222352.0, rms: 0.053 },
  hyperion: { pole: [40.200, 83.600], i: 0.89392, node0: 222.11454, nodeRate: -0.003468980, L0: 351.53849, n: 16.923421206, e: 0.101221, w0: 233.9414, wRate: -0.047288120, aKm: 1489132.1, libs: [[640.0, -1.44865, -9.00436]], rms: 2.312 },
  iapetus: { pole: [288.700, 78.900], i: 7.58048, node0: 71.71194, nodeRate: -0.000322314, L0: 145.69193, n: 4.538268690, e: 0.028472, w0: 282.3637, wRate: 0.000592715, aKm: 3562294.9, rms: 0.073 },
  ariel: { pole: [257.311, -15.175], i: 179.98183, node0: 161.79851, nodeRate: 0.029088567, L0: 195.10895, n: 142.864734020, e: 0.000118, w0: 30.0119, wRate: -0.034103536, aKm: 190929.5, rms: 0.093 },
  umbriel: { pole: [257.311, -15.175], i: 179.92489, node0: 257.63578, nodeRate: 0.007649855, L0: 139.39783, n: 86.876525246, e: 0.003805, w0: 145.9438, wRate: 0.015370151, aKm: 265983.9, rms: 0.051 },
  titania: { pole: [257.311, -15.175], i: 179.94548, node0: 350.05717, nodeRate: -0.004982472, L0: 183.45793, n: 41.346433763, e: 0.001585, w0: 71.9618, wRate: -0.001699567, aKm: 436280.9, rms: 0.074 },
  oberon: { pole: [257.311, -15.175], i: 179.80146, node0: 337.11034, nodeRate: 0.001677397, L0: 167.12578, n: 26.741161975, e: 0.001536, w0: 350.5109, wRate: 0.006214385, aKm: 583449.2, rms: 0.075 },
  miranda: { pole: [257.311, -15.175], i: 175.57255, node0: 80.05256, nodeRate: 0.055412387, L0: 231.65109, n: 254.746113644, e: 0.001371, w0: 331.5622, wRate: 0.110261358, aKm: 129848.2, rms: 0.981 },
  triton: { pole: [299.800, 43.100], i: 157.23615, node0: 190.99637, nodeRate: 0.001458291, L0: 74.72643, n: 61.258720778, e: 0.000124, w0: 100.6753, wRate: 0, aKm: 354759.1, rms: 0.002 },
  proteus: { pole: [299.800, 42.600], i: 0.20379, node0: 337.30012, nodeRate: 0.005707430, L0: 170.25656, n: 320.759926672, e: 0.000018, w0: 56.7903, wRate: 0, aKm: 117647.1, rms: 0.040 },
  charon: { pole: [132.993, -6.163], i: 0.08238, node0: 11.09758, nodeRate: 0.000166058, L0: 35.86529, n: 56.362364652, e: 0.000161, w0: 144.3211, wRate: 0, aKm: 19595.8, rms: 0.000 },
  nix: { pole: [132.993, -6.163], i: 0.08349, node0: 10.71053, nodeRate: 0.000170893, L0: 348.61730, n: 14.484000550, e: 0.000028, w0: 298.4829, wRate: 0, aKm: 48688.9, rms: 0.179 },
  hydra: { pole: [132.993, -6.163], i: 0.28270, node0: 145.37464, nodeRate: -0.071242135, L0: 275.91445, n: 9.494828389, e: 0.000220, w0: 220.8924, wRate: 0, aKm: 64720.1, rms: 0.452 },
  kerberos: { pole: [132.993, -6.163], i: 0.43164, node0: 331.58608, nodeRate: -0.108948000, L0: 99.73008, n: 11.300207530, e: 0.000079, w0: 40.1037, wRate: 0, aKm: 57748.4, rms: 0.262 },
  styx: { pole: [132.993, -6.163], i: 0.09005, node0: 11.45037, nodeRate: 0.000235300, L0: 235.11775, n: 17.855202064, e: 0.000397, w0: 327.1731, wRate: 0, aKm: 42408.7, rms: 0.289 },
};

/** Osculating planetocentric elements (J2000 ecliptic) from Horizons at SAT_EPOCH; q in AU, angles deg. */
const IRREGULAR = {
  nereid: { q: 9.3369575351e-3, e: 0.7464526805, i: 5.04347604, node: 319.36060496, peri: 296.77402134, tp: 2461411.52806804, mu: 1.5240391367e-8 },
  phoebe: { q: 7.1960983099e-2, e: 0.167509273, i: 172.84216677, node: 271.59912048, peri: 10.95435714, tp: 2461374.05988217, mu: 8.4576149458e-8 },
};
const irr = (k: keyof typeof IRREGULAR) => {
  const x = IRREGULAR[k];
  return { q: x.q, e: x.e, i: x.i * D2R, node: x.node * D2R, peri: x.peri * D2R, tp: x.tp, mu: x.mu };
};

type MoonSpec = Omit<BodyDef, 'kind' | 'orbit' | 'priority'> & { orbit?: BodyDef['orbit']; priority?: number };
const moon = (m: MoonSpec): BodyDef => ({
  kind: 'moon',
  priority: m.priority ?? 3,
  locked: m.locked ?? true,
  orbit: m.orbit ?? { type: 'sat', fit: FIT[m.id] },
  ...m,
});

export const MOONS: BodyDef[] = [
  moon({
    id: 'moon',
    name: 'Moon',
    parent: 'earth',
    radiusKm: 1737.4,
    massKg: 7.342e22,
    albedo: 0.12,
    color: '#c9c3b8',
    orbit: { type: 'moon' },
    rotation: { ra: 269.9949, dec: 66.5392, raRate: 0.0031, decRate: 0.013, W0: 38.3213, Wd: 13.17635815, model: 'moon' },
    locked: false,
    planet: { kind: 'barren', radiusKm: 1737.4, temperatureK: 250, atmosphere: null },
    subtitle: 'Earth’s satellite',
    blurb:
      'A quarter of Earth’s width, probably born from a Mars-sized impact 4.5 billion years ago. Tides lock its face toward us and push it outward 3.8 cm a year.',
    facts: { 'Orbital period': '27.32 d', 'Distance': '363 300 – 405 500 km' },
  }),
  moon({
    id: 'phobos', name: 'Phobos', parent: 'mars', radiusKm: 11.08, radiiKm: [13.0, 11.4, 9.1], massKg: 1.0659e16, albedo: 0.071, color: '#8c8279',
    shape: 'irregular', priority: 4, subtitle: 'Moon of Mars',
    blurb: 'A 27 km rubble pile orbiting faster than Mars turns — it rises in the west twice a day. Tides are dragging it down; in ~40 million years it will break into a ring.',
  }),
  moon({
    id: 'deimos', name: 'Deimos', parent: 'mars', radiusKm: 6.2, radiiKm: [7.8, 6.0, 5.1], massKg: 1.4762e15, albedo: 0.068, color: '#9a8f84',
    shape: 'irregular', priority: 4, subtitle: 'Moon of Mars',
    blurb: 'Mars’s smooth little outer moon, 15 km long. From the Martian surface it looks like a bright star.',
  }),
  moon({
    id: 'io', name: 'Io', parent: 'jupiter', radiusKm: 1821.6, massKg: 8.9319e22, albedo: 0.63, color: '#e8d36a',
    planet: { kind: 'lava', radiusKm: 1821.6, temperatureK: 130, atmosphere: null }, subtitle: 'Galilean moon of Jupiter',
    blurb: 'The most volcanic world known. The 1:2:4 Laplace resonance with Europa and Ganymede keeps its orbit eccentric, and Jupiter’s tides knead its interior molten.',
  }),
  moon({
    id: 'europa', name: 'Europa', parent: 'jupiter', radiusKm: 1560.8, massKg: 4.7998e22, albedo: 0.67, color: '#d9cfbd',
    planet: { kind: 'ice', radiusKm: 1560.8, temperatureK: 102, atmosphere: null }, subtitle: 'Galilean moon of Jupiter',
    blurb: 'A cracked ice shell over a global salt-water ocean holding perhaps twice the water of Earth’s oceans — among the best places to look for life.',
  }),
  moon({
    id: 'ganymede', name: 'Ganymede', parent: 'jupiter', radiusKm: 2634.1, massKg: 1.4819e23, albedo: 0.43, color: '#b3a894',
    planet: { kind: 'ice', radiusKm: 2634.1, temperatureK: 110, ice: 0.3, atmosphere: null }, subtitle: 'Galilean moon of Jupiter',
    blurb: 'The largest moon in the Solar System — wider than Mercury — and the only one with its own magnetic field and aurorae.',
  }),
  moon({
    id: 'callisto', name: 'Callisto', parent: 'jupiter', radiusKm: 2410.3, massKg: 1.0759e23, albedo: 0.22, color: '#8f8577',
    planet: { kind: 'barren', radiusKm: 2410.3, temperatureK: 134, atmosphere: null }, subtitle: 'Galilean moon of Jupiter',
    blurb: 'The most heavily cratered surface known: four billion years of impacts on ice and rock, outside the resonance that heats its siblings.',
  }),
  moon({
    id: 'amalthea', name: 'Amalthea', parent: 'jupiter', radiusKm: 83.5, radiiKm: [125, 73, 64], massKg: 2.08e18, albedo: 0.09, color: '#a0685a',
    shape: 'irregular', priority: 4, subtitle: 'Inner moon of Jupiter',
    blurb: 'The reddest object in the Solar System, a porous 250 km potato inside Io’s orbit that sheds dust into Jupiter’s gossamer ring.',
  }),
  moon({
    id: 'mimas', name: 'Mimas', parent: 'saturn', radiusKm: 198.2, radiiKm: [207.8, 196.7, 190.6], massKg: 3.75e19, albedo: 0.96, color: '#cfcac4',
    planet: { kind: 'ice', radiusKm: 198.2, temperatureK: 64, atmosphere: null }, priority: 4, subtitle: 'Moon of Saturn',
    blurb: 'Herschel crater spans a third of its face. Its 2:1 resonance with ring particles clears the Cassini Division; its libration with Tethys swings it ±43° over 70 years.',
  }),
  moon({
    id: 'enceladus', name: 'Enceladus', parent: 'saturn', radiusKm: 252.1, massKg: 1.08e20, albedo: 1.375, color: '#f2f4f7',
    planet: { kind: 'ice', radiusKm: 252.1, temperatureK: 75, ice: 1, atmosphere: null }, priority: 3, subtitle: 'Moon of Saturn',
    blurb: 'The brightest body in the Solar System. Geysers at its south pole jet an ocean into space, feeding Saturn’s E ring; Cassini flew through them and tasted salt and organics.',
  }),
  moon({
    id: 'tethys', name: 'Tethys', parent: 'saturn', radiusKm: 531.1, massKg: 6.17e20, albedo: 1.229, color: '#e8e6e2',
    planet: { kind: 'ice', radiusKm: 531.1, temperatureK: 86, atmosphere: null }, priority: 4, subtitle: 'Moon of Saturn',
    blurb: 'Almost pure water ice; the canyon Ithaca Chasma runs three-quarters of the way around it.',
  }),
  moon({
    id: 'dione', name: 'Dione', parent: 'saturn', radiusKm: 561.4, massKg: 1.095e21, albedo: 0.998, color: '#dcd9d4',
    planet: { kind: 'ice', radiusKm: 561.4, temperatureK: 87, atmosphere: null }, priority: 4, subtitle: 'Moon of Saturn',
    blurb: 'Laced with bright ice cliffs; its 2:1 resonance with Enceladus pumps the tidal heat that keeps Enceladus’s ocean liquid.',
  }),
  moon({
    id: 'rhea', name: 'Rhea', parent: 'saturn', radiusKm: 763.8, massKg: 2.307e21, albedo: 0.949, color: '#d6d2cb',
    planet: { kind: 'ice', radiusKm: 763.8, temperatureK: 76, atmosphere: null }, priority: 3, subtitle: 'Moon of Saturn',
    blurb: 'Saturn’s second-largest moon: a 1 528 km ball of ice and rock under a tenuous oxygen–CO₂ exosphere.',
  }),
  moon({
    id: 'titan', name: 'Titan', parent: 'saturn', radiusKm: 2574.7, massKg: 1.3452e23, albedo: 0.22, color: '#e0a64c',
    planet: {
      kind: 'venus', radiusKm: 2574.7, temperatureK: 94, clouds: 1,
      atmosphere: { rayleigh: [3, 7, 17], mie: 900, mieG: 0.65, scaleHeight: 40 / 2574.7, thickness: 0.2, absorption: [4, 20, 80], tint: [1.0, 0.62, 0.26] },
    },
    subtitle: 'Moon of Saturn',
    blurb: 'The only moon with a thick atmosphere — 1.5 bar of nitrogen under orange organic haze — and the only other world with standing liquid on its surface: lakes of methane and ethane.',
  }),
  moon({
    id: 'hyperion', name: 'Hyperion', parent: 'saturn', radiusKm: 135, radiiKm: [180, 133, 103], massKg: 5.62e18, albedo: 0.3, color: '#b39e86',
    shape: 'irregular', locked: false, spinHours: 13 * 24, priority: 4, subtitle: 'Moon of Saturn',
    blurb: 'A sponge-like, low-density body that tumbles chaotically — its spin axis wanders unpredictably, driven by the 4:3 resonance with Titan.',
  }),
  moon({
    id: 'iapetus', name: 'Iapetus', parent: 'saturn', radiusKm: 734.5, massKg: 1.806e21, albedo: 0.6, color: '#b9aa94',
    planet: { kind: 'barren', radiusKm: 734.5, temperatureK: 110, atmosphere: null }, priority: 3, subtitle: 'Moon of Saturn',
    blurb: 'Yin and yang: a coal-dark leading hemisphere and a snow-white trailing one, girdled by an equatorial ridge 20 km high.',
  }),
  moon({
    id: 'phoebe', name: 'Phoebe', parent: 'saturn', radiusKm: 106.5, radiiKm: [109, 109, 102], massKg: 8.3e18, albedo: 0.08, color: '#6f6a64',
    orbit: { type: 'sat-conic', el: irr('phoebe') }, locked: false, spinHours: 9.27, shape: 'irregular', priority: 4, subtitle: 'Irregular moon of Saturn',
    blurb: 'A captured, retrograde outer-Solar-System body; dust knocked off it forms Saturn’s enormous, nearly invisible Phoebe ring.',
  }),
  moon({
    id: 'miranda', name: 'Miranda', parent: 'uranus', radiusKm: 235.8, massKg: 6.59e19, albedo: 0.32, color: '#bdb7b0',
    planet: { kind: 'ice', radiusKm: 235.8, temperatureK: 60, atmosphere: null }, priority: 4, subtitle: 'Moon of Uranus',
    blurb: 'A patchwork of grooved terrains; the cliff Verona Rupes may drop 20 km — the tallest known in the Solar System.',
  }),
  moon({
    id: 'ariel', name: 'Ariel', parent: 'uranus', radiusKm: 578.9, massKg: 1.251e21, albedo: 0.53, color: '#cfcac3',
    planet: { kind: 'ice', radiusKm: 578.9, temperatureK: 60, atmosphere: null }, priority: 4, subtitle: 'Moon of Uranus',
    blurb: 'The brightest and youngest-looking of Uranus’s large moons, scored by long rift valleys.',
  }),
  moon({
    id: 'umbriel', name: 'Umbriel', parent: 'uranus', radiusKm: 584.7, massKg: 1.275e21, albedo: 0.26, color: '#8e8a86',
    planet: { kind: 'barren', radiusKm: 584.7, temperatureK: 75, atmosphere: null }, priority: 4, subtitle: 'Moon of Uranus',
    blurb: 'The darkest of the large Uranian moons, ancient and cratered, with a mysterious bright ring (Wunda) on its equator.',
  }),
  moon({
    id: 'titania', name: 'Titania', parent: 'uranus', radiusKm: 788.9, massKg: 3.4e21, albedo: 0.35, color: '#c0b8ae',
    planet: { kind: 'ice', radiusKm: 788.9, temperatureK: 70, atmosphere: null }, priority: 3, subtitle: 'Moon of Uranus',
    blurb: 'Uranus’s largest moon, cut by canyons up to 1 500 km long.',
  }),
  moon({
    id: 'oberon', name: 'Oberon', parent: 'uranus', radiusKm: 761.4, massKg: 3.076e21, albedo: 0.31, color: '#b5ab9f',
    planet: { kind: 'barren', radiusKm: 761.4, temperatureK: 75, atmosphere: null }, priority: 3, subtitle: 'Moon of Uranus',
    blurb: 'The outermost large moon of Uranus: an old, heavily cratered surface with dark-floored craters.',
  }),
  moon({
    id: 'triton', name: 'Triton', parent: 'neptune', radiusKm: 1353.4, massKg: 2.139e22, albedo: 0.76, color: '#e3d2c6',
    planet: { kind: 'ice', radiusKm: 1353.4, temperatureK: 38, ice: 0.8, atmosphere: { rayleigh: [0.2, 0.5, 1.2], mie: 1, mieG: 0.6, scaleHeight: 0.006, thickness: 0.03 } },
    subtitle: 'Moon of Neptune · retrograde',
    blurb: 'It orbits backwards: a captured Kuiper-belt world. Nitrogen geysers streak its pink “cantaloupe” terrain, and tides are slowly pulling it toward Neptune.',
  }),
  moon({
    id: 'nereid', name: 'Nereid', parent: 'neptune', radiusKm: 178, massKg: 3.1e19, albedo: 0.16, color: '#a6a19b',
    orbit: { type: 'sat-conic', el: irr('nereid') }, locked: false, spinHours: 11.6, priority: 4, subtitle: 'Irregular moon of Neptune',
    planet: { kind: 'barren', radiusKm: 178, temperatureK: 50, atmosphere: null },
    blurb: 'One of the most eccentric moon orbits known (e = 0.75): it swings from 1.4 to 9.6 million km from Neptune.',
  }),
  moon({
    id: 'proteus', name: 'Proteus', parent: 'neptune', radiusKm: 210, radiiKm: [218, 208, 201], massKg: 4.4e19, albedo: 0.096, color: '#77716b',
    shape: 'irregular', priority: 4, subtitle: 'Moon of Neptune',
    blurb: 'About as large as a body can be before its own gravity pulls it round — one of the darkest objects in the Solar System.',
  }),
  moon({
    id: 'charon', name: 'Charon', parent: 'pluto', radiusKm: 606, massKg: 1.586e21, albedo: 0.38, color: '#b3aca4',
    planet: { kind: 'barren', radiusKm: 606, temperatureK: 53, atmosphere: null }, subtitle: 'Moon of Pluto',
    blurb: 'Half Pluto’s width: the two are tidally locked face to face, circling a point in space between them. Its red pole, Mordor Macula, is stained by gas escaping Pluto.',
  }),
  moon({
    id: 'nix', name: 'Nix', parent: 'pluto', radiusKm: 19, radiiKm: [25, 17.5, 16.5], albedo: 0.56, color: '#cfcbc6',
    orbit: { type: 'sat', fit: FIT.nix, barycentric: true }, shape: 'irregular', locked: false, spinHours: 43.9, priority: 5, subtitle: 'Moon of Pluto',
    blurb: 'A small, chaotically tumbling moon circling the Pluto–Charon binary.',
  }),
  moon({
    id: 'hydra', name: 'Hydra', parent: 'pluto', radiusKm: 19.6, radiiKm: [25.5, 18, 15.5], albedo: 0.83, color: '#d9d6d2',
    orbit: { type: 'sat', fit: FIT.hydra, barycentric: true }, shape: 'irregular', locked: false, spinHours: 10.3, priority: 5, subtitle: 'Moon of Pluto',
    blurb: 'Pluto’s outermost moon, spinning every 10 hours — nearly 90 times per orbit.',
  }),
  moon({
    id: 'kerberos', name: 'Kerberos', parent: 'pluto', radiusKm: 6, radiiKm: [9.5, 5, 4.5], albedo: 0.56, color: '#bdb8b2',
    orbit: { type: 'sat', fit: FIT.kerberos, barycentric: true }, shape: 'bilobed', locked: false, spinHours: 5.3, priority: 5, subtitle: 'Moon of Pluto',
    blurb: 'A double-lobed moonlet, 19 km long.',
  }),
  moon({
    id: 'styx', name: 'Styx', parent: 'pluto', radiusKm: 5, radiiKm: [8, 4.5, 4], albedo: 0.65, color: '#c8c3bd',
    orbit: { type: 'sat', fit: FIT.styx, barycentric: true }, shape: 'irregular', locked: false, spinHours: 77, priority: 5, subtitle: 'Moon of Pluto',
    blurb: 'The smallest of Pluto’s moons, discovered by Hubble in 2012.',
  }),
];

/** Pluto–Charon mass ratio (Brozović & Jacobson 2024): Charon/Pluto ≈ 0.1218. */
export const CHARON_PLUTO_MASS_RATIO = 1.586e21 / 1.303e22;

export { FIT as SATELLITE_FITS, KM_AU, MU_SUN };
