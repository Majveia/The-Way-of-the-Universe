/**
 * Pure music theory for the generative score. No Web Audio here: everything is a function of
 * numbers so it can be unit-tested (tests/audio-ui.test.ts) and reasoned about.
 *
 * Tuning: 12-tone equal temperament, A4 = 440 Hz (MIDI 69):  f = 440 · 2^((m − 69)/12).
 * Bells use the natural harmonic series instead (f_n = n · f_0), which is what makes them
 * sound "glassy" against the tempered pads — the 7th and 11th partials sit between the keys.
 */

export type ModeName = 'ionian' | 'dorian' | 'phrygian' | 'lydian' | 'mixolydian' | 'aeolian';

/** Semitone offsets of each diatonic mode from its tonic. */
export const MODES: Readonly<Record<ModeName, readonly number[]>> = {
  ionian: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
};

export const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'] as const;

export function midiToHz(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}
export function hzToMidi(f: number): number {
  return 69 + 12 * Math.log2(f / 440);
}
export function noteName(m: number): string {
  const r = Math.round(m);
  return `${NOTE_NAMES[((r % 12) + 12) % 12]}${Math.floor(r / 12) - 1}`;
}

/**
 * Transpose a (possibly inaudible) physical frequency by whole octaves into [lo, 2·lo).
 * Octave transposition preserves pitch class — the same trick NASA used to sonify the
 * Perseus cluster's pressure waves (shifted up 57–58 octaves). Returns the folded frequency
 * and the number of octaves applied (positive = up).
 */
export function foldToOctave(f: number, lo: number): { hz: number; octaves: number } {
  if (!(f > 0) || !(lo > 0)) return { hz: lo, octaves: 0 };
  const octaves = Math.floor(Math.log2(lo / f)) + 1;
  let hz = f * Math.pow(2, octaves);
  // guard float edge cases so the result is strictly in [lo, 2lo)
  let k = octaves;
  if (hz >= 2 * lo) {
    hz /= 2;
    k--;
  } else if (hz < lo) {
    hz *= 2;
    k++;
  }
  return { hz, octaves: k };
}

/** Pitch class (0 = C … 11 = B) of a frequency after octave folding. */
export function pitchClassOf(f: number): number {
  if (!(f > 0)) return 0;
  return ((Math.round(hzToMidi(f)) % 12) + 12) % 12;
}

/** Scale degree (0-based, may exceed 6 or be negative) → semitones above the tonic. */
export function degreeToSemitone(mode: ModeName, degree: number): number {
  const s = MODES[mode];
  const oct = Math.floor(degree / 7);
  const i = degree - oct * 7;
  return s[i] + 12 * oct;
}

/**
 * Tertian chord on a scale degree: `size` notes stacked in diatonic thirds
 * (size 4 = seventh chord, 5 = ninth, 6 = eleventh, 7 = thirteenth). Semitones from tonic.
 */
export function tertianChord(mode: ModeName, degree: number, size = 5): number[] {
  const out: number[] = [];
  for (let k = 0; k < size; k++) out.push(degreeToSemitone(mode, degree + 2 * k));
  return out;
}

/** Quartal stack on a degree (diatonic fourths): the open, modal "So What" sound. */
export function quartalChord(mode: ModeName, degree: number, size = 4): number[] {
  const out: number[] = [];
  for (let k = 0; k < size; k++) out.push(degreeToSemitone(mode, degree + 3 * k));
  return out;
}

/**
 * Rootless jazz voicing of the chord on `degree` (Bill Evans "A/B" forms): 3-5-7-9 or 7-9-3-5.
 * The bass carries the root, so the piano leaves it out. Returns absolute MIDI notes,
 * all within [lo, hi].
 */
export function rootlessVoicings(tonic: number, mode: ModeName, degree: number, lo = 50, hi = 74): number[][] {
  const c = tertianChord(mode, degree, 5); // 1 3 5 7 9
  const [, third, fifth, seventh, ninth] = c;
  const forms = [
    [third, fifth, seventh, ninth],
    [seventh - 12, ninth - 12, third, fifth],
  ];
  const out: number[][] = [];
  for (const f of forms) {
    for (let oct = -3; oct <= 4; oct++) {
      const v = f.map((s) => tonic + s + 12 * oct);
      if (v[0] >= lo && v[v.length - 1] <= hi) out.push(v);
    }
  }
  return out;
}

/**
 * Pick the candidate voicing with the smallest total voice movement from `prev`
 * (smooth voice leading). Ties → the one nearest `centre`.
 */
