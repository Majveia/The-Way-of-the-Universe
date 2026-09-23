/**
 * The cosmic-web N-body run: 2LPT initial conditions → FastPM particle-mesh steps → keyframes
 * with friends-of-friends halos, a galaxy population and the measured power spectrum.
 * Pure computation (no DOM, no three.js) so it runs in a Web Worker or on the main thread.
 */
import { Expansion, fastpmDrift, fastpmKick } from '../../physics/cosmosExpansion';
import { LinearPower, RHO_CRIT_H2 } from '../../physics/cosmosPower';
import { GaussianField, LATTICE_OFFSET, lptDisplacements, measurePower } from '../../physics/cosmosIC';
import { ParticleMesh } from '../../physics/cosmosPM';
import { friendsOfFriends, type FoFResult } from '../../physics/cosmosFoF';
import { centralQuenchedFraction, mergingTime, r200c, satelliteQuenched, stellarMass } from '../../physics/cosmosGalaxies';
import { hash01 } from '../../physics/random';
import type { CosmoParams, GalaxyCatalog, HaloCatalog, Keyframe, SimConfig, SimInfo, WorkerMessage } from './types';

export function makeExpansion(c: CosmoParams): Expansion {
  return new Expansion({ H0: 100 * c.h, Om0: c.Om0, Ode0: c.Ode0 }, { tMax: 8 });
}

export function makeLinearPower(c: CosmoParams, e: Expansion): LinearPower {
  const Ob0 = Math.min(c.Ob0, 0.45 * c.Om0);
  return c.norm === 'sigma8'
    ? new LinearPower({ h: c.h, Om0: c.Om0, Ob0, ns: c.ns, wiggles: c.wiggles, sigma8: c.sigma8 })
    : new LinearPower({ h: c.h, Om0: c.Om0, Ob0, ns: c.ns, wiggles: c.wiggles, As: c.As, growthMD: e.growthMDToday });
}

export interface Schedule {
  /** Step boundary times (H0 units), length steps+1. */
  t: number[];
  a: number[];
  /** Kick/drift midpoint per step (length steps). */
  half: number[];
  key: boolean[];
  /** Index of the step boundary at a = 1. */
  today: number;
}

/**
 * Time steps: log-spaced in a from aInit to 0.1 (where growth is fastest in log time), linear in
 * a to today (a = 1, always a step boundary), then either on to aFuture (ever-expanding) or up to
 * turnaround and uniformly in time into the collapse (recollapsing universes).
 */
export function buildSchedule(e: Expansion, cfg: SimConfig): Schedule {
  const aList: number[] = [];
  const t: number[] = [];
  const aMid = 0.1;
  for (let i = 0; i <= cfg.stepsEarly; i++) aList.push(cfg.aInit * Math.pow(aMid / cfg.aInit, i / cfg.stepsEarly));
  for (let i = 1; i <= cfg.stepsMain; i++) aList.push(aMid + ((1 - aMid) * i) / cfg.stepsMain);
  const today = aList.length - 1;
  for (const a of aList) t.push(e.timeOfA(a));
  const half: number[] = [];
  for (let i = 0; i + 1 < aList.length; i++) half.push(e.timeOfA(0.5 * (aList[i] + aList[i + 1])));
  if (!e.recollapses) {
    const aEnd = Math.max(1.05, cfg.aFuture);
    for (let i = 1; i <= cfg.stepsFuture; i++) {
      const a = 1 + ((aEnd - 1) * i) / cfg.stepsFuture;
      const tt = e.timeOfA(a);
      if (!isFinite(tt) || tt > e.tEnd) break;
      half.push(e.timeOfA(0.5 * (aList[aList.length - 1] + a)));
      aList.push(a);
      t.push(tt);
    }
  } else {
    // Expand to just short of the maximum, then march in time through the turnaround and collapse.
    const aTop = e.aMax;
    const nUp = Math.max(1, Math.round(cfg.stepsFuture * Math.min(1, (aTop - 1) / 1.5)));
    const aUp = 1 + (aTop - 1) * 0.985;
    if (aUp > 1.0005) {
      for (let i = 1; i <= nUp; i++) {
        const a = 1 + ((aUp - 1) * i) / nUp;
        half.push(e.timeOfA(0.5 * (aList[aList.length - 1] + a)));
        aList.push(a);
        t.push(e.timeOfA(a));
      }
    }
    // End of the run: a falls back to ~40 % of its maximum (the crunch follows quickly after).
    let lo = e.tTurn, hi = Math.min(e.tCrunch, e.tEnd);
    for (let k = 0; k < 80; k++) {
      const m = 0.5 * (lo + hi);
      if (e.aAt(m) > 0.4 * aTop) lo = m;
      else hi = m;
    }
    const tStart = t[t.length - 1];
    const tStop = lo;
    for (let i = 1; i <= cfg.stepsCollapse; i++) {
      const tt = tStart + ((tStop - tStart) * i) / cfg.stepsCollapse;
      half.push(0.5 * (t[t.length - 1] + tt));
      t.push(tt);
      aList.push(e.aAt(tt));
    }
  }
  const key = t.map((_, i) => i === 0 || i === today || i === t.length - 1 || i % cfg.keyEvery === 0);
  return { t, a: aList, half, key, today };
}

