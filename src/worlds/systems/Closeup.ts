import * as THREE from 'three';
import { createPlanet, type PlanetRenderer } from '../planet';
import type { PlanetUpdate } from '../planet/types';
import { createStar, type StarRenderer } from '../star';
import { applyObliquity, type BodyEntry, type SystemLayer } from './SystemLayer';
import type { MoonData } from './generate';
import { R_EARTH_KM } from './planets';
import { StarGlare, glareStrength } from './glare';
import { cornerCos, planSlices, ringDistance, shellDistance, type SliceItem } from './slices';

/**
 * A planet at true scale, in its own frame: 1 unit = the planet's radius, planet at the origin.
 * The star(s) sit at their true distances and radii in these units, so from low orbit they have
 * the correct angular size and colour (a red dwarf looms several times larger than our Sun seen
 * from Earth; a hot Jupiter's star fills a quarter of the sky). Moons orbit in the equatorial plane.
 *
 * It *borrows* the planet renderer from the SystemLayer (reparenting its object) so entering and
 * leaving costs nothing; `dispose()` hands it back.
 *
 * Each body is drawn in its own depth slice (near/far bracketing its bounding sphere), far to near,
 * so depth precision holds from 10⁻³ to 10⁷ planet radii.
 */

const AU_KM = 1.495978707e8;
const R_SUN_KM = 695700;
const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();
const tmpC = new THREE.Color();
const tmpQ = new THREE.Quaternion();

/** Star disk-centre radiance relative to the white surface it lights is ≈ π/Ω★ (4.6 × 10⁴ for the
 * Sun at 1 AU); like the Pale Blue Dot experience we draw it ~40× dimmer so bloom stays a glare. */
const STAR_INTENSITY = 30;

interface MoonEntry {
  data: MoonData;
  view: PlanetRenderer;
  pos: THREE.Vector3;
  radius: number;
  /** Surface baked (see update). */
  ready: boolean;
}

/** One body to draw: its own scene (stars) or an object in the shared local scene (planet, moons). */
interface Item extends SliceItem {
  scene: THREE.Scene;
  /** Object toggled per slice in the shared scene; null for a star's own scene. */
  obj: THREE.Object3D | null;
}

const frustum = new THREE.Frustum();
const viewProj = new THREE.Matrix4();

/**
 * Is a sphere (world centre, radius) at least partly inside the four *side* planes of the camera's
 * frustum? Near/far are ignored: every slice sets its own. `frustum` must be built from the camera.
 */
function inSideFrustum(centre: THREE.Vector3, radius: number): boolean {
  for (let k = 0; k < 4; k++) if (frustum.planes[k].distanceToPoint(centre) < -radius) return false;
  return true;
}

export class WorldCloseup {
  readonly body: BodyEntry;
  readonly unitKm: number;
  private layer: SystemLayer;
  private planetScene = new THREE.Scene();
  private starScene = new THREE.Scene();
  private compScene = new THREE.Scene();
  private tilt = new THREE.Group();
  private star: StarRenderer;
  private companion: StarRenderer | null = null;
  readonly starPos = new THREE.Vector3();
  readonly companionPos = new THREE.Vector3();
  readonly starRadius: number;
  readonly companionRadius: number = 0;
  readonly moons: MoonEntry[] = [];
  private prevParent: THREE.Object3D | null;
  private prevScale: number;
  /** Starlight colour × irradiance at the planet (luminance-normalised to the primary). */
  readonly sunColor = new THREE.Color();