export function voiceLead(prev: readonly number[] | null, candidates: number[][], centre = 62): number[] {
  if (!candidates.length) return prev ? prev.slice() : [];
  let best = candidates[0];
  let bestCost = Infinity;
  for (const c of candidates) {
    const mean = c.reduce((a, b) => a + b, 0) / c.length;
    let cost = Math.abs(mean - centre) * 0.05;
    if (prev && prev.length === c.length) {
      const p = [...prev].sort((a, b) => a - b);
      const q = [...c].sort((a, b) => a - b);
      for (let i = 0; i < q.length; i++) cost += Math.abs(q[i] - p[i]);
    }
    if (cost < bestCost) {
      bestCost = cost;
      best = c;
    }
  }
  return best.slice();
}

/** Deterministic small PRNG for the score (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Put `m` in the octave nearest `ref`. */
export function nearestOctave(m: number, ref: number): number {
  return m + 12 * Math.round((ref - m) / 12);
}

/**
 * One bar of walking bass in 4/4 (four quarter notes), the grammar of the upright bass:
 *   beat 1 — the chord root (octave nearest the previous note, within range),
 *   beats 2–3 — chord tones or scale steps moving toward the target,
 *   beat 4 — an approach tone a semitone (chromatic) or scale step away from the next root.
 * `root`, `nextRoot` are MIDI; returns 4 MIDI notes within [lo, hi].
 */
export function walkingBar(
  tonic: number,
  mode: ModeName,
  degree: number,
  nextDegree: number,
  prevNote: number,
  rnd: () => number,
  lo = 31,
  hi = 50,
): number[] {
  const clampOct = (m: number) => {
    let x = m;
    while (x < lo) x += 12;
    while (x > hi) x -= 12;
    return x;
  };
  const root = clampOct(nearestOctave(tonic + degreeToSemitone(mode, degree), prevNote));
  const chord = tertianChord(mode, degree, 4).map((s) => s - degreeToSemitone(mode, degree)); // 0,3rd,5th,7th rel.
  let target = clampOct(nearestOctave(tonic + degreeToSemitone(mode, nextDegree), root));
  if (target === root) target = clampOct(root + (rnd() < 0.5 ? 12 : -12));
  const up = target > root;
  // beats 2 and 3: chord tones in the direction of travel
  const tones = chord.slice(1).map((s) => root + (up ? s : s - 12)).map(clampOct);
  let b2 = tones[Math.floor(rnd() * tones.length)];
  let b3 = tones[Math.floor(rnd() * tones.length)];
  if (b3 === b2) b3 = clampOct(b2 + (up ? 2 : -2));
  if (up ? b2 > b3 : b2 < b3) [b2, b3] = [b3, b2];
  // beat 4: chromatic (70%) or diatonic approach from the side we are coming from
  const side = b3 < target ? -1 : 1;
  const b4 = rnd() < 0.7 ? target + side : target + side * 2;
  return [root, b2, b3, Math.min(hi, Math.max(lo, b4))];
}

/**
 * Euclidean rhythm E(k, n): k onsets spread as evenly as possible over n steps
 * (Bjorklund / Toussaint). Used for sparse percussion and bell patterns.
 */
export function euclid(k: number, n: number, rotate = 0): boolean[] {
  const out: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + rotate) % n;
    out.push(k > 0 && Math.floor(((j + 1) * k) / n) !== Math.floor((j * k) / n));
  }
  return out;
}

/** Swung position of an eighth note: onbeat at 0, offbeat at `ratio` of the beat (2/3 = triplet swing). */
export function swingOffset(eighth: number, beat: number, ratio = 0.62): number {
  const b = Math.floor(eighth / 2);
  return (b + (eighth % 2 ? ratio : 0)) * beat;
}

/**
 * Open pad voicing on a scale degree, five voices: root (octave 3), fifth, seventh, ninth and
 * the third two octaves up ("spread" voicing — no seconds in the low register, so it stays
 * clear under heavy reverb). A ♭9 is an avoid note over a root, so Phrygian-type chords use
 * the eleventh instead. `quartal` stacks diatonic fourths on the root (the modal jazz colour
 * that sits under any chord of the mode).
 */
export function padVoicing(tonic: number, mode: ModeName, degree: number, quartal = false): number[] {
  let root = tonic + degreeToSemitone(mode, degree);
  while (root < 43) root += 12;
  while (root > 54) root -= 12;
  const iv = (k: number) => degreeToSemitone(mode, degree + k) - degreeToSemitone(mode, degree);
  if (quartal) return [root, root + iv(3), root + iv(6), root + iv(9), root + iv(12)];
  const ninth = iv(1) === 1 ? iv(3) + 12 : iv(8);
  return [root, root + iv(4), root + iv(6), root + ninth, root + iv(2) + 24];
}
