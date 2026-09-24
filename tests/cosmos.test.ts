/**
 * Cosmic Web (module: cosmos) — physics and pure-logic tests.
 * FFT round trips, the Eisenstein & Hu spectrum, Gaussian initial conditions, the expansion
 * history, FastPM linear growth through the whole particle-mesh pipeline, friends-of-friends,
 * the keyframe codec and the galaxy relations.
 */
import { describe, expect, it } from 'vitest';
import { FFT, RealFFT3D, fft1d, fft3dComplex } from '../src/physics/cosmosFFT';
import { EisensteinHu, LinearPower, collapsedFraction, erfc, topHatW } from '../src/physics/cosmosPower';
import { GaussianField, lptDisplacements, measurePower } from '../src/physics/cosmosIC';
import { Expansion, fastpmDrift, fastpmKick } from '../src/physics/cosmosExpansion';
import { ParticleMesh } from '../src/physics/cosmosPM';
import { friendsOfFriends } from '../src/physics/cosmosFoF';
import { cosmicSFRD, r200c, stellarMass, v200 } from '../src/physics/cosmosGalaxies';
import { Cosmology } from '../src/physics/cosmology';
import { Rng } from '../src/physics/random';
import { Simulation, buildSchedule, makeExpansion } from '../src/worlds/cosmicweb/Simulation';
import { SnapshotStore } from '../src/worlds/cosmicweb/SnapshotStore';
import { PLANCK_COSMO, type Keyframe, type SimConfig, type WorkerMessage } from '../src/worlds/cosmicweb/types';
import { CosmicTimeline } from '../src/experiences/cosmos/timeline';
import { projectHalos } from '../src/worlds/cosmicweb/webCache';

const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);
const mulberry32 = (seed: number) => {
  const r = new Rng(seed);
  return () => r.next();
};

describe('FFT', () => {
  it('1D transform matches a direct DFT and round-trips', () => {
    const n = 16;
    const rnd = mulberry32(1);
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      re[i] = rnd() - 0.5;
      im[i] = rnd() - 0.5;
    }
    const r0 = re.slice(), i0 = im.slice();
    fft1d(re, im);
    for (let k = 0; k < n; k++) {
      let sr = 0, si = 0;
      for (let j = 0; j < n; j++) {
        const ph = (-2 * Math.PI * j * k) / n;
        sr += r0[j] * Math.cos(ph) - i0[j] * Math.sin(ph);
        si += r0[j] * Math.sin(ph) + i0[j] * Math.cos(ph);
      }
      expect(re[k]).toBeCloseTo(sr, 10);
      expect(im[k]).toBeCloseTo(si, 10);
    }
    fft1d(re, im, true);
    for (let i = 0; i < n; i++) {
      expect(re[i]).toBeCloseTo(r0[i], 12);
      expect(im[i]).toBeCloseTo(i0[i], 12);
    }
  });

  it('rejects non-power-of-two sizes', () => {
    expect(() => new FFT(12)).toThrow();
  });

  it('3D real-to-complex transform agrees with the full complex transform and round-trips', () => {
    const n = 16;
    const rnd = mulberry32(7);
    const N = n * n * n;
    const x = new Float64Array(N);
    for (let i = 0; i < N; i++) x[i] = rnd() * 2 - 1;
    const re = x.slice(), im = new Float64Array(N);
    fft3dComplex(re, im, n);
    const r = new RealFFT3D(n);
    r.forward(x);
    const nzc = r.nzc;
    let maxErr = 0;
    for (let ix = 0; ix < n; ix++)
      for (let iy = 0; iy < n; iy++)
        for (let iz = 0; iz < nzc; iz++) {
          const a = (ix * n + iy) * nzc + iz, b = (ix * n + iy) * n + iz;
          maxErr = Math.max(maxErr, Math.abs(r.re[a] - re[b]), Math.abs(r.im[a] - im[b]));
        }
    expect(maxErr).toBeLessThan(1e-9);
    const back = new Float64Array(N);
    r.inverse(back);
    let err = 0;
    for (let i = 0; i < N; i++) err = Math.max(err, Math.abs(back[i] - x[i]));
    expect(err).toBeLessThan(1e-12);
  });
});

