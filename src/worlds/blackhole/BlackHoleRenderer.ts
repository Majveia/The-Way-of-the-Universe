import * as THREE from 'three';
import { FullscreenQuad, FULLSCREEN_VERT } from '../../core/post/FullscreenQuad';
import {
  axisymmetricPoseKey,
  buildTetradInto,
  captureRadius,
  createTetrad,
  diskProfile,
  horizonRadius,
  iscoRadius,
  ksRadius,
  orbitingObserverInto,
  photonOrbitRadius,
  rainObserverInto,
  rayMomentum,
  staticObserverInto,
  traceRay,
  zamoObserverInto,
  type RayResult,
  type Tetrad,
  type Vec3,
  type Vec4,
} from './kerr';
import {
  PLANCK_T_MAX,
  PLANCK_T_MIN,
  createColorTemperatureTexture,
  createPlanckTexture,
  planckLuminance,
  populationColor,
} from './spectrum';
import { ACCUM_FRAG, COMPOSITE_FRAG, DISK_NOISE_FRAG, DISK_TEXTURE_FRAG, METER_FRAG, traceFrag } from './shaders';

export type ObserverKind = 'static' | 'zamo' | 'orbiting' | 'rain';
export type BlackHoleQuality = 'low' | 'medium' | 'high' | 'ultra';

/** Everything that shapes the picture. Units: gravitational radii (r_g = GM/c²), kelvin, M for time. */
export interface BlackHoleParams {
  /** Dimensionless spin a/M in [0, 0.998]. */
  spin: number;
  /** Inner disk edge in r_g; ≤ 0 means the ISCO (Novikov–Thorne zero-torque edge). */
  diskInner: number;
  diskOuter: number;
  /** Disk scale height H/r. */
  thickness: number;
  /** Peak effective temperature of the Page–Thorne profile (K) — i.e. the accretion rate. */
  peakTemperature: number;
  /** HDR radiance of a surface at the peak temperature (auto-exposure for the disk). */
  diskBrightness: number;
  /** Vertical optical depth of the inner disk. */
  opacity: number;
  /** Turbulence contrast 0..1. */
  turbulence: number;
  disk: boolean;
  doppler: boolean;
  gravitationalRedshift: boolean;
  lensing: boolean;
  /** Lensed overlay of the ISCO circle. */
  showIsco: boolean;
  /** Lensed overlay of the circular photon orbits (prograde and retrograde). */
  showPhotonOrbits: boolean;
  /** Orbiting hot spot strength (0 = off), orbit radius in r_g. */
  hotSpot: number;
  hotSpotRadius: number;
  /** Background: cube-map gain, point-star gain. */
  envGain: number;
  starGain: number;
  stars: boolean;
  /** Who is holding the camera (ignored while a custom 4-velocity is set). */
  observer: ObserverKind;
  /** Coordinate time in M (drives the disk's rotation). */
  time: number;
  seed: number;
  /** Rotation of the black-hole frame (spin along +Y) inside the world/sky frame. */
  orientation: THREE.Quaternion;
}

export const defaultBlackHoleParams = (): BlackHoleParams => ({
  spin: 0.9,
  diskInner: 0,
  diskOuter: 22,
  thickness: 0.018,
  peakTemperature: 9000,
  diskBrightness: 4,
  opacity: 4,
  turbulence: 0.8,
  disk: true,
  doppler: true,
  gravitationalRedshift: true,
  lensing: true,
  showIsco: false,
  showPhotonOrbits: false,
  hotSpot: 0,
  hotSpotRadius: 7,
  envGain: 0.08,
  starGain: 1,
  stars: true,
  observer: 'static',
  time: 0,
  seed: 7,
  orientation: new THREE.Quaternion(),
});

/** Parameters that only affect the final composite (no re-trace, no history reset). */
const COMPOSITE_ONLY = new Set<keyof BlackHoleParams>(['envGain', 'starGain', 'stars']);
/** Parameters that change the disk's light but not where any ray goes (the lens cache survives). */
const SHADING_ONLY = new Set<keyof BlackHoleParams>([
  'peakTemperature',
  'diskBrightness',
  'opacity',
  'turbulence',
  'doppler',
  'gravitationalRedshift',
  'hotSpot',
  'hotSpotRadius',
  'seed',
]);

export interface BlackHoleRendererOptions {
  quality?: BlackHoleQuality;
  /** Override the trace resolution relative to the output target. */
  traceScale?: number;
  /** Override the cap on traced pixels per frame. */
  tracePixels?: number;
}

interface QualitySettings {
  /** Trace resolution relative to the output target (upper bound). */
  traceScale: number;
  /**
   * Cap on traced pixels per frame, whatever the output size: the geodesic march costs ~15–20k
   * ALU operations per pixel, so the trace is sized to a GPU budget, not to the screen (a 2560 × 1600
   * DPR-2 laptop would otherwise trace 4× the pixels of 1080p).
   */
  tracePixels: number;
  maxSteps: number;
  /** Step length as a fraction of r (RK4). */
  eps: number;
  diskSamples: number;
  diskTex: [number, number];
  /** Turbulence octaves in the (baked) disk noise. */
  diskOct: number;
  /** Anisotropic filtering of the disk texture (grazing views). */
  aniso: number;
  /** Analytic star layers drawn in the composite (the faintest is dropped on low). */
  starLayers: number;
}

/**
 * Tiers, sized with a GPU cost model (ALU slots; ~1.25e12/s on a 2.5-TFLOPS laptop GPU):
 *  - trace: pixels × (RK4 steps × ~500 + disk samples × ~190). Measured at the default view
 *    (warp-max over 8 × 4 tiles): 37 / 29 / 23 steps and 3.7 / 4.0 / 4.1 samples per pixel for
 *    high / medium / low → ≈ 19k / 15k / 12k slots. While the camera only orbits the spin axis
 *    (the idle view) the lens cache traces ~30 % of those pixels again.
 *  - disk texture: texels × ~250 (the noise is baked once); composite: output pixels × ~900.
 * High at 1080p: trace 500k px ≈ 10 ms when everything moves, ≈ 3 ms idle; + ~2 ms composite.
 */
