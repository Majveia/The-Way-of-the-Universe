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

// ——— Review additions: FDN dynamics, audio bus lifecycle, interface contract ———

describe('FDN as wired (self-feedback + shared −2/N sum)', () => {
  /** Sample-level model of FDNReverb's node graph with pure gains (no damping filters). */
  function simulate(sumGain: number, rt60: number, sr = 8000, seconds = 1.6): Float64Array {
    const n = 8;
    const D = fdnDelays(n, 1.25, sr).map((d) => Math.round(d * sr));
    const g = D.map((d) => fdnGain(d / sr, rt60));
    const N = Math.round(seconds * sr);
    const lineIn = D.map(() => new Float64Array(N));
    const energy = new Float64Array(N);
    const v = new Float64Array(n);
    for (let t = 0; t < N; t++) {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        v[i] = t >= D[i] ? g[i] * lineIn[i][t - D[i]] : 0;
        sum += v[i];
      }
      let e = 0;
      for (let i = 0; i < n; i++) {
        lineIn[i][t] = (t === 0 ? 1 : 0) + v[i] + sumGain * sum; // x + A·v with A = I + sumGain·11ᵀ
        e += v[i] * v[i];
      }
      energy[t] = e;
    }
    return energy;
  }
  const windowDb = (e: Float64Array, t0: number, t1: number, sr = 8000) => {
    let s = 0;
    for (let i = Math.round(t0 * sr); i < Math.round(t1 * sr); i++) s += e[i];
    return 10 * Math.log10(s / ((t1 - t0) * sr));
  };
  it('decays 60 dB per RT60 (energy envelope), independent of line length', () => {
    const rt = 1.2;
    const e = simulate(-2 / 8, rt);
    const a = windowDb(e, 0.2, 0.4);
    const b = windowDb(e, 0.2 + rt / 2, 0.4 + rt / 2);
    expect(a - b).toBeGreaterThan(27);
    expect(a - b).toBeLessThan(33);
  });
  it('the −2/N sign is what keeps it stable (+2/N would blow up)', () => {
    const e = simulate(+2 / 8, 1.2, 8000, 0.8);
    expect(windowDb(e, 0.6, 0.8)).toBeGreaterThan(windowDb(e, 0.1, 0.3));
  });
});

describe('physics constants behind the keys', () => {
  it('Wien frequency constant = x·k/h with x = 2.821439372 (CODATA 2018 exact k, h)', async () => {
    const k = 1.380649e-23;
    const h = 6.62607015e-34;
    expect(WIEN_FREQ / ((2.821439372122 * k) / h)).toBeCloseTo(1, 7);
  });
  it('ISCO: BPT closed form matches the defining condition (E″ = 0 ⇔ r² − 6r + 8a√r − 3a² = 0)', () => {
    for (const a of [0, 0.3, 0.7, 0.9, 0.998]) {
      const r = iscoRadiusBPT(a);
      expect(r * r - 6 * r + 8 * a * Math.sqrt(r) - 3 * a * a).toBeCloseTo(0, 8);
    }
    // retrograde branch (a < 0 in this convention): 9 M at the extremal limit
    expect(iscoRadiusBPT(-0.9999)).toBeGreaterThan(8.9);
  });
  it('Kerr ISCO frequency Ω = c³ / (GM (r^{3/2} + a)): spin 0.998 is ≈ 6.2 × faster than Schwarzschild', () => {
    const r = iscoRadiusBPT(0.998);
    const ratio = iscoOrbitalFrequency(1, 0.998) / iscoOrbitalFrequency(1, 0);
    expect(ratio).toBeCloseTo(Math.pow(6, 1.5) / (Math.pow(r, 1.5) + 0.998), 10);
    expect(ratio).toBeGreaterThan(6);
    expect(ratio).toBeLessThan(6.5);
  });
  it('named keys: Sgr A* → C, CMB peak → D, solar ν_max 3.09 mHz → A♭ (101.25 Hz after 15 octaves)', () => {
    const pc = (m: number) => ((m % 12) + 12) % 12;
    expect(pc(resolveMood('gargantua', { mass: 4.3e6 }).tonic)).toBe(0);
    expect(pc(resolveMood('cosmos').tonic)).toBe(2);
    expect(pc(resolveMood('solar').tonic)).toBe(8);
    expect(resolveMood('solar').key).toMatch(/^A♭ /);
    expect(resolveMood('cosmos').origin).toMatch(/lowered 31 octaves/);
  });
  it('Doppler shift is monotonic, zero at rest and capped (no runaway pitch near c)', () => {
    expect(resolveMood('voyage', { speed: 0 }).bellShift).toBe(0);
    expect(resolveMood('voyage', { speed: 0.3 }).bellShift).toBeLessThan(resolveMood('voyage', { speed: 0.6 }).bellShift);
    expect(resolveMood('voyage', { speed: 0.9999 }).bellShift).toBeLessThanOrEqual(1.5);
    expect(Number.isFinite(resolveMood('voyage', { speed: 1 }).bellShift)).toBe(true);
  });
  it('bad params never produce NaN keys', () => {
    for (const p of [{ mass: NaN }, { mass: -5 }, { teff: Infinity }, { speed: NaN }, { z: -1 }, { separation: NaN }]) {
      for (const id of MOOD_IDS) {
        const s = resolveMood(id, p as never);
        expect(Number.isFinite(s.tonic)).toBe(true);
        expect(Number.isFinite(s.brightness)).toBe(true);
        expect(Number.isFinite(s.bellShift)).toBe(true);
      }
    }
  });
});

