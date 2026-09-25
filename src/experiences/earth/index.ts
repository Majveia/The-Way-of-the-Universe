import * as THREE from 'three';
import type { Experience, ExperienceContext, FrameInfo } from '../../core/types';
import type { Control } from '../../ui/Panel';
import type { Readout } from '../../ui/UI';
import { Sky } from '../../worlds/sky/Sky';
import { createPlanet, planetSpec, type PlanetRenderer, type PlanetUpdate } from '../../worlds/planet';
import { createStar, type StarRenderer } from '../../worlds/star';
import { gmst, meanObliquity, solarElevation, moonState, msToJD, radecToVector, sunState, VOYAGER1_PALE_BLUE_DOT } from '../../physics/planets-ephemeris';
import { astroToThree } from '../../physics/kepler';
import { formatDistance, formatNumber } from '../../physics/units';
import { EarthCamera, meanMotion, type OrbitFraming } from './camera';
import { GALLERY, phaseFor, type GalleryWorld, type Lighting } from './gallery';
import { Sunbeam } from './sunbeam';
import { AU_RE, R_EARTH_KM, fovForDistance, moonOrientation, pbdProgress, smooth, voyagerGeocentricAU } from './math';
import { SunGlare } from './glare';

/**
 * Pale Blue Dot — the Earth as it is right now.
 *
 * Scene units: Earth radii (R⊕ = 6 371 km), geocentric, three.js axes aligned with the equatorial
 * frame of date (y → celestial north pole; astroToThree maps x→x, z→y, y→−z). The Earth turns by
 * Greenwich mean sidereal time; the Sun and Moon come from Meeus' series (planets-ephemeris), so the
 * subsolar point, seasons, the equation of time, Moon phase and eclipses are all where they really are.
 * The background sky is the real star catalogue in the same frame.
 *
 * Passes (each with its own near/far to keep depth precision from 400 km to 6 × 10⁹ km):
 *   sky → (far→near) Sun · Moon · Earth → Voyager stray light (Pale Blue Dot only).
 */

const MOON_R = 1737.4 / R_EARTH_KM;
const SUN_R = 695_700 / R_EARTH_KM;
const DEG = Math.PI / 180;
const GEO_R = 42_164 / R_EARTH_KM;
/**
 * The Sun's disk-centre radiance relative to a white surface it lights is ≈ 4.6 × 10⁴ (π / Ω☉).
 * We draw it ~40× dimmer so that the bloom stays a glare rather than a white-out (said in the UI).
 */
const SUN_INTENSITY = 30;
const PBD_EXPOSURE = 260;

type ViewId = 'dawn' | 'disk' | 'night' | 'iss' | 'moon' | 'eclipse' | 'voyager';
const VIEWS: Array<{ id: ViewId; label: string }> = [
  { id: 'dawn', label: 'Dawn' },
  { id: 'disk', label: 'Full disk' },
  { id: 'night', label: 'Night' },
  { id: 'iss', label: 'ISS' },
  { id: 'moon', label: 'Earthrise' },
  { id: 'eclipse', label: 'Eclipse' },
  { id: 'voyager', label: 'Pale Blue Dot' },
];
/** Densest night-light regions (lat, lon in degrees) and a weight for how spectacular they are. */
const NIGHT_REGIONS = [
  { name: 'Europe', lat: 48, lon: 10, weight: 1 },
  { name: 'Nile and the Levant', lat: 30, lon: 32, weight: 0.6 },
  { name: 'India', lat: 23, lon: 79, weight: 0.9 },
  { name: 'East Asia', lat: 34, lon: 118, weight: 1 },
  { name: 'North America', lat: 38, lon: -88, weight: 1 },
  { name: 'South America', lat: -20, lon: -47, weight: 0.6 },
];
const WARPS = [1, 10, 60, 600, 3600, 21600, 86400];

interface DepthLayer {
  scene: THREE.Scene;
  centre: THREE.Vector3;
  radius: number;
  dist: number;
}
const farToNear = (a: DepthLayer, b: DepthLayer) => b.dist - a.dist;

