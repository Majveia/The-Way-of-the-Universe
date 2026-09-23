import * as THREE from 'three';

/**
 * Procedural geometry for the Ship of the Imagination — an original design: a 26 m ivory lifting-body
 * "seed" with a dark ceramic belly (a nod to orbiter heat-shield tiles), a teardrop canopy, swept
 * anhedral blade wings, a canted V-tail and a ring drive. Ship-local metres; nose toward −Z, up +Y,
 * starboard +X (the same convention as a three.js camera, so a flight quaternion can drive it).
 *
 * Every vertex carries `uv` (surface parameters used for procedural panel lines) and `part`:
 *   0 fuselage · 1 wing · 2 fin · 3 canopy · 4 drive ring · 5 nozzle (inner, glowing) · 6 tail cap
 */
export const SHIP_PART = { fuselage: 0, wing: 1, fin: 2, canopy: 3, ring: 4, nozzle: 5, cap: 6 } as const;

export const SHIP_DIMENSIONS = {
  length: 26,
  noseZ: -13,
  tailZ: 13,
  halfWidth: 2.2,
  halfHeight: 1.45,
};

interface Part {
  positions: number[];
  uvs: number[];
  indices: number[];
  part: number;
  /** Seam pairs (vertex indices) whose normals should be averaged. */
  seams: Array<[number, number]>;
  poles: Array<{ index: number; normal: [number, number, number] }>;
}

function newPart(part: number): Part {
  return { positions: [], uvs: [], indices: [], part, seams: [], poles: [] };
}

/** Lofted grid of (nu+1) × (nv+1) vertices; v wraps when closedV. */
function loft(p: Part, nu: number, nv: number, fn: (u: number, v: number) => [number, number, number], closedV: boolean, flip = false): void {
  const base = p.positions.length / 3;
  for (let i = 0; i <= nu; i++) {
    const u = i / nu;
    for (let j = 0; j <= nv; j++) {
      const v = j / nv;
      const [x, y, z] = fn(u, closedV && j === nv ? 0 : v);
      p.positions.push(x, y, z);
      p.uvs.push(u, v);
    }
    if (closedV) p.seams.push([base + i * (nv + 1), base + i * (nv + 1) + nv]);
  }
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const a = base + i * (nv + 1) + j;
      const b = a + nv + 1;
      if (flip) p.indices.push(a, a + 1, b, b, a + 1, b + 1);
      else p.indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// ——— Fuselage profile ———
const SP = 0.46; // station of maximum width
/** Half-width (m) at station s ∈ [0, 1] (nose → tail). */
export function fuselageHalfWidth(s: number): number {
  const { halfWidth } = SHIP_DIMENSIONS;
  if (s < SP) {
    const t = 1 - s / SP;
    return halfWidth * Math.pow(Math.max(0, 1 - t * t), 0.62);
  }
  return halfWidth * (1 - 0.6 * Math.pow(smooth(SP, 1, s), 1.15));
}
/** Half-height (m) at station s. */
export function fuselageHalfHeight(s: number): number {
  const { halfHeight } = SHIP_DIMENSIONS;
  const sp = 0.38;
  if (s < sp) {
    const t = 1 - s / sp;
    return halfHeight * Math.pow(Math.max(0, 1 - t * t), 0.58);
  }
  return halfHeight * (1 - 0.62 * Math.pow(smooth(sp, 1, s), 1.1));
}
/** Centre-line height: the nose droops slightly, the tail lifts. */
export function fuselageCenterY(s: number): number {
  return -0.32 * Math.pow(1 - s, 3) + 0.18 * Math.pow(s, 4);
}
const stationZ = (s: number) => SHIP_DIMENSIONS.noseZ + SHIP_DIMENSIONS.length * s;

/** Superellipse cross-section point; θ = 0 → +X (starboard), θ = π/2 → top. */
function sectionPoint(s: number, theta: number): [number, number, number] {
  const w = fuselageHalfWidth(s);
  const h = fuselageHalfHeight(s);
  const n = 2.35;
  const c = Math.cos(theta), sn = Math.sin(theta);
  const x = w * Math.sign(c) * Math.pow(Math.abs(c), 2 / n);
  let y = h * Math.sign(sn) * Math.pow(Math.abs(sn), 2 / n);
  // Dorsal spine: a soft ridge along the top, strongest mid-ship.
  if (sn > 0) y += 0.16 * Math.pow(sn, 10) * smooth(0.12, 0.35, s) * (1 - smooth(0.7, 1, s));
  // Flatter belly.
  if (sn < 0) y *= 0.86;
  return [x, fuselageCenterY(s) + y, stationZ(s)];
}

function buildFuselage(detail: number): Part {
  const p = newPart(SHIP_PART.fuselage);
  const nu = Math.round(90 * detail);
  const nv = Math.round(72 * detail);
  // Station spacing denser near the nose (u² mapping).
  const sOf = (u: number) => 0.975 * (u * u * 0.35 + u * 0.65);
  loft(p, nu, nv, (u, v) => sectionPoint(Math.max(1e-4, sOf(u)), v * Math.PI * 2), true, true);
  // Nose pole: first row collapses toward the tip; force a forward normal.
  for (let j = 0; j <= nv; j++) p.poles.push({ index: j, normal: [0, -0.2, -1] });
  return p;
}

/** Tail cap closing the fuselage around the drive (a shallow dish). */
function buildTailCap(detail: number): Part {
  const p = newPart(SHIP_PART.cap);
  const nv = Math.round(72 * detail);
  const s0 = 0.975;
  const rings = 6;
  loft(
    p,
    rings,
    nv,
    (u, v) => {
      const [x, y, z] = sectionPoint(s0, v * Math.PI * 2);
      const cy = fuselageCenterY(s0);
      const k = 1 - u * 0.62; // shrink toward the nozzle radius
      return [x * k, cy + (y - cy) * k, z + 0.18 * Math.sin(u * Math.PI * 0.5)];
    },
    true,
    true,
  );
  return p;
}

/** NACA 4-digit symmetric half-thickness (closed trailing edge), x ∈ [0, 1]. */
function naca(x: number, t: number): number {
  return 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x * x * x - 0.1036 * x * x * x * x);
}

