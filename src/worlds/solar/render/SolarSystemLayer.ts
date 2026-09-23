/**
 * SolarSystemLayer — renders a SolarSystemModel in AU with camera-relative precision.
 *
 *  - Camera-relative placement: every object is positioned at (body − camera) computed in float64,
 *    so float32 on the GPU stays precise from a comet nucleus to the Oort cloud.
 *  - Depth slicing (DepthSlices.ts): resolved bodies get tight near/far ranges; lines and points
 *    fill the gaps. Saturn's rings, its moons and the orbit of Neptune all render without z-fighting.
 *  - Bodies: the Sun via createStar, planets/moons via createPlanet (lazily, when first resolved),
 *    irregular bodies via Rocks.ts. Unresolved bodies are PSF sprites (BodySprites.ts).
 *  - Scale honesty: 'true' scale, or 'enlarged' (planets ×N, Sun ×min(N, 10)); the system of the
 *    focused body always returns to true scale, animated in step with the camera flight.
 *  - Orbits (one draw call), small-body belts on GPU Kepler orbits, DOM labels, picking.
 *
 * Voyage integration: construct with a model, call setCamera()/setSize()/update()/render() each
 * frame; use pick(), screenOf(), displayRadius() and the per-body hooks (onBodyObject).
 */
import * as THREE from 'three';
import type { PlanetView, StarView, PlanetSpec } from '../../planet/types';
import { createPlanet } from '../../planet';
import { createStar } from '../../star';
import { blackbodyRGB } from '../../../physics/blackbody';
import { hashString } from '../../../physics/random';
import type { QualityProfile } from '../../../core/Engine';
import { SolarSystemModel, makeOrbitGeometry, type SolarBody, type OrbitGeometry } from '../SolarSystemModel';
import { OrbitLines, MAX_ORBITS, type OrbitSlot } from './OrbitLines';
import { BodySprites } from './BodySprites';
import { BeltPoints } from './BeltPoints';
import { DepthSlicer } from './DepthSlices';
import { Labels, type LabelCandidate } from './Labels';
import { rockGeometry, rockMaterial } from './Rocks';
import { sampleHildas, sampleKuiper, sampleMainBelt, sampleNEAs, sampleOort, sampleTrojans } from '../belts';

export type ScaleMode = 'true' | 'enlarged';

export interface SolarLayerSettings {
  orbits: boolean;
  labels: boolean;
  moons: boolean;
  /** Main belt, Hildas, Trojans, near-Earth asteroids and named asteroids. */
  asteroids: boolean;
  /** Kuiper belt, scattered disc and trans-Neptunian dwarfs. */
  kuiper: boolean;
  comets: boolean;
  spacecraft: boolean;
  /** The (hypothetical) Oort cloud, shown only from far out. */
  oort: boolean;
  scaleMode: ScaleMode;
  /** Enlargement factor for planets in 'enlarged' mode. */
  enlarge: number;
  /** 1 = true eccentricities; 0 = every small body on a circle at its semi-major axis. */
  beltEccentricity: number;
  /** Exponent of the sunlight falloff used for shading (2 = physical 1/r², 1 = compressed for visibility). */
  lightFalloff: number;
}

export const defaultLayerSettings = (): SolarLayerSettings => ({
  orbits: true,
  labels: true,
  moons: true,
  asteroids: true,
  kuiper: true,
  comets: true,
  spacecraft: true,
  oort: true,
  scaleMode: 'true',
  enlarge: 600,
  beltEccentricity: 1,
  lightFalloff: 1.1,
});

