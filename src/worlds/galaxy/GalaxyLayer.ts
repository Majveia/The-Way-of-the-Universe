import * as THREE from 'three';
import { FullscreenQuad, FULLSCREEN_VERT } from '../../core/post/FullscreenQuad';
import { blackbodyRGB } from '../../physics/blackbody';
import { extinctionRGB, hiiRGB, oiiiRGB } from '../../physics/galaxyStars';
import { radMyrFromKmsKpc } from '../../physics/galaxyPotential';
import { generateParticles, Kinematics, PARTICLE_LIGHT, defaultLive, type GalaxyLive, type GalaxyParticles } from './model';
import { MAX_ARMS, type GalaxyParams } from './params';
import { MAP_FRAG } from './shaders/maps';
import { NOISE3D_FRAG } from './shaders/noise3d';
import { STAR_FRAG, STAR_VERT } from './shaders/stars';
import { VOLUME_COMPOSITE_FRAG, VOLUME_FRAG } from './shaders/volume';

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
  private starScene = new THREE.Scene();

  private volRT: THREE.WebGLRenderTarget | null = null;
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
      },
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquation: THREE.AddEquation,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });

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
    s.uDustAmount.value = this.live.dust;
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
      (d.lum * (1 - PARTICLE_LIGHT.disk)) / (2 * Math.PI * d.scaleLength ** 2) / fourPi,
      d.scaleLength,
      d.scaleHeight,
      d.truncation,
    );
    (vu.uThickP.value as THREE.Vector4).set(
      (d.thickLum * (1 - PARTICLE_LIGHT.thick)) / (2 * Math.PI * d.thickScaleLength ** 2) / fourPi,
      d.thickScaleLength,
      d.thickScaleHeight,
      d.truncation,
    );
    (vu.uFlare.value as THREE.Vector2).set(d.flare, 2.5 * d.scaleLength);
    const b = p.bulge;
    (vu.uBulgeP.value as THREE.Vector4).set((b.lum * (1 - PARTICLE_LIGHT.bulge) * b.a) / (2 * Math.PI) / fourPi, b.a, b.flatten, b.a * b.rMaxFactor);
    const [coreI, longI] = barIntegrals(p.bar.halfLength, p.bar.axisRatio, s.uBarStrength.value as number);
    const barVol = p.bar.lum * (1 - PARTICLE_LIGHT.bar);
    (vu.uBarP.value as THREE.Vector4).set(hasBar ? (0.5 * barVol) / coreI / fourPi : 0, hasBar ? (0.5 * barVol) / longI / fourPi : 0, L, p.bar.axisRatio);
    if (p.id === 'milkyway') {
      // Nuclear star cluster (Plummer, b ≈ 3.2 pc, ~2 × 10⁷ L☉) and nuclear stellar disk (~5 × 10⁸ L☉).
      const bn = 3.2;
      const Lnsc = 2e7;
      const Lnsd = 5e8;
      const rd = 90;
      (vu.uNucP.value as THREE.Vector4).set((3 * Lnsc) / (4 * Math.PI * bn ** 3) / fourPi, bn, Lnsd / (2 * Math.PI * rd * rd * 90) / fourPi, rd);
    } else (vu.uNucP.value as THREE.Vector4).set(0, 1, 0, 1);
    (vu.uBounds.value as THREE.Vector2).set(p.rMax, p.zMax);
    vu.uScatter.value = 0.5 * 60 * this.live.dust * 0;
    vu.uNoiseTile.value = p.rMax > 15000 ? 2600 : 1400;
    this.normsDirty = true;
  }

  private updateVolumeNorms(): void {
    const p = this.params;
    const vu = this.volMat.uniforms;
    const fourPi = 4 * Math.PI;
    const youngPart = this.particles?.populations.find((q) => q.name === 'young')?.lum ?? p.young.lum * PARTICLE_LIGHT.young;
    const youngVol = Math.max(0, p.young.lum - youngPart) * Math.min(2, p.young.sfr * this.live.sfr);
    (vu.uYoungP.value as THREE.Vector2).set(this.youngInt > 0 ? youngVol / this.youngInt / fourPi : 0, Math.max(40, p.young.scaleHeight * 1.6));
    // Hα + [NII] + Hβ… of ionised gas: a few per cent of the young stars' light, very concentrated.
    const hiiL = 0.1 * p.young.lum * p.gas.hii * Math.min(2, p.young.sfr * this.live.sfr);
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
    this.updateVolumeNorms();
  }

  // ——— Rendering ———————————————————————————————————————————————————————————

  resize(width: number, height: number): void {
    const w = Math.max(1, Math.round(width * this.volScale));
    const h = Math.max(1, Math.round(height * this.volScale));
    if (this.volRT && this.volRT.width === w && this.volRT.height === h) return;
    this.volRT?.dispose();
    this.volRT = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
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
      const cu = this.compMat.uniforms;
      cu.tVol.value = this.volRT!.texture;
      (cu.uTexel.value as THREE.Vector2).set(1 / this.volRT!.width, 1 / this.volRT!.height);
      this.quad.material = this.compMat;
      renderer.setRenderTarget(target);
      renderer.render(this.quad.scene, this.quad.camera);
    }

    if (this.stars && this.starsVisible) {
      const su = this.starMat.uniforms;
      (su.uCamModel.value as THREE.Vector3).copy(cam);
      (su.uOrigin.value as THREE.Vector3).copy(o.origin ?? ZERO);
      su.uFluxToRad.value = this.radianceScale / (4 * Math.PI * omegaPx);
      su.uMinRad.value = 0.0012 / Math.max(exposure, 1e-6);
      su.uSizeRef.value = 3 / Math.max(exposure, 1e-6);
      su.uMaxSize.value = Math.min(this.maxPointSize, 44);
      renderer.setRenderTarget(target);
      renderer.render(this.starScene, camera);
    }
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
    this.disposed = true;
    this.worker?.terminate();
    this.worker = null;
    this.starGeom?.dispose();
    this.starMat.dispose();
    this.volMat.dispose();
    this.compMat.dispose();
    this.mapMat.dispose();
    this.mapRT.dispose();
    this.mapNormRT.dispose();
    this.noiseRT.dispose();
    this.volRT?.dispose();
    this.lutTex.dispose();
  }
}

const ZERO = new THREE.Vector3();

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
