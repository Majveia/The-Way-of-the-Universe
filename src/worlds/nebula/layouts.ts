import * as THREE from 'three';
import { Rng } from '../../physics/random';
import { makeCluster, makeYSOs } from './stars';
import { powerLawRGB } from '../../physics/nebulae';
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
    : [p.source.pos[0] + rng.normal(0, 0.5), p.source.pos[1] + rng.normal(0, 0.2), p.source.pos[2] + rng.normal(0, 0.4)];
  const cavityR = curated ? 4.6 : rng.range(4.2, 5.0);
  // Pillars: [base x, base z, length (pc), base radius (pc)] — the Eagle's three columns, tallest on the left.
  const specs: Array<[number, number, number, number]> = curated
    ? [
        [-1.75, -0.35, 3.35, 0.46],
        [-0.25, -0.75, 2.05, 0.36],
        [0.95, -0.2, 1.45, 0.3],
      ]
    : Array.from({ length: rng.chance(0.4) ? 4 : 3 }, (_, i) => [
        -2.1 + i * 1.3 + rng.normal(0, 0.25),
        rng.range(-0.9, 0.2),
        rng.range(1.2, 3.4),
        rng.range(0.26, 0.46),
      ]);
  const A = vec4Array(6);
  const B = vec4Array(6);
  const tips: Vec3[] = [];
  specs.forEach(([bx, bz, L, r], i) => {
    const base: Vec3 = [bx, -2.9, bz];
    const toSrc = sub(src, base);
    // Point at the cluster, with a little independent lean.
    const lean: Vec3 = curated ? [[-0.12, 0, 0.04], [0.02, 0, -0.06], [0.1, 0, 0.05]][i] as Vec3 : [rng.normal(0, 0.12), 0, rng.normal(0, 0.12)];
    const d = norm(toSrc);
    const ax = norm([d[0] + lean[0], d[1] + lean[1], d[2] + lean[2]]);
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
      G[g++].set(t[0] + d.x * 0.32, t[1] + Math.abs(d.y) * 0.22 + 0.05, t[2] + d.z * 0.32, rng.range(0.04, 0.075));
    }
  }
  // Bok globules: dark knots adrift in the cavity, silhouetted on the glowing wall.
  const nBok = curated ? 3 : 2 + rng.int(3);
  for (let j = 0; j < nBok && g < 16; j++) {
    G[g++].set(rng.range(-3, 2.5), rng.range(-0.8, 2.2), rng.range(-1.4, -0.6), rng.range(0.1, 0.17));
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

/** Unit vector with a seeded wobble (curated seed 0 keeps `a` exactly). */
function wobble(rng: Rng, a: Vec3, amount: number, curated: boolean): THREE.Vector3 {
  const v = v3(a).normalize();
  if (curated) return v;
  return v.add(new THREE.Vector3(rng.normal(0, amount), rng.normal(0, amount), rng.normal(0, amount))).normalize();
}

const seedOffsetFor = (rng: Rng, curated: boolean, c: Vec3): Vec3 =>
  curated ? c : [rng.range(-50, 50), rng.range(-50, 50), rng.range(-50, 50)];

/** A planetary-nebula nucleus: a hot, compact white dwarf (M_V from L and T via the stars module). */
function centralStar(teff: number, mv: number): NebulaStar {
  return { pos: [0, 0, 0], teff, mv, kind: 'ionizing' };
}

function ringLayout(p: NebulaPreset, seed: number): VariantLayout {
  const rng = new Rng(seed * 7919 + 23).fork('ring');
  const c = seed === 0;
  const axis = wobble(rng, [0.22, 0.32, 0.92], 0.35, c);
  const k = c ? 1 : rng.range(0.85, 1.2);
  return {
    densityUniforms: {
      uAxis: { value: axis },
      uAxis2: { value: axis.clone() },
      // Ring radius, radial width, height along the axis, ellipticity.
      uShape: { value: new THREE.Vector4(0.125 * k, 0.034 * k, 0.1 * k, c ? 1.3 : rng.range(1.05, 1.45)) },
      // Halo radius, spacing of the concentric arcs (JWST: ≈ 0.02 pc, i.e. ~280 yr at 25 km/s... in the halo's 10 km/s).
      uShape2: { value: new THREE.Vector4(0.42 * k, 0.021, 0, 0) },
    },
    source: [0, 0, 0],
    stars: [centralStar(p.source.teff, 6.2)],
    scatter: [],
    seedOffset: seedOffsetFor(rng, c, [3.1, 7.7, 1.9]),
  };
}

function helixLayout(p: NebulaPreset, seed: number): VariantLayout {
  const rng = new Rng(seed * 7919 + 29).fork('helix');
  const c = seed === 0;
  // Inner disk inclined ≈ 23°, outer ring nearly perpendicular to it (O'Dell et al. 2004).
  const a1 = wobble(rng, [0.18, 0.33, 0.93], 0.3, c);
  const a2 = wobble(rng, [0.85, 0.12, 0.5], 0.3, c);
  return {
    densityUniforms: {
      uAxis: { value: a1 },
      uAxis2: { value: a2 },
      uShape: { value: new THREE.Vector4(0.33, 0.1, 0.13, 1.12) },
      uShape2: { value: new THREE.Vector4(0.52, 0.075, 0.1, 1.08) },
    },
    source: [0, 0, 0],
    stars: [centralStar(p.source.teff, 6.9)],
    scatter: [],
    seedOffset: seedOffsetFor(rng, c, [5.3, 1.1, 8.4]),
  };
}

function butterflyLayout(p: NebulaPreset, seed: number): VariantLayout {
  const rng = new Rng(seed * 7919 + 31).fork('butterfly');
  const c = seed === 0;
  const axis = wobble(rng, [1, 0.14, 0.3], 0.25, c);
  return {
    densityUniforms: {
      uAxis: { value: axis },
      uAxis2: { value: axis.clone() },
      // Lobe length, lobe half-width, torus radius, torus width (pc).
      // The torus is kept ≥ 4 bake voxels thick so it can shadow itself (an unresolved torus
      // leaks the central star's light into its outer skin and glows instead of forming a lane).
      uShape: { value: new THREE.Vector4(0.58, c ? 0.2 : rng.range(0.14, 0.26), 0.07, 0.045) },
      uShape2: { value: new THREE.Vector4() },
    },
    source: [0, 0, 0],
    stars: [centralStar(p.source.teff, 2.5)],
    scatter: [],
    seedOffset: seedOffsetFor(rng, c, [2.2, 9.1, 4.4]),
  };
}

function rotationTo(axis: THREE.Vector3, roll: number): THREE.Matrix3 {
  // Local → ellipsoid frame: the ellipsoid's long axis is x.
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), axis.clone().normalize());
  q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), roll));
  const m4 = new THREE.Matrix4().makeRotationFromQuaternion(q).invert();
  return new THREE.Matrix3().setFromMatrix4(m4);
}