interface WingSpec {
  /** Root leading edge (x, y, z) and chord. */
  root: [number, number, number];
  rootChord: number;
  /** Tip leading edge and chord. */
  tip: [number, number, number];
  tipChord: number;
  thickness: number;
  /** Mirror across X. */
  mirror: boolean;
}

function buildWing(detail: number, w: WingSpec, part: number): Part {
  const p = newPart(part);
  const nu = Math.round(28 * detail); // spanwise
  const nv = Math.round(40 * detail); // around the airfoil
  const sx = w.mirror ? -1 : 1;
  // Thickness direction: perpendicular to the span and to the chord (+Z) — "up" for a wing,
  // inboard-up for a canted fin.
  const span = new THREE.Vector3(w.tip[0] - w.root[0], w.tip[1] - w.root[1], 0).normalize();
  const thick = new THREE.Vector3(-span.y, span.x, 0);
  loft(
    p,
    nu,
    nv,
    (u, v) => {
      // Spanwise station with a rounded tip: thickness and chord ease off over the last 6 %.
      const sp = u;
      const le: [number, number, number] = [
        w.root[0] + (w.tip[0] - w.root[0]) * sp,
        w.root[1] + (w.tip[1] - w.root[1]) * sp * sp,
        w.root[2] + (w.tip[2] - w.root[2]) * sp,
      ];
      let chord = w.rootChord + (w.tipChord - w.rootChord) * sp;
      const tipRound = Math.sqrt(Math.max(0, 1 - Math.pow(Math.max(0, (sp - 0.94) / 0.06), 2)));
      chord *= 0.35 + 0.65 * tipRound;
      // Around the airfoil: v ∈ [0, 0.5] upper surface TE→LE, [0.5, 1] lower LE→TE.
      const upper = v < 0.5;
      const k = upper ? 1 - v * 2 : (v - 0.5) * 2;
      const xc = 0.5 - 0.5 * Math.cos(k * Math.PI);
      const t = w.thickness * (1 - 0.25 * sp) * tipRound;
      const yt = naca(xc, t) * chord * (upper ? 1 : -1);
      return [sx * (le[0] + thick.x * yt), le[1] + thick.y * yt, le[2] + xc * chord];
    },
    true,
    w.mirror,
  );
  return p;
}

