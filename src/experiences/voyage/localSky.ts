import * as THREE from 'three';
import { Sky, type ApparentStar, type RelativityFlags } from '../../worlds/sky/Sky';
import { equatorialToGalacticThree, type StarCatalog } from '../../worlds/sky/catalog';
import { NearStars, type NearStarView } from '../../worlds/sky/NearStars';
import { AU_PC, R_SUN_PC, estimateRadius, tangentBasis, visualOrbitOffset } from '../../worlds/sky/stellar';
import { aberrateDirection, logBlackbodyLuminance } from '../../physics/voyage-relativity';
import { formatNumber } from '../../physics/units';
import { DESTINATIONS, STAR_OVERRIDES, type Destination } from './targets';
import type { LabelItem } from './hud';

/**
 * The solar neighbourhood as Starflight built it (phase 1), packaged as one regime of the explorer:
 * the real sky (HYG catalogue in 3D with parallax, proper motion, relativistic aberration / Doppler /
 * beaming), resolved nearby stars (NearStars billboards, binary orbits from their visual orbits),
 * star-name labels and the stars that light the ship. Positions: heliocentric galactic frame, pc —
 * the explorer's `local` frame.
 *
 * The whole regime fades out (`fade`) as the traveller leaves the neighbourhood, where the
 * procedural Galaxy takes over the sky.
 */

export const LY_PC = 1 / 3.2615637771674337;
export const NOW_YEAR = 2026.73; // 2026 Sep 23
const J2000 = 2000.0;
/** Reference pixel angle (rad) for converting star flux to illuminance on the hull (≈ 60° / 1047 px). */
export const P_REF = 1e-3;
const NEAR_PC = 0.05;

export interface NearEntry {
  index: number;
  pos: THREE.Vector3;
  radiusRsun: number;
  temperature: number;
  absMag: number;
  name: string;
}

/** An extra resolved star (e.g. a procedural system's sun) in the local frame. */
export interface ExtraStar {
  pos: THREE.Vector3;
  radiusRsun: number;
  temperature: number;
  absMag: number;
  seed: number;
  /** 0..1 visibility (cross-fades). */
  weight: number;
}

export interface Light {
  dir: THREE.Vector3;
  illum: number;
  temperature: number;
}

export class LocalSky {
  readonly sky: Sky;
  readonly near: NearStars;
  readonly nearList: NearEntry[] = [];
  readonly nearViews: NearStarView[] = [];
  readonly extras: ExtraStar[] = [];
  private namedBright: number[];
  private nearScanFrame = 0;
  private app: ApparentStar = { dir: new THREE.Vector3(), restDir: new THREE.Vector3(), distance: 0, mag: 0, temperature: 0, delta: 1 };
  private relScratch = new THREE.Vector3();
  private baryScratch = new THREE.Vector3();
  /** Observer (local pc), velocity (β), relativity flags, epoch — set by update(). */
  readonly observer = new THREE.Vector3();
  readonly beta = new THREE.Vector3();
  flags: RelativityFlags = { aberration: true, doppler: true, beaming: true };
  /** Years since J2000 (for proper motions). */
  epoch = NOW_YEAR - J2000;
  /** Years after now (binary orbits). */
  yearsFromNow = 0;
  /** Distance to the nearest catalogue star (pc), refreshed a few times per second. */
  nearestStar = 1;
  /** 0..1 overall visibility of the regime. */
  fade = 1;
  /** Baseline sky brightness/star size (view-dependent: planetarium vs camera). */
  baseBrightness = 1;
  baseStarSize = 1;
  baseMilkyWay = 1;

  constructor(
    readonly cat: StarCatalog,
    detail: number,
  ) {
    this.sky = new Sky({ catalog: cat, stars: Math.round(26000 * detail), milkyWay: 1, constellations: 0 });
    this.sky.minStarDistance = 1e-9;
    for (const [name, o] of Object.entries(STAR_OVERRIDES)) {
      const i = cat.find(name);
      if (i >= 0 && o.teff) this.sky.overrideStar(i, { temperature: o.teff });
    }
    this.near = new NearStars();
    this.namedBright = cat.namedIndices.filter((i) => cat.mag[i] < 2.6 || cat.distance[i] < 5.5).slice(0, 160);
  }

  get ready(): Promise<void> {
    return this.sky.ready;
  }

  /** Heliocentric position (pc, local frame) of catalogue star i at the current epoch. */
  starPos(i: number, out: THREE.Vector3): THREE.Vector3 {
    const c = this.cat;
    const t = this.epoch;
    return out.set(c.position[i * 3] + c.velocity[i * 3] * t, c.position[i * 3 + 1] + c.velocity[i * 3 + 1] * t, c.position[i * 3 + 2] + c.velocity[i * 3 + 2] * t);
  }

  findStar(q: string): number {
    if (q.startsWith('#')) return Number(q.slice(1));
    return this.cat.find(q);
  }

