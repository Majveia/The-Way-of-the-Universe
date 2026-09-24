import * as THREE from 'three';
import { WebRenderer, type WebFrameState } from '../cosmicweb/WebRenderer';
import { loadWebToday, type CachedWeb, type CosmicHalo } from '../cosmicweb/webCache';
import { boxToGalactic, chooseHome, wrapNear, type HomeChoice } from './universe';

/**
 * The cosmic web at z = 0 as the outermost layer of the explorer, in the explorer's ROOT frame:
 * Mpc, Local-Group-centred, Milky Way galactic axes.
 *
 * Uses the cosmicweb module's simulation cache (a Web Worker PM run, shared with the Cosmic Web
 * experience) and its WebRenderer. The box is wrapped periodically around home and rotated so the
 * Virgo-analogue cluster lies toward the real Virgo (see universe.ts). Dark matter can be faded
 * independently of the galaxies (it is an "overlay" seen only far from galaxies), and everything
 * within a near radius of the camera fades out — there the explorer draws galaxies in full.
 */
export interface UniverseHalo {
  /** Root-frame position, Mpc (home = origin, wrapped to the nearest periodic image). */
  position: THREE.Vector3;
  mass: number;
  seed: number;
  index: number;
}

export interface UniverseRenderOptions {
  /** Dark-matter overlay 0..1. */
  darkMatter: number;
  /** Galaxy sprites 0..1. */
  galaxies: number;
  /** Linear brightness. */
  exposure: number;
  /** Everything closer than this (Mpc) fades out (over ×1…×3). */
  nearFade: number;
  pixelRatio: number;
}

export class UniverseLayer {
  readonly ready: Promise<void>;
  /** Halos in the root frame (empty until ready), most massive first. */
  halos: UniverseHalo[] = [];
  home: HomeChoice | null = null;
  boxMpc = 0;
  /** Box axes → root (galactic) axes. */
  readonly boxRotation = new THREE.Quaternion();
  /** Home in box-centred world coordinates (Mpc). */
  readonly homeWorld = new THREE.Vector3();
  private web: WebRenderer | null = null;
  private data: CachedWeb | null = null;
  private disposed = false;
  private cam = new THREE.PerspectiveCamera();
  private size = new THREE.Vector2();
  private qInv = new THREE.Quaternion();
  private state: WebFrameState = {
    mix: 0,
    za: -1,
    D: 1,
    z: 0,
    scale: 1,
    wrap: true,
    wrapCenter: new THREE.Vector3(0.5, 0.5, 0.5),
    fadeFar: 0,
    slab: null,
    darkMatter: 1,
    galaxies: 1,
    fieldGalaxies: 1,
    replicas: 0,
    outline: 0,
    exposure: 1,
    sfrBoost: 0,
    quench: 1,
    cmb: null,
  };

  constructor(
    private renderer: THREE.WebGLRenderer,
    private opts: { detail: number; seed?: number },
  ) {
    const d = opts.detail;
    const np = d >= 1 ? 128 : d >= 0.6 ? 96 : 64;
    this.ready = loadWebToday({ seed: opts.seed ?? 42, np }).then((w) => {
      if (this.disposed) return;
      this.data = w;
      this.boxMpc = w.boxMpc;
      this.setupHome(w.halos);
      const info = w.info;
      this.web = new WebRenderer(renderer, {
        np: info.np,
        count: info.count,
        nm: info.nm,
        boxWorld: w.boxMpc,
        deltaL: info.deltaL,
        sigmaL: info.sigmaL,
        varDwarf: Math.max(0.5, info.sigmaMin2 - info.sigmaL * info.sigmaL),
        varBright: Math.max(0.3, 9 - info.sigmaL * info.sigmaL),
        detail: d,
      });
      this.web.setKeyframes(0, w.today.positions, 0, w.today.positions);
      this.web.setGalaxies(w.today.galaxies, w.today.galaxies);
    });
  }

  get isReady(): boolean {
    return !!this.web;
  }

  private setupHome(halos: CosmicHalo[]): void {
    const box = this.boxMpc;
    const choice = chooseHome(halos, box);
    this.home = choice;
    const h = halos[choice.home];
    this.homeWorld.copy(h.position);
    const virgo = choice.virgo >= 0 ? wrapNear(halos[choice.virgo].position, h.position, box, new THREE.Vector3()).sub(h.position) : null;
    this.boxRotation.copy(boxToGalactic(virgo));
    this.qInv.copy(this.boxRotation).invert();
    // Box fraction of home for the periodic wrap.
    this.state.wrapCenter.set(h.position.x / box + 0.5, h.position.y / box + 0.5, h.position.z / box + 0.5);
    const tmp = new THREE.Vector3();
    this.halos = halos.map((x, index) => ({
      position: wrapNear(x.position, h.position, box, tmp).sub(h.position).applyQuaternion(this.boxRotation).clone(),
      mass: x.mass,
      seed: x.seed,
      index,
    }));
  }

  /** Root (Mpc) → box world coordinates. */
  toWorld(pRoot: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(pRoot).applyQuaternion(this.qInv).add(this.homeWorld);
  }

  /** Nearest halos to a root-frame point (Mpc), up to k. */
  nearestHalos(p: THREE.Vector3, k: number, exclude = -1): UniverseHalo[] {
    const arr = this.halos.filter((h) => h.index !== exclude);
    arr.sort((a, b) => a.position.distanceToSquared(p) - b.position.distanceToSquared(p));
    return arr.slice(0, k);
  }

  render(target: THREE.WebGLRenderTarget, camPosRoot: THREE.Vector3, camQuatRoot: THREE.Quaternion, fov: number, o: UniverseRenderOptions): void {
    const web = this.web;
    if (!web || !this.data || o.exposure <= 0 || (o.darkMatter <= 0 && o.galaxies <= 0)) return;
    const r = this.renderer;
    this.size.set(target.width, target.height);
    const scale = web.opts.detail >= 1 ? 1 : web.opts.detail >= 0.6 ? 0.85 : 0.7;
    const acc = web.accumSize;
    if (Math.abs(acc.width - Math.round(this.size.x * scale)) > 1 || Math.abs(acc.height - Math.round(this.size.y * scale)) > 1) web.resize(this.size.x, this.size.y);
    const c = this.cam;
    c.fov = fov;
    c.aspect = target.width / Math.max(1, target.height);
    c.near = Math.max(1e-4, o.nearFade * 0.5);
    c.far = 1e5;
    this.toWorld(camPosRoot, c.position);
    c.quaternion.copy(this.qInv).multiply(camQuatRoot);
    c.updateProjectionMatrix();
    c.updateMatrixWorld();
    const st = this.state;
    st.exposure = o.exposure;
    st.darkMatter = o.darkMatter;
    st.galaxies = o.galaxies;
    st.fieldGalaxies = o.galaxies;
    web.pixelRatio = o.pixelRatio;
    web.render(target, c, st, true);
    r.setRenderTarget(target);
  }

  dispose(): void {
    this.disposed = true;
    this.web?.dispose();
    this.web = null;
    this.data = null;
  }
}