function buildCanopy(detail: number): Part {
  const p = newPart(SHIP_PART.canopy);
  const nu = Math.round(40 * detail);
  const nv = Math.round(36 * detail);
  const s0 = 0.12, s1 = 0.42;
  loft(
    p,
    nu,
    nv,
    (u, v) => {
      const s = s0 + (s1 - s0) * u;
      // Teardrop plan and profile.
      const tt = u < 0.35 ? Math.sqrt(Math.max(0, 1 - Math.pow(1 - u / 0.35, 2))) : 1 - 0.85 * Math.pow(smooth(0.35, 1, u), 1.4);
      const halfW = 0.78 * tt + 0.001;
      const bulge = 0.62 * tt;
      const top = fuselageCenterY(s) + fuselageHalfHeight(s) * 0.97;
      const th = v * Math.PI; // 0 → starboard, π → port
      const c = Math.cos(th), sn = Math.sin(th);
      const x = halfW * Math.sign(c) * Math.pow(Math.abs(c), 0.8);
      const y = top - 0.25 + (bulge + 0.25) * Math.pow(sn, 0.7);
      return [x, y, stationZ(s)];
    },
    false,
    true,
  );
  return p;
}

function buildRing(detail: number): Part {
  const p = newPart(SHIP_PART.ring);
  const R = 1.18, r = 0.2;
  const z0 = SHIP_DIMENSIONS.tailZ + 0.35;
  const cy = fuselageCenterY(1) - 0.02;
  loft(
    p,
    Math.round(96 * detail),
    Math.round(20 * detail),
    (u, v) => {
      const a = u * Math.PI * 2, b = v * Math.PI * 2;
      // Slightly flattened (elliptical) tube, longer along Z.
      const rr = R + r * Math.cos(b);
      return [rr * Math.cos(a), cy + rr * Math.sin(a), z0 + r * 1.6 * Math.sin(b)];
    },
    true,
  );
  return p;
}

function buildNozzle(detail: number): Part {
  const p = newPart(SHIP_PART.nozzle);
  const z0 = SHIP_DIMENSIONS.tailZ - 0.2;
  const cy = fuselageCenterY(1) - 0.02;
  // Inner bell: a funnel from the throat (r 0.42) out to the drive ring (r 1.02); rendered from inside.
  loft(
    p,
    14,
    Math.round(64 * detail),
    (u, v) => {
      const a = v * Math.PI * 2;
      const r = 0.42 + 0.6 * Math.pow(u, 1.6);
      return [r * Math.cos(a), cy + r * Math.sin(a), z0 + 0.95 * u];
    },
    true,
  );
  return p;
}