  /** Secondary − primary offset (pc, local) of a destination's visual binary. */
  companionOffset(d: Destination, primary: number, out: THREE.Vector3): THREE.Vector3 {
    const o = d.companion!.orbit;
    const [n, e, r] = visualOrbitOffset(o, NOW_YEAR + this.yearsFromNow);
    const b = tangentBasis(this.cat.ra[primary], this.cat.dec[primary], equatorialToGalacticThree);
    return out.set(0, 0, 0).addScaledVector(b.north, n * AU_PC).addScaledVector(b.east, e * AU_PC).addScaledVector(b.los, r * AU_PC);
  }

  /** Centre (barycentre for binaries) of a destination, local pc. */
  destCenter(d: Destination, out: THREE.Vector3): THREE.Vector3 {
    const i = this.findStar(d.star);
    this.starPos(i, out);
    if (d.companion) out.addScaledVector(this.companionOffset(d, i, this.relScratch), d.companion.orbit.q);
    return out;
  }

  /** Physical properties of catalogue star i (curated overrides first). */
  starInfo(i: number): { temperature: number; radius: number; absMag: number } {
    const inf = this.cat.info(i);
    const ov = STAR_OVERRIDES[inf.proper] ?? STAR_OVERRIDES[inf.name];
    const props = this.sky.starProps(i);
    const T = ov?.teff ?? props.temperature;
    return { temperature: T, radius: ov?.radius ?? estimateRadius(props.absMag, T), absMag: props.absMag };
  }

  /** Per-frame state. */
  update(observerPc: THREE.Vector3, beta: THREE.Vector3, time: number): void {
    this.observer.copy(observerPc);
    this.beta.copy(beta);
    const s = this.sky;
    s.setObserver(observerPc);
    s.setEpoch(this.epoch);
    s.setVelocity(beta);
    s.setRelativity(this.flags);
    const f = this.fade;
    s.brightness = this.baseBrightness * f;
    s.milkyWay = this.baseMilkyWay * f;
    this.near.brightness = f;
    this.near.time = time;
    if (f > 0.001) this.updateNearStars();
    else {
      this.nearList.length = 0;
      this.nearViews.length = 0;
    }
  }

