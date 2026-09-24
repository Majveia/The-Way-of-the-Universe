import { GalaxyPotential, radMyrFromKmsKpc, pcMyrFromKms } from '../../physics/galaxyPotential';
import { Rng } from '../../physics/random';
import { msLifetime, msLuminosity, msTemperature, sampleKroupa, sampleClusterRadius } from '../../physics/galaxyStars';
import { hash2u, hash3u, next, u01 } from './hash';
import { armPhi, buildArms, wrapPi, type ArmSpec, type GalaxyParams } from './params';

/**
 * GalaxyModel: parameters + seed → a deterministic set of star particles, each carrying the
 * parameters of its orbit (not a position). Positions at any time t are evaluated on the GPU
 * (shaders/stars.ts) and mirrored here on the CPU (`positionAt`) for picking, tests and
 * `nearestStars`.
 *
 * Orbits (Binney & Tremaine 2008 §3.2.3, §6.1–6.2):
 *  - DISK: epicycles about a guiding centre R_g moving at Ω(R_g):
 *      R = R_g − X cos(κt + ψ),  φ = φ_g + (2Ω/κ)(X/R_g) sin(κt + ψ),  z = z_A cos(νt + ψ_z).
 *    Plus the density wave (Lin & Shu 1964) in Kalnajs' (1973) kinematic form: an organised
 *    epicycle whose phase is locked to the pattern, θ = m(φ_g − Ω_p t − α(R_g)), with the
 *    orientation α(R) winding logarithmically (pitch i). Neighbouring orbits crowd where
 *    ∂R/∂R_g is smallest, which is along the arms: δΣ/Σ ≈ A m cot(i) — a rigidly rotating
 *    spiral made of stars that are *not* rotating with it. Kalnajs' ellipses stay aligned on their
 *    own only where Ω − κ/2 ≈ Ω_p; elsewhere we assume, as Lin–Shu theory does, that the disk's
 *    self-gravity keeps them locked to the pattern (an ansatz, not an N-body solution). Random
 *    epicycles (Rayleigh amplitudes σ_R/κ) smear the wave by the reduction factor e^{−k²s²/2}.
 *  - BAR: x1-like orbits closed in the frame rotating with the bar (Ω_b): ellipses with
 *    axis ratio q traversed at Ω(a) − Ω_b; peanut ("banana") orbits have z ∝ cos 2θ, which
 *    together build the boxy/X-shaped bulge (Combes et al. 1990; Wegg & Gerhard 2013).
 *  - SPHEROID (bulge, halo, ellipticals): rosettes in randomly oriented planes.
 *  - YOUNG: OB associations born in the arms at the pattern's position, then drifting with
 *    Ω(R) (so they shear), expanding, ageing and dying on their real main-sequence lifetimes.
 *  - GLOBULAR: King-profile clusters on inclined halo orbits.
 */

export const KIND_DISK = 0;
export const KIND_BAR = 1;
export const KIND_SPHEROID = 2;
export const KIND_YOUNG = 3;
export const KIND_CLUSTER = 4;

/** Floats per particle: [kind, p1..p8, temperature (or mass-derived T0), luminosity, id]. */
export const STRIDE = 12;

export interface PopulationRange {
  name: string;
  kind: number;
  start: number;
  count: number;
  /** Total luminosity carried by the particles (L☉, time-averaged for young stars). */
  lum: number;
}

export interface GalaxyParticles {
  data: Float32Array;
  count: number;
  populations: PopulationRange[];
  /** Number of young clusters (ids 0..n−1) and globular clusters. */
  youngClusters: number;
  /**
   * Stars represented by each young particle (≥ 1): a particle stands for k co-located stars of its
   * mass inside its association, so that the sampled associations carry the population's light.
   * From more than a few parsecs away an association is a point; closer, it is a cloud of the
   * association's size (see the smoothing length in shaders/stars.ts).
   */
  youngMultiplicity: number;
  globularClusters: number;
  /** Positions of globular cluster centres are orbit params: [r0, θ0, cosI, node] per cluster. */
  globulars: Float32Array;
}

/** Fraction of each population's light carried by particles (the rest is the diffuse volume). */
export const PARTICLE_LIGHT = { disk: 0.15, thick: 0.15, bar: 0.12, bulge: 0.12, young: 0.5, halo: 1, globular: 1 } as const;

/** Live, user-controlled parameters shared by the GPU and the CPU mirror. */
export interface GalaxyLive {
  /** Kinematic density-wave multiplicity m. */
  arms: number;
  pitchDeg: number;
  /** 0..1 × preset bar strength. */
  barStrength: number;
  /** Dust multiplier. */
  dust: number;
  /** Star-formation multiplier (0..2). */
  sfr: number;
}