/** Per-body render state. */
export interface BodyRender {
  readonly body: SolarBody;
  readonly color: THREE.Color;
  planet: PlanetView | null;
  star: StarView | null;
  rock: THREE.Mesh | null;
  object: THREE.Object3D | null;
  /** Radius the view was created with (AU). */
  baseRadius: number;
  /** Bounding radius / display radius (rings, atmospheres, coronae). */
  bound: number;
  scale: number;
  target: number;
  readonly rel: THREE.Vector3;
  dist: number;
  /** Rendered radius on screen (device px). */
  radiusPx: number;
  /** Screen position (CSS px) and whether in front of the camera. */
  sx: number;
  sy: number;
  front: boolean;
  shown: boolean;
  /** 0..1 how much the point sprite is used. */
  sprite: number;
  failed: boolean;
}

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qSpin = new THREE.Quaternion();
const Y = new THREE.Vector3(0, 1, 0);
const _geom: OrbitGeometry = makeOrbitGeometry();
const _slot: OrbitSlot = {
  P: new THREE.Vector3(),
  Q: new THREE.Vector3(),
  a: 1,
  b: 1,
  e: 0,
  hyperbolic: false,
  anomaly: 0,
  rangeBack: -Math.PI,
  rangeAhead: Math.PI,
  bodyRel: new THREE.Vector3(),
  color: new THREE.Color(),
  alpha: 0,
  bodyRadius: 0,
  trail: 1,
};

const srgbToLinear = (hex: string) => new THREE.Color(hex); // three.Color parses CSS hex as sRGB → linear working space

export class SolarSystemLayer {
  readonly model: SolarSystemModel;
  readonly scene = new THREE.Scene();
  /** Camera at the origin (camera-relative rendering); near/far are set per depth slice. */
  readonly camera = new THREE.PerspectiveCamera(50, 1, 1e-9, 1e7);
  /** Camera position, heliocentric J2000-ecliptic (three.js axes), AU — float64. */
  readonly cameraPosition = new THREE.Vector3(0, 0, 3);
  readonly settings: SolarLayerSettings;
  readonly bodies: BodyRender[] = [];
  readonly byId = new Map<string, BodyRender>();
  /** Body whose system is shown at true scale and highlighted (null = none). */
  focus: SolarBody | null = null;
  /** Body drawn as selected (label accent, brighter orbit). */
  selected: SolarBody | null = null;
  /** Post exposure (overlays such as orbit lines divide by it to keep constant display brightness). */
  exposure = 1;
  /** Called after a body's 3D object is created (for per-body detail hooks). */
  onBodyObject: ((r: BodyRender) => void) | null = null;
  readonly belts: { main: BeltPoints; hildas: BeltPoints; trojans: BeltPoints; neas: BeltPoints; kuiper: BeltPoints; oort: BeltPoints };
  readonly labels: Labels | null;

  private renderer: THREE.WebGLRenderer;
  private detail: number;
  private orbits = new OrbitLines();
  private sprites: BodySprites;
  private slicer = new DepthSlicer();
  private width = 1;
  private height = 1;
  private cssW = 1;
  private cssH = 1;
  private pixelRatio = 1;
  private pixelAngle = 1e-3;
  private time = 0;
  private sunColor = new THREE.Color();
  private starRGB: [number, number, number];
  private labelCands: LabelCandidate[] = [];
  private creationsThisFrame = 0;
  private maxPointSize = 64;
  private orbitAlpha = new Float32Array(256);
  private sunRel = new THREE.Vector3();
  private planetColor = new THREE.Color();
  private rockGeos = new Map<string, THREE.BufferGeometry>();
  private disposed = false;

