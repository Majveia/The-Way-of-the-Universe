import * as THREE from 'three';
import type { PlanetSpec, PlanetUpdate, PlanetView } from './types';
import { resolveAtmosphereSpec, type AtmosphereRenderParams } from '../../physics/planets-atmosphere';
import { AURORA_LINES, lambertPhase, lineColor } from '../../physics/planets-photometry';
import { AURORA_LINES_NM, AURORA_SHELL_KM, LIGHTS_SCALE, NIGHT_GAIN, auroraLineGains, kiloRayleighRadiance, planetSteps } from './glow';
import { acquireLUTs, generateLUTs, releaseLUTs, type AtmosphereLUTs } from './luts';
import { BAKE_KINDS, bakeSurface, bakeSize, kindDefine, worldUniforms, type BakedSurface } from './bake';
import { ringTexture } from './rings';
import { ATMO_FRAG, POINT_FRAG, POINT_VERT, PROXY_VERT, RING_FRAG, SURFACE_FRAG } from './shaders';
import { acquireEarthImagery, acquireMoonImagery, releaseEarthImagery, releaseMoonImagery, seasonalBlend, type EarthImagery } from './textures';

/** Live-tunable presentation options (the Earth experience's layer toggles). */
export interface PlanetOptions {
  clouds?: number; // 0..1 opacity of the cloud layer
  atmosphere?: number; // scattered-light multiplier (0 hides the atmosphere)
  cityLights?: number; // radiance scale of night lights
  aurora?: number;
  airglow?: number;
  relief?: number;
  /** Emission scale for molten rock (1 = physical). */
  emission?: number;
}

/** The full renderer interface (a superset of the PlanetView contract). */
export interface PlanetRenderer extends PlanetView {
  /** Build GPU resources now (atmosphere LUTs, procedural bakes). Otherwise done on first render. */
  prepare(renderer: THREE.WebGLRenderer): void;
  /** Resolves when asynchronous imagery (Earth, Moon) is loaded; the planet stays hidden until then. */
  readonly ready: Promise<void>;
  setOptions(o: PlanetOptions): void;
  /** Real spheres that cast shadows on this planet (e.g. the Moon on the Earth), world space. */
  setOccluders(list: Array<{ position: THREE.Vector3; radius: number; umbraLight?: THREE.Color }>): void;
  /** Date (ms UTC) for seasonal imagery on Earth. */
  setDate(ms: number): void;
  /** Mean albedo colour (linear) used for sub-pixel rendering. */
  readonly meanAlbedo: THREE.Color;
  /** Planetocentric position of the named storm (gas giants with `storm`), rad; null otherwise. */
  readonly stormPosition: { lat: number; lon: number } | null;
}

/**
 * Radiance of a saturated city-light pixel. Real night lights are ~10⁻⁵ of daylight; like every
 * image of Earth at night they are shown far brighter than a daylight exposure would record
 * (the Earth experience says so in its info card). See glow.ts.
 */
export { LIGHTS_SCALE };

/**
 * The night-vision gain (~10⁵ over a daylight exposure) that aurora and airglow share with the city
 * lights, so their brightness relative to the cities is physical: a bright auroral arc (~100 kR in
 * O I 557.7 nm, ≈ 2.8 × 10⁻⁵ W m⁻² sr⁻¹ seen straight down) is a tenth of a bright city, brighter
 * edge-on; the ~400 R airglow layer is only visible edge-on at the limb, as in astronaut photographs.
 */
export const NIGHT_GLOW_SCALE = NIGHT_GAIN;

/** Zenith column rates of the night airglow (kR): O I 557.7 nm and the mesospheric Na D doublet. */
const AIRGLOW_KR = { green: 0.4, sodium: 0.1 };
/** Scale height (km) of the Gaussian airglow layer at 95 km (AURORA_GLSL.airglowEmission). */
const AIRGLOW_WIDTH_KM = 6;

const tmpM = new THREE.Matrix4();
const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpS = new THREE.Vector3();

/** Linear RGB of an emission line of luminance `lum` (renderer units): the chromaticity of λ × lum. */
function lineRGB(nm: number, lum: number): THREE.Vector3 {
  const c = lineColor(nm);
  return new THREE.Vector3(c[0] * lum, c[1] * lum, c[2] * lum);
}