export function defaultLive(p: GalaxyParams): GalaxyLive {
  return { arms: p.spiral.arms, pitchDeg: p.spiral.pitchDeg, barStrength: 1, dust: 1, sfr: 1 };
}

// ——— Stellar classes for old populations ————————————————————————————————————

type ClassTable = ReadonlyArray<[prob: number, tLo: number, tHi: number, wLo: number, wHi: number]>;
const CLASSES: Record<'disk' | 'thick' | 'bulge' | 'halo', ClassTable> = {
  // dwarfs G/K, A/F main sequence, red clump & K giants, M giants
  disk: [
    [0.55, 4600, 6200, 0.4, 1.5],
    [0.14, 6800, 10000, 2, 8],
    [0.24, 4400, 5100, 3, 12],
    [0.07, 3500, 4000, 5, 22],
  ],
  thick: [
    [0.6, 4700, 5900, 0.4, 1.3],
    [0.3, 4300, 5000, 3, 12],
    [0.1, 3500, 4000, 5, 20],
  ],
  bulge: [
    [0.5, 4600, 5700, 0.4, 1.2],
    [0.35, 4100, 4900, 3, 12],
    [0.15, 3400, 3900, 5, 25],
  ],
  // metal-poor: warmer giants, blue horizontal branch, RR Lyrae
  halo: [
    [0.55, 5000, 6200, 0.4, 1.2],
    [0.3, 4300, 5200, 2, 8],
    [0.1, 7500, 10000, 2, 6],
    [0.05, 6000, 7200, 2, 5],
  ],
};

function sampleClass(rng: Rng, table: ClassTable, colorShift = 0): [number, number] {
  let u = rng.next();
  for (const [p, tLo, tHi, wLo, wHi] of table) {
    if (u < p) return [rng.range(tLo, tHi) + colorShift, Math.exp(rng.range(Math.log(wLo), Math.log(wHi)))];
    u -= p;
  }
  const last = table[table.length - 1];
  return [last[1], last[3]];
}

// ——— Generation ————————————————————————————————————————————————————————————

/** Sample R from p(R) ∝ R e^{−R/h} on [lo, hi] (exponential disk surface density). */
function sampleDiskRadius(rng: Rng, h: number, lo: number, hi: number): number {
  for (let k = 0; k < 64; k++) {
    const r = -h * Math.log(Math.max(1e-12, rng.next() * rng.next()));
    if (r >= lo && r <= hi) return r;
  }
  return lo + (hi - lo) * rng.next();
}

/** Radii for ρ ∝ r^−3.5 (p(r) ∝ r^−1.5) between lo and hi. */
function samplePowerHalo(rng: Rng, lo: number, hi: number): number {
  const a = Math.pow(lo, -0.5);
  const b = Math.pow(hi, -0.5);
  return Math.pow(a - rng.next() * (a - b), -2);
}

/**
 * Deterministic particle set for `params` with about `n` particles. Pure (no DOM/GPU), so it can
 * run in a worker. The same params, seed and n always produce the same bytes.
 */
