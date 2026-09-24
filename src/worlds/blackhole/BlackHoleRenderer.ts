import * as THREE from 'three';
import { FullscreenQuad, FULLSCREEN_VERT } from '../../core/post/FullscreenQuad';
import {
  buildTetrad,
  captureRadius,
  diskProfile,
  horizonRadius,
  iscoRadius,
  ksRadius,
  orbitingObserver,
  photonOrbitRadius,
  rainObserver,
  rayMomentum,
  staticObserver,
  traceRay,
  zamoObserver,
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
import { ACCUM_FRAG, COMPOSITE_FRAG, DISK_TEXTURE_FRAG, METER_FRAG, traceFrag } from './shaders';

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

export interface BlackHoleRendererOptions {
  quality?: BlackHoleQuality;
  /** Override the trace resolution relative to the output target. */
  traceScale?: number;
}

interface QualitySettings {
  traceScale: number;
  maxSteps: number;
  eps: number;
  diskSamples: number;
  diskTex: [number, number];
  /** Turbulence octaves in the disk texture. */
  diskOct: number;
}

const QUALITY: Record<BlackHoleQuality, QualitySettings> = {
  low: { traceScale: 0.5, maxSteps: 150, eps: 0.14, diskSamples: 8, diskTex: [1024, 256], diskOct: 3 },
  medium: { traceScale: 0.6, maxSteps: 220, eps: 0.11, diskSamples: 12, diskTex: [1536, 384], diskOct: 4 },
  high: { traceScale: 0.72, maxSteps: 300, eps: 0.09, diskSamples: 16, diskTex: [2048, 512], diskOct: 5 },
  ultra: { traceScale: 1, maxSteps: 420, eps: 0.07, diskSamples: 24, diskTex: [3072, 768], diskOct: 6 },
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
 */
export class BlackHoleRenderer {
  readonly params: BlackHoleParams = defaultBlackHoleParams();
  readonly quality: QualitySettings;
  private renderer: THREE.WebGLRenderer;
  private quad = new FullscreenQuad();
  private traceRT: THREE.WebGLRenderTarget | null = null;
  private accum: THREE.WebGLRenderTarget[] = [];
  private accumIndex = 0;
  private diskRT: THREE.WebGLRenderTarget;
  private profileTex: THREE.DataTexture;
  private planckTex: THREE.DataTexture;
  private ctTex: THREE.DataTexture;
  private ctRange: { qMin: number; qMax: number };
  private diskMat: THREE.ShaderMaterial;
  private traceMat: THREE.ShaderMaterial;
  private accumMat: THREE.ShaderMaterial;
  private compMat: THREE.ShaderMaterial;
  private meterMat: THREE.ShaderMaterial;
  private meterRT = new THREE.WebGLRenderTarget(METER_W, METER_H, { type: THREE.UnsignedByteType, depthBuffer: false });
  private meterBuf = new Uint8Array(METER_W * METER_H * 4);
  private meterBusy = false;
  private meterSorted = new Float64Array(METER_W * METER_H);
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
  private diskNormKey = -1;
  private diskNorm = 1;
  private lastFwd = new THREE.Vector3();
  private lastPos = new THREE.Vector3();
  private traceScale: number;
  /** Increments whenever a parameter other than `time` changes (lets callers detect a new image). */
  version = 0;
  /** Camera state of the most recent frame (for picking and readouts). */
  camera: CameraState | null = null;
  private tanX = 1;
  private tanY = 1;
  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpV = new THREE.Vector3();
  private readonly camToSky = new THREE.Matrix3();
  private readonly toSky = new THREE.Matrix3();
  private readonly bhRot = new THREE.Matrix3();
  private readonly tmpM = new THREE.Matrix4();
  private readonly tmpQ2 = new THREE.Quaternion();
  private readonly tmpV2 = new THREE.Vector3();
  private readonly jitter = new THREE.Vector2();

  constructor(renderer: THREE.WebGLRenderer, opts: BlackHoleRendererOptions = {}) {
    this.renderer = renderer;
    this.quality = { ...QUALITY[opts.quality ?? 'high'] };
    this.traceScale = opts.traceScale ?? this.quality.traceScale;
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
    this.diskRT.texture.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());

    const common = { vertexShader: FULLSCREEN_VERT, glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false };
    this.diskMat = new THREE.ShaderMaterial({
      ...common,
      fragmentShader: `#define DISK_OCT ${this.quality.diskOct}\n${DISK_TEXTURE_FRAG}`,
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
        uToSky: { value: new THREE.Matrix3() },
        uCamToSky: { value: new THREE.Matrix3() },
        uFrame: { value: 0 },
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
      fragmentShader: COMPOSITE_FRAG,
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
      },
    });
  }

  /** Background seen through the lens: a cube map (e.g. the project's Sky rendered by a CubeCamera). */
  setEnvironment(tex: THREE.Texture | null): void {
    this.env = tex;
    this.version++;
    this.historyValid = false;
  }

  /** Merge parameters. Anything that changes the image invalidates the temporal history. */
  setParams(p: Partial<BlackHoleParams>): void {
    let changed = false;
    for (const key of Object.keys(p) as Array<keyof BlackHoleParams>) {
      const v = p[key];
      if (v === undefined) continue;
      if (key === 'orientation') {
        this.params.orientation.copy(v as THREE.Quaternion);
        changed = true;
      } else if (this.params[key] !== v) {
        (this.params as unknown as Record<string, unknown>)[key] = v;
        if (key !== 'time') changed = true;
      }
    }
    if (changed) {
      this.dirty = true;
      this.version++;
    }
  }

  /** Carry the camera with an arbitrary 4-velocity (Kerr–Schild contravariant), e.g. a plunge. */
  setObserverVelocity(u: Vec4 | null): void {
    this.customU = u;
  }

  /** Debug visualisation in the trace pass (0 off, 1 T/T_peak, 2 g/2, 3 LOD/10, 4 τ/100). */
  set debugMode(m: number) {
    this.traceMat.uniforms.uDebug.value = m;
    this.historyValid = false;
  }

  /** Drop the temporal history (call after a cut). */
  resetHistory(): void {
    this.version++;
    this.historyValid = false;
  }

  /** Effective inner disk radius. */
  get innerRadius(): number {
    const p = this.params;
    return p.diskInner > 0 ? p.diskInner : iscoRadius(p.spin);
  }

  private ensureTargets(w: number, h: number): void {
    const tw = Math.max(2, Math.round(w * this.traceScale));
    const th = Math.max(2, Math.round(h * this.traceScale));
    if (this.traceRT && this.traceRT.width === tw && this.traceRT.height === th) return;
    this.traceRT?.dispose();
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
    // 32-bit floats where renderable: the sky target stores the deflection Δ, whose finite
    // differences give the lens Jacobian — half-float rounding (~1e-4 at Δ ≈ 0.1) is comparable to a
    // pixel's angle and would smear the analytically lensed stars into streaks.
    const full = this.renderer.extensions.has('EXT_color_buffer_float');
    this.traceRT = new THREE.WebGLRenderTarget(tw, th, { ...opts, type: full ? THREE.FloatType : THREE.HalfFloatType, count: 2 });
    // Both are read at texel centres (accumulation) or with texelFetch (composite): nearest
    // filtering keeps float32 targets valid without OES_texture_float_linear.
    for (const t of this.traceRT.textures) t.minFilter = t.magFilter = THREE.NearestFilter;
    this.accum = [new THREE.WebGLRenderTarget(tw, th, opts), new THREE.WebGLRenderTarget(tw, th, opts)];
    this.historyValid = false;
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

  /** Observer 4-velocity at a Kerr–Schild position (falls back gracefully where it cannot exist). */
  observerVelocity(pos: Vec3): Vec4 {
    if (this.customU) return this.customU;
    const a = this.params.spin;
    const [x, y, z] = pos;
    let u: Vec4 | null = null;
    switch (this.params.observer) {
      case 'static':
        u = staticObserver(a, x, y, z);
        break;
      case 'orbiting':
        u = orbitingObserver(a, x, y, z);
        break;
      case 'rain':
        u = rainObserver(a, x, y, z);
        break;
      default:
        u = null;
    }
    return u ?? zamoObserver(a, x, y, z) ?? rainObserver(a, x, y, z);
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
    this.frame++;

    // ——— camera → Kerr–Schild frame
    this.bhRot.setFromMatrix4(this.tmpM.makeRotationFromQuaternion(p.orientation));
    const invOrient = this.tmpQ.copy(p.orientation).invert();
    const qCam = this.tmpQ2.copy(invOrient).multiply(camera.quaternion);
    const toKS = (v: THREE.Vector3): Vec3 => [v.x, -v.z, v.y];
    const pos = toKS(camPosInRg);
    const right = toKS(this.tmpV.set(1, 0, 0).applyQuaternion(qCam));
    const up = toKS(this.tmpV.set(0, 1, 0).applyQuaternion(qCam));
    const back = toKS(this.tmpV.set(0, 0, 1).applyQuaternion(qCam));
    const a = p.spin;
    const rCam = ksRadius(a, pos[0], pos[1], pos[2]);
    const rh = horizonRadius(a);
    const lensing = p.lensing;
    let u: Vec4;
    let tetrad: Tetrad;
    if (lensing) {
      u = this.observerVelocity(pos);
      tetrad = buildTetrad(a, pos, u, right, up, back);
    } else {
      // Flat space: a static observer with the coordinate axes.
      u = [1, 0, 0, 0];
      tetrad = {
        e: [u, [0, ...right], [0, ...up], [0, ...back]] as Tetrad['e'],
        E: [[-1, 0, 0, 0], [0, ...right], [0, ...up], [0, ...back]] as Tetrad['E'],
      };
    }
    this.camera = { pos, r: rCam, u, tetrad, inside: rCam < rh };

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
    const t = this.traceMat.uniforms;
    t.uA.value = a;
    t.uLensing.value = lensing ? 1 : 0;
    (t.uRes.value as THREE.Vector2).set(tr.width, tr.height);
    (t.uJitter.value as THREE.Vector2).set(jx, jy);
    (t.uTan.value as THREE.Vector2).set(this.tanX, this.tanY);
    (t.uCamPos.value as THREE.Vector3).set(pos[0], pos[1], pos[2]);
    const E = tetrad.E;
    (t.uE0.value as THREE.Vector4).set(E[0][1], E[0][2], E[0][3], E[0][0]);
    (t.uE1.value as THREE.Vector4).set(E[1][1], E[1][2], E[1][3], E[1][0]);
    (t.uE2.value as THREE.Vector4).set(E[2][1], E[2][2], E[2][3], E[2][0]);
    (t.uE3.value as THREE.Vector4).set(E[3][1], E[3][2], E[3][3], E[3][0]);
    t.uCapR.value = lensing ? captureRadius(a) : rh;
    t.uHorizon.value = rh;
    t.uInside.value = rCam < rh && lensing ? 1 : 0;
    t.uEscR.value = Math.max(rCam * 1.05, 60, p.diskOuter * 1.5);
    t.uEps.value = this.quality.eps;
    (t.uToSky.value as THREE.Matrix3).copy(this.toSky);
    (t.uCamToSky.value as THREE.Matrix3).copy(this.camToSky);
    t.uFrame.value = this.frame % 64;
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
    this.quad.render(r, tr);

    // ——— accumulate
    const hist = this.accum[this.accumIndex];
    const next = this.accum[1 - this.accumIndex];
    const am = this.accumMat.uniforms;
    am.uCurrent.value = tr.textures[0];
    am.uHistory.value = hist.texture;
    am.uAlpha.value = alpha;
    this.quad.material = this.accumMat;
    this.quad.render(r, next);
    this.accumIndex = 1 - this.accumIndex;
    this.historyValid = true;
    this.jitter.set(jx, jy);
    this.composite(target);
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
    r.readRenderTargetPixelsAsync(this.meterRT, 0, 0, METER_W, METER_H, this.meterBuf)
      .then(() => {
        const n = METER_W * METER_H;
        for (let i = 0; i < n; i++) this.meterSorted[i] = this.meterBuf[i * 4];
        this.meterSorted.sort();
        const code = this.meterSorted[Math.floor(n * 0.95)];
        this.highlightLuminance = Math.pow(2, (code / 255) * 24 - 16);
      })
      .catch(() => undefined)
      .finally(() => {
        this.meterBusy = false;
      });
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
  /** Block until the GPU has finished this frame (headless/CPU WebGL: stops frames piling up). */
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
    for (const a of this.accum) a.dispose();
    this.diskRT.dispose();
    this.profileTex.dispose();
    this.planckTex.dispose();
    this.ctTex.dispose();
    this.diskMat.dispose();
    this.traceMat.dispose();
    this.accumMat.dispose();
    this.compMat.dispose();
    this.meterMat.dispose();
    this.meterRT.dispose();
  }
}
