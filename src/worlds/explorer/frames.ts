import * as THREE from 'three';

/**
 * The frame stack of the seamless explorer.
 *
 * One universe spans 10²⁷ m (the simulated box) down to 10³ m (a spacecraft above a planet): 24
 * decades, more than float64 holds (≈ 16 significant digits). So positions live in a tree of
 * frames, each in its own natural unit, and the traveller's position is kept in float64 in the
 * *deepest* frame that contains it:
 *
 *   universe (Mpc) ─ galaxy (pc) ─ local neighbourhood (pc, heliocentric) ─ star system (AU) ─ planet (km)
 *
 * A frame is defined by its origin in the parent (parent units, float64), the rotation that takes
 * its axes into the parent's axes, and the length of one of its units in parent units. Converting
 * between any two frames walks up to their lowest common ancestor and back down; only the
 * conversions along the way lose precision, never the stored state.
 *
 * Attitude (the ship's and the camera's orientation) is always expressed in the ROOT frame's axes,
 * so crossing into a rotated frame (the ecliptic of a star system, the disk of another galaxy)
 * never jolts the view. Velocities are root-axis metres per second for the same reason.
 *
 * Hysteresis: a frame is entered inside `entry` (child units) and left beyond `exit` > `entry`,
 * so hovering at a boundary never flips back and forth.
 */

export type FrameKind = 'universe' | 'galaxy' | 'local' | 'system' | 'planet';

export interface FrameOptions {
  id: string;
  kind: FrameKind;
  label: string;
  parent?: Frame | null;
  /** Origin in parent units. */
  origin?: THREE.Vector3;
  /** Child axes → parent axes. */
  rotation?: THREE.Quaternion;
  /** One child unit expressed in parent units (root: metres per unit via `metres`). */
  unit?: number;
  /** Metres per unit — required for the root, derived for children. */
  metres?: number;
  entry?: number;
  exit?: number;
  data?: unknown;
}

export class Frame {
  readonly id: string;
  readonly kind: FrameKind;
  label: string;
  readonly parent: Frame | null;
  readonly depth: number;
  /** Origin in parent units (float64). Mutable: moving frames (planets) update it every frame. */
  readonly origin = new THREE.Vector3();
  /** Child axes → parent axes. */
  readonly rotation = new THREE.Quaternion();
  /** Child axes → root axes (composed; refreshed by `setRotation`). */
  readonly rootRotation = new THREE.Quaternion();
  /** One child unit in parent units. */
  readonly unit: number;
  /** Metres per unit of this frame. */
  readonly metres: number;
  /** Enter inside this radius, leave beyond `exit` (child units). */
  entry: number;
  exit: number;
  /** Free slot for the owner (e.g. the body or system this frame belongs to). */
  data: unknown;
  /** Set when the frame has been removed from the tree (its layer was disposed). */
  disposed = false;

  constructor(o: FrameOptions) {
    this.id = o.id;
    this.kind = o.kind;
    this.label = o.label;
    this.parent = o.parent ?? null;
    this.depth = this.parent ? this.parent.depth + 1 : 0;
    if (o.origin) this.origin.copy(o.origin);
    this.unit = this.parent ? (o.unit ?? 1) : 1;
    this.metres = this.parent ? this.parent.metres * this.unit : (o.metres ?? 1);
    this.entry = o.entry ?? Infinity;
    this.exit = Math.max(o.exit ?? this.entry * 1.25, this.entry);
    this.data = o.data;
    this.setRotation(o.rotation ?? IDENTITY);
  }

  setRotation(q: THREE.Quaternion): void {
    this.rotation.copy(q).normalize();
    if (this.parent) this.rootRotation.copy(this.parent.rootRotation).multiply(this.rotation);
    else this.rootRotation.copy(this.rotation);
  }

  /** Point: this frame → parent frame. */
  toParent(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(p).multiplyScalar(this.unit).applyQuaternion(this.rotation).add(this.origin);
  }

  /** Point: parent frame → this frame. */
  fromParent(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    _qi.copy(this.rotation).invert();
    return out.copy(p).sub(this.origin).applyQuaternion(_qi).divideScalar(this.unit);
  }

  /** Is `a` this frame or one of its ancestors? */
  isWithin(a: Frame): boolean {
    for (let f: Frame | null = this; f; f = f.parent) if (f === a) return true;
    return false;
  }

  /** Root → … → this. */
  path(): Frame[] {
    const out: Frame[] = [];
    for (let f: Frame | null = this; f; f = f.parent) out.push(f);
    return out.reverse();
  }
}

const IDENTITY = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _p = new THREE.Vector3();

/** Lowest common ancestor (null only if the frames live in different trees). */
export function commonAncestor(a: Frame, b: Frame): Frame | null {
  let x: Frame | null = a;
  let y: Frame | null = b;
  while (x && y && x.depth > y.depth) x = x.parent;
  while (x && y && y.depth > x.depth) y = y.parent;
  while (x && y && x !== y) {
    x = x.parent;
    y = y.parent;
  }
  return x && x === y ? x : null;
}

