import * as THREE from 'three';
import { orbitState } from '../../physics/kepler';
import { createPlanet, type PlanetRenderer } from '../planet';
import { createStar, type StarRenderer } from '../star';
import { binaryMu, type PlanetData, type SystemData } from './generate';
import { OrbitLine, ZoneDisk } from './overlays';
import { EyeballIce, eyeballOpening } from './eyeball';
import { R_SUN_AU } from './stellar';

/**
 * SystemLayer: renders a generated system in the three.js frame (y-up; astro x,y,z → x,z,−y).
 *
 * Display units are "mapped AU": a radial mapping r' = r^γ about the primary (or the barycentre
 * of a circumbinary pair). γ = 1 gives true distances; γ ≈ 0.5 (default) compresses the huge
 * dynamic range of real systems (0.01 → 30 AU) so every orbit is visible at once. Planet and
 * star sizes are enlarged, preserving their size ordering (display radius ∝ R^½). The UI says so.
 *
 * Planets are full `createPlanet` renderers (atmospheres, clouds, rings), lit by their star with a
 * display irradiance ∝ S^¼ (true ratios span 10⁶ across a system — no camera sees them at once).
 *
 * Usage: `layer.setTime(days)`, `layer.update(camera, renderer)`, `layer.render(renderer, camera)`
 * after the sky. `pick()` returns the planet index under a screen point.
 */

export interface SystemLayerOptions {
  detail?: number;
  /** Initial γ of the radial display mapping (1 = true distances). */
  gamma?: number;
}

export interface BodyEntry {
  data: PlanetData;
  planet: PlanetRenderer;
  tilt: THREE.Group;
  orbit: OrbitLine;
  eyeball: EyeballIce | null;
  /** True heliocentric position (AU, three frame). */
  truePos: THREE.Vector3;
  /** Displayed position (mapped units). */
  pos: THREE.Vector3;
  displayRadius: number;
  /** Display irradiance factor. */
  irradiance: number;
  meanAnomaly: number;
  spin: number;
}

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpC = new THREE.Color();
const ORBIT_COLOR = new THREE.Color(0.1, 0.13, 0.18);
const ORBIT_SELECTED = new THREE.Color(0.36, 0.27, 0.18);
const ORBIT_HOVER = new THREE.Color(0.2, 0.24, 0.3);

export class SystemLayer {
  readonly sys: SystemData;
  readonly scene = new THREE.Scene();
  readonly bodies: BodyEntry[] = [];
  readonly star: StarRenderer;
  readonly companion: StarRenderer | null;
  /** Current mapped positions of the stars. */
  readonly starPos = new THREE.Vector3();
  readonly companionPos = new THREE.Vector3();
  readonly starTruePos = new THREE.Vector3();
  readonly companionTruePos = new THREE.Vector3();
  readonly gamma: THREE.IUniform<number>;
  private zone: ZoneDisk;
  private binaryLines: OrbitLine[] = [];
  private starDisplayR = 0.01;
  private companionDisplayR = 0.01;
  private timeDays = 0;
  private selected = -1;
  private hovered = -1;
  private showOrbits = 1;
  private disposed = false;
  readonly starLight = new THREE.Color();
  readonly companionLight = new THREE.Color();