describe('Linear power spectrum (Eisenstein & Hu 1998)', () => {
  const lp = new LinearPower({ h: 0.6766, Om0: 0.30966, Ob0: 0.04897, ns: 0.9665, sigma8: 0.8102 });

  it('transfer function → 1 on large scales and falls on small scales', () => {
    const eh = lp.eh;
    expect(eh.transfer(1e-5)).toBeCloseTo(1, 3);
    expect(eh.transfer(1)).toBeLessThan(0.02);
    expect(eh.transferNoWiggle(1e-5)).toBeCloseTo(1, 3);
  });

  it('sound horizon at the drag epoch ≈ 147–152 Mpc for Planck 2018', () => {
    expect(lp.eh.s).toBeGreaterThan(145);
    expect(lp.eh.s).toBeLessThan(155);
  });

  it('is normalised to σ8 and shows baryon acoustic wiggles', () => {
    expect(lp.sigma8()).toBeCloseTo(0.8102, 4);
    const nw = new LinearPower({ h: 0.6766, Om0: 0.30966, Ob0: 0.04897, ns: 0.9665, sigma8: 0.8102, wiggles: false });
    // Ratio to the no-wiggle spectrum oscillates around 1 with a few per cent amplitude.
    let lo = Infinity, hi = -Infinity, signChanges = 0, prev = 0;
    for (let k = 0.05; k < 0.3; k += 0.002) {
      const q = lp.P(k) / nw.P(k) - 1;
      lo = Math.min(lo, q);
      hi = Math.max(hi, q);
      if (prev !== 0 && Math.sign(q) !== Math.sign(prev)) signChanges++;
      prev = q;
    }
    expect(hi - lo).toBeGreaterThan(0.04);
    expect(signChanges).toBeGreaterThanOrEqual(4);
  });

  it('A_s normalisation reproduces Planck σ8 within 2 %', () => {
    const e = makeExpansion(PLANCK_COSMO);
    const lpA = new LinearPower({ h: 0.6766, Om0: 0.30966, Ob0: 0.04897, ns: 0.9665, As: 2.105e-9, growthMD: e.growthMDToday });
    expect(rel(lpA.sigma8(), 0.8102)).toBeLessThan(0.02);
  });

  it('top-hat window and erfc behave', () => {
    expect(topHatW(0)).toBeCloseTo(1, 6);
    expect(topHatW(4.4934)).toBeCloseTo(0, 3); // first zero, tan x = x
    expect(erfc(0)).toBeCloseTo(1, 6);
    expect(erfc(1)).toBeCloseTo(0.157299, 5);
    expect(erfc(-1)).toBeCloseTo(1.842701, 5);
    // Collapsed fraction rises with growth.
    expect(collapsedFraction(0, 0, 4, 0.2)).toBeLessThan(collapsedFraction(0, 0, 4, 1));
  });

  it('EH without baryons falls back to the smooth fit', () => {
    const eh = new EisensteinHu({ h: 0.7, Om0: 1, Ob0: 0 });
    expect(eh.hasBaryons).toBe(false);
    expect(eh.transfer(0.1)).toBeCloseTo(eh.transferNoWiggle(0.1), 12);
  });
});