  constructor(
    renderer: THREE.WebGLRenderer,
    model: SolarSystemModel,
    o: { quality: QualityProfile; overlay?: HTMLElement | null; onLabelPick?: (id: string) => void; settings?: Partial<SolarLayerSettings> },
  ) {
    this.renderer = renderer;
    this.model = model;
    this.detail = o.quality.detail;
    this.settings = { ...defaultLayerSettings(), ...(o.settings ?? {}) };
    this.starRGB = blackbodyRGB(5772);
    for (const b of model.bodies) {
      const r: BodyRender = {
        body: b,
        color: srgbToLinear(b.def.color),
        planet: null,
        star: null,
        rock: null,
        object: null,
        baseRadius: b.radius,
        bound: 1.05,
        scale: 1,
        target: 1,
        rel: new THREE.Vector3(),
        dist: 1,
        radiusPx: 0,
        sx: 0,
        sy: 0,
        front: false,
        shown: false,
        sprite: 0,
        failed: false,
      };
      this.bodies.push(r);
      this.byId.set(b.id, r);
      this.labelCands.push({ id: b.id, text: b.def.name, x: 0, y: 0, priority: b.def.priority, strength: 0, radius: 0, selected: false, tint: b.def.color });
    }
    this.sprites = new BodySprites(model.bodies.length + 4);
    this.scene.add(this.orbits.object, this.sprites.object);
    const d = this.detail;
    const n = (x: number) => Math.max(500, Math.round(x * d));
    // Reference fluxes chosen so a 10 km, p = 0.1 asteroid at r = 2.7 AU, Δ = 2 AU is display ≈ 1.
    const fluxRef = 0.1 * (10 * 6.6845871e-9) ** 2 / (2.7 * 2.7 * 2 * 2);
    this.belts = {
      main: new BeltPoints(sampleMainBelt(n(60000)), { brightness: 0.05, gamma: 0.42, fluxRef }, 6),
      hildas: new BeltPoints(sampleHildas(n(3500)), { brightness: 0.055, gamma: 0.42, fluxRef }, 6),
      trojans: new BeltPoints(sampleTrojans(n(9000)), { brightness: 0.055, gamma: 0.42, fluxRef }, 7),
      neas: new BeltPoints(sampleNEAs(n(1500)), { brightness: 0.04, gamma: 0.42, fluxRef }, 5),
      kuiper: new BeltPoints(sampleKuiper(n(36000)), { brightness: 0.05, gamma: 0.36, fluxRef: fluxRef * 1e-4 }, 1200),
      oort: new BeltPoints(sampleOort(n(16000)), { brightness: 0.05, gamma: 0.3, fluxRef: fluxRef * 1e-9 }, 2e5),
    };
    for (const b of Object.values(this.belts)) this.scene.add(b.object);
    this.labels = o.overlay ? new Labels(o.overlay, (id) => o.onLabelPick?.(id)) : null;
    const gl = renderer.getContext();
    const range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array | number[] | null;
    this.maxPointSize = Math.max(16, Math.min(128, range ? range[1] : 64));
  }

  get(id: string): BodyRender | undefined {
    return this.byId.get(id);
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.width = width;
    this.height = height;
    this.pixelRatio = pixelRatio;
    this.cssW = width / pixelRatio;
    this.cssH = height / pixelRatio;
    this.camera.aspect = width / Math.max(1, height);
    this.orbits.setViewport(width, height, pixelRatio);
  }

  /** Camera pose: position (AU, heliocentric, float64), orientation and vertical field of view (deg). */
  setCamera(position: THREE.Vector3, quaternion: THREE.Quaternion, fovDeg: number): void {
    this.cameraPosition.copy(position);
    this.camera.position.set(0, 0, 0);
    this.camera.quaternion.copy(quaternion);
    this.camera.fov = fovDeg;
    this.camera.near = 1e-9;
    this.camera.far = 1e7;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
  }

  /** Display radius (AU) of a body right now (includes enlargement). */
  displayRadius(b: SolarBody): number {
    const r = this.byId.get(b.id);
    return b.radius * (r ? r.scale : 1);
  }

  /** Radians per device pixel. */
  get radPerPixel(): number {
    return this.pixelAngle;
  }

  /** Is `b` part of the focused system (the focus itself, its moons, or its parent planet and siblings)? */
  private inFocusSystem(b: SolarBody): boolean {
    const f = this.focus;
    if (!f) return false;
    if (b === f) return true;
    const sys = f.def.kind === 'moon' ? f.parent : f;
    return b === sys || b.parent === sys;
  }

