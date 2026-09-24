/**
 * Feedback delay network reverb (Jot & Chaigne 1991; Stautner & Puckette 1982), built from
 * plain Web Audio nodes — no ConvolverNode, no impulse response to generate or fetch.
 *
 *   x ──► in_i ──► delay_i ──► lowpass_i (damping) ──► g_i ──┬──► out (L/R alternating)
 *            ▲                                               │
 *            └────────── A · (all line outputs) ◄────────────┘
 *
 * Mixing matrix: Householder A = I − (2/N)·11ᵀ (orthogonal, maximally diffusing, and cheap:
 * each line feeds back to itself, plus one shared "sum" node scaled by −2/N).
 * Per-line gain for a target decay time: g_i = 10^(−3·d_i / RT60), so every recirculation
 * path loses 60 dB in RT60 seconds regardless of its length. Delay lengths are distinct
 * primes (in samples) so the echo densities never line up.
 */

export function isPrime(n: number): boolean {
  if (n < 2) return false;
  if (n % 2 === 0) return n === 2;
  for (let k = 3; k * k <= n; k += 2) if (n % k === 0) return false;
  return true;
}

/** N delay lengths (seconds), geometrically spaced in [minMs, maxMs]·size, each a prime number of samples. */
export function fdnDelays(n: number, size = 1, sampleRate = 48000, minMs = 31, maxMs = 97): number[] {
  const out: number[] = [];
  const used = new Set<number>();
  for (let i = 0; i < n; i++) {
    const ms = minMs * Math.pow(maxMs / minMs, n > 1 ? i / (n - 1) : 0) * size;
    let s = Math.max(3, Math.round((ms / 1000) * sampleRate));
    while (!isPrime(s) || used.has(s)) s++;
    used.add(s);
    out.push(s / sampleRate);
  }
  return out;
}

/** Loop gain for a delay line of length d (s) so that it decays 60 dB in rt60 (s). */
export function fdnGain(d: number, rt60: number): number {
  return Math.pow(10, (-3 * d) / Math.max(0.05, rt60));
}

/** Householder feedback matrix I − (2/N)·11ᵀ (row-major). */
export function householder(n: number): number[][] {
  const m: number[][] = [];
  for (let i = 0; i < n; i++) {
    const r: number[] = [];
    for (let j = 0; j < n; j++) r.push((i === j ? 1 : 0) - 2 / n);
    m.push(r);
  }
  return m;
}

/** The network as Web Audio nodes. Connect a send to `input`; `output` is stereo. */
export class FDNReverb {
  readonly input: GainNode;
  readonly output: GainNode;
  private delays: DelayNode[] = [];
  private damps: BiquadFilterNode[] = [];
  private gains: GainNode[] = [];
  private lengths: number[];
  private nodes: AudioNode[] = [];

  constructor(private ctx: AudioContext, n = 8, size = 1.2) {
    this.lengths = fdnDelays(n, size, ctx.sampleRate);
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    const merger = ctx.createChannelMerger(2);
    const sum = ctx.createGain();
    sum.gain.value = -2 / n;
    // gentle pre-filter so the tail stays dark and never hisses
    const pre = ctx.createBiquadFilter();
    pre.type = 'lowpass';
    pre.frequency.value = 5200;
    this.input.connect(pre);
    this.nodes.push(merger, sum, pre);
    for (let i = 0; i < n; i++) {
      const lineIn = ctx.createGain();
      const d = ctx.createDelay(1);
      d.delayTime.value = this.lengths[i];
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 3800;
      lp.Q.value = -3; // dB: no resonant peak, so the loop gain never exceeds g_i
      const g = ctx.createGain();
      g.gain.value = fdnGain(this.lengths[i], 6);
      pre.connect(lineIn);
      lineIn.connect(d).connect(lp).connect(g);
      g.connect(lineIn); // diagonal of the Householder matrix
      g.connect(sum); // −2/N · Σ
      g.connect(merger, 0, i % 2);
      this.delays.push(d);
      this.damps.push(lp);
      this.gains.push(g);
      this.nodes.push(lineIn, d, lp, g);
    }
    for (let i = 0; i < n; i++) sum.connect(this.nodes[3 + i * 4]); // each lineIn
    merger.connect(this.output);
    this.output.gain.value = 0.9;
  }

  /** Change decay (RT60, s) and damping (Hz) smoothly. */
  set(rt60: number, dampHz: number, t: number, tau = 1): void {
    for (let i = 0; i < this.gains.length; i++) {
      this.gains[i].gain.setTargetAtTime(fdnGain(this.lengths[i], rt60), t, tau);
      this.damps[i].frequency.setTargetAtTime(dampHz, t, tau);
    }
  }

  dispose(): void {
    for (const n of this.nodes) n.disconnect();
    this.input.disconnect();
    this.output.disconnect();
  }
}
