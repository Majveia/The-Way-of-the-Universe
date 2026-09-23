import {
  COMP_BULGE,
  COMP_DISK,
  COMP_HALO,
  realizeGalaxy,
  type GalaxyRealization,
  type GalaxySpec,
  type SmoothModel,
  type Softening,
} from './galaxy';
import { diskRotation, keplerStart, rotate, type OrbitSpec, type RelativeState } from './orbit';

/**
 * A two-galaxy encounter, laid out for the GPU.
 *
 * World frame = three.js frame: the orbital plane is XZ and the orbital angular momentum
 * points along +Y (orbit frame (x, y, z) → world (x, z, −y)).
 *
 * Skeleton texture (width SKELETON_WIDTH): segments [halo₀ | halo₁ | bulge₀ | bulge₁ | disk₀ | disk₁],
 * each a whole number of rows so the force loop can use per-segment softening.
 *   pos = (x, y, z, m)     vel = (vx, vy, vz, code = comp + 4·galaxy)
 * Tracer texture (width TRACER_WIDTH): galaxy 0 rows, then galaxy 1 rows.
 *   pos = (x, y, z, t_burst)   vel = (vx, vy, vz, 0)   attr = (kind, galaxy, age₀ [Myr], weight)
 */
export const SKELETON_WIDTH = 64;
export const TRACER_WIDTH = 256;

export interface GalaxyPlacement {
  spec: GalaxySpec;
  /** Toomre & Toomre inclination and argument of pericentre (degrees). */
  i: number;
  w: number;
}

export interface ScenarioDef {
  galaxies: [GalaxyPlacement, GalaxyPlacement];
  orbit: OrbitSpec;
  seed: number;
  softening?: [Softening, Softening];
}

export interface ScenarioCounts {
  /** Total skeleton particles (rounded to whole rows per segment). */
  skeleton: number;
  /** Total tracer particles. */
  tracers: number;
}

export interface Segment {
  start: number;
  count: number;
  comp: number;
  galaxy: number;
  eps: number;
}

export interface GalaxyInfo {
  spec: GalaxySpec;
  model: SmoothModel;
  /** World-frame initial centre and velocity. */
  center: [number, number, number];
  velocity: [number, number, number];
  /** World-frame unit spin axis of the disk. */
  spin: [number, number, number];
  /** Skeleton mass (10¹⁰ M☉). */
  mass: number;
  softening: Softening;
  /** Tracer rows [start, count). */
  tracerRows: [number, number];
  /** Skeleton bulge segment (for centre tracking). */
  bulge: Segment;
  /** Initial second moments of the disk tracers (for smooth-disk refits). */
  moments0: { R2: number; z2: number; weightIn: number; weightAll: number };
}

export interface ScenarioData {
  def: ScenarioDef;
  skeleton: { n: number; width: number; pos: Float32Array; vel: Float32Array; segments: Segment[] };
  tracers: { n: number; width: number; rows: number; pos: Float32Array; vel: Float32Array; attr: Float32Array };
  galaxies: [GalaxyInfo, GalaxyInfo];
  relative: RelativeState;
}

const roundRows = (n: number, w: number) => Math.max(w, Math.round(n / w) * w);

export function defaultSoftening(spec: GalaxySpec): Softening {
  const c = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
  return {
    halo: c(0.035 * spec.halo.scale, 0.4, 1.2),
    bulge: c(0.3 * spec.bulge.scale, 0.08, 0.3),
    disk: c(0.1 * spec.disk.scale, 0.15, 0.4),
  };
}

/** Radius inside which the smooth disk is refit from its tracers. */
export const diskMomentRadius = (spec: GalaxySpec) => 5 * spec.disk.scale;

