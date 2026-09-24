import { describe, expect, it } from 'vitest';
import {
  MODES,
  degreeToSemitone,
  euclid,
  foldToOctave,
  hzToMidi,
  midiToHz,
  mulberry32,
  noteName,
  padVoicing,
  pitchClassOf,
  quartalChord,
  rootlessVoicings,
  swingOffset,
  tertianChord,
  voiceLead,
  walkingBar,
} from '../src/audio/theory';
import { fdnDelays, fdnGain, householder, isPrime } from '../src/audio/fdn';
import {
  MOOD_IDS,
  NEBULA_LINES_NM,
  WIEN_FREQ,
  T_CMB,
  canonicalMood,
  harmonyKey,
  iscoOrbitalFrequency,
  iscoRadiusBPT,
  physicalTonic,
  resolveMood,
} from '../src/audio/moods';
import { fuzzyScore, rankCommands } from '../src/ui/fuzzy';

describe('tuning', () => {
  it('A4 = 440 Hz, octaves double', () => {
    expect(midiToHz(69)).toBeCloseTo(440, 10);
    expect(midiToHz(81)).toBeCloseTo(880, 10);
    expect(hzToMidi(261.6256)).toBeCloseTo(60, 3);
    expect(noteName(60)).toBe('C4');
    expect(noteName(38)).toBe('D2');
  });
  it('octave folding preserves pitch class and lands in [lo, 2lo)', () => {
    for (const f of [1e-4, 0.00309, 7.83, 440, 1.6e11, 3.4e14]) {
      const { hz, octaves } = foldToOctave(f, 65.406);
      expect(hz).toBeGreaterThanOrEqual(65.406);
      expect(hz).toBeLessThan(2 * 65.406);
      expect(hz / Math.pow(2, octaves)).toBeCloseTo(f, 6 - Math.max(0, Math.log10(f)));
      expect(pitchClassOf(hz)).toBe(pitchClassOf(f));
    }
  });
});

describe('modes and chords', () => {
  it('modes are rotations of the major scale', () => {
    const maj = MODES.ionian;
    const rot = (k: number) => maj.map((_, i) => (maj[(i + k) % 7] - maj[k] + 12) % 12);
    expect(MODES.dorian).toEqual(rot(1));
    expect(MODES.phrygian).toEqual(rot(2));
    expect(MODES.lydian).toEqual(rot(3));
    expect(MODES.mixolydian).toEqual(rot(4));
    expect(MODES.aeolian).toEqual(rot(5));
  });
  it('degree arithmetic wraps octaves', () => {
    expect(degreeToSemitone('ionian', 7)).toBe(12);
    expect(degreeToSemitone('ionian', -1)).toBe(-1);
    expect(degreeToSemitone('lydian', 3)).toBe(6); // the raised fourth
  });
  it('Dorian i9 is a minor ninth, IV is a dominant 13 colour', () => {
    expect(tertianChord('dorian', 0, 5)).toEqual([0, 3, 7, 10, 14]);
    expect(tertianChord('dorian', 3, 4)).toEqual([5, 9, 12, 15]); // IV7 (dominant)
    expect(quartalChord('dorian', 0, 3)).toEqual([0, 5, 10]);
  });
  it('rootless voicings stay in range and omit the root', () => {
    const vs = rootlessVoicings(38, 'dorian', 0, 50, 74);
    expect(vs.length).toBeGreaterThan(0);
    for (const v of vs) {
      expect(v.length).toBe(4);
      for (const m of v) {
        expect(m).toBeGreaterThanOrEqual(50);
        expect(m).toBeLessThanOrEqual(74);
        expect(((m - 38) % 12 + 12) % 12).not.toBe(0);
      }
    }
  });
  it('voice leading prefers the nearest voicing', () => {
    const prev = [53, 57, 60, 64];
    const pick = voiceLead(prev, [
      [65, 69, 72, 76],
      [52, 57, 60, 64],
    ]);
    expect(pick).toEqual([52, 57, 60, 64]);
  });
  it('pad voicings are open (no seconds in the bass) and avoid ♭9', () => {
    for (const mode of Object.keys(MODES) as Array<keyof typeof MODES>) {
      for (let d = 0; d < 7; d++) {
        const v = padVoicing(40, mode, d);
        expect(v.length).toBe(5);
        expect(v[1] - v[0]).toBeGreaterThanOrEqual(6);
        const ninthAboveRoot = (v[3] - v[0]) % 12;
        expect(ninthAboveRoot).not.toBe(1);
        expect(Math.max(...v)).toBeLessThanOrEqual(84);
      }
    }
  });
});

