import type { MoodParams, SoundEngine, SoundOptions } from './AudioBus';
import { FDNReverb } from './fdn';
import { harmonyKey, resolveMood, type MoodSpec } from './moods';
import {
  degreeToSemitone,
  midiToHz,
  mulberry32,
  padVoicing,
  rootlessVoicings,
  swingOffset,
  voiceLead,
  walkingBar,
} from './theory';

/**
 * The generative score. Everything is built once in start(): ~60 persistent oscillators,
 * two looping noise buffers and an 8-line FDN reverb. Notes are *envelopes* on pooled,
 * always-running voices, scheduled on the audio clock with look-ahead — no node is created
 * per frame or per note, so the graph never churns and the CPU cost is flat (≈1–3 % of a core).
 *
 *  AMBIENT (always):                     SPACE JAZZ (optional layer, "Music" in the sound menu):
 *   pad deck A ┐ crossfade (~4 s)          FM electric piano — rootless voicings, voice-led
 *   pad deck B ┘  on mood/chord change     walking upright bass — root / chord tones / approach
 *   sub drone (+2nd harmonic, beating)     brushes — swish on every beat, swung ride taps
 *   filtered pink-noise "wind"             vibraphone-like FM motifs, sparse
 *   FM bells (harmonic / glass / spectral)
 *  EVENTS: portal/whoosh/warp sweeps, arrival chimes, collision rumble, pulsar ticks, UI ticks.
 *  All layers → dry bus + FDN reverb send → engine out → AudioBus master (compressor).
 */

const LOOKAHEAD = 0.3; // s of audio scheduled ahead of the clock
const APPLY_EVERY = 0.1; // s between continuous-parameter updates

interface PadVoice {
  a: OscillatorNode;
  b: OscillatorNode;
  g: GainNode;
}
interface PadDeck {
  gain: GainNode;
  filter: BiquadFilterNode;
  voices: PadVoice[];
  quietAt: number; // audio time when this deck will be silent
  sleep: Sleeper;
}
interface FMVoice {
  car: OscillatorNode;
  mod: OscillatorNode;
  idx: GainNode;
  out: GainNode;
  pan: StereoPannerNode;
  free: number;
  sleep: Sleeper;
}
interface BassVoice {
  o1: OscillatorNode;
  o2: OscillatorNode;
  out: GainNode;
  free: number;
  sleep: Sleeper;
}

type Rnd = () => number;

/**
 * Web Audio renders by pulling from the destination, so a sub-graph that is not connected
 * costs nothing. A Sleeper keeps a node connected only while something is sounding through it
 * (wake(until)); tick() parks it again afterwards. Connection changes are cheap — no nodes are
 * created or destroyed.
 */
class Sleeper {
  private on = false;
  private until = 0;
  constructor(private node: AudioNode, private dest: AudioNode) {}
  wake(until: number): void {
    this.until = Math.max(this.until, until);
    if (!this.on) {
      this.node.connect(this.dest);
      this.on = true;
    }
  }
  /** Stay connected until `until`, then park (overrides a longer wake). */
  sleepAt(until: number): void {
    this.until = until;
  }
  tick(now: number): void {
    if (this.on && now > this.until + 0.6) {
      this.node.disconnect(this.dest);
      this.on = false;
    }
  }
  get awake(): boolean {
    return this.on;
  }
}

function noiseBuffer(ctx: AudioContext, seconds: number, color: 'white' | 'pink' | 'brown', rnd: Rnd): AudioBuffer {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  // Paul Kellet's economy pink filter; leaky-integrated brown.
  let b0 = 0, b1 = 0, b2 = 0, br = 0;
  for (let i = 0; i < n; i++) {
    const w = rnd() * 2 - 1;
    if (color === 'white') d[i] = w * 0.5;
    else if (color === 'pink') {
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.11;
    } else {
      br = (br + 0.02 * w) / 1.02;
      d[i] = br * 3.2;
    }
  }
  // crossfade the loop seam
  const f = Math.min(2048, n >> 3);
  for (let i = 0; i < f; i++) {
    const k = i / f;
    d[i] = d[i] * k + d[n - f + i] * (1 - k);
  }
  return buf;
}

/** Retrigger-safe envelope: quick fade of whatever is sounding, then attack and exponential decay. */
function strike(p: AudioParam, t: number, peak: number, attack: number, decay: number): void {
  p.cancelScheduledValues(t);
  p.setTargetAtTime(0, t, 0.004);
  p.setTargetAtTime(peak, t + 0.012, attack / 3);
  p.setTargetAtTime(0, t + 0.012 + attack, decay);
}