describe('AudioBus lifecycle', () => {
  /** Minimal Web Audio stand-in: enough for AudioBus (the engine is injected). */
  function installFakeAudio() {
    const param = () => ({ value: 0, cancelScheduledValues() {}, setTargetAtTime() {} });
    const node = () => {
      const n: Record<string, unknown> = { gain: param(), threshold: param(), ratio: param(), disconnect() {} };
      n.connect = (d: unknown) => d;
      return n;
    };
    let contexts = 0;
    class FakeAC {
      currentTime = 0;
      state = 'running';
      destination = node();
      constructor() {
        contexts++;
      }
      createGain = node;
      createDynamicsCompressor = node;
      resume = async () => undefined;
      suspend = async () => undefined;
    }
    const w = globalThis as unknown as Record<string, unknown>;
    const prev = w.window;
    w.window = { AudioContext: FakeAC, setTimeout: () => 0, localStorage: undefined };
    return { contexts: () => contexts, restore: () => void (w.window = prev) };
  }

  it('on → off → on while the engine is still loading builds exactly one engine', async () => {
    const fake = installFakeAudio();
    try {
      const { AudioBus } = await import('../src/audio/AudioBus');
      const bus = new AudioBus();
      let built = 0;
      let started = 0;
      bus.setEngineFactory(async () => {
        built++;
        await new Promise((r) => setTimeout(r, 5));
        return { start: () => void started++, setMood() {}, event() {}, update() {}, stop() {} };
      });
      const a = bus.enable();
      bus.disable();
      const b = bus.enable();
      const c = bus.enable();
      await Promise.all([a, b, c]);
      expect(built).toBe(1);
      expect(started).toBe(1);
      expect(fake.contexts()).toBe(1);
      expect(bus.enabled).toBe(true);
    } finally {
      fake.restore();
    }
  });

  it('setMood before enable is remembered and handed to the engine', async () => {
    const fake = installFakeAudio();
    try {
      const { AudioBus } = await import('../src/audio/AudioBus');
      const bus = new AudioBus();
      const got: string[] = [];
      bus.setEngineFactory(async () => ({ start() {}, setMood: (n: string) => void got.push(n), event() {}, update() {}, stop() {} }));
      bus.setMood('blackhole', { mass: 1e8 });
      await bus.enable();
      expect(got).toEqual(['blackhole']);
      expect(bus.describe().key).toMatch(/^[A-G]/);
    } finally {
      fake.restore();
    }
  });
});