const fmt2 = (n: number) => String(n).padStart(2, '0');
function utcString(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${fmt2(d.getUTCMonth() + 1)}-${fmt2(d.getUTCDate())} ${fmt2(d.getUTCHours())}:${fmt2(d.getUTCMinutes())}`;
}
function latLon(lat: number, lon: number): string {
  const la = lat / DEG;
  let lo = ((((lon / DEG) + 180) % 360) + 360) % 360 - 180;
  if (lo === -180) lo = 180;
  return `${Math.abs(la).toFixed(1)}°${la >= 0 ? 'N' : 'S'} ${Math.abs(lo).toFixed(1)}°${lo >= 0 ? 'E' : 'W'}`;
}
function moonPhaseName(elong: number, waxing: boolean, k: number): string {
  if (k < 0.02) return 'New';
  if (k > 0.98) return 'Full';
  const e = elong / DEG;
  const base = e < 80 ? 'crescent' : e < 100 ? 'quarter' : 'gibbous';
  if (base === 'quarter') return waxing ? 'First quarter' : 'Last quarter';
  return `${waxing ? 'Waxing' : 'Waning'} ${base}`;
}
function warpLabel(w: number): string {
  if (w < 60) return `${formatNumber(w, 2)} s/s`;
  if (w < 3600) return `${formatNumber(w / 60, 2)} min/s`;
  if (w < 86400) return `${formatNumber(w / 3600, 2)} h/s`;
  return `${formatNumber(w / 86400, 2)} d/s`;
}

class EarthExperience implements Experience {
  private ctx!: ExperienceContext;
  private sky!: Sky;
  private cam!: EarthCamera;
  private earth!: PlanetRenderer;
  private moon!: PlanetRenderer;
  private sun!: StarRenderer;
  private sunbeam!: Sunbeam;
  private glare!: SunGlare;
  private readonly glareOcc = [{ c: new THREE.Vector3(), r: 1.004 }, { c: new THREE.Vector3(), r: MOON_R }];
  private earthScene = new THREE.Scene();
  private moonScene = new THREE.Scene();
  private sunScene = new THREE.Scene();
  private galleryScene = new THREE.Scene();

  // Simulation state.
  private simMs = Date.now();
  private warp = 60;
  private paused = false;
  private readonly origin = new THREE.Vector3();
  private readonly sunPos = new THREE.Vector3();
  private readonly sunDir = new THREE.Vector3();
  private readonly moonPos = new THREE.Vector3();
  private sunAng = 0.00465;
  private sun$ = sunState(msToJD(this.simMs));
  private moon$ = moonState(msToJD(this.simMs));
  private view: ViewId = 'dawn';
  private prePbdMs: number | null = null;
  private layers = { clouds: true, atmosphere: true, lights: true, aurora: true, moon: true };
  private exposureBase = 1;

  // Gallery.
  private world: GalleryWorld | null = null;
  private gPlanet: PlanetRenderer | null = null;
  private gStar: StarRenderer | null = null;
  private gTilt = new THREE.Group();
  private readonly gSun = new THREE.Vector3(1e5, 0, 0);
  private gLighting: Lighting = 'terminator';
  private gSpin = 0;

  // UI.
  private readouts: Readout[] = [];
  private rAlt: Readout | null = null;
  private rUtc: Readout | null = null;
  private rSun: Readout | null = null;
  private rMoon: Readout | null = null;
  private rPhase: Readout | null = null;
  private viewButtons: { setActive(i: number): void } | null = null;
  private warpCtl: Control<number> | null = null;
  private dayCtl: Control<number> | null = null;
  private hourCtl: Control<number> | null = null;
  private pauseBtn: Control<void> | null = null;
  private worldCtl: Control<string> | null = null;
  private earthSections: HTMLElement[] = [];
  private gallerySection: HTMLElement | null = null;
  private lightButtons: { setActive(i: number): void } | null = null;
  private label: HTMLDivElement | null = null;
  private readonly labelState = { on: false, x: NaN, y: NaN };
  private readonly planetUpdate: PlanetUpdate = { time: 0, sunPosition: this.sunPos, camera: new THREE.PerspectiveCamera() };
  private readonly galleryUpdate: PlanetUpdate = { time: 0, sunPosition: this.gSun, camera: new THREE.PerspectiveCamera() };
  private readonly starUpdate: { time: number; camera: THREE.Camera } = { time: 0, camera: new THREE.PerspectiveCamera() };
  private uiClock = 0;

  // Scratch.
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  /** Lunar eclipses: sunlight refracted through the Earth's atmosphere reddens the umbra. */
  private readonly earthOccluders = [{ position: this.moonPos, radius: MOON_R }];
  private readonly noOccluders: Array<{ position: THREE.Vector3; radius: number }> = [];
  private readonly moonOccluders = [{ position: new THREE.Vector3(), radius: 1.012, umbraLight: new THREE.Color(0.012, 0.0035, 0.0009) }];
  private readonly astro = { x: 0, y: 0, z: 0 };
  private readonly bodies: DepthLayer[] = [];
  /** Depth layers reused every frame: Sun, Moon, Earth (1.075 R⊕ encloses the aurora shell), gallery. */
  private readonly layerSlots: [DepthLayer, DepthLayer, DepthLayer, DepthLayer] = [
    { scene: this.sunScene, centre: this.sunPos, radius: SUN_R * 6.5, dist: 0 },
    { scene: this.moonScene, centre: this.moonPos, radius: MOON_R * 1.01, dist: 0 },
    { scene: this.earthScene, centre: this.origin, radius: 1.075, dist: 0 },
    { scene: this.galleryScene, centre: this.origin, radius: 1.2, dist: 0 },
  ];
  /** UTC start of the simulated year (cached: recomputed only when the year changes). */
  private yearStart = { year: -1, ms: 0 };

  // ——— Debug hooks (also used by the UI) ———

  /** Jump to a named view: dawn · disk · night · iss · moon · voyager. */
  setView(id: ViewId, tween = 3.2): void {
    if (this.world) this.setWorld('earth');
    this.view = id;
    this.uiClock = 0;
    this.viewButtons?.setActive(VIEWS.findIndex((v) => v.id === id));
    this.ctx.ui.info(null);
    const c = this.cam;
    const earthFraming: OrbitFraming = { focus: () => this.origin, fov: (d) => this.fovFor(d) };
    const s = this.sunDir;
    // Camera direction at `west` degrees west of the Sun's meridian (morning side) and latitude `lat`.
    const dirFrom = (west: number, lat: number) => {
      const v = this.tmp.set(s.x, 0, s.z).normalize().applyAxisAngle(THREE.Object3D.DEFAULT_UP, -west * DEG);
      return v.multiplyScalar(Math.cos(lat * DEG)).setY(Math.sin(lat * DEG)).normalize();
    };
    const orbit = (d: number, west: number, lat: number, framing: OrbitFraming) => {
      const v = dirFrom(west, lat);
      c.setOrbit(framing, { distance: d, yaw: Math.atan2(v.x, v.z), pitch: Math.asin(v.y) }, tween);
    };
    if (id !== 'iss' && this.warp === 1) this.setWarp(60);
    // Leaving a historical/future moment (Pale Blue Dot, eclipse) returns to the time we left from.
    if (id !== 'voyager' && id !== 'eclipse' && this.prePbdMs !== null) {
      this.setTime(this.prePbdMs);
      this.prePbdMs = null;
    }
    switch (id) {
      case 'dawn':
        orbit(3.9, 74, 16, { ...earthFraming, frameX: 0.06 });
        break;
      case 'disk':
        orbit(GEO_R, 8, 4, { focus: () => this.origin, fov: 19.5 });
        break;
      case 'night': {
        // Over whichever great web of city lights is deepest in night right now.
        const jd = msToJD(this.simMs);
        let best = NIGHT_REGIONS[0];
        let bestEl = Infinity;
        for (const r of NIGHT_REGIONS) {
          const el = solarElevation(r.lat * DEG, r.lon * DEG, jd);
          const score = el < -0.3 ? -1 - r.weight * 0.5 + el * 0.2 : el;
          if (score < bestEl) {
            bestEl = score;
            best = r;
          }
        }
        const lon = best.lon * DEG + gmst(jd);
        const lat = (best.lat + 5) * DEG;
        const v = this.tmp.set(Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon));
        c.setOrbit({ ...earthFraming, frameY: -0.02 }, { distance: 2.6, yaw: Math.atan2(v.x, v.z), pitch: Math.asin(v.y) }, tween);
        this.ctx.ui.toast(`Night over ${best.name}`);
        break;
      }
      case 'iss':
        this.enterISS(tween);
        this.setWarp(1);
        this.ctx.ui.toast('Real time · 7.66 km/s · 92 minutes per orbit');
        break;
      case 'moon': {
        // Earthrise, as from Apollo 8: low lunar orbit (~120 km), the Earth a few degrees above the
        // lunar horizon, on the side of the Moon the Sun is lighting.
        const e = this.tmp2.copy(this.moonPos).negate().normalize();
        const p = this.tmp.copy(this.sunDir).addScaledVector(e, -this.sunDir.dot(e));
        if (p.length() < 0.25) p.set(0, 1, 0).addScaledVector(e, -e.y);
        p.normalize();
        const D = 1 + 900 / 1737.4;
        const beta = Math.asin(1 / D) + 3.2 * DEG;
        const u = e.clone().multiplyScalar(-Math.cos(beta)).addScaledVector(p, Math.sin(beta)).normalize();
        c.setOrbit(
          { focus: () => this.moonPos, aim: () => this.origin, aimBlend: 1, frameY: 0.04, fov: 13, radialUp: true },
          { distance: D * MOON_R, yaw: Math.atan2(u.x, u.z), pitch: Math.asin(u.y) },
          tween > 0 ? Math.max(tween, 4.5) : 0,
        );
        if (!this.layers.moon) this.setLayer('moon', true);
        break;
      }
      case 'eclipse': {
        // Total solar eclipse of 2 August 2027: greatest eclipse 10:07 UT near Luxor (25.5°N 33.2°E),
        // 6 min 23 s of totality. The umbra and penumbra are the Moon's real shadow (occluder model).
        if (this.prePbdMs === null) this.prePbdMs = this.simMs;
        this.setTime(Date.UTC(2027, 7, 2, 10, 7, 50));
        this.setWarp(60);
        if (!this.layers.moon) this.setLayer('moon', true);
        this.lookAt(25.5, 33.2, 4.0, tween);
        this.ctx.ui.toast('Total solar eclipse · 2 August 2027 · the Moon’s shadow over Egypt');
        break;
      }
      case 'voyager':
        this.paleBlueDot(tween > 0);
        break;
    }
    this.ctx.audio.setMood('earth', { intensity: id === 'voyager' ? 0.2 : 0.35, view: id });
  }

  /** Debug: camera above a geographic point (deg) at `distance` Earth radii (Earth-centred orbit). */
  lookAt(latDeg: number, lonDeg: number, distance = 2.6, tween = 0): void {
    if (this.world) this.setWorld('earth');
    const lon = lonDeg * DEG + gmst(msToJD(this.simMs));
    const lat = latDeg * DEG;
    const v = this.tmp.set(Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon));
    this.cam.setOrbit({ focus: () => this.origin, fov: (d) => this.fovFor(d) }, { distance, yaw: Math.atan2(v.x, v.z), pitch: Math.asin(v.y) }, tween);
  }

  /** Set the simulated UTC time (ISO string or ms). */
  setTime(t: string | number): void {
    this.simMs = typeof t === 'number' ? t : Date.parse(t);
    this.uiClock = 0;
    this.computeEphemeris();
  }

  setWarp(w: number): void {
    this.warp = w;
    this.warpCtl?.set(w);
  }

  setPaused(p: boolean): void {
    this.paused = p;
    const b = this.pauseBtn?.el.querySelector('button');
    if (b) b.textContent = p ? 'Play' : 'Pause';
  }

  /** Switch to a gallery world ('earth' returns home). */
  setWorld(id: string): void {
    const w = GALLERY.find((g) => g.id === id) ?? null;
    this.disposeGallery();
    this.world = w;
    this.worldCtl?.set(w ? w.id : 'earth');
    for (const el of this.earthSections) el.style.display = w ? 'none' : '';
    if (this.gallerySection) this.gallerySection.style.display = w ? '' : 'none';
    this.buildReadouts();
    if (!w) {
      this.ctx.post.exposure = this.exposureBase;
      this.ctx.ui.info(null);
      this.setView(this.view === 'voyager' ? 'dawn' : this.view, 0);
      return;
    }
    const detail = this.ctx.quality.detail;
    this.gTilt.rotation.set(0, 0, 0);
    if (w.preset === 'sun') {
      this.gStar = createStar({ seed: 3, temperatureK: 5772, radius: 1, intensity: 1, activity: 0.75, corona: 1.2, detail });
      this.gTilt.add(this.gStar.object);
      this.gTilt.rotation.z = -7.25 * DEG;
    } else {
      const spec = planetSpec(w.preset, 1, { detail });
      this.gPlanet = createPlanet(spec);
      this.gPlanet.prepare(this.ctx.renderer);
      this.gTilt.add(this.gPlanet.object);
      // Tilt the pole toward the Sun (+x) so rings are lit from above in the default views.
      const tilt = spec.axialTilt ?? 0;
      this.gTilt.rotation.z = -Math.min(tilt, Math.PI - tilt);
    }
    this.ctx.ui.info({ title: w.label, subtitle: w.subtitle, rows: w.rows, body: w.body });
    this.setLighting(w.lighting, w, 0);
    // Turn a named storm (the Great Red Spot) toward the camera, a little toward the lit side.
    const storm = this.gPlanet?.stormPosition;
    const yawCam = Math.PI / 2 - phaseFor(w.lighting);
    const lonCam = Math.atan2(-Math.cos(yawCam), Math.sin(yawCam));
    this.gSpin = storm ? lonCam - storm.lon + 0.15 : 0;
    this.ctx.audio.setMood('earth', { intensity: 0.3, world: w.id });
  }

  /** Gallery lighting: 'day' | 'terminator' | 'crescent' | 'backlit'. */
  setLighting(l: Lighting, w = this.world, tween = 2): void {
    if (!w) return;
    this.gLighting = l;
    this.lightButtons?.setActive(['day', 'terminator', 'crescent', 'backlit'].indexOf(l));
    const phase = phaseFor(l);
    const pitch = w.pitch ?? 0.12;
    // Sun along +x; the camera sits `phase` from it about the vertical.
    const yaw = Math.PI / 2 - phase;
    this.cam.setOrbit({ focus: () => this.origin, fov: 28, frameX: w.frameX ?? 0 }, { distance: w.distance, yaw, pitch }, tween);
    // Gallery exposure: the star is ~40× a lit planet; backlit scenes are faint (forward scattering
    // and ringshine), so they get a longer exposure — as Cassini's did.
    const giant = w.preset === 'jupiter' || w.preset === 'saturn';
    this.ctx.post.exposure = w.preset === 'sun' ? 0.02 : this.exposureBase * (l === 'backlit' ? 3.5 : giant ? 0.85 : 1);
    this.uiClock = 0;
  }

  // ——— Lifecycle ———

  async mount(ctx: ExperienceContext): Promise<void> {
    this.ctx = ctx;
    const p = ctx.params;
    if (p.has('t')) this.simMs = Date.parse(p.get('t')!);
    const detail = ctx.quality.detail;
    this.computeEphemeris();

    // The Milky Way stays faint: at the Earth's daylight exposure it would be invisible, and brighter it
    // reads as a grey-brown haze on an OLED black (docs/VISION.md). Its cube bake scales with the tier.
    this.sky = new Sky({ frame: 'equatorial', stars: Math.round(20000 * detail), milkyWay: 0.22, brightness: 0.9, bandResolution: detail >= 0.9 ? 1024 : 512 });
    this.earth = createPlanet(planetSpec('earth', 1, { detail }));
    this.moon = createPlanet(planetSpec('moon', MOON_R, { detail }));
    this.sun = createStar({ seed: 3, temperatureK: 5772, radius: SUN_R, intensity: SUN_INTENSITY, activity: 0.6, detail });
    this.sunbeam = new Sunbeam();
    this.glare = new SunGlare();
    this.earthScene.add(this.earth.object);
    this.moonScene.add(this.moon.object);
    this.sunScene.add(this.sun.object);
    this.galleryScene.add(this.gTilt);

    this.cam = new EarthCamera(ctx.input, { focus: () => this.origin, fov: (d) => this.fovFor(d) });

    ctx.post.exposure = this.exposureBase = Number(p.get('exposure') ?? 1.0);
    ctx.post.bloomStrength = 0.035;
    ctx.post.bloomRadius = 0.75;
    ctx.post.vignette = 0.12;
    const tm = p.get('tonemap');
    if (tm === 'aces' || tm === 'agx' || tm === 'agx-punchy' || tm === 'linear') ctx.post.tonemap = tm;

    ctx.progress(0.15, 'Blue Marble');
    await Promise.all([this.earth.ready, this.moon.ready]);
    ctx.progress(0.7, 'Atmosphere');
    this.earth.prepare(ctx.renderer);
    this.moon.prepare(ctx.renderer);

    this.buildUI();
    this.setView((p.get('view') as ViewId) ?? 'dawn', 0);
    if (p.has('world')) this.setWorld(p.get('world')!);
    if (p.has('warp')) this.setWarp(Number(p.get('warp')));
    this.update({ dt: 0, time: 0, frame: 0 });
    ctx.audio.setMood('earth', { intensity: 0.35, view: this.view });
    ctx.ui.hint('Drag to orbit · Scroll to zoom · 1–7 views · Space pause · [ ] time warp');
    ctx.progress(1);
    ctx.signalReady();
  }

  private computeEphemeris(): void {
    const jd = msToJD(this.simMs);
    const s = (this.sun$ = sunState(jd));
    radecToVector(s.ra, s.dec, this.astro);
    astroToThree(this.tmp.set(this.astro.x, this.astro.y, this.astro.z), this.sunDir);
    this.sunDir.normalize();
    this.sunPos.copy(this.sunDir).multiplyScalar(s.distanceAU * AU_RE);
    this.sunAng = Math.asin(SUN_R / (s.distanceAU * AU_RE));
    const m = (this.moon$ = moonState(jd));
    radecToVector(m.ra, m.dec, this.astro);
    astroToThree(this.tmp.set(this.astro.x, this.astro.y, this.astro.z), this.moonPos);
    this.moonPos.normalize().multiplyScalar(m.distanceKm / R_EARTH_KM);
  }

  update(f: FrameInfo): void {
    const simDt = this.paused ? 0 : f.dt * this.warp;
    this.simMs += simDt * 1000;
    this.computeEphemeris();
    const jd = msToJD(this.simMs);
    // Shader time: seconds since the start of the year (keeps float32 animation phases precise).
    const tShader = (this.simMs - this.yearStartMs()) / 1000;

    // Earth: sidereal rotation, seasonal imagery, the Moon's shadow.
    this.earth.setRotation(gmst(jd));
    this.earth.setDate(this.simMs);
    this.earth.setOccluders(this.layers.moon ? this.earthOccluders : this.noOccluders);
    // Moon: tidally locked (prime meridian toward the Earth), pole ≈ ecliptic north.
    moonOrientation(this.moonPos, meanObliquity(jd), this.moon.object.quaternion);
    this.moon.object.position.copy(this.moonPos);
    this.moon.object.visible = this.layers.moon;
    // Lunar eclipses: sunlight refracted through the Earth's atmosphere reddens the umbra.
    this.moon.setOccluders(this.moonOccluders);
    this.sun.object.position.copy(this.sunPos);

    if (this.world) {
      this.gSpin += (simDt / 3600 / this.world.rotationHours) * Math.PI * 2;
      this.gSpin %= Math.PI * 2;
    }
    this.cam.update(f.dt, this.world ? 0 : simDt);
    this.cam.apply(this.aspect);
    const camera = this.cam.camera;
    // Reused update records (no per-frame garbage).
    const pu = this.planetUpdate;
    pu.time = tShader;
    pu.camera = camera;
    pu.sunAngularRadius = this.sunAng;
    pu.renderer = this.ctx.renderer;
    this.earth.update(pu);
    this.moon.update(pu);
    const su = this.starUpdate;
    su.time = tShader;
    su.camera = camera;
    this.sun.update(su);
    if (this.gPlanet) {
      this.gPlanet.setRotation(this.gSpin);
      const gu = this.galleryUpdate;
      gu.time = tShader;
      gu.camera = camera;
      gu.renderer = this.ctx.renderer;
      this.gPlanet.update(gu);
    }
    if (this.gStar) {
      this.gStar.object.rotation.y = this.gSpin;
      this.gStar.update(su);
    }

    // Pale Blue Dot: exposure follows the distance (the glare and stray light are drawn in render()).
    if (!this.world) {
      const t = pbdProgress(this.cam.altitudeRadius);
      const boost = Math.exp(Math.log(PBD_EXPOSURE) * smooth(0.45, 1, t));
      this.ctx.post.exposure = this.exposureBase * boost;
      this.sky.exposure = 1 / Math.pow(boost, 0.85);
    } else {
      this.sky.exposure = 1;
    }
    this.updateUI(f.dt);
  }

  private aspect = 16 / 9;

  /** UTC ms of 1 January of the simulated year (no Date allocation unless the year changed). */
  private yearStartMs(): number {
    const ys = this.yearStart;
    // A year is 365–366 days: only re-derive the year near or past the cached bounds.
    if (ys.year < 0 || this.simMs < ys.ms || this.simMs >= ys.ms + 365 * 86_400_000) {
      const y = new Date(this.simMs).getUTCFullYear();
      ys.year = y;
      ys.ms = Date.UTC(y, 0, 1);
    }
    return ys.ms;
  }

  resize(w: number, h: number): void {
    this.aspect = w / Math.max(1, h);
  }

  render(target: THREE.WebGLRenderTarget): void {
    const r = this.ctx.renderer;
    this.aspect = target.width / Math.max(1, target.height);
    const camera = this.cam.apply(this.aspect);
    r.setRenderTarget(target);
    // Sky at infinity (the camera's rotation only).
    camera.near = 0.1;
    camera.far = 10;
    camera.updateProjectionMatrix();
    this.sky.render(r, camera, this.ctx.engine.pixelRatio);

    // Depth layers, far to near (entries preallocated: no per-frame garbage).
    const list = this.bodies;
    list.length = 0;
    const [lSun, lMoon, lEarth, lGallery] = this.layerSlots;
    if (this.world) {
      lGallery.radius = this.gPlanet?.spec.rings ? this.gPlanet.spec.rings.outer * 1.05 : this.gStar ? 6.5 : 1.2;
      list.push(lGallery);
    } else {
      lSun.dist = camera.position.distanceTo(this.sunPos);
      list.push(lSun);
      if (this.layers.moon) {
        lMoon.dist = camera.position.distanceTo(this.moonPos);
        list.push(lMoon);
      }
      lEarth.dist = camera.position.length();
      list.push(lEarth);
      list.sort(farToNear);
    }
    for (const b of list) {
      r.clearDepth();
      this.cam.bracket(b.centre, b.radius);
      r.render(b.scene, camera);
    }
    if (!this.world) {
      // Veiling glare of the Sun, hidden when the Earth (or Moon) covers the disk.
      this.glareOcc[1].c.copy(this.moonPos);
      this.glareOcc[1].r = this.layers.moon ? MOON_R : 0;
      const vis = SunGlare.visibility(camera.position, this.sunPos, SUN_R, this.glareOcc, this.tmp);
      this.glare.render(r, camera, this.sunPos, (vis * 2.5) / this.ctx.post.exposure);
      const t = pbdProgress(this.cam.altitudeRadius);
      const k = smooth(0.8, 1, t);
      if (k > 0) this.sunbeam.render(r, camera, this.sunPos, this.origin, (k * 0.05) / this.ctx.post.exposure);
    }
  }

  unmount(): void {
    this.disposeGallery();
    this.earth.dispose();
    this.moon.dispose();
    this.sun.dispose();
    this.sunbeam.dispose();
    this.glare.dispose();
    this.sky.dispose();
    for (const r of this.readouts) r.remove();
    this.readouts = [];
  }

  // ——— Views ———

  private fovFor(d: number): number {
    // The camera's field spans the narrow screen dimension (see EarthCamera.apply), in CSS pixels.
    const e = this.ctx.engine;
    return fovForDistance(d, Math.min(e.cssWidth, e.cssHeight));
  }

  private enterISS(tween: number): void {
    // ISS-like orbit: 420 km, inclination 51.6°. Pick the node so the Sun lies ~12° from the orbit
    // plane (β angle), then start ~40 s before orbital sunrise, looking along-track toward it.
    const rad = 1 + 420 / R_EARTH_KM;
    const inc = 51.64 * DEG;
    const s = this.sunDir;
    let best = { node: 0, err: Infinity };
    const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n = new THREE.Vector3();
    const basis = (node: number) => {
      e1.set(Math.cos(node), 0, -Math.sin(node));
      e2.set(-Math.sin(node) * Math.cos(inc), Math.sin(inc), -Math.cos(node) * Math.cos(inc));
      n.crossVectors(e1, e2);
    };
    for (let i = 0; i < 360; i++) {
      const node = i * DEG;
      basis(node);
      const beta = Math.asin(n.dot(s));
      const err = Math.abs(beta - 12 * DEG);
      if (err < best.err) best = { node, err };
    }
    basis(best.node);
    // Scan for shadow → sunlight along the orbit.
    const lit = (a: number) => {
      const px = Math.cos(a) * rad, py = Math.sin(a) * rad;
      const P = this.tmp.copy(e1).multiplyScalar(px).addScaledVector(e2, py);
      const along = P.dot(s);
      if (along >= 0) return true;
      return P.addScaledVector(s, -along).length() > 1.0;
    };
    let anomaly = 0;
    for (let i = 0; i < 3600; i++) {
      const a = (i / 3600) * Math.PI * 2;
      if (!lit(a) && lit(a + (Math.PI * 2) / 3600)) {
        anomaly = a;
        break;
      }
    }
    // Arrive a minute after orbital sunrise, looking toward the Sun (a little left of it).
    anomaly += meanMotion(rad) * 200;
    const P = this.tmp.copy(e1).multiplyScalar(Math.cos(anomaly)).addScaledVector(e2, Math.sin(anomaly));
    const U = P.normalize();
    const V = this.tmp2.copy(e1).multiplyScalar(-Math.sin(anomaly)).addScaledVector(e2, Math.cos(anomaly));
    const Sh = n.copy(s).addScaledVector(U, -s.dot(U)).normalize();
    const yaw = Math.atan2(new THREE.Vector3().crossVectors(V, Sh).dot(U), V.dot(Sh)) + 0.3;
    this.cam.setHorizon({ radius: rad, e1: e1.clone(), e2: e2.clone(), anomaly, yaw, elevation: -0.16, fov: 56 }, tween);
  }

  private paleBlueDot(animate: boolean): void {
    // Voyager 1, 14 February 1990: 40.47 AU from the Sun toward RA 17h13m, Dec +12°.
    if (this.prePbdMs === null) this.prePbdMs = this.simMs;
    this.setTime(VOYAGER1_PALE_BLUE_DOT.utc);
    this.setWarp(60);
    const g = voyagerGeocentricAU();
    const pos = astroToThree(this.tmp.set(g.x, g.y, g.z), new THREE.Vector3()).multiplyScalar(AU_RE);
    const dist = pos.length();
    const u = pos.normalize();
    const framing: OrbitFraming = { focus: () => this.origin, fov: (d) => this.fovFor(d) };
    const yaw = Math.atan2(u.x, u.z), pitch = Math.asin(u.y);
    if (!animate) {
      this.cam.setOrbit(framing, { distance: dist, yaw, pitch }, 0);
    } else {
      // Start from where we are (as an Earth-centred orbit), then pull back for 16 s.
      const cp = this.cam.pose.position;
      const d0 = Math.max(cp.length(), 1.2);
      this.cam.setOrbit(framing, { distance: d0, yaw: Math.atan2(cp.x, cp.z), pitch: Math.asin(THREE.MathUtils.clamp(cp.y / d0, -1, 1)) }, 1.2);
      this.cam.rig.flyTo({ distance: dist, yaw, pitch }, 16);
    }
    this.ctx.ui.info({
      title: 'Pale Blue Dot',
      subtitle: 'Voyager 1 · 14 February 1990 · 40.5 AU',
      rows: [
        ['Distance', '6.05 × 10⁹ km'],
        ['Earth', '0.12 pixel'],
        ['Camera', 'NAC, 0.424° field'],
      ],
      body: 'Looking back from beyond Neptune’s orbit, the Earth is a fraction of a pixel inside a ray of sunlight scattered in the camera. “That’s here. That’s home. That’s us.” — Carl Sagan. The exposure is raised to show it, as Voyager’s was.',
    });
  }

  private setLayer(k: keyof EarthExperience['layers'], v: boolean): void {
    this.layers[k] = v;
    this.earth.setOptions({
      clouds: this.layers.clouds ? 1 : 0,
      atmosphere: this.layers.atmosphere ? 1 : 0,
      cityLights: this.layers.lights ? 1 : 0,
      aurora: this.layers.aurora ? 0.7 : 0,
      airglow: this.layers.aurora ? 0.6 : 0,
    });
  }

  private disposeGallery(): void {
    this.gPlanet?.dispose();
    this.gStar?.dispose();
    this.gPlanet = null;
    this.gStar = null;
    this.gTilt.clear();
  }

  // ——— UI ———

  private buildUI(): void {
    const ui = this.ctx.ui;
    const views = ui.section('View');
    this.viewButtons = views.buttons(
      VIEWS.map((v) => ({ label: v.label, onClick: () => this.setView(v.id) })),
      0,
    );
    views.text('Earth, Sun, Moon and stars in their real places for the date shown.');

    const time = ui.section('Time');
    this.pauseBtn = time.button({ label: 'Pause', onClick: () => this.setPaused(!this.paused) });
    time.buttons([
      { label: 'Now', onClick: () => this.setTime(Date.now()) },
      { label: 'Solstice', onClick: () => this.jumpSeason(5, 21) },
      { label: 'Equinox', onClick: () => this.jumpSeason(8, 23) },
    ]);
    this.warpCtl = time.slider({ label: 'Time warp', min: 1, max: 86400, log: true, value: this.warp, format: warpLabel, onChange: (v) => (this.warp = v) });
    this.dayCtl = time.slider({
      label: 'Day of year',
      min: 1,
      max: 365,
      step: 1,
      value: 1,
      format: (v) => {
        const d = new Date(Date.UTC(2001, 0, Math.round(v)));
        return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
      },
      onChange: (v) => {
        const d = new Date(this.simMs);
        const start = Date.UTC(d.getUTCFullYear(), 0, 1);
        const tod = this.simMs - Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
        this.setTime(start + (Math.round(v) - 1) * 86_400_000 + tod);
      },
    });
    this.hourCtl = time.slider({
      label: 'Time of day',
      min: 0,
      max: 24,
      step: 0.05,
      value: 12,
      format: (v) => `${fmt2(Math.floor(v) % 24)}:${fmt2(Math.floor((v % 1) * 60))} UTC`,
      onChange: (v) => {
        const d = new Date(this.simMs);
        this.setTime(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + v * 3_600_000);
      },
    });

    const lay = ui.section('Layers');
    lay.toggle({ label: 'Clouds', value: true, onChange: (v) => this.setLayer('clouds', v) });
    lay.toggle({ label: 'Atmosphere', value: true, onChange: (v) => this.setLayer('atmosphere', v) });
    lay.toggle({ label: 'City lights', value: true, onChange: (v) => this.setLayer('lights', v) });
    lay.toggle({ label: 'Aurora & airglow', value: true, onChange: (v) => this.setLayer('aurora', v) });
    lay.toggle({ label: 'The Moon', value: true, onChange: (v) => this.setLayer('moon', v) });
    lay.slider({ label: 'Relief', min: 0, max: 12, value: 6, format: (v) => `×${v.toFixed(1)}`, onChange: (v) => this.earth.setOptions({ relief: v }), help: 'Vertical exaggeration of GEBCO terrain shading' });
    lay.text('Night lights are shown ~10⁴× brighter than a daylight exposure would record them, as in every night image of Earth.');

    const wsec = ui.section('Other worlds');
    this.worldCtl = wsec.select({
      label: 'World',
      value: 'earth',
      options: [{ value: 'earth', label: 'Earth' }, ...GALLERY.map((g) => ({ value: g.id, label: g.label }))],
      onChange: (v) => this.setWorld(v),
    });
    const gl = ui.section('Lighting');
    this.lightButtons = gl.buttons(
      [
        { label: 'Day', onClick: () => this.setLighting('day') },
        { label: 'Terminator', onClick: () => this.setLighting('terminator') },
        { label: 'Crescent', onClick: () => this.setLighting('crescent') },
        { label: 'Backlit', onClick: () => this.setLighting('backlit') },
      ],
      1,
    );
    this.gallerySection = gl.el;
    gl.el.style.display = 'none';
    this.earthSections = [views.el, time.el, lay.el];

    this.buildReadouts();

    // Pale Blue Dot marker.
    const lab = document.createElement('div');
    lab.style.cssText =
      'position:absolute;left:0;top:0;pointer-events:none;opacity:0;transition:opacity 1.2s;font:300 12px/1.3 var(--font-ui);letter-spacing:.08em;color:var(--ink-2);white-space:nowrap';
    lab.innerHTML =
      '<div style="position:absolute;left:-17px;top:-17px;width:34px;height:34px;border:1px solid var(--ink-3);border-radius:50%"></div><div style="position:absolute;left:26px;top:-8px">Earth · <span style="font-family:var(--font-mono)">0.12 px</span></div>';
    this.ctx.ui.overlay.appendChild(lab);
    this.label = lab;

    const input = this.ctx.input;
    input.onKeyDown((e) => {
      const k = e.code;
      if (k.startsWith('Digit')) {
        const i = Number(k.slice(5)) - 1;
        if (i >= 0 && i < VIEWS.length) this.setView(VIEWS[i].id);
      } else if (k === 'Space') this.setPaused(!this.paused);
      else if (k === 'BracketRight' || k === 'BracketLeft') {
        let i = WARPS.findIndex((w) => w >= this.warp - 1e-6);
        if (i < 0) i = WARPS.length - 1;
        i = THREE.MathUtils.clamp(i + (k === 'BracketRight' ? 1 : -1), 0, WARPS.length - 1);
        this.setWarp(WARPS[i]);
        this.ctx.ui.toast(`Time warp ${warpLabel(WARPS[i])}`);
      } else if (k === 'KeyN') this.setTime(Date.now());
    });
  }

  private buildReadouts(): void {
    for (const r of this.readouts) r.remove();
    this.readouts = [];
    this.rAlt = this.rUtc = this.rSun = this.rMoon = this.rPhase = null;
    const ui = this.ctx.ui;
    if (this.world) {
      const w = this.world;
      for (const [k, v] of w.rows.slice(0, 2)) {
        const r = ui.readout(k);
        r.set(v, '');
        this.readouts.push(r);
      }
      this.rPhase = ui.readout('Phase angle');
      this.readouts.push(this.rPhase);
      return;
    }
    this.rAlt = ui.readout('Altitude');
    this.rUtc = ui.readout('UTC');
    this.rSun = ui.readout('Sun overhead');
    this.rMoon = ui.readout('Moon');
    this.readouts.push(this.rAlt, this.rUtc, this.rSun, this.rMoon);
  }

  private jumpSeason(month: number, day: number): void {
    const d = new Date(this.simMs);
    const tod = this.simMs - Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    this.setTime(Date.UTC(d.getUTCFullYear(), month, day) + tod);
  }

  private updateUI(dt: number): void {
    // Pale Blue Dot marker follows the Earth's projected position.
    if (this.label) {
      // Touch the DOM only on change, and size from the engine (reading clientWidth after a style
      // write would force a synchronous layout every frame).
      const t = this.world ? 0 : pbdProgress(this.cam.altitudeRadius);
      const on = t > 0.97;
      const ls = this.labelState;
      if (on !== ls.on) {
        ls.on = on;
        this.label.style.opacity = on ? '1' : '0';
      }
      if (on) {
        const p = this.tmp.copy(this.origin).project(this.cam.camera);
        const e = this.ctx.engine;
        const x = Math.round(((p.x + 1) / 2) * e.cssWidth);
        const y = Math.round(((1 - p.y) / 2) * e.cssHeight);
        if (x !== ls.x || y !== ls.y) {
          ls.x = x;
          ls.y = y;
          this.label.style.transform = `translate(${x}px, ${y}px)`;
        }
      }
    }
    this.uiClock -= Math.max(dt, 1 / 60);
    if (this.uiClock > 0) return;
    this.uiClock = 0.2;
    if (this.world) {
      // Phase angle Sun–planet–camera.
      const c = this.cam.pose.position;
      const ph = Math.acos(THREE.MathUtils.clamp(c.dot(this.gSun) / (c.length() * this.gSun.length()), -1, 1));
      this.rPhase?.set((ph / DEG).toFixed(0), '°');
      return;
    }
    if (!this.rAlt) return;
    const alt = (this.cam.altitudeRadius - 1) * R_EARTH_KM * 1e3;
    const fa = formatDistance(alt, 3);
    this.rAlt.set(fa.value, fa.unit);
    this.rUtc?.set(utcString(this.simMs), '');
    const s = this.sun$;
    this.rSun?.set(latLon(s.subsolarLat, s.subsolarLon), '');
    const m = this.moon$;
    const waxing = Math.sin(m.longitude - s.longitude) > 0;
    this.rMoon?.set(`${moonPhaseName(m.elongation, waxing, m.illuminated)} ${Math.round(m.illuminated * 100)}`, '%');
    const d = new Date(this.simMs);
    const doy = Math.floor((this.simMs - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000) + 1;
    this.dayCtl?.set(Math.min(365, doy));
    this.hourCtl?.set(d.getUTCHours() + d.getUTCMinutes() / 60);
  }
}

export default () => new EarthExperience();
