/**
 * Dwarf planets, notable asteroids, comets and spacecraft.
 *
 * Orbits: osculating heliocentric elements (J2000 ecliptic) from the JPL Small-Body Database
 * (ssd-api.jpl.nasa.gov/sbdb.api, retrieved 2026-09-22), propagated as two-body conics — accurate
 * to arc-minutes for years around each epoch; planetary perturbations accumulate beyond that.
 * Spacecraft: JPL Horizons heliocentric state vectors at 2026-09-23 TDB, propagated as hyperbolic
 * conics (valid after each craft's last planetary flyby).
 * Physical data: SBDB, mission results (Dawn, NEAR, OSIRIS-REx, Hayabusa2, Rosetta, New Horizons).
 */
import type { BodyDef, CometPhysics } from './types';
import type { ConicElements } from '../ephem/conic';
import { MU_SUN } from '../ephem/conic';
import { calendarToJD } from '../time';

const D = Math.PI / 180;
/** SBDB-style elements (deg) → conic (radians). */
const sb = (q: number, e: number, i: number, om: number, w: number, tp: number): ConicElements => ({
  q, e, i: i * D, node: om * D, peri: w * D, tp, mu: MU_SUN,
});

type SmallSpec = Omit<BodyDef, 'parent'> & { parent?: string };
const body = (b: SmallSpec): BodyDef => ({ parent: 'sun', ...b });

