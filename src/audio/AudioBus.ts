/**
 * Audio entry point. Browsers only allow sound after a user gesture, so the bus stays
 * silent until `enable()` is called from a click. Experiences describe *what is happening*
 * (setMood / event); the audio engine decides what that sounds like.
 */
import { resolveMood } from './moods';

export interface MoodParams {
  /** 0..1 overall energy/tension of the scene. */
  intensity?: number;
  /** Optional hints: e.g. { mass: 1e6 } for a black hole, { density } for the cosmic web. */
  [key: string]: number | string | boolean | undefined;
}

/** Listener-facing switches (persisted per browser). */
export interface SoundOptions {
  /** The generative "space jazz" layer (piano, walking bass, brushes). */
  music: boolean;
  /** Ambient pads, drones, wind and bells. */
  ambience: boolean;
  /** Very subtle interface ticks. Off by default. */
  ui: boolean;
}

export interface SoundEngine {
  start(ctx: AudioContext, out: AudioNode): void;
  setMood(name: string, params: MoodParams): void;
  event(name: string, params?: MoodParams): void;
  update(dt: number): void;
  stop(): void;
  /** Optional: apply listener options. */
  configure?(o: Partial<SoundOptions>): void;
}

const STORE_KEY = 'twu.sound.v1';

function loadPrefs(): { volume: number; options: SoundOptions } {
  const d = { volume: 0.7, options: { music: false, ambience: true, ui: false } };
  try {
    const raw = window.localStorage?.getItem(STORE_KEY);
    if (!raw) return d;
    const p = JSON.parse(raw) as Partial<{ volume: number; options: Partial<SoundOptions> }>;
    return {
      volume: typeof p.volume === 'number' && p.volume >= 0 && p.volume <= 1 ? p.volume : d.volume,
      options: { ...d.options, ...(p.options ?? {}) },
    };
  } catch {
    return d;
  }
}

export class AudioBus {
  ctx: AudioContext | null = null;
  master: GainNode | null = null;
  private engine: SoundEngine | null = null;
  private engineFactory: (() => Promise<SoundEngine>) | null = null;
  private mood: { name: string; params: MoodParams } = { name: 'silence', params: {} };
  private suspendTimer = 0;
  private listeners = new Set<() => void>();
  enabled = false;
  volume = 0.7;
  options: SoundOptions = { music: false, ambience: true, ui: false };

  constructor() {
    if (typeof window !== 'undefined') {
      const p = loadPrefs();
      this.volume = p.volume;
      this.options = p.options;
    }
  }

  /** Register the generative sound engine (loaded lazily on first enable). */
  setEngineFactory(f: () => Promise<SoundEngine>): void {
    this.engineFactory = f;
  }

  async enable(): Promise<void> {
    clearTimeout(this.suspendTimer);
    if (!this.ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC({ latencyHint: 'playback' });
      this.master = this.ctx.createGain();
      this.master.gain.value = 0;
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 3;
      this.master.connect(comp).connect(this.ctx.destination);
    }
    this.enabled = true;
    this.emit();
    await this.ctx.resume();
    if (!this.engine && this.engineFactory) {
      this.engine = await this.engineFactory();
      this.engine.start(this.ctx, this.master!);
      this.engine.configure?.(this.options);
      this.engine.setMood(this.mood.name, this.mood.params);
    }
    if (!this.enabled) return;
    this.master!.gain.cancelScheduledValues(this.ctx.currentTime);
    this.master!.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.8);
  }

  disable(): void {
    if (!this.ctx || !this.master) {
      this.enabled = false;
      this.emit();
      return;
    }
    this.enabled = false;
    this.master.gain.cancelScheduledValues(this.ctx.currentTime);
    this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.3);
    // Free the audio thread once the fade has finished (the engine costs nothing while suspended).
    clearTimeout(this.suspendTimer);
    const ctx = this.ctx;
    this.suspendTimer = window.setTimeout(() => {
      if (!this.enabled) void ctx.suspend().catch(() => undefined);
    }, 2000);
    this.emit();
  }

  /** Toggle sound; returns the new on/off state. */
  toggle(): boolean {
    if (this.enabled) {
      this.disable();
      return false;
    }
    void this.enable();
    return true;
  }

  /** Master volume 0..1 (persisted). */
  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v));
    if (this.ctx && this.master && this.enabled) this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.08);
    this.save();
    this.emit();
  }

  /** Change listener options (persisted): music (space jazz), ambience, ui ticks. */
  setOption<K extends keyof SoundOptions>(key: K, value: SoundOptions[K]): void {
    this.options = { ...this.options, [key]: value };
    this.engine?.configure?.({ [key]: value } as Partial<SoundOptions>);
    this.save();
    this.emit();
  }

  /** Subscribe to state changes (enabled, volume, options, mood). Returns an unsubscribe function. */
  onChange(f: () => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  /** The current key and where it comes from, e.g. { key: 'D Lydian', origin: '…' }. */
  describe(): { mood: string; key: string; origin: string } {
    const s = resolveMood(this.mood.name, this.mood.params);
    return { mood: s.id, key: s.key, origin: s.origin };
  }

  get moodName(): string {
    return this.mood.name;
  }

  setMood(name: string, params: MoodParams = {}): void {
    const changed = name !== this.mood.name;
    this.mood = { name, params };
    this.engine?.setMood(name, params);
    if (changed) this.emit();
  }

  event(name: string, params?: MoodParams): void {
    if (this.enabled) this.engine?.event(name, params);
  }

  update(dt: number): void {
    if (this.enabled) this.engine?.update(dt);
  }

  private save(): void {
    try {
      window.localStorage?.setItem(STORE_KEY, JSON.stringify({ volume: this.volume, options: this.options }));
    } catch {
      /* storage blocked: preferences last for this visit only */
    }
  }

  private emit(): void {
    for (const f of this.listeners) f();
  }
}