const QUALITY: Record<BlackHoleQuality, QualitySettings> = {
  low: { traceScale: 0.5, tracePixels: 150e3, maxSteps: 170, eps: 0.16, diskSamples: 8, diskTex: [1024, 256], diskOct: 3, aniso: 4, starLayers: 2 },
  medium: { traceScale: 0.6, tracePixels: 300e3, maxSteps: 220, eps: 0.13, diskSamples: 12, diskTex: [1536, 384], diskOct: 4, aniso: 8, starLayers: 3 },
  high: { traceScale: 0.72, tracePixels: 500e3, maxSteps: 280, eps: 0.1, diskSamples: 14, diskTex: [2048, 512], diskOct: 5, aniso: 16, starLayers: 3 },
  ultra: { traceScale: 1, tracePixels: 1.6e6, maxSteps: 400, eps: 0.08, diskSamples: 20, diskTex: [3072, 768], diskOct: 6, aniso: 16, starLayers: 3 },
};

/** Star layers: cells per cube-face edge and magnitude ranges (dN/dm ∝ 10^{0.35 m}). */
const STAR_LAYERS = [
  { n: 16, mLo: -1.2, mHi: 4.6 },
  { n: 48, mLo: 4.6, mHi: 7.2 },
  { n: 136, mLo: 7.2, mHi: 9.8 },
];

/** Kerr–Schild (spin +z) → three.js black-hole frame (spin +y): (x, y, z) → (x, z, −y). */
const KS_TO_BH = new THREE.Matrix3().set(1, 0, 0, 0, 0, 1, 0, -1, 0);

const METER_W = 16;
const METER_H = 9;

/** Length of the camera-invariant geometry key (see lensKey). */
const KEY_N = 26;

const halton = (i: number, b: number): number => {
  let f = 1, r = 0;
  while (i > 0) {
    f /= b;
    r += f * (i % b);
    i = Math.floor(i / b);
  }
  return r;
};

export interface CameraState {
  /** Kerr–Schild position. */
  pos: Vec3;
  /** Boyer–Lindquist radius. */
  r: number;
  u: Vec4;
  tetrad: Tetrad;
  inside: boolean;
}

/** Floating-point render-target support, probed once per renderer. */
interface FloatSupport {
  /** RGBA16F color attachments (EXT_color_buffer_half_float or EXT_color_buffer_float). */
  half: boolean;
  /** RGBA32F color attachments (EXT_color_buffer_float). */
  full: boolean;
}

function floatSupport(r: THREE.WebGLRenderer): FloatSupport {
  const e = r.extensions;
  const full = e.has('EXT_color_buffer_float');
  return { full, half: full || e.has('EXT_color_buffer_half_float') };
}

/** Is `rt` a complete framebuffer on this device? (Restores the bound target.) */
function isComplete(r: THREE.WebGLRenderer, rt: THREE.WebGLRenderTarget): boolean {
  const prev = r.getRenderTarget();
  r.setRenderTarget(rt);
  const gl = r.getContext();
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  r.setRenderTarget(prev);
  return ok;
}

/**
 * Real-time general-relativistic renderer of a Kerr black hole with a thin accretion disk,
 * lensed background and point stars. Draws a full-screen view into a linear-HDR target.
 *
 *   const bh = new BlackHoleRenderer(renderer, { quality: 'high' });
 *   bh.setEnvironment(cubeRenderTarget.texture);
 *   bh.setParams({ spin: 0.9, peakTemperature: 14000 });
 *   bh.render(hdrTarget, camera, camPosInRg);   // camera oriented in the black hole's frame
 *
 * The camera is carried by a physical observer (static by default; see `observer` and
 * `setObserverVelocity`), whose motion aberrates and Doppler-shifts everything it sees.
 *
 * Needs renderable half-float targets (EXT_color_buffer_half_float or EXT_color_buffer_float —
 * every current WebGL2 GPU); the constructor throws a readable error otherwise. 32-bit float
 * targets (EXT_color_buffer_float) sharpen the lensed star field and are used where available.
 * Nothing samples a 32-bit float texture with linear filtering (OES_texture_float_linear) and
 * nothing blends into a float target (EXT_float_blend).
 */