let sharedEarthDefaults: { magAxis: THREE.Vector3 } | null = null;

function magneticAxis(): THREE.Vector3 {
  if (!sharedEarthDefaults) {
    // IGRF-13 dipole north pole (2025): 80.8°N, 72.7°W, in the Earth-fixed three.js frame.
    const lat = (80.8 * Math.PI) / 180;
    const lon = (-72.7 * Math.PI) / 180;
    sharedEarthDefaults = { magAxis: new THREE.Vector3(Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon)) };
  }
  return sharedEarthDefaults.magAxis;
}

function meanAlbedoFor(spec: PlanetSpec): THREE.Color {
  const c = new THREE.Color();
  switch (spec.kind) {
    case 'earth':
    case 'terrestrial':
      return c.setRGB(0.26, 0.3, 0.38, THREE.LinearSRGBColorSpace);
    case 'ocean':
      return c.setRGB(0.18, 0.24, 0.36, THREE.LinearSRGBColorSpace);
    case 'desert':
      return c.setRGB(0.3, 0.18, 0.1, THREE.LinearSRGBColorSpace);
    case 'lava':
      return c.setRGB(0.06, 0.05, 0.05, THREE.LinearSRGBColorSpace);
    case 'ice':
      return c.setRGB(0.66, 0.62, 0.58, THREE.LinearSRGBColorSpace);
    case 'barren':
      return c.setRGB(0.14, 0.13, 0.12, THREE.LinearSRGBColorSpace);
    case 'venus':
      return c.setRGB(0.8, 0.72, 0.52, THREE.LinearSRGBColorSpace);
    case 'gas-giant':
      return c.setRGB(0.55, 0.47, 0.36, THREE.LinearSRGBColorSpace);
    case 'ice-giant':
      return c.setRGB(0.36, 0.52, 0.66, THREE.LinearSRGBColorSpace);
  }
  return c.setRGB(0.3, 0.3, 0.3, THREE.LinearSRGBColorSpace);
}

/** Icosphere proxy scaled to the (oblate) shape and inflated so the faceted mesh encloses the true surface. */
function proxyGeometry(radius: number, ellipsoid: THREE.Vector3, detail: number, inflate: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(radius * inflate, detail);
  g.scale(ellipsoid.x, ellipsoid.y, ellipsoid.z);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  return g;
}

export class Planet implements PlanetRenderer {
  readonly object = new THREE.Group();
  readonly spec: PlanetSpec;
  readonly meanAlbedo: THREE.Color;
  readonly ready: Promise<void>;
  private body = new THREE.Group();
  private spin = new THREE.Group();
  private surface: THREE.Mesh;
  private surfaceMat: THREE.ShaderMaterial;
  private atmoT: THREE.Mesh | null = null;
  private atmoS: THREE.Mesh | null = null;
  private ringFar: THREE.Mesh | null = null;
  private ringNear: THREE.Mesh | null = null;
  private ringTex: THREE.DataTexture | null = null;
  private point: THREE.Points;
  private pointMat: THREE.ShaderMaterial;
  private materials: THREE.Material[] = [];
  private geometries: THREE.BufferGeometry[] = [];
  private atmo: AtmosphereRenderParams | null = null;
  private luts: AtmosphereLUTs | null = null;
  private baked: BakedSurface | null = null;
  private world: Record<string, THREE.IUniform> | null = null;
  private earth: EarthImagery | null = null;
  private earthMonths: [number, number] = [-1, -1];
  private readonly blend = { a: 0, b: 0, t: 0 };
  private renderer: THREE.WebGLRenderer | null = null;
  private usesEarth = false;
  private usesMoon = false;
  private disposed = false;
  private prepared = false;
  private dateMs = Date.now();
  private sunWorld = new THREE.Vector3(1e12, 0, 0);
  private occluders: Array<{ position: THREE.Vector3; radius: number; umbraLight?: THREE.Color }> = [];
  /** Uniforms in the spin frame (surface + atmosphere) and in the body frame (rings). */
  private spinU: Record<string, THREE.IUniform>;
  private bodyU: Record<string, THREE.IUniform>;
  private common: Record<string, THREE.IUniform>;
  private ellipsoid: THREE.Vector3;