interface Gal {
  id: number;
  host: number;
  mPeak: number;
  mStar: number;
  central: boolean;
  tInfall: number;
  born: number;
  q: number;
  alive: boolean;
  /** Halo index in the latest catalog, −1 if none. */
  halo: number;
}

export type Emit = (msg: WorkerMessage, transfer?: ArrayBuffer[]) => void;

/**
 * One simulation run. `run()` drives the whole thing; `yieldFn` (if given) is awaited between
 * phases so a main-thread fallback can keep the page responsive.
 */
export class Simulation {
  readonly cfg: SimConfig;
  readonly e: Expansion;
  readonly lp: LinearPower;
  readonly schedule: Schedule;
  private cancelled = false;
  private readonly emit: Emit;
  private readonly runId: number;

  constructor(cfg: SimConfig, emit: Emit, runId = 0) {
    this.cfg = cfg;
    this.emit = emit;
    this.runId = runId;
    this.e = makeExpansion(cfg.cosmo);
    if (!this.e.bigBang) throw new Error('These parameters have no Big Bang: the universe would bounce before reaching today.');
    this.lp = makeLinearPower(cfg.cosmo, this.e);
    this.schedule = buildSchedule(this.e, cfg);
  }

  cancel(): void {
    this.cancelled = true;
  }