  constructor(sys: SystemData, opts: SystemLayerOptions = {}) {
    this.sys = sys;
    const detail = opts.detail ?? 1;
    this.gamma = { value: opts.gamma ?? 0.5 };
    const s = sys.star;
    this.star = createStar({ seed: sys.seed % 1000, temperatureK: s.teff, radius: 1, intensity: starIntensity(s.teff), activity: s.activity, corona: s.stage === 'white-dwarf' ? 0.2 : 1, detail });
    this.scene.add(this.star.object);
    this.starLight.copy(adaptedLight(this.star.lightColor));
    if (sys.companion) {
      const c = sys.companion.star;
      this.companion = createStar({ seed: (sys.seed + 7) % 1000, temperatureK: c.teff, radius: 1, intensity: starIntensity(c.teff), activity: c.activity, detail });
      this.scene.add(this.companion.object);
      this.companionLight.copy(adaptedLight(this.companion.lightColor));
      if (sys.companion.config === 'P') {
        // Both stars' orbits about the barycentre.
        const mu = sys.companion.mu;
        const o = sys.companion.orbit;
        this.binaryLines.push(new OrbitLine({ ...o, a: o.a * mu, peri: o.peri + Math.PI }, this.gamma, ORBIT_COLOR));
        this.binaryLines.push(new OrbitLine({ ...o, a: o.a * (1 - mu) }, this.gamma, ORBIT_COLOR));
      } else {
        this.binaryLines.push(new OrbitLine(sys.companion.orbit, this.gamma, ORBIT_COLOR, 512));
      }
      for (const l of this.binaryLines) {
        l.setStyle(ORBIT_COLOR, 0.12, 0.35);
        this.scene.add(l.line);
      }
    } else this.companion = null;

    const hz = sys.hz;
    this.zone = new ZoneDisk([hz.recentVenus, hz.runaway, hz.maxGreenhouse, hz.earlyMars], sys.snowLine, sys.clearedInside, this.gamma);
    this.scene.add(this.zone.mesh);

    // Display irradiance: S^¼ about the system's median flux.
    const Ss = sys.planets.map((p) => p.insolation).sort((a, b) => a - b);
    const Smed = Ss[Math.floor(Ss.length / 2)] ?? 1;

    for (const p of sys.planets) {
      const planet = createPlanet({ ...p.spec, radius: 1, detail: detail * (p.spec.detail ?? 1) });
      const tilt = new THREE.Group();
      tilt.rotation.z = p.axialTilt;
      tilt.add(planet.object);
      this.scene.add(tilt);
      const orbit = new OrbitLine(p.orbit, this.gamma, ORBIT_COLOR);
      this.scene.add(orbit.line);
      let eyeball: EyeballIce | null = null;
      if (p.eyeball) {
        eyeball = new EyeballIce(eyeballOpening(p.teq), p.spec.seed);
        planet.object.add(eyeball.mesh);
      }
      this.bodies.push({
        data: p,
        planet,
        tilt,
        orbit,
        eyeball,
        truePos: new THREE.Vector3(),
        pos: new THREE.Vector3(),
        displayRadius: 0.01,
        irradiance: THREE.MathUtils.clamp(Math.pow(p.insolation / Smed, 0.25), 0.4, 2.2),
        meanAnomaly: 0,
        spin: 0,
      });
    }
    this.layoutSizes();
    this.setTime(0);
  }

  /** Build GPU resources (atmosphere LUTs, surface bakes) now rather than on first sight. */
  prepare(renderer: THREE.WebGLRenderer): void {
    for (const b of this.bodies) b.planet.prepare(renderer);
  }

  /** Map a true position (AU) to display units. */
  mapPoint(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const r = p.length();
    return r > 0 ? out.copy(p).multiplyScalar(Math.pow(r, this.gamma.value - 1)) : out.copy(p);
  }
  mapRadius(r: number): number {
    return Math.pow(r, this.gamma.value);
  }

  get compression(): number {
    return this.gamma.value;
  }
  setCompression(g: number): void {
    this.gamma.value = THREE.MathUtils.clamp(g, 0.2, 1);
    this.layoutSizes();
    this.setTime(this.timeDays);
  }

  /** Outer extent of the planetary system in display units. */
  get extent(): number {
    let r = 0;
    for (const b of this.bodies) r = Math.max(r, this.mapRadius(b.data.orbit.a * (1 + b.data.orbit.e)));
    if (this.sys.companion?.config === 'P') r = Math.max(r, this.mapRadius(this.sys.companion.orbit.a * 1.5));
    return Math.max(r, this.mapRadius(this.sys.hz.earlyMars) * 0.6);
  }