  /** Catalogue stars within NEAR_PC (plus binary companions from their orbits) → resolved list. */
  private updateNearStars(): void {
    const c = this.cat;
    const list = this.nearList;
    const o = this.observer;
    if (this.nearScanFrame++ % 8 === 0 || list.length === 0) {
      list.length = 0;
      const t = this.epoch;
      let nearest = Infinity;
      for (let i = 0; i < c.count; i++) {
        const dx = c.position[i * 3] + c.velocity[i * 3] * t - o.x;
        const dy = c.position[i * 3 + 1] + c.velocity[i * 3 + 1] * t - o.y;
        const dz = c.position[i * 3 + 2] + c.velocity[i * 3 + 2] * t - o.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < nearest) nearest = d2;
        if (d2 > NEAR_PC * NEAR_PC || d2 < 1e-24) continue;
        if (list.length >= 6) continue;
        const inf = c.info(i);
        const p = this.starInfo(i);
        list.push({ index: i, pos: new THREE.Vector3(), radiusRsun: p.radius, temperature: p.temperature, absMag: p.absMag, name: inf.name });
      }
      this.nearestStar = Math.sqrt(nearest);
    }
    for (const e of list) this.starPos(e.index, e.pos);
    for (const d of DESTINATIONS) {
      if (!d.companion) continue;
      const pi = c.find(d.star), si = c.find(d.companion.star);
      const P = list.find((x) => x.index === pi), S = list.find((x) => x.index === si);
      if (!P && !S) continue;
      const rel = this.companionOffset(d, pi, this.relScratch);
      const bary = this.starPos(pi, this.baryScratch);
      if (P) P.pos.copy(bary).addScaledVector(rel, -d.companion.orbit.q);
      if (S) {
        S.pos.copy(bary).addScaledVector(rel, 1 - d.companion.orbit.q);
        S.temperature = d.companion.teff;
        S.radiusRsun = d.companion.radius;
      }
    }
    const views = this.nearViews;
    views.length = 0;
    const hide: number[] = [];
    let k = 0;
    const add = (pos: THREE.Vector3, absMag: number, temp: number, radiusRsun: number, seed: number, weight: number) => {
      const rel = _v3.copy(pos).sub(o);
      const d = Math.max(rel.length(), 1e-14);
      const restDir = rel.divideScalar(d);
      let delta = 1;
      const view = views[k] ?? (views[k] = { dir: new THREE.Vector3(), angularRadius: 0, temperature: 0, mag: 0, seed: 0 });
      if (this.beta.lengthSq() > 1e-14) {
        delta = aberrateDirection(restDir, this.beta, view.dir);
        if (!this.flags.aberration) view.dir.copy(restDir);
      } else view.dir.copy(restDir);
      let m = absMag + 5 * (Math.log10(d) - 1) - 2.5 * Math.log10(Math.max(weight, 1e-6));
      let T = temp;
      if (delta !== 1) {
        const Tobs = T * delta;
        if (this.flags.beaming) m -= 2.5 * (logLum10(Tobs) - logLum10(T) - 2 * Math.log10(delta));
        if (this.flags.doppler) T = Tobs;
      }
      view.mag = m;
      view.temperature = T;
      view.angularRadius = Math.asin(Math.min(1, (radiusRsun * R_SUN_PC) / d)) / delta;
      view.seed = seed;
      k++;
    };
    for (const e of list) {
      hide.push(e.index);
      add(e.pos, e.absMag, e.temperature, e.radiusRsun, e.index * 0.137, 1);
    }
    for (const x of this.extras) if (x.weight > 0.001 && k < 8) add(x.pos, x.absMag, x.temperature, x.radiusRsun, x.seed, x.weight);
    views.length = k;
    this.sky.hideStars(hide);
  }

  /** Stars bright enough to light the ship (flux-calibrated illuminance, see Starflight). */
  collectLights(push: (dir: THREE.Vector3, illum: number, T: number) => void): void {
    if (this.fade <= 0.001) return;
    const f = this.fade;
    for (const v of this.nearViews) push(v.dir, 3.17 * Math.pow(10, -0.4 * (v.mag - 1)) * P_REF * P_REF * f, v.temperature);
    for (let i = 0; i < 7; i++) {
      if (this.nearList.some((e) => e.index === i)) continue;
      if (this.sky.apparent(i, this.app) && this.app.distance > 1e-9 && this.app.mag < -3) push(this.app.dir, 3.17 * Math.pow(10, -0.4 * (this.app.mag - 1)) * P_REF * P_REF * f, this.app.temperature);
    }
  }

  /** Named-star labels as seen from the observer. */
  labels(pool: LabelItem[], out: LabelItem[], showSun: boolean): void {
    if (this.fade < 0.3) return;
    let k = out.length;
    const add = (i: number, boost = 0) => {
      if (k >= pool.length) return;
      if (!this.sky.apparent(i, this.app)) return;
      const nv = this.nearList.findIndex((e) => e.index === i);
      const dir = nv >= 0 && this.nearViews[nv] ? this.nearViews[nv].dir : this.app.dir;
      const mag = nv >= 0 && this.nearViews[nv] ? this.nearViews[nv].mag : this.app.mag;
      if (mag > 3.2 && boost === 0) return;
      const it = pool[k++];
      it.dir.copy(dir);
      const inf = this.cat.info(i);
      it.text = i === 0 ? 'Sun' : inf.proper || inf.designation || inf.name;
      const dly = this.app.distance / LY_PC;
      it.sub = dly < 0.05 ? `${formatNumber(this.app.distance / AU_PC, 2)} AU` : `${formatNumber(dly, dly < 10 ? 2 : 3)} ly`;
      it.priority = -mag + boost;
      it.cool = i === 0;
      out.push(it);
    };
    if (showSun) add(0, 30);
    for (const i of this.namedBright) add(i);
    for (const e of this.nearList) if (!this.namedBright.includes(e.index)) add(e.index, 5);
  }

  /** Apparent direction of catalogue star i (or false if unavailable). */
  apparent(i: number, out: ApparentStar): boolean {
    return this.sky.apparent(i, out);
  }

  /** Brightest-looking catalogue star near a screen point (CSS px) for camera `cam` (rotation only). */
  pick(x: number, y: number, cam: THREE.PerspectiveCamera, w: number, h: number): number {
    if (this.fade < 0.3) return -1;
    const rot = _m3.setFromMatrix4(cam.matrixWorldInverse);
    let best = -1, bestScore = Infinity;
    for (let i = 1; i < this.cat.count; i++) {
      if (!this.sky.apparent(i, this.app) || this.app.mag > 6.8) continue;
      const p = _v1.copy(this.app.dir).applyMatrix3(rot);
      if (p.z >= 0) continue;
      p.applyMatrix4(cam.projectionMatrix);
      const sx = (p.x * 0.5 + 0.5) * w, sy = (-p.y * 0.5 + 0.5) * h;
      const d = Math.hypot(sx - x, sy - y);
      if (d > 28) continue;
      const score = d + 4 * this.app.mag;
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best;
  }

  /** Draw the sky (writes the background: call first). */
  renderSky(r: THREE.WebGLRenderer, skyCam: THREE.PerspectiveCamera, pixelRatio: number, cssHeight: number): void {
    if (this.fade <= 0.001) return;
    this.sky.cssHeight = cssHeight;
    this.sky.render(r, skyCam, pixelRatio);
  }

  /** Draw the resolved nearby stars (additive). */
  renderNear(r: THREE.WebGLRenderer, skyCam: THREE.PerspectiveCamera, pixelRatio: number, targetW: number, targetH: number, exposure: number): void {
    if (this.fade <= 0.001 || this.nearViews.length === 0) return;
    const pxAngle = (2 * Math.tan(THREE.MathUtils.degToRad(skyCam.fov) / 2)) / targetH;
    this.near.set(this.nearViews, pxAngle, pixelRatio, exposure, targetW, targetH, targetH * 0.28);
    this.near.render(r, skyCam);
  }

  dispose(): void {
    this.sky.dispose();
    this.near.dispose();
  }
}

function logLum10(T: number): number {
  return logBlackbodyLuminance(T) / Math.LN10;
}

const _v1 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _m3 = new THREE.Matrix3();