class GenerativeEngine implements SoundEngine {
  private ctx!: AudioContext;
  private out!: GainNode;
  private dry!: GainNode;
  private send!: GainNode;
  private reverb!: FDNReverb;
  private ambient!: GainNode;
  private jazzBus!: GainNode;
  private fxBus!: GainNode;
  private nodes: AudioNode[] = [];
  private sources: AudioScheduledSourceNode[] = [];
  private rnd: Rnd = mulberry32(0x5eed);

  private decks: PadDeck[] = [];
  private active = 0;
  private droneA!: OscillatorNode;
  private droneB!: OscillatorNode;
  private droneH!: OscillatorNode;
  private droneGain!: GainNode;
  private droneFilter!: BiquadFilterNode;
  private tremGain!: GainNode;
  private trem!: OscillatorNode;
  private windFilter!: BiquadFilterNode;
  private windGain!: GainNode;
  private rumbleGain!: GainNode;
  private rumbleFilter!: BiquadFilterNode;
  private rumbleEnv!: GainNode;
  private sweepFilter!: BiquadFilterNode;
  private sweepGain!: GainNode;
  private tickGain!: GainNode;
  private brushSwish!: GainNode;
  private brushTap!: GainNode;
  private sleepers: Sleeper[] = [];
  private jazzSleep!: Sleeper;
  private sweepSleep!: Sleeper;
  private tickSleep!: Sleeper;
  private rumbleSleep!: Sleeper;
  private envSleep!: Sleeper;
  private bells: FMVoice[] = [];
  private eps: FMVoice[] = [];
  private bass: BassVoice[] = [];

  private spec: MoodSpec = resolveMood('silence');
  private hkey = '';
  private opts: SoundOptions = { music: false, ambience: true, ui: false };
  private applyClock = 0;
  private applied: Record<string, number> = {};
  private padIndex = 0;
  private padDegree = 0;
  private nextPadChange = 0;
  private nextBell = 0;
  private nextPulse = 0;
  private lastEvent: Record<string, number> = {};
  // jazz state
  private nextBeat = 0;
  private beat = 0;
  private bar = 0;
  private chordStep = 0;
  private chordDeg = 0;
  private nextChordDeg = 0;
  private voicing: number[] | null = null;
  private bassLine: number[] = [];
  private prevBass = 38;
  private comp: number[] = [];
  private motif: Array<[number, number]> = [];
  private timer = 0;