  /**
   * Enlarged sizes: display radius = k·√(R/R⊕), with k chosen so neighbours never touch
   * (≤ 35% of the smallest mapped gap) and the largest body stays modest relative to the system.
   */
  private layoutSizes(): void {
    const ext = this.extent;
    const rs = this.bodies.map((b) => Math.sqrt(b.data.radius));
    const k = (0.05 * ext) / Math.max(...rs, 1);
    const n = this.bodies.length;
    // Room on each side of every orbit (mapped), so crowded inner planets shrink but never touch.
    const room = this.bodies.map((b, i) => {
      const o = b.data.orbit;
      const inner = i > 0 ? this.mapRadius(o.a * (1 - o.e)) - this.mapRadius(this.bodies[i - 1].data.orbit.a * (1 + this.bodies[i - 1].data.orbit.e)) : this.mapRadius(o.a * (1 - o.e));
      const outer = i < n - 1 ? this.mapRadius(this.bodies[i + 1].data.orbit.a * (1 - this.bodies[i + 1].data.orbit.e)) - this.mapRadius(o.a * (1 + o.e)) : Infinity;
      return Math.max(0, Math.min(inner, outer));
    });
    this.bodies.forEach((b, i) => {
      b.displayRadius = Math.max(Math.min(k * rs[i], 0.4 * room[i]), 0.004 * ext);
      b.planet.object.scale.setScalar(b.displayRadius);
    });
    // Stars: at least true (mapped) size, else a size between the planets' and the inner orbit.
    const s = this.sys.star;
    const inner = this.bodies.length ? this.mapRadius(this.bodies[0].data.orbit.a * (1 - this.bodies[0].data.orbit.e)) : ext * 0.2;
    const trueR = this.gamma.value === 1 ? s.radius * R_SUN_AU : 0;
    const maxPlanet = Math.max(...this.bodies.map((b) => b.displayRadius), 0);
    let starR = Math.max(trueR, maxPlanet * 1.6 * Math.pow(Math.max(s.radius, 0.05), 0.25));
    const limit = this.sys.companion?.config === 'P' ? this.mapRadius(this.sys.companion.orbit.a) * 0.3 : inner * 0.35;
    starR = Math.max(Math.min(starR, limit), trueR, maxPlanet * 0.8);
    this.starDisplayR = starR;
    this.star.object.scale.setScalar(starR);
    if (this.companion && this.sys.companion) {
      this.companionDisplayR = starR * Math.pow(this.sys.companion.star.radius / Math.max(s.radius, 1e-3), 0.5);
      this.companion.object.scale.setScalar(this.companionDisplayR);
    }
    this.zone.setExtent(Math.max(ext, this.mapRadius(this.sys.hz.earlyMars), this.mapRadius(this.sys.snowLine)) * 1.2);
  }

  get starRadius(): number {
    return this.starDisplayR;
  }

  /** Advance the Keplerian clock (days since the epoch). */
  setTime(tDays: number): void {
    this.timeDays = tDays;
    const sys = this.sys;
    // Stars.
    if (sys.companion) {
      orbitState(sys.companion.orbit, tDays, binaryMu(sys), tmpA);
      const rel = tmpB.set(tmpA.x, tmpA.z, -tmpA.y);
      if (sys.companion.config === 'P') {
        this.starTruePos.copy(rel).multiplyScalar(-sys.companion.mu);
        this.companionTruePos.copy(rel).multiplyScalar(1 - sys.companion.mu);
      } else {
        this.starTruePos.set(0, 0, 0);
        this.companionTruePos.copy(rel);
      }
      this.mapPoint(this.companionTruePos, this.companionPos);
      this.companion!.object.position.copy(this.companionPos);
      // Binary orbit trails follow the stars.
      const n = Math.sqrt(binaryMu(sys) / Math.pow(sys.companion.orbit.a, 3));
      const M = sys.companion.orbit.M0 + n * tDays;
      if (sys.companion.config === 'P') {
        this.binaryLines[0].setPhase(M);
        this.binaryLines[1].setPhase(M);
      } else this.binaryLines[0].setPhase(M);
    } else this.starTruePos.set(0, 0, 0);
    this.mapPoint(this.starTruePos, this.starPos);
    this.star.object.position.copy(this.starPos);
    // Planets.
    for (const b of this.bodies) {
      const p = b.data;
      orbitState(p.orbit, tDays, p.mu, tmpA);
      b.truePos.set(tmpA.x, tmpA.z, -tmpA.y);
      this.mapPoint(b.truePos, b.pos);
      b.tilt.position.copy(b.pos);
      const n = Math.sqrt(p.mu / Math.pow(p.orbit.a, 3));
      b.meanAnomaly = p.orbit.M0 + n * tDays;
      b.orbit.setPhase(b.meanAnomaly);
      // Spin: sidereal rotation; a synchronous rotator keeps one face to the star.
      b.spin = p.spinOrbit === '1:1' ? b.meanAnomaly + Math.PI : (2 * Math.PI * tDays * 24) / p.rotationHours;
      b.planet.setRotation(b.spin % (2 * Math.PI));
    }
  }