describe('Gaussian initial conditions', () => {
  const n = 32, box = 256;
  const power = (k: number) => 2e4 * Math.pow(k / 0.05, -1.2) / (1 + (k / 0.05) ** 2);
  const field = new GaussianField({ n, box, seed: 11, power });

  it('Hermitian symmetry makes the realised field real (inverse of the half spectrum is exact)', () => {
    const fft = new RealFFT3D(n);
    const out = new Float64Array(n * n * n);
    field.realise(fft, out, (_x, _y, _z, _k2, r) => {
      r.r = 1;
      r.i = 0;
    });
    // Forward again must reproduce the spectrum: no information was lost to an imaginary part.
    fft.forward(out);
    let err = 0, mag = 0;
    for (let i = 0; i < fft.re.length; i++) {
      err = Math.max(err, Math.abs(fft.re[i] - field.re[i]), Math.abs(fft.im[i] - field.im[i]));
      mag = Math.max(mag, Math.abs(field.re[i]));
    }
    expect(err / mag).toBeLessThan(1e-9);
  });

  it('measured P(k) of the initial field matches the input spectrum', () => {
    // Average over several seeds to beat cosmic variance on the largest scales.
    const bins = 8;
    const acc = new Float64Array(bins);
    let kk: Float64Array | null = null;
    const seeds = [1, 2, 3, 4, 5, 6];
    for (const s of seeds) {
      const f = new GaussianField({ n, box, seed: s, power });
      const m = measurePower(f.re, f.im, n, box, bins);
      for (let b = 0; b < bins; b++) acc[b] += m.P[b] / seeds.length;
      kk = m.k;
    }
    for (let b = 1; b < bins; b++) {
      expect(rel(acc[b], power(kk![b]))).toBeLessThan(0.15);
    }
  });

  it('the same seed gives the same large-scale modes at every resolution', () => {
    const lo = new GaussianField({ n: 16, box, seed: 5, power });
    const hi = new GaussianField({ n: 32, box, seed: 5, power });
    // Mode (kx, ky, kz) = (1, 2, 3): same draw, same DFT-normalised amplitude ratio (n³ scaling).
    const iLo = (1 * 16 + 2) * 9 + 3, iHi = (1 * 32 + 2) * 17 + 3;
    const s = (32 / 16) ** 3;
    expect(hi.re[iHi] / s).toBeCloseTo(lo.re[iLo], 8);
    expect(hi.im[iHi] / s).toBeCloseTo(lo.im[iLo], 8);
  });

  it('Zel’dovich displacement has the linear-theory rms and 2LPT is second order', () => {
    const d = lptDisplacements(field, n);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < d.psi1.length; i++) {
      s1 += d.psi1[i] ** 2;
      s2 += d.psi2[i] ** 2;
    }
    const rms1 = Math.sqrt(s1 / d.psi1.length), rms2 = Math.sqrt(s2 / d.psi2.length);
    expect(rms1).toBeCloseTo(d.psiRms, 3);
    // σ_ψ² per component = (1/3) ∫ P(k) d³k/(2π)³ / k² over the grid's modes.
    let th = 0;
    const kf = (2 * Math.PI) / box;
    for (let ix = -n / 2 + 1; ix < n / 2; ix++)
      for (let iy = -n / 2 + 1; iy < n / 2; iy++)
        for (let iz = -n / 2 + 1; iz < n / 2; iz++) {
          const q = ix * ix + iy * iy + iz * iz;
          if (!q) continue;
          const k = kf * Math.sqrt(q);
          th += power(k) / (k * k);
        }
    th /= 3 * box ** 3;
    expect(rel(rms1 * rms1, th)).toBeLessThan(0.25);
    expect(rms2).toBeGreaterThan(0);
    expect(rms2).toBeLessThan(rms1);
  });
});