const _down: Frame[] = [];

/** Convert a point from frame `from` to frame `to` (float64 all the way). */
export function convertPoint(p: THREE.Vector3, from: Frame, to: Frame, out: THREE.Vector3): THREE.Vector3 {
  if (from === to) return out.copy(p);
  const lca = commonAncestor(from, to);
  if (!lca) throw new Error(`frames ${from.id} and ${to.id} share no ancestor`);
  _p.copy(p);
  for (let f: Frame = from; f !== lca; f = f.parent!) f.toParent(_p, _p);
  _down.length = 0;
  for (let f: Frame = to; f !== lca; f = f.parent!) _down.push(f);
  for (let i = _down.length - 1; i >= 0; i--) _down[i].fromParent(_p, _p);
  return out.copy(_p);
}

/** Convert a direction (unit-free vector) between the axes of two frames. */
export function convertDirection(v: THREE.Vector3, from: Frame, to: Frame, out: THREE.Vector3): THREE.Vector3 {
  out.copy(v).applyQuaternion(from.rootRotation);
  _qi.copy(to.rootRotation).invert();
  return out.applyQuaternion(_qi);
}

/** Root-axis direction → a frame's axes. */
export function rootDirToFrame(v: THREE.Vector3, f: Frame, out: THREE.Vector3): THREE.Vector3 {
  _qi.copy(f.rootRotation).invert();
  return out.copy(v).applyQuaternion(_qi);
}

/** A frame's axes → root axes. */
export function frameDirToRoot(v: THREE.Vector3, f: Frame, out: THREE.Vector3): THREE.Vector3 {
  return out.copy(v).applyQuaternion(f.rootRotation);
}

/** Root-axis attitude → the same attitude expressed in a frame's axes. */
export function rootQuatToFrame(q: THREE.Quaternion, f: Frame, out: THREE.Quaternion): THREE.Quaternion {
  _qi.copy(f.rootRotation).invert();
  return out.copy(_qi).multiply(q);
}

/** Distance between two points given in (possibly different) frames, in metres. */
export function distanceMetres(a: THREE.Vector3, fa: Frame, b: THREE.Vector3, fb: Frame): number {
  const lca = commonAncestor(fa, fb)!;
  convertPoint(a, fa, lca, _a);
  convertPoint(b, fb, lca, _b);
  return _a.distanceTo(_b) * lca.metres;
}
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

/** The traveller: position (frame units, float64), attitude (root axes), velocity (root axes, m/s). */
export interface NavState {
  frame: Frame;
  readonly position: THREE.Vector3;
  readonly quaternion: THREE.Quaternion;
  readonly velocity: THREE.Vector3;
}

export function makeNav(frame: Frame): NavState {
  return { frame, position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), velocity: new THREE.Vector3() };
}

/** Re-express the traveller's position in another frame (attitude and velocity are frame-free). */
export function rebase(nav: NavState, to: Frame): void {
  if (nav.frame === to) return;
  convertPoint(nav.position, nav.frame, to, nav.position);
  nav.frame = to;
}

/** Move by a root-axis displacement given in metres. */
export function translateMetres(nav: NavState, dRoot: THREE.Vector3): void {
  rootDirToFrame(dRoot, nav.frame, _p).divideScalar(nav.frame.metres);
  nav.position.add(_p);
}

/** Supplies the child frames that could be entered from a frame (created lazily by their owners). */
export type ChildProvider = (f: Frame) => readonly Frame[];

/**
 * Settle the traveller in the deepest frame that contains it: leave frames beyond their exit
 * radius (climbing), then enter the child frame inside whose entry radius we sit (the one we are
 * relatively deepest in, |p|/entry smallest). Returns true if the frame changed.
 */
export function settleFrame(nav: NavState, children: ChildProvider, maxSteps = 16): boolean {
  const start = nav.frame;
  for (let step = 0; step < maxSteps; step++) {
    // Climb out.
    while (nav.frame.parent && (nav.frame.disposed || nav.position.length() > nav.frame.exit)) rebase(nav, nav.frame.parent);
    // Descend.
    let best: Frame | null = null;
    let bestR = 1;
    for (const c of children(nav.frame)) {
      if (c.disposed || c.parent !== nav.frame) continue;
      c.fromParent(nav.position, _p);
      const r = _p.length() / c.entry;
      if (r < bestR) {
        bestR = r;
        best = c;
      }
    }
    if (!best) break;
    rebase(nav, best);
  }
  return nav.frame !== start;
}

/** Physical length units, metres. */
export const UNIT = {
  KM: 1e3,
  AU: 1.495978707e11,
  PC: 3.0856775814913673e16,
  KPC: 3.0856775814913673e19,
  MPC: 3.0856775814913673e22,
  LY: 9.4607304725808e15,
} as const;