  get time(): number {
    return this.timeDays;
  }

  /** Per-frame: lighting and shader clocks. `timeSec` drives clouds/turbulence. */
  update(camera: THREE.Camera, renderer: THREE.WebGLRenderer, timeSec: number): void {
    const sys = this.sys;
    this.star.update({ time: timeSec, camera });
    this.companion?.update({ time: timeSec, camera });
    for (const b of this.bodies) {
      // Light from the primary (the dominant source); a circumbinary pair acts as one lamp at
      // its luminosity-weighted centre, with the summed colour.
      const sunPos = sys.companion?.config === 'P' ? this.lampPosition(tmpB) : tmpB.copy(this.starPos);
      tmpC.copy(this.lightColorAt(b.truePos)).multiplyScalar(b.irradiance);
      const dTrue = b.truePos.distanceTo(this.starTruePos);
      b.planet.update({ time: timeSec, sunPosition: sunPos, sunColor: tmpC, camera, sunAngularRadius: (sys.star.radius * R_SUN_AU) / Math.max(dTrue, 1e-6), renderer });
      if (b.eyeball) b.eyeball.update(tmpA.copy(sunPos).sub(b.pos).normalize(), tmpC);
    }
  }

  /** Colour (luminance-normalised, summed over stars by flux) of starlight at a true position. */
  lightColorAt(truePos: THREE.Vector3, out = new THREE.Color()): THREE.Color {
    const sys = this.sys;
    if (!sys.companion) return out.copy(this.starLight);
    const d1 = Math.max(truePos.distanceToSquared(this.starTruePos), 1e-12);
    const d2 = Math.max(truePos.distanceToSquared(this.companionTruePos), 1e-12);
    const f1 = sys.star.luminosity / d1;
    const f2 = sys.companion.star.luminosity / d2;
    const w = f2 / f1;
    if (w < 1e-3) return out.copy(this.starLight);
    out.copy(this.starLight).lerp(this.companionLight, w / (1 + w)).multiplyScalar(1 + w);
    return out;
  }

  /** Luminosity-weighted centre of the two stars (mapped units). */
  lampPosition(out: THREE.Vector3): THREE.Vector3 {
    const c = this.sys.companion;
    if (!c) return out.copy(this.starPos);
    const L1 = this.sys.star.luminosity, L2 = c.star.luminosity;
    return out.copy(this.starPos).multiplyScalar(L1 / (L1 + L2)).addScaledVector(this.companionPos, L2 / (L1 + L2));
  }

  setSelected(i: number): void {
    this.selected = i;
    this.restyle();
  }
  setHovered(i: number): void {
    if (i === this.hovered) return;
    this.hovered = i;
    this.restyle();
  }
  private restyle(): void {
    this.bodies.forEach((b, i) => {
      const sel = i === this.selected;
      const hov = i === this.hovered;
      b.orbit.setStyle(sel ? ORBIT_SELECTED : hov ? ORBIT_HOVER : ORBIT_COLOR, (sel ? 0.3 : 0.16) * this.showOrbits, (sel ? 1.4 : 0.9) * this.showOrbits);
      b.orbit.line.visible = this.showOrbits > 0;
    });
  }