function toGeometry(parts: Part[]): THREE.BufferGeometry {
  const merged = new THREE.BufferGeometry();
  const pos: number[] = [], uv: number[] = [], partA: number[] = [], idx: number[] = [], nrm: number[] = [];
  for (const p of parts) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p.positions, 3));
    g.setIndex(p.indices);
    g.computeVertexNormals();
    const n = g.getAttribute('normal') as THREE.BufferAttribute;
    for (const [a, b] of p.seams) {
      const x = n.getX(a) + n.getX(b), y = n.getY(a) + n.getY(b), z = n.getZ(a) + n.getZ(b);
      const l = Math.hypot(x, y, z) || 1;
      n.setXYZ(a, x / l, y / l, z / l);
      n.setXYZ(b, x / l, y / l, z / l);
    }
    for (const pole of p.poles) {
      const [x, y, z] = pole.normal;
      const l = Math.hypot(x, y, z);
      n.setXYZ(pole.index, x / l, y / l, z / l);
    }
    const base = pos.length / 3;
    pos.push(...p.positions);
    uv.push(...p.uvs);
    for (let i = 0; i < p.positions.length / 3; i++) {
      partA.push(p.part);
      nrm.push(n.getX(i), n.getY(i), n.getZ(i));
    }
    for (const i of p.indices) idx.push(base + i);
    g.dispose();
  }
  merged.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  merged.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  merged.setAttribute('part', new THREE.Float32BufferAttribute(partA, 1));
  merged.setIndex(idx);
  merged.computeBoundingSphere();
  return merged;
}

export interface ShipGeometry {
  /** All opaque hull surfaces in one geometry (`part` attribute selects the material). */
  hull: THREE.BufferGeometry;
  /** Navigation lights: position (ship-local) and colour name. */
  lights: Array<{ position: THREE.Vector3; kind: 'port' | 'starboard' | 'strobe' | 'beacon' }>;
  /** Centre of the drive throat and the exhaust axis (+Z). */
  nozzle: THREE.Vector3;
  nozzleRadius: number;
  /** Pilot's eye point for the cockpit view. */
  cockpit: THREE.Vector3;
  boundingRadius: number;
}

export function buildShipGeometry(detail = 1): ShipGeometry {
  const d = THREE.MathUtils.clamp(detail, 0.45, 1.6);
  const wingY = -0.34;
  const wingRoot: [number, number, number] = [1.35, wingY, -1.2];
  const wingTip: [number, number, number] = [7.4, wingY - 0.95, 6.3];
  const wingSpec = (mirror: boolean): WingSpec => ({ root: wingRoot, rootChord: 9.2, tip: wingTip, tipChord: 2.3, thickness: 0.07, mirror });
  const finSpec = (mirror: boolean): WingSpec => ({ root: [0.42, 0.72, 5.1], rootChord: 5.8, tip: [2.45, 3.35, 9.7], tipChord: 1.9, thickness: 0.08, mirror });
  const parts = [
    buildFuselage(d),
    buildTailCap(d),
    buildWing(d, wingSpec(false), SHIP_PART.wing),
    buildWing(d, wingSpec(true), SHIP_PART.wing),
    buildWing(d, finSpec(false), SHIP_PART.fin),
    buildWing(d, finSpec(true), SHIP_PART.fin),
    buildCanopy(d),
    buildRing(d),
    buildNozzle(d),
  ];
  const hull = toGeometry(parts);
  const tipLE = new THREE.Vector3(wingTip[0], wingTip[1], wingTip[2]);
  const tipChord = 2.3 * 0.35;
  const cy = fuselageCenterY(1) - 0.02;
  return {
    hull,
    lights: [
      { position: new THREE.Vector3(-tipLE.x - 0.05, tipLE.y, tipLE.z + tipChord * 0.4), kind: 'port' },
      { position: new THREE.Vector3(tipLE.x + 0.05, tipLE.y, tipLE.z + tipChord * 0.4), kind: 'starboard' },
      { position: new THREE.Vector3(-2.45, 3.4, 10.25), kind: 'strobe' },
      { position: new THREE.Vector3(2.45, 3.4, 10.25), kind: 'strobe' },
      { position: new THREE.Vector3(0, fuselageCenterY(0.55) - fuselageHalfHeight(0.55) * 0.86 - 0.05, stationZ(0.55)), kind: 'beacon' },
    ],
    nozzle: new THREE.Vector3(0, cy, SHIP_DIMENSIONS.tailZ - 0.2),
    nozzleRadius: 1.02,
    cockpit: new THREE.Vector3(0, fuselageCenterY(0.24) + fuselageHalfHeight(0.24) + 0.18, stationZ(0.24)),
    boundingRadius: 14.5,
  };
}
