import * as THREE from 'three';
import { createPlanet, type PlanetRenderer } from '../planet';
import { createStar, type StarRenderer } from '../star';
import type { BodyEntry, SystemLayer } from './SystemLayer';
import type { MoonData } from './generate';
import { R_EARTH_KM } from './planets';

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

/** Star disk-centre radiance relative to the white surface it lights is ≈ π/Ω★ (4.6 × 10⁴ for the
 * Sun at 1 AU); like the Pale Blue Dot experience we draw it ~40× dimmer so bloom stays a glare. */
const STAR_INTENSITY = 30;

interface MoonEntry {
  data: MoonData;
  view: PlanetRenderer;
  pos: THREE.Vector3;
  radius: number;
}

interface Slice {
  scene: THREE.Scene;
  centre: THREE.Vector3;
  radius: number;
  dist: number;
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
  private moonScenes: THREE.Scene[] = [];
  private slices: Slice[] = [];
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
    this.tilt.rotation.z = b.data.axialTilt;
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
    const intensity = STAR_INTENSITY * THREE.MathUtils.clamp(1.5 / starDeg, 0.06, 1);
    this.star = createStar({ seed: sys.seed % 1000, temperatureK: s.teff, radius: this.starRadius, intensity, activity: s.activity, corona: s.stage === 'white-dwarf' ? 0.05 : corona, detail });
    this.starScene.add(this.star.object);
    if (sys.companion) {
      const c = sys.companion.star;
      this.companionRadius = (c.radius * R_SUN_KM) / this.unitKm;
      this.companion = createStar({ seed: (sys.seed + 7) % 1000, temperatureK: c.teff, radius: this.companionRadius, intensity: STAR_INTENSITY, activity: c.activity, corona: 0.25, detail });
      this.compScene.add(this.companion.object);
    }
    for (const m of b.data.moons) {
      const radius = m.radius / b.data.radius;
      const view = createPlanet({ ...m.spec, radius, detail: detail * (m.spec.detail ?? 1) });
      view.prepare(renderer);
      const sc = new THREE.Scene();
      sc.add(view.object);
      this.moonScenes.push(sc);
      this.moons.push({ data: m, view, pos: new THREE.Vector3(), radius });
    }
    // Eclipses: the planet shadows its moons, and the two innermost moons can shadow the planet
    // (lists hold live references; set once).
    const planetOcc = [{ position: ORIGIN, radius: 1 }];
    for (const m of this.moons) m.view.setOccluders(planetOcc);
    b.planet.setOccluders(this.moons.slice(0, 2).map((m) => ({ position: m.pos, radius: m.radius })));
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
    if (this.companion) {
      tmp.copy(L.companionTruePos).sub(b.truePos).multiplyScalar(AU_KM / kmPerUnit);
      this.companionPos.copy(tmp);
      this.companion.object.position.copy(tmp);
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
    b.planet.update({ time: timeSec, sunPosition: sunPos, sunColor: this.sunColor, camera, sunAngularRadius: angR, renderer });
    b.eyeball?.update(tmp.copy(sunPos).normalize(), this.sunColor);
    this.star.update({ time: timeSec, camera });
    this.companion?.update({ time: timeSec, camera });
    for (const m of this.moons) {
      tmpC.copy(this.sunColor);
      m.view.update({ time: timeSec, sunPosition: sunPos, sunColor: tmpC, camera, sunAngularRadius: angR, renderer });
    }
  }

  private lampPos(out: THREE.Vector3): THREE.Vector3 {
    const sys = this.layer.sys;
    const L1 = sys.star.luminosity, L2 = sys.companion!.star.luminosity;
    return out.copy(this.starPos).multiplyScalar(L1 / (L1 + L2)).addScaledVector(this.companionPos, L2 / (L1 + L2));
  }

  render(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera): void {
    const sl = this.slices;
    sl.length = 0;
    const cp = camera.position;
    sl.push({ scene: this.starScene, centre: this.starPos, radius: this.starRadius * 7, dist: cp.distanceTo(this.starPos) });
    if (this.companion) sl.push({ scene: this.compScene, centre: this.companionPos, radius: this.companionRadius * 7, dist: cp.distanceTo(this.companionPos) });
    this.moons.forEach((m, i) => sl.push({ scene: this.moonScenes[i], centre: m.pos, radius: m.radius * 1.1, dist: cp.distanceTo(m.pos) }));
    const ringR = this.body.data.spec.rings ? this.body.data.spec.rings.outer * 1.05 : 1.2;
    sl.push({ scene: this.planetScene, centre: ORIGIN, radius: ringR, dist: cp.length() });
    sl.sort((a, b) => b.dist - a.dist);
    for (const s of sl) {
      renderer.clearDepth();
      const d = s.dist;
      camera.near = Math.max(d - s.radius, d * 1e-6, 1e-6);
      camera.far = Math.max(d + s.radius, camera.near * 4);
      camera.updateProjectionMatrix();
      renderer.render(s.scene, camera);
    }
  }

  /** Return the planet to the system view and free the close-up's own resources. */
  dispose(): void {
    this.body.planet.setOccluders([]);
    const obj = this.body.planet.object;
    obj.scale.setScalar(this.prevScale);
    if (this.prevParent) this.prevParent.add(obj);
    this.star.dispose();
    this.companion?.dispose();
    for (const m of this.moons) m.view.dispose();
  }
}

const ORIGIN = new THREE.Vector3();