describe('walking bass', () => {
  it('starts on the root, stays in range, approaches the next root by step', () => {
    const rnd = mulberry32(7);
    let prev = 38;
    for (let bar = 0; bar < 200; bar++) {
      const deg = bar % 4 === 0 ? 0 : 3;
      const next = bar % 4 === 0 ? 3 : 0;
      const line = walkingBar(38, 'dorian', deg, next, prev, rnd, 31, 50);
      expect(line.length).toBe(4);
      for (const m of line) {
        expect(m).toBeGreaterThanOrEqual(31);
        expect(m).toBeLessThanOrEqual(50);
      }
      const rootPc = (38 + degreeToSemitone('dorian', deg)) % 12;
      expect(((line[0] % 12) + 12) % 12).toBe(rootPc);
      const nextPc = (38 + degreeToSemitone('dorian', next)) % 12;
      const d = Math.min(...[-24, -12, 0, 12, 24].map((o) => Math.abs(line[3] - (nextPc + o + 36))));
      expect(d).toBeLessThanOrEqual(2);
      prev = line[3];
    }
  });
});

describe('rhythm', () => {
  it('euclidean rhythms distribute onsets evenly', () => {
    expect(euclid(3, 8).filter(Boolean).length).toBe(3);
    expect(euclid(5, 16).filter(Boolean).length).toBe(5);
    expect(euclid(0, 8).some(Boolean)).toBe(false);
    expect(euclid(8, 8).every(Boolean)).toBe(true);
  });
  it('swing puts the offbeat late', () => {
    expect(swingOffset(0, 0.5)).toBe(0);
    expect(swingOffset(1, 0.5, 2 / 3)).toBeCloseTo(1 / 3, 10);
    expect(swingOffset(3, 0.5, 2 / 3)).toBeCloseTo(0.5 + 1 / 3, 10);
  });
});

describe('feedback delay network', () => {
  it('delay lengths are distinct primes (in samples), increasing', () => {
    const d = fdnDelays(8, 1.25, 48000);
    const s = d.map((x) => Math.round(x * 48000));
    expect(new Set(s).size).toBe(8);
    for (const n of s) expect(isPrime(n)).toBe(true);
    for (let i = 1; i < s.length; i++) expect(s[i]).toBeGreaterThan(s[i - 1]);
  });
  it('loop gains decay 60 dB in RT60 for any line length', () => {
    for (const d of [0.031, 0.05, 0.097]) {
      const rt = 7;
      const loops = rt / d;
      expect(Math.pow(fdnGain(d, rt), loops)).toBeCloseTo(1e-3, 8);
      expect(fdnGain(d, rt)).toBeLessThan(1);
    }
  });
  it('Householder mixing is orthogonal (energy preserving)', () => {
    const n = 8;
    const A = householder(n);
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        let dot = 0;
        for (let k = 0; k < n; k++) dot += A[i][k] * A[j][k];
        expect(dot).toBeCloseTo(i === j ? 1 : 0, 12);
      }
  });
});

describe('physical keys', () => {
  it('Schwarzschild ISCO is 6 GM/c²; extremal prograde → 1', () => {
    expect(iscoRadiusBPT(0)).toBeCloseTo(6, 10);
    expect(iscoRadiusBPT(0.998)).toBeCloseTo(1.237, 2);
  });
  it('f_ISCO ≈ 2.2 kHz for one solar mass, ∝ 1/M', () => {
    expect(iscoOrbitalFrequency(1)).toBeGreaterThan(2150);
    expect(iscoOrbitalFrequency(1)).toBeLessThan(2250);
    expect(iscoOrbitalFrequency(4.3e6) * 4.3e6).toBeCloseTo(iscoOrbitalFrequency(1), 6);
    // Sgr A*: ~0.5 mHz (orbital period ≈ 30 min)
    expect(1 / iscoOrbitalFrequency(4.3e6) / 60).toBeGreaterThan(25);
    expect(1 / iscoOrbitalFrequency(4.3e6) / 60).toBeLessThan(40);
    expect(iscoOrbitalFrequency(1, 0.9)).toBeGreaterThan(iscoOrbitalFrequency(1, 0));
  });
  it('physical tonics fall in octave 2', () => {
    for (const f of [iscoOrbitalFrequency(4.3e6), iscoOrbitalFrequency(6.5e9), WIEN_FREQ * T_CMB, WIEN_FREQ * 5772]) {
      const t = physicalTonic(f);
      expect(t.tonic).toBeGreaterThanOrEqual(36);
      expect(t.tonic).toBeLessThanOrEqual(47);
    }
    // CMB peak ~160 GHz
    expect(WIEN_FREQ * T_CMB).toBeGreaterThan(1.59e11);
    expect(WIEN_FREQ * T_CMB).toBeLessThan(1.61e11);
  });
  it('nebula bells are in the ratios of emission-line frequencies', () => {
    const s = resolveMood('nebulae');
    expect(s.bellKind).toBe('spectral');
    expect(s.partials[0]).toBeCloseTo(1, 10);
    expect(s.partials[2]).toBeCloseTo(656.3 / 500.7, 10); // [O III] is bluer → higher
    expect(s.partials.length).toBe(NEBULA_LINES_NM.length);
  });
});

