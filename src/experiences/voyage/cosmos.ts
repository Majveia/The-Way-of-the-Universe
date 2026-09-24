import * as THREE from 'three';
import { GalaxyLayer } from '../../worlds/galaxy/GalaxyLayer';
import { milkyWay, preset, type GalaxyParams, type MorphologyId } from '../../worlds/galaxy/params';
import { Frame, UNIT, convertPoint } from '../../worlds/explorer/frames';
import { UniverseLayer, type UniverseHalo } from '../../worlds/explorer/UniverseLayer';
import { M31, diskOrientation, equatorialDir, morphologyForHalo, randomOrientation, MORPH_LABEL } from '../../worlds/explorer/universe';

/**
 * The explorer's universe: the frame tree above the star systems, the galaxies drawn in full
 * (GalaxyLayer: the Milky Way, Andromeda, and whichever other galaxy the traveller visits) and the
 * cosmic web. Heavy layers are built lazily when the traveller comes near and disposed when left
 * far behind; each fades in over ~1 s once its particles are on the GPU.
 */

export interface GalaxyEntry {
  id: string;
  name: string;
  kicker: string;
  frame: Frame;
  params: GalaxyParams;
  morph: MorphologyId;
  layer: GalaxyLayer | null;
  ready: boolean;
  /** Seconds since ready (fade-in clock). */
  age: number;
  /** Visible radius, pc. */
  radius: number;
  /** Current render weight 0..1 (set by the explorer each frame). */
  weight: number;
  halo: UniverseHalo | null;
  /** Build when closer than this (Mpc); dispose beyond `dropMpc`. */
  buildMpc: number;
  dropMpc: number;
}

/** Scale a galaxy model by k in size (masses ∝ k^1.2 so the rotation speed rises gently; light ∝ k²). */
export function scaleGalaxy(p: GalaxyParams, k: number): GalaxyParams {
  const q: GalaxyParams = JSON.parse(JSON.stringify(p));
  const m = Math.pow(k, 1.2);
  q.potential = q.potential.map((c) => {
    const o = { ...c } as Record<string, unknown>;
    for (const key of ['a', 'b', 'rs', 'soft']) if (typeof o[key] === 'number') o[key] = (o[key] as number) * (key === 'b' ? 1 : k);
    for (const key of ['M', 'Ms']) if (typeof o[key] === 'number') o[key] = (o[key] as number) * m;
    return o as unknown as typeof c;
  });
  q.rMax *= k;
  q.disk.scaleLength *= k;
  q.disk.truncation *= k;
  q.disk.thickScaleLength *= k;
  q.disk.lum *= k * k;
  q.disk.thickLum *= k * k;
  q.bulge.a *= k;
  q.bulge.lum *= k * k;
  q.bar.halfLength *= k;
  q.bar.lum *= k * k;
  q.spiral.r0 *= k;
  q.spiral.rInner *= k;
  q.spiral.rOuter *= k;
  q.young.scaleLength *= k;
  q.young.rInner *= k;
  q.young.rOuter *= k;
  q.young.lum *= k * k;
  q.gas.dustScaleLength *= k;
  q.gas.dustHole *= k;
  q.gas.nuclearRing *= k;
  q.halo.rMin *= k;
  q.halo.rMax *= k;
  q.globulars.rCore *= k;
  q.globulars.rMax *= k;
  q.look.viewDistance *= k;
  return q;
}

export class Cosmos {
  readonly root: Frame;
  readonly mw: Frame;
  readonly local: Frame;
  readonly galaxies: GalaxyEntry[] = [];
  readonly universe: UniverseLayer;
  readonly mwEntry: GalaxyEntry;
  readonly m31Entry: GalaxyEntry;
  /** The visited galaxy (random destination), if any. */
  visited: GalaxyEntry | null = null;
  /** The Sun in the Milky Way frame (pc). */
  readonly sunGalaxy = new THREE.Vector3();
  private kids = new Map<Frame, Frame[]>();
  private width = 1;
  private height = 1;

  constructor(
    private renderer: THREE.WebGLRenderer,
    private detail: number,
  ) {
    this.root = new Frame({ id: 'universe', kind: 'universe', label: 'Cosmic web', metres: UNIT.MPC });
    const mwParams = milkyWay(1);
    const sun = mwParams.sun!;
    // Render frame (y-up): X = R cos φ, H = z, Z = −spin · R sin φ (see galaxy/model.ts Kinematics).
    this.sunGalaxy.set(sun.R * Math.cos(sun.phi), sun.z, -mwParams.spin * sun.R * Math.sin(sun.phi));
    this.mw = new Frame({ id: 'milkyway', kind: 'galaxy', label: 'Milky Way', parent: this.root, unit: 1e-6, entry: 250_000, exit: 320_000 });
    this.local = new Frame({ id: 'local', kind: 'local', label: 'Orion Spur', parent: this.mw, unit: 1, origin: this.sunGalaxy, entry: 800, exit: 1000 });
    this.mwEntry = this.addGalaxy({ id: 'milkyway', name: 'Milky Way', kicker: 'Barred spiral SBbc · home', frame: this.mw, params: mwParams, morph: 'milkyway', buildMpc: 3, dropMpc: 5 });
    // Andromeda: real direction, distance and disk orientation; an Sb model 1.5× the Milky Way's size.
    const o = diskOrientation(M31.raDeg, M31.decDeg, M31.paDeg, M31.inclinationDeg);
    const m31Pos = equatorialDir(M31.raDeg, M31.decDeg).multiplyScalar(M31.distanceMpc).addScaledVector(this.sunGalaxy, 1e-6);
    const m31Frame = new Frame({ id: 'm31', kind: 'galaxy', label: 'Andromeda', parent: this.root, unit: 1e-6, origin: m31Pos, rotation: o.rotation, entry: 250_000, exit: 320_000 });
    const m31Params = scaleGalaxy(preset('Sb', 31), 1.45);
    m31Params.label = 'Andromeda (M31)';
    this.m31Entry = this.addGalaxy({ id: 'm31', name: 'Andromeda', kicker: 'M31 · spiral Sb · 2.5 million ly', frame: m31Frame, params: m31Params, morph: 'Sb', buildMpc: 2.2, dropMpc: 3.2 });
    this.universe = new UniverseLayer(renderer, { detail });
    this.kids.set(this.mw, [this.local]);
  }