function crabLayout(p: NebulaPreset, seed: number): VariantLayout {
  const rng = new Rng(seed * 7919 + 37).fork('crab');
  const c = seed === 0;
  // Long axis along the pulsar's spin axis projected at PA ≈ 125° (Hester 2008), tilted to the sky.
  const axis = wobble(rng, [0.83, -0.42, 0.37], 0.3, c);
  const rot = rotationTo(axis, c ? 0.4 : rng.range(0, 6.28));
  const axes = new THREE.Vector3(1.7, 1.12, 1.05);
  // Synchrotron colour: F_ν ∝ ν^−0.6 in the optical core, steepening to ≈ −0.9 toward the edge
  // as electrons lose energy on their way out (Véron-Cetty & Woltjer 1993).
  const core = powerLawRGB(0.6);
  const edge = powerLawRGB(1.1);
  const syn = 450000;
  return {
    densityUniforms: {
      uEllAxes: { value: axes },
      uEllRot: { value: rot },
      uCell: { value: 0.42 },
      uMarch_uSheetR: { value: new THREE.Vector4(0.0, 0.012, 14000, 0) },
      uMarch_uSheetO: { value: new THREE.Vector4(-0.012, 0.02, 12000, 0) },
      uMarch_uSheetB: { value: new THREE.Vector4(0, 0.03, 0, 0) },
      uMarch_uRipple: { value: 0.035 },
      uMarch_uSynAxes: { value: new THREE.Vector3(1.25, 0.85, 0.82) },
      uMarch_uSynRot: { value: rot },
      uMarch_uSynCore: { value: new THREE.Vector3(core[0] * syn, core[1] * syn, core[2] * syn) },
      uMarch_uSynEdge: { value: new THREE.Vector3(edge[0] * syn * 0.35, edge[1] * syn * 0.35, edge[2] * syn * 0.35) },
      // Inner wisps: the termination shock of the pulsar wind, ≈ 0.1 pc (Hester et al. 2002).
      uMarch_uWisp: { value: new THREE.Vector4(0.13, 0.025, 0.018, 2.2) },
    },
    source: [0, 0, 0],
    stars: [
      // Crab pulsar: V = 16.5 at 2 kpc through A_V ≈ 1.6 → M_V ≈ +3.4 (unreddened).
      { pos: [0, 0, 0], teff: 14000, mv: 3.4, kind: 'pulsar' },
      // The "companion" line-of-sight star 4″ NW of the pulsar (a field star in reality).
      { pos: [-0.03, 0.035, 0.6], teff: 6500, mv: 3.8 },
    ],
    scatter: [],
    seedOffset: seedOffsetFor(rng, c, [4.4, 2.8, 6.1]),
  };
}

