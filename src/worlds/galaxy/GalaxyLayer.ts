import * as THREE from 'three';
import { FullscreenQuad, FULLSCREEN_VERT } from '../../core/post/FullscreenQuad';
import { blackbodyRGB } from '../../physics/blackbody';
import { extinctionRGB, hiiLines, hiiRGB, lineEfficacy, oiiiRGB, visualEfficacyFit as visEff } from '../../physics/galaxyStars';
import { LINES } from '../../physics/spectrum';
import { pcMyrFromKms, radMyrFromKmsKpc } from '../../physics/galaxyPotential';
import { generateParticles, Kinematics, PARTICLE_LIGHT, defaultLive, type GalaxyLive, type GalaxyParticles } from './model';
import { MAX_ARMS, type GalaxyParams } from './params';
import { MAP_FRAG } from './shaders/maps';
import { NOISE3D_FRAG } from './shaders/noise3d';
import { STAR_FRAG, STAR_VERT } from './shaders/stars';
import { HII_FRAG, HII_VERT } from './shaders/hii';
import { VOLUME_COMPOSITE_FRAG, VOLUME_FRAG } from './shaders/volume';
import { GalaxyIntegrator } from './integrator';
import { LOCAL_STAR_VERT } from './shaders/localStars';
import {
  densityParams,
  LOCAL_CELLS,
  LOCAL_MAX_PER_CELL,
  LOCAL_TIERS,
  mwReference,
  nearestLocalStars,
  type DensityParams,
} from './localStars';
import { milkyWay } from './params';
import { KIND_YOUNG, particleState, STRIDE, type ParticleState } from './model';

/** Options for a galaxy layer. */
export interface GalaxyLayerOptions {
  params: GalaxyParams;
  /** Quality detail multiplier (Engine QualityProfile.detail, 0.35–1.6). */
  detail?: number;
  /** Override the particle count (default 700 000 × detail). */
  particles?: number;
  /** Render the unresolved light / dust / gas volume (default true). */
  volume?: boolean;
  /** Generate particles in a Web Worker (default true; falls back to the main thread). */
  worker?: boolean;
}

export interface GalaxyRenderOptions {
  /** Render-frame origin (pc) the camera is placed relative to (camera-relative rendering). */
  origin?: THREE.Vector3;
  /** Target pixels per CSS pixel (unused for sizes: sprites are sized in target pixels). */
  pixelRatio?: number;
  /** Exposure the post chain will apply (used for culling faint stars). */
  exposure?: number;
  /** Frame counter for jitter. */
  frame?: number;
}

type U = { value: unknown };
const v4 = () => new THREE.Vector4();

/**
 * Renders a GalaxyModel in parsecs (render frame, y-up): the star particles (orbits evaluated on
 * the GPU), and a low-resolution volume of unresolved starlight, ionised gas and dust composited
 * underneath. Everything is linear HDR radiance in L☉ pc⁻² sr⁻¹ (× radianceScale).
 */
export class GalaxyLayer {
  params: GalaxyParams;
  kin: Kinematics;
  live: GalaxyLive;
  /** Simulation time, Myr. */
  time = 0;
  /** Overall brightness (multiplies stars and volume). */
  radianceScale = 1;
  /** Brightness multipliers per population class (old, young) for look tuning. */
  readonly popGain = new THREE.Vector2(1, 1);
  /** Volume gain (fades when the volume cannot follow the stars, e.g. dark matter removed). */
  volumeGain = 1;
  starsVisible = true;
  /** Brightness multiplier of the old (non-young) star particles (look / debugging). */
  oldGain = 1;
  volumeVisible = true;
  /** Debug: draw the face-on ISM map (0 = off, 1..4 = channel R/G/B/A, 5 = RGB). */
  debugMap = 0;
  /** Debug: volume shader mode (0 = normal). */
  set debugVolume(m: number) {
    this.volMat.uniforms.uDebug.value = m;
  }
  /** Debug: volume component mask (1 disk, 2 thick, 4 bulge, 8 bar, 16 young, 32 HII, 64 scattering, 128 dust). */
  set debugMask(m: number) {
    this.volMat.uniforms.uMask.value = m;
  }
  particles: GalaxyParticles | null = null;
  /**
   * Metered radiance of the diffuse light: `lum` log-mean over lit pixels (what the eye looks at),
   * `sky` plain log-mean of the whole view, `lit` fraction of the view above the floor; NaN
   * until the first readback. Volume units. See METER_FRAG.
   */
  readonly meter = { lum: NaN, lit: 0, sky: NaN };
  private meterRT: THREE.WebGLRenderTarget | null = null;
  private meterMat: THREE.ShaderMaterial | null = null;
  private meterBuf = new Float32Array(16 * 9 * 4);
  private meterPending = false;
  private meterFrame = 0;
  /** Time (Myr) at which the dark halo was removed (NaN while it is present). */
  darkOffTime = NaN;
  private integ: GalaxyIntegrator | null = null;
  /** Resolves when the first particle set is on the GPU. */
  ready: Promise<void>;

  private renderer: THREE.WebGLRenderer;
  private detail: number;
  private nParticles: number;
  private useVolume: boolean;
  private useWorker: boolean;
  private worker: Worker | null = null;
  private jobId = 0;
  private disposed = false;

  readonly shared: Record<string, U>;
  private lutTex: THREE.DataTexture;
  private mapRT: THREE.WebGLRenderTarget;
  private mapNormRT: THREE.WebGLRenderTarget;
  private noiseRT: THREE.WebGL3DRenderTarget;
  private mapMat: THREE.ShaderMaterial;
  private quad = new FullscreenQuad();

  private starGeom: THREE.BufferGeometry | null = null;
  private starMat: THREE.ShaderMaterial;
  private stars: THREE.Points | null = null;
  private hiiGeom: THREE.BufferGeometry | null = null;
  private hiiMat: THREE.ShaderMaterial;
  private hii: THREE.Points | null = null;
  /** HII-region brightness multiplier (look). */
  hiiGain = 1;
  private starScene = new THREE.Scene();
  private localScene = new THREE.Scene();
  private localTiers: Array<{ mat: THREE.ShaderMaterial; geom: THREE.BufferGeometry; pts: THREE.Points }> = [];
  private dens!: DensityParams;
  /** Is the local star field drawn this frame (camera inside or near the disk)? */
  localActive = false;
  /** Radius (pc) inside which the volume's light is replaced by the local star field. */
  nearCut = 200;