  private targetScale(b: SolarBody): number {
    const s = this.settings;
    if (s.scaleMode === 'true') return 1;
    if (this.inFocusSystem(b)) return 1;
    const N = Math.max(1, s.enlarge);
    switch (b.def.kind) {
      case 'star':
        return Math.min(N, 10);
      case 'spacecraft':
        return 1;
      default:
        return N;
    }
  }

  private categoryVisible(b: SolarBody): boolean {
    const s = this.settings;
    const d = b.def;
    if (!b.active) return false;
    switch (d.kind) {
      case 'moon':
        return s.moons;
      case 'comet':
        return s.comets;
      case 'spacecraft':
        return s.spacecraft;
      case 'asteroid':
        return b.sunDistance > 20 ? s.kuiper : s.asteroids;
      case 'dwarf':
        return b.sunDistance > 20 ? s.kuiper || d.id === 'pluto' || d.id === 'eris' : true;
      default:
        return true;
    }
  }

  /** Sunlight multiplier at heliocentric distance r (AU). */
  sunIntensity(r: number): number {
    return Math.pow(Math.max(r, 0.005), -this.settings.lightFalloff);
  }

  private createObject(r: BodyRender): void {
    const b = r.body;
    const def = b.def;
    const seed = hashString(def.id) % 100000;
    try {
      if (def.kind === 'star') {
        r.star = createStar({ seed, temperatureK: 5772, radius: b.radius, intensity: 1, activity: 0.55, corona: 1, detail: this.detail });
        r.object = r.star.object;
      } else if (def.planet) {
        const spec: PlanetSpec = { ...def.planet, seed, radius: b.radius, detail: this.detail } as PlanetSpec;
        if (def.radiiKm && !spec.oblateness) {
          const f = 1 - def.radiiKm[2] / def.radiiKm[0];
          if (f > 0.001) spec.oblateness = f;
        }
        r.planet = createPlanet(spec);
        r.object = r.planet.object;
      } else {
        const shape = def.shape ?? 'irregular';
        const key = `${def.id}:${shape}`;
        let g = this.rockGeos.get(key);
        if (!g) {
          g = rockGeometry(def.id, shape, this.detail > 0.8 ? 5 : 4);
          this.rockGeos.set(key, g);
        }
        const albedo = new THREE.Color(def.color).multiplyScalar(Math.min(1.2, 0.25 + 1.6 * def.albedo));
        r.rock = new THREE.Mesh(g, rockMaterial(albedo, seed));
        r.object = r.rock;
        r.baseRadius = 1; // unit geometry, scaled by radii each frame
      }
      if (r.object) {
        r.object.matrixAutoUpdate = true;
        this.scene.add(r.object);
        // Bounding radius relative to the created radius (rings, atmosphere, corona).
        if (!r.rock) {
          const box = new THREE.Box3().setFromObject(r.object);
          const sph = box.getBoundingSphere(new THREE.Sphere());
          r.bound = Math.max(1.05, isFinite(sph.radius) && sph.radius > 0 ? sph.radius / b.radius : 1.05);
          if (def.planet?.rings) r.bound = Math.max(r.bound, def.planet.rings.outer * 1.02);
        } else r.bound = 1.1;
        this.onBodyObject?.(r);
      }
    } catch (err) {
      console.error(`solar: could not create ${def.id}`, err);
      r.failed = true;
    }
  }