export class BlackHoleRenderer {
  readonly params: BlackHoleParams = defaultBlackHoleParams();
  readonly quality: QualitySettings;
  private renderer: THREE.WebGLRenderer;
  private float: FloatSupport;
  private quad = new FullscreenQuad();
  /** MRT: [0] disk light + transmittance, [1] lens map (camera-frame deflection, g). */
  private traceRT: THREE.WebGLRenderTarget | null = null;
  /** Disk light of frames that reuse the cached lens map. */
  private lightRT: THREE.WebGLRenderTarget | null = null;
  private accum: THREE.WebGLRenderTarget[] = [];
  private accumIndex = 0;
  private diskRT: THREE.WebGLRenderTarget;
  private noiseRT: THREE.WebGLRenderTarget;
  private profileTex: THREE.DataTexture;
  private planckTex: THREE.DataTexture;
  private ctTex: THREE.DataTexture;
  private ctRange: { qMin: number; qMax: number };
  private noiseMat: THREE.ShaderMaterial;
  private diskMat: THREE.ShaderMaterial;
  private traceMat: THREE.ShaderMaterial;
  private accumMat: THREE.ShaderMaterial;
  private compMat: THREE.ShaderMaterial;
  private meterMat: THREE.ShaderMaterial;
  private meterRT = new THREE.WebGLRenderTarget(METER_W, METER_H, { type: THREE.UnsignedByteType, depthBuffer: false });
  private meterBuf = new Uint8Array(METER_W * METER_H * 4);
  private meterBusy = false;
  private meterSorted = new Float64Array(METER_W * METER_H);
  private readonly onMeter = (): void => {
    const n = METER_W * METER_H;
    for (let i = 0; i < n; i++) this.meterSorted[i] = this.meterBuf[i * 4];
    this.meterSorted.sort();
    const code = this.meterSorted[Math.floor(n * 0.95)];
    this.highlightLuminance = Math.pow(2, (code / 255) * 24 - 16);
    this.meterBusy = false;
  };
  private readonly onMeterFail = (): void => {
    this.meterBusy = false;
  };
  /**
   * Scene brightness from the last metering: the 95th-percentile linear luminance of the disk
   * light (a camera exposing for its highlights). 0 until the first measurement arrives.
   */
  highlightLuminance = 0;
  private env: THREE.Texture | null = null;
  private customU: Vec4 | null = null;
  private frame = 0;
  private historyValid = false;
  private dirty = true;
  private profileKey = '';
  private noiseKey = '';
  private framesSinceBake = 0;
  private diskNormKey = -1;
  private diskNorm = 1;
  private lastFwd = new THREE.Vector3();
  private lastPos = new THREE.Vector3();
  private traceScale: number;
  private tracePixels: number;
  /** Increments whenever a parameter other than `time` changes (lets callers detect a new image). */
  version = 0;
  /** Bumps when anything that bends or clips rays changes (invalidates the lens cache). */
  private geomVersion = 0;
  /** Camera state of the most recent frame (for picking and readouts). */
  camera: CameraState | null = null;
  /** Lens cache: key of the frame whose lens map is in traceRT, and its jitter. */
  private cacheKey = new Float64Array(KEY_N);
  private curKey = new Float64Array(KEY_N);
  private cacheValid = false;
  private cacheJitter = new THREE.Vector2();
  /** Frames traced with the cache (diagnostics / benchmarks). */
  cachedFrames = 0;
  /** Set false to always trace every pixel (debug / A–B comparison). */
  lensCache = true;
  private tanX = 1;
  private tanY = 1;
  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpV = new THREE.Vector3();
  private readonly camToSky = new THREE.Matrix3();
  private readonly toSky = new THREE.Matrix3();
  private readonly ksToCam = new THREE.Matrix3();
  private readonly bhRot = new THREE.Matrix3();
  private readonly tmpM = new THREE.Matrix4();
  private readonly tmpQ2 = new THREE.Quaternion();
  private readonly tmpV2 = new THREE.Vector3();
  private readonly jitter = new THREE.Vector2();
  // Per-frame scratch (no allocations in render()).
  private readonly camState: CameraState = { pos: [0, 0, 0], r: 0, u: [1, 0, 0, 0], tetrad: createTetrad(), inside: false };
  private readonly kRight: Vec3 = [0, 0, 0];
  private readonly kUp: Vec3 = [0, 0, 0];
  private readonly kBack: Vec3 = [0, 0, 0];
  private readonly uObs: Vec4 = [1, 0, 0, 0];
  private readonly kAxes: [Vec3, Vec3, Vec3] = [this.kRight, this.kUp, this.kBack];