  private volRT: THREE.WebGLRenderTarget | null = null;
  /** Temporal accumulation of the jittered ray-march (history ping-pong). */
  private accRT: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] | null = null;
  private accIdx = 0;
  private accCount = 0;
  private accMat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: /* glsl */ `
      precision highp float;
      in vec2 vUv;
      out vec4 outColor;
      uniform sampler2D tCur;
      uniform sampler2D tHist;
      uniform float uAlpha;
      void main() { outColor = mix(texture(tHist, vUv), texture(tCur, vUv), uAlpha); }
    `,
    depthTest: false,
    depthWrite: false,
    uniforms: { tCur: { value: null }, tHist: { value: null }, uAlpha: { value: 1 } },
  });
  private readonly prevCam = new THREE.Matrix4();
  private prevFov = 0;
  private prevTime = NaN;
  /** Force the next frame to discard the volume history (e.g. after a jump). */
  resetHistory(): void {
    this.accCount = 0;
  }
  private volMat: THREE.ShaderMaterial;
  private compMat: THREE.ShaderMaterial;
  private volScale: number;
  private mapsDirty = true;
  private normsDirty = true;
  private youngInt = 1;
  private hiiInt = 1;
  private readonly tmpV = new THREE.Vector3();
  private readonly camModel = new THREE.Vector3();
  private readonly maxPointSize: number;

  constructor(renderer: THREE.WebGLRenderer, o: GalaxyLayerOptions) {
    this.renderer = renderer;
    this.params = o.params;
    this.detail = o.detail ?? 1;
    this.nParticles = Math.round(o.particles ?? 700_000 * this.detail);
    this.useVolume = o.volume ?? true;
    this.useWorker = o.worker ?? true;
    this.live = defaultLive(o.params);
    this.kin = new Kinematics(o.params, this.live);
    this.volScale = THREE.MathUtils.clamp(0.22 + 0.2 * this.detail, 0.3, 0.55);
    const gl = renderer.getContext();
    const range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array | number[] | null;
    this.maxPointSize = range ? Math.min(64, Number(range[1]) || 64) : 64;

    this.lutTex = new THREE.DataTexture(this.kin.lut, this.kin.lutN, 2, THREE.RGBAFormat, THREE.FloatType);
    this.lutTex.minFilter = this.lutTex.magFilter = THREE.NearestFilter;
    this.lutTex.needsUpdate = true;

    const arms = () => Array.from({ length: MAX_ARMS }, v4);
    this.shared = {
      uLUT: { value: this.lutTex },
      uLutRmax: { value: this.kin.lutRmax },
      uLutN: { value: this.kin.lutN },
      uTime: { value: 0 },
      uSpin: { value: 1 },
      uOmegaP: { value: 0 },
      uOmegaB: { value: 0 },
      uBarAngle0: { value: 0 },
      uBarStrength: { value: 0 },
      uWaveM: { value: 0 },
      uWaveCot: { value: 1 },
      uWavePhase: { value: 0 },
      uWaveR0: { value: 1 },
      uWaveAmp: { value: 0 },
      uWaveRange: { value: new THREE.Vector2() },
      uWarp: { value: new THREE.Vector3() },
      uArmCount: { value: 0 },
      uArmA: { value: arms() },
      uArmB: { value: arms() },
      uYoungArmFrac: { value: 0.8 },
      uYoungScaleH: { value: 70 },
      uSfrActive: { value: 1 },
      uSfrBright: { value: 1 },
      // ISM
      uMap: { value: null },
      uMapGeom: { value: new THREE.Vector3() },
      uDustAmount: { value: 1 },
      uDustH: { value: 100 },
      uExtRGB: { value: new THREE.Vector3(...extinctionRGB()) },
      uBarLane: { value: new THREE.Vector4() },
      uRing: { value: new THREE.Vector3() },
      uBubble: { value: new THREE.Vector4() },
      uCloudCount: { value: 0 },
      uClouds: { value: Array.from({ length: 8 }, v4) },
      uCloudTau: { value: new Array(8).fill(0) },
    };

    // Maps (log-polar, pattern frame).
    const mapSize = this.detail >= 0.9 ? 1024 : 512;
    const rtOpts = {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    } as const;
    this.mapRT = new THREE.WebGLRenderTarget(mapSize, mapSize, { ...rtOpts, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.RepeatWrapping });
    this.mapNormRT = new THREE.WebGLRenderTarget(128, 128, { ...rtOpts, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.shared.uMap.value = this.mapRT.texture;
    this.mapMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: MAP_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        ...this.shared,
        uSeedOff: { value: new THREE.Vector2() },
        uYoungEnv: { value: new THREE.Vector3() },
        uDustP: { value: new THREE.Vector4() },
        uFloc: { value: 0 },
        uClump: { value: 0 },
        uArmFrac: { value: 0.8 },
        uTrunc: { value: 20000 },
        uDiskSigma: { value: new THREE.Vector2() },
      },
    });

    // 3D noise (tileable), generated once.
    const nsz = this.detail >= 0.9 ? 96 : 64;
    this.noiseRT = new THREE.WebGL3DRenderTarget(nsz, nsz, nsz, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.noiseRT.texture.wrapS = this.noiseRT.texture.wrapT = this.noiseRT.texture.wrapR = THREE.RepeatWrapping;
    this.generateNoise(nsz);

    this.starMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      uniforms: {
        ...this.shared,
        uCamModel: { value: new THREE.Vector3() },
        uOrigin: { value: new THREE.Vector3() },
        uFluxToRad: { value: 1 },
        uMinRad: { value: 1e-3 },
        uSizeRef: { value: 1 },
        uMaxSize: { value: 40 },
        uExtSamples: { value: this.detail >= 0.9 ? 6 : 4 },
        uMode: { value: 0 },
        uStatePos: { value: null },
        uStateW: { value: 1 },
        uSwitchTime: { value: 0 },
        uSaturation: { value: 0.9 },
        uYoungBoost: { value: 1 },
        uPopGain: { value: this.popGain },
        uPxPerRad: { value: 500 },
        uSmooth: { value: new THREE.Vector4(1, 1, 1, 1) },
        uSmoothBar: { value: 1 },
        uYoungMult: { value: 1 },
      },
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquation: THREE.AddEquation,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });

    const lineEffHII = lineEfficacy(hiiLines(0.25));
    const lineEffO3 = lineEfficacy([
      [LINES.OIII_5007, 3],
      [LINES.OIII_4959, 1],
    ]);
    this.hiiMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: HII_VERT,
      fragmentShader: HII_FRAG,
      uniforms: {
        ...this.shared,
        uCamModel: this.starMat.uniforms.uCamModel,
        uOrigin: this.starMat.uniforms.uOrigin,
        uFluxToRad: this.starMat.uniforms.uFluxToRad,
        uMinRad: this.starMat.uniforms.uMinRad,
        uMaxSize: { value: 64 },
        uPxPerRad: { value: 500 },
        uExtSamples: this.starMat.uniforms.uExtSamples,
        uDensity: { value: 12 }, // n_e of extended (giant) HII regions, cm⁻³
        uYoungMult: this.starMat.uniforms.uYoungMult,
        uGain: { value: 1 },
        uColHII: { value: new THREE.Vector3(...hiiRGB(0.25)).multiplyScalar(lineEffHII) },
        uColOIII: { value: new THREE.Vector3(...oiiiRGB()).multiplyScalar(lineEffO3) },
        uMode: this.starMat.uniforms.uMode,
        uStatePos: this.starMat.uniforms.uStatePos,
        uStateW: this.starMat.uniforms.uStateW,
        uSwitchTime: this.starMat.uniforms.uSwitchTime,
      },
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquation: THREE.AddEquation,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });

    // Local star field: one Points draw per luminosity tier (vertex-generated, no attributes used).
    for (let t = 0; t < LOCAL_TIERS.length; t++) {
      const N = LOCAL_CELLS[t];
      const per = LOCAL_MAX_PER_CELL[t];
      if (!N || !per) continue;
      const tier = LOCAL_TIERS[t];
      const count = N * N * N * per;
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count), 1));
      geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
      const mat = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: LOCAL_STAR_VERT,
        fragmentShader: STAR_FRAG,
        uniforms: {
          ...this.shared,
          uTier: { value: t },
          uCell: { value: tier.cell },
          uN: { value: N },
          uMaxPer: { value: per },
          uCamCell: { value: new THREE.Vector3() },
          uTierL: { value: new THREE.Vector4(tier.lLo, tier.lHi, tier.n0, tier.giants) },
          uRadius: { value: tier.radius },
          uBeta: { value: tier.beta },
          uSeed: { value: 1 },
          uThin: { value: new THREE.Vector3() },
          uThick: { value: new THREE.Vector3() },
          uBulge: { value: new THREE.Vector3() },
          uFlareP: { value: new THREE.Vector2() },
          uTrunc: { value: 1 },
          uRef: { value: 1 },
          uCamModel: this.starMat.uniforms.uCamModel,
          uOrigin: this.starMat.uniforms.uOrigin,
          uFluxToRad: this.starMat.uniforms.uFluxToRad,
          uMinRad: this.starMat.uniforms.uMinRad,
          uSizeRef: this.starMat.uniforms.uSizeRef,
          uMaxSize: this.starMat.uniforms.uMaxSize,
          uGain: { value: 1 },
          uSaturation: this.starMat.uniforms.uSaturation,
        },
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneFactor,
        blendEquation: THREE.AddEquation,
        depthTest: false,
        depthWrite: false,
        transparent: true,
      });
      const pts = new THREE.Points(geom, mat);
      pts.frustumCulled = false;
      this.localScene.add(pts);
      this.localTiers.push({ mat, geom, pts });
    }

    this.volMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: VOLUME_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        ...this.shared,
        uTanFov: { value: new THREE.Vector2(1, 1) },
        uCamWorld: { value: new THREE.Matrix4() },
        uCamModel: { value: new THREE.Vector3() },
        uBounds: { value: new THREE.Vector2() },
        uMaxSteps: { value: Math.round(90 + 150 * Math.min(1.2, this.detail)) },
        uStepK: { value: 0.3 },
        uStepRange: { value: new THREE.Vector2(6, 260) },
        uFrame: { value: 0 },
        uColDisk: { value: new THREE.Vector3() },
        uColThick: { value: new THREE.Vector3() },
        uColBulge: { value: new THREE.Vector3() },
        uColBar: { value: new THREE.Vector3() },
        uColYoung: { value: new THREE.Vector3() },
        uColHII: { value: new THREE.Vector3() },
        uColOIII: { value: new THREE.Vector3() },
        uColScatter: { value: new THREE.Vector3() },
        uDiskP: { value: new THREE.Vector4() },
        uThickP: { value: new THREE.Vector4() },
        uFlare: { value: new THREE.Vector2() },
        uBulgeP: { value: new THREE.Vector4() },
        uBarP: { value: new THREE.Vector4() },
        uNucP: { value: new THREE.Vector4() },
        uYoungP: { value: new THREE.Vector2() },
        uHIIP: { value: new THREE.Vector2() },
        uScatter: { value: 0 },
        uNoise: { value: this.noiseRT.texture },
        uNoiseTile: { value: 2400 },
        uGain: { value: 1 },
        uNearCut: { value: 0 },
        uDebug: { value: 0 },
        uMask: { value: 255 },
      },
    });
    this.compMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: VOLUME_COMPOSITE_FRAG,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.SrcAlphaFactor,
      blendEquation: THREE.AddEquation,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      uniforms: { tVol: { value: null }, uTexel: { value: new THREE.Vector2() } },
    });

    this.applyParams();
    this.ready = this.regenerate();
  }

  // ——— Parameters ——————————————————————————————————————————————————————————

  /** Replace the galaxy (new preset or seed): regenerates particles and maps. */
  setParams(p: GalaxyParams): Promise<void> {
    this.params = p;
    this.live = defaultLive(p);
    this.kin = new Kinematics(p, this.live);
    this.kin.potential.darkMatter = this.darkMatter;
    this.lutTex.image.data = this.kin.lut;
    this.lutTex.needsUpdate = true;
    this.shared.uLutRmax.value = this.kin.lutRmax;
    this.applyParams();
    this.ready = this.regenerate();
    return this.ready;
  }

  /** Change live controls (arms, pitch, bar, dust, star formation) — no regeneration needed. */
  setLive(l: Partial<GalaxyLive>): void {
    const next = { ...this.live, ...l };
    const structural = next.arms !== this.live.arms || next.pitchDeg !== this.live.pitchDeg;
    const barChanged = next.barStrength !== this.live.barStrength;
    this.live = next;
    this.kin.setLive(next);
    this.applyParams();
    if (structural || barChanged) {
      this.mapsDirty = true;
      this.normsDirty = true;
    }
  }

  /** Is the dark-matter halo present? */
  get darkMatter(): boolean {
    return Number.isNaN(this.darkOffTime);
  }

  /**
   * Remove (false) or restore (true) the dark halo. Removing it freezes every star's current
   * position and velocity and integrates them from then on in the baryonic potential alone
   * (GalaxyIntegrator). Restoring it returns the galaxy to its equilibrium orbits.
   */
  setDarkMatter(on: boolean): void {
    if (on === this.darkMatter) return;
    this.kin.potential.darkMatter = on;
    if (on) {
      this.darkOffTime = NaN;
      this.integ?.dispose();
      this.integ = null;
      this.updateDarkFade();
      return;
    }
    this.darkOffTime = this.time;
    this.startIntegrator();
  }

  private startIntegrator(): void {
    this.integ?.dispose();
    this.integ = null;
    if (!this.particles) return;
    this.shared.uTime.value = this.time;
    this.integ = new GalaxyIntegrator(this.renderer, this.particles.data, this.particles.count, this.shared);
    this.integ.setPotential(this.params.potential, false);
    this.integ.init(this.time);
    this.updateDarkFade();
  }

  /** The Sun's position (model frame) at the current time: its guiding centre moves at Ω(R⊙). */
  sunModel(out: THREE.Vector3): THREE.Vector3 | null {
    const sun = this.params.sun;
    if (!sun) return null;
    const phi = sun.phi + this.kin.potential.omega(sun.R, true) * this.time;
    return out.set(sun.R * Math.cos(phi), sun.R * Math.sin(phi), sun.z);
  }

  /** Place the Local Bubble and nearby clouds around the Sun (they orbit with it). */
  private updateLocalISM(): void {
    const s = this.shared;
    const ism = this.params.localISM;
    const sun = this.sunModel(this.tmpV);
    if (!ism || !sun) {
      s.uCloudCount.value = 0;
      (s.uBubble.value as THREE.Vector4).set(0, 0, 0, 0);
      return;
    }
    (s.uBubble.value as THREE.Vector4).set(sun.x, sun.y, sun.z, ism.bubble);
    const phi = Math.atan2(sun.y, sun.x);
    const gx = -Math.cos(phi), gy = -Math.sin(phi); // toward the Galactic Centre (l = 0)
    const rx = -Math.sin(phi), ry = Math.cos(phi); // direction of rotation (l = 90°)
    const C = s.uClouds.value as THREE.Vector4[];
    const T = s.uCloudTau.value as number[];
    const n = Math.min(8, ism.clouds.length);
    for (let i = 0; i < n; i++) {
      const c = ism.clouds[i];
      const l = (c.l * Math.PI) / 180, b = (c.b * Math.PI) / 180;
      const cb = Math.cos(b);
      C[i].set(
        sun.x + c.d * cb * (Math.cos(l) * gx + Math.sin(l) * rx),
        sun.y + c.d * cb * (Math.cos(l) * gy + Math.sin(l) * ry),
        sun.z + c.d * Math.sin(b),
        c.r,
      );
      T[i] = c.tau * this.live.dust;
    }
    s.uCloudCount.value = n;
  }

  /**
   * Advance simulation time by dt Myr (negative runs backwards). With the halo present every
   * position is analytic in t; without it the GPU leapfrog integrates the same dt.
   */
  advance(dt: number): void {
    this.time += dt;
    if (!this.darkMatter && this.integ) {
      this.shared.uTime.value = this.time;
      this.integ.step(dt);
    }
    this.updateDarkFade();
  }

  /**
   * The diffuse volume (unresolved light, gas, dust) is a field in the equilibrium galaxy and cannot
   * follow the integrated stars, so it fades over ~60 Myr after the halo is removed and the star
   * particles take over its light (total luminosity is conserved).
   */
  private updateDarkFade(): void {
    const g = this.darkMatter ? 1 : Math.exp(-Math.abs(this.time - this.darkOffTime) / 60);
    this.volumeGain = g;
    this.popGain.x = this.oldGain / (0.14 + 0.86 * g);
    this.shared.uDustAmount.value = this.live.dust * g;
  }

  private applyParams(): void {
    const p = this.params;
    const k = this.kin;
    const s = this.shared;
    s.uSpin.value = p.spin;
    s.uOmegaP.value = radMyrFromKmsKpc(p.spiral.patternSpeed);
    s.uOmegaB.value = radMyrFromKmsKpc(p.bar.patternSpeed);
    s.uBarAngle0.value = p.bar.angle;
    s.uBarStrength.value = p.bar.lum > 0 ? p.bar.strength * this.live.barStrength : 0;
    const waveOn = p.spiral.amplitude > 0 && this.live.arms > 0;
    s.uWaveM.value = waveOn ? this.live.arms : 0;
    s.uWaveCot.value = 1 / Math.tan(Math.max(1, this.live.pitchDeg) * (Math.PI / 180));
    s.uWavePhase.value = p.spiral.phase;
    s.uWaveR0.value = p.spiral.r0;
    s.uWaveAmp.value = p.spiral.amplitude;
    (s.uWaveRange.value as THREE.Vector2).set(p.spiral.rInner, p.spiral.rOuter);
    (s.uWarp.value as THREE.Vector3).set(p.warp.amplitude, p.warp.rStart, p.warp.nodeAngle);
    const A = s.uArmA.value as THREE.Vector4[];
    const B = s.uArmB.value as THREE.Vector4[];
    const arms = k.arms;
    s.uArmCount.value = Math.min(MAX_ARMS, arms.length);
    for (let i = 0; i < MAX_ARMS; i++) {
      const a = arms[i];
      if (!a) {
        A[i].set(0, 0, 0, 0);
        B[i].set(0, 0, 0, 1);
        continue;
      }
      const pr = (a.pitchDeg * Math.PI) / 180;
      A[i].set(1 / Math.tan(pr), a.phase, Math.log(a.r0), a.strength);
      B[i].set(a.rStart, a.rEnd, a.width, Math.sin(pr));
    }
    s.uYoungArmFrac.value = p.young.armFraction;
    s.uYoungScaleH.value = p.young.scaleHeight;
    const sfr = p.young.sfr * this.live.sfr;
    s.uSfrActive.value = Math.min(1, sfr);
    s.uSfrBright.value = Math.max(1, sfr);

    // ISM
    const rMin = 100;
    (s.uMapGeom.value as THREE.Vector3).set(Math.log(rMin), 1 / Math.log(p.rMax / rMin), rMin);
    s.uDustH.value = p.gas.dustScaleHeight;
    const L = p.bar.halfLength;
    const hasBar = p.bar.lum > 0 && p.bar.strength > 0;
    (s.uBarLane.value as THREE.Vector4).set(L, 0.1 * L, 0.035 * L, hasBar ? 1.6 * p.gas.dustLane * Math.min(1, p.gas.dust) : 0);
    const ring = p.gas.nuclearRing;
    (s.uRing.value as THREE.Vector3).set(ring, ring * 0.22, ring > 0 ? 2.2 * p.gas.dust : 0);

    // Map-generation uniforms.
    const mu = this.mapMat.uniforms;
    const seed = p.seed * 1.618;
    (mu.uSeedOff.value as THREE.Vector2).set((seed * 12.9898) % 97, (seed * 78.233) % 89);
    (mu.uYoungEnv.value as THREE.Vector3).set(p.young.scaleLength, p.young.rInner, p.young.rOuter);
    (mu.uDustP.value as THREE.Vector4).set(p.gas.dust, p.gas.dustScaleLength, p.gas.dustHole, p.gas.dustLane);
    mu.uFloc.value = p.spiral.flocculence;
    mu.uClump.value = p.clumpiness;
    mu.uArmFrac.value = p.young.armFraction;
    mu.uTrunc.value = p.disk.lum > 0 ? p.disk.truncation * 1.1 : p.rMax;
    (mu.uDiskSigma.value as THREE.Vector2).set(pcMyrFromKms(p.disk.sigmaR), p.disk.scaleLength);

    // Volume emission.
    const vu = this.volMat.uniforms;
    const col = (T: number, target: THREE.Vector3) => {
      const [r, g, b] = blackbodyRGB(T);
      return target.set(r, g, b);
    };
    col(p.disk.colorT, vu.uColDisk.value as THREE.Vector3);
    col(p.disk.thickColorT, vu.uColThick.value as THREE.Vector3);
    col(p.bulge.colorT, vu.uColBulge.value as THREE.Vector3);
    col(p.bar.colorT, vu.uColBar.value as THREE.Vector3);
    col(p.young.colorT, vu.uColYoung.value as THREE.Vector3);
    (vu.uColHII.value as THREE.Vector3).set(...hiiRGB(0.25));
    (vu.uColOIII.value as THREE.Vector3).set(...oiiiRGB());
    const ext = extinctionRGB();
    const sc = (vu.uColYoung.value as THREE.Vector3).clone().multiply(new THREE.Vector3(...ext));
    sc.multiplyScalar(1 / (0.2126 * sc.x + 0.7152 * sc.y + 0.0722 * sc.z));
    (vu.uColScatter.value as THREE.Vector3).copy(sc);
    const fourPi = 4 * Math.PI;
    const d = p.disk;
    (vu.uDiskP.value as THREE.Vector4).set(
      (visEff(d.colorT) * d.lum * (1 - PARTICLE_LIGHT.disk)) / (2 * Math.PI * d.scaleLength ** 2) / fourPi,
      d.scaleLength,
      d.scaleHeight,
      d.truncation,
    );
    (vu.uThickP.value as THREE.Vector4).set(
      (visEff(d.thickColorT) * d.thickLum * (1 - PARTICLE_LIGHT.thick)) / (2 * Math.PI * d.thickScaleLength ** 2) / fourPi,
      d.thickScaleLength,
      d.thickScaleHeight,
      d.truncation,
    );
    (vu.uFlare.value as THREE.Vector2).set(d.flare, 2.5 * d.scaleLength);
    const b = p.bulge;
    (vu.uBulgeP.value as THREE.Vector4).set((visEff(b.colorT) * b.lum * (1 - PARTICLE_LIGHT.bulge) * b.a) / (2 * Math.PI) / fourPi, b.a, b.flatten, b.a * b.rMaxFactor);
    const [coreI, longI] = barIntegrals(p.bar.halfLength, p.bar.axisRatio, s.uBarStrength.value as number);
    const barVol = visEff(p.bar.colorT) * p.bar.lum * (1 - PARTICLE_LIGHT.bar);
    (vu.uBarP.value as THREE.Vector4).set(hasBar ? (0.5 * barVol) / coreI / fourPi : 0, hasBar ? (0.5 * barVol) / longI / fourPi : 0, L, p.bar.axisRatio);
    if (p.id === 'milkyway') {
      // Nuclear star cluster (Plummer, b ≈ 3.2 pc, ~2 × 10⁷ L☉) and nuclear stellar disk (~5 × 10⁸ L☉).
      const bn = 3.2;
      const Lnsc = 2e7 * visEff(p.bulge.colorT);
      const Lnsd = 5e8 * visEff(p.bulge.colorT);
      const rd = 90;
      (vu.uNucP.value as THREE.Vector4).set((3 * Lnsc) / (4 * Math.PI * bn ** 3) / fourPi, bn, Lnsd / (2 * Math.PI * rd * rd * 90) / fourPi, rd);
    } else (vu.uNucP.value as THREE.Vector4).set(0, 1, 0, 1);
    (vu.uBounds.value as THREE.Vector2).set(p.rMax, p.zMax);
    vu.uScatter.value = 0.5 * 60 * this.live.dust * 0;
    vu.uNoiseTile.value = p.rMax > 15000 ? 2600 : 1400;
    this.normsDirty = true;
    this.updateDarkFade();
    this.dens = densityParams(p, mwRef());
    for (const lt of this.localTiers) {
      const u = lt.mat.uniforms;
      (u.uThin.value as THREE.Vector3).set(...this.dens.thin);
      (u.uThick.value as THREE.Vector3).set(...this.dens.thick);
      (u.uBulge.value as THREE.Vector3).set(...this.dens.bulge);
      (u.uFlareP.value as THREE.Vector2).set(...this.dens.flare);
      u.uTrunc.value = this.dens.trunc;
      u.uRef.value = this.dens.ref;
      u.uSeed.value = p.seed >>> 0;
    }
  }

  private updateVolumeNorms(): void {
    const p = this.params;
    const vu = this.volMat.uniforms;
    const fourPi = 4 * Math.PI;
    const youngPart = this.particles?.populations.find((q) => q.name === 'young')?.lum ?? p.young.lum * PARTICLE_LIGHT.young;
    // Diffuse light of unresolved young stars: a mix of B/A stars (≈ colorT), visual efficacy applied.
    const youngVol = visEff(p.young.colorT) * Math.max(0, p.young.lum - youngPart) * Math.min(2, p.young.sfr * this.live.sfr);
    (vu.uYoungP.value as THREE.Vector2).set(this.youngInt > 0 ? youngVol / this.youngInt / fourPi : 0, Math.max(40, p.young.scaleHeight));
    // Diffuse ionised gas (the "warm ionised medium"): ≈ 40% of a galaxy's Hα (Haffner et al. 2009).
    // Total optical line light ≈ 3 L(Hα) ≈ 2% of the OB population's bolometric output (Kennicutt
    // 1998: L(Hα) = SFR / 7.9 × 10⁻⁴² erg s⁻¹); the HII-region sprites carry the rest.
    const hiiL = 0.4 * 0.02 * lineEfficacy(hiiLines(0.25)) * p.young.lum * p.gas.hii * Math.min(2, p.young.sfr * this.live.sfr);
    (vu.uHIIP.value as THREE.Vector2).set(this.hiiInt > 0 ? hiiL / this.hiiInt / fourPi : 0, 60);
  }

  // ——— Generation ————————————————————————————————————————————————————————————

  private generateNoise(n: number): void {
    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: NOISE3D_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: { uZ: { value: 0 }, uSeed: { value: 3.7 } },
    });
    const r = this.renderer;
    const prev = r.getRenderTarget();
    this.quad.material = mat;
    for (let z = 0; z < n; z++) {
      mat.uniforms.uZ.value = (z + 0.5) / n;
      r.setRenderTarget(this.noiseRT, z);
      r.render(this.quad.scene, this.quad.camera);
    }
    r.setRenderTarget(prev);
    mat.dispose();
  }

  private renderMaps(): void {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    this.quad.material = this.mapMat;
    this.quad.render(r, this.mapRT);
    if (this.normsDirty) {
      // Normalisation integrals from a small copy: ∫G dA and ∫A dA with dA = R² d(lnR) dφ.
      this.quad.render(r, this.mapNormRT);
      const w = this.mapNormRT.width;
      const h = this.mapNormRT.height;
      const buf = new Uint16Array(w * h * 4);
      r.readRenderTargetPixels(this.mapNormRT, 0, 0, w, h, buf);
      const geo = this.shared.uMapGeom.value as THREE.Vector3;
      const lnRange = 1 / geo.y;
      let gI = 0;
      let aI = 0;
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
          const u = (i + 0.5) / w;
          const R = Math.exp(geo.x + u * lnRange);
          const dA = R * R * (lnRange / w) * ((2 * Math.PI) / h);
          const o = (j * w + i) * 4;
          gI += THREE.DataUtils.fromHalfFloat(buf[o + 1]) * dA;
          aI += THREE.DataUtils.fromHalfFloat(buf[o + 3]) * dA;
        }
      }
      this.youngInt = gI;
      this.hiiInt = aI;
      this.normsDirty = false;
      this.updateVolumeNorms();
    }
    r.setRenderTarget(prev);
    this.mapsDirty = false;
  }

  private async regenerate(): Promise<void> {
    const job = ++this.jobId;
    this.mapsDirty = true;
    this.normsDirty = true;
    const g = await this.generate(this.params, this.nParticles);
    if (this.disposed || job !== this.jobId) return;
    this.upload(g);
    if (!this.darkMatter) {
      this.darkOffTime = this.time;
      this.startIntegrator();
    }
  }

  private generate(params: GalaxyParams, count: number): Promise<GalaxyParticles> {
    if (this.useWorker && typeof Worker !== 'undefined') {
      try {
        if (!this.worker) this.worker = new Worker(new URL('./generate.worker.ts', import.meta.url), { type: 'module' });
        const w = this.worker;
        const id = this.jobId;
        return new Promise((resolve) => {
          const onMsg = (e: MessageEvent) => {
            if (e.data?.id !== id) return;
            w.removeEventListener('message', onMsg);
            w.removeEventListener('error', onErr);
            if (e.data.ok) resolve(e.data.particles as GalaxyParticles);
            else resolve(generateParticles(params, count));
          };
          const onErr = () => {
            w.removeEventListener('message', onMsg);
            w.removeEventListener('error', onErr);
            this.useWorker = false;
            resolve(generateParticles(params, count));
          };
          w.addEventListener('message', onMsg);
          w.addEventListener('error', onErr);
          w.postMessage({ id, params, count });
        });
      } catch {
        this.useWorker = false;
      }
    }
    return Promise.resolve(generateParticles(params, count));
  }

  private upload(g: GalaxyParticles): void {
    this.particles = g;
    if (this.stars) {
      this.starScene.remove(this.stars);
      this.starGeom?.dispose();
    }
    const geom = new THREE.BufferGeometry();
    const ib = new THREE.InterleavedBuffer(g.data, 12);
    geom.setAttribute('a0', new THREE.InterleavedBufferAttribute(ib, 4, 0));
    geom.setAttribute('a1', new THREE.InterleavedBufferAttribute(ib, 4, 4));
    geom.setAttribute('a2', new THREE.InterleavedBufferAttribute(ib, 4, 8));
    geom.setDrawRange(0, g.count);
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    this.starGeom = geom;
    this.stars = new THREE.Points(geom, this.starMat);
    this.stars.frustumCulled = false;
    this.starScene.add(this.stars);
    if (this.hii) {
      this.starScene.remove(this.hii);
      this.hiiGeom?.dispose();
      this.hii = null;
    }
    this.starMat.uniforms.uYoungMult.value = g.youngMultiplicity;
    // Particle surface densities for the smoothing lengths (see shaders/stars.ts).
    const pd = this.params.disk;
    const nOf = (n: string) => g.populations.find((q) => q.name === n)?.count ?? 0;
    (this.starMat.uniforms.uSmooth.value as THREE.Vector4).set(
      nOf('disk') / (2 * Math.PI * pd.scaleLength ** 2),
      pd.scaleLength,
      nOf('thick') / (2 * Math.PI * pd.thickScaleLength ** 2),
      pd.thickScaleLength,
    );
    const bl = Math.max(1, this.params.bar.halfLength);
    this.starMat.uniforms.uSmoothBar.value = nOf('bar') / (Math.PI * bl * bl * this.params.bar.axisRatio);
    const young = g.populations.find((q) => q.name === 'young');
    if (young && young.count > 0) {
      const hg = new THREE.BufferGeometry();
      hg.setAttribute('a0', geom.getAttribute('a0'));
      hg.setAttribute('a1', geom.getAttribute('a1'));
      hg.setAttribute('a2', geom.getAttribute('a2'));
      hg.setDrawRange(young.start, young.count);
      hg.boundingSphere = geom.boundingSphere;
      this.hiiGeom = hg;
      this.hii = new THREE.Points(hg, this.hiiMat);
      this.hii.frustumCulled = false;
      this.hii.renderOrder = -1;
      this.starScene.add(this.hii);
    }
    this.updateVolumeNorms();
  }

  // ——— Rendering ———————————————————————————————————————————————————————————

  resize(width: number, height: number): void {
    const w = Math.max(1, Math.round(width * this.volScale));
    const h = Math.max(1, Math.round(height * this.volScale));
    if (this.volRT && this.volRT.width === w && this.volRT.height === h) return;
    this.volRT?.dispose();
    this.accRT?.[0].dispose();
    this.accRT?.[1].dispose();
    const mk = () =>
      new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
      });
    this.volRT = mk();
    this.accRT = [mk(), mk()];
    this.accCount = 0;
  }

  /**
   * History weight for this frame: 1 (reset) when the view moved by more than ~½ volume pixel
   * (rotation, or parallax of structure at the distance of the nearest emitting layer) or time
   * jumped; otherwise a running mean that settles at 1/10.
   */
  private historyAlpha(camera: THREE.PerspectiveCamera, cam: THREE.Vector3): number {
    const e = camera.matrixWorld.elements;
    const p = this.prevCam.elements;
    const pxPerRad = this.volRT!.height / (2 * Math.tan((camera.fov * Math.PI) / 360));
    // Rotation: change of the camera basis vectors (radians, small-angle).
    let rot = 0;
    for (const i of [0, 1, 2, 4, 5, 6, 8, 9, 10]) rot = Math.max(rot, Math.abs(e[i] - p[i]));
    const dPos = Math.hypot(e[12] - p[12], e[13] - p[13], e[14] - p[14]);
    const nearest = Math.max(40, Math.min(Math.hypot(cam.x, cam.y, cam.z) * 0.5, Math.abs(cam.z) + 60));
    const shift = (rot + dPos / nearest) * pxPerRad;
    const jumped = !(Math.abs(this.time - this.prevTime) < 3) || Math.abs(camera.fov - this.prevFov) > 0.05;
    this.prevCam.copy(camera.matrixWorld);
    this.prevFov = camera.fov;
    this.prevTime = this.time;
    if (shift > 0.5 || jumped || this.accCount === 0) {
      this.accCount = 1;
      return 1;
    }
    this.accCount++;
    return Math.max(1 / this.accCount, 0.1);
  }

  /** Camera position in the model frame (absolute pc). */
  cameraModel(camera: THREE.Camera, origin?: THREE.Vector3): THREE.Vector3 {
    this.tmpV.setFromMatrixPosition(camera.matrixWorld);
    if (origin) this.tmpV.add(origin);
    return this.kin.fromRender(this.tmpV.x, this.tmpV.y, this.tmpV.z, this.camModel) as THREE.Vector3;
  }

  /**
   * Draw into `target` (linear HDR): volume first (composited over what is already there),
   * then additive stars. The camera must have up-to-date matrices.
   */
  render(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, target: THREE.WebGLRenderTarget, o: GalaxyRenderOptions = {}): void {
    this.shared.uTime.value = this.time;
    this.updateLocalISM();
    if (this.mapsDirty) this.renderMaps();
    const cam = this.cameraModel(camera, o.origin);
    const H = target.height;
    const fov = (camera.fov * Math.PI) / 180;
    const pix = (2 * Math.tan(fov / 2)) / H;
    const omegaPx = pix * pix;
    const exposure = o.exposure ?? 1;

    if (this.debugMap > 0) {
      this.drawDebugMap(renderer, target);
      return;
    }
    // The local star field takes over the light of the nearest stars when the viewer is in (or near)
    // the stellar disk; the volume then leaves out emission within `nearCut` of the camera.
    const Rc = Math.hypot(cam.x, cam.y);
    this.localActive = this.starsVisible && this.darkMatter && Math.abs(cam.z) < 1500 && Rc < this.dens.trunc * 1.05;
    const cutFade = 1 - THREE.MathUtils.smoothstep(Math.abs(cam.z), 600, 1500);
    this.volMat.uniforms.uNearCut.value = this.localActive ? this.nearCut * cutFade : 0;
    if (this.useVolume && this.volumeVisible && this.volumeGain > 0.001) {
      if (!this.volRT) this.resize(target.width, target.height);
      const vu = this.volMat.uniforms;
      const th = Math.tan(fov / 2);
      (vu.uTanFov.value as THREE.Vector2).set(th * camera.aspect, th);
      (vu.uCamWorld.value as THREE.Matrix4).copy(camera.matrixWorld);
      (vu.uCamModel.value as THREE.Vector3).copy(cam);
      vu.uFrame.value = (o.frame ?? 0) % 64;
      vu.uGain.value = this.radianceScale * this.volumeGain;
      this.quad.material = this.volMat;
      this.quad.render(renderer, this.volRT!);
      // Temporal accumulation.
      const au = this.accMat.uniforms;
      const hist = this.accRT![this.accIdx];
      const dst = this.accRT![1 - this.accIdx];
      au.uAlpha.value = this.historyAlpha(camera, cam);
      au.tCur.value = this.volRT!.texture;
      au.tHist.value = hist.texture;
      this.quad.material = this.accMat;
      this.quad.render(renderer, dst);
      this.accIdx = 1 - this.accIdx;
      const cu = this.compMat.uniforms;
      cu.tVol.value = dst.texture;
      (cu.uTexel.value as THREE.Vector2).set(1 / this.volRT!.width, 1 / this.volRT!.height);
      this.quad.material = this.compMat;
      renderer.setRenderTarget(target);
      renderer.render(this.quad.scene, this.quad.camera);
      if (++this.meterFrame % 6 === 1) this.runMeter(renderer, target);
    }

    if (this.stars && this.starsVisible) {
      const su = this.starMat.uniforms;
      (su.uCamModel.value as THREE.Vector3).copy(cam);
      (su.uOrigin.value as THREE.Vector3).copy(o.origin ?? ZERO);
      su.uFluxToRad.value = this.radianceScale / (4 * Math.PI * omegaPx);
      su.uMinRad.value = 0.0012 / Math.max(exposure, 1e-6);
      su.uSizeRef.value = 3 / Math.max(exposure, 1e-6);
      su.uMaxSize.value = Math.min(this.maxPointSize, 44);
      if (this.integ && !this.darkMatter) {
        su.uMode.value = 1;
        su.uStatePos.value = this.integ.positions;
        su.uStateW.value = this.integ.width;
        su.uSwitchTime.value = this.darkOffTime;
      } else su.uMode.value = 0;
      const hu = this.hiiMat.uniforms;
      hu.uPxPerRad.value = su.uPxPerRad.value = H / (2 * Math.tan(fov / 2));
      hu.uMaxSize.value = Math.min(this.maxPointSize, 64);
      hu.uGain.value = this.hiiGain * this.params.gas.hii;
      renderer.setRenderTarget(target);
      renderer.render(this.starScene, camera);
      if (this.localActive) {
        for (const lt of this.localTiers) {
          const u = lt.mat.uniforms;
          const C = u.uCell.value as number;
          const R = u.uRadius.value as number;
          // Skip tiers whose stars are all out of reach (camera far above or outside the disk).
          lt.pts.visible = Math.abs(cam.z) < R + 2500 && Math.hypot(cam.x, cam.y) < this.dens.trunc * 1.1 + R;
          (u.uCamCell.value as THREE.Vector3).set(Math.floor(cam.x / C), Math.floor(cam.y / C), Math.floor(cam.z / C));
          u.uGain.value = this.radianceScale;
        }
        renderer.render(this.localScene, camera);
      }
    }
  }

  /**
   * The k stars nearest to `posPc` (render frame, pc) at the current time: procedural field stars of
   * every luminosity class (the same ones the local star field draws), the OB stars of the orbit
   * model, and the Sun (Milky Way). Sorted by distance. CPU; a few ms for k ≲ 100.
   */
  nearestStars(posPc: THREE.Vector3, k = 16): StarRecord[] {
    const m = this.kin.fromRender(posPc.x, posPc.y, posPc.z, { x: 0, y: 0, z: 0 });
    const field = nearestLocalStars(this.dens, this.params.seed >>> 0, m.x, m.y, m.z, k);
    const out: Array<StarRecord & { d: number }> = field.map((f) => {
      const v = new THREE.Vector3();
      this.kin.toRender(f.x, f.y, f.h, v);
      return { id: f.id, position: v, temperatureK: f.temperatureK, luminosity: f.luminosity, massSun: f.massSun, seed: f.seed, kind: 'field' as const, d: v.distanceTo(posPc) };
    });
    const reach = out.length ? out[out.length - 1].d : Infinity;
    const sun = this.sunModel(new THREE.Vector3());
    if (sun) {
      const v = this.kin.toRender(sun.x, sun.y, sun.z, new THREE.Vector3()) as THREE.Vector3;
      const d = v.distanceTo(posPc);
      if (d < reach || out.length < k) out.push({ id: 0, position: v, temperatureK: 5772, luminosity: 1, massSun: 1, seed: 0, kind: 'sun', name: 'Sun', d });
    }
    const g = this.particles;
    const young = g?.populations.find((q) => q.name === 'young');
    if (g && young && this.darkMatter) {
      const st: ParticleState = { x: 0, y: 0, z: 0, lum: 0, temperature: 0 };
      const km = Math.max(1, g.youngMultiplicity);
      for (let i = young.start; i < young.start + young.count; i++) {
        if (g.data[i * STRIDE] !== KIND_YOUNG) continue;
        particleState(this.kin, g.data, i, this.time, st);
        if (st.lum <= 0) continue;
        const d = Math.hypot(st.x - posPc.x, st.y - posPc.y, st.z - posPc.z);
        if (d >= reach) continue;
        out.push({
          id: 2 ** 50 + i,
          position: new THREE.Vector3(st.x, st.y, st.z),
          temperatureK: st.temperature,
          luminosity: st.lum / km,
          massSun: g.data[i * STRIDE + 4],
          seed: g.data[i * STRIDE + 11],
          kind: 'young',
          d,
        });
      }
    }
    out.sort((a, b) => a.d - b.d);
    return out.slice(0, k).map(({ d: _d, ...r }) => r);
  }

  private runMeter(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget): void {
    if (this.meterPending || !this.volRT) return;
    if (!this.meterRT) {
      this.meterRT = new THREE.WebGLRenderTarget(16, 9, {
        type: THREE.FloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
      });
      this.meterMat = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: METER_FRAG,
        depthTest: false,
        depthWrite: false,
        uniforms: { tVol: { value: null }, uFloor: { value: 0.5 } },
      });
    }
    const mat = this.meterMat!;
    mat.uniforms.tVol.value = this.accRT ? this.accRT[this.accIdx].texture : this.volRT.texture;
    this.quad.material = mat;
    this.quad.render(renderer, this.meterRT);
    renderer.setRenderTarget(target);
    this.meterPending = true;
    const rt = this.meterRT;
    renderer
      .readRenderTargetPixelsAsync(rt, 0, 0, 16, 9, this.meterBuf)
      .then(() => {
        if (this.disposed) return;
        const b = this.meterBuf;
        let sl = 0;
        let sw = 0;
        let sa = 0;
        let nl = 0;
        for (let i = 0; i < 16 * 9; i++) {
          sl += b[i * 4];
          sw += b[i * 4 + 1];
          sa += b[i * 4 + 2];
          nl += b[i * 4 + 3];
        }
        const n = 16 * 9 * 16;
        this.meter.lit = nl / n;
        this.meter.lum = sw > 1e-3 ? Math.exp(sl / sw) : NaN;
        this.meter.sky = Math.exp(sa / n);
      })
      .catch(() => {
        /* metering is optional */
      })
      .finally(() => (this.meterPending = false));
  }

  private debugMat: THREE.ShaderMaterial | null = null;
  private drawDebugMap(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget): void {
    if (!this.debugMat) {
      this.debugMat = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: `precision highp float; in vec2 vUv; out vec4 outColor; uniform sampler2D tMap; uniform int uCh;
          void main(){ vec4 m = texture(tMap, vUv); vec3 c = uCh==1? vec3(m.r*0.5) : uCh==2? vec3(m.g*30.0) : uCh==3? vec3(m.b*0.5) : uCh==4? vec3(m.a*30.0) : vec3(m.a*20.0, m.g*20.0, m.b*0.5); outColor = vec4(c,1.0);} `,
        uniforms: { tMap: { value: null }, uCh: { value: 1 } },
        depthTest: false,
        depthWrite: false,
      });
    }
    this.debugMat.uniforms.tMap.value = this.mapRT.texture;
    this.debugMat.uniforms.uCh.value = this.debugMap;
    this.quad.material = this.debugMat;
    this.quad.render(renderer, target);
  }

  dispose(): void {
    this.debugMat?.dispose();
    this.meterRT?.dispose();
    this.meterMat?.dispose();
    this.integ?.dispose();
    this.integ = null;
    this.disposed = true;
    this.worker?.terminate();
    this.worker = null;
    this.starGeom?.dispose();
    this.hiiGeom?.dispose();
    this.hiiMat.dispose();
    for (const lt of this.localTiers) {
      lt.geom.dispose();
      lt.mat.dispose();
    }
    this.starMat.dispose();
    this.volMat.dispose();
    this.compMat.dispose();
    this.mapMat.dispose();
    this.mapRT.dispose();
    this.mapNormRT.dispose();
    this.noiseRT.dispose();
    this.volRT?.dispose();
    this.accRT?.[0].dispose();
    this.accRT?.[1].dispose();
    this.accMat.dispose();
    this.lutTex.dispose();
  }
}