/** Partition the particle budgets between two galaxies and their components. */
export function allocateCounts(def: ScenarioDef, counts: ScenarioCounts) {
  const [a, b] = def.galaxies.map((g) => g.spec);
  const mA = a.halo.mass + a.bulge.mass + a.disk.mass, mB = b.halo.mass + b.bulge.mass + b.disk.mass;
  const wA = Math.pow(mA, 0.6), wB = Math.pow(mB, 0.6);
  const lA = Math.pow(a.bulge.mass + a.disk.mass, 0.8), lB = Math.pow(b.bulge.mass + b.disk.mass, 0.8);
  const sk = [counts.skeleton * (wA / (wA + wB)), counts.skeleton * (wB / (wA + wB))];
  const tr = [counts.tracers * (lA / (lA + lB)), counts.tracers * (lB / (lA + lB))];
  return [a, b].map((spec, g) => {
    const S = sk[g], W = SKELETON_WIDTH;
    const skel = { halo: roundRows(0.55 * S, W), bulge: roundRows(0.15 * S, W), disk: roundRows(0.3 * S, W) };
    const T = roundRows(Math.max(tr[g], 4 * TRACER_WIDTH), TRACER_WIDTH);
    const gasShare = Math.min(0.35, Math.max(0.14, 0.1 + spec.gas.fraction));
    const bulgeShare = Math.min(0.3, Math.max(0.08, (0.9 * spec.bulge.mass) / (spec.bulge.mass + spec.disk.mass)));
    const gas = Math.round(T * gasShare);
    const bulge = Math.round(T * bulgeShare);
    const disk = T - gas - bulge;
    return { skeleton: skel, tracers: { bulge, disk, gas } };
  });
}