  private addGalaxy(o: Omit<GalaxyEntry, 'layer' | 'ready' | 'age' | 'radius' | 'weight' | 'halo'> & { halo?: UniverseHalo }): GalaxyEntry {
    const e: GalaxyEntry = { ...o, layer: null, ready: false, age: 0, radius: o.params.rMax, weight: 0, halo: o.halo ?? null };
    this.galaxies.push(e);
    const list = this.kids.get(this.root) ?? [];
    list.push(e.frame);
    this.kids.set(this.root, list);
    return e;
  }

  /** Child frames that can be entered from `f` (for settleFrame). */
  children = (f: Frame): readonly Frame[] => this.kids.get(f) ?? EMPTY;

  addChild(parent: Frame, child: Frame): void {
    const list = this.kids.get(parent) ?? [];
    if (!list.includes(child)) list.push(child);
    this.kids.set(parent, list);
  }
  removeChild(parent: Frame, child: Frame): void {
    const list = this.kids.get(parent);
    if (!list) return;
    const i = list.indexOf(child);
    if (i >= 0) list.splice(i, 1);
  }

  /** A galaxy for a halo of the simulated web (the "random galaxy" destination). */
  visitHalo(h: UniverseHalo): GalaxyEntry {
    if (this.visited?.halo?.index === h.index) return this.visited;
    this.dropVisited();
    const morph = morphologyForHalo(h.mass, h.seed);
    const params = preset(morph, (h.seed % 9973) + 1);
    const frame = new Frame({ id: `halo-${h.index}`, kind: 'galaxy', label: 'Galaxy', parent: this.root, unit: 1e-6, origin: h.position, rotation: randomOrientation(h.seed), entry: 250_000, exit: 320_000 });
    const name = `TWG ${String(h.seed % 100000).padStart(5, '0')}`;
    frame.label = name;
    const e = this.addGalaxy({ id: frame.id, name, kicker: `${MORPH_LABEL[morph]} · halo ${fmtMass(h.mass)}`, frame, params, morph, buildMpc: 4, dropMpc: 6, halo: h });
    this.visited = e;
    return e;
  }

  private dropVisited(): void {
    const v = this.visited;
    if (!v) return;
    v.layer?.dispose();
    v.layer = null;
    v.frame.disposed = true;
    this.removeChild(this.root, v.frame);
    this.galaxies.splice(this.galaxies.indexOf(v), 1);
    this.visited = null;
  }

  /** Build/dispose galaxy layers by distance (camera in root Mpc). */
  manage(camRoot: THREE.Vector3, dt: number, allowM31: boolean): void {
    for (const g of this.galaxies) {
      const d = camRoot.distanceTo(g.frame.origin);
      const want = g === this.m31Entry ? allowM31 && d < g.buildMpc : d < g.buildMpc;
      if (want && !g.layer) {
        g.ready = false;
        g.age = 0;
        g.layer = new GalaxyLayer(this.renderer, { params: g.params, detail: this.detail });
        g.layer.resize(this.width, this.height);
        const layer = g.layer;
        void layer.ready.then(() => {
          if (g.layer === layer) g.ready = true;
        });
      } else if (g.layer && d > g.dropMpc) {
        g.layer.dispose();
        g.layer = null;
        g.ready = false;
      }
      if (g.ready) g.age += dt;
    }
  }

  resize(w: number, h: number): void {
    this.width = w;
    this.height = h;
    for (const g of this.galaxies) g.layer?.resize(w, h);
  }

  /** Point in the root frame (Mpc) of a point given in any frame. */
  toRoot(p: THREE.Vector3, f: Frame, out: THREE.Vector3): THREE.Vector3 {
    return convertPoint(p, f, this.root, out);
  }

  dispose(): void {
    for (const g of this.galaxies) {
      g.layer?.dispose();
      g.layer = null;
    }
    this.universe.dispose();
  }
}

const EMPTY: readonly Frame[] = [];

export function fmtMass(m: number): string {
  const e = Math.floor(Math.log10(m));
  const sup = String(e).replace(/[0-9-]/g, (c) => '⁰¹²³⁴⁵⁶⁷⁸⁹'['0123456789'.indexOf(c)] ?? '⁻');
  return `${(m / 10 ** e).toFixed(1)} × 10${sup} M☉`;
}
