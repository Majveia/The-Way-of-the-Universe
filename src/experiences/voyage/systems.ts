import * as THREE from 'three';
import type { ExperienceContext } from '../../core/types';
import { generateSystem, SystemLayer, R_EARTH_KM, type SystemData, type StarHint, type BodyEntry } from '../../worlds/systems';
import { Frame, UNIT, rootQuatToFrame } from '../../worlds/explorer/frames';
import { LayerFader } from '../../worlds/explorer/LayerFader';
import { randomOrientation } from '../../worlds/explorer/universe';

/**
 * Procedurally generated planets around any other star (the Possible Worlds generator: Kroupa IMF,
 * Holman–Wiegert stability, Hill-spaced orbits, Chen & Kipping radii, Kopparapu habitable zones),
 * seeded by the star so every visit finds the same worlds. Only the planets are procedural: the star
 * itself is the real (catalogue) or modelled (galaxy) star, drawn by the sky's resolved-star renderer.
 *
 * Drawn at TRUE scale — distances and radii — so from the system's edge the planets are points;
 * a planet's disc is never drawn smaller than ~1.6 px (a point of light, like the Solar System's
 * sprites). Each body gets its own depth slice so a hot Jupiter a few radii away and an ice giant at
 * 30 AU share the view without z-fighting. Planet frames (km) co-move with the planets.
 *
 * Lighting is physical: irradiance ∝ L/d²; the camera meters for the planet it is near (or the
 * system's median planet), as a camera would.
 */

const AU_KM = UNIT.AU / 1e3;

export interface ProcSystemSpec {
  id: string;
  name: string;
  /** Parent frame and the star's position there (parent units); updated by the owner. */
  parent: Frame;
  position: THREE.Vector3;
  seed: number;
  /** Generator hint: always a fixed stage and the catalogue T_eff (explorer/hosts.ts procHostHint). */
  hint: StarHint;
}

export class ProcSystem {
  readonly frame: Frame;
  readonly sys: SystemData;
  readonly layer: SystemLayer;
  readonly planetFrames: Frame[] = [];
  opacity = 0;
  exposure = 1;
  private fader: LayerFader;
  private cam = new THREE.PerspectiveCamera(50, 1, 1e-9, 1e7);
  private lines: THREE.Object3D[] = [];
  private bodyObjs: THREE.Object3D[] = [];
  private firstMeter = true;
  private lastFocus: BodyEntry | null = null;

  constructor(
    private ctx: ExperienceContext,
    readonly spec: ProcSystemSpec,
    addChild: (p: Frame, c: Frame) => void,
    private removeChild: (p: Frame, c: Frame) => void,
  ) {
    this.sys = generateSystem(spec.seed, spec.hint);
    this.frame = new Frame({
      id: `sys-${spec.id}`,
      kind: 'system',
      label: spec.name,
      parent: spec.parent,
      unit: UNIT.AU / spec.parent.metres,
      origin: spec.position,
      rotation: randomOrientation(spec.seed ^ 0x51a7),
      entry: 200,
      exit: 260,
    });
    addChild(spec.parent, this.frame);
    this.layer = new SystemLayer(this.sys, { detail: ctx.quality.detail, gamma: 1 });
    this.layer.setCompression(1);
    this.layer.setZonesVisible(false);
    // The star is drawn by the resolved-star renderer (true flux); hide the layer's own.
    this.layer.star.object.visible = false;
    if (this.layer.companion) this.layer.companion.object.visible = false;
    for (const b of this.layer.bodies) {
      const R = b.data.radius * R_EARTH_KM;
      const entry = THREE.MathUtils.clamp(0.5 * b.data.orbit.a * AU_KM * Math.cbrt((b.data.mass * 3.0035e-6) / (3 * this.sys.star.mass)), 20 * R, 400 * R);
      const f = new Frame({ id: `${this.frame.id}-${b.data.letter}`, kind: 'planet', label: `${b.data.designation}`, parent: this.frame, unit: 1 / AU_KM, entry, exit: entry * 1.25, data: b });
      this.planetFrames.push(f);
      addChild(this.frame, f);
      this.lines.push(b.orbit.line);
      this.bodyObjs.push(b.tilt);
    }
    this.fader = new LayerFader(ctx.renderer);
    this.layer.prepare(ctx.renderer);
  }

  /** Days of system time. */
  setTime(days: number): void {
    this.layer.setTime(days);
    for (const f of this.planetFrames) f.origin.copy((f.data as BodyEntry).truePos);
  }