  /** Advance to jd (TT). `time` is the real clock (s) for animated surfaces; `dt` real seconds. */
  update(jd: number, time: number, dt: number): void {
    if (this.disposed) return;
    const model = this.model;
    if (jd !== model.jd) model.update(jd);
    this.time = time;
    this.creationsThisFrame = 0;
    const cam = this.cameraPosition;
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    this.pixelAngle = (2 * Math.tan(fov / 2)) / Math.max(1, this.height);
    const pa = this.pixelAngle;
    this.sunRel.copy(cam).negate();
    const kScale = 1 - Math.exp(-Math.max(dt, 0) / 0.45);
    const expo = Math.max(1e-6, this.exposure);
    this.sprites.begin();
    this.slicer.begin();

    // 1. Placement, scale, visibility.
    for (const r of this.bodies) {
      const b = r.body;
      r.target = this.targetScale(b);
      r.scale = dt > 0 ? Math.exp(Math.log(r.scale) + (Math.log(r.target) - Math.log(r.scale)) * kScale) : r.target;
      if (Math.abs(r.scale / r.target - 1) < 1e-4) r.scale = r.target;
      r.rel.subVectors(b.position, cam);
      r.dist = Math.max(r.rel.length(), 1e-15);
      const Rd = b.radius * r.scale;
      r.radiusPx = Rd / r.dist / pa;
      let vis = this.categoryVisible(b);
      // Enlarged moons that would sit inside their enlarged parent are hidden (their orbits can't be drawn honestly).
      if (vis && b.def.kind === 'moon' && b.parent) {
        const pr = this.byId.get(b.parent.id)!;
        const clear = b.local.length() / (b.parent.radius * pr.scale + Rd);
        if (clear < 1.6) vis = false;
      }
      r.shown = vis;
      // Screen position.
      _v.copy(r.rel).applyMatrix4(this.camera.matrixWorldInverse);
      r.front = _v.z < 0;
      if (r.front) {
        _w.copy(_v).applyMatrix4(this.camera.projectionMatrix);
        r.sx = (_w.x * 0.5 + 0.5) * this.cssW;
        r.sy = (-_w.y * 0.5 + 0.5) * this.cssH;
      }
      // 3D object: create lazily once it is about to be resolved (≤ 2 creations per frame).
      const wantMesh = vis && r.radiusPx > 0.45;
      if (wantMesh && !r.object && !r.failed && this.creationsThisFrame < 2) {
        this.creationsThisFrame++;
        this.createObject(r);
      }
      if (r.object) {
        r.object.visible = wantMesh;
        if (wantMesh) this.place(r, Rd);
      }
    }

    // 2. Sprites for unresolved bodies (and the Sun's point core when it is small).
    for (const r of this.bodies) {
      if (!r.shown) {
        r.sprite = 0;
        continue;
      }
      const b = r.body;
      const w = 1 - THREE.MathUtils.smoothstep(r.radiusPx, 1.0, 2.6);
      r.sprite = w;
      if (w <= 0 || !r.front) continue;
      // Hide a moon's point inside its parent's glare.
      if (b.def.kind === 'moon' && b.parent) {
        const pr = this.byId.get(b.parent.id)!;
        const sepPx = b.local.length() / r.dist / pa;
        if (sepPx < pr.radiusPx + 2.5) continue;
      }
      if (b.def.kind === 'star') {
        // Energy-conserving disc flux with exposure compression so the Sun stays the brightest star.
        const disc = Math.PI * r.radiusPx * r.radiusPx * 4.0;
        const I = Math.max(disc, 0) * Math.pow(Math.max(r.dist, 1), 1.25) * 2.5;
        this.sprites.add(r.rel, I * this.starRGB[0], I * this.starRGB[1], I * this.starRGB[2], 0.65 * this.pixelRatio);
        continue;
      }
      // Reflected flux of a Lambert sphere: p · Φ(α) · (π R²px) · ⅔ · I(r).
      const rs = b.sunDistance;
      _v.copy(b.position).negate(); // body → Sun
      const cosA = _v.dot(_w.copy(r.rel).negate()) / (Math.max(rs, 1e-12) * r.dist);
      const alpha = Math.acos(THREE.MathUtils.clamp(cosA, -1, 1));
      const phase = (Math.sin(alpha) + (Math.PI - alpha) * Math.cos(alpha)) / Math.PI;
      const albedo = b.def.kind === 'comet' ? 0.3 : b.def.albedo;
      const flux = albedo * Math.max(phase, 0.03) * Math.PI * r.radiusPx * r.radiusPx * (2 / 3) * this.sunIntensity(rs);
      const floor = b.def.kind === 'planet' ? 0.06 : b.def.kind === 'dwarf' ? 0.035 : b.def.kind === 'spacecraft' ? 0.03 : 0.018;
      const I = Math.max(floor, 2.2 * Math.pow(flux, 0.42)) * w / expo;
      const c = b.def.kind === 'spacecraft' ? this.planetColor.setRGB(1, 0.8, 0.6) : r.color;
      const tint = 0.55; // colour saturation of the points
      const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
      const cr = (lum + (c.r - lum) * tint) / Math.max(lum, 1e-3);
      const cg = (lum + (c.g - lum) * tint) / Math.max(lum, 1e-3);
      const cb = (lum + (c.b - lum) * tint) / Math.max(lum, 1e-3);
      this.sprites.add(r.rel, I * cr, I * cg, I * cb, 0.62 * this.pixelRatio);
    }
    this.sprites.end();

    // 3. Depth intervals of every visible mesh.
    for (const r of this.bodies) {
      if (!r.object || !r.object.visible) continue;
      const R = r.body.radius * r.scale * r.bound;
      this.slicer.add(r.dist, R, 1e-12);
    }

    // 4. Orbits.
    this.updateOrbits(expo);

    // 5. Belts.
    const s = this.settings;
    const camR = cam.length();
    const bm = this.belts;
    for (const k of ['main', 'hildas', 'trojans', 'neas', 'kuiper', 'oort'] as const) {
      const belt = bm[k];
      let fade: number;
      if (k === 'oort') fade = s.oort ? THREE.MathUtils.smoothstep(camR, 400, 3000) : 0;
      else if (k === 'kuiper') fade = s.kuiper ? 1 : 0;
      else fade = s.asteroids ? 1 - THREE.MathUtils.smoothstep(camR, 400, 3000) : 0;
      belt.fade = fade / expo;
      if (fade > 0) {
        belt.update(jd, this.sunRel, pa, this.pixelRatio, this.maxPointSize);
        belt.eccentricity = k === 'oort' ? 1 : s.beltEccentricity;
      }
    }
  }