  constructor(renderer: THREE.WebGLRenderer, opts: BlackHoleRendererOptions = {}) {
    this.renderer = renderer;
    this.float = floatSupport(renderer);
    if (!this.float.half)
      throw new Error('This device cannot render to floating-point targets (WebGL2 EXT_color_buffer_half_float), which the black-hole ray tracer needs.');
    this.quality = { ...QUALITY[opts.quality ?? 'high'] };
    this.traceScale = opts.traceScale ?? this.quality.traceScale;
    this.tracePixels = opts.tracePixels ?? this.quality.tracePixels;
    this.planckTex = createPlanckTexture();
    const ct = createColorTemperatureTexture();
    this.ctTex = ct.texture;
    this.ctRange = { qMin: ct.qMin, qMax: ct.qMax };
    this.profileTex = new THREE.DataTexture(new Uint16Array(256 * 4), 256, 1, THREE.RGBAFormat, THREE.HalfFloatType);
    this.profileTex.minFilter = this.profileTex.magFilter = THREE.LinearFilter;
    this.profileTex.wrapS = this.profileTex.wrapT = THREE.ClampToEdgeWrapping;

    const [dw, dh] = this.quality.diskTex;
    this.diskRT = new THREE.WebGLRenderTarget(dw, dh, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      generateMipmaps: true,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.diskRT.texture.anisotropy = Math.min(this.quality.aniso, renderer.capabilities.getMaxAnisotropy());
    this.noiseRT = new THREE.WebGLRenderTarget(dw, dh, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      generateMipmaps: false,
      depthBuffer: false,
      stencilBuffer: false,
    });
    if (!isComplete(renderer, this.diskRT) || !isComplete(renderer, this.noiseRT))
      throw new Error('This device cannot render to half-float textures, which the black-hole ray tracer needs.');

    const common = { vertexShader: FULLSCREEN_VERT, glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false };
    this.noiseMat = new THREE.ShaderMaterial({
      ...common,
      fragmentShader: `#define DISK_OCT ${this.quality.diskOct}\n${DISK_NOISE_FRAG}`,
      uniforms: { uLnR0: { value: 0 }, uLnSpan: { value: 1 }, uSeed: { value: 7 } },
    });
    this.diskMat = new THREE.ShaderMaterial({
      ...common,
      fragmentShader: DISK_TEXTURE_FRAG,
      uniforms: {
        uA: { value: 0.9 },
        uTime: { value: 0 },
        uLnR0: { value: 0 },
        uLnSpan: { value: 1 },
        uRin: { value: 2 },
        uRout: { value: 20 },
        uTau0: { value: 40 },
        uTurb: { value: 0.7 },
        uSeed: { value: 7 },
        uProfile: { value: this.profileTex },
        uNoise: { value: this.noiseRT.texture },
        uHot: { value: new THREE.Vector4() },
      },
    });
    this.traceMat = new THREE.ShaderMaterial({
      ...common,
      fragmentShader: traceFrag(this.quality.maxSteps, this.quality.diskSamples),
      uniforms: {
        uA: { value: 0.9 },
        uLensing: { value: 1 },
        uRes: { value: new THREE.Vector2(1, 1) },
        uJitter: { value: new THREE.Vector2() },
        uTan: { value: new THREE.Vector2(1, 1) },
        uCamPos: { value: new THREE.Vector3() },
        uE0: { value: new THREE.Vector4() },
        uE1: { value: new THREE.Vector4() },
        uE2: { value: new THREE.Vector4() },
        uE3: { value: new THREE.Vector4() },
        uCapR: { value: 2.5 },
        uHorizon: { value: 2 },
        uInside: { value: 0 },
        uEscR: { value: 60 },
        uEps: { value: this.quality.eps },
        uKsToCam: { value: new THREE.Matrix3() },
        uFrame: { value: 0 },
        uCached: { value: 0 },
        uSkyCache: { value: null },
        uDiskOn: { value: 1 },
        uDisk: { value: this.diskRT.texture },
        uDiskMap: { value: new THREE.Vector2(0, 1) },
        uDiskR: { value: new THREE.Vector2(2, 20) },
        uH: { value: 0.02 },
        uTpeak: { value: 14000 },
        uDiskNorm: { value: 1 },
        uShift: { value: 3 },
        uDiskTexel: { value: new THREE.Vector2(dw, dh) },
        uPixAngle: { value: 0.001 },
        uPlanck: { value: this.planckTex },
        uPlanckMap: { value: new THREE.Vector2(Math.log(PLANCK_T_MIN), 1 / Math.log(PLANCK_T_MAX / PLANCK_T_MIN)) },
        uRings: { value: new THREE.Vector4() },
        uRingColA: { value: new THREE.Vector3(1.0, 0.62, 0.3).multiplyScalar(0.9) },
        uRingColB: { value: new THREE.Vector3(0.45, 0.62, 1.0).multiplyScalar(0.9) },
        uDebug: { value: 0 },
      },
    });
    this.accumMat = new THREE.ShaderMaterial({
      ...common,
      fragmentShader: ACCUM_FRAG,
      uniforms: { uCurrent: { value: null }, uHistory: { value: null }, uAlpha: { value: 1 } },
    });
    this.meterMat = new THREE.ShaderMaterial({
      ...common,
      fragmentShader: METER_FRAG,
      uniforms: { uAccum: { value: null }, uCells: { value: new THREE.Vector2(METER_W, METER_H) } },
    });
    // Star-layer statistics for the unresolved limit.
    const k = 0.35 * Math.LN10;
    const means = STAR_LAYERS.map((l) => {
      // E[10^{-0.4 m}] for p(m) ∝ e^{k m} on [mLo, mHi]
      let num = 0, den = 0;
      for (let i = 0; i <= 200; i++) {
        const m = l.mLo + ((l.mHi - l.mLo) * i) / 200;
        const w = Math.exp(k * m);
        num += w * Math.pow(10, -0.4 * m);
        den += w;
      }
      return num / den;
    });
    const avg = populationColor([3400, 4500, 5700, 6900, 9000, 15000], [0.1, 0.26, 0.22, 0.2, 0.15, 0.07]);
    this.compMat = new THREE.ShaderMaterial({
      ...common,
      fragmentShader: `#define STAR_LAYERS ${this.quality.starLayers}\n${COMPOSITE_FRAG}`,
      uniforms: {
        uAccum: { value: null },
        uSky: { value: null },
        uEnv: { value: null },
        uEnvOn: { value: 0 },
        uTraceRes: { value: new THREE.Vector2(1, 1) },
        uJitter: { value: new THREE.Vector2() },
        uTan: { value: new THREE.Vector2(1, 1) },
        uCamToSky: { value: new THREE.Matrix3() },
        uScale: { value: 1 },
        uEnvGain: { value: 1 },
        uStarGain: { value: 1 },
        uStarsOn: { value: 1 },
        uSigmaPix: { value: 0.62 },
        uSigmaSrc: { value: 1.2e-4 },
        uLayerN: { value: new THREE.Vector3(...STAR_LAYERS.map((l) => l.n)) },
        uLayerMean: { value: new THREE.Vector3(...means) },
        uMagLo: { value: new THREE.Vector4(...STAR_LAYERS.map((l) => l.mLo), 0) },
        uMagHi: { value: new THREE.Vector4(...STAR_LAYERS.map((l) => l.mHi), 0) },
        uAvgStarColor: { value: new THREE.Vector3(...avg) },
        uPlanck: { value: this.planckTex },
        uPlanckMap: { value: new THREE.Vector2(Math.log(PLANCK_T_MIN), 1 / Math.log(PLANCK_T_MAX / PLANCK_T_MIN)) },
        uCT: { value: this.ctTex },
        uCTMap: { value: new THREE.Vector2(this.ctRange.qMin, 1 / (this.ctRange.qMax - this.ctRange.qMin)) },
        uSkyShift: { value: 1 },
        uDbg: { value: 0 },
        uUpsample: { value: 1 },
      },
    });
  }

  /** Background seen through the lens: a cube map (e.g. the project's Sky rendered by a CubeCamera). */
  setEnvironment(tex: THREE.Texture | null): void {
    this.env = tex;
    this.version++;
    this.historyValid = false;
  }

