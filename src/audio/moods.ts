import type { MoodParams } from './AudioBus';
import { foldToOctave, hzToMidi, noteName, type ModeName } from './theory';

/**
 * Moods: what each world sounds like, as pure data. `resolveMood(name, params)` turns an
 * experience's description of the scene (setMood) into a complete score specification.
 *
 * Several keys are *derived from physics* by octave transposition (pitch class is preserved,
 * as in NASA's sonification of the Perseus cluster, raised 57 octaves):
 *  - Black hole: orbital frequency at the innermost stable circular orbit,
 *      f_ISCO = c³ / (2π G M (r_isco^{3/2} + a)),  r_isco from Bardeen, Press & Teukolsky (1972).
 *      Sgr A* (4.3 × 10⁶ M☉, a = 0): 0.51 mHz. Heavier holes → lower f → different key.
 *  - Sun: the 5-minute p-mode oscillations, ν_max ≈ 3.09 mHz (Kjeldsen & Bedding 1995).
 *  - Cosmic web: the peak of the CMB blackbody today, ν = 58.79 GHz/K × 2.7255 K = 160.2 GHz (Wien).
 *  - Possible worlds: the Wien peak frequency of the host star, ν = 58.79 GHz/K × T_eff.
 *  - Earth: the fundamental Schumann resonance of the Earth–ionosphere cavity, 7.83 Hz — audible
 *    as a slow shimmer (tremolo) on the drone.
 *  - Nebulae: bell partials in the frequency ratios of the strongest emission lines
 *    (Hα 656.3, Hβ 486.1, [O III] 500.7/495.9, [N II] 658.4, [S II] 671.6/673.1, [O II] 372.7 nm).
 */

export type BellKind = 'harmonic' | 'glass' | 'spectral';

export interface MoodSpec {
  /** Canonical mood id. */
  id: string;
  /** Tonic of the pad (MIDI, octave 2–3). */
  tonic: number;
  mode: ModeName;
  /** Pad chord progression as scale degrees (0-based). */
  progression: number[];
  /** Jazz layer chord degrees (2 bars each). */
  jazz: number[];
  /** Pad level 0..1. */
  pad: number;
  /** Pad low-pass brightness 0..1 (maps to ~250 Hz … 4 kHz). */
  brightness: number;
  /** Sub drone level 0..1. */
  drone: number;
  /** Drone octave offset below the tonic (−1 or −2). */
  droneOct: number;
  /** Beating between the two drone oscillators, Hz (tension). */
  beat: number;
  /** Bell rate (events per second, Poisson). */
  bells: number;
  bellKind: BellKind;
  /** Bell partial list (harmonic numbers of the tonic or frequency ratios). */
  partials: number[];
  /** Bell pitch shift in octaves (e.g. relativistic Doppler in Voyage). */
  bellShift: number;
  /** Filtered-noise "wind" level 0..1 and centre frequency Hz. */
  noise: number;
  noiseHz: number;
  /** Reverb decay RT60 (s) and wet mix 0..1. */
  rt60: number;
  space: number;
  /** Jazz tempo (BPM). */
  tempo: number;
  /** Drone tremolo rate (Hz) and depth 0..1. */
  tremoloHz: number;
  tremolo: number;
  /** Low rumble bed 0..1 (collisions). */
  rumble: number;
  /** Pulse (pulsar) tick rate Hz, 0 = none. */
  pulse: number;
  /** Human-readable key and where it comes from. */
  key: string;
  origin: string;
}

const C = 299_792_458;
const G = 6.6743e-11;
const M_SUN = 1.98847e30;
/** Wien displacement law in frequency form: ν_peak = 5.879 × 10¹⁰ Hz/K · T. */
export const WIEN_FREQ = 5.878925757e10;
export const T_CMB = 2.7255;
export const SCHUMANN_HZ = 7.83;
export const SOLAR_NU_MAX = 3.09e-3;

/** Prograde ISCO radius in units of GM/c² for dimensionless spin a (BPT 1972). */
export function iscoRadiusBPT(a: number): number {
  const s = Math.max(-0.9999, Math.min(0.9999, a));
  const z1 = 1 + Math.cbrt(1 - s * s) * (Math.cbrt(1 + s) + Math.cbrt(1 - s));
  const z2 = Math.sqrt(3 * s * s + z1 * z1);
  return 3 + z2 - Math.sign(s || 1) * Math.sqrt((3 - z1) * (3 + z1 + 2 * z2));
}