  start(ctx: AudioContext, dest: AudioNode): void {
    this.ctx = ctx;
    const t = ctx.currentTime;
    const g = (v: number) => {
      const n = ctx.createGain();
      n.gain.value = v;
      this.nodes.push(n);
      return n;
    };
    const osc = (type: OscillatorType | PeriodicWave, f: number) => {
      const o = ctx.createOscillator();
      if (type instanceof PeriodicWave) o.setPeriodicWave(type);
      else o.type = type;
      o.frequency.value = f;
      o.start(t);
      this.sources.push(o);
      return o;
    };
    const filt = (type: BiquadFilterType, f: number, q = 0.7) => {
      const n = ctx.createBiquadFilter();
      n.type = type;
      n.frequency.value = f;
      n.Q.value = q;
      this.nodes.push(n);
      return n;
    };

    this.out = g(0);
    this.out.connect(dest);
    this.out.gain.setTargetAtTime(0.34, t, 1.5);
    this.dry = g(1);
    this.send = g(0.5);
    this.dry.connect(this.out);
    this.reverb = new FDNReverb(ctx, 8, 1.25);
    // High-pass the reverb send: low end in a long tail is mud, not space.
    const sendHp = filt('highpass', 190, 0.5);
    this.send.connect(sendHp).connect(this.reverb.input);
    this.reverb.output.connect(this.out);
    this.ambient = g(1);
    this.jazzBus = g(0);
    this.fxBus = g(0.9);
    for (const b of [this.ambient, this.fxBus]) {
      b.connect(this.dry);
      b.connect(this.send);
    }
    // The jazz layer reaches the mix through one gain, parked while the music is off.
    const jazzOut = g(1);
    jazzOut.connect(this.dry);
    jazzOut.connect(this.send);
    this.jazzSleep = new Sleeper(this.jazzBus, jazzOut);
    const sl = (n: AudioNode, d: AudioNode) => {
      const x = new Sleeper(n, d);
      this.sleepers.push(x);
      return x;
    };

    // Noise sources (one-time buffers, looping forever).
    const white = ctx.createBufferSource();
    white.buffer = noiseBuffer(ctx, 3.1, 'white', this.rnd);
    white.loop = true;
    white.start(t);
    const pink = ctx.createBufferSource();
    pink.buffer = noiseBuffer(ctx, 4.3, 'pink', this.rnd);
    pink.loop = true;
    pink.start(t);
    const brown = ctx.createBufferSource();
    brown.buffer = noiseBuffer(ctx, 3.7, 'brown', this.rnd);
    brown.loop = true;
    brown.start(t);
    this.sources.push(white, pink, brown);

    // ——— Pads: two decks, a soft "string" spectrum a_n ∝ n^−1.7 ———
    const H = 24;
    const re = new Float32Array(H + 1);
    const im = new Float32Array(H + 1);
    for (let n = 1; n <= H; n++) im[n] = Math.pow(n, -1.7) * (n % 2 ? 1 : 0.6);
    const wave = ctx.createPeriodicWave(re, im);
    const lfoRates = [0.031, 0.047, 0.067, 0.083, 0.039];
    const lfos = lfoRates.map((r) => {
      const o = osc('sine', r);
      const d = g(0.32);
      o.connect(d);
      return d;
    });
    const filtLfo = osc('sine', 0.019);
    const filtDepth = g(240);
    filtLfo.connect(filtDepth);
    const padPan = [-0.55, 0.35, -0.15, 0.6, -0.4];
    for (let k = 0; k < 2; k++) {
      const dg = g(0);
      const deck: PadDeck = { gain: dg, filter: filt('lowpass', 900, 0.4), voices: [], quietAt: 0, sleep: sl(dg, this.ambient) };
      filtDepth.connect(deck.filter.frequency);
      deck.filter.connect(deck.gain);
      for (let v = 0; v < 5; v++) {
        const a = osc(wave, 110);
        const b = osc(wave, 110);
        a.detune.value = -6 - v;
        b.detune.value = 5 + v;
        const vg = g(0.62);
        lfos[v].connect(vg.gain);
        const pan = ctx.createStereoPanner();
        pan.pan.value = padPan[v];
        this.nodes.push(pan);
        a.connect(vg);
        b.connect(vg);
        vg.connect(pan).connect(deck.filter);
        deck.voices.push({ a, b, g: vg });
      }
      this.decks.push(deck);
    }

    // ——— Sub drone: two slightly detuned sines (beating) + 2nd harmonic (missing-fundamental cue) ———
    this.droneFilter = filt('lowpass', 260, 0.3);
    this.droneGain = g(0);
    this.droneA = osc('sine', 55);
    this.droneB = osc('sine', 55.1);
    this.droneH = osc('triangle', 110);
    const hG = g(0.16);
    this.droneA.connect(this.droneFilter);
    this.droneB.connect(this.droneFilter);
    this.droneH.connect(hG).connect(this.droneFilter);
    this.tremGain = g(0);
    this.trem = osc('sine', 7.83);
    this.trem.connect(this.tremGain).connect(this.droneGain.gain);
    this.droneFilter.connect(this.droneGain).connect(this.ambient);

    // ——— Wind: pink noise through a slowly wandering band-pass, drifting across the stereo field ———
    this.windFilter = filt('bandpass', 700, 0.9);
    this.windGain = g(0);
    const windPan = ctx.createStereoPanner();
    this.nodes.push(windPan);
    const panLfo = osc('sine', 0.013);
    const panDepth = g(0.6);
    panLfo.connect(panDepth).connect(windPan.pan);
    const windLfo = osc('sine', 0.023);
    const windDepth = g(220);
    windLfo.connect(windDepth).connect(this.windFilter.frequency);
    pink.connect(this.windFilter).connect(this.windGain).connect(windPan).connect(this.ambient);

    // ——— Rumble (collisions, warp): brown noise + the drone, low-passed ———
    this.rumbleFilter = filt('lowpass', 140, 0.5);
    this.rumbleGain = g(0);
    this.rumbleEnv = g(0);
    brown.connect(this.rumbleFilter);
    this.rumbleFilter.connect(this.rumbleGain);
    this.rumbleFilter.connect(this.rumbleEnv);
    this.rumbleSleep = sl(this.rumbleGain, this.fxBus);
    this.envSleep = sl(this.rumbleEnv, this.fxBus);

    // ——— Sweeps (portal, whoosh, warp) and ticks (pulsar, UI) from white noise ———
    this.sweepFilter = filt('bandpass', 400, 2.2);
    this.sweepGain = g(0);
    white.connect(this.sweepFilter).connect(this.sweepGain);
    this.sweepSleep = sl(this.sweepGain, this.fxBus);
    const tickHp = filt('highpass', 2600, 0.7);
    this.tickGain = g(0);
    white.connect(tickHp).connect(this.tickGain);
    this.tickSleep = sl(this.tickGain, this.fxBus);

    // ——— FM voices: bells (ambient) and electric piano (jazz) ———
    const fm = (bus: GainNode, pan: number): FMVoice => {
      const car = osc('sine', 440);
      const mod = osc('sine', 440);
      const idx = g(0);
      const out = g(0);
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      this.nodes.push(p);
      mod.connect(idx).connect(car.frequency);
      car.connect(out).connect(p);
      return { car, mod, idx, out, pan: p, free: 0, sleep: sl(p, bus) };
    };
    for (let i = 0; i < 6; i++) this.bells.push(fm(this.ambient, (i / 5) * 1.2 - 0.6));
    for (let i = 0; i < 8; i++) this.eps.push(fm(this.jazzBus, ((i % 4) / 3) * 0.6 - 0.3));

    // ——— Upright bass: sine + soft triangle through a low-pass, plucked envelope ———
    const bassLp = filt('lowpass', 520, 0.2);
    bassLp.connect(this.jazzBus);
    for (let i = 0; i < 2; i++) {
      const o1 = osc('sine', 55);
      const o2 = osc('triangle', 55);
      const m2 = g(0.35);
      const out = g(0);
      o1.connect(out);
      o2.connect(m2).connect(out);
      this.bass.push({ o1, o2, out, free: 0, sleep: sl(out, bassLp) });
    }

    // ——— Brushes: band-passed swish + high-passed taps ———
    const swishBp = filt('bandpass', 3800, 0.6);
    this.brushSwish = g(0);
    white.connect(swishBp).connect(this.brushSwish).connect(this.jazzBus);
    const tapHp = filt('highpass', 6500, 0.5);
    this.brushTap = g(0);
    const tapPan = ctx.createStereoPanner();
    tapPan.pan.value = 0.35;
    this.nodes.push(tapPan);
    white.connect(tapHp).connect(this.brushTap).connect(tapPan).connect(this.jazzBus);

    this.nextBell = t + 3;
    this.nextPadChange = t + 16;
    this.timer = window.setInterval(() => this.schedule(), 90);
  }