  /** Merge parameters. Anything that changes the traced image invalidates the temporal history. */
  setParams(p: Partial<BlackHoleParams>): void {
    let changed = false;
    let traced = false;
    let geometry = false;
    for (const key in p) {
      const k = key as keyof BlackHoleParams;
      const v = p[k];
      if (v === undefined) continue;
      if (k === 'orientation') {
        if (!this.params.orientation.equals(v as THREE.Quaternion)) {
          this.params.orientation.copy(v as THREE.Quaternion);
          changed = traced = geometry = true;
        }
      } else if (this.params[k] !== v) {
        (this.params as unknown as Record<string, unknown>)[k] = v;
        if (k !== 'time') {
          changed = true;
          if (!COMPOSITE_ONLY.has(k)) traced = true;
          if (!COMPOSITE_ONLY.has(k) && !SHADING_ONLY.has(k)) geometry = true;
        }
      }
    }
    if (changed) this.version++;
    if (traced) this.dirty = true;
    if (geometry) this.geomVersion++;
  }

  /** Advance the disk's clock (coordinate time, M) without any bookkeeping — call every frame. */
  setTime(t: number): void {
    this.params.time = t;
  }

  /** Carry the camera with an arbitrary 4-velocity (Kerr–Schild contravariant), e.g. a plunge. */
  setObserverVelocity(u: Vec4 | null): void {
    this.customU = u;
  }

  /** Debug visualisation in the trace pass (0 off, 1 T/T_peak, 2 g/2, 3 LOD/10, 4 τ/100, 15 cost). */
  set debugMode(m: number) {
    this.traceMat.uniforms.uDebug.value = m;
    this.historyValid = false;
    this.cacheValid = false;
  }

  /** Drop the temporal history and the lens cache (call after a cut). */
  resetHistory(): void {
    this.version++;
    this.historyValid = false;
    this.cacheValid = false;
  }

  /** Effective inner disk radius. */
  get innerRadius(): number {
    const p = this.params;
    return p.diskInner > 0 ? p.diskInner : iscoRadius(p.spin);
  }

  /** Trace-target size for an output of w × h: traceScale × output, capped at tracePixels. */
  traceSize(w: number, h: number): [number, number] {
    const s = Math.min(this.traceScale, Math.sqrt(this.tracePixels / Math.max(1, w * h)));
    return [Math.max(2, Math.round(w * s)), Math.max(2, Math.round(h * s))];
  }

