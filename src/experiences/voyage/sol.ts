import * as THREE from 'three';
import type { ExperienceContext } from '../../core/types';
import { skyFrameMatrix } from '../../worlds/sky/Sky';
import { SolarSystemModel, AU_KM, type SolarBody } from '../../worlds/solar/SolarSystemModel';
import { SolarSystemLayer } from '../../worlds/solar/render/SolarSystemLayer';
import { JD_MAX, JD_MIN, utcToTT } from '../../worlds/solar/time';
import { Frame, UNIT, rootQuatToFrame } from '../../worlds/explorer/frames';
import { LayerFader } from '../../worlds/explorer/LayerFader';

/**
 * Our Solar System inside the explorer: a `system` frame (AU, J2000 ecliptic axes) at the Sun, with
 * `planet` frames (km, co-moving) for the planets, dwarf planets and major moons (moons nest inside
 * their planet's frame). Ephemerides and rendering come from the solar module (Standish elements,
 * ELP-2000 Moon, fitted satellites; SolarSystemLayer with depth slices and lazily created planets).
 *
 * Entry radii follow each body's Hill sphere r_H = a (m / 3M)^{1/3} (half of it, clamped to 20–400
 * body radii): inside it the body dominates, so the camera rides along with it.
 */

/** Seen from outside this radius (AU) the Sun is one star among many (Starflight's regime). */
export const SOL_ENTRY_AU = 200;
export const SOL_FADE_AU: [number, number] = [170, 270];

const M_SUN_KG = 1.98847e30;

export class SolRegime {
  readonly frame: Frame;
  readonly model = new SolarSystemModel();
  layer: SolarSystemLayer | null = null;
  readonly bodyFrames = new Map<string, Frame>();
  /** Layer weight 0..1 (distance cross-fade). */
  opacity = 0;
  /** Post exposure wanted inside the system (solar-experience metering). */
  exposure = 1;
  private fader: LayerFader;
  private camAU = new THREE.Vector3();
  private camQ = new THREE.Quaternion();
  jdUTC = 0;
  /** Frames for which the meter jumps straight to its target (after a cut). */
  snap = 0;

  constructor(
    private ctx: ExperienceContext,
    local: Frame,
    private onPick: (id: string) => void,
    addChild: (parent: Frame, child: Frame) => void,
    jd0: number,
  ) {
    this.setTimeModelOnly(jd0);
    // Ecliptic three.js axes → galactic three.js axes (the local frame): transpose of skyFrameMatrix.
    const m = skyFrameMatrix('ecliptic').clone().transpose();
    const q = new THREE.Quaternion().setFromRotationMatrix(m);
    this.frame = new Frame({ id: 'sol', kind: 'system', label: 'Sol', parent: local, unit: UNIT.AU / UNIT.PC, rotation: q, entry: SOL_ENTRY_AU, exit: SOL_ENTRY_AU * 1.3 });
    addChild(local, this.frame);
    this.fader = new LayerFader(ctx.renderer);
    // Frames for the major bodies.
    const major = this.model.bodies.filter((b) => (b.def.kind === 'planet' || b.def.kind === 'dwarf' || (b.def.kind === 'moon' && b.def.priority <= 3)) && b.def.radiusKm > 150);
    const planets = major.filter((b) => b.def.kind !== 'moon');
    const moons = major.filter((b) => b.def.kind === 'moon');
    for (const b of [...planets, ...moons]) {
      const parentFrame = b.def.kind === 'moon' && b.parent ? this.bodyFrames.get(b.parent.id) : this.frame;
      if (!parentFrame) continue;
      const R = b.def.radiusKm;
      const entry = THREE.MathUtils.clamp(0.5 * this.hillKm(b), 20 * R, 400 * R);
      const f = new Frame({ id: `body-${b.id}`, kind: 'planet', label: b.def.name, parent: parentFrame, unit: parentFrame === this.frame ? 1 / AU_KM : 1, entry, exit: entry * 1.25, data: b });
      this.bodyFrames.set(b.id, f);
      addChild(parentFrame, f);
    }
  }

  /** Hill radius (km) of a body about its parent (Sun for planets). */
  private hillKm(b: SolarBody): number {
    const m = b.def.massKg ?? (4 / 3) * Math.PI * Math.pow(b.def.radiusKm * 1e3, 3) * 2500;
    const parent = b.parent;
    const M = parent && parent.def.kind !== 'star' ? (parent.def.massKg ?? 1e25) : M_SUN_KG;
    const a = (parent && parent.def.kind !== 'star' ? b.local.length() : b.position.length()) * AU_KM || 1.5e8;
    return a * Math.cbrt(m / (3 * M));
  }

  private setTimeModelOnly(jdUTC: number): void {
    this.jdUTC = THREE.MathUtils.clamp(jdUTC, JD_MIN, JD_MAX);
    this.model.update(utcToTT(this.jdUTC));
  }

  body(id: string): SolarBody | undefined {
    return this.model.get(id);
  }