  constructor(spec: PlanetSpec) {
    this.spec = spec;
    this.meanAlbedo = meanAlbedoFor(spec);
    const f = Math.min(Math.max(spec.oblateness ?? 0, 0), 0.3);
    this.ellipsoid = new THREE.Vector3(1, 1 - f, 1);
    this.body.scale.setScalar(spec.radius);
    this.object.add(this.body);
    this.body.add(this.spin);
    this.object.name = `planet:${spec.kind}`;

    const detail = spec.detail ?? 1;
    const kind = spec.kind;
    this.usesEarth = kind === 'earth';
    this.usesMoon = spec.texture === 'moon' && !this.usesEarth;
    // `atmosphere: null` means airless; undefined means the kind's default (Earth has one).
    const hasAtmo = spec.atmosphere === null ? false : spec.atmosphere !== undefined || kind === 'earth';
    if (hasAtmo) {
      const a = spec.atmosphere ?? (kind === 'earth' ? { preset: 'earth' as const } : {});
      this.atmo = resolveAtmosphereSpec(a, spec.radiusKm ?? (kind === 'earth' ? 6371 : 6371));
      this.luts = acquireLUTs(this.atmo);
    }
    const cloudAmount = spec.clouds ?? (kind === 'earth' ? 1 : 0);
    const hasClouds = cloudAmount > 0 && (kind === 'earth' || kind === 'terrestrial' || kind === 'ocean' || kind === 'desert' || kind === 'ice') && !!this.atmo;
    const hasRings = !!spec.rings && spec.rings.outer > spec.rings.inner;
    const auroraAmt = spec.aurora ?? (kind === 'earth' ? 0.7 : 0);
    const airglowAmt = spec.airglow ?? (kind === 'earth' ? 0.6 : 0);
    const hasAurora = (auroraAmt > 0 || airglowAmt > 0) && !!this.atmo;
    const radiusKm = spec.radiusKm ?? (kind === 'earth' ? 6371 : 6371);
    const steps = planetSteps(detail);
    const glowGain = auroraLineGains(radiusKm);
    // Airglow: zenith column rates → luminance per unit Gaussian profile per radius of path.
    const airglowCol = (AIRGLOW_WIDTH_KM * Math.sqrt(Math.PI)) / radiusKm;
    const airglowColor = lineRGB(AURORA_LINES.OI_GREEN, (AIRGLOW_KR.green * kiloRayleighRadiance(AURORA_LINES.OI_GREEN)) / airglowCol).add(
      lineRGB(AURORA_LINES.NA_D, (AIRGLOW_KR.sodium * kiloRayleighRadiance(AURORA_LINES.NA_D)) / airglowCol),
    );

    // Frame uniforms, recomputed per mesh in onBeforeRender.
    this.spinU = {
      uCamPos: { value: new THREE.Vector3(0, 0, 10) },
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      uOccluder0: { value: new THREE.Vector4(0, 0, 0, 0) },
      uOccluder1: { value: new THREE.Vector4(0, 0, 0, 0) },
      uMagAxis: { value: magneticAxis().clone() },
    };
    this.bodyU = {
      uCamPos: { value: new THREE.Vector3(0, 0, 10) },
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
    };
    const H = this.atmo?.rayleighH ?? 0.00126;
    this.common = {
      uEllipsoid: { value: this.ellipsoid },
      uSunColor: { value: new THREE.Vector3(1, 1, 1) },
      uSunAng: { value: 0.00465 },
      uTime: { value: 0 },
      uPixelRadius: { value: 1000 },
      uPixelAngle: { value: 1e-3 },
      uDepthMode: { value: 0 },
      uLogDepthFC: { value: 1 },
      uSteps: { value: new THREE.Vector3(steps.above, steps.below, steps.limb) },
      uGlowSteps: { value: new THREE.Vector3(steps.auroraLow, steps.auroraHigh, steps.airglow) },
      uAtmoIntensity: { value: this.atmo?.intensity ?? 1 },
      uAtmoTint: { value: new THREE.Vector3(...(this.atmo?.tint ?? [1, 1, 1])) },
      uCloudLayer: { value: new THREE.Vector2(1 + 0.25 * H, 1 + 1.1 * H) },
      uCloudOpacity: { value: hasClouds ? 1 : 0 },
      uCloudTime: { value: 0 },
      uCloudDensityScale: { value: kind === 'earth' ? 1 : 0.8 },
      uLights: { value: (spec.cityLights ?? (kind === 'earth' ? 1 : 0)) * LIGHTS_SCALE },
      uLightsColorA: { value: new THREE.Vector3(1.0, 0.56, 0.22) },
      uLightsColorB: { value: new THREE.Vector3(1.0, 0.82, 0.6) },
      uRoughness: { value: Math.sqrt(0.003 + 5.12e-3 * (spec.windSpeed ?? 7)) },
      uLavaT: { value: spec.lavaTemperatureK ?? 1400 },
      uEmission: { value: 1 },
      uRelief: { value: spec.relief ?? (kind === 'earth' ? 6 : this.usesMoon ? 2.5 : 1) },
      uBandTime: { value: 0 },
      uTintRT: { value: new THREE.Vector3(...(spec.color ?? [1, 1, 1])) },
      uBakeTexel: { value: Math.PI / 2 / bakeSize(spec) },
      uSeedOffRT: { value: new THREE.Vector3((spec.seed * 13.7) % 97, (spec.seed * 7.3) % 89, (spec.seed * 3.1) % 83) },
      uUmbraLight: { value: new THREE.Vector3(0, 0, 0) },
      uAurora: { value: auroraAmt },
      uAirglow: { value: airglowAmt },
      uAuroraGreen: { value: lineRGB(AURORA_LINES_NM.green, glowGain.green) },
      uAuroraRed: { value: lineRGB(AURORA_LINES_NM.red, glowGain.red) },
      uAuroraBlue: { value: lineRGB(AURORA_LINES_NM.blue, glowGain.blue) },
      uAirglowColor: { value: airglowColor },
      uAuroraTime: { value: 0 },
      uAuroraShell: { value: new THREE.Vector4(1 + AURORA_SHELL_KM[0] / radiusKm, 1 + AURORA_SHELL_KM[1] / radiusKm, 1 / radiusKm, 0) },
      uRingTex: { value: null },
      uRingRange: { value: new THREE.Vector2(0, 0) },
      uRingOpacity: { value: spec.rings?.opacity ?? 1 },
      uProxyScale: { value: 1 },
    };
    if (this.luts) {
      // Shared LUT/atmosphere uniforms, but the stellar angular size is per planet.
      for (const [k, v] of Object.entries(this.luts.uniforms)) if (k !== 'uSunAng') this.common[k] = v;
    }
    if (BAKE_KINDS.has(kind) && !this.usesMoon) this.world = worldUniforms(spec);
    if (hasRings) {
      this.ringTex = ringTexture(spec.rings!);
      this.common.uRingTex.value = this.ringTex;
      this.common.uRingRange.value.set(spec.rings!.inner, spec.rings!.outer);
    }

    const defines: Record<string, string> = { DETAIL_LEVEL: String(steps.detailLevel) };
    if (this.usesEarth) defines.KIND_EARTH = '';
    else if (this.usesMoon) defines.TEX_MOON = '';
    else defines[kindDefine(kind)] = '';
    if (this.atmo) defines.HAS_ATMO = '';
    if (hasClouds) defines.HAS_CLOUDS = '';
    if (hasRings) defines.HAS_RINGS = '';
    if (hasAurora) defines.HAS_AURORA = '';

    // ——— Surface ———
    const surfU: Record<string, THREE.IUniform> = { ...this.common, ...this.spinU };
    if (this.usesEarth) {
      Object.assign(surfU, {
        uDayA: { value: null },
        uDayB: { value: null },
        uDayMix: { value: 0 },
        uNight: { value: null },
        uClouds: { value: null },
        uTopo: { value: null },
      });
      this.common.uBakeTexel.value = Math.PI / 2048;
    } else if (this.usesMoon) {
      Object.assign(surfU, { uMoonColor: { value: null }, uMoonHeight: { value: null } });
    } else {
      Object.assign(surfU, { uCubeA: { value: null }, uCubeB: { value: null }, uCubeC: { value: null } });
    }
    this.surfaceMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: PROXY_VERT,
      fragmentShader: SURFACE_FRAG,
      uniforms: surfU,
      defines,
      side: THREE.FrontSide,
    });
    this.materials.push(this.surfaceMat);
    const sg = proxyGeometry(1, this.ellipsoid, 16, 1.0015);
    this.geometries.push(sg);
    this.surface = new THREE.Mesh(sg, this.surfaceMat);
    this.surface.name = 'planet-surface';
    this.surface.onBeforeRender = (r, _s, cam) => this.beforeSurface(r, cam);
    this.spin.add(this.surface);

    // ——— Rings: far half first, near half last (same z → stable id order) ———
    const makeRing = (half: number) => {
      const rg = new THREE.RingGeometry(spec.rings!.inner, spec.rings!.outer, 384, 6);
      rg.rotateX(-Math.PI / 2);
      this.geometries.push(rg);
      const rc = spec.rings!.color ?? [0.92, 0.84, 0.7];
      const m = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: PROXY_VERT,
        fragmentShader: RING_FRAG,
        uniforms: {
          ...this.common,
          ...this.bodyU,
          uHalf: { value: half },
          uProxyScale: { value: 1 },
          uRingColor: { value: new THREE.Vector3(rc[0], rc[1], rc[2]) },
          uRingColorB: { value: new THREE.Vector3(rc[0] * 0.78, rc[1] * 0.8, rc[2] * 0.9) },
          uRingAlbedo: { value: 0.55 },
          uDust: { value: spec.rings!.dust ?? 0.35 },
          uPlanetAlbedo: { value: new THREE.Vector3(this.meanAlbedo.r, this.meanAlbedo.g, this.meanAlbedo.b) },
        },
        side: THREE.DoubleSide,
        transparent: true,
        depthWrite: false,
        blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
        blendSrcAlpha: THREE.ZeroFactor,
        blendDstAlpha: THREE.OneFactor,
      });
      this.materials.push(m);
      const mesh = new THREE.Mesh(rg, m);
      mesh.name = half > 0 ? 'planet-ring-near' : 'planet-ring-far';
      mesh.onBeforeRender = (r, _s, cam) => this.beforeBody(r, cam, mesh);
      this.body.add(mesh);
      return mesh;
    };
    if (hasRings) this.ringFar = makeRing(-1);

    // ——— Atmosphere: transmittance (multiply) then in-scatter (add) ———
    if (this.atmo) {
      // The proxy encloses the air and, on worlds with aurora/airglow, their emitting shells too.
      const shellTop = hasAurora ? Math.max(this.atmo.top, 1 + AURORA_SHELL_KM[1] / radiusKm) : this.atmo.top;
      const ag = proxyGeometry(shellTop, this.ellipsoid, 12, 1.004);
      this.geometries.push(ag);
      const mk = (transmit: boolean) => {
        const m = new THREE.ShaderMaterial({
          glslVersion: THREE.GLSL3,
          vertexShader: PROXY_VERT,
          fragmentShader: ATMO_FRAG,
          uniforms: surfU,
          defines: transmit ? { ...defines, TRANSMIT: '' } : defines,
          side: THREE.BackSide,
          transparent: true,
          depthWrite: false,
          blending: THREE.CustomBlending,
          blendEquation: THREE.AddEquation,
          blendSrc: transmit ? THREE.ZeroFactor : THREE.OneFactor,
          blendDst: transmit ? THREE.SrcColorFactor : THREE.OneFactor,
          blendSrcAlpha: THREE.ZeroFactor,
          blendDstAlpha: THREE.OneFactor,
        });
        this.materials.push(m);
        return m;
      };
      this.atmoT = new THREE.Mesh(ag, mk(true));
      this.atmoS = new THREE.Mesh(ag, mk(false));
      this.atmoT.name = 'planet-atmosphere-transmittance';
      this.atmoS.name = 'planet-atmosphere-scattering';
      this.atmoT.onBeforeRender = (r, _s, cam) => this.beforeSpin(r, cam, this.atmoT!);
      this.atmoS.onBeforeRender = (r, _s, cam) => this.beforeSpin(r, cam, this.atmoS!);
      this.spin.add(this.atmoT, this.atmoS);
    }
    if (hasRings) this.ringNear = makeRing(1);

    // ——— Sub-pixel point ———
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
    pg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.5);
    this.geometries.push(pg);
    this.pointMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: POINT_VERT,
      fragmentShader: POINT_FRAG,
      uniforms: { uWorldRadius: { value: spec.radius }, uViewportH: { value: 1080 }, uPointColor: { value: new THREE.Vector3() } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.materials.push(this.pointMat);
    this.point = new THREE.Points(pg, this.pointMat);
    this.point.name = 'planet-point';
    this.point.frustumCulled = false;
    this.point.onBeforeRender = (r) => this.beforePoint(r);
    this.body.add(this.point);

    // ——— Imagery ———
    if (this.usesEarth) {
      this.surface.visible = false;
      const maxWidth = detail >= 0.9 ? 4096 : 2048;
      this.ready = acquireEarthImagery({ anisotropy: 8, maxWidth }).then(async (img) => {
        if (this.disposed) return;
        this.earth = img;
        this.surfaceMat.uniforms.uNight.value = img.night;
        this.surfaceMat.uniforms.uClouds.value = img.clouds;
        this.surfaceMat.uniforms.uTopo.value = img.topo;
        await this.syncSeason(true);
        if (!this.disposed) this.surface.visible = true;
      });
    } else if (this.usesMoon) {
      this.surface.visible = false;
      this.ready = acquireMoonImagery({ anisotropy: 8, maxWidth: detail >= 0.9 ? 4096 : 2048 }).then((m) => {
        if (this.disposed) return;
        this.surfaceMat.uniforms.uMoonColor.value = m.color;
        this.surfaceMat.uniforms.uMoonHeight.value = m.height;
        this.surface.visible = true;
      });
    } else {
      this.ready = Promise.resolve();
    }
    this.ready.catch(() => undefined);
  }

  // ——— GPU preparation ———

  prepare(renderer: THREE.WebGLRenderer): void {
    if (this.prepared || this.disposed) return;
    this.prepared = true;
    if (this.luts) generateLUTs(renderer, this.luts);
    if (this.world) {
      this.baked = bakeSurface(renderer, this.spec, this.world);
      const u = this.surfaceMat.uniforms;
      u.uCubeA.value = this.baked.albedo?.texture ?? null;
      u.uCubeB.value = this.baked.normal?.texture ?? this.baked.albedo?.texture ?? null;
      u.uCubeC.value = this.baked.clouds?.texture ?? this.baked.albedo?.texture ?? null;
    }
    this.renderer = renderer;
    const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    if (this.earth) {
      // Upload (and build mipmaps) now rather than inside the first frame that draws the planet.
      for (const t of [this.earth.night, this.earth.clouds, this.earth.topo]) {
        t.anisotropy = aniso;
        renderer.initTexture(t);
      }
      const u = this.surfaceMat.uniforms;
      for (const t of [u.uDayA.value, u.uDayB.value] as Array<THREE.Texture | null>) if (t) renderer.initTexture(t);
    }
  }

  // ——— Frame sync ———

  private sync(renderer: THREE.WebGLRenderer, camera: THREE.Camera, mesh: THREE.Object3D, u: Record<string, THREE.IUniform>): void {
    tmpM.copy(mesh.matrixWorld).invert();
    u.uCamPos.value.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(tmpM);
    tmpV.copy(this.sunWorld).applyMatrix4(tmpM);
    u.uSunDir.value.copy(tmpV).normalize();
    // Viewport, pixel angle, projected radius, depth mode.
    const rt = renderer.getRenderTarget();
    const h = rt ? rt.height : renderer.domElement.height;
    const pm = camera.projectionMatrix.elements;
    const perspective = (camera as THREE.PerspectiveCamera).isPerspectiveCamera;
    const p11 = pm[5];
    this.common.uPixelAngle.value = perspective ? 2 / (p11 * h) : 1e-6;
    mesh.matrixWorld.decompose(tmpV2, tmpQ, tmpS);
    const worldR = this.spec.radius * (this.object.matrixWorld.getMaxScaleOnAxis() || 1);
    const dist = tmpV.setFromMatrixPosition(camera.matrixWorld).distanceTo(tmpV2);
    const pxR = perspective ? (worldR / Math.max(dist, 1e-12)) * p11 * 0.5 * h : 1000;
    this.common.uPixelRadius.value = pxR;
    // Keep the proxies' silhouettes ≥ 2.5 px outside the limb (see PROXY_VERT).
    this.common.uProxyScale.value = 1 + Math.min(0.05, 2.5 / Math.max(pxR, 1));
    const caps = renderer.capabilities as unknown as { reverseDepthBuffer?: boolean; logarithmicDepthBuffer?: boolean };
    if (caps.logarithmicDepthBuffer) {
      this.common.uDepthMode.value = 2;
      const far = (camera as THREE.PerspectiveCamera).far ?? 1e9;
      this.common.uLogDepthFC.value = 2.0 / (Math.log(far + 1.0) / Math.LN2);
    } else this.common.uDepthMode.value = caps.reverseDepthBuffer ? 1 : 0;
  }

  private beforeSurface(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void {
    if (!this.prepared) this.prepare(renderer);
    this.beforeSpin(renderer, camera, this.surface);
    // Inside the (inflated) proxy? Render back faces so the ground still covers the view.
    const inside = tmpV.copy(this.spinU.uCamPos.value).divide(this.ellipsoid).length() < 1.0016 * (this.common.uProxyScale.value as number);
    const side = inside ? THREE.BackSide : THREE.FrontSide;
    if (this.surfaceMat.side !== side) {
      this.surfaceMat.side = side;
      this.surfaceMat.needsUpdate = true;
    }
  }

  private beforeSpin(renderer: THREE.WebGLRenderer, camera: THREE.Camera, mesh: THREE.Object3D): void {
    if (!this.prepared) this.prepare(renderer);
    this.sync(renderer, camera, mesh, this.spinU);
    // Occluders into the spin frame.
    tmpM.copy(mesh.matrixWorld).invert();
    const scale = 1 / (this.spec.radius * (this.object.matrixWorld.getMaxScaleOnAxis() || 1));
    for (let i = 0; i < 2; i++) {
      const o = this.occluders[i];
      const u = this.spinU[i === 0 ? 'uOccluder0' : 'uOccluder1'].value as THREE.Vector4;
      if (!o) {
        u.set(0, 0, 0, 0);
        continue;
      }
      tmpV.copy(o.position).applyMatrix4(tmpM);
      u.set(tmpV.x, tmpV.y, tmpV.z, o.radius * scale);
    }
  }

  private beforeBody(renderer: THREE.WebGLRenderer, camera: THREE.Camera, mesh: THREE.Object3D): void {
    if (!this.prepared) this.prepare(renderer);
    this.sync(renderer, camera, mesh, this.bodyU);
  }

  private beforePoint(renderer: THREE.WebGLRenderer): void {
    const rt = renderer.getRenderTarget();
    this.pointMat.uniforms.uViewportH.value = rt ? rt.height : renderer.domElement.height;
    this.pointMat.uniforms.uWorldRadius.value = this.spec.radius * (this.object.matrixWorld.getMaxScaleOnAxis() || 1);
  }

  // ——— Contract ———

  update(u: PlanetUpdate): void {
    this.sunWorld.copy(u.sunPosition);
    const c = this.common;
    const sc = u.sunColor;
    if (sc) c.uSunColor.value.set(sc.r, sc.g, sc.b);
    else c.uSunColor.value.set(1, 1, 1);
    if (u.sunAngularRadius !== undefined) c.uSunAng.value = Math.max(u.sunAngularRadius, 1e-5);
    c.uTime.value = u.time;
    c.uCloudTime.value = u.time / (8 * 3600);
    c.uBandTime.value = u.time / (30 * 3600);
    c.uAuroraTime.value = u.time / 40;
    if (u.renderer && !this.prepared) this.prepare(u.renderer);
    // Sub-pixel colour: disk-averaged radiance at the current phase angle.
    this.object.updateWorldMatrix(true, false);
    const centre = tmpV.setFromMatrixPosition(this.object.matrixWorld);
    const toSun = tmpV2.copy(this.sunWorld).sub(centre).normalize();
    const toCam = tmpS.setFromMatrixPosition(u.camera.matrixWorld).sub(centre).normalize();
    const alpha = Math.acos(THREE.MathUtils.clamp(toSun.dot(toCam), -1, 1));
    const k = (2 / 3) * lambertPhase(alpha) * (this.atmo ? 1.1 : 1);
    const pc = this.pointMat.uniforms.uPointColor.value as THREE.Vector3;
    pc.set(this.meanAlbedo.r * k * c.uSunColor.value.x, this.meanAlbedo.g * k * c.uSunColor.value.y, this.meanAlbedo.b * k * c.uSunColor.value.z);
    if (this.usesEarth) this.syncSeason(false);
  }

  setRotation(angle: number): void {
    this.spin.rotation.y = angle;
  }

  setDate(ms: number): void {
    this.dateMs = ms;
    if (this.usesEarth) this.syncSeason(false);
  }

  /**
   * Seasonal imagery: blend weight every frame (no allocation); when the bracketing months change,
   * load (once) and upload the new pair, and let the imagery cache release the months no longer used.
   */
  private syncSeason(force: boolean): Promise<void> | void {
    const img = this.earth;
    if (!img) return;
    const { a, b, t } = seasonalBlend(this.dateMs, this.blend);
    this.surfaceMat.uniforms.uDayMix.value = t;
    if (!force && this.earthMonths[0] === a && this.earthMonths[1] === b) return;
    this.earthMonths[0] = a;
    this.earthMonths[1] = b;
    return Promise.all([img.loadDay(a), img.loadDay(b)]).then(([ta, tb]) => {
      if (this.disposed || this.earthMonths[0] !== a || this.earthMonths[1] !== b) return;
      this.surfaceMat.uniforms.uDayA.value = ta;
      this.surfaceMat.uniforms.uDayB.value = tb;
      img.useMonths(this, a, b);
      if (this.renderer) {
        this.renderer.initTexture(ta);
        this.renderer.initTexture(tb);
      }
    });
  }

  /** (ext) Planetocentric position of the named storm (rad), or null. */
  get stormPosition(): { lat: number; lon: number } | null {
    if (!this.spec.storm || !this.world) return null;
    const v = this.world.uStormPos.value as THREE.Vector2;
    return { lat: v.x, lon: v.y };
  }

  setOptions(o: PlanetOptions): void {
    const c = this.common;
    if (o.clouds !== undefined) c.uCloudOpacity.value = o.clouds;
    if (o.atmosphere !== undefined) c.uAtmoIntensity.value = o.atmosphere * (this.atmo?.intensity ?? 1);
    if (o.cityLights !== undefined) c.uLights.value = o.cityLights * LIGHTS_SCALE;
    if (o.aurora !== undefined) c.uAurora.value = o.aurora;
    if (o.airglow !== undefined) c.uAirglow.value = o.airglow;
    if (o.relief !== undefined) c.uRelief.value = o.relief;
    if (o.emission !== undefined) c.uEmission.value = o.emission;
    if (this.atmoS) this.atmoS.visible = (c.uAtmoIntensity.value as number) > 0;
    if (this.atmoT) this.atmoT.visible = (c.uAtmoIntensity.value as number) > 0;
  }

  setOccluders(list: Array<{ position: THREE.Vector3; radius: number; umbraLight?: THREE.Color }>): void {
    // Stored by reference (no per-frame garbage); only the first two are used.
    this.occluders = list;
    let ul: THREE.Color | undefined;
    for (let i = 0; i < list.length && i < 2; i++) if (list[i].umbraLight) ul = list[i].umbraLight;
    this.common.uUmbraLight.value.set(ul?.r ?? 0, ul?.g ?? 0, ul?.b ?? 0);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.object.removeFromParent();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.ringTex?.dispose();
    this.baked?.dispose();
    if (this.luts) releaseLUTs(this.luts);
    if (this.usesEarth) {
      this.earth?.release(this);
      releaseEarthImagery();
    }
    if (this.usesMoon) releaseMoonImagery();
  }
}