  async run(yieldFn?: () => Promise<void>): Promise<void> {
    const T0 = performance.now();
    const { cfg, e, lp, schedule } = this;
    const pause = async () => {
      if (yieldFn) await yieldFn();
    };
    const np = cfg.np, nm = cfg.nm, N = np * np * np;
    const cell = cfg.box / nm; // h⁻¹ Mpc per mesh cell
    const progress = (fraction: number, label: string) => this.emit({ type: 'progress', runId: this.runId, fraction, label });

    // ——— Initial conditions ———
    progress(0.02, 'Seeding primordial fluctuations');
    await pause();
    const field = new GaussianField({ n: nm, box: cfg.box, seed: cfg.seed, power: (k) => lp.P(k) });
    await pause();
    const smoothingR = 1.25 * (cfg.box / np);
    const lpt = lptDisplacements(field, np, {
      smoothing: smoothingR,
      progress: (f, label) => progress(0.05 + 0.85 * f, label),
    });
    await pause();
    if (this.cancelled) return;
    const pos = new Float32Array(3 * N);
    const mom = new Float32Array(3 * N);
    const t0 = schedule.t[0];
    const a0 = e.aAt(t0), ad0 = e.adotAt(t0);
    const D1 = e.DAt(t0), D2 = e.D2At(t0), f1 = e.fAt(t0), f2 = e.f2At(t0);
    const ratio = nm / np;
    const inv = 1 / cell;
    let p = 0;
    for (let i = 0; i < np; i++)
      for (let j = 0; j < np; j++)
        for (let k = 0; k < np; k++, p++) {
          const q = [i * ratio + LATTICE_OFFSET, j * ratio + LATTICE_OFFSET, k * ratio + LATTICE_OFFSET];
          for (let c = 0; c < 3; c++) {
            const s1 = lpt.psi1[3 * p + c] * inv, s2 = lpt.psi2[3 * p + c] * inv;
            let x = q[c] + D1 * s1 + D2 * s2;
            x -= nm * Math.floor(x / nm);
            if (x >= nm) x = 0;
            pos[3 * p + c] = x;
            mom[3 * p + c] = a0 * ad0 * (f1 * D1 * s1 + f2 * D2 * s2);
          }
        }
    const deltaL = new Int8Array(N);
    for (let i = 0; i < N; i++) deltaL[i] = Math.max(-127, Math.min(127, Math.round((lpt.deltaL[i] / lpt.sigmaL) * 32)));
    const mp = (cfg.cosmo.Om0 * RHO_CRIT_H2 * cfg.box ** 3) / N / cfg.cosmo.h; // M☉
    const info: SimInfo = {
      np,
      nm,
      count: N,
      box: cfg.box,
      particleMass: mp,
      stepT: Float64Array.from(schedule.t),
      stepA: Float64Array.from(schedule.a),
      keyStep: Uint8Array.from(schedule.key, (b) => (b ? 1 : 0)),
      deltaL,
      sigmaL: lpt.sigmaL,
      smoothingR,
      psiRms: lpt.psiRms,
      sigma8: lp.sigma8(),
      sigmaMin2: lp.sigmaM(1e8 * cfg.cosmo.h) ** 2,
      sigmaR2: lp.sigmaR(smoothingR, 'gauss') ** 2,
    };
    this.emit({ type: 'info', runId: this.runId, info }, [info.deltaL.buffer as ArrayBuffer]);

    const pm = new ParticleMesh(nm, { deconvolve: cfg.deconvolve });
    const dens = new Float32Array(N);
    pm.deposit(pos, N);
    pm.densityAt(pos, N, dens);
    pm.solve();
    progress(1, 'Initial conditions ready');
    const gals = new GalaxyBook(N);
    let keyIndex = 0;
    this.emitKeyframe(keyIndex++, 0, pos, mom, dens, pm, gals, 0);
    await pause();

    // ——— FastPM kick–drift–kick ———
    const steps = schedule.t.length - 1;
    let stepAcc = 0, stepCount = 0;
    for (let i = 0; i < steps; i++) {
      if (this.cancelled) return;
      const ts = performance.now();
      const ta = schedule.t[i], tb = schedule.t[i + 1], th = schedule.half[i];
      pm.kick(pos, mom, N, fastpmKick(e, ta, th, ta));
      pm.drift(pos, mom, N, fastpmDrift(e, ta, tb, th));
      pm.deposit(pos, N);
      const key = schedule.key[i + 1];
      if (key) pm.densityAt(pos, N, dens);
      pm.solve();
      pm.kick(pos, mom, N, fastpmKick(e, th, tb, tb));
      stepAcc += performance.now() - ts;
      stepCount++;
      if (key) {
        this.emitKeyframe(keyIndex++, i + 1, pos, mom, dens, pm, gals, stepAcc / stepCount);
        stepAcc = 0;
        stepCount = 0;
      }
      await pause();
    }
    this.emit({ type: 'done', runId: this.runId, ms: performance.now() - T0 });
  }

