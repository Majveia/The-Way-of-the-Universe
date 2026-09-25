/**
 * The cosmic timeline: maps a playback track u ∈ [0, 1] to cosmic time and names the epochs.
 *
 * Track pacing (so that each era gets screen time in proportion to how much *changes*):
 *   u ∈ [0, U1]   recombination fireball → start of the N-body run: linear in ln a
 *   u ∈ [U1, U2]  structure formation to today: linear in √a (early web growth gets room)
 *   u ∈ [U2, 1]   the future (ln a), or the turnaround and collapse (cosmic time)
 */
import type { Expansion } from '../../physics/cosmosExpansion';
import { cieXYZ, planck } from '../../physics/blackbody';

export const Z_START = 1500;
const U1 = 0.1;
const U2 = 0.86;

export interface Epoch {
  id: string;
  kicker: string;
  line: string;
}

export const EPOCHS: Record<string, Epoch> = {
  plasma: {
    id: 'plasma',
    kicker: 'The primordial plasma',
    line: 'Hydrogen, helium and light fused into one glowing, opaque fog.',
  },
  recombination: {
    id: 'recombination',
    kicker: 'Recombination · 380 000 years',
    line: 'Electrons settle onto nuclei. The fog lifts: light travels freely for the first time.',
  },
  dark: {
    id: 'dark',
    kicker: 'The Dark Ages',
    line: 'The afterglow reddens into the infrared. Unseen, dark matter keeps gathering.',
  },
  dawn: {
    id: 'dawn',
    kicker: 'Cosmic Dawn',
    line: 'In the rarest, densest peaks the first stars ignite.',
  },
  reionization: {
    id: 'reionization',
    kicker: 'Reionization',
    line: 'Ultraviolet light from the first galaxies splits the hydrogen between them.',
  },
  assembly: {
    id: 'assembly',
    kicker: 'Galaxies assemble',
    line: 'Matter drains from the voids along filaments into growing knots.',
  },
  noon: {
    id: 'noon',
    kicker: 'Cosmic Noon',
    line: 'Star formation peaks. The universe is at its most brilliant.',
  },
  lambda: {
    id: 'lambda',
    kicker: 'Dark energy takes over',
    line: 'The expansion begins to accelerate and the growth of structure slows.',
  },
  matter: {
    id: 'matter',
    kicker: 'The matter era',
    line: 'With nothing to hold it back, gravity keeps building ever larger clusters.',
  },
  today: {
    id: 'today',
    kicker: 'Today',
    line: 'Clusters, filaments, walls and voids — the cosmic web.',
  },
  future: {
    id: 'future',
    kicker: 'The far future',
    line: 'Bound clusters endure while accelerating space pulls the web apart.',
  },
  turnaround: {
    id: 'turnaround',
    kicker: 'Turnaround',
    line: 'Gravity wins: the expansion halts and reverses.',
  },
  collapse: {
    id: 'collapse',
    kicker: 'Toward the Big Crunch',
    line: 'Space contracts, the background heats up again, everything falls together.',
  },
};

export class CosmicTimeline {
  readonly e: Expansion;
  readonly tStart: number;
  readonly tIC: number;
  readonly tToday: number;
  readonly tEnd: number;
  private readonly aStart: number;
  private readonly aIC: number;
  private readonly aEnd: number;
  readonly recollapse: boolean;
  /** Track positions of the main milestones. */
  readonly uIC = U1;
  readonly uToday = U2;

  constructor(e: Expansion, tIC: number, tEnd: number) {
    this.e = e;
    this.aStart = 1 / (1 + Z_START);
    this.tStart = e.timeOfA(this.aStart);
    this.tIC = tIC;
    this.aIC = e.aAt(tIC);
    this.tToday = e.tToday;
    this.tEnd = Math.max(tEnd, this.tToday * 1.0001);
    this.aEnd = e.aAt(this.tEnd);
    this.recollapse = e.recollapses && this.tEnd > e.tTurn;
  }