function veilLayout(p: NebulaPreset, seed: number): VariantLayout {
  const rng = new Rng(seed * 7919 + 41).fork('veil');
  const c = seed === 0;
  return {
    densityUniforms: {
      uShellR: { value: p.shellRadius },
      // Axis of the bright east/west arcs (the Cygnus Loop is brightest on its limbs).
      uArc: { value: wobble(rng, [1, 0.12, 0.05], 0.4, c) },
      uMarch_uSheetR: { value: new THREE.Vector4(0.22, 0.09, 2600, 0) },
      uMarch_uSheetO: { value: new THREE.Vector4(0.02, 0.07, 1500, 0) },
      uMarch_uSheetB: { value: new THREE.Vector4(-0.08, 0.05, 250, 0) },
      uMarch_uRipple: { value: 0.07 },
    },
    source: [0, 0, 0],
    stars: [],
    scatter: [],
    seedOffset: seedOffsetFor(rng, c, [1.7, 5.5, 3.3]),
  };
}

function horseheadLayout(p: NebulaPreset, seed: number): VariantLayout {
  const rng = new Rng(seed * 7919 + 43).fork('horsehead');
  const c = seed === 0;
  const src: Vec3 = c ? [...p.source.pos] : [p.source.pos[0] + rng.normal(0, 0.6), p.source.pos[1], p.source.pos[2] + rng.normal(0, 0.5)];
  const scat = p.scatter.map((s) => ({ ...s, pos: (c ? [...s.pos] : [s.pos[0] + rng.normal(0, 0.4), s.pos[1], s.pos[2] + rng.normal(0, 0.3)]) as Vec3 }));
  // Horse: (x offset, z depth, scale, lean).
  const horse = c ? new THREE.Vector4(0, 0.35, 1, 0) : new THREE.Vector4(rng.range(-0.8, 0.8), rng.range(0.1, 0.6), rng.range(0.8, 1.2), rng.normal(0, 0.15));
  const stars: NebulaStar[] = [
    // σ Ori AB: O9.5 V + B0.5 V.
    { pos: src, teff: 33000, mv: -4.3, kind: 'ionizing' },
    // HD 37903, the B1.5 V star inside NGC 2023.
    { pos: scat[0].pos, teff: 22000, mv: -1.6 },
    ...makeYSOs(rng.fork('yso'), [[-0.25 + horse.x, 0.5, horse.y], [1.4, -1.2, 0.4], [-1.2, -1.5, 0.6]], 1, 0.08),
  ];
  return {
    densityUniforms: {
      uSource: { value: v3(src) },
      uHorse: { value: horse },
      uScat0: { value: v3(scat[0].pos) },
    },
    source: src,
    stars,
    scatter: scat,
    seedOffset: seedOffsetFor(rng, c, [8.1, 2.4, 5.6]),
  };
}