  constructor(layer: SystemLayer, index: number, renderer: THREE.WebGLRenderer, detail = 1) {
    this.layer = layer;
    const b = (this.body = layer.bodies[index]);
    const sys = layer.sys;
    this.unitKm = b.data.radius * R_EARTH_KM;
    // Borrow the planet.
    this.prevParent = b.planet.object.parent;
    this.prevScale = b.planet.object.scale.x;
    b.planet.object.scale.setScalar(1);
    applyObliquity(this.tilt, b.data);
    this.tilt.add(b.planet.object);
    this.planetScene.add(this.tilt);

    const s = sys.star;
    this.starRadius = (s.radius * R_SUN_KM) / this.unitKm;
    // A star that fills the sky would drown the frame in coronal glare (a camera would see it, an
    // eye squinting at the planet would not): the K-corona is dimmed as the disk grows.
    const starDeg = (2 * (s.radius * R_SUN_KM)) / (b.data.orbit.a * AU_KM) * (180 / Math.PI);
    const corona = THREE.MathUtils.clamp(1.2 / starDeg, 0.02, 1) * 0.25;
    // Likewise its disk is drawn dimmer as it grows, so limb darkening and granulation stay visible
    // instead of one bloomed blob (the planet is still lit at the true relative irradiance).
    // (Disk-centre radiance is 40 × intensity; a star tens of degrees across ends near ~2, a few
    // times the lit planet, so limb darkening and granulation read instead of a clipped disk.)
    const intensity = STAR_INTENSITY * THREE.MathUtils.clamp(Math.pow(1.2 / starDeg, 2.6), 0.0015, 1);
    this.star = createStar({ seed: sys.seed % 1000, temperatureK: s.teff, radius: this.starRadius, intensity, activity: s.activity, corona: s.stage === 'white-dwarf' ? 0.05 : corona, detail });
    this.starScene.add(this.star.object);
    this.glares.push(this.addGlare(this.star, this.starScene, starDeg));
    if (sys.companion) {
      const c = sys.companion.star;
      this.companionRadius = (c.radius * R_SUN_KM) / this.unitKm;
      this.companion = createStar({ seed: (sys.seed + 7) % 1000, temperatureK: c.teff, radius: this.companionRadius, intensity: STAR_INTENSITY, activity: c.activity, corona: 0.25, detail });
      this.compScene.add(this.companion.object);
      // Distance to the companion: the planet's orbit for a circumbinary pair, else the binary's.
      const dComp = sys.companion.config === 'P' ? b.data.orbit.a : sys.companion.orbit.a;
      const compDeg = (2 * (c.radius * R_SUN_KM)) / (Math.max(dComp, 1e-6) * AU_KM) * (180 / Math.PI);
      // Relative flux sets how hard it glares (fourth root: the eye's compressed response).
      const rel = (c.luminosity / (dComp * dComp)) / (s.luminosity / (b.data.orbit.a * b.data.orbit.a));
      this.glares.push(this.addGlare(this.companion, this.compScene, compDeg, Math.min(1, Math.pow(rel, 0.25))));
    }
    // Moons share the planet's scene (see render): each is baked on a later frame (update →
    // one per frame) and stays hidden until then, so arriving at a giant does not stall on four
    // surface bakes and their read-backs at once.
    for (const m of b.data.moons) {
      const radius = m.radius / b.data.radius;
      const view = createPlanet({ ...m.spec, radius, detail: detail * (m.spec.detail ?? 1) });
      view.object.visible = false;
      this.planetScene.add(view.object);
      this.moons.push({ data: m, view, pos: new THREE.Vector3(), radius, ready: false });
    }
    void renderer;
    this.measureShells();
    // Eclipses: the planet shadows its moons, and the two innermost moons can shadow the planet
    // (lists hold live references; set once).
    const planetOcc = [{ position: ORIGIN, radius: 1 }];
    for (const m of this.moons) m.view.setOccluders(planetOcc);
    b.planet.setOccluders(this.moons.slice(0, 2).map((m) => ({ position: m.pos, radius: m.radius })));
  }

  private glares: Array<StarGlare | null> = [];
  private addGlare(star: StarRenderer, scene: THREE.Scene, diameterDeg: number, flux = 1): StarGlare | null {
    const w = glareStrength(diameterDeg) * flux;
    if (w <= 0.01) return null;
    const g = new StarGlare(star.lightColor, w);
    scene.add(g.mesh);
    return g;
  }

  /** Recompute positions for the SystemLayer's current time (call after layer.setTime). */
  sync(): void {
    const L = this.layer;
    const b = this.body;
    const kmPerUnit = this.unitKm;
    // Star(s): true separation, in planet radii, three.js frame.
    tmp.copy(L.starTruePos).sub(b.truePos).multiplyScalar(AU_KM / kmPerUnit);
    this.starPos.copy(tmp);
    this.star.object.position.copy(tmp);
    this.glares[0]?.mesh.position.copy(tmp);
    if (this.companion) {
      tmp.copy(L.companionTruePos).sub(b.truePos).multiplyScalar(AU_KM / kmPerUnit);
      this.companionPos.copy(tmp);
      this.companion.object.position.copy(tmp);
      this.glares[1]?.mesh.position.copy(tmp);
    }
    // Moons: circular orbits in the (tilted) equatorial plane.
    const t = L.time;
    for (const m of this.moons) {
      const ang = m.data.M0 + (2 * Math.PI * t) / m.data.periodDays;
      tmp.set(Math.cos(ang) * m.data.a, Math.sin(m.data.inclination) * Math.sin(ang) * m.data.a, -Math.sin(ang) * m.data.a);
      tmp.applyEuler(this.tilt.rotation);
      m.pos.copy(tmp);
      m.view.object.position.copy(tmp);
      // Moons are tidally locked to their planet.
      m.view.setRotation(ang + Math.PI);
    }
  }