  /** Advance the ephemerides to jd (UTC) and move the body frames. */
  setTime(jdUTC: number): void {
    this.jdUTC = THREE.MathUtils.clamp(jdUTC, JD_MIN, JD_MAX);
    const jdTT = utcToTT(this.jdUTC);
    if (Math.abs(jdTT - this.model.jd) > 1e-9) this.model.update(jdTT);
    for (const f of this.bodyFrames.values()) {
      const b = f.data as SolarBody;
      if (f.parent === this.frame) f.origin.copy(b.position);
      else f.origin.copy(b.local).multiplyScalar(AU_KM);
    }
  }

  /** Build / drop the renderer by distance from the Sun (AU). */
  manage(dSunAU: number): void {
    this.opacity = 1 - THREE.MathUtils.smoothstep(dSunAU, SOL_FADE_AU[0], SOL_FADE_AU[1]);
    if (!this.layer && dSunAU < 1500) {
      this.layer = new SolarSystemLayer(this.ctx.renderer, this.model, {
        quality: this.ctx.quality,
        overlay: this.ctx.ui.overlay,
        onLabelPick: (id) => this.onPick(id),
        settings: { scaleMode: 'true', spacecraft: true, oort: false },
      });
      this.layer.setSize(this.ctx.engine.width, this.ctx.engine.height, this.ctx.engine.pixelRatio);
    } else if (this.layer && dSunAU > 6000) {
      this.layer.dispose();
      this.layer = null;
    }
  }

  /**
   * Per frame: camera (Sol AU, float64; attitude in root axes), labels, metering.
   * `focus` is the body whose frame we are in (null in open space).
   */
  update(camSolAU: THREE.Vector3, camQuatRoot: THREE.Quaternion, fov: number, time: number, dt: number, labels: boolean, focus: SolarBody | null): void {
    const d = camSolAU.length();
    this.opacity = 1 - THREE.MathUtils.smoothstep(d, SOL_FADE_AU[0], SOL_FADE_AU[1]);
    const L = this.layer;
    if (!L) return;
    this.camAU.copy(camSolAU);
    rootQuatToFrame(camQuatRoot, this.frame, this.camQ);
    L.focus = focus;
    L.selected = focus;
    L.settings.labels = labels && this.opacity > 0.6;
    L.exposure = this.exposure;
    // From inside the Kuiper belt its bodies (V ≈ 20–24) would be invisible points scattered over the
    // whole sky; the belt is shown only from the inner system, where it reads as the ring it is.
    L.settings.kuiper = d < 22;
    L.setCamera(this.camAU, this.camQ, fov);
    if (this.opacity > 0.001) {
      L.update(this.model.jd, time, dt);
      L.updateLabels(dt);
    } else if (L.labels) {
      L.settings.labels = false;
      L.updateLabels(dt);
    }
    this.meter(dt, focus);
  }

  /**
   * Camera-like auto exposure (as the Solar System experience): expose for the subject — the
   * photosphere near the Sun, the body we are at, or the 1/r² sunlight of the region we are in.
   */
  private meter(dt: number, focus: SolarBody | null): void {
    const L = this.layer!;
    const camSun = this.camAU.length();
    const sunR = this.model.sun.radius;
    let target: number;
    if (camSun < sunR * 40) {
      const d = Math.max(camSun / sunR, 1);
      target = THREE.MathUtils.clamp(0.016 * Math.pow(d / 6, 0.9), 0.012, 1);
    } else {
      const f = focus ?? null;
      const r = Math.max(0.3, f ? f.sunDistance : camSun);
      const close = f ? 1 - THREE.MathUtils.smoothstep(this.camAU.distanceTo(f.position) / Math.max(f.radius, 1e-12), 30, 400) : 0;
      target = Math.pow(L.sunIntensity(r), -(0.75 + 0.25 * close));
    }
    target = THREE.MathUtils.clamp(target, 0.015, 30);
    const k = dt <= 0 || this.snap > 0 ? 1 : 1 - Math.exp(-dt / 0.8);
    if (this.snap > 0) this.snap--;
    this.exposure = Math.exp(Math.log(this.exposure) + (Math.log(target) - Math.log(this.exposure)) * k);
  }

  render(target: THREE.WebGLRenderTarget): void {
    if (!this.layer || this.opacity <= 0.001) return;
    const t = this.fader.begin(target, this.opacity);
    this.layer.render(t);
    this.fader.end();
  }

  resize(w: number, h: number): void {
    this.layer?.setSize(w, h, this.ctx.engine.pixelRatio);
  }

  /** Distance (km) from a Sol-frame point (AU) to the nearest body surface. */
  nearestSurfaceKm(pAU: THREE.Vector3): number {
    let best = Infinity;
    for (const f of this.bodyFrames.values()) {
      const b = f.data as SolarBody;
      const d = (pAU.distanceTo(b.position) - b.radius) * AU_KM;
      if (d < best) best = d;
    }
    const s = (pAU.length() - this.model.sun.radius) * AU_KM;
    return Math.max(Math.min(best, s), 1);
  }

  dispose(): void {
    this.layer?.dispose();
    this.layer = null;
    this.fader.dispose();
  }
}