describe('interface contract', () => {
  // Node's fs without Node typings (tsconfig types = vite/client only).
  type FS = { readFileSync(u: URL, enc: 'utf8'): string; existsSync(u: URL): boolean };
  const fs = async () => (await import(/* @vite-ignore */ 'node:fs' as string)) as FS;
  const read = async (p: string) => (await fs()).readFileSync(new URL(p, import.meta.url), 'utf8');

  /** WCAG 2.x relative luminance of an sRGB colour (0–255 channels). */
  const lum = (r: number, g: number, b: number) => {
    const f = (c: number) => {
      const x = c / 255;
      return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const onBlack = (css: string) => {
    const m = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/.exec(css);
    let rgb: number[];
    if (m) {
      const a = m[4] === undefined ? 1 : Number(m[4]);
      rgb = [Number(m[1]) * a, Number(m[2]) * a, Number(m[3]) * a]; // composited over #000
    } else {
      const h = /#([0-9a-f]{6})/i.exec(css)![1];
      rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    }
    return (lum(rgb[0], rgb[1], rgb[2]) + 0.05) / 0.05;
  };

  it('text tokens meet WCAG contrast on the OLED ground (#000)', async () => {
    const css = await read('../src/ui/style.css');
    const token = (name: string) => new RegExp(`--${name}:\\s*([^;]+);`).exec(css)![1];
    expect(token('ground').trim()).toBe('#000000');
    for (const t of ['ink', 'ink-2', 'ink-3', 'accent', 'cool']) expect(onBlack(token(t))).toBeGreaterThanOrEqual(4.5);
    expect(onBlack(token('ink-4'))).toBeGreaterThanOrEqual(3);
  });

  it('nothing is fetched from the network at runtime (fonts are bundled)', async () => {
    const html = await read('../index.html');
    expect(html).not.toMatch(/<link[^>]+https?:\/\//i);
    for (const f of ['../src/ui/style.css', '../src/ui/overlays.css']) {
      const css = await read(f);
      expect(css).not.toMatch(/url\(\s*['"]?https?:/i);
      expect(css).not.toMatch(/@import\s+url\(\s*['"]?https?:/i);
    }
    const css = await read('../src/ui/style.css');
    const refs = [...css.matchAll(/url\('\.\/(fonts\/[^']+)'\)/g)].map((m) => `../src/ui/${m[1]}`);
    expect(refs.length).toBeGreaterThanOrEqual(3);
    const { existsSync } = await fs();
    for (const r of refs) expect(existsSync(new URL(r, import.meta.url))).toBe(true);
    expect(css).toMatch(/font-display:\s*swap/);
  });

  it('backdrop blur is never applied unconditionally (phones re-blur the live canvas every frame)', async () => {
    for (const f of ['../src/ui/style.css', '../src/ui/overlays.css']) {
      const css = (await read(f)).replace(/\/\*[\s\S]*?\*\//g, '');
      // every backdrop-filter must sit inside a (pointer: fine) media block
      const re = /backdrop-filter\s*:/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(css))) {
        const before = css.slice(0, m.index);
        const open = before.lastIndexOf('@media');
        expect(open).toBeGreaterThanOrEqual(0);
        expect(before.slice(open, open + 60)).toMatch(/pointer:\s*fine/);
      }
    }
  });

  it('only text entry swallows the global keys', async () => {
    const { isTypingTarget } = await import('../src/ui/UI');
    const input = (type: string) => ({ tagName: 'INPUT', type, isContentEditable: false }) as unknown as EventTarget;
    expect(isTypingTarget(input('text'))).toBe(true);
    expect(isTypingTarget(input('search'))).toBe(true);
    expect(isTypingTarget(input('range'))).toBe(false);
    expect(isTypingTarget(input('checkbox'))).toBe(false);
    expect(isTypingTarget({ tagName: 'TEXTAREA', isContentEditable: false } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: 'CANVAS', isContentEditable: false } as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('sound engine graph (fake Web Audio)', () => {
  interface FNode {
    kind: string;
    out: Set<FNode>;
    connect(d: FNode | FParam): FNode | FParam;
    disconnect(d?: FNode): void;
    [k: string]: unknown;
  }
  interface FParam {
    kind: 'param';
    owner: FNode;
    value: number;
  }
  function fakeContext() {
    const all: FNode[] = [];
    const param = (owner: FNode): FParam => {
      const p = { kind: 'param' as const, owner, value: 0 } as FParam & Record<string, unknown>;
      for (const m of ['setValueAtTime', 'setTargetAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime', 'cancelScheduledValues']) p[m] = () => p;
      return p;
    };
    const node = (kind: string, params: string[] = []): FNode => {
      const n = { kind, out: new Set<FNode>() } as FNode;
      n.connect = (d) => {
        n.out.add((d as FParam).kind === 'param' ? (d as FParam).owner : (d as FNode));
        return d;
      };
      n.disconnect = (d) => {
        if (d) n.out.delete(d);
        else n.out.clear();
      };
      for (const p of params) n[p] = param(n);
      n.start = () => undefined;
      n.stop = () => undefined;
      n.setPeriodicWave = () => undefined;
      all.push(n);
      return n;
    };
    const ctx = {
      sampleRate: 8000,
      currentTime: 0,
      state: 'running',
      destination: node('destination'),
      createGain: () => node('gain', ['gain']),
      createOscillator: () => node('osc', ['frequency', 'detune']),
      createBiquadFilter: () => node('biquad', ['frequency', 'Q', 'gain']),
      createStereoPanner: () => node('pan', ['pan']),
      createDelay: () => node('delay', ['delayTime']),
      createChannelMerger: () => node('merger'),
      createBufferSource: () => node('buffer'),
      createPeriodicWave: () => ({}),
      createBuffer: (_c: number, n: number) => ({ getChannelData: () => new Float32Array(n) }),
    };
    return { ctx, all };
  }
  /** Can `from` reach `to` without passing through `avoid`? */
  const reaches = (from: FNode, to: FNode, avoid?: FNode) => {
    const seen = new Set<FNode>();
    const stack = [from];
    while (stack.length) {
      const n = stack.pop()!;
      if (n === to) return true;
      if (seen.has(n) || n === avoid) continue;
      seen.add(n);
      stack.push(...n.out);
    }
    return false;
  };

  async function engineWith(opts: { music: boolean; ambience: boolean; ui: boolean }) {
    const w = globalThis as unknown as Record<string, unknown>;
    const prev = w.window;
    w.window = { setInterval: () => 0, clearInterval: () => undefined };
    class PW {}
    const prevPW = w.PeriodicWave;
    w.PeriodicWave = PW;
    const { createSoundEngine } = await import('../src/audio/engine');
    const { ctx } = fakeContext();
    ctx.createPeriodicWave = () => new PW();
    const eng = createSoundEngine() as unknown as Record<string, unknown> & import('../src/audio/AudioBus').SoundEngine;
    const out = ctx.createGain();
    out.connect(ctx.destination);
    eng.start(ctx as unknown as AudioContext, out as unknown as AudioNode);
    eng.configure!(opts);
    eng.setMood('prelude', { intensity: 0.4 });
    return {
      eng,
      ctx,
      restore: () => {
        w.window = prev;
        w.PeriodicWave = prevPW;
      },
    };
  }

  it('event chimes and UI ticks still sound with Ambience off; the ambient bus is parked', async () => {
    const { eng, ctx, restore } = await engineWith({ music: false, ambience: false, ui: true });
    try {
      const ambient = eng.ambient as FNode;
      ctx.currentTime = 10; // past the 4 s park delay
      eng.update(0.1);
      const bells = eng.bells as Array<{ pan: FNode }>;
      eng.event('arrive');
      const woken = bells.filter((b) => b.pan.out.size > 0);
      expect(woken.length).toBeGreaterThan(0);
      for (const b of woken) expect(reaches(b.pan, ctx.destination as FNode, ambient)).toBe(true);
      // ambient layers are disconnected from the mix while off
      expect(reaches(ambient, ctx.destination as FNode)).toBe(false);
    } finally {
      restore();
    }
  });

  it('the jazz bus is parked while the music is off and reaches the output when on', async () => {
    const { eng, ctx, restore } = await engineWith({ music: false, ambience: true, ui: false });
    try {
      const jazz = eng.jazzBus as FNode;
      ctx.currentTime = 10;
      eng.update(0.1);
      expect(reaches(jazz, ctx.destination as FNode)).toBe(false);
      eng.configure!({ music: true });
      expect(reaches(jazz, ctx.destination as FNode)).toBe(true);
      expect(reaches(eng.ambient as FNode, ctx.destination as FNode)).toBe(true);
    } finally {
      restore();
    }
  });

  it('re-sending an identical mood is a no-op (no re-resolve)', async () => {
    const { eng, restore } = await engineWith({ music: false, ambience: true, ui: false });
    try {
      const spec = eng.spec;
      eng.setMood('prelude', { intensity: 0.4 });
      expect(eng.spec).toBe(spec);
      eng.setMood('prelude', { intensity: 0.5 });
      expect(eng.spec).not.toBe(spec);
    } finally {
      restore();
    }
  });
});