  configure(o: Partial<SoundOptions>): void {
    const was = this.opts.music;
    this.opts = { ...this.opts, ...o };
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.jazzBus.gain.setTargetAtTime(this.opts.music ? 1 : 0, t, 0.9);
    if (this.opts.music) this.jazzSleep.wake(Infinity);
    else this.jazzSleep.sleepAt(t + 4);
    this.ambient.gain.setTargetAtTime(this.opts.ambience ? 1 : 0, t, 0.9);
    if (this.opts.music && !was) {
      this.nextBeat = t + 0.4;
      this.beat = 0;
      this.bar = 0;
      this.chordStep = 0;
      this.voicing = null;
    }
    if (was !== this.opts.music) this.retune(t, 3, true);
    this.applied = {};
  }

  describe(): { key: string; origin: string } {
    return { key: this.spec.key, origin: this.spec.origin };
  }

  setMood(name: string, params: MoodParams): void {
    this.spec = resolveMood(name, params);
    if (!this.ctx) return;
    const k = harmonyKey(this.spec);
    if (k !== this.hkey) {
      const first = this.hkey === '';
      this.hkey = k;
      this.padIndex = 0;
      this.padDegree = this.spec.progression[0];
      this.nextPadChange = this.ctx.currentTime + 14 + 8 * this.rnd();
      this.retune(this.ctx.currentTime, first ? 2 : 4, true);
      this.applied = {};
      this.applyContinuous(this.ctx.currentTime, 1.3);
    }
  }