/** The brightest Pleiades: offsets from Alcyone (arcmin east, arcmin north), T_eff, L (L☉), M_V. */
const PLEIADES: Array<[string, number, number, number, number, number]> = [
  ['Alcyone', 0, 0, 12300, 2400, -2.8],
  ['Atlas', 23.0, -3.1, 12000, 940, -2.05],
  ['Electra', -35.7, 0.5, 13400, 1225, -1.97],
  ['Maia', -22.7, 15.8, 12600, 660, -1.8],
  ['Merope', -15.8, -9.4, 14000, 630, -1.49],
  ['Taygeta', -31.1, 21.7, 13700, 600, -1.37],
  ['Pleione', 23.3, 1.9, 12000, 190, -0.62],
  ['Celaeno', -36.7, 11.1, 12300, 240, -0.22],
];
export const PLEIADES_NAMES = PLEIADES.map((s) => s[0]);

function pleiadesLayout(p: NebulaPreset, seed: number): VariantLayout {
  const rng = new Rng(seed * 7919 + 47).fork('pleiades');
  const c = seed === 0;
  // 1′ at 136 pc = 0.0396 pc; east is to the left with north up.
  const arcmin = 0.0396;
  const pos: Vec3[] = PLEIADES.map(([, e, n], i) => [
    -e * arcmin + 0.45,
    n * arcmin - 0.15,
    c ? [0.1, -0.35, 0.4, -0.2, 0.25, -0.5, 0.3, 0.15][i] : rng.normal(0, 0.45),
  ]);
  const stars: NebulaStar[] = PLEIADES.map(([, , , t, , mv], i) => ({ pos: pos[i], teff: t, mv }));
  stars.push(
    ...makeCluster(rng.fork('members'), { center: [0, 0.05, 0], count: 160, radius: 1.1, minMass: 0.6, maxMass: 3.2 }),
  );
  const scatter: ScatterStar[] = PLEIADES.slice(1).map(([, , , t, L], i) => ({ pos: pos[i + 1], teff: t, lum: L }));
  // Magnetic-field direction the dust striations follow (Gibson & Nordsieck 2003).
  const field = wobble(rng, [0.8, -0.55, 0.2], 0.5, c);
  return {
    densityUniforms: { uBField: { value: field }, uStarsA: { value: pos.map((q) => new THREE.Vector4(q[0], q[1], q[2], 0)) } },
    source: pos[0],
    stars,
    scatter,
    seedOffset: seedOffsetFor(rng, c, [6.6, 3.9, 2.2]),
  };
}

export function buildLayout(preset: NebulaPreset, seed: number): VariantLayout {
  switch (preset.variant) {
    case 'ring':
      return ringLayout(preset, seed);
    case 'helix':
      return helixLayout(preset, seed);
    case 'butterfly':
      return butterflyLayout(preset, seed);
    case 'crab':
      return crabLayout(preset, seed);
    case 'veil':
      return veilLayout(preset, seed);
    case 'horsehead':
      return horseheadLayout(preset, seed);
    case 'pleiades':
      return pleiadesLayout(preset, seed);
    case 'pillars':
    default:
      return pillarsLayout(preset, seed);
  }
}
