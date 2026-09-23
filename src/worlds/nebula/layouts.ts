import * as THREE from 'three';
import { Rng } from '../../physics/random';
import { makeCluster, makeYSOs } from './stars';
import type { NebulaPreset, NebulaStar, ScatterStar, Vec3 } from './types';

/**
 * Seeded geometry for each variant: uniforms of its density generator, the position of the
 * ionizing source, and the stars that live inside the nebula. Seed 0 is the curated
 * arrangement that resembles the reference object; any other seed is a new, physically
 * equivalent nebula.
 */
export interface VariantLayout {
  densityUniforms: Record<string, THREE.IUniform>;
  source: Vec3;
  stars: NebulaStar[];
  scatter: ScatterStar[];
  seedOffset: Vec3;
}

const v3 = (a: Vec3) => new THREE.Vector3(a[0], a[1], a[2]);
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: Vec3): Vec3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

function vec4Array(n: number): THREE.Vector4[] {
  return Array.from({ length: n }, () => new THREE.Vector4());
}

function pillarsLayout(p: NebulaPreset, seed: number): VariantLayout {
  const rng = new Rng(seed * 7919 + 17).fork('pillars');
  const curated = seed === 0;
  const src: Vec3 = curated
    ? [...p.source.pos]
    : [p.source.pos[0] + rng.normal(0, 0.35), p.source.pos[1] + rng.normal(0, 0.25), p.source.pos[2] + rng.normal(0, 0.35)];
  const cavityR = curated ? 3.45 : rng.range(3.1, 3.8);
  // Pillars: [base x, base z, length fraction, radius]
  const specs: Array<[number, number, number, number]> = curated
    ? [
        [-1.85, -0.35, 0.56, 0.4],
        [-0.45, 0.2, 0.42, 0.3],
        [0.55, -0.75, 0.33, 0.24],
      ]
    : Array.from({ length: rng.chance(0.4) ? 4 : 3 }, (_, i, ) => [
        -2.3 + i * 1.15 + rng.normal(0, 0.25),
        rng.range(-1.0, 0.5),
        rng.range(0.3, 0.58),
        rng.range(0.22, 0.42),
      ]);
  const A = vec4Array(6);
  const B = vec4Array(6);
  const tips: Vec3[] = [];
  specs.forEach(([bx, bz, f, r], i) => {
    const base: Vec3 = [bx, -2.35, bz];
    const toSrc = sub(src, base);
    // Point at the cluster, with a little independent lean.
    const lean: Vec3 = curated ? [0.12 * (i - 1), 0, 0.05] : [rng.normal(0, 0.12), 0, rng.normal(0, 0.12)];
    const ax = norm([toSrc[0] / len(toSrc) + lean[0], toSrc[1] / len(toSrc) + lean[1], toSrc[2] / len(toSrc) + lean[2]]);
    const L = f * len(toSrc);
    A[i].set(base[0], base[1], base[2], r);
    B[i].set(ax[0], ax[1], ax[2], L);
    tips.push([base[0] + ax[0] * L * 0.97, base[1] + ax[1] * L * 0.97, base[2] + ax[2] * L * 0.97]);
  });
  // Globules: EGGs near the tips, Bok globules loose in the cavity.
  const G = vec4Array(16);
  let g = 0;
  for (const t of tips) {
    const k = curated ? 2 : 1 + rng.int(3);
    for (let j = 0; j < k && g < 16; j++) {
      const d = rng.onSphere();
      G[g++].set(t[0] + d.x * 0.3, t[1] + Math.abs(d.y) * 0.25 + 0.05, t[2] + d.z * 0.3, rng.range(0.035, 0.07));
    }
  }
  // Bok globules: dark knots adrift in the far half of the cavity, silhouetted on the glowing wall.
  const nBok = curated ? 3 : 2 + rng.int(3);
  for (let j = 0; j < nBok && g < 16; j++) {
    const az = rng.range(-2.6, -0.6);
    const el = rng.range(-0.5, 0.35);
    const r = cavityR * rng.range(0.72, 0.92);
    G[g++].set(src[0] + Math.cos(az) * Math.cos(el) * r, src[1] + Math.sin(el) * r, src[2] + Math.sin(-az) * Math.cos(el) * r * 0.5 + 0.8, rng.range(0.1, 0.16));
  }
  const seedOffset: Vec3 = curated ? [11.7, 3.2, 7.9] : [rng.range(-50, 50), rng.range(-50, 50), rng.range(-50, 50)];
  const stars = [
    ...makeCluster(rng.fork('cluster'), {
      center: src,
      count: 150,
      radius: 0.7,
      minMass: 0.7,
      maxMass: 16,
      oTypes: ['O4 V', 'O5 V', 'O5 V', 'O6 V', 'O7 V', 'O8 V', 'O9 V'],
      coreRadius: 0.25,
    }),
    ...makeYSOs(rng.fork('yso'), tips, 2, 0.06),
  ];
  return {
    densityUniforms: {
      uSource: { value: v3(src) },
      uCavityR: { value: cavityR },
      uPillarA: { value: A },
      uPillarB: { value: B },
      uPillarCount: { value: specs.length },
      uGlob: { value: G },
      uGlobCount: { value: g },
    },
    source: src,
    stars,
    scatter: [],
    seedOffset,
  };
}

export function buildLayout(preset: NebulaPreset, seed: number): VariantLayout {
  switch (preset.variant) {
    case 'pillars':
    default:
      return pillarsLayout(preset, seed);
  }
}