export function generateParticles(params: GalaxyParams, n: number): GalaxyParticles {
  const pot = new GalaxyPotential(params.potential);
  const root = new Rng(params.seed * 7919 + 17);
  const P = params;

  // Particle budget per population: sub-linear in luminosity so faint components stay resolved.
  const want: Record<string, number> = {
    disk: P.disk.lum > 0 ? 0.47 : 0,
    thick: P.disk.thickLum > 0 ? 0.075 : 0,
    bar: P.bar.lum > 0 && P.bar.strength > 0 ? 0.1 : 0,
    bulge: P.bulge.lum > 0 ? (P.disk.lum > 0 ? 0.075 : 0.86) : 0,
    young: P.young.lum > 0 && P.young.sfr > 0 ? 0.2 : 0,
    halo: P.halo.lum > 0 ? 0.045 : 0,
    globular: P.globulars.count > 0 ? (P.disk.lum > 0 ? 0.02 : 0.06) : 0,
  };
  const wsum = Object.values(want).reduce((a, b) => a + b, 0);
  const count = (k: string) => Math.round((n * want[k]) / wsum);

  const total = Object.keys(want).reduce((s, k) => s + count(k), 0);
  const data = new Float32Array(total * STRIDE);
  const populations: PopulationRange[] = [];
  let cursor = 0;
  let idCounter = 0;

  const put = (kind: number, p: ArrayLike<number>, T: number, L: number) => {
    const o = cursor * STRIDE;
    data[o] = kind;
    for (let j = 0; j < 8; j++) data[o + 1 + j] = p[j] ?? 0;
    data[o + 9] = T;
    data[o + 10] = L;
    data[o + 11] = idCounter++;
    cursor++;
  };
  const tmp = new Float64Array(8);

  // Normalise luminosity weights of a range so the particles carry `lum` in total.
  const normalise = (start: number, cnt: number, lum: number) => {
    let s = 0;
    for (let i = start; i < start + cnt; i++) s += data[i * STRIDE + 10];
    const k = s > 0 ? lum / s : 0;
    for (let i = start; i < start + cnt; i++) data[i * STRIDE + 10] *= k;
  };

  const sigmaAt = (sig0: number, R: number, Rd: number) => sig0 * Math.exp(-(R - 3.15 * Rd) / (2 * Rd));
  const flareAt = (R: number) => (P.disk.flare > 0 ? Math.exp(Math.max(0, R - 2.5 * P.disk.scaleLength) / P.disk.flare) : 1);

  // Clumps (irregulars, and a little lopsidedness elsewhere).
  const clumpRng = root.fork('clumps');
  const clumps: Array<[number, number, number]> = [];
  const nClumps = Math.round(4 + 10 * P.clumpiness);
  for (let i = 0; i < nClumps; i++) {
    clumps.push([
      sampleDiskRadius(clumpRng, P.disk.scaleLength * 0.9, 100, P.disk.truncation * 0.7),
      clumpRng.range(0, 2 * Math.PI),
      clumpRng.range(0.25, 0.8) * P.disk.scaleLength,
    ]);
  }

  // ——— Thin and thick disks ———
  for (const which of ['disk', 'thick'] as const) {
    const cnt = count(which);
    if (!cnt) continue;
    const rng = root.fork(which);
    const start = cursor;
    const Rd = which === 'disk' ? P.disk.scaleLength : P.disk.thickScaleLength;
    const h = which === 'disk' ? P.disk.scaleHeight : P.disk.thickScaleHeight;
    const sig = which === 'disk' ? P.disk.sigmaR : P.disk.thickSigmaR;
    const lum = (which === 'disk' ? P.disk.lum : P.disk.thickLum) * PARTICLE_LIGHT[which];
    for (let i = 0; i < cnt; i++) {
      let Rg: number;
      let phi0: number;
      if (P.clumpiness > 0 && rng.next() < P.clumpiness * 0.6) {
        const c = clumps[rng.int(clumps.length)];
        const cx = c[0] * Math.cos(c[1]) + rng.normal(0, c[2]);
        const cy = c[0] * Math.sin(c[1]) + rng.normal(0, c[2]);
        Rg = Math.min(P.disk.truncation, Math.max(60, Math.hypot(cx, cy)));
        phi0 = Math.atan2(cy, cx);
      } else {
        Rg = sampleDiskRadius(rng, Rd, 80, P.disk.truncation);
        phi0 = rng.range(0, 2 * Math.PI);
      }
      const kap = pot.kappa(Rg);
      const sR = pcMyrFromKms(sigmaAt(sig, Rg, Rd));
      // Schwarzschild velocity ellipsoid → Rayleigh-distributed epicycle amplitude X = σ_R/κ.
      const eSig = Math.min(0.28, sR / (kap * Rg));
      const e = Math.min(0.32, eSig * Math.sqrt(-2 * Math.log(Math.max(1e-9, 1 - rng.next()))));
      const zA = h * 1.2 * -Math.log(Math.max(1e-9, 1 - rng.next() * 0.995)) * (which === 'disk' ? flareAt(Rg) : 1);
      tmp[0] = Rg;
      tmp[1] = phi0;
      tmp[2] = e;
      tmp[3] = rng.range(0, 2 * Math.PI);
      tmp[4] = zA;
      tmp[5] = rng.range(0, 2 * Math.PI);
      tmp[6] = which === 'disk' ? rng.range(0.55, 1.45) : rng.range(0.1, 0.5);
      tmp[7] = 0;
      const [T, w] = sampleClass(rng, which === 'disk' ? CLASSES.disk : CLASSES.thick, which === 'disk' ? (P.disk.colorT - 5200) * 0.35 : 0);
      put(KIND_DISK, tmp, T, w);
    }
    normalise(start, cnt, lum);
    populations.push({ name: which, kind: KIND_DISK, start, count: cnt, lum });
  }

  // ——— Bar (x1 + peanut orbits) ———
  {
    const cnt = count('bar');
    if (cnt) {
      const rng = root.fork('bar');
      const start = cursor;
      const L = P.bar.halfLength;
      for (let i = 0; i < cnt; i++) {
        // Half the bar light in the boxy/peanut core (a < 0.45 L), the rest in the long thin bar.
        const core = rng.next() < 0.5;
        const x = core ? Math.min(0.45, 0.45 * Math.pow(rng.next(), 0.75)) : 0.3 + 0.7 * Math.pow(rng.next(), 0.9);
        const a = Math.max(60, x * L);
        const qBase = P.bar.axisRatio * rng.range(0.75, 1.35);
        const q = core ? qBase + (0.7 - qBase) * Math.max(0, 1 - x / 0.3) : qBase;
        const banana = core && rng.next() < P.bar.peanut ? 1 : 0;
        const zA = banana ? a * rng.range(0.18, 0.42) : (core ? 0.25 * a : 140) * -Math.log(Math.max(1e-6, 1 - rng.next() * 0.99));
        tmp[0] = a;
        tmp[1] = rng.range(0, 2 * Math.PI);
        tmp[2] = Math.min(1, q);
        tmp[3] = zA;
        tmp[4] = banana ? (rng.next() < 0.5 ? 0 : Math.PI) + rng.normal(0, 0.35) : rng.range(0, 2 * Math.PI);
        tmp[5] = banana;
        tmp[6] = Math.abs(rng.normal(0, 0.1 * a + 40));
        tmp[7] = rng.range(0, 2 * Math.PI);
        const [T, w] = sampleClass(rng, CLASSES.bulge, (P.bar.colorT - 4300) * 0.5);
        put(KIND_BAR, tmp, T, w);
      }
      const lum = P.bar.lum * PARTICLE_LIGHT.bar;
      normalise(start, cnt, lum);
      populations.push({ name: 'bar', kind: KIND_BAR, start, count: cnt, lum });
    }
  }

  // ——— Spheroids: bulge (or the whole elliptical) and the stellar halo ———
  for (const which of ['bulge', 'halo'] as const) {
    const cnt = count(which);
    if (!cnt) continue;
    const rng = root.fork(which);
    const start = cursor;
    for (let i = 0; i < cnt; i++) {
      let r: number;
      let ci: number;
      if (which === 'bulge') {
        const a = P.bulge.a;
        const rmax = a * P.bulge.rMaxFactor;
        do {
          const s = Math.sqrt(rng.next());
          r = (a * s) / Math.max(1e-6, 1 - s);
        } while (r > rmax);
        r = Math.max(r, 3);
        ci = rng.next() < P.bulge.rotation ? rng.range(0.25, 1) : rng.range(-1, 1);
      } else {
        r = samplePowerHalo(rng, P.halo.rMin, P.halo.rMax);
        ci = rng.range(-1, 1);
      }
      tmp[0] = r;
      tmp[1] = rng.range(0, 2 * Math.PI);
      tmp[2] = ci;
      tmp[3] = rng.range(0, 2 * Math.PI);
      tmp[4] = rng.range(0, which === 'halo' ? 0.55 : 0.4);
      tmp[5] = rng.range(0, 2 * Math.PI);
      tmp[6] = which === 'bulge' ? P.bulge.flatten : P.halo.flatten;
      tmp[7] = 0;
      const [T, w] = sampleClass(rng, which === 'bulge' ? CLASSES.bulge : CLASSES.halo, which === 'bulge' ? (P.bulge.colorT - 4250) * 0.5 : 0);
      put(KIND_SPHEROID, tmp, T, w);
    }
    const lum = (which === 'bulge' ? P.bulge.lum : P.halo.lum) * PARTICLE_LIGHT[which];
    normalise(start, cnt, lum);
    populations.push({ name: which, kind: KIND_SPHEROID, start, count: cnt, lum });
  }

  // ——— Young OB associations ———
  let youngClusters = 0;
  let youngK = 1;
  {
    const cnt = count('young');
    if (cnt) {
      const rng = root.fork('young');
      const start = cursor;
      let made = 0;
      let lumAvg = 0;
      while (made < cnt) {
        // Cluster richness dN/dn ∝ n^−2 (Lada & Lada 2003), 4…160 massive members.
        const nm = Math.min(cnt - made, Math.max(3, Math.round(rng.powerLaw(-2, 4, 160))));
        const cid = youngClusters++;
        let Rg: number;
        if (P.clumpiness > 0.5 && rng.next() < P.clumpiness * 0.7) {
          const c = clumps[rng.int(clumps.length)];
          const cx = c[0] * Math.cos(c[1]) + rng.normal(0, c[2] * 0.7);
          const cy = c[0] * Math.sin(c[1]) + rng.normal(0, c[2] * 0.7);
          Rg = Math.min(P.young.rOuter, Math.max(80, Math.hypot(cx, cy)));
        } else {
          Rg = sampleDiskRadius(rng, P.young.scaleLength, Math.max(P.young.rInner, 80), P.young.rOuter);
        }
        const masses: number[] = [];
        let tauMax = 0;
        for (let j = 0; j < nm; j++) {
          const m = sampleKroupa(rng.next(), 5, 90);
          masses.push(m);
          tauMax = Math.max(tauMax, msLifetime(m));
        }
        const Tc = tauMax * 1.12 + rng.range(4, 30);
        const off = rng.range(0, Tc);
        const scale = rng.range(3, 14) * Math.sqrt(nm / 20);
        for (let j = 0; j < nm; j++) {
          const m = masses[j];
          const tau = msLifetime(m);
          const L0 = msLuminosity(m);
          tmp[0] = Rg;
          tmp[1] = cid;
          tmp[2] = j;
          tmp[3] = m;
          tmp[4] = tau;
          tmp[5] = Tc;
          tmp[6] = off;
          tmp[7] = scale;
          put(KIND_YOUNG, tmp, msTemperature(m), L0);
          // Time-averaged light: ∫ L dt over the MS (L rises ~×1.4 on average) and supergiant phase.
          lumAvg += (L0 * (tau * 1.4 + 0.1 * tau * 1.6)) / Tc;
        }
        made += nm;
      }
      // Each particle stands for k stars of its mass (k ≥ 1, see youngMultiplicity); the rest of the
      // young light stays in the diffuse young component of the volume.
      const want = P.young.lum * PARTICLE_LIGHT.young;
      const k = lumAvg > 0 ? Math.max(1, Math.min(want / lumAvg, 200)) : 0;
      youngK = k;
      for (let i = start; i < start + made; i++) data[i * STRIDE + 10] *= k;
      populations.push({ name: 'young', kind: KIND_YOUNG, start, count: made, lum: lumAvg * k });
    }
  }

  // ——— Globular clusters ———
  let globularClusters = 0;
  let globulars = new Float32Array(0);
  {
    const cnt = count('globular');
    if (cnt) {
      const rng = root.fork('globular');
      const start = cursor;
      const nc = P.globulars.count;
      globulars = new Float32Array(nc * 4);
      // Globular cluster luminosity function: log-normal, peak M_V = −7.4, σ = 1.2 mag (Harris 2001).
      const Ls: number[] = [];
      let Lsum = 0;
      for (let c = 0; c < nc; c++) {
        const Mv = rng.normal(-7.4, 1.2);
        const L = Math.pow(10, -0.4 * (Mv - 4.83));
        Ls.push(L);
        Lsum += Math.pow(L, 0.7);
      }
      let made = 0;
      for (let c = 0; c < nc && made < cnt; c++) {
        const members = c === nc - 1 ? cnt - made : Math.max(10, Math.round((cnt * Math.pow(Ls[c], 0.7)) / Lsum));
        const nm = Math.min(members, cnt - made);
        let r0: number;
        do r0 = samplePowerHalo(rng, 400, P.globulars.rMax);
        while (rng.next() > Math.pow(r0 / (r0 + P.globulars.rCore), 1.2) && r0 < P.globulars.rCore * 3);
        const theta0 = rng.range(0, 2 * Math.PI);
        const ci = rng.range(-1, 1);
        const node = rng.range(0, 2 * Math.PI);
        globulars.set([r0, theta0, ci, node], c * 4);
        const rc = rng.logRange(0.4, 3);
        const conc = Math.pow(10, rng.range(1.2, 2.1));
        for (let j = 0; j < nm; j++) {
          tmp[0] = r0;
          tmp[1] = theta0;
          tmp[2] = ci;
          tmp[3] = node;
          tmp[4] = rc * sampleClusterRadius(rng.next(), conc);
          tmp[5] = rng.next();
          tmp[6] = rng.next();
          tmp[7] = c;
          const [T, w] = sampleClass(rng, CLASSES.halo);
          put(KIND_CLUSTER, tmp, T, w * (Ls[c] / Math.max(1, nm)));
        }
        made += nm;
        globularClusters++;
      }
      const lum = Ls.reduce((a, b) => a + b, 0);
      normalise(start, made, lum);
      populations.push({ name: 'globular', kind: KIND_CLUSTER, start, count: made, lum });
    }
  }

  const used = cursor;
  return {
    data: used * STRIDE === data.length ? data : data.slice(0, used * STRIDE),
    count: used,
    populations,
    youngClusters,
    youngMultiplicity: youngK,
    globularClusters,
    globulars,
  };
}

