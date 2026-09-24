import * as THREE from 'three';
import type { Experience, ExperienceContext, FrameInfo } from '../../core/types';
import { OrbitRig } from '../../core/rigs/OrbitRig';
import { Sky } from '../../worlds/sky/Sky';
import { createPlanet, planetSpec, type PlanetRenderer } from '../../worlds/planet';
import { msToJD, radecToVector, sunState } from '../../physics/planets-ephemeris';
import { astroToThree } from '../../physics/kepler';
import { AU } from '../../physics/constants';

const R_EARTH_KM = 6371;
const AU_IN_RE = AU / 1e3 / R_EARTH_KM;

/** Pale Blue Dot — Earth under a physically scattered sky (skeleton, first light). */
class EarthExperience implements Experience {
  private ctx!: ExperienceContext;
  private sky!: Sky;
  private rig!: OrbitRig;
  private camera = new THREE.PerspectiveCamera(35, 1, 0.01, 10);
  private scene = new THREE.Scene();
  private earth!: PlanetRenderer;
  private simMs = Date.now();
  private sunPos = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private astro = { x: 0, y: 0, z: 0 };

  /** Debug: place the camera at a phase angle (deg) from the Sun, elevation (deg), distance (R⊕). */
  setPhase(phaseDeg: number, elevDeg = 10, distance = 3.2): void {
    this.update({ dt: 0, time: 0, frame: 0 });
    const s = this.tmp.copy(this.sunPos).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const side = new THREE.Vector3().crossVectors(up, s).normalize();
    const a = (phaseDeg * Math.PI) / 180;
    const c = s.clone().multiplyScalar(Math.cos(a)).addScaledVector(side, Math.sin(a));
    c.y += Math.tan((elevDeg * Math.PI) / 180);
    c.normalize();
    this.rig.set({ distance, yaw: Math.atan2(c.x, c.z), pitch: Math.asin(c.y) });
  }
  /** Debug: camera above a geographic point (deg), at `distance` Earth radii. */
  lookAt(latDeg: number, lonDeg: number, distance = 2.6): void {
    this.update({ dt: 0, time: 0, frame: 0 });
    const s = sunState(msToJD(this.simMs));
    const lat = (latDeg * Math.PI) / 180;
    const ra = (lonDeg * Math.PI) / 180 + s.gmst;
    radecToVector(ra, lat, this.astro);
    const c = astroToThree(this.tmp.set(this.astro.x, this.astro.y, this.astro.z), new THREE.Vector3());
    this.rig.set({ distance, yaw: Math.atan2(c.x, c.z), pitch: Math.asin(c.y) });
  }
  setTime(iso: string): void {
    this.simMs = Date.parse(iso);
  }

  async mount(ctx: ExperienceContext): Promise<void> {
    this.ctx = ctx;
    const q = ctx.params.get('t');
    if (q) this.simMs = Date.parse(q);
    this.sky = new Sky({ frame: 'equatorial', stars: Math.round(24000 * ctx.quality.detail), milkyWay: 0.9 });
    this.earth = createPlanet(planetSpec('earth', 1, { detail: ctx.quality.detail }));
    this.scene.add(this.earth.object);
    this.rig = new OrbitRig(ctx.input, { distance: 3.4, yaw: 0.6, pitch: 0.25, minDistance: 1.03, maxDistance: 2e6, enablePan: false });
    ctx.post.exposure = Number(ctx.params.get('exposure') ?? 1.0);
    ctx.post.bloomStrength = 0.04;
    const tm = ctx.params.get('tonemap');
    if (tm === 'aces' || tm === 'agx' || tm === 'agx-punchy' || tm === 'linear') ctx.post.tonemap = tm;
    ctx.progress(0.2, 'Blue Marble');
    await this.earth.ready;
    ctx.progress(0.8, 'Atmosphere');
    this.update({ dt: 0, time: 0, frame: 0 });
    if (ctx.params.has('lat')) this.lookAt(Number(ctx.params.get('lat')), Number(ctx.params.get('lon') ?? 0), Number(ctx.params.get('dist') ?? 2.6));
    const ph = ctx.params.get('phase');
    if (ph) this.setPhase(Number(ph), Number(ctx.params.get('elev') ?? 10), Number(ctx.params.get('dist') ?? 3.2));
    const opt = (k: string) => (ctx.params.has(k) ? Number(ctx.params.get(k)) : undefined);
    this.earth.setOptions({ aurora: opt('aurora'), airglow: opt('airglow'), clouds: opt('clouds'), cityLights: opt('lights') });
    this.earth.prepare(ctx.renderer);
    ctx.progress(1);
    ctx.signalReady();
  }

  update(f: FrameInfo): void {
    this.rig.update(f.dt);
    const jd = msToJD(this.simMs);
    const s = sunState(jd);
    radecToVector(s.ra, s.dec, this.astro);
    astroToThree(this.tmp.set(this.astro.x, this.astro.y, this.astro.z), this.sunPos);
    this.sunPos.multiplyScalar(s.distanceAU * AU_IN_RE);
    this.earth.setRotation(s.gmst);
    this.earth.setDate(this.simMs);
    this.earth.update({ time: this.simMs / 1000, sunPosition: this.sunPos, camera: this.camera, sunAngularRadius: 0.00465 / s.distanceAU });
  }

  render(target: THREE.WebGLRenderTarget): void {
    const r = this.ctx.renderer;
    const cam = this.camera;
    cam.aspect = target.width / target.height;
    this.rig.applyTo(cam);
    const d = this.rig.distance;
    cam.near = Math.max(d - 1.1, d * 1e-5);
    cam.far = d + 1.1;
    cam.updateProjectionMatrix();
    r.setRenderTarget(target);
    this.sky.render(r, cam, this.ctx.engine.pixelRatio);
    r.clearDepth();
    r.render(this.scene, cam);
  }

  unmount(): void {
    this.earth.dispose();
    this.sky.dispose();
  }
}

export default () => new EarthExperience();