  private place(r: BodyRender, Rd: number): void {
    const b = r.body;
    const o = r.object!;
    o.position.copy(r.rel);
    if (r.rock) {
      _qSpin.setFromAxisAngle(Y, b.spin);
      o.quaternion.copy(b.quaternion).multiply(_qSpin);
      o.scale.copy(b.radii).multiplyScalar(r.scale);
      const m = r.rock.material as THREE.ShaderMaterial;
      _v.copy(this.sunRel).applyMatrix4(this.camera.matrixWorldInverse);
      (m.uniforms.uSunView.value as THREE.Vector3).copy(_v);
      const I = this.sunIntensity(b.sunDistance);
      (m.uniforms.uSunColor.value as THREE.Color).setRGB(I * this.starRGB[0], I * this.starRGB[1], I * this.starRGB[2]);
      return;
    }
    o.quaternion.copy(b.quaternion);
    o.scale.setScalar(Rd / r.baseRadius);
    if (r.planet) {
      r.planet.setRotation(b.spin);
      const I = this.sunIntensity(b.sunDistance);
      this.sunColor.setRGB(I * this.starRGB[0], I * this.starRGB[1], I * this.starRGB[2]);
      r.planet.update({
        time: this.time,
        sunPosition: this.sunRel,
        sunColor: this.sunColor,
        camera: this.camera,
        sunAngularRadius: (this.model.sun.radius * (this.byId.get('sun')?.scale ?? 1)) / Math.max(b.sunDistance, 1e-9),
        renderer: this.renderer,
      });
    } else if (r.star) {
      _q.copy(b.quaternion);
      r.star.update({ time: this.time, camera: this.camera });
    }
  }