// ——— Kinematics (CPU mirror of shaders/stars.ts) ————————————————————————

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** Everything the kinematic model needs besides a particle's own parameters. */
export class Kinematics {
  readonly params: GalaxyParams;
  readonly potential: GalaxyPotential;
  readonly lutN = 512;
  readonly lutRmax: number;
  /** [Ω, κ, ν, v_c] rows (0 = with dark matter, 1 = baryons only). */
  readonly lut: Float32Array;
  arms: ArmSpec[] = [];
  live: GalaxyLive;
  // Derived uniforms.
  omegaP = 0;
  omegaB = 0;
  waveM = 0;
  waveCot = 0;
  wavePhase = 0;
  waveR0 = 1;

  constructor(params: GalaxyParams, live?: GalaxyLive) {
    this.params = params;
    this.potential = new GalaxyPotential(params.potential);
    this.lutRmax = Math.max(100000, params.halo.rMax * 1.2, params.globulars.rMax * 1.5);
    this.lut = this.potential.buildLUT(this.lutN, this.lutRmax);
    this.live = live ?? defaultLive(params);
    this.setLive(this.live);
  }

  setLive(live: GalaxyLive): void {
    this.live = live;
    const p = this.params;
    this.omegaP = radMyrFromKmsKpc(p.spiral.patternSpeed);
    this.omegaB = radMyrFromKmsKpc(p.bar.patternSpeed);
    this.waveM = live.arms;
    this.waveCot = 1 / Math.tan(Math.max(1, live.pitchDeg) * (Math.PI / 180));
    this.wavePhase = p.spiral.phase;
    this.waveR0 = p.spiral.r0;
    const armsOverride = p.spiral.armList ? (live.arms !== p.spiral.arms ? live.arms : undefined) : live.arms;
    const pitchOverride = live.pitchDeg !== p.spiral.pitchDeg ? live.pitchDeg : undefined;
    this.arms = buildArms(p, armsOverride, pitchOverride);
  }