  private emitKeyframe(
    index: number,
    step: number,
    pos: Float32Array,
    mom: Float32Array,
    dens: Float32Array,
    pm: ParticleMesh,
    gals: GalaxyBook,
    stepMs: number,
  ): void {
    const { cfg, e, lp, schedule } = this;
    const nm = cfg.nm, np = cfg.np, N = np * np * np;
    const t = schedule.t[step];
    const a = e.aAt(t);
    const D = e.DAt(t);
    const z = 1 / a - 1;
    const positions = new Uint16Array(3 * N);
    const s = 65536 / nm;
    for (let i = 0; i < 3 * N; i++) positions[i] = Math.round(pos[i] * s) & 0xffff;

    // Halos and galaxies.
    let halos: HaloCatalog = emptyHalos();
    let fofMs = 0;
    if (z <= cfg.zHalos) {
      const tf = performance.now();
      const found = this.findHalos(pos, mom, dens, t, a);
      halos = found.halos;
      gals.update(halos, found.fof, t, a, this.e);
      fofMs = performance.now() - tf;
    }
    const galaxies = gals.catalog(halos);

    // Power spectrum of the evolved field vs linear theory.
    // No shot-noise subtraction: a perturbed lattice carries almost none (unlike a Poisson sample).
    const m = measurePower(pm.deltaRe, pm.deltaIm, nm, cfg.box, 22, { window2: ParticleMesh.cicWindow2(nm) });
    const pk = { k: new Float32Array(m.k), P: new Float32Array(m.P), Plin: new Float32Array(m.k.length) };
    for (let i = 0; i < m.k.length; i++) pk.Plin[i] = D * D * lp.P(m.k[i]);

    // Deepest voids in the density smoothed on ~6 h⁻¹ Mpc.
    const voids = z < 3 ? this.findVoids(pm) : new Float32Array(0);

    const kf: Keyframe = {
      index,
      step,
      t,
      a,
      D,
      positions,
      halos,
      galaxies,
      pk,
      stats: { stepMs, fofMs, maxHaloMass: halos.count ? halos.mass[0] : 0, sigma8a: D * lp.sigma8(), voids },
    };
    const transfer: ArrayBuffer[] = [positions.buffer as ArrayBuffer];
    for (const arr of [halos.host, halos.mass, halos.r200, halos.sigma, halos.npart, halos.center, halos.ngal, halos.vel,
      galaxies.id, galaxies.host, galaxies.mstar, galaxies.blue, galaxies.sat, galaxies.halo, galaxies.born, pk.k, pk.P, pk.Plin, voids])
      transfer.push(arr.buffer as ArrayBuffer);
    this.emit({ type: 'keyframe', runId: this.runId, keyframe: kf }, transfer);
  }

  /** Friends-of-friends halos with centres, velocity dispersions and virial radii. */
  private findHalos(pos: Float32Array, mom: Float32Array, dens: Float32Array, t: number, a: number): { halos: HaloCatalog; fof: FoFResult } {
    const { cfg, e } = this;
    const np = cfg.np, nm = cfg.nm, N = np * np * np;
    // Candidates: anything denser than ~1.6× the mean on the mesh scale.
    let M = 0;
    const cand = new Uint32Array(N);
    for (let i = 0; i < N; i++) if (dens[i] >= 1.6) cand[M++] = i;
    const link = cfg.fofB * (nm / np);
    const fof = friendsOfFriends(pos, cand, M, nm, link, cfg.fofMin);
    const G = fof.groups;
    const out: HaloCatalog = {
      count: G,
      host: new Uint32Array(G),
      mass: new Float32Array(G),
      r200: new Float32Array(G),
      sigma: new Float32Array(G),
      npart: new Uint32Array(G),
      center: new Float32Array(3 * G),
      ngal: new Uint16Array(G),
      vel: new Float32Array(3 * G),
    };
    const mp = (cfg.cosmo.Om0 * RHO_CRIT_H2 * cfg.box ** 3) / N / cfg.cosmo.h;
    const Hkms = e.HAt(t) * 100 * cfg.cosmo.h;
    const vconv = (100 * (cfg.box / nm)) / a; // p (cells·H0) → peculiar km/s
    const half = nm / 2;
    for (let g = 0; g < G; g++) {
      const s0 = fof.groupStart[g], s1 = fof.groupStart[g + 1];
      const n = s1 - s0;
      let best = fof.members[s0], bd = -1;
      for (let s = s0; s < s1; s++) {
        const pi = fof.members[s];
        if (dens[pi] > bd) {
          bd = dens[pi];
          best = pi;
        }
      }
      const hx = pos[3 * best], hy = pos[3 * best + 1], hz = pos[3 * best + 2];
      let cx = 0, cy = 0, cz = 0, vx = 0, vy = 0, vz = 0;
      for (let s = s0; s < s1; s++) {
        const pi = fof.members[s];
        let dx = pos[3 * pi] - hx, dy = pos[3 * pi + 1] - hy, dz = pos[3 * pi + 2] - hz;
        if (dx > half) dx -= nm; else if (dx < -half) dx += nm;
        if (dy > half) dy -= nm; else if (dy < -half) dy += nm;
        if (dz > half) dz -= nm; else if (dz < -half) dz += nm;
        cx += dx; cy += dy; cz += dz;
        vx += mom[3 * pi]; vy += mom[3 * pi + 1]; vz += mom[3 * pi + 2];
      }
      cx = hx + cx / n; cy = hy + cy / n; cz = hz + cz / n;
      vx /= n; vy /= n; vz /= n;
      let s2 = 0;
      for (let s = s0; s < s1; s++) {
        const pi = fof.members[s];
        const ux = mom[3 * pi] - vx, uy = mom[3 * pi + 1] - vy, uz = mom[3 * pi + 2] - vz;
        s2 += ux * ux + uy * uy + uz * uz;
      }
      const mass = n * mp;
      out.host[g] = best;
      out.mass[g] = mass;
      out.npart[g] = n;
      out.r200[g] = r200c(mass, Hkms);
      out.sigma[g] = Math.sqrt(s2 / (3 * n)) * vconv;
      const wrap = (v: number) => ((v % nm) + nm) % nm / nm;
      out.center[3 * g] = wrap(cx);
      out.center[3 * g + 1] = wrap(cy);
      out.center[3 * g + 2] = wrap(cz);
      out.vel[3 * g] = vx * vconv;
      out.vel[3 * g + 1] = vy * vconv;
      out.vel[3 * g + 2] = vz * vconv;
    }
    return { halos: out, fof };
  }