export const DWARFS_AND_ASTEROIDS: BodyDef[] = [
  body({
    id: 'ceres', name: 'Ceres', kind: 'dwarf', radiusKm: 469.7, radiiKm: [482.2, 482.1, 445.9], massKg: 9.3835e20, albedo: 0.09, color: '#a8a39c',
    rotation: { ra: 291.418, dec: 66.764, W0: 170.65, Wd: 952.1532635 },
    orbit: { type: 'conic', el: sb(2.545159361382861, 0.07969229514816586, 10.58802780183462, 80.24862682043221, 73.29421453021587, 2461599.841466614066) },
    planet: { kind: 'barren', radiusKm: 469.7, temperatureK: 168, atmosphere: null },
    priority: 2, subtitle: 'Dwarf planet · asteroid belt',
    blurb: 'A third of the belt’s mass in one round, briny world. Dawn found bright salt deposits in Occator crater, left by a slushy reservoir beneath.',
  }),
  body({
    id: 'vesta', name: 'Vesta', kind: 'asteroid', radiusKm: 262.7, radiiKm: [284.6, 277.2, 226.3], massKg: 2.59076e20, albedo: 0.42, color: '#c4b8a8',
    rotation: { ra: 309.031, dec: 42.235, W0: 285.39, Wd: 1617.3329428 },
    orbit: { type: 'conic', el: sb(2.148361914524259, 0.09020374382834395, 7.143925545058711, 103.701293265032, 151.4686478221564, 2460901.587379842988) },
    shape: 'ellipsoid', planet: { kind: 'barren', radiusKm: 262.7, temperatureK: 180, atmosphere: null },
    priority: 3, subtitle: 'Asteroid · protoplanet',
    blurb: 'A surviving protoplanet with a basaltic crust. The Rheasilvia impact basin at its south pole is 500 km wide; its debris is the Vesta family — and many meteorites on Earth.',
  }),
  body({
    id: 'pallas', name: 'Pallas', kind: 'asteroid', radiusKm: 256, radiiKm: [284, 266, 224], massKg: 2.04e20, albedo: 0.155, color: '#a19d97',
    spinHours: 7.8132,
    orbit: { type: 'conic', el: sb(2.130621471209779, 0.2307000995648547, 34.93279321851542, 172.8866193357694, 310.9699161652136, 2461695.03116438268) },
    shape: 'ellipsoid', planet: { kind: 'barren', radiusKm: 256, temperatureK: 164, atmosphere: null },
    priority: 3, subtitle: 'Asteroid · steeply inclined',
    blurb: 'Tilted 35° to the ecliptic — a golf-ball of a world battered by high-speed impacts.',
  }),
  body({
    id: 'hygiea', name: 'Hygiea', kind: 'asteroid', radiusKm: 203.6, radiiKm: [225, 215, 212], massKg: 8.74e19, albedo: 0.072, color: '#8c8883',
    spinHours: 13.828,
    orbit: { type: 'conic', el: sb(2.814735882015559, 0.1067092741240963, 3.829529946447122, 283.1198927508594, 312.4242387344704, 2461813.20082868179) },
    planet: { kind: 'barren', radiusKm: 203.6, temperatureK: 164, atmosphere: null },
    priority: 3, subtitle: 'Asteroid · nearly round',
    blurb: 'The fourth-largest asteroid, dark and almost spherical — perhaps reassembled after a giant collision.',
  }),
  body({
    id: 'psyche', name: 'Psyche', kind: 'asteroid', radiusKm: 111, radiiKm: [139, 119, 85.5], massKg: 2.29e19, albedo: 0.12, color: '#a7a39e',
    spinHours: 4.196,
    orbit: { type: 'conic', el: sb(2.53094576621639, 0.1349324738201893, 3.098749116151128, 149.9753859305033, 230.0326782748359, 2460795.475337075717) },
    shape: 'irregular', priority: 4, subtitle: 'Asteroid · metal-rich',
    blurb: 'Possibly the exposed iron core of a shattered protoplanet. NASA’s Psyche spacecraft arrives in 2029.',
  }),
  body({
    id: 'juno', name: 'Juno', kind: 'asteroid', radiusKm: 123.3, radiiKm: [144, 125, 112], albedo: 0.214, color: '#b4a592',
    spinHours: 7.21,
    orbit: { type: 'conic', el: sb(1.98801754864507, 0.2556999836681878, 12.98659236598085, 169.8115953492418, 247.8950743075613, 2461631.297203163838) },
    shape: 'irregular', priority: 4, subtitle: 'Asteroid',
    blurb: 'The third asteroid ever found (1804), a stony S-type body 250 km across.',
  }),
  body({
    id: 'eros', name: 'Eros', kind: 'asteroid', radiusKm: 8.42, radiiKm: [17.2, 5.6, 5.6], massKg: 6.687e15, albedo: 0.25, color: '#b39f86',
    rotation: { ra: 11.35, dec: 17.22, W0: 326.07, Wd: 1639.38864745 },
    orbit: { type: 'conic', el: sb(1.133233327946397, 0.2228779627700761, 10.82854410314273, 304.2679713350896, 178.9181319135911, 2461088.813494039683) },
    shape: 'irregular', priority: 4, subtitle: 'Near-Earth asteroid',
    blurb: 'A 34 km peanut; NEAR Shoemaker orbited it for a year and landed on it in 2001 — the first landing on an asteroid.',
  }),
  body({
    id: 'bennu', name: 'Bennu', kind: 'asteroid', radiusKm: 0.2419, radiiKm: [0.2524, 0.2459, 0.2284], massKg: 7.329e10, albedo: 0.044, color: '#6b6763',
    rotation: { ra: 85.3388, dec: -60.1688, W0: 150.57, Wd: 2011.1445 },
    orbit: { type: 'conic', el: sb(0.8968944004459729, 0.2037450762416414, 6.03494377024794, 2.06086619569642, 66.22306084084298, 2455439.14194087267) },
    shape: 'irregular', priority: 5, subtitle: 'Near-Earth asteroid · sampled',
    blurb: 'A spinning-top rubble pile of carbon-rich rock. OSIRIS-REx brought 121 g of it to Earth in 2023: amino acids, salts, and phosphates.',
  }),
  body({
    id: 'apophis', name: 'Apophis', kind: 'asteroid', radiusKm: 0.17, radiiKm: [0.225, 0.15, 0.13], albedo: 0.35, color: '#a39d95',
    spinHours: 30.56,
    orbit: { type: 'conic', el: sb(0.7460509677535309, 0.1911492279663492, 3.340996879880978, 203.8936514240762, 126.6795706895841, 2461042.919201488142) },
    shape: 'irregular', priority: 5, subtitle: 'Near-Earth asteroid',
    blurb: 'On 13 April 2029 this 340 m asteroid passes 32 000 km above Earth — inside the geostationary ring, visible to the naked eye. No impact risk for at least a century.',
  }),
  body({
    id: 'ryugu', name: 'Ryugu', kind: 'asteroid', radiusKm: 0.448, radiiKm: [0.502, 0.438, 0.438], massKg: 4.5e11, albedo: 0.045, color: '#5f5b58',
    spinHours: -7.63262,
    orbit: { type: 'conic', el: sb(0.9633664739388087, 0.1910730046480051, 5.866442486408568, 251.2897123995624, 211.608993811871, 2461118.296422313344) },
    shape: 'irregular', priority: 5, subtitle: 'Near-Earth asteroid · sampled',
    blurb: 'Hayabusa2 fired a copper impactor into it and returned 5 g of its pristine carbonaceous dust in 2020.',
  }),
  body({
    id: 'ida', name: 'Ida', kind: 'asteroid', radiusKm: 15.7, radiiKm: [29.9, 12.7, 9.3], albedo: 0.26, color: '#a8997f',
    spinHours: 4.634,
    orbit: { type: 'conic', el: sb(2.731320119246325, 0.04610962795708528, 1.130363094271507, 323.5366609419851, 113.2571826848795, 2460956.434615665439) },
    shape: 'irregular', priority: 5, subtitle: 'Asteroid · Koronis family',
    blurb: 'The first asteroid found to have a moon: 1.4 km Dactyl, imaged by Galileo in 1993.',
  }),
  body({
    id: 'lutetia', name: 'Lutetia', kind: 'asteroid', radiusKm: 49, radiiKm: [60.5, 50.5, 37.5], massKg: 1.7e18, albedo: 0.19, color: '#a29c94',
    spinHours: 8.1655,
    orbit: { type: 'conic', el: sb(2.033308734220419, 0.1647703512177245, 3.064452891064415, 80.83855721319993, 249.8802780888828, 2461436.459564184442) },
    shape: 'irregular', priority: 5, subtitle: 'Asteroid',
    blurb: 'Rosetta flew past in 2010: an ancient, dense body that may be a leftover planetesimal from the inner Solar System.',
  }),
  body({
    id: 'hektor', name: 'Hektor', kind: 'asteroid', radiusKm: 112.5, radiiKm: [185, 100, 95], albedo: 0.025, color: '#7a5f52',
    spinHours: 6.924,
    orbit: { type: 'conic', el: sb(5.148518434353456, 0.02434489234275647, 18.14715224028094, 342.8018513679027, 181.288859678094, 2460894.080956281625) },
    shape: 'bilobed', priority: 4, subtitle: 'Jupiter Trojan · L4',
    blurb: 'The largest Jupiter Trojan: a dark, reddish double-lobed body 60° ahead of Jupiter, with a small moon.',
  }),
  body({
    id: 'hilda', name: 'Hilda', kind: 'asteroid', radiusKm: 85.3, albedo: 0.062, color: '#7f7872',
    spinHours: 5.9585,
    orbit: { type: 'conic', el: sb(3.418817018532514, 0.1384847714022829, 7.831389294038131, 228.0800257005049, 39.0661557941409, 2460087.651208655072) },
    shape: 'irregular', priority: 4, subtitle: 'Asteroid · 3:2 resonance',
    blurb: 'Namesake of the Hildas, which orbit the Sun three times for every two Jovian years and trace a slowly turning triangle.',
  }),
  body({
    id: 'cruithne', name: 'Cruithne', kind: 'asteroid', radiusKm: 1.04, albedo: 0.36, color: '#aba69f',
    spinHours: 27.31,
    orbit: { type: 'conic', el: sb(0.4840278155072256, 0.5149036013028605, 19.80238133612434, 126.1886918424181, 43.8830157643464, 2461380.368895556011) },
    shape: 'irregular', priority: 5, subtitle: 'Asteroid · Earth co-orbital',
    blurb: 'Shares Earth’s orbital period; seen from Earth it traces a slow horseshoe around our orbit.',
  }),
  body({
    id: 'didymos', name: 'Didymos', kind: 'asteroid', radiusKm: 0.39, radiiKm: [0.4, 0.39, 0.38], albedo: 0.15, color: '#9d978f',
    spinHours: 2.2593,
    orbit: { type: 'conic', el: sb(1.013349242511927, 0.3831233242624545, 3.413876519313629, 72.9858236207145, 319.5807001349104, 2461412.277780167719) },
    shape: 'irregular', priority: 5, subtitle: 'Near-Earth binary asteroid',
    blurb: 'In 2022 NASA’s DART spacecraft struck its moonlet Dimorphos and shortened its orbit by 33 minutes — the first test of planetary defence.',
  }),
  body({
    id: 'eris', name: 'Eris', kind: 'dwarf', radiusKm: 1163, massKg: 1.6466e22, albedo: 0.96, color: '#ebe7e1',
    spinHours: 378.9,
    orbit: { type: 'conic', el: sb(38.16267353549761, 0.4382385347971672, 43.9258279471791, 36.00477044417249, 150.7949235840312, 2545407.716847013144) },
    planet: { kind: 'ice', radiusKm: 1163, temperatureK: 42, ice: 1, atmosphere: null },
    priority: 2, subtitle: 'Dwarf planet · scattered disc',
    blurb: 'Almost Pluto’s size but 27 % more massive; its discovery in 2005 led the IAU to define “planet”. It is now near aphelion, 96 AU away.',
  }),
  body({
    id: 'haumea', name: 'Haumea', kind: 'dwarf', radiusKm: 780, radiiKm: [1161, 852, 513], massKg: 4.006e21, albedo: 0.51, color: '#e6e3df',
    spinHours: 3.9155,
    orbit: { type: 'conic', el: sb(34.68751758088936, 0.1944430148898797, 28.20847393040364, 121.7860561329425, 240.6905472508661, 2500416.59961528275) },
    shape: 'ellipsoid', planet: { kind: 'ice', radiusKm: 780, temperatureK: 50, ice: 1, atmosphere: null },
    priority: 2, subtitle: 'Dwarf planet · spins every 3.9 h',
    blurb: 'Spinning so fast it has stretched into an egg twice as long as it is thick. It has two moons and a ring.',
  }),
  body({
    id: 'makemake', name: 'Makemake', kind: 'dwarf', radiusKm: 715, massKg: 3.1e21, albedo: 0.82, color: '#e3c7a6',
    spinHours: 22.83,
    orbit: { type: 'conic', el: sb(38.33021338173601, 0.1588889953992523, 29.02785603743067, 79.2948338209406, 297.0922733397207, 2408158.694098616288) },
    planet: { kind: 'ice', radiusKm: 715, temperatureK: 40, ice: 1, atmosphere: null },
    priority: 2, subtitle: 'Dwarf planet · classical Kuiper belt',
    blurb: 'Bright, reddish methane ice on a world two-thirds Pluto’s size.',
  }),
  body({
    id: 'gonggong', name: 'Gonggong', kind: 'dwarf', radiusKm: 615, massKg: 1.75e21, albedo: 0.14, color: '#c47c5c',
    spinHours: 22.4,
    orbit: { type: 'conic', el: sb(33.14908264104688, 0.5042510000302973, 30.89906721170288, 336.8383156185827, 206.6232839773693, 2399252.724653532496) },
    planet: { kind: 'barren', radiusKm: 615, temperatureK: 36, atmosphere: null },
    priority: 3, subtitle: 'Dwarf planet · scattered disc',
    blurb: 'One of the reddest large bodies known, coated in organic tholins.',
  }),
  body({
    id: 'quaoar', name: 'Quaoar', kind: 'dwarf', radiusKm: 555, massKg: 1.2e21, albedo: 0.11, color: '#b58a70',
    spinHours: 17.68,
    orbit: { type: 'conic', el: sb(41.63706885746655, 0.03520023677935285, 7.991575801906905, 188.9191248447958, 163.2090510089555, 2480516.376493195825) },
    planet: { kind: 'barren', radiusKm: 555, temperatureK: 40, atmosphere: null },
    priority: 3, subtitle: 'Dwarf planet · classical Kuiper belt',
    blurb: 'Its ring orbits at 7.4 radii — far outside the Roche limit where rings should gather into moons.',
  }),
  body({
    id: 'orcus', name: 'Orcus', kind: 'dwarf', radiusKm: 455, massKg: 6.3e20, albedo: 0.23, color: '#bcb8b4',
    spinHours: 10.47,
    orbit: { type: 'conic', el: sb(30.69331904442224, 0.2205240628250881, 20.55681019612, 268.4053519455824, 73.56848606705262, 2504046.134962433665) },
    planet: { kind: 'ice', radiusKm: 455, temperatureK: 42, atmosphere: null },
    priority: 3, subtitle: 'Dwarf planet · plutino',
    blurb: 'The “anti-Pluto”: in the same 3:2 resonance with Neptune, but always on the opposite side of its orbit.',
  }),
  body({
    id: 'sedna', name: 'Sedna', kind: 'dwarf', radiusKm: 500, albedo: 0.32, color: '#c9603f',
    spinHours: 10.273,
    orbit: { type: 'conic', el: sb(76.18464364627253, 0.8598824585187618, 11.92527582847476, 144.5061662673739, 311.0987725939751, 2479264.750687138669) },
    planet: { kind: 'barren', radiusKm: 500, temperatureK: 30, atmosphere: null },
    priority: 3, subtitle: 'Detached object · inner Oort cloud?',
    blurb: 'Its 11 400-year orbit never comes closer than 76 AU — too far for Neptune to have placed it. Something else did: a passing star, or an unseen planet.',
  }),
  body({
    id: 'arrokoth', name: 'Arrokoth', kind: 'asteroid', radiusKm: 9, radiiKm: [18, 10, 5], albedo: 0.21, color: '#a8583c',
    spinHours: 15.92,
    orbit: { type: 'conic', el: sb(42.48619305808604, 0.03555717645015258, 2.450613924655929, 159.0377267890618, 188.8507463365642, 2475741.40387305351) },
    shape: 'bilobed', priority: 4, subtitle: 'Cold classical Kuiper belt object',
    blurb: 'A pristine contact binary — two lobes that merged gently 4.5 billion years ago. New Horizons flew past on 1 January 2019, 6.6 billion km from Earth.',
  }),
];