/** Orbital frequency (Hz, as seen from infinity) of a circular equatorial orbit at the ISCO. */
export function iscoOrbitalFrequency(massSolar: number, spin = 0): number {
  const r = iscoRadiusBPT(spin);
  const omega = (C * C * C) / (G * massSolar * M_SUN) / (Math.pow(r, 1.5) + spin);
  return omega / (2 * Math.PI);
}

/** A physical frequency → a tonic MIDI note in octave 2 (C2 = 36 … B2 = 47) + description. */
export function physicalTonic(f: number): { tonic: number; octaves: number } {
  const { hz, octaves } = foldToOctave(f, 65.406); // C2
  let m = Math.round(hzToMidi(hz));
  if (m > 47) m -= 12;
  return { tonic: m, octaves };
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Emission lines (nm) used as spectral bell ratios, relative to Hα. */
export const NEBULA_LINES_NM = [656.3, 486.1, 500.7, 495.9, 658.4, 671.6, 372.7];

const ALIASES: Record<string, string> = {
  blackhole: 'gargantua',
  galaxy: 'milkyway',
  planets: 'solar',
  web: 'cosmos',
};

type Base = Omit<MoodSpec, 'id' | 'key' | 'origin' | 'bellShift' | 'rumble' | 'pulse'> & { origin?: string };

const BASE: Record<string, Base> = {
  silence: {
    tonic: 38, mode: 'lydian', progression: [0], jazz: [0, 1], pad: 0, brightness: 0.2, drone: 0, droneOct: -1, beat: 0.1,
    bells: 0, bellKind: 'harmonic', partials: [4], noise: 0, noiseHz: 400, rt60: 4, space: 0.3, tempo: 84, tremoloHz: 0, tremolo: 0,
  },
  prelude: {
    // The night sky before a world is chosen: open Lydian wonder, sparse harmonic-series bells.
    tonic: 38, mode: 'lydian', progression: [0, 1, 4, 0, 5, 1], jazz: [0, 1], pad: 0.8, brightness: 0.36, drone: 0.4, droneOct: -1, beat: 0.07,
    bells: 0.12, bellKind: 'harmonic', partials: [6, 8, 9, 10, 12, 15, 16, 18], noise: 0.12, noiseHz: 700, rt60: 7, space: 0.6, tempo: 82,
    tremoloHz: 0, tremolo: 0, origin: 'An open Lydian sky; bells from the natural harmonic series.',
  },
  cosmos: {
    tonic: 36, mode: 'lydian', progression: [0, 4, 1, 5], jazz: [0, 1], pad: 0.85, brightness: 0.3, drone: 0.55, droneOct: -1, beat: 0.05,
    bells: 0.09, bellKind: 'glass', partials: [4, 6, 8, 9, 12, 16], noise: 0.16, noiseHz: 520, rt60: 9, space: 0.68, tempo: 76,
    tremoloHz: 0, tremolo: 0,
  },
  gargantua: {
    tonic: 38, mode: 'aeolian', progression: [0, 5, 3, 0, 6], jazz: [0, 5], pad: 0.75, brightness: 0.24, drone: 0.85, droneOct: -2, beat: 0.12,
    bells: 0.05, bellKind: 'glass', partials: [5, 7, 9, 11, 13], noise: 0.1, noiseHz: 300, rt60: 11, space: 0.72, tempo: 66,
    tremoloHz: 0, tremolo: 0,
  },
  milkyway: {
    tonic: 45, mode: 'dorian', progression: [0, 3, 6, 3], jazz: [0, 3], pad: 0.85, brightness: 0.4, drone: 0.45, droneOct: -1, beat: 0.06,
    bells: 0.14, bellKind: 'harmonic', partials: [4, 5, 6, 8, 9, 10, 12], noise: 0.1, noiseHz: 900, rt60: 7, space: 0.6, tempo: 88,
    tremoloHz: 0, tremolo: 0, origin: 'Warm Dorian: the density wave turning.',
  },
  collision: {
    tonic: 42, mode: 'phrygian', progression: [0, 1, 0, 6], jazz: [0, 6], pad: 0.75, brightness: 0.3, drone: 0.7, droneOct: -1, beat: 0.18,
    bells: 0.06, bellKind: 'glass', partials: [5, 7, 9, 11], noise: 0.14, noiseHz: 380, rt60: 8, space: 0.6, tempo: 96,
    tremoloHz: 0, tremolo: 0, origin: 'Phrygian tension; the rumble swells at each pericentre passage.',
  },
  nebulae: {
    tonic: 40, mode: 'lydian', progression: [0, 1, 5, 1], jazz: [0, 1], pad: 0.85, brightness: 0.42, drone: 0.4, droneOct: -1, beat: 0.05,
    bells: 0.16, bellKind: 'spectral', partials: NEBULA_LINES_NM.map((l) => 656.3 / l), noise: 0.14, noiseHz: 1200, rt60: 8, space: 0.66,
    tempo: 80, tremoloHz: 0, tremolo: 0,
    origin: 'Bells tuned to the ratios of Hα, Hβ, [O III], [N II], [S II] and [O II] line frequencies.',
  },
  solar: {
    tonic: 45, mode: 'mixolydian', progression: [0, 6, 3, 0], jazz: [0, 6], pad: 0.85, brightness: 0.44, drone: 0.5, droneOct: -1, beat: 0.05,
    bells: 0.13, bellKind: 'harmonic', partials: [4, 5, 6, 8, 10, 12], noise: 0.08, noiseHz: 1000, rt60: 6, space: 0.55, tempo: 86,
    tremoloHz: 0, tremolo: 0,
  },
  earth: {
    tonic: 38, mode: 'dorian', progression: [0, 3, 0, 4, 6], jazz: [0, 3], pad: 0.9, brightness: 0.46, drone: 0.4, droneOct: -1, beat: 0.04,
    bells: 0.1, bellKind: 'harmonic', partials: [4, 6, 8, 9, 10, 12], noise: 0.2, noiseHz: 650, rt60: 6, space: 0.55, tempo: 82,
    tremoloHz: SCHUMANN_HZ, tremolo: 0.18,
    origin: 'The drone shimmers at 7.83 Hz, the Schumann resonance of the Earth–ionosphere cavity.',
  },
  worlds: {
    tonic: 43, mode: 'lydian', progression: [0, 1, 4, 5], jazz: [0, 1], pad: 0.85, brightness: 0.42, drone: 0.45, droneOct: -1, beat: 0.06,
    bells: 0.14, bellKind: 'harmonic', partials: [4, 5, 6, 7, 8, 9, 11, 12], noise: 0.1, noiseHz: 850, rt60: 7, space: 0.6, tempo: 90,
    tremoloHz: 0, tremolo: 0,
  },
  voyage: {
    tonic: 47, mode: 'lydian', progression: [0, 1, 4, 1], jazz: [0, 1], pad: 0.85, brightness: 0.38, drone: 0.5, droneOct: -1, beat: 0.05,
    bells: 0.1, bellKind: 'glass', partials: [4, 6, 8, 9, 12], noise: 0.12, noiseHz: 700, rt60: 8, space: 0.62, tempo: 100,
    tremoloHz: 0, tremolo: 0, origin: 'Bells shift by the relativistic Doppler factor √((1+β)/(1−β)) of the ship.',
  },
};

export const MOOD_IDS = Object.keys(BASE).filter((k) => k !== 'silence');

export function canonicalMood(name: string): string {
  const n = ALIASES[name] ?? name;
  return BASE[n] ? n : 'prelude';
}

const MODE_LABEL: Record<ModeName, string> = {
  ionian: 'major',
  dorian: 'Dorian',
  phrygian: 'Phrygian',
  lydian: 'Lydian',
  mixolydian: 'Mixolydian',
  aeolian: 'Aeolian',
};

const sci = (x: number) => {
  const e = Math.floor(Math.log10(Math.abs(x)));
  const m = x / Math.pow(10, e);
  const sup = String(e).replace(/-/g, '⁻').replace(/\d/g, (d) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(d)]);
  return e === 0 ? m.toFixed(2) : `${m.toFixed(2)} × 10${sup}`;
};