  /** Smooth δ(k) with a Gaussian (R ≈ 6 h⁻¹ Mpc) and return the three deepest, well-separated minima. */
  private findVoids(pm: ParticleMesh): Float32Array {
    const nm = pm.n, nzc = pm.fft.nzc, half = nm >> 1;
    const R = 6 / (this.cfg.box / nm); // cells
    const w = (2 * Math.PI) / nm;
    for (let ix = 0; ix < nm; ix++) {
      const fx = ix < half ? ix : ix - nm;
      for (let iy = 0; iy < nm; iy++) {
        const fy = iy < half ? iy : iy - nm;
        for (let iz = 0; iz < nzc; iz++) {
          const idx = (ix * nm + iy) * nzc + iz;
          const k2 = (fx * fx + fy * fy + iz * iz) * w * w;
          const g = ix === half || iy === half || iz === half ? 0 : Math.exp(-0.5 * k2 * R * R);
          pm.fft.re[idx] = pm.deltaRe[idx] * g;
          pm.fft.im[idx] = pm.deltaIm[idx] * g;
        }
      }
    }
    pm.fft.inverse(pm.grid);
    const g = pm.grid;
    const found: number[] = [];
    const sep2 = (2.5 * R) ** 2;
    for (let pass = 0; pass < 3; pass++) {
      let best = -1, bv = Infinity;
      for (let i = 0; i < g.length; i++) {
        if (g[i] >= bv) continue;
        const x = i >> (2 * Math.log2(nm)), y = (i >> Math.log2(nm)) & (nm - 1), z = i & (nm - 1);
        let ok = true;
        for (let f = 0; f < found.length; f += 4) {
          let dx = Math.abs(x - found[f] * nm), dy = Math.abs(y - found[f + 1] * nm), dz = Math.abs(z - found[f + 2] * nm);
          dx = Math.min(dx, nm - dx); dy = Math.min(dy, nm - dy); dz = Math.min(dz, nm - dz);
          if (dx * dx + dy * dy + dz * dz < sep2) { ok = false; break; }
        }
        if (!ok) continue;
        bv = g[i];
        best = i;
      }
      if (best < 0) break;
      const x = best >> (2 * Math.log2(nm)), y = (best >> Math.log2(nm)) & (nm - 1), z = best & (nm - 1);
      found.push((x + 0.5) / nm, (y + 0.5) / nm, (z + 0.5) / nm, 1 + bv);
    }
    return Float32Array.from(found);
  }
}

function emptyHalos(): HaloCatalog {
  return {
    count: 0,
    host: new Uint32Array(0),
    mass: new Float32Array(0),
    r200: new Float32Array(0),
    sigma: new Float32Array(0),
    npart: new Uint32Array(0),
    center: new Float32Array(0),
    ngal: new Uint16Array(0),
    vel: new Float32Array(0),
  };
}

/**
 * Persistent galaxy population riding on simulation particles. Each FoF halo hosts a central
 * galaxy on its densest particle; when halos merge, the smaller centrals become satellites that
 * keep orbiting on their own particle, quench after a delay and eventually merge by dynamical
 * friction. Stellar masses follow the Moster et al. (2013) relation at the halo's peak mass.
 */