describe('moods', () => {
  it('every mood resolves; aliases map; unknown falls back', () => {
    for (const id of MOOD_IDS) {
      const s = resolveMood(id, { intensity: 0.5 });
      expect(s.id).toBe(id);
      expect(s.key).toMatch(/^[A-G][♯♭]? /);
      for (const v of [s.pad, s.brightness, s.drone, s.noise, s.space]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
    expect(canonicalMood('blackhole')).toBe('gargantua');
    expect(canonicalMood('galaxy')).toBe('milkyway');
    expect(canonicalMood('nope')).toBe('prelude');
  });
  it('black hole: heavier → different key; proximity → deeper, tenser drone', () => {
    const near = resolveMood('blackhole', { intensity: 1, mass: 4.3e6 });
    const far = resolveMood('blackhole', { intensity: 0.35, mass: 4.3e6 });
    expect(near.drone).toBeGreaterThan(far.drone);
    expect(near.beat).toBeGreaterThan(far.beat);
    expect(near.origin).toMatch(/ISCO/);
    expect(harmonyKey(near)).toBe(harmonyKey(far)); // proximity alone never re-keys
  });
  it('per-frame setMood with small changes keeps the same harmony', () => {
    const a = resolveMood('cosmos', { intensity: 0.4, z: 3 });
    const b = resolveMood('cosmos', { intensity: 0.41, z: 2.9 });
    expect(harmonyKey(a)).toBe(harmonyKey(b));
    expect(resolveMood('cosmos', { z: 1000 }).brightness).toBeGreaterThan(resolveMood('cosmos', { z: 0 }).brightness);
  });
  it('voyage bells are Doppler-shifted by √((1+β)/(1−β))', () => {
    const s = resolveMood('voyage', { speed: 0.6 });
    expect(Math.pow(2, s.bellShift)).toBeCloseTo(Math.sqrt(1.6 / 0.4), 10);
  });
  it('earth carries the Schumann resonance', () => {
    expect(resolveMood('earth').tremoloHz).toBeCloseTo(7.83, 2);
  });
  it('worlds: hot stars are Lydian, cool stars Dorian', () => {
    expect(resolveMood('worlds', { teff: 9000 }).mode).toBe('lydian');
    expect(resolveMood('worlds', { teff: 3200 }).mode).toBe('dorian');
  });
});

describe('command palette ranking', () => {
  it('prefix and word-start matches beat scattered ones', () => {
    expect(fuzzyScore('gar', 'Gargantua')).toBeGreaterThan(fuzzyScore('gar', 'Solar System · Mars orbit'));
    expect(fuzzyScore('mw', 'The Milky Way')).toBeGreaterThan(0);
    expect(fuzzyScore('xyz', 'Gargantua')).toBe(0);
    expect(fuzzyScore('', 'anything')).toBeGreaterThan(0);
  });
  it('keywords count; empty query keeps order', () => {
    const items = [
      { label: 'Gargantua', keywords: 'black hole kerr' },
      { label: 'Cosmic Web', keywords: 'structure formation' },
      { label: 'Solar System', keywords: 'planets sun' },
    ];
    expect(rankCommands('black', items)[0].label).toBe('Gargantua');
    expect(rankCommands('sun', items)[0].label).toBe('Solar System');
    expect(rankCommands('', items).map((x) => x.label)).toEqual(items.map((x) => x.label));
    // long descriptions must not match on scattered letters
    const more = [...items, { label: 'Nebulae', keywords: 'Interstellar medium Stellar nurseries and death shrouds glowing' }, { label: 'Edge-on', keywords: 'View' }];
    expect(rankCommands('edge', more).map((x) => x.label)).toEqual(['Edge-on']);
  });
});

describe('help from hint lines', () => {
  it('parses "X to Y" and "Key action" forms', async () => {
    const { hintToShortcuts } = await import('../src/ui/hint');
    const s = hintToShortcuts('Drag to orbit · Scroll to zoom · Tap to trace a ray · 1–5 views · G plunge · WASD fly · Space pause');
    expect(s[0]).toEqual({ keys: ['Drag'], label: 'Orbit' });
    expect(s[3]).toEqual({ keys: ['1–5'], label: 'Views' });
    expect(s[4]).toEqual({ keys: ['G'], label: 'Plunge' });
    expect(s[5]).toEqual({ keys: ['W', 'A', 'S', 'D'], label: 'Fly' });
    expect(s[6]).toEqual({ keys: ['Space'], label: 'Pause' });
    expect(hintToShortcuts('')).toEqual([]);
  });
});