  private ensureTargets(w: number, h: number): void {
    const [tw, th] = this.traceSize(w, h);
    if (this.traceRT && this.traceRT.width === tw && this.traceRT.height === th) return;
    this.traceRT?.dispose();
    this.lightRT?.dispose();
    for (const a of this.accum) a.dispose();
    const opts = {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    } as const;
    // 32-bit floats where renderable: the lens map's finite differences give the lens Jacobian —
    // half-float rounding (~1e-4 at Δ ≈ 0.1) is comparable to a pixel's angle and would smear the
    // analytically lensed stars into streaks. Both attachments are read with texelFetch or at texel
    // centres (nearest), so float32 needs no OES_texture_float_linear.
    const make = (type: THREE.TextureDataType) => {
      const rt = new THREE.WebGLRenderTarget(tw, th, { ...opts, type, count: 2 });
      for (const t of rt.textures) t.minFilter = t.magFilter = THREE.NearestFilter;
      return rt;
    };
    let rt = this.float.full ? make(THREE.FloatType) : null;
    if (rt && !isComplete(this.renderer, rt)) {
      // Some tile-based GPUs refuse 2 × RGBA32F attachments (bits per pixel) despite the extension.
      rt.dispose();
      rt = null;
    }
    rt ??= make(THREE.HalfFloatType);
    if (!isComplete(this.renderer, rt)) {
      rt.dispose();
      throw new Error('This GPU cannot render the black hole’s two half-float targets at once (multiple render targets).');
    }
    this.traceRT = rt;
    this.lightRT = new THREE.WebGLRenderTarget(tw, th, { ...opts, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.accum = [new THREE.WebGLRenderTarget(tw, th, opts), new THREE.WebGLRenderTarget(tw, th, opts)];
    this.historyValid = false;
    this.cacheValid = false;
  }

  private updateProfile(): void {
    const p = this.params;
    const rIn = this.innerRadius;
    const key = `${p.spin}|${rIn}|${p.diskOuter}`;
    if (key === this.profileKey) return;
    this.profileKey = key;
    const r0 = rIn * 0.97;
    const prof = diskProfile(p.spin, r0, p.diskOuter, 256);
    const data = this.profileTex.image.data as Uint16Array;
    for (let i = 0; i < 256; i++) {
      const t = prof.temperature[i];
      data[i * 4] = THREE.DataUtils.toHalfFloat(t);
      data[i * 4 + 1] = data[i * 4 + 2] = 0;
      data[i * 4 + 3] = THREE.DataUtils.toHalfFloat(1);
    }
    this.profileTex.needsUpdate = true;
    const lnR0 = Math.log(r0);
    const span = Math.log(p.diskOuter / r0);
    const du = this.diskMat.uniforms;
    du.uLnR0.value = lnR0;
    du.uLnSpan.value = span;
    (this.traceMat.uniforms.uDiskMap.value as THREE.Vector2).set(lnR0, 1 / span);
  }

  /**
   * Bake the disk's turbulence noise on its (φ, ln r) grid — only when that grid or the seed changes,
   * and at most every few frames while a slider sweeps the disk's edges or the spin (a bake is
   * ~4 ms on a mid laptop at 2048 × 512; a few frames of slightly stretched noise are invisible).
   */
  private updateNoise(): void {
    const du = this.diskMat.uniforms;
    const key = `${du.uLnR0.value}|${du.uLnSpan.value}|${this.params.seed}`;
    this.framesSinceBake++;
    if (key === this.noiseKey || (this.noiseKey !== '' && this.framesSinceBake < 10)) return;
    this.noiseKey = key;
    this.framesSinceBake = 0;
    const nu = this.noiseMat.uniforms;
    nu.uLnR0.value = du.uLnR0.value;
    nu.uLnSpan.value = du.uLnSpan.value;
    nu.uSeed.value = this.params.seed;
    this.quad.material = this.noiseMat;
    this.quad.render(this.renderer, this.noiseRT);
  }

  /** Observer 4-velocity at a Kerr–Schild position, into `out` (falls back where it cannot exist). */
  private observerVelocityInto(pos: Vec3, out: Vec4): Vec4 {
    if (this.customU) {
      for (let i = 0; i < 4; i++) out[i] = this.customU[i];
      return out;
    }
    const a = this.params.spin;
    const x = pos[0], y = pos[1], z = pos[2];
    let ok = false;
    switch (this.params.observer) {
      case 'static':
        ok = staticObserverInto(a, x, y, z, out);
        break;
      case 'orbiting':
        ok = orbitingObserverInto(a, x, y, z, out);
        break;
      case 'rain':
        rainObserverInto(a, x, y, z, out);
        ok = true;
        break;
      default:
        ok = false;
    }
    if (!ok && !zamoObserverInto(a, x, y, z, out)) rainObserverInto(a, x, y, z, out);
    return out;
  }

  /** Observer 4-velocity at a Kerr–Schild position (falls back gracefully where it cannot exist). */
  observerVelocity(pos: Vec3): Vec4 {
    return this.observerVelocityInto(pos, [0, 0, 0, 0]);
  }

  /** A camera axis (unit vector along x, y, z of the camera) in Kerr–Schild components. */
  private axisToKS(out: Vec3, q: THREE.Quaternion, x: number, y: number, z: number): void {
    const v = this.tmpV.set(x, y, z).applyQuaternion(q);
    out[0] = v.x;
    out[1] = -v.z;
    out[2] = v.y;
  }

  /**
   * Geometry key of this frame, invariant under rotations about the spin axis: the camera's
   * cylindrical radius and height, its axes in the local (ϖ̂, φ̂, ẑ) frame, the lens and trace
   * settings, and the geometry parameters. Equal keys ⇒ identical rays in the camera frame.
   */
  private lensKey(pos: Vec3, tw: number, th: number, escR: number): Float64Array {
    const k = this.curKey;
    axisymmetricPoseKey(pos, this.kRight, this.kUp, this.kBack, k);
    k[11] = tw;
    k[12] = th;
    k[13] = this.tanX;
    k[14] = this.tanY;
    k[15] = escR;
    k[16] = this.geomVersion;
    k[17] = this.customU ? NaN : 0; // a custom (plunge) velocity is never cached
    k[18] = this.params.showIsco || this.params.showPhotonOrbits ? NaN : 0;
    k[19] = Math.hypot(pos[0], pos[1]) > 1e-6 ? 0 : NaN; // on the axis the local frame is undefined
    k[20] = this.traceMat.uniforms.uDebug.value;
    for (let i = 21; i < KEY_N; i++) k[i] = 0;
    return k;
  }

  /**
   * Same geometry as the cached frame? Poses may differ by 2e-5 (relative position, axis
   * components): rays then move by ≲ 1/50 of a trace pixel, and a camera easing into place (rig
   * damping, look-around smoothing) reuses the cache instead of re-tracing for seconds.
   */
  private keyMatches(): boolean {
    const a = this.cacheKey, b = this.curKey;
    const scale = Math.max(1, Math.abs(b[0]), Math.abs(b[1]));
    for (let i = 0; i < KEY_N; i++) {
      // 0–1 position, 2–10 axes, 11–12 trace size (exact), 13–15 field of view and escape radius
      // (relative), 16+ flags and versions (exact).
      const tol = i < 2 ? 2e-5 * scale : i < 11 ? 2e-5 : i === 11 || i === 12 || i > 15 ? 0 : 2e-5 * Math.abs(b[i]);
      if (!(Math.abs(a[i] - b[i]) <= tol)) return false;
    }
    return true;
  }

  /**
   * Draw the black hole as seen by `camera` into `target` (linear HDR radiance, full screen).
   * `camPosInRg`: camera position in gravitational radii in the black hole's frame (spin +Y).
   * The camera's world orientation is interpreted in the same frame (after `params.orientation`).
   */
  render(target: THREE.WebGLRenderTarget, camera: THREE.PerspectiveCamera, camPosInRg: THREE.Vector3, reuse = false): void {
    const r = this.renderer;
    const p = this.params;
    this.ensureTargets(target.width, target.height);
    const tr = this.traceRT!;
    // `reuse`: composite last frame's trace again (cheap) — used to throttle CPU-emulated WebGL.
    if (reuse && this.historyValid && this.camera) {
      this.composite(target);
      return;
    }
    this.updateProfile();
    this.updateNoise();
    this.frame++;

    // ——— camera → Kerr–Schild frame (spin +z): (x, y, z)_BH → (x, −z, y)
    this.bhRot.setFromMatrix4(this.tmpM.makeRotationFromQuaternion(p.orientation));
    const invOrient = this.tmpQ.copy(p.orientation).invert();
    const qCam = this.tmpQ2.copy(invOrient).multiply(camera.quaternion);
    const cs = this.camState;
    const pos = cs.pos;
    pos[0] = camPosInRg.x;
    pos[1] = -camPosInRg.z;
    pos[2] = camPosInRg.y;
    this.axisToKS(this.kRight, qCam, 1, 0, 0);
    this.axisToKS(this.kUp, qCam, 0, 1, 0);
    this.axisToKS(this.kBack, qCam, 0, 0, 1);
    const a = p.spin;
    const rCam = ksRadius(a, pos[0], pos[1], pos[2]);
    const rh = horizonRadius(a);
    const lensing = p.lensing;
    const tet = cs.tetrad;
    if (lensing) {
      this.observerVelocityInto(pos, this.uObs);
      buildTetradInto(a, pos, this.uObs, this.kRight, this.kUp, this.kBack, tet);
      for (let i = 0; i < 4; i++) cs.u[i] = this.uObs[i];
    } else {
      // Flat space: a static observer with the coordinate axes.
      cs.u[0] = 1;
      cs.u[1] = cs.u[2] = cs.u[3] = 0;
      const axes = this.kAxes;
      for (let k = 0; k < 4; k++) {
        const e = tet.e[k], E = tet.E[k];
        if (k === 0) {
          e[0] = 1;
          e[1] = e[2] = e[3] = 0;
          E[0] = -1;
          E[1] = E[2] = E[3] = 0;
        } else {
          const v = axes[k - 1];
          e[0] = E[0] = 0;
          for (let i = 0; i < 3; i++) e[i + 1] = E[i + 1] = v[i];
        }
      }
    }
    cs.r = rCam;
    cs.inside = rCam < rh;
    this.camera = cs;

    // ——— temporal accumulation weight from camera motion
    const fwd = this.tmpV2.set(0, 0, -1).applyQuaternion(camera.quaternion);
    this.tanY = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    this.tanX = this.tanY * camera.aspect;
    const pixAngle = (2 * this.tanY) / tr.height;
    const turn = fwd.angleTo(this.lastFwd);
    const moved = camPosInRg.distanceTo(this.lastPos) / Math.max(camPosInRg.length(), 1e-6);
    const motionPx = (turn + moved) / pixAngle;
    let alpha = THREE.MathUtils.clamp(0.22 + 0.35 * motionPx, 0.22, 1);
    if (!this.historyValid || this.dirty) alpha = 1;
    this.lastFwd.copy(fwd);
    this.lastPos.copy(camPosInRg);
    this.dirty = false;

    // ——— disk texture
    const rIn = this.innerRadius;
    if (p.disk) {
      const du = this.diskMat.uniforms;
      du.uA.value = a;
      du.uTime.value = p.time;
      du.uRin.value = rIn;
      du.uRout.value = p.diskOuter;
      du.uTau0.value = p.opacity;
      du.uTurb.value = p.turbulence;
      du.uSeed.value = p.seed;
      const hs = du.uHot.value as THREE.Vector4;
      if (p.hotSpot > 0) {
        const rs = Math.max(p.hotSpotRadius, rIn * 1.05);
        const om = 1 / (Math.pow(rs, 1.5) + a);
        hs.set(rs, (1.3 + om * p.time) % (Math.PI * 2), 0.45 + 0.04 * rs, p.hotSpot);
      } else hs.set(0, 0, 1, 0);
      this.quad.material = this.diskMat;
      this.quad.render(r, this.diskRT);
    }

    // ——— trace
    if (this.diskNormKey !== p.peakTemperature) {
      this.diskNormKey = p.peakTemperature;
      this.diskNorm = 1 / planckLuminance(p.peakTemperature);
    }
    const jx = halton((this.frame % 16) + 1, 2) - 0.5;
    const jy = halton((this.frame % 16) + 1, 3) - 0.5;
    this.toSky.copy(this.bhRot).multiply(KS_TO_BH);
    this.camToSky.setFromMatrix4(this.tmpM.makeRotationFromQuaternion(camera.quaternion));
    this.ksToCam.copy(this.camToSky).transpose().multiply(this.toSky);
    const escR = Math.max(rCam * 1.05, 60, p.diskOuter * 1.5);
    // Lens cache: identical geometry up to a turn about the spin axis (the idle orbit) → only the
    // rays that met the disk (or border the shadow) are traced again.
    this.lensKey(pos, tr.width, tr.height, escR);
    const cached = this.lensCache && this.cacheValid && this.historyValid && this.keyMatches();
    const t = this.traceMat.uniforms;
    t.uA.value = a;
    t.uLensing.value = lensing ? 1 : 0;
    (t.uRes.value as THREE.Vector2).set(tr.width, tr.height);
    (t.uJitter.value as THREE.Vector2).set(jx, jy);
    (t.uTan.value as THREE.Vector2).set(this.tanX, this.tanY);
    (t.uCamPos.value as THREE.Vector3).set(pos[0], pos[1], pos[2]);
    const E = tet.E;
    (t.uE0.value as THREE.Vector4).set(E[0][1], E[0][2], E[0][3], E[0][0]);
    (t.uE1.value as THREE.Vector4).set(E[1][1], E[1][2], E[1][3], E[1][0]);
    (t.uE2.value as THREE.Vector4).set(E[2][1], E[2][2], E[2][3], E[2][0]);
    (t.uE3.value as THREE.Vector4).set(E[3][1], E[3][2], E[3][3], E[3][0]);
    t.uCapR.value = lensing ? captureRadius(a) : rh;
    t.uHorizon.value = rh;
    t.uInside.value = rCam < rh && lensing ? 1 : 0;
    t.uEscR.value = escR;
    t.uEps.value = this.quality.eps;
    (t.uKsToCam.value as THREE.Matrix3).copy(this.ksToCam);
    t.uFrame.value = this.frame % 64;
    t.uCached.value = cached ? 1 : 0;
    t.uSkyCache.value = cached ? tr.textures[1] : null;
    t.uDiskOn.value = p.disk ? 1 : 0;
    (t.uDiskR.value as THREE.Vector2).set(rIn, p.diskOuter);
    t.uH.value = p.thickness;
    t.uTpeak.value = p.peakTemperature;
    t.uDiskNorm.value = this.diskNorm * p.diskBrightness;
    t.uShift.value = (p.doppler ? 1 : 0) + (p.gravitationalRedshift ? 2 : 0);
    t.uPixAngle.value = pixAngle;
    (t.uRings.value as THREE.Vector4).set(
      p.showIsco ? iscoRadius(a) : 0,
      p.showPhotonOrbits ? photonOrbitRadius(a, true) : 0,
      p.showPhotonOrbits && a > 0.01 ? photonOrbitRadius(a, false) : 0,
      0,
    );
    this.quad.material = this.traceMat;
    if (cached) {
      // Disk light only (the lens map stays the cached one, and so does its jitter).
      this.quad.render(r, this.lightRT!);
      this.cachedFrames++;
    } else {
      this.quad.render(r, tr);
      this.cacheKey.set(this.curKey);
      this.cacheValid = true;
      this.cacheJitter.set(jx, jy);
    }

    // ——— accumulate
    const hist = this.accum[this.accumIndex];
    const next = this.accum[1 - this.accumIndex];
    const am = this.accumMat.uniforms;
    am.uCurrent.value = cached ? this.lightRT!.texture : tr.textures[0];
    am.uHistory.value = hist.texture;
    am.uAlpha.value = alpha;
    this.quad.material = this.accumMat;
    this.quad.render(r, next);
    this.accumIndex = 1 - this.accumIndex;
    this.historyValid = true;
    this.jitter.copy(this.cacheJitter);
    this.composite(target);
    if (!this.checkedPrograms) this.checkPrograms();
  }

  private checkedPrograms = false;
  /**
   * A shader the driver refuses to link draws nothing: the view would stay black with only a
   * console message. Turn that into an error the app shows (checked once, after the first frame).
   */
  private checkPrograms(): void {
    this.checkedPrograms = true;
    for (const m of [this.noiseMat, this.diskMat, this.traceMat, this.accumMat, this.compMat]) {
      const prog = (this.renderer.properties.get(m) as { currentProgram?: { diagnostics?: { runnable: boolean } } }).currentProgram;
      if (prog?.diagnostics && !prog.diagnostics.runnable)
        throw new Error('The black-hole ray tracer’s shaders failed to compile on this GPU (details in the console).');
    }
  }

  /**
   * Measure the image brightness for auto exposure (async GPU readback, no stall). Call every few
   * frames; the result lands in `highlightLuminance`.
   */
  meter(): void {
    if (this.meterBusy || !this.historyValid) return;
    const r = this.renderer;
    this.meterMat.uniforms.uAccum.value = this.accum[this.accumIndex].texture;
    this.quad.material = this.meterMat;
    this.quad.render(r, this.meterRT);
    this.meterBusy = true;
    r.readRenderTargetPixelsAsync(this.meterRT, 0, 0, METER_W, METER_H, this.meterBuf).then(this.onMeter, this.onMeterFail);
  }

  /** Final pass: upsampled disk light over the lensed sky, into the HDR target. */
  private composite(target: THREE.WebGLRenderTarget): void {
    const p = this.params;
    const tr = this.traceRT!;
    const c = this.compMat.uniforms;
    c.uAccum.value = this.accum[this.accumIndex].texture;
    c.uSky.value = tr.textures[1];
    c.uEnv.value = this.env;
    c.uEnvOn.value = this.env ? 1 : 0;
    (c.uTraceRes.value as THREE.Vector2).set(tr.width, tr.height);
    (c.uJitter.value as THREE.Vector2).copy(this.jitter);
    (c.uTan.value as THREE.Vector2).set(this.tanX, this.tanY);
    (c.uCamToSky.value as THREE.Matrix3).copy(this.camToSky);
    c.uScale.value = tr.width / target.width;
    c.uEnvGain.value = p.envGain;
    // Point-star peak radiance is F/(2πσ²θ_pix²): scaling the gain with the pixel solid angle keeps
    // a star's on-screen brightness independent of resolution (a 0-mag star peaks at ≈ 8).
    const outPix = (2 * this.tanY) / target.height;
    c.uStarGain.value = p.starGain * 20 * outPix * outPix;
    c.uStarsOn.value = p.stars ? 1 : 0;
    c.uSkyShift.value = p.gravitationalRedshift || p.doppler ? 1 : 0;
    this.quad.material = this.compMat;
    this.quad.render(this.renderer, target);
  }

  /** Debug: read the latest accumulated trace value (rgb, transmittance) at normalised coords. */
  debugSample(u: number, v: number): number[] {
    const t = this.accum[this.accumIndex];
    if (!t) return [];
    const buf = new Uint16Array(4);
    this.renderer.readRenderTargetPixels(t, Math.floor(u * (t.width - 1)), Math.floor(v * (t.height - 1)), 1, 1, buf);
    return Array.from(buf, (h) => +THREE.DataUtils.fromHalfFloat(h).toPrecision(4));
  }

  private syncBuf = new Uint16Array(4);
  /** Block until the GPU has finished this frame (headless/CPU WebGL only: stops frames piling up). */
  syncGPU(): void {
    const t = this.accum[this.accumIndex];
    if (t) this.renderer.readRenderTargetPixels(t, 0, 0, 1, 1, this.syncBuf);
  }

  /**
   * Trace the ray through a screen point on the CPU (float64) with the last frame's camera.
   * ndc in [−1, 1]² (y up). Returns null before the first frame.
   */
  pick(ndcX: number, ndcY: number): (RayResult & { direction: Vec3 }) | null {
    const cam = this.camera;
    if (!cam) return null;
    const d: Vec3 = [ndcX * this.tanX, ndcY * this.tanY, -1];
    const n = Math.hypot(d[0], d[1], d[2]);
    const dir: Vec3 = [d[0] / n, d[1] / n, d[2] / n];
    if (!this.params.lensing) return null;
    return traceRay(this.params.spin, cam.pos, rayMomentum(cam.tetrad, dir), { eps: 0.03 });
  }

  dispose(): void {
    this.traceRT?.dispose();
    this.lightRT?.dispose();
    for (const a of this.accum) a.dispose();
    this.diskRT.dispose();
    this.noiseRT.dispose();
    this.profileTex.dispose();
    this.planckTex.dispose();
    this.ctTex.dispose();
    this.noiseMat.dispose();
    this.diskMat.dispose();
    this.traceMat.dispose();
    this.accumMat.dispose();
    this.compMat.dispose();
    this.meterMat.dispose();
    this.meterRT.dispose();
  }
}