  /**
   * Camera in this system's frame (AU, float64), attitude in root axes, vertical fov (deg).
   * `focus` = the planet whose frame we are in.
   */
  update(camAU: THREE.Vector3, camQuatRoot: THREE.Quaternion, fov: number, aspect: number, height: number, time: number, focus: BodyEntry | null): void {
    this.opacity = 1 - THREE.MathUtils.smoothstep(camAU.length(), 170, 270);
    const c = this.cam;
    c.position.copy(camAU);
    rootQuatToFrame(camQuatRoot, this.frame, c.quaternion);
    c.fov = fov;
    c.aspect = aspect;
    c.near = 1e-9;
    c.far = 1e7;
    c.updateProjectionMatrix();
    c.updateMatrixWorld();
    const pxAngle = (2 * Math.tan(THREE.MathUtils.degToRad(fov) / 2)) / Math.max(height, 1);
    const s = this.sys.star;
    // True sizes (with a 1.6 px floor) and physical irradiance.
    let meterS = 0;
    for (const b of this.layer.bodies) {
      const R = (b.data.radius * R_EARTH_KM) / AU_KM;
      const d = camAU.distanceTo(b.truePos);
      const r = Math.max(R, 1.6 * pxAngle * d);
      b.displayRadius = r;
      b.planet.object.scale.setScalar(r);
      const dStar = Math.max(b.truePos.length(), 1e-6);
      const S = s.luminosity / (dStar * dStar);
      b.irradiance = Math.pow(S, 1);
      if (b === focus) meterS = S;
    }
    if (!focus) {
      const Ss = this.layer.bodies.map((b) => b.irradiance).sort((a, b) => a - b);
      meterS = Ss[Math.floor(Ss.length / 2)] ?? 1;
    }
    this.layer.update(c, this.ctx.renderer, time);
    // Meter: fully compensate the irradiance at a planet, partially in open space.
    const target = THREE.MathUtils.clamp(Math.pow(Math.max(meterS, 1e-6), focus ? -1 : -0.8), 1e-4, 100);
    const k = this.firstMeter || focus !== this.lastFocus ? 1 : 0.05;
    this.firstMeter = false;
    this.lastFocus = focus;
    this.exposure = Math.exp(Math.log(this.exposure) + (Math.log(target) - Math.log(this.exposure)) * k);
  }

  /** Depth-sliced render: orbit lines first, then each body far → near in its own depth range. */
  render(target: THREE.WebGLRenderTarget): void {
    if (this.opacity <= 0.001) return;
    const r = this.ctx.renderer;
    const rt = this.fader.begin(target, this.opacity);
    r.setRenderTarget(rt);
    const c = this.cam;
    const scene = this.layer.scene;
    // Lines only.
    for (const o of this.bodyObjs) o.visible = false;
    const compObj = this.layer.companion?.object ?? null;
    if (compObj) compObj.visible = false;
    c.near = Math.max(1e-6, c.position.length() * 1e-4);
    c.far = c.position.length() + 400;
    c.updateProjectionMatrix();
    r.clearDepth();
    r.render(scene, c);
    for (const l of this.lines) l.visible = false;
    // Bodies.
    const order = this.layer.bodies.map((b, i) => ({ b, i, d: c.position.distanceTo(b.truePos) })).sort((a, b) => b.d - a.d);
    c.updateMatrixWorld();
    for (const { b, i } of order) {
      const R = b.displayRadius * (b.data.spec.rings ? b.data.spec.rings.outer * 1.05 : 1.2);
      const z = -_v.copy(b.truePos).applyMatrix4(c.matrixWorldInverse).z;
      if (z + R <= 0) continue;
      this.bodyObjs[i].visible = true;
      c.near = Math.max(z - R, z * 1e-6, 1e-12);
      c.far = Math.max(z + R, c.near * 4);
      c.updateProjectionMatrix();
      r.clearDepth();
      r.render(scene, c);
      this.bodyObjs[i].visible = false;
    }
    for (const o of this.bodyObjs) o.visible = true;
    for (const l of this.lines) l.visible = true;
    this.fader.end();
  }

  /** Star irradiance at a system-frame point (AU), in units of the Sun's at Earth (S⊕). */
  irradianceAt(pAU: THREE.Vector3): number {
    return this.sys.star.luminosity / Math.max(pAU.lengthSq(), 1e-8);
  }

  /** Distance (km) from a system-frame point (AU) to the nearest planet surface or the star. */
  nearestSurfaceKm(pAU: THREE.Vector3): number {
    let best = (pAU.length() - (this.sys.star.radius * 695700) / AU_KM) * AU_KM;
    for (const b of this.layer.bodies) best = Math.min(best, (pAU.distanceTo(b.truePos) - (b.data.radius * R_EARTH_KM) / AU_KM) * AU_KM);
    return Math.max(best, 1);
  }

  /** Screen-space pick (CSS px) of a planet: index or −1. */
  pick(x: number, y: number, w: number, h: number): number {
    return this.layer.pick(x, y, this.cam, w, h, 18);
  }

  dispose(): void {
    for (const f of this.planetFrames) {
      f.disposed = true;
      this.removeChild(this.frame, f);
    }
    this.frame.disposed = true;
    this.removeChild(this.spec.parent, this.frame);
    this.layer.dispose();
    this.fader.dispose();
  }
}

const _v = new THREE.Vector3();