describe('Expansion history', () => {
  const planck = makeExpansion(PLANCK_COSMO);

  it('Planck 2018: age 13.79 Gyr, acceleration since z ≈ 0.63, growth matches Cosmology', () => {
    expect(planck.toGyr(planck.tToday)).toBeCloseTo(13.79, 1);
    const aAcc = planck.aAt(planck.tAccel);
    expect(1 / aAcc - 1).toBeGreaterThan(0.55);
    expect(1 / aAcc - 1).toBeLessThan(0.72);
    const c = new Cosmology({ H0: 67.66, Om0: 0.30966 });
    for (const a of [0.05, 0.2, 0.5, 1.5]) {
      const t = planck.timeOfA(a);
      expect(rel(planck.DAt(t), c.growth(a))).toBeLessThan(0.01);
      expect(rel(planck.toGyr(t), c.ageGyr(a))).toBeLessThan(0.005);
    }
    expect(planck.recollapses).toBe(false);
  });

  it('Einstein–de Sitter: t = 2/(3H0) and D = a', () => {
    const e = new Expansion({ H0: 70, Om0: 1, Ode0: 0, Or0: 0 });
    expect(e.tToday).toBeCloseTo(2 / 3, 4);
    const t = e.timeOfA(0.25);
    expect(e.DAt(t)).toBeCloseTo(0.25, 3);
    expect(e.fAt(t)).toBeCloseTo(1, 2);
  });

  it('a closed universe (Ωm = 2.5) turns around and recollapses', () => {
    const e = new Expansion({ H0: 67.66, Om0: 2.5, Ode0: 0 });
    expect(e.recollapses).toBe(true);
    // Matter-only closed model: a_max = Ωm/(Ωm − 1), t_crunch = π Ωm (Ωm − 1)^(−3/2)
    expect(rel(e.aMax, 2.5 / 1.5)).toBeLessThan(0.01);
    expect(rel(e.tCrunch, (Math.PI * 2.5) / Math.pow(1.5, 1.5))).toBeLessThan(0.02);
    expect(e.aAt(e.tTurn)).toBeGreaterThan(e.aAt(e.tTurn * 0.9));
  });

  it('flags universes with no Big Bang (too much Λ)', () => {
    const e = new Expansion({ H0: 70, Om0: 0.3, Ode0: 2.5 });
    expect(e.bigBang).toBe(false);
  });

  it('FastPM kick/drift factors integrate the linear growing mode exactly', () => {
    // For x = q + D ψ, p = G_p ψ: one drift of the momentum must advance D, one kick G_p.
    const t0 = planck.timeOfA(0.1), t1 = planck.timeOfA(0.6), tc = planck.timeOfA(0.35);
    const drift = fastpmDrift(planck, t0, t1, tc) * planck.Gp(tc);
    expect(drift).toBeCloseTo(planck.DAt(t1) - planck.DAt(t0), 10);
    const kick = fastpmKick(planck, t0, t1, tc) * planck.DAt(tc);
    expect(kick).toBeCloseTo(planck.Gp(t1) - planck.Gp(t0), 10);
  });
});