  private updateOrbits(expo: number): void {
    const s = this.settings;
    const pa = this.pixelAngle;
    let slot = 0;
    for (const r of this.bodies) {
      const b = r.body;
      if (slot >= MAX_ORBITS) break;
      if (!s.orbits || !r.shown || !b.parent || b.def.kind === 'star') continue;
      if (!this.model.orbitGeometry(b, _geom)) continue;
      const parent = this.byId.get(b.parent.id)!;
      // Apparent size of the orbit: hide when sub-pixel, fade in by 60 px.
      const dParent = Math.max(parent.dist, 1e-12);
      const sizePx = (_geom.hyperbolic ? Math.max(_geom.a, b.local.length()) : _geom.a) / dParent / pa / this.pixelRatio;
      let alpha = THREE.MathUtils.smoothstep(sizePx, 10, 70);
      // Orbits of moons of an enlarged planet cannot be drawn honestly.
      if (b.def.kind === 'moon' && parent.scale > 1.5) alpha = 0;
      if (alpha <= 0.001) continue;
      const kind = b.def.kind;
      const base = kind === 'planet' ? 0.42 : kind === 'dwarf' ? 0.3 : kind === 'moon' ? 0.3 : kind === 'comet' ? 0.34 : kind === 'spacecraft' ? 0.36 : 0.2;
      alpha *= base * (b === this.selected ? 1.9 : 1);
      _slot.P.copy(_geom.P);
      _slot.Q.copy(_geom.Q);
      _slot.a = _geom.a;
      _slot.b = _geom.b;
      _slot.e = _geom.e;
      _slot.hyperbolic = _geom.hyperbolic;
      _slot.anomaly = _geom.anomaly;
      if (_geom.hyperbolic) {
        // Draw the branch out to max(40 AU, 1.3 × current distance) on the way in and out.
        const rMax = Math.max(40, 1.3 * b.local.length());
        const Hmax = Math.acosh(Math.max(1, (rMax / _geom.a + 1) / _geom.e));
        let Hmin = -Hmax;
        if (b.def.kind === 'spacecraft' && b.def.visibleFrom) Hmin = Math.max(Hmin, _geom.anomaly - 60); // (whole post-flyby path)
        _slot.rangeBack = Math.min(0, Hmin - _geom.anomaly);
        _slot.rangeAhead = Math.max(0, Hmax - _geom.anomaly);
      } else {
        _slot.rangeBack = -Math.PI;
        _slot.rangeAhead = Math.PI;
      }
      _slot.bodyRel.copy(r.rel);
      // Desaturated body colour for the line; divide by exposure so lines keep their display brightness.
      const c = r.color;
      const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
      const t = kind === 'comet' ? 0.3 : 0.5;
      const k = 1 / Math.max(lum, 0.05);
      _slot.color.setRGB((lum + (c.r - lum) * t) * k, (lum + (c.g - lum) * t) * k, (lum + (c.b - lum) * t) * k).multiplyScalar(0.16 / expo);
      _slot.alpha = alpha;
      _slot.bodyRadius = b.radius * r.scale;
      _slot.trail = kind === 'planet' ? 1 : 0.8;
      this.orbits.set(slot, _slot);
      this.orbitAlpha[slot] = alpha;
      slot++;
    }
    this.orbits.commit(slot);
  }

  /** Draw every slice far → near into `target` (the caller has drawn the sky and cleared depth). */
  render(target: THREE.WebGLRenderTarget): void {
    const r = this.renderer;
    r.setRenderTarget(target);
    const camR = this.cameraPosition.length();
    const maxFar = Math.max(2.5e5, camR * 3);
    const slices = this.slicer.build(1e-12, maxFar);
    const cam = this.camera;
    for (const s of slices) {
      cam.near = s.near;
      cam.far = s.far;
      cam.updateProjectionMatrix();
      this.orbits.near = s.near;
      r.clearDepth();
      r.render(this.scene, cam);
    }
    cam.near = 1e-9;
    cam.far = 1e7;
    cam.updateProjectionMatrix();
  }