  setOrbitsVisible(v: boolean): void {
    this.showOrbits = v ? 1 : 0;
    for (const l of this.binaryLines) l.line.visible = v;
    this.restyle();
  }
  setZonesVisible(hz: boolean, snow = hz): void {
    this.zone.material.uniforms.uHZOn.value = hz ? 1 : 0;
    this.zone.material.uniforms.uSnowOn.value = snow ? 1 : 0;
  }

  /** Planet under a screen point (CSS px), or −1. Generous hit radius for touch. */
  pick(x: number, y: number, camera: THREE.PerspectiveCamera, width: number, height: number, slop = 16): number {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      const sp = this.project(b.pos, camera, width, height, tmpA);
      if (sp.z > 1) continue;
      const rpx = this.pixelRadius(b.pos, b.displayRadius, camera, height);
      const d = Math.hypot(sp.x - x, sp.y - y);
      if (d < rpx + slop && d - rpx < bestD) {
        bestD = d - rpx;
        best = i;
      }
    }
    return best;
  }

  /** Screen position (CSS px) of a display-space point; z > 1 means behind the camera. */
  project(p: THREE.Vector3, camera: THREE.Camera, width: number, height: number, out: THREE.Vector3): THREE.Vector3 {
    out.copy(p).project(camera);
    const behind = out.z > 1 || out.z < -1;
    out.set((out.x * 0.5 + 0.5) * width, (-out.y * 0.5 + 0.5) * height, behind ? 2 : out.z);
    return out;
  }

  pixelRadius(p: THREE.Vector3, r: number, camera: THREE.PerspectiveCamera, height: number): number {
    const d = camera.position.distanceTo(p);
    return (r / Math.max(d, 1e-9)) * (height / (2 * Math.tan((camera.fov * Math.PI) / 360)));
  }

  render(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera): void {
    // Depth range around everything in front of the camera.
    const d = camera.position.length();
    let far = d + this.extent * 3;
    if (this.sys.companion) far = Math.max(far, camera.position.distanceTo(this.companionPos) + this.companionDisplayR * 8);
    let near = far;
    for (const b of this.bodies) near = Math.min(near, camera.position.distanceTo(b.pos) - b.displayRadius * 3);
    near = Math.min(near, camera.position.distanceTo(this.starPos) - this.starDisplayR * 7);
    camera.near = Math.max(near * 0.5, far * 2e-6, 1e-7);
    camera.far = far;
    camera.updateProjectionMatrix();
    renderer.render(this.scene, camera);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.star.dispose();
    this.companion?.dispose();
    for (const b of this.bodies) {
      b.eyeball?.dispose();
      b.planet.dispose();
      b.orbit.dispose();
    }
    for (const l of this.binaryLines) l.dispose();
    this.zone.dispose();
  }
}

/**
 * Star brightness multiplier for the system view: cool stars have far lower visible surface
 * brightness (the renderer applies the Planck ratio at 555 nm); lift them part-way so an M dwarf
 * still glows like the ember it is instead of vanishing.
 */
export function starIntensity(teff: number): number {
  return THREE.MathUtils.clamp(Math.pow(5772 / teff, 1.6), 0.35, 4);
}

/**
 * Chromatic adaptation: our eyes (and a camera's white balance) partly discount the colour of the
 * illuminant. Planet lighting uses the star's blackbody colour moved 40% of the way to white
 * (a partial von Kries transform), so a red dwarf's world looks warm, not monochrome orange.
 * The stars themselves keep their true colour.
 */
export const ADAPTATION = 0.4;
export function adaptedLight(c: THREE.Color, out = new THREE.Color()): THREE.Color {
  out.setRGB(c.r + (1 - c.r) * ADAPTATION, c.g + (1 - c.g) * ADAPTATION, c.b + (1 - c.b) * ADAPTATION, THREE.LinearSRGBColorSpace);
  const y = 0.2126 * out.r + 0.7152 * out.g + 0.0722 * out.b;
  return out.multiplyScalar(1 / y);
}