const ZERO = new THREE.Vector3();
let MW_REF = 0;
const mwRef = () => (MW_REF ||= mwReference(milkyWay(1)));

/** A star record for navigation (Voyage): positions in the render frame, parsecs. */
export interface StarRecord {
  id: number;
  position: THREE.Vector3;
  temperatureK: number;
  /** Bolometric luminosity, L☉. */
  luminosity: number;
  massSun: number;
  seed: number;
  /** 'sun', 'field' (procedural local star), or 'young' (an OB star of the orbit model). */
  kind: 'sun' | 'field' | 'young';
  name?: string;
}

/**
 * Exposure metering: each texel of a 16 × 9 target summarises a block of the volume image as
 * (Σ w·ln L, Σ w, Σ ln L, n_lit) with w = L/(L + L_floor), so empty sky does not drag the average down —
 * the eye adapts to what it is looking at, and surface brightness does not depend on distance.
 */
const METER_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D tVol;
uniform float uFloor;
void main() {
  vec2 cell = vec2(1.0 / 16.0, 1.0 / 9.0);
  vec2 o = floor(vUv / cell) * cell;
  float sl = 0.0, sw = 0.0, sa = 0.0, nl = 0.0;
  for (int j = 0; j < 4; j++) {
    for (int i = 0; i < 4; i++) {
      vec2 uv = o + (vec2(float(i), float(j)) + 0.5) * cell * 0.25;
      vec3 c = texture(tVol, uv).rgb;
      float L = max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 0.0);
      // Lit pixels only: empty space does not count, faint outskirts count a little.
      float w = L / (L + uFloor);
      sl += w * log(L + 1e-12);
      sw += w;
      sa += log(L + uFloor * 0.05);
      nl += step(uFloor * 0.3, L);
    }
  }
  outColor = vec4(sl, sw, sa, nl);
}
`;

/**
 * Integrals of the unnormalised bar shapes used by the volume shader (boxy/peanut core and long
 * thin bar), so their emissivities can be normalised to the bar's luminosity.
 */
export function barIntegrals(Lb: number, q: number, strength: number): [number, number] {
  if (Lb <= 0) return [1, 1];
  const s = Math.min(1, Math.max(0, strength));
  const ac = 0.36 * Lb;
  const bc = ac * (1 + (0.62 - 1) * s);
  const al = Lb;
  const bl = Lb * (1 + (q - 1) * s);
  const nx = 160;
  const ny = 120;
  const X = 1.4 * Lb;
  const Y = 0.9 * Lb;
  const dx = (2 * X) / nx;
  const dy = (2 * Y) / ny;
  let core = 0;
  let long = 0;
  for (let i = 0; i < nx; i++) {
    const x = -X + (i + 0.5) * dx;
    const azc = 0.14 * Lb * (0.5 + 0.9 * Math.min(1, Math.abs(x) / (0.55 * ac)));
    for (let j = 0; j < ny; j++) {
      const y = -Y + (j + 0.5) * dy;
      const mc = Math.pow(Math.pow(Math.abs(x / ac), 3) + Math.pow(Math.abs(y / bc), 3), 2 / 3);
      core += Math.exp(-mc) * Math.sqrt(Math.PI) * azc;
      const ml = Math.sqrt(Math.pow(Math.abs(x / al), 4) + Math.pow(Math.abs(y / bl), 4));
      long += Math.exp(-2.2 * ml) * Math.sqrt(Math.PI / 2.2) * 150;
    }
  }
  return [core * dx * dy, long * dx * dy];
}