  /** Move the pad (and drone) to the current degree; crossfade decks over `fade` seconds. */
  private retune(t: number, fade: number, swap: boolean): void {
    const s = this.spec;
    const notes = padVoicing(s.tonic, s.mode, this.opts.music ? 0 : this.padDegree, this.opts.music);
    const next = this.decks[1 - this.active];
    const level = s.pad * (this.opts.music ? 0.55 : 1) * 0.1;
    const tau = fade / 3;
    if (swap && next.quietAt <= t) {
      next.sleep.wake(Infinity);
      next.voices.forEach((v, i) => {
        const f = midiToHz(notes[i]);
        v.a.frequency.cancelScheduledValues(t);
        v.b.frequency.cancelScheduledValues(t);
        v.a.frequency.setValueAtTime(f, t);
        v.b.frequency.setValueAtTime(f, t);
      });
      const cur = this.decks[this.active];
      cur.gain.gain.cancelScheduledValues(t);
      cur.gain.gain.setTargetAtTime(0, t, tau);
      cur.quietAt = t + fade * 2.2;
      cur.sleep.sleepAt(cur.quietAt);
      next.gain.gain.cancelScheduledValues(t);
      next.gain.gain.setTargetAtTime(level, t, tau);
      this.active = 1 - this.active;
    } else {
      // the other deck is still ringing: glide the active one instead
      const cur = this.decks[this.active];
      cur.sleep.wake(Infinity);
      cur.voices.forEach((v, i) => {
        const f = midiToHz(notes[i]);
        v.a.frequency.setTargetAtTime(f, t, tau);
        v.b.frequency.setTargetAtTime(f, t, tau);
      });
      cur.gain.gain.setTargetAtTime(level, t, tau);
    }
    const droneHz = midiToHz(s.tonic + 12 * s.droneOct);
    this.droneA.frequency.setTargetAtTime(droneHz, t, tau);
    this.droneH.frequency.setTargetAtTime(droneHz * 2, t, tau);
  }

  /** Throttled, change-only updates of continuous parameters (safe to call setMood every frame). */
  private applyContinuous(t: number, tau: number): void {
    const s = this.spec;
    const set = (key: string, p: AudioParam, v: number, eps: number) => {
      const prev = this.applied[key];
      if (prev !== undefined && Math.abs(prev - v) < eps) return;
      this.applied[key] = v;
      p.setTargetAtTime(v, t, tau);
    };
    const cutoff = 220 * Math.pow(18, s.brightness);
    for (const d of this.decks) set(`cut${this.decks.indexOf(d)}`, d.filter.frequency, cutoff, cutoff * 0.03);
    const droneHz = midiToHz(s.tonic + 12 * s.droneOct);
    set('beat', this.droneB.frequency, droneHz + s.beat, 0.01);
    set('drone', this.droneGain.gain, 0.11 * s.drone, 0.003);
    set('dcut', this.droneFilter.frequency, 160 + 260 * s.drone, 8);
    set('trem', this.tremGain.gain, 0.11 * s.drone * s.tremolo, 0.002);
    if (s.tremoloHz > 0) set('tremHz', this.trem.frequency, s.tremoloHz, 0.01);
    set('wind', this.windGain.gain, 0.22 * s.noise, 0.003);
    set('windHz', this.windFilter.frequency, s.noiseHz, s.noiseHz * 0.04);
    set('rumble', this.rumbleGain.gain, 0.5 * s.rumble, 0.01);
    set('send', this.send.gain, 0.35 + 0.5 * s.space, 0.01);
    if (this.applied.rt === undefined || Math.abs(this.applied.rt - s.rt60) > 0.3) {
      this.applied.rt = s.rt60;
      this.reverb.set(s.rt60, 2400 + 2600 * s.brightness, t, tau);
    }
  }