  /** Update the DOM labels (call after update(); dt in seconds). */
  updateLabels(dt: number): void {
    if (!this.labels) return;
    const s = this.settings;
    this.labels.visible = s.labels;
    let n = 0;
    const pa = this.pixelAngle;
    for (let i = 0; i < this.bodies.length; i++) {
      const r = this.bodies[i];
      const b = r.body;
      const c = this.labelCands[i];
      if (!r.shown || !r.front) continue;
      let strength = 1;
      const kind = b.def.kind;
      if (kind === 'moon' && b.parent) {
        // Moons appear once they separate from their planet on screen.
        const pr = this.byId.get(b.parent.id)!;
        const sepPx = b.local.length() / r.dist / pa / this.pixelRatio;
        strength = THREE.MathUtils.smoothstep(sepPx, pr.radiusPx / this.pixelRatio + 14, pr.radiusPx / this.pixelRatio + 44);
      } else if (kind === 'asteroid' || kind === 'comet' || kind === 'spacecraft' || kind === 'dwarf') {
        // Minor bodies: show when fairly near or selected.
        const near = b.def.priority <= 3 ? 30 : 6;
        const ref = kind === 'spacecraft' ? 60 : kind === 'dwarf' && b.def.priority <= 2 ? 200 : near;
        strength = 1 - THREE.MathUtils.smoothstep(r.dist, ref * 0.6, ref);
        if (kind === 'comet' && b.sunDistance < 4) strength = Math.max(strength, 0.85);
      } else if (kind === 'planet') {
        // Inner planets are lost in the glare at Kuiper-belt distances.
        const sepPx = b.sunDistance / r.dist / pa / this.pixelRatio;
        strength = THREE.MathUtils.smoothstep(sepPx, 10, 26);
      }
      if (b === this.selected) strength = 1;
      c.x = r.sx;
      c.y = r.sy;
      c.radius = Math.max(r.radiusPx / this.pixelRatio, 2);
      c.strength = strength;
      c.selected = b === this.selected;
      // Swap into the compact prefix.
      if (n !== i) {
        const tmp = this.labelCands[n];
        this.labelCands[n] = c;
        this.labelCands[i] = tmp;
      }
      n++;
    }
    this.labels.update(this.labelCands, n, dt, this.cssW, this.cssH);
  }

  /** Nearest pickable body to a CSS-pixel position, or null. */
  pick(x: number, y: number): SolarBody | null {
    let best: BodyRender | null = null;
    let bestScore = Infinity;
    for (const r of this.bodies) {
      if (!r.shown || !r.front) continue;
      const rad = r.radiusPx / this.pixelRatio;
      const d = Math.hypot(r.sx - x, r.sy - y);
      const reach = Math.max(rad + 10, 16);
      if (d > reach) continue;
      // Prefer bodies we are inside of, then importance, then proximity.
      const score = (d <= rad ? -1000 : 0) + r.body.def.priority * 12 + d;
      if (score < bestScore) {
        bestScore = score;
        best = r;
      }
    }
    return best?.body ?? null;
  }

  /** CSS-pixel screen position of a heliocentric point; returns false when behind the camera. */
  projectPoint(p: THREE.Vector3, out: THREE.Vector2): boolean {
    _v.subVectors(p, this.cameraPosition).applyMatrix4(this.camera.matrixWorldInverse);
    if (_v.z >= 0) return false;
    _v.applyMatrix4(this.camera.projectionMatrix);
    out.set((_v.x * 0.5 + 0.5) * this.cssW, (-_v.y * 0.5 + 0.5) * this.cssH);
    return true;
  }

  dispose(): void {
    this.disposed = true;
    for (const r of this.bodies) {
      r.planet?.dispose();
      r.star?.dispose();
      if (r.rock) (r.rock.material as THREE.Material).dispose();
      if (r.object) this.scene.remove(r.object);
    }
    for (const g of this.rockGeos.values()) g.dispose();
    this.rockGeos.clear();
    this.orbits.dispose();
    this.sprites.dispose();
    for (const b of Object.values(this.belts)) b.dispose();
    this.labels?.dispose();
  }
}
