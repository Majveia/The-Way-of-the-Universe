/**
 * Audio entry point. Browsers only allow sound after a user gesture, so the bus stays
 * silent until `enable()` is called from a click. Experiences describe *what is happening*
 * (setMood / event); the audio engine decides what that sounds like.
 */
export interface MoodParams {
  /** 0..1 overall energy/tension of the scene. */
  intensity?: number;
  /** Optional hints: e.g. { mass: 1e6 } for a black hole, { density } for the cosmic web. */
  [key: string]: number | string | boolean | undefined;
}

export interface SoundEngine {
  start(ctx: AudioContext, out: AudioNode): void;
  setMood(name: string, params: MoodParams): void;
  event(name: string, params?: MoodParams): void;
  update(dt: number): void;
  stop(): void;
}

export class AudioBus {
  ctx: AudioContext | null = null;
  master: GainNode | null = null;
  private engine: SoundEngine | null = null;
  private engineFactory: (() => Promise<SoundEngine>) | null = null;
  private mood: { name: string; params: MoodParams } = { name: 'silence', params: {} };
  enabled = false;
  volume = 0.7;

  /** Register the generative sound engine (loaded lazily on first enable). */
  setEngineFactory(f: () => Promise<SoundEngine>): void {
    this.engineFactory = f;
  }

  async enable(): Promise<void> {
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
    await this.ctx.resume();
    if (!this.engine && this.engineFactory) {
      this.engine = await this.engineFactory();
      this.engine.start(this.ctx, this.master!);
      this.engine.setMood(this.mood.name, this.mood.params);
    }
    this.enabled = true;
    this.master!.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.8);
  }

  disable(): void {
    if (!this.ctx || !this.master) return;
    this.enabled = false;
    this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.3);
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

  setMood(name: string, params: MoodParams = {}): void {
    this.mood = { name, params };
    this.engine?.setMood(name, params);
  }

  event(name: string, params?: MoodParams): void {
    this.engine?.event(name, params);
  }

  update(dt: number): void {
    if (this.enabled) this.engine?.update(dt);
  }
}