export function buildScenario(def: ScenarioDef, counts: ScenarioCounts): ScenarioData {
  const alloc = allocateCounts(def, counts);
  const soft = def.softening ?? [defaultSoftening(def.galaxies[0].spec), defaultSoftening(def.galaxies[1].spec)];
  const reals: GalaxyRealization[] = def.galaxies.map((g, k) =>
    realizeGalaxy(g.spec, alloc[k].skeleton, alloc[k].tracers, soft[k], def.seed * 7919 + k * 104729),
  );
  const m1 = reals[0].mass, m2 = reals[1].mass;
  const rel = keplerStart(m1, m2, def.orbit);
  const M = m1 + m2;
  // Orbit-frame centres and velocities (centre of mass at rest at the origin).
  const oc = [
    [(-m2 / M) * rel.r[0], (-m2 / M) * rel.r[1], (-m2 / M) * rel.r[2]],
    [(m1 / M) * rel.r[0], (m1 / M) * rel.r[1], (m1 / M) * rel.r[2]],
  ];
  const ov = [
    [(-m2 / M) * rel.v[0], (-m2 / M) * rel.v[1], (-m2 / M) * rel.v[2]],
    [(m1 / M) * rel.v[0], (m1 / M) * rel.v[1], (m1 / M) * rel.v[2]],
  ];
  const rots = def.galaxies.map((g) => diskRotation(g.i, g.w));
  const toWorld = (v: number[], o: number, out: Float32Array | number[], oo: number) => {
    // orbit (x, y, z) → world (x, z, −y)
    const x = v[o], y = v[o + 1], z = v[o + 2];
    out[oo] = x;
    out[oo + 1] = z;
    out[oo + 2] = -y;
  };

  // ——— Skeleton layout ———
  const segs: Segment[] = [];
  let start = 0;
  for (const comp of [COMP_HALO, COMP_BULGE, COMP_DISK]) {
    for (let g = 0; g < 2; g++) {
      const c = alloc[g].skeleton;
      const count = comp === COMP_HALO ? c.halo : comp === COMP_BULGE ? c.bulge : c.disk;
      const eps = comp === COMP_HALO ? soft[g].halo : comp === COMP_BULGE ? soft[g].bulge : soft[g].disk;
      segs.push({ start, count, comp, galaxy: g, eps });
      start += count;
    }
  }
  const nS = start;
  const sPos = new Float32Array(nS * 4), sVel = new Float32Array(nS * 4);
  const tmpA = [0, 0, 0], tmpB = [0, 0, 0];
  for (const seg of segs) {
    const R = reals[seg.galaxy];
    const rot = rots[seg.galaxy];
    // Local index offset of this component inside the realisation.
    const cnt = R.skeleton.counts;
    const off = seg.comp === COMP_HALO ? 0 : seg.comp === COMP_BULGE ? cnt.halo : cnt.halo + cnt.bulge;
    for (let i = 0; i < seg.count; i++) {
      const j = off + i;
      const d = seg.start + i;
      rotate(rot, R.skeleton.pos[j * 3], R.skeleton.pos[j * 3 + 1], R.skeleton.pos[j * 3 + 2], tmpA);
      rotate(rot, R.skeleton.vel[j * 3], R.skeleton.vel[j * 3 + 1], R.skeleton.vel[j * 3 + 2], tmpB);
      for (let k = 0; k < 3; k++) {
        tmpA[k] += oc[seg.galaxy][k];
        tmpB[k] += ov[seg.galaxy][k];
      }
      toWorld(tmpA, 0, sPos, d * 4);
      toWorld(tmpB, 0, sVel, d * 4);
      sPos[d * 4 + 3] = R.skeleton.mass[j];
      sVel[d * 4 + 3] = seg.comp + 4 * seg.galaxy;
    }
  }

  // ——— Tracer layout ———
  const nT = reals[0].tracers.kind.length + reals[1].tracers.kind.length;
  const tPos = new Float32Array(nT * 4), tVel = new Float32Array(nT * 4), tAttr = new Float32Array(nT * 4);
  let q = 0;
  const infos: GalaxyInfo[] = [];
  for (let g = 0; g < 2; g++) {
    const R = reals[g];
    const rot = rots[g];
    const row0 = q / TRACER_WIDTH;
    const n = R.tracers.kind.length;
    // Moments of the disk tracers (local frame) for later smooth-disk refits.
    const rCut = diskMomentRadius(R.spec);
    let wIn = 0, wAll = 0, R2 = 0, z2 = 0;
    for (let i = 0; i < n; i++, q++) {
      const x = R.tracers.pos[i * 3], y = R.tracers.pos[i * 3 + 1], z = R.tracers.pos[i * 3 + 2];
      const kind = R.tracers.kind[i];
      const w = R.tracers.weight[i];
      if (kind !== 0) {
        wAll += w;
        if (x * x + y * y + z * z < rCut * rCut) {
          wIn += w;
          R2 += w * (x * x + y * y);
          z2 += w * z * z;
        }
      }
      rotate(rot, x, y, z, tmpA);
      rotate(rot, R.tracers.vel[i * 3], R.tracers.vel[i * 3 + 1], R.tracers.vel[i * 3 + 2], tmpB);
      for (let k = 0; k < 3; k++) {
        tmpA[k] += oc[g][k];
        tmpB[k] += ov[g][k];
      }
      toWorld(tmpA, 0, tPos, q * 4);
      toWorld(tmpB, 0, tVel, q * 4);
      // Gas: pos.w holds the time of its last starburst (negative = before t = 0).
      tPos[q * 4 + 3] = kind === 2 ? -R.tracers.age[i] : 0;
      tAttr[q * 4] = kind;
      tAttr[q * 4 + 1] = g;
      tAttr[q * 4 + 2] = R.tracers.age[i];
      tAttr[q * 4 + 3] = R.tracers.weight[i];
    }
    const spinO = [0, 0, 0];
    rotate(rot, 0, 0, 1, spinO);
    const spinW: [number, number, number] = [spinO[0], spinO[2], -spinO[1]];
    const cW: [number, number, number] = [oc[g][0], oc[g][2], -oc[g][1]];
    const vW: [number, number, number] = [ov[g][0], ov[g][2], -ov[g][1]];
    infos.push({
      spec: R.spec,
      model: R.model,
      center: cW,
      velocity: vW,
      spin: spinW,
      mass: R.mass,
      softening: soft[g],
      tracerRows: [row0, n / TRACER_WIDTH],
      bulge: segs.find((s) => s.comp === COMP_BULGE && s.galaxy === g)!,
      moments0: { R2: R2 / Math.max(wIn, 1e-30), z2: z2 / Math.max(wIn, 1e-30), weightIn: wIn, weightAll: wAll },
    });
  }
  return {
    def,
    skeleton: { n: nS, width: SKELETON_WIDTH, pos: sPos, vel: sVel, segments: segs },
    tracers: { n: nT, width: TRACER_WIDTH, rows: nT / TRACER_WIDTH, pos: tPos, vel: tVel, attr: tAttr },
    galaxies: [infos[0], infos[1]],
    relative: rel,
  };
}