/** Resolve a mood name + scene hints into a full score specification. Pure. */
export function resolveMood(name: string, params: MoodParams = {}): MoodSpec {
  const id = name === 'silence' ? 'silence' : canonicalMood(name);
  const b = BASE[id];
  const I = clamp01(num(params.intensity, 0.3));
  const s: MoodSpec = { ...b, progression: b.progression.slice(), jazz: b.jazz.slice(), partials: b.partials.slice(), id, bellShift: 0, rumble: 0, pulse: 0, key: '', origin: b.origin ?? '' };

  // Intensity: brighter, denser, more drone — shared by every world.
  s.brightness = clamp01(b.brightness + 0.28 * (I - 0.3));
  s.drone = clamp01(b.drone * (0.75 + 0.6 * I));
  s.bells = b.bells * (0.7 + 0.9 * I);

  switch (id) {
    case 'gargantua': {
      const mass = Math.max(1, num(params.mass, 4.3e6));
      const spin = Math.max(0, Math.min(0.998, num(params.spin, 0)));
      const f = iscoOrbitalFrequency(mass, spin);
      const t = physicalTonic(f);
      s.tonic = t.tonic;
      // Proximity (intensity rises as the camera nears the hole): deeper, louder, tenser.
      s.drone = clamp01(0.55 + 0.5 * I);
      s.beat = 0.06 + 0.5 * I * I;
      s.brightness = clamp01(0.3 - 0.14 * I);
      s.origin = `Key from the ISCO orbital frequency of a ${sci(mass)} M☉ hole, ${sci(f)} Hz, raised ${t.octaves} octaves.`;
      break;
    }
    case 'solar': {
      const t = physicalTonic(SOLAR_NU_MAX);
      s.tonic = t.tonic + 12 * (t.tonic < 40 ? 1 : 0);
      s.origin = `Key from the Sun's 5-minute oscillations (3.09 mHz), raised ${t.octaves} octaves.`;
      break;
    }
    case 'cosmos': {
      const t = physicalTonic(WIEN_FREQ * T_CMB);
      s.tonic = t.tonic;
      const z = Math.max(0, num(params.z, 0));
      // The young universe is hot and bright; today's is dark and spacious.
      const hot = clamp01(Math.log10(1 + z) / 3);
      s.brightness = clamp01(s.brightness + 0.25 * hot);
      s.noise = b.noise * (1 + 0.8 * hot);
      s.noiseHz = b.noiseHz * (1 + 2 * hot);
      s.origin = `Key from the peak of the cosmic microwave background, 160 GHz, lowered ${-t.octaves} octaves.`;
      break;
    }
    case 'worlds': {
      const teff = num(params.teff, 0);
      if (teff > 0) {
        const t = physicalTonic(WIEN_FREQ * teff);
        s.tonic = t.tonic + 12 * (t.tonic < 40 ? 1 : 0);
        // Hot blue stars: Lydian and bright; cool red dwarfs: Dorian and dark.
        s.mode = teff > 6500 ? 'lydian' : teff > 4500 ? 'mixolydian' : 'dorian';
        s.brightness = clamp01(0.22 + 0.3 * Math.min(1, Math.log10(teff / 2500) / Math.log10(12)));
        s.origin = `Key from the Wien peak of a ${Math.round(teff)} K star, ${sci(WIEN_FREQ * teff)} Hz, lowered ${-t.octaves} octaves.`;
      }
      const n = num(params.planets, 0);
      if (n > 0) s.bells = s.bells * (0.6 + 0.12 * Math.min(8, n));
      break;
    }
    case 'voyage': {
      const beta = Math.max(0, Math.min(0.999, num(params.speed, 0)));
      // Light (and here, sound) from ahead is blue-shifted by D = √((1+β)/(1−β)).
      s.bellShift = Math.min(1.5, 0.5 * Math.log2((1 + beta) / (1 - beta)));
      s.brightness = clamp01(s.brightness + 0.3 * beta);
      s.noise = b.noise * (1 + 2.5 * beta);
      s.noiseHz = b.noiseHz * (1 + 2 * beta);
      break;
    }
    case 'collision': {
      const sep = num(params.separation, 60);
      s.rumble = clamp01(0.15 + 0.85 * Math.exp(-sep / 25) + 0.3 * (I - 0.3));
      break;
    }
    case 'earth': {
      if (params.view === 'voyager') {
        s.pad = 0.7;
        s.brightness = 0.28;
        s.bells *= 0.5;
      }
      break;
    }
  }
  const p = num(params.pulsar, 0);
  if (p > 0) s.pulse = Math.min(40, p);
  s.key = `${noteName(s.tonic).replace(/-?\d+$/, '')} ${MODE_LABEL[s.mode]}`;
  return s;
}

/** Identity of the harmony: when this changes, the pad crossfades to a new deck. */
export function harmonyKey(s: MoodSpec): string {
  return `${s.id}|${s.tonic}|${s.mode}`;
}