class GalaxyBook {
  private list: Gal[] = [];
  private byParticle: Int32Array;
  private nextId = 1;
  private tNow = 0;
  private zNow = 99;

  constructor(N: number) {
    this.byParticle = new Int32Array(N).fill(-1);
  }

  update(halos: HaloCatalog, fof: FoFResult, t: number, a: number, e: Expansion): void {
    const z = 1 / a - 1;
    const tGyr = e.toGyr(t);
    const tDyn = e.toGyr(0.1 / Math.max(Math.abs(e.HAt(t)), 1e-3));
    for (const g of this.list) g.halo = -1;
    for (let g = 0; g < halos.count; g++) {
      const s0 = fof.groupStart[g], s1 = fof.groupStart[g + 1];
      const mass = halos.mass[g];
      const here: number[] = [];
      for (let s = s0; s < s1; s++) {
        const gi = this.byParticle[fof.members[s]];
        if (gi >= 0 && this.list[gi].alive) here.push(gi);
      }
      if (here.length === 0) {
        const gal: Gal = {
          id: this.nextId,
          host: halos.host[g],
          mPeak: mass,
          mStar: stellarMass(mass, z),
          central: true,
          tInfall: -1,
          born: t,
          q: hash01(this.nextId, 7331),
          alive: true,
          halo: g,
        };
        this.nextId++;
        this.list.push(gal);
        this.byParticle[gal.host] = this.list.length - 1;
        continue;
      }
      // The most massive progenitor keeps the centre; the others become (or stay) satellites.
      let ci = here[0];
      for (const gi of here) if (this.list[gi].mPeak > this.list[ci].mPeak) ci = gi;
      const central = this.list[ci];
      for (const gi of here) {
        const gal = this.list[gi];
        gal.halo = g;
        if (gi === ci) continue;
        if (gal.central) {
          gal.central = false;
          gal.tInfall = tGyr;
        }
        if (tGyr - gal.tInfall > mergingTime(mass / Math.max(gal.mPeak, 1), tDyn)) {
          gal.alive = false;
          this.byParticle[gal.host] = -1;
          central.mStar += gal.mStar;
        }
      }
      central.central = true;
      central.tInfall = -1;
      central.mPeak = Math.max(central.mPeak, mass);
      central.mStar = Math.max(central.mStar, stellarMass(central.mPeak, z));
      // Keep the central galaxy on the halo's densest particle (the bottom of the potential well).
      const target = halos.host[g];
      if (central.host !== target && this.byParticle[target] < 0) {
        this.byParticle[central.host] = -1;
        central.host = target;
        this.byParticle[target] = ci;
      }
    }
    // Compact the list when many galaxies have merged away.
    let dead = 0;
    for (const g of this.list) if (!g.alive) dead++;
    if (dead > 64 && dead > this.list.length / 3) {
      this.list = this.list.filter((g) => g.alive);
      this.byParticle.fill(-1);
      this.list.forEach((g, i) => (this.byParticle[g.host] = i));
    }
    this.tNow = tGyr;
    this.zNow = z;
  }

  catalog(halos: HaloCatalog): GalaxyCatalog {
    const alive = this.list.filter((g) => g.alive);
    const n = alive.length;
    const out: GalaxyCatalog = {
      count: n,
      id: new Uint32Array(n),
      host: new Uint32Array(n),
      mstar: new Float32Array(n),
      blue: new Float32Array(n),
      sat: new Uint8Array(n),
      halo: new Int32Array(n),
      born: new Float32Array(n),
    };
    alive.forEach((g, i) => {
      out.id[i] = g.id;
      out.host[i] = g.host;
      out.mstar[i] = g.mStar;
      out.sat[i] = g.central ? 0 : 1;
      out.born[i] = g.born;
      const quenched = g.central
        ? g.q < centralQuenchedFraction(g.mPeak, this.zNow) ? 1 : 0
        : satelliteQuenched(this.tNow - g.tInfall);
      out.blue[i] = 1 - quenched;
      const h = g.halo < halos.count ? g.halo : -1;
      out.halo[i] = h;
      if (h >= 0) halos.ngal[h] = Math.min(65535, halos.ngal[h] + 1);
    });
    return out;
  }
}