  /**
   * Where to look for "the sun(s)": the primary, or — when a companion is within ~70° of it in
   * this planet's sky — the midpoint of the pair, so a double sunset frames both stars.
   */
  skyDirection(out: THREE.Vector3): THREE.Vector3 {
    out.copy(this.starPos).normalize();
    if (!this.companion) return out;
    tmp.copy(this.companionPos).normalize();
    if (out.dot(tmp) < 0.34) return out;
    return out.add(tmp).normalize();
  }

  /** Direction to the (primary) star, unit vector. */
  starDirection(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.starPos).normalize();
  }

  update(camera: THREE.Camera, renderer: THREE.WebGLRenderer, timeSec: number): void {
    const L = this.layer;
    const b = this.body;
    const sys = L.sys;
    // True-exposure lighting: the planet is lit at irradiance 1 (the camera exposes for it);
    // a companion adds its flux ratio and colour.
    L.lightColorAt(b.truePos, this.sunColor);
    const sunPos = sys.companion?.config === 'P' ? this.lampPos(tmp2) : this.starPos;
    const angR = this.starRadius / Math.max(this.starPos.length(), 1e-9);
    // One reusable argument object (no per-frame garbage); renderers copy what they keep.
    const pu = this.pu;
    pu.time = timeSec;
    pu.sunPosition = sunPos;
    pu.sunColor = this.sunColor;
    pu.camera = camera;
    pu.sunAngularRadius = angR;
    pu.renderer = renderer;
    b.planet.update(pu);
    b.eyeball?.update(tmp.copy(sunPos).normalize(), this.sunColor);
    this.su.time = timeSec;
    this.su.camera = camera;
    this.star.update(this.su);
    this.companion?.update(this.su);
    pu.sunColor = tmpC;
    let baked = false;
    for (const m of this.moons) {
      if (!m.ready) {
        // At most one moon bake per frame (an update with a renderer would bake it now).
        if (baked) continue;
        m.view.prepare(renderer);
        m.ready = baked = true;
        m.view.object.visible = true;
      }
      tmpC.copy(this.sunColor);
      m.view.update(pu);
    }
  }

  private pu: PlanetUpdate = { time: 0, sunPosition: new THREE.Vector3(), camera: new THREE.PerspectiveCamera() };
  private su: { time: number; camera: THREE.Camera } = { time: 0, camera: this.pu.camera };

  private lampPos(out: THREE.Vector3): THREE.Vector3 {
    const sys = this.layer.sys;
    const L1 = sys.star.luminosity, L2 = sys.companion!.star.luminosity;
    return out.copy(this.starPos).multiplyScalar(L1 / (L1 + L2)).addScaledVector(this.companionPos, L2 / (L1 + L2));
  }

  /* ——— Depth slices ——— */

  /** Radial extent [lo, hi] of each of the planet's shell-like meshes (surface proxy, air, ice). */
  private shells: number[] = [];
  private ring: { inner: number; outer: number } | null = null;

  private measureShells(): void {
    const f = Math.min(Math.max(this.body.data.spec.oblateness ?? 0, 0), 0.3);
    this.body.planet.object.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const g = mesh.geometry as THREE.BufferGeometry & { parameters?: { innerRadius?: number; outerRadius?: number } };
      if (g.type === 'RingGeometry' && g.parameters?.innerRadius !== undefined) {
        this.ring = { inner: g.parameters.innerRadius, outer: g.parameters.outerRadius! };
        return;
      }
      const pos = g.getAttribute('position');
      if (!pos) return;
      let lo = Infinity, hi = 0;
      for (let i = 0; i < pos.count; i++) {
        const r = Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i));
        lo = Math.min(lo, r);
        hi = Math.max(hi, r);
      }
      // The surface proxy is inflated in the vertex shader by up to 3.5 % (Planet: uProxyScale);
      // shells may be flattened by the spin (oblateness). Widen the band to cover both.
      const inflate = mesh.name === 'planet-surface' ? 1.037 : 1.001;
      this.shells.push(lo * (1 - f) * 0.999, hi * inflate);
    });
  }

  /** Distance from the camera to the nearest planet geometry, or 0 when it may touch some. */
  private nearestPlanetGeometry(camPos: THREE.Vector3): number {
    const d = camPos.length();
    let best = Infinity;
    for (let i = 0; i < this.shells.length; i += 2) best = Math.min(best, shellDistance(d, this.shells[i], this.shells[i + 1]));
    if (this.ring) {
      const p = tmp.copy(camPos).applyQuaternion(tmpQ.copy(this.tilt.quaternion).invert());
      best = Math.min(best, ringDistance(p.x, p.y, p.z, this.ring.inner, this.ring.outer));
    }
    return Number.isFinite(best) ? best : 0;
  }

  /** Body records, reused every frame (no per-frame garbage). */
  private pool: Item[] = [];
  private order: Item[] = [];
  private ranges: number[] = [];
  /** Number of depth slices (render passes) drawn in the last frame (debug / cost accounting). */
  slicesDrawn = 0;

  private item(k: number, scene: THREE.Scene, obj: THREE.Object3D | null, centre: THREE.Vector3, radius: number, camera: THREE.Camera): Item | null {
    // View-space depth (what the clip planes test), not Euclidean distance: an off-axis star at
    // depth d·cos θ would otherwise fall in front of the near plane.
    const z = -tmp.copy(centre).applyMatrix4(camera.matrixWorldInverse).z;
    if (z + radius <= 0) return null; // entirely behind the camera
    if (!inSideFrustum(centre, radius)) return null; // entirely off-screen
    const it = (this.pool[k] ??= { scene, obj, near: 0, far: 0, dist: 0, solo: false, slice: 0 });
    it.scene = scene;
    it.obj = obj;
    it.dist = camera.position.distanceTo(centre);
    it.near = Math.max(z - radius, it.dist * 1e-6, 1e-6);
    it.far = Math.max(z + radius, it.near * 4);
    it.solo = obj === null;
    return it;
  }

  private glareHalf(i: number, camera: THREE.PerspectiveCamera): number {
    const g = this.glares[i];
    return g ? g.orient(camera, 0.09) * Math.SQRT1_2 : 0;
  }

  /**
   * Draw far → near in depth slices. Every `renderer.render()` into a multisampled target ends with
   * a full-screen MSAA resolve (three.js blits after each call), so: bodies wholly outside the view
   * are skipped; the planet and its moons share one slice whenever their depth range fits one
   * buffer (see slices.ts); stars keep their own (their glare ignores depth and must precede the
   * planet that hides it behind the limb).
   */
  render(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera): void {
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
    frustum.setFromProjectionMatrix(viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const cp = camera.position;
    const sl = this.order;
    sl.length = 0;
    let k = 0;
    let it = this.item(k++, this.starScene, null, this.starPos, Math.max(this.starRadius * 7, this.glareHalf(0, camera)), camera);
    if (it) sl.push(it);
    if (this.companion) {
      it = this.item(k++, this.compScene, null, this.companionPos, Math.max(this.companionRadius * 7, this.glareHalf(1, camera)), camera);
      if (it) sl.push(it);
    }
    for (let i = 0; i < this.moons.length; i++) {
      const m = this.moons[i];
      if (!m.ready) continue;
      it = this.item(k++, this.planetScene, m.view.object, m.pos, m.radius * 1.1, camera);
      if (it) sl.push(it);
    }
    const ringR = this.body.data.spec.rings ? this.body.data.spec.rings.outer * 1.05 : 1.2;
    const pl = this.item(k++, this.planetScene, this.tilt, ORIGIN, ringR, camera);
    if (pl) {
      // Camera inside the bounding sphere (low orbit): bound the near plane by the distance to the
      // nearest real geometry instead of letting it collapse to 10⁻⁶.
      const g = this.nearestPlanetGeometry(cp) * cornerCos(camera.projectionMatrix.elements) * 0.9;
      if (g > pl.near) {
        pl.near = g;
        pl.far = Math.max(pl.far, g * 4);
      }
      sl.push(pl);
    }
    sl.sort(byDistanceDesc);
    const ranges = this.ranges;
    const n = planSlices(sl, ranges);
    for (let s = 0; s < n; s++) {
      let scene: THREE.Scene | null = null;
      for (const x of sl) {
        if (x.slice !== s) continue;
        scene = x.scene;
        break;
      }
      if (!scene) continue;
      // The shared scene: show only this slice's bodies.
      if (scene === this.planetScene) this.showLocal(s);
      renderer.clearDepth();
      camera.near = ranges[2 * s];
      camera.far = ranges[2 * s + 1];
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
    }
    this.showLocal(-1);
    this.slicesDrawn = n;
  }

  /** Visibility in the shared local scene: bodies of slice `s` only (−1: restore all ready bodies). */
  private showLocal(s: number): void {
    this.tilt.visible = false;
    for (const m of this.moons) m.view.object.visible = false;
    if (s < 0) {
      this.tilt.visible = true;
      for (const m of this.moons) m.view.object.visible = m.ready;
      return;
    }
    for (const it of this.order) if (it.slice === s && it.obj) it.obj.visible = true;
  }

  /** Return the planet to the system view and free the close-up's own resources. */
  dispose(): void {
    this.body.planet.setOccluders([]);
    const obj = this.body.planet.object;
    obj.scale.setScalar(this.prevScale);
    if (this.prevParent) this.prevParent.add(obj);
    for (const g of this.glares) g?.dispose();
    this.star.dispose();
    this.companion?.dispose();
    for (const m of this.moons) m.view.dispose();
  }
}

const ORIGIN = new THREE.Vector3();
const byDistanceDesc = (a: Item, b: Item) => b.dist - a.dist;