  uOfT(t: number): number {
    const e = this.e;
    if (t <= this.tStart) return 0;
    if (t < this.tIC) {
      const s = (Math.log(e.aAt(t)) - Math.log(this.aStart)) / (Math.log(this.aIC) - Math.log(this.aStart));
      return U1 * clamp01(s);
    }
    if (t <= this.tToday) {
      const s = (Math.sqrt(e.aAt(t)) - Math.sqrt(this.aIC)) / (1 - Math.sqrt(this.aIC));
      return U1 + (U2 - U1) * clamp01(s);
    }
    if (t >= this.tEnd) return 1;
    if (this.recollapse) return U2 + (1 - U2) * ((t - this.tToday) / (this.tEnd - this.tToday));
    const s = Math.log(e.aAt(t)) / Math.log(this.aEnd);
    return U2 + (1 - U2) * clamp01(s);
  }

  tOfU(u: number): number {
    const e = this.e;
    u = clamp01(u);
    if (u <= U1) {
      const la = Math.log(this.aStart) + (u / U1) * (Math.log(this.aIC) - Math.log(this.aStart));
      return e.timeOfA(Math.exp(la));
    }
    if (u <= U2) {
      const s = (u - U1) / (U2 - U1);
      const sa = Math.sqrt(this.aIC) + s * (1 - Math.sqrt(this.aIC));
      return e.timeOfA(sa * sa);
    }
    const s = (u - U2) / (1 - U2);
    if (this.recollapse) return this.tToday + s * (this.tEnd - this.tToday);
    return e.timeOfA(Math.exp(s * Math.log(this.aEnd)));
  }

  /** The epoch at cosmic time t (H0 units). */
  epochAt(t: number): Epoch {
    const e = this.e;
    if (e.recollapses && t > e.tTurn) {
      return t - e.tTurn < 0.08 * (e.tCrunch - e.tTurn) ? EPOCHS.turnaround : EPOCHS.collapse;
    }
    const a = e.aAt(t);
    const z = 1 / a - 1;
    if (z > 1100) return EPOCHS.plasma;
    if (z > 850) return EPOCHS.recombination;
    if (z > 30) return EPOCHS.dark;
    if (z > 15) return EPOCHS.dawn;
    if (z > 6) return EPOCHS.reionization;
    if (z > 3) return EPOCHS.assembly;
    if (z > 1.2) return EPOCHS.noon;
    if (Math.abs(t - this.tToday) < 0.012 || (z > -0.02 && z < 0.03)) return EPOCHS.today;
    if (t > this.tToday) return e.recollapses ? EPOCHS.matter : EPOCHS.future;
    if (this.e.Ode0 > 0.05 && isFinite(e.tAccel) && t > e.tAccel - 0.05) return EPOCHS.lambda;
    return EPOCHS.matter;
  }

  /** Tick marks for the timeline widget. */
  ticks(): Array<{ u: number; label: string; major: boolean }> {
    const e = this.e;
    const out: Array<{ u: number; label: string; major: boolean }> = [];
    const at = (z: number) => this.uOfT(e.timeOfA(1 / (1 + z)));
    out.push({ u: at(1090), label: 'Recombination', major: false });
    out.push({ u: at(20), label: 'Cosmic Dawn', major: false });
    out.push({ u: at(7.7), label: 'Reionization', major: false });
    out.push({ u: at(2), label: 'Cosmic Noon', major: false });
    if (isFinite(e.tAccel) && e.tAccel < this.tToday) out.push({ u: this.uOfT(e.tAccel), label: 'Acceleration', major: false });
    out.push({ u: this.uToday, label: 'Today', major: true });
    if (this.recollapse) out.push({ u: this.uOfT(e.tTurn), label: 'Turnaround', major: false });
    return out;
  }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Visible-band radiance of a blackbody at T relative to T = 3000 K (the last-scattering surface),
 * ∫ B_λ(T) ȳ(λ) dλ. It falls by ~10⁴ between 3000 K and 1000 K: the afterglow leaves the visible
 * a few hundred million years into the Dark Ages. Evaluated every frame, so the photopic ȳ(λ)
 * table is built once and nothing is allocated per call (81 Planck terms ≈ a few µs).
 */
const Y_BAR = Float64Array.from({ length: 81 }, (_, i) => cieXYZ(380 + 5 * i)[1]);
function visibleRadiance(T: number): number {
  const t = Math.max(T, 50);
  let s = 0;
  for (let i = 0; i < 81; i++) s += planck((380 + 5 * i) * 1e-9, t) * Y_BAR[i];
  return s;
}
const RADIANCE_3000 = visibleRadiance(3000);
export function fireballRadiance(T: number): number {
  return visibleRadiance(T) / RADIANCE_3000;
}
