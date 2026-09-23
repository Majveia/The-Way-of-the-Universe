import type { MoodParams, SoundEngine } from './AudioBus';

/**
 * Minimal ambient engine: a slowly breathing, detuned drone through a resonant low-pass.
 * (Placeholder for the generative score; same interface.)
 */
export function createSoundEngine(): SoundEngine {
  let ctx: AudioContext;
  let out: GainNode;
  let filter: BiquadFilterNode;
  const oscs: OscillatorNode[] = [];
  let intensity = 0.3;
  return {
    start(c, dest) {
      ctx = c;
      out = c.createGain();
      out.gain.value = 0.18;
      filter = c.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 420;
      filter.Q.value = 4;
      filter.connect(out).connect(dest);
      const base = 55; // A1
      for (const [ratio, det] of [[1, -6], [1.5, 4], [2, 7], [3, -3]] as const) {
        const o = c.createOscillator();
        o.type = ratio === 1 ? 'sine' : 'triangle';
        o.frequency.value = base * ratio;
        o.detune.value = det;
        const g = c.createGain();
        g.gain.value = 0.25 / ratio;
        o.connect(g).connect(filter);
        o.start();
        oscs.push(o);
      }
      const lfo = c.createOscillator();
      lfo.frequency.value = 0.05;
      const lg = c.createGain();
      lg.gain.value = 180;
      lfo.connect(lg).connect(filter.frequency);
      lfo.start();
      oscs.push(lfo);
    },
    setMood(_name: string, p: MoodParams) {
      intensity = typeof p.intensity === 'number' ? p.intensity : 0.3;
      if (filter) filter.frequency.setTargetAtTime(300 + 900 * intensity, ctx.currentTime, 2);
    },
    event() {},
    update() {},
    stop() {
      for (const o of oscs) o.stop();
      out?.disconnect();
    },
  };
}