describe('Particle-mesh gravity', () => {
  it('a single plane wave produces the Poisson force F = −∇ψ, ∇²ψ = δ', () => {
    const n = 32;
    const pm = new ParticleMesh(n, { deconvolve: 0 });
    // Uniform lattice displaced by a small sine wave along x: δ ≈ −∂ψ/∂x.
    const np = n, N = np ** 3, A = 0.05, kx = (2 * Math.PI) / n;
    const pos = new Float32Array(3 * N);
    let p = 0;
    for (let i = 0; i < np; i++)
      for (let j = 0; j < np; j++)
        for (let k = 0; k < np; k++, p++) {
          const q = i + 0.5;
          pos[3 * p] = q + A * Math.sin(kx * q);
          pos[3 * p + 1] = j + 0.5;
          pos[3 * p + 2] = k + 0.5;
        }
    pm.deposit(pos, N);
    pm.solve();
    // δ = −A kx cos(kx q) → ψ = A cos(kx x)/kx → F = −∂ψ/∂x = A sin(kx x): the Zel'dovich force points along the displacement.
    const mom = new Float32Array(3 * N);
    pm.kick(pos, mom, N, 1);
    let dot = 0, nn = 0;
    for (let q = 0; q < N; q++) {
      const x = pos[3 * q];
      const expected = A * Math.sin(kx * x);
      dot += mom[3 * q] * expected;
      nn += expected * expected;
    }
    expect(rel(dot / nn, 1)).toBeLessThan(0.03);
  });

  it('the whole pipeline (2LPT + FastPM, 12 steps) grows large-scale modes as D(a)²', async () => {
    const cfg: SimConfig = {
      cosmo: { ...PLANCK_COSMO },
      box: 1200,
      np: 32,
      nm: 32,
      seed: 3,
      aInit: 0.02,
      aFuture: 1.05,
      stepsEarly: 4,
      stepsMain: 8,
      stepsFuture: 1,
      stepsCollapse: 4,
      keyEvery: 1,
      zHalos: -1,
      fofMin: 20,
      fofB: 0.2,
      deconvolve: 2,
    };
    const frames: Keyframe[] = [];
    const sim = new Simulation(cfg, (m: WorkerMessage) => {
      if (m.type === 'keyframe') frames.push(m.keyframe);
    });
    await sim.run();
    const first = frames[0];
    const today = frames.find((f) => Math.abs(f.a - 1) < 1e-6)!;
    expect(today).toBeDefined();
    // Large scales (lowest k bins): the ratio of measured power to linear D²P stays ≈ 1.
    for (const f of [first, today]) {
      const pk = f.pk!;
      let sum = 0, cnt = 0;
      for (let b = 0; b < pk.k.length; b++) {
        if (pk.k[b] > 0.03 || !(pk.P[b] > 0)) continue;
        sum += pk.P[b] / pk.Plin[b];
        cnt++;
      }
      expect(cnt).toBeGreaterThan(0);
      // Cosmic variance on a 32³ grid with a few modes per bin allows ~±40 %; the growth
      // test below compares the *same* modes at two times and is much tighter.
      expect(sum / cnt).toBeGreaterThan(0.5);
      expect(sum / cnt).toBeLessThan(1.6);
    }
    let growth = 0, gc = 0;
    for (let b = 0; b < first.pk!.k.length; b++) {
      if (first.pk!.k[b] > 0.03 || !(first.pk!.P[b] > 0)) continue;
      growth += today.pk!.P[b] / first.pk!.P[b];
      gc++;
    }
    const expected = (today.D / first.D) ** 2;
    expect(rel(growth / gc, expected)).toBeLessThan(0.06);
  }, 60000);

  it('the time-step schedule lands exactly on today and on turnaround-safe times', () => {
    const e = makeExpansion(PLANCK_COSMO);
    const cfg = { aInit: 0.02, aFuture: 2.6, stepsEarly: 6, stepsMain: 24, stepsFuture: 8, stepsCollapse: 14, keyEvery: 1 } as SimConfig;
    const s = buildSchedule(e, cfg);
    expect(s.a[s.today]).toBeCloseTo(1, 10);
    for (let i = 1; i < s.t.length; i++) expect(s.t[i]).toBeGreaterThan(s.t[i - 1]);
    const ec = makeExpansion({ ...PLANCK_COSMO, Om0: 2.5, Ode0: 0 });
    const sc = buildSchedule(ec, cfg);
    for (let i = 1; i < sc.t.length; i++) expect(sc.t[i]).toBeGreaterThan(sc.t[i - 1]);
    expect(sc.a[sc.a.length - 1]).toBeLessThan(ec.aMax);
  });
});

describe('Friends-of-friends', () => {
  it('finds two compact clumps and ignores the field', () => {
    const rnd = mulberry32(5);
    const box = 64;
    const pts: number[] = [];
    const clump = (cx: number, cy: number, cz: number, m: number) => {
      for (let i = 0; i < m; i++) pts.push(cx + (rnd() - 0.5) * 0.6, cy + (rnd() - 0.5) * 0.6, cz + (rnd() - 0.5) * 0.6);
    };
    clump(10, 10, 10, 60);
    clump(63.8, 40, 20, 35); // straddles the periodic boundary
    for (let i = 0; i < 200; i++) pts.push(rnd() * box, rnd() * box, rnd() * box);
    for (let i = 0; i < pts.length; i++) pts[i] = ((pts[i] % box) + box) % box;
    const pos = Float32Array.from(pts);
    const N = pos.length / 3;
    const cand = Uint32Array.from({ length: N }, (_, i) => i);
    const r = friendsOfFriends(pos, cand, N, box, 0.4, 20);
    expect(r.groups).toBe(2);
    expect(r.groupStart[1] - r.groupStart[0]).toBe(60);
    expect(r.groupStart[2] - r.groupStart[1]).toBe(35);
  });
});