  /** LUT sample (manual linear interpolation, matching the shader's texelFetch path). */
  lutAt(R: number, row: number, ch: number): number {
    const u = Math.sqrt(Math.min(Math.max(R / this.lutRmax, 0), 1)) * (this.lutN - 1);
    const i0 = Math.min(this.lutN - 2, Math.floor(u));
    const f = u - i0;
    const o = (row * this.lutN + i0) * 4 + ch;
    return this.lut[o] * (1 - f) + this.lut[o + 4] * f;
  }

  /** Density-wave orientation α(R): arms (density maxima) sit at φ = α − π/(2m) for trailing waves. */
  waveAlpha(R: number): number {
    const phiArm = this.wavePhase - Math.log(Math.max(R, 1) / this.waveR0) * this.waveCot;
    return phiArm + Math.PI / (2 * Math.max(1, this.waveM));
  }

  waveTaper(R: number): number {
    const p = this.params.spiral;
    return smoothstep(p.rInner * 0.75, p.rInner * 1.1, R) * (1 - smoothstep(p.rOuter * 0.8, p.rOuter * 1.05, R));
  }

  /** Warp of the outer disk (pc above the mid-plane) at model-frame (R, φ). */
  warpH(R: number, phi: number): number {
    const w = this.params.warp;
    if (w.amplitude === 0 || R <= w.rStart) return 0;
    const s = (R - w.rStart) / Math.max(1, 20000 - w.rStart);
    return w.amplitude * s * s * Math.sin(phi - w.nodeAngle);
  }