const comet = (b: Omit<SmallSpec, 'kind' | 'albedo' | 'priority'> & { comet: CometPhysics; priority?: number }): BodyDef =>
  body({ kind: 'comet', albedo: 0.04, priority: b.priority ?? 4, shape: 'irregular', ...b });

export const COMETS: BodyDef[] = [
  comet({
    id: 'halley', name: '1P/Halley', radiusKm: 5.5, radiiKm: [7.6, 4.1, 4.1], color: '#cfe0ff',
    spinHours: 52.8,
    orbit: { type: 'conic', el: sb(0.5748638313743413, 0.9679359956953211, 162.1905300439129, 59.09894720612437, 112.2414314637764, 2446469.973616146677) },
    comet: { M1: 5.5, K1: 8, rCut: 3.2, dust: 0.65, nucleusKm: 5.5 },
    priority: 3, subtitle: 'Periodic comet · 76 years · retrograde',
    blurb: 'The first comet whose return was predicted (Halley, 1705). Recorded at every perihelion since 240 BC; next back in July 2061. Parent of the Eta Aquariid and Orionid meteors.',
  }),
  comet({
    id: 'hale-bopp', name: 'Hale–Bopp', radiusKm: 30, color: '#dfe6ff',
    spinHours: 11.3,
    orbit: { type: 'conic', el: sb(0.890537663547794, 0.9949810027633206, 89.28759424740302, 282.7334213961641, 130.4146670659176, 2450537.134907143944) },
    comet: { M1: -1.3, K1: 7.5, rCut: 7, dust: 1, nucleusKm: 30 },
    priority: 3, subtitle: 'C/1995 O1 · the Great Comet of 1997',
    blurb: 'Visible to the naked eye for a record 18 months, with a white dust tail and a separate blue ion tail. Its 60 km nucleus returns in about 2 400 years.',
  }),
  comet({
    id: '67p', name: '67P/Churyumov–Gerasimenko', radiusKm: 1.65, radiiKm: [2.05, 1.65, 1.2], color: '#d9e4ff',
    rotation: { ra: 69.54, dec: 64.11, W0: 114.69, Wd: 696.543884 },
    orbit: { type: 'conic', el: sb(1.243265640702404, 0.6409081308996354, 7.040294937543767, 50.13557377155012, 12.79824970228189, 2457247.588657812098) },
    comet: { M1: 12.9, K1: 7.5, rCut: 3.5, dust: 0.45, nucleusKm: 1.65 },
    shape: 'bilobed', subtitle: 'Jupiter-family comet · 6.4 years',
    blurb: 'Rosetta orbited this 4 km “rubber duck” for two years and put the Philae lander on it in 2014.',
  }),
  comet({
    id: 'encke', name: '2P/Encke', radiusKm: 2.4, color: '#d4e2ff',
    spinHours: 11.08,
    orbit: { type: 'conic', el: sb(0.3394821819631164, 0.8470279034259183, 11.342270038, 334.0454694778515, 187.2630430521377, 2460240.009056778996) },
    comet: { M1: 10.5, K1: 10, rCut: 2.5, dust: 0.3, nucleusKm: 2.4 },
    subtitle: 'Periodic comet · 3.3 years',
    blurb: 'The shortest-period bright comet, returning every 3.3 years; its debris makes the Taurid meteors.',
  }),
  comet({
    id: 'neowise', name: 'NEOWISE', radiusKm: 2.5, color: '#e4eaff',
    orbit: { type: 'conic', el: sb(0.2946512493809196, 0.9991780262531292, 128.9375027594809, 61.01042818536988, 37.2786584481257, 2459034.178898044365) },
    comet: { M1: 6.5, K1: 12, rCut: 3, dust: 0.9, nucleusKm: 2.5 },
    subtitle: 'C/2020 F3 · summer 2020',
    blurb: 'The brightest comet of the northern sky since Hale–Bopp, with a curving, striated dust tail. It will be back in about 6 800 years.',
  }),
  comet({
    id: 'pons-brooks', name: '12P/Pons–Brooks', radiusKm: 15, color: '#d8e6ff',
    orbit: { type: 'conic', el: sb(0.7808611331423883, 0.9545612442767357, 74.19091017013747, 255.8553510995133, 198.9879994677832, 2460421.631159499004) },
    comet: { M1: 5, K1: 15, rCut: 4, dust: 0.45, nucleusKm: 15 },
    subtitle: 'Periodic comet · 71 years',
    blurb: 'Known for explosive outbursts that gave its coma horn-like shapes in 2023; perihelion in April 2024.',
  }),
  comet({
    id: 'tsuchinshan-atlas', name: 'Tsuchinshan–ATLAS', radiusKm: 5, color: '#e1e8ff',
    orbit: { type: 'conic', el: sb(0.3914300748355564, 1.000095368540586, 139.112109080566, 21.55947897244586, 308.4917649633916, 2460581.240845175775) },
    comet: { M1: 4.5, K1: 10, rCut: 7, dust: 0.95, nucleusKm: 5 },
    subtitle: 'C/2023 A3 · October 2024',
    blurb: 'A great comet of 2024 with a long dust tail and a sunward anti-tail. Its orbit is now hyperbolic: it will not return.',
  }),
  comet({
    id: '3i-atlas', name: '3I/ATLAS', radiusKm: 2.5, color: '#e6ecff',
    orbit: { type: 'conic', el: sb(1.356481057231181, 6.141351449317625, 175.1164570850441, 322.1696089290778, 128.0228697185194, 2460977.995262847653) },
    comet: { M1: 12.5, K1: 4.5, rCut: 5, dust: 0.5, nucleusKm: 2.5 },
    priority: 3, subtitle: 'Interstellar comet · e = 6.1',
    blurb: 'The third known visitor from another star system, arriving at 58 km/s in 2025 on a steeply hyperbolic path. It may be older than the Sun.',
  }),
  comet({
    id: 'swift-tuttle', name: '109P/Swift–Tuttle', radiusKm: 13, color: '#d6e3ff',
    orbit: { type: 'conic', el: sb(0.959516155068868, 0.963225755046038, 113.453816997171, 139.3811920815948, 152.9821676305871, 2448968.499784556297) },
    comet: { M1: 4.5, K1: 15, rCut: 3.2, dust: 0.6, nucleusKm: 13 },
    subtitle: 'Periodic comet · 133 years',
    blurb: 'The parent of the Perseid meteors every August — the largest object that repeatedly crosses Earth’s orbit. Next perihelion: 2126.',
  }),
  comet({
    id: 'mcnaught', name: 'McNaught', radiusKm: 12.5, color: '#e8ecff',
    orbit: { type: 'conic', el: sb(0.1707364648528884, 1.000018815882278, 77.83700054890942, 267.4148026435385, 155.9749681149126, 2454113.298843632772) },
    comet: { M1: 5.4, K1: 20.75, rCut: 3, dust: 1, nucleusKm: 12.5 },
    subtitle: 'C/2006 P1 · the Great Comet of 2007',
    blurb: 'Its dust tail fanned across 35° of the southern sky in January 2007, combed into striae by the Sun’s light pressure.',
  }),
  comet({
    id: 'ikeya-seki', name: 'Ikeya–Seki', radiusKm: 5, color: '#eef1ff',
    orbit: { type: 'conic', el: sb(0.007786, 0.999915, 141.8642, 346.9947, 69.0486, 2439054.6837) },
    comet: { M1: 6, K1: 10, rCut: 2, dust: 0.9, nucleusKm: 5 },
    subtitle: 'C/1965 S1 · Kreutz sungrazer',
    blurb: 'Grazed 450 000 km above the Sun’s surface in October 1965 and broke into three pieces — one of the brightest comets of the millennium.',
  }),
  comet({
    id: 'bok', name: 'Bok', radiusKm: 3, color: '#dde7ff',
    orbit: { type: 'conic', el: sb(1.93780806531261, 0.9976281629146271, 82.30577352901797, 206.5888159014548, 155.9368257273623, 2461396.854090574628) },
    comet: { M1: 8.8, K1: 12.75, rCut: 4, dust: 0.5, nucleusKm: 3 },
    subtitle: 'C/2026 A2 · perihelion Dec 2026',
    blurb: 'A long-period comet arriving now, reaching perihelion at 1.94 AU on 22 December 2026.',
  }),
  comet({
    id: 'panstarrs-m2', name: 'PANSTARRS (M2)', radiusKm: 8, color: '#dde6ff',
    orbit: { type: 'conic', el: sb(2.72091182327501, 1.001926352725311, 173.215283219783, 305.5341508440158, 96.75474460812916, 2461733.000470293006) },
    comet: { M1: 4.7, K1: 12, rCut: 8, dust: 0.6, nucleusKm: 8 },
    subtitle: 'C/2025 M2 · perihelion Nov 2027',
    blurb: 'A large, distant, retrograde comet already active far beyond Jupiter, falling in for a November 2027 perihelion at 2.7 AU.',
  }),
];