describe('Keyframe store', () => {
  it('delta-encoded frames decode within half a quantum, including large jumps', () => {
    const count = 500;
    const store = new SnapshotStore(count);
    const rnd = mulberry32(9);
    const truth: Uint16Array[] = [];
    let cur = new Uint16Array(3 * count);
    for (let i = 0; i < cur.length; i++) cur[i] = Math.floor(rnd() * 65536);
    for (let f = 0; f < 20; f++) {
      const next = new Uint16Array(cur.length);
      for (let i = 0; i < cur.length; i++) {
        const jump = rnd() < 0.01 ? 5000 : 300;
        next[i] = (cur[i] + Math.round((rnd() - 0.5) * jump) + 65536) & 0xffff;
      }
      cur = next;
      truth.push(cur.slice());
      store.add({ index: f, step: f, t: f, a: 1, D: 1, positions: cur.slice(), halos: null as never, galaxies: null as never, pk: null, stats: null as never });
    }
    for (const f of [19, 3, 11, 0, 16]) {
      const d = store.positions(f);
      let err = 0;
      for (let i = 0; i < d.length; i++) {
        let e = Math.abs(d[i] - truth[f][i]);
        e = Math.min(e, 65536 - e);
        err = Math.max(err, e);
      }
      expect(err).toBeLessThanOrEqual(4);
    }
    expect(store.frameAt(7.5)).toBe(7);
    expect(store.frameAt(-1)).toBe(-1);
  });
});

describe('Galaxies and halos', () => {
  it('stellar-to-halo mass ratio peaks near 10¹² M☉ at a few per cent (Moster+13)', () => {
    let best = 0, bestM = 0;
    for (let lm = 10; lm <= 15; lm += 0.05) {
      const M = 10 ** lm;
      const r = stellarMass(M, 0) / M;
      if (r > best) {
        best = r;
        bestM = M;
      }
    }
    expect(best).toBeGreaterThan(0.02);
    expect(best).toBeLessThan(0.05);
    expect(Math.log10(bestM)).toBeGreaterThan(11.4);
    expect(Math.log10(bestM)).toBeLessThan(12.2);
  });

  it('R200c and V200 of a Milky-Way halo', () => {
    const r = r200c(1e12, 70);
    expect(r).toBeGreaterThan(195);
    expect(r).toBeLessThan(215);
    expect(v200(1e12, r)).toBeGreaterThan(140);
    expect(v200(1e12, r)).toBeLessThan(150);
  });

  it('cosmic star formation peaks near z ≈ 2 (Madau & Dickinson 2014)', () => {
    let best = 0, bz = 0;
    for (let z = 0; z < 8; z += 0.05) {
      const s = cosmicSFRD(z);
      if (s > best) {
        best = s;
        bz = z;
      }
    }
    expect(bz).toBeGreaterThan(1.5);
    expect(bz).toBeLessThan(2.3);
    expect(cosmicSFRD(0)).toBeCloseTo(0.015, 3);
  });

  it('places halos in Mpc around the box centre, like the renderer', () => {
    const out = projectHalos(
      { count: 2, center: Float32Array.from([0.5, 0.5, 0.5, 0.75, 0.25, 0.5]), mass: Float32Array.from([1e14, 1e12]) },
      100,
      123,
    );
    expect(out).toHaveLength(2);
    expect(out[0].position.x).toBeCloseTo(0, 6);
    expect(out[1].position.x).toBeCloseTo(25, 6);
    expect(out[1].position.y).toBeCloseTo(-25, 6);
    expect(out[1].position.z).toBeCloseTo(0, 6);
    expect(rel(out[0].mass, 1e14)).toBeLessThan(1e-6);
    expect(out[0].seed).not.toBe(out[1].seed);
  });
});

describe('Cosmic timeline', () => {
  it('maps track position to time monotonically and back', () => {
    const e = makeExpansion(PLANCK_COSMO);
    const tl = new CosmicTimeline(e, e.timeOfA(0.02), e.timeOfA(2.6));
    let prev = -1;
    for (let u = 0; u <= 1.0001; u += 0.01) {
      const t = tl.tOfU(u);
      expect(t).toBeGreaterThan(prev);
      prev = t;
      expect(tl.uOfT(t)).toBeCloseTo(Math.min(u, 1), 4);
    }
    expect(tl.tOfU(tl.uToday)).toBeCloseTo(e.tToday, 6);
    expect(tl.epochAt(e.timeOfA(1 / 1301)).id).toBe('plasma');
    expect(tl.epochAt(e.tToday).id).toBe('today');
  });
});