  event(name: string, params: MoodParams = {}): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + 0.02;
    if (t - (this.lastEvent[name] ?? -1) < 0.15) return;
    this.lastEvent[name] = t;
    const I = typeof params.intensity === 'number' ? Math.max(0, Math.min(1, params.intensity)) : 0.6;
    const s = this.spec;
    const root = s.tonic + 24;
    const sweep = (f0: number, f1: number, f2: number, dur: number, peak: number) => {
      this.sweepSleep.wake(t + dur * 2);
      const f = this.sweepFilter.frequency;
      f.cancelScheduledValues(t);
      f.setValueAtTime(f0, t);
      f.exponentialRampToValueAtTime(f1, t + dur * 0.55);
      f.exponentialRampToValueAtTime(f2, t + dur);
      const gg = this.sweepGain.gain;
      gg.cancelScheduledValues(t);
      gg.setTargetAtTime(peak, t, dur * 0.2);
      gg.setTargetAtTime(0, t + dur * 0.55, dur * 0.18);
    };
    const rumble = (peak: number, dur: number) => {
      this.envSleep.wake(t + dur * 2.5);
      const gg = this.rumbleEnv.gain;
      gg.cancelScheduledValues(t);
      gg.setTargetAtTime(peak, t, dur * 0.15);
      gg.setTargetAtTime(0, t + dur * 0.35, dur * 0.25);
    };
    switch (name) {
      case 'portal':
        sweep(180, 2600, 700, 2.6, 0.35);
        this.chime([0, 7, 14, 19], t + 0.9, 0.05, 0.22);
        break;
      case 'whoosh':
        sweep(260, 1900, 320, 1.4, 0.28);
        break;
      case 'warp':
        sweep(120, 3400, 900, 3.2, 0.4);
        rumble(0.9, 3);
        break;
      case 'engage':
        sweep(90, 600, 200, 1.6, 0.22);
        rumble(0.5, 1.8);
        break;
      case 'arrive':
        this.chime([0, 7, 12, 16, 21], t + 0.05, 0.06, 0.28);
        break;
      case 'select':
        this.bellNote(midiToHz(root + 24 + degreeToSemitone(s.mode, 4)), t, 0.05, 1.5, 3.5, 0.6);
        break;
      case 'collision-passage':
        rumble(0.4 + 0.8 * I, 4);
        break;
      case 'collision-merger':
        rumble(1.3, 7);
        this.chime([-12, -5, 0], t + 0.3, 0.2, 0.2);
        break;
      case 'rupture':
        rumble(0.7, 3);
        this.bellNote(midiToHz(root + 13), t, 0.05, 3, 3.5, 2);
        break;
      case 'restore':
        this.chime([0, 2, 4, 6, 8].map((d) => degreeToSemitone(s.mode, d)), t, 0.09, 0.24);
        break;
      case 'pulsar':
        this.tick(t, 0.25);
        break;
      default:
        if (name.startsWith('ui-')) {
          if (!this.opts.ui) return;
          this.uiSound(name, t);
        } else this.bellNote(midiToHz(root + 12), t, 0.04, 1, 2, 0.8);
    }
  }

  private uiSound(name: string, t: number): void {
    // Tiny, low-level, pitched to the current key; routed through uiBus (off by default).
    const f = midiToHz(this.spec.tonic + 48 + (name === 'ui-close' ? 0 : name === 'ui-move' ? 7 : 12));
    this.bellNote(f, t, name === 'ui-move' ? 0.008 : 0.016, 2, 0.08, 0.3);
    this.tick(t, 0.015);
  }

  /** A click of band-limited noise (pulsar pulses, UI). */
  private tick(t: number, level = 0.25): void {
    this.tickSleep.wake(t + 0.1);
    const gg = this.tickGain.gain;
    gg.cancelScheduledValues(t);
    gg.setValueAtTime(0, t);
    gg.linearRampToValueAtTime(level, t + 0.0015);
    gg.setTargetAtTime(0, t + 0.0015, 0.006);
  }

  /** A single FM bell/glass/vibes note on the least-recently-used voice. */
  private bellNote(f: number, t: number, level: number, ratio: number, decay: number, index = 1.2): void {
    let v = this.bells[0];
    for (const b of this.bells) if (b.free < v.free) v = b;
    v.car.frequency.setValueAtTime(f, t);
    v.mod.frequency.setValueAtTime(f * ratio, t);
    strike(v.idx.gain, t, f * ratio * index, 0.004, decay * 0.25);
    strike(v.out.gain, t, level, 0.006, decay);
    v.free = t + decay * 3;
    v.sleep.wake(t + decay * 5);
  }

  private chime(semis: number[], t: number, gap: number, level: number): void {
    const base = this.spec.tonic + 36;
    semis.forEach((x, i) => this.bellNote(midiToHz(base + x), t + i * gap, level * 0.25, 1, 3.2, 0.9));
  }

  update(): void {
    this.schedule();
  }

  private schedule(): void {
    if (!this.ctx || this.ctx.state === 'closed') return; // (offline renders drive this at suspend points)
    const now = this.ctx.currentTime;
    const horizon = now + LOOKAHEAD;
    const s = this.spec;
    if (now - this.applyClock > APPLY_EVERY) {
      this.applyClock = now;
      this.applyContinuous(now, 1.2);
      if (s.rumble > 0.001) this.rumbleSleep.wake(now + 5);
      for (const z of this.sleepers) z.tick(now);
      this.jazzSleep.tick(now);
    }
    // Pad chord walk (ambient only; with jazz the pad holds a quartal colour on the tonic).
    if (now > this.nextPadChange) {
      this.nextPadChange = now + 15 + 10 * this.rnd();
      if (!this.opts.music && s.progression.length > 1) {
        this.padIndex = (this.padIndex + 1 + (this.rnd() < 0.25 ? 1 : 0)) % s.progression.length;
        this.padDegree = s.progression[this.padIndex];
        this.retune(now + 0.05, 6, true);
      }
    }
    // Bells: a Poisson process, occasionally echoing into a two- or three-note figure.
    if (this.nextBell < now - 1) this.nextBell = now + 0.5;
    while (this.nextBell < horizon) {
      const tb = this.nextBell;
      const rate = s.bells * (this.opts.music ? 0.35 : 1);
      this.nextBell += rate > 0 ? -Math.log(1 - this.rnd() * 0.999) / rate + 0.6 : 4;
      if (rate <= 0 || !this.opts.ambience) continue;
      this.ambientBell(tb);
    }
    // Pulsar ticks.
    if (s.pulse > 0) {
      if (this.nextPulse < now - 0.5) this.nextPulse = now + 0.05;
      while (this.nextPulse < horizon) {
        this.tick(this.nextPulse, 0.12);
        this.nextPulse += 1 / s.pulse;
      }
    }
    if (this.opts.music) this.scheduleJazz(now, horizon);
  }

  private ambientBell(t: number): void {
    const s = this.spec;
    const r = this.rnd;
    const f0 = midiToHz(s.tonic) * Math.pow(2, s.bellShift);
    const pick = () => s.partials[Math.floor(r() * s.partials.length)];
    let f: number;
    let ratio = 1;
    let index = 0.7;
    let decay = 3.5;
    if (s.bellKind === 'spectral') {
      f = f0 * 8 * pick();
      ratio = 1.0;
      index = 0.5;
      decay = 4.5;
    } else if (s.bellKind === 'glass') {
      f = f0 * pick();
      ratio = 3.53; // inharmonic → glassy
      index = 0.35;
      decay = 3;
    } else {
      f = f0 * pick();
      ratio = 1;
      index = 0.9;
    }
    while (f > 2400) f /= 2;
    while (f < 260) f *= 2;
    const lvl = 0.035 + 0.03 * r();
    this.bellNote(f, t, lvl, ratio, decay, index);
    if (r() < 0.3) this.bellNote(f * (s.bellKind === 'harmonic' ? 1.5 : 2), t + 0.22 + 0.2 * r(), lvl * 0.5, ratio, decay * 0.8, index);
  }

  // ——— Space jazz ———
  private scheduleJazz(now: number, horizon: number): void {
    const s = this.spec;
    const beatDur = 60 / s.tempo;
    if (this.nextBeat < now - 0.05) this.nextBeat = now + 0.05; // skip, never pile up late notes
    while (this.nextBeat < horizon) {
      const tb = this.nextBeat;
      const r = this.rnd;
      if (this.beat === 0) {
        if (this.bar % 2 === 0) {
          const prog = s.jazz;
          this.chordDeg = prog[this.chordStep % prog.length];
          this.chordStep++;
          this.nextChordDeg = prog[this.chordStep % prog.length];
          this.voicing = voiceLead(this.voicing, rootlessVoicings(s.tonic, s.mode, this.chordDeg, 50, 74), 62);
          this.motif = this.makeMotif();
        }
        const toward = this.bar % 2 === 0 ? this.chordDeg + 4 : this.nextChordDeg;
        this.bassLine = walkingBar(s.tonic, s.mode, this.chordDeg, toward, this.prevBass, r);
        this.prevBass = this.bassLine[3];
        // comping template, in swung eighths of the bar
        const templates = [[0, 3], [3, 7], [1, 4], [0, 5], [3], [2, 7], [0]];
        this.comp = templates[Math.floor(r() * templates.length)];
      }
      // bass (a touch of human timing)
      this.bassNote(midiToHz(this.bassLine[this.beat]), tb + (r() - 0.5) * 0.012, beatDur * 0.92);
      // brushes: swish across every beat, taps on the ride pattern (1 2-a 3 4-a)
      const sw = this.brushSwish.gain;
      sw.setTargetAtTime(0.05 + 0.02 * (this.beat % 2), tb, beatDur * 0.25);
      sw.setTargetAtTime(0.008, tb + beatDur * 0.45, beatDur * 0.2);
      this.tap(tb, this.beat % 2 ? 0.09 : 0.06);
      if (this.beat % 2 === 1) this.tap(tb + swingOffset(1, beatDur, 0.64), 0.045);
      // comping chords and motif notes that fall in this beat
      for (const e of this.comp) {
        if (Math.floor(e / 2) !== this.beat) continue;
        const te = tb + swingOffset(e % 2, beatDur, 0.64);
        this.epChord(this.voicing ?? [], te, e % 2 ? beatDur * 0.55 : beatDur * 1.4);
      }
      const barInPair = this.bar % 2;
      for (const [pos, note] of this.motif) {
        if (Math.floor(pos / 8) !== barInPair || Math.floor((pos % 8) / 2) !== this.beat) continue;
        this.bellNote(midiToHz(note), tb + swingOffset(pos % 2, beatDur, 0.64), 0.045, 1, 1.4, 0.35); // vibes
      }
      this.nextBeat += beatDur;
      this.beat = (this.beat + 1) % 4;
      if (this.beat === 0) this.bar++;
    }
  }

  /** A sparse vibraphone phrase over the current chord: 0–4 notes, stepwise, swung. */
  private makeMotif(): Array<[number, number]> {
    const r = this.rnd;
    const s = this.spec;
    if (r() < 0.45) return [];
    const n = 2 + Math.floor(r() * 3);
    const start = Math.floor(r() * 6);
    const out: Array<[number, number]> = [];
    let deg = this.chordDeg + [0, 2, 4, 6][Math.floor(r() * 4)] + 14;
    let pos = start;
    for (let i = 0; i < n && pos < 16; i++) {
      out.push([pos, s.tonic + 12 + degreeToSemitone(s.mode, deg)]);
      deg += r() < 0.6 ? -1 : r() < 0.5 ? 1 : -2;
      pos += 1 + Math.floor(r() * 3);
    }
    return out;
  }

  private tap(t: number, level: number): void {
    const gg = this.brushTap.gain;
    gg.setValueAtTime(0, t);
    gg.linearRampToValueAtTime(level, t + 0.003);
    gg.setTargetAtTime(0, t + 0.003, 0.035);
  }

  private bassNote(f: number, t: number, dur: number): void {
    const v = this.bass[0].free <= this.bass[1].free ? this.bass[0] : this.bass[1];
    const other = v === this.bass[0] ? this.bass[1] : this.bass[0];
    other.out.gain.setTargetAtTime(0, t, 0.03); // legato hand-off
    v.o1.frequency.setValueAtTime(f, t);
    v.o2.frequency.setValueAtTime(f, t);
    const gg = v.out.gain;
    gg.cancelScheduledValues(t);
    gg.setTargetAtTime(0, t - 0.004, 0.003);
    gg.setTargetAtTime(0.34, t + 0.004, 0.004);
    gg.setTargetAtTime(0.16, t + 0.03, 0.18);
    gg.setTargetAtTime(0, t + dur, 0.05);
    v.free = t + dur;
    v.sleep.wake(t + dur + 0.5);
  }

  /** Rhodes-like FM: carrier:modulator 1:1, bright attack whose index decays into a mellow tone. */
  private epChord(notes: number[], t: number, dur: number): void {
    const vel = 0.8 + 0.2 * this.rnd();
    notes.forEach((m, i) => {
      let v = this.eps[0];
      for (const e of this.eps) if (e.free < v.free) v = e;
      const tt = t + i * 0.006; // a slight roll
      const f = midiToHz(m);
      v.car.frequency.setValueAtTime(f, tt);
      v.mod.frequency.setValueAtTime(f, tt);
      const ix = v.idx.gain;
      ix.cancelScheduledValues(tt);
      ix.setTargetAtTime(f * 1.8 * vel, tt, 0.002);
      ix.setTargetAtTime(f * 0.25, tt + 0.01, 0.25);
      const gg = v.out.gain;
      gg.cancelScheduledValues(tt);
      gg.setTargetAtTime(0, tt - 0.005, 0.003);
      gg.setTargetAtTime(0.045 * vel, tt + 0.003, 0.003);
      gg.setTargetAtTime(0.02 * vel, tt + 0.02, 0.5);
      gg.setTargetAtTime(0, tt + dur, 0.12);
      v.free = tt + dur + 0.3;
      v.sleep.wake(tt + dur + 1);
    });
  }

  stop(): void {
    clearInterval(this.timer);
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
      s.disconnect();
    }
    for (const n of this.nodes) n.disconnect();
    this.reverb?.dispose();
    this.sources = [];
    this.nodes = [];
  }
}

export function createSoundEngine(): SoundEngine {
  return new GenerativeEngine();
}