  /** Model frame (X, Y, H) → render frame (three.js, y-up). */
  toRender(X: number, Y: number, H: number, out: Vec3Like): Vec3Like {
    out.x = X;
    out.y = H;
    out.z = -this.params.spin * Y;
    return out;
  }

  /** Render frame → model (X, Y, H). */
  fromRender(x: number, y: number, z: number, out: Vec3Like): Vec3Like {
    out.x = x;
    out.y = -this.params.spin * z;
    out.z = y;
    return out;
  }

  /** Probability weight that a young cluster at R is born in arm k (0 outside its extent). */
  armWeight(a: ArmSpec, R: number): number {
    return a.strength * smoothstep(a.rStart, a.rStart * 1.15, R) * (1 - smoothstep(a.rEnd * 0.85, a.rEnd, R));
  }
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Result of evaluating a particle: render-frame position and its current light. */
export interface ParticleState {
  x: number;
  y: number;
  z: number;
  /** Current luminosity (L☉; 0 = dead or inactive). */
  lum: number;
  temperature: number;
}

/**
 * Position and light of particle `i` at time `t` (Myr) — the exact CPU mirror of the GPU
 * vertex shader. Model-frame math, float64.
 */
export function particleState(k: Kinematics, d: Float32Array, i: number, t: number, out: ParticleState): ParticleState {
  const o = i * STRIDE;
  const kind = d[o];
  const p1 = d[o + 1], p2 = d[o + 2], p3 = d[o + 3], p4 = d[o + 4];
  const p5 = d[o + 5], p6 = d[o + 6], p7 = d[o + 7], p8 = d[o + 8];
  let T = d[o + 9];
  let L = d[o + 10];
  let X = 0, Y = 0, H = 0;
  const P = k.params;

  if (kind === KIND_DISK) {
    const Rg = p1;
    const Om = k.lutAt(Rg, 0, 0), ka = k.lutAt(Rg, 0, 1), nu = k.lutAt(Rg, 0, 2);
    const phig = p2 + Om * t;
    let x = -p3 * Rg * Math.cos(ka * t + p4);
    let yph = ((2 * Om) / ka) * p3 * Rg * Math.sin(ka * t + p4);
    if (k.waveM > 0) {
      const A = P.spiral.amplitude * p7 * k.waveTaper(Rg);
      const th = k.waveM * (phig - k.omegaP * t - k.waveAlpha(Rg));
      x -= A * Rg * Math.cos(th);
      yph += ((2 * Om) / ka) * A * Rg * Math.sin(th);
    }
    const R = Rg + x;
    const phi = phig + yph / Rg;
    X = R * Math.cos(phi);
    Y = R * Math.sin(phi);
    H = p5 * Math.cos(nu * t + p6) + k.warpH(R, phi);
  } else if (kind === KIND_BAR) {
    const a = p1;
    const Om = k.lutAt(a, 0, 0), nu = k.lutAt(a, 0, 2);
    const th = p2 + (Om - k.omegaB) * t;
    const s = P.bar.strength * k.live.barStrength;
    const q = 1 + (p3 - 1) * s;
    const xb = a * Math.cos(th) + p7 * Math.cos(p8);
    const yb = a * q * Math.sin(th) + p7 * Math.sin(p8);
    H = p6 > 0.5 ? p4 * Math.cos(2 * th + p5) * (0.35 + 0.65 * s) : p4 * Math.cos(nu * t + p5);
    const ang = P.bar.angle + k.omegaB * t;
    const c = Math.cos(ang), sn = Math.sin(ang);
    X = xb * c - yb * sn;
    Y = xb * sn + yb * c;
  } else if (kind === KIND_SPHEROID || kind === KIND_CLUSTER) {
    const r0 = p1;
    const Om = k.lutAt(r0, 0, 0), ka = k.lutAt(r0, 0, 1);
    const eR = kind === KIND_SPHEROID ? p5 : 0.08;
    const psi = kind === KIND_SPHEROID ? p6 : p2 * 3.1;
    const ph = ka * t + psi;
    const th = p2 + Om * t + ((2 * Om) / ka) * eR * Math.sin(ph);
    const r = r0 * (1 - eR * Math.cos(ph));
    const ci = p3, si = Math.sqrt(Math.max(0, 1 - ci * ci));
    const cn = Math.cos(p4), sn = Math.sin(p4);
    const ct = Math.cos(th), st = Math.sin(th);
    X = r * (ct * cn - st * sn * ci);
    Y = r * (ct * sn + st * cn * ci);
    H = r * st * si;
    if (kind === KIND_SPHEROID) H *= p7;
    else {
      // Member offset (King profile) — static in the cluster frame.
      const cz = 2 * p6 - 1;
      const sz = Math.sqrt(Math.max(0, 1 - cz * cz));
      const az = 2 * Math.PI * p7;
      X += p5 * sz * Math.cos(az);
      Y += p5 * sz * Math.sin(az);
      H += p5 * cz;
    }
  } else if (kind === KIND_YOUNG) {
    const st = youngState(k, p1, p2, p3, p4, p5, p6, p7, p8, T, L, t);
    X = st.X;
    Y = st.Y;
    H = st.H;
    T = st.T;
    L = st.L;
  }
  k.toRender(X, Y, H, out);
  out.lum = L;
  out.temperature = T;
  return out;
}

const youngTmp = { X: 0, Y: 0, H: 0, T: 0, L: 0 };

/**
 * An OB association's life cycle. Cycle n starts at t_n = n·T_c − offset; the cluster is born in
 * a spiral arm at the pattern's position then, drifts with the gas at Ω(R) (young stars stream
 * out of the arm, downstream of the dust lane), expands at a few km/s, and its stars die on
 * their main-sequence lifetimes (the last 10% as supergiants).
 */
export function youngState(
  k: Kinematics,
  Rg: number,
  cidF: number,
  midF: number,
  mass: number,
  tau: number,
  Tc: number,
  off: number,
  scale: number,
  T0: number,
  L0: number,
  t: number,
): typeof youngTmp {
  const P = k.params;
  const cid = cidF | 0;
  const mid = midF | 0;
  const tt = t + off;
  const n = Math.floor(tt / Tc);
  const age = tt - n * Tc;
  const tb = t - age;
  let h = hash2u(cid, n | 0);
  // Star-formation switch: the fraction of clusters forming this cycle follows the live SFR.
  const active = u01(hash2u(cid, 0x51ab)) < Math.min(1, P.young.sfr * k.live.sfr) ? 1 : 0;
  const bright = Math.max(1, P.young.sfr * k.live.sfr);

  // Birth azimuth in the pattern frame.
  const OmG = k.lutAt(Rg, 0, 0);
  let wsum = 0;
  for (const a of k.arms) wsum += k.armWeight(a, Rg);
  h = next(h);
  const uArm = u01(h);
  h = next(h);
  const uPick = u01(h);
  h = next(h);
  const uJit = u01(h);
  h = next(h);
  const uJit2 = u01(h);
  let phiB: number;
  const inArm = wsum > 1e-4 && uArm < P.young.armFraction * Math.min(1, wsum * 1.5);
  if (inArm) {
    let acc = 0;
    let chosen = k.arms[0];
    const target = uPick * wsum;
    for (const a of k.arms) {
      acc += k.armWeight(a, Rg);
      chosen = a;
      if (acc >= target) break;
    }
    const sinI = Math.sin(chosen.pitchDeg * (Math.PI / 180));
    const dir = OmG >= k.omegaP ? 1 : -1; // downstream of the shock
    const g = Math.sqrt(-2 * Math.log(Math.max(1e-7, uJit))) * Math.cos(2 * Math.PI * uJit2);
    phiB = armPhi(chosen, Rg) + (chosen.width / sinI) * (dir * 0.45 + 0.55 * g);
  } else {
    phiB = uPick * 2 * Math.PI;
  }
  phiB += k.omegaP * tb;

  // Member offset: a random direction, radius growing with age (unbound association).
  let hm = hash3u(cid, mid, n | 0);
  const cz = 2 * u01(hm) - 1;
  hm = next(hm);
  const az = 2 * Math.PI * u01(hm);
  hm = next(hm);
  const rr = Math.cbrt(u01(hm));
  hm = next(hm);
  const vexp = 1.2 + 3.5 * u01(hm);
  // The association's birth height is shared by all its members (it oscillates as one).
  const hb = (u01(next(h)) - 0.5) * 2 * P.young.scaleHeight;
  const sz = Math.sqrt(Math.max(0, 1 - cz * cz));
  const rad = scale * (0.2 + 0.8 * rr) + vexp * age;
  const dR = rad * sz * Math.cos(az);
  const dT = rad * sz * Math.sin(az);
  const dH = rad * cz * 0.6;
  const Rm = Math.max(30, Rg + dR);
  const Om = k.lutAt(Rm, 0, 0);
  const nu = k.lutAt(Rg, 0, 2);
  const phi = phiB + dT / Rg + Om * age;
  youngTmp.X = Rm * Math.cos(phi);
  youngTmp.Y = Rm * Math.sin(phi);
  youngTmp.H = hb * Math.cos(nu * age) + dH + k.warpH(Rm, phi);

  // Light: main sequence (brightening ×1.8, cooling slightly), then a supergiant phase.
  const x = age / tau;
  let T = T0;
  let L = 0;
  if (x < 1) {
    L = L0 * (1 + 0.8 * x);
    T = T0 * (1 - 0.18 * x);
  } else if (x < 1.1) {
    const red = mass < 35;
    L = L0 * 1.6;
    T = red ? 3650 + 500 * u01(hash2u(cid, mid + 99)) : T0 * 0.75;
  }
  youngTmp.L = L * active * bright;
  youngTmp.T = T;
  return youngTmp;
}

/** Wrap helper re-export for consumers. */
export { wrapPi };