const craft = (b: Omit<SmallSpec, 'kind' | 'albedo' | 'priority' | 'radiusKm'> & { priority?: number }): BodyDef =>
  body({ kind: 'spacecraft', albedo: 0.5, radiusKm: 0.002, priority: b.priority ?? 3, ...b });

export const SPACECRAFT: BodyDef[] = [
  craft({
    id: 'voyager-1', name: 'Voyager 1', color: '#ffe2b8',
    orbit: { type: 'state', jd: 2461306.5, r: [-32.15345863119892, -136.7617088694136, 98.94980483121891], v: [-0.001195521269499995, -0.007861186711304268, 0.005678475293754538] },
    visibleFrom: calendarToJD(1980, 11, 13),
    subtitle: 'Spacecraft · interstellar space since 2012',
    blurb: 'Launched 1977; the most distant human-made object, crossing the heliopause at 121 AU in August 2012. On 14 February 1990 it turned back to take the Pale Blue Dot.',
  }),
  craft({
    id: 'voyager-2', name: 'Voyager 2', color: '#ffe2b8',
    orbit: { type: 'state', jd: 2461306.5, r: [39.87085085396552, -105.4211924714468, -89.65102447278164], v: [0.002427678701644913, -0.005394509818564277, -0.006536062147957701] },
    visibleFrom: calendarToJD(1989, 8, 26),
    subtitle: 'Spacecraft · the only visitor to Uranus and Neptune',
    blurb: 'The only spacecraft to have visited Uranus (1986) and Neptune (1989); it left the heliosphere in November 2018, heading south of the ecliptic.',
  }),
  craft({
    id: 'new-horizons', name: 'New Horizons', color: '#ffe2b8',
    orbit: { type: 'state', jd: 2461306.5, r: [20.82264689820093, -62.2181423349853, 2.288248718492476], v: [0.003065635803603914, -0.007213686177039731, 0.0002838929200376568] },
    visibleFrom: calendarToJD(2007, 3, 1),
    subtitle: 'Spacecraft · Pluto 2015, Arrokoth 2019',
    blurb: 'The fastest spacecraft ever launched from Earth; it flew past Pluto in July 2015 and Arrokoth on New Year’s Day 2019.',
  }),
  craft({
    id: 'pioneer-10', name: 'Pioneer 10', color: '#e8d6c0',
    orbit: { type: 'state', jd: 2461306.5, r: [24.06539764468817, 139.6227593115088, 7.389635031194412], v: [0.0007086013796471469, 0.006798313628122529, 0.0003482866034564203] },
    visibleFrom: calendarToJD(1973, 12, 5),
    priority: 4, subtitle: 'Spacecraft · silent since 2003',
    blurb: 'The first probe to cross the asteroid belt and visit Jupiter (1973). It carries a plaque for anyone who finds it.',
  }),
  craft({
    id: 'pioneer-11', name: 'Pioneer 11', color: '#e8d6c0',
    orbit: { type: 'state', jd: 2461306.5, r: [29.0683526470343, -110.7218315696996, 28.21798011251607], v: [0.002331835311586491, -0.005830983515503426, 0.001404277676424362] },
    visibleFrom: calendarToJD(1979, 9, 2),
    priority: 4, subtitle: 'Spacecraft · silent since 1995',
    blurb: 'The first spacecraft to visit Saturn (1979), now drifting toward the constellation Aquila.',
  }),
];
