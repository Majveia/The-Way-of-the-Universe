import * as THREE from 'three';
import { FullscreenQuad, FULLSCREEN_VERT } from '../../core/post/FullscreenQuad';
import { blackbodyRGB } from '../../physics/blackbody';
import { L_SUN } from '../../physics/constants';
import {
  BALMER_CASE_B,
  blackbodyVisibleFraction,
  ccm89,
  HBETA_EMISSIVITY,
  NEBULA_LINES,
  paletteLineColours,
  PC_CM,
  photonBudgetK,
  tauVPerPc,
  zoneThreshold,
  DUST_ALBEDO_V,
  DUST_HG_G,
  type Palette,
} from '../../physics/nebulae';
import { DETAIL_FRAGMENT, LIGHT_FRAGMENT } from './glsl/bake';
import { densityFragment } from './glsl/density';
import { marchFragment } from './glsl/march';
import { COMPOSITE_ADD_FRAGMENT, COMPOSITE_MUL_FRAGMENT, RESOLVE_FRAGMENT } from './glsl/resolve';
import { buildLayout, type VariantLayout } from './layouts';
import { DEFAULT_VARIANT, getPreset } from './presets';
import type { NebulaPreset, NebulaStar, NebulaType, NebulaVariant, Vec3 } from './types';

export interface NebulaVolumeOptions {
  /** Spec type; picks the default variant when `variant` is omitted. */
  type?: NebulaType;
  variant?: NebulaVariant;
  /** 0 = curated arrangement resembling the reference object; anything else = new nebula. */
  seed?: number;
  /** Half-size of the volume in the parent's units (default: the preset's size in parsecs). */
  radius?: number;
  /** Quality multiplier (ExperienceContext.quality.detail, 0.35–1.6). */
  detail?: number;
  palette?: Palette;
}

export interface NebulaRenderOptions {
  /** Treat this frame as a camera cut: drop temporal history. */
  cut?: boolean;
  /** Seconds of simulated real time since the last frame (drives temporal blending while animating). */
  animating?: boolean;
}

/** Radiance of one line of sight, per emission line (Hβ-relative emission-measure units). */
export interface NebulaSpectrum {
  lines: Record<string, number>;
  /** Dust-scattered and synchrotron continuum (linear RGB, same units). */
  continuum: [number, number, number];
  /** V-band optical depth through the nebula along the ray. */
  tauV: number;
}

interface QualitySettings {
  N: number;
  detailN: number;
  steps: number;
  scale: number;
  lightStep: number;
  maxLowPixels: number;
}

function qualityFor(detail: number): QualitySettings {
  if (detail < 0.5) return { N: 64, detailN: 48, steps: 40, scale: 0.34, lightStep: 1.0, maxLowPixels: 0.35e6 };
  if (detail < 0.85) return { N: 96, detailN: 64, steps: 60, scale: 0.42, lightStep: 0.85, maxLowPixels: 0.7e6 };
  if (detail < 1.3) return { N: 128, detailN: 64, steps: 84, scale: 0.5, lightStep: 0.75, maxLowPixels: 1.1e6 };
  return { N: 160, detailN: 96, steps: 120, scale: 0.6, lightStep: 0.7, maxLowPixels: 1.8e6 };
}

const halton = (i: number, b: number) => {
  let f = 1;
  let r = 0;
  while (i > 0) {
    f /= b;
    r += f * (i % b);
    i = Math.floor(i / b);
  }
  return r;
};

/** Hβ intensity (erg s⁻¹ cm⁻² sr⁻¹) per unit emission measure (pc cm⁻⁶). */
const HBETA_I_PER_EM = (HBETA_EMISSIVITY / (4 * Math.PI)) * PC_CM;
/** Flux (erg s⁻¹ cm⁻²) of 1 L☉ at 1 pc, expressed in Hβ emission-measure units. */
export const LSUN_AT_1PC_EM = (L_SUN * 1e7) / (4 * Math.PI * PC_CM * PC_CM) / HBETA_I_PER_EM;

type Stage = 'detail' | 'density' | 'light' | 'done';

/**
 * A volumetric nebula: a physically lit gas-and-dust cube that renders itself into any linear-HDR
 * target, depth-free and composited with correct extinction of whatever is behind it.
 *
 *   const neb = new NebulaVolume({ type: 'emission', seed: 0 });
 *   await neb.bake(renderer);                       // or let render() bake progressively
 *   scene: sky → neb.render(renderer, camera, target) → stars
 *
 * Local units are parsecs; `object` places/scales the cube in the parent frame.
 */
export class NebulaVolume {
  readonly object = new THREE.Object3D();
  readonly preset: NebulaPreset;
  readonly seed: number;
  readonly layout: VariantLayout;
  readonly quality: QualitySettings;

  palette: Palette;
  /** Exposure multiplier on top of the preset's normalisation. */
  exposure = 1;
  /** Multipliers of the physical inputs (re-bake the ionization when changed). */
  densityScale = 1;
  fluxScale = 1;
  dustScale = 1;
  /** Effective temperature of the ionizing source (K): hardness → [OIII]/He II zones. */
  teff: number;
  /** Fade multiplier on all emission (0..1). */
  emission = 1;
  /** Age in years: drives turbulence drift and homologous expansion of shells. */
  age: number;
  /** True while simulated time runs (history is refreshed faster). */
  animating = false;
  /**
   * Photometric normalisation (1 / reference radiance). Starts at the preset's value and is
   * replaced by `calibrate()`, which meters the default view once like a camera's auto-exposure
   * — after that it stays fixed so physical changes (flux, density) visibly brighten or dim.
   */
  baseGain: number;
  private calibrated = false;
  /** True once calibrate() has finished (or was skipped). */
  metered = false;
  private calibRT: THREE.WebGLRenderTarget | null = null;

  private readonly N: number;
  private dens: THREE.WebGL3DRenderTarget;
  private fields: [THREE.WebGL3DRenderTarget, THREE.WebGL3DRenderTarget];
  private front = 0;
  private detailRT: THREE.WebGL3DRenderTarget;
  private stage: Stage = 'detail';
  private layer = 0;
  private hasField = false;
  private bakedExpand = 1;
  private bakedKey = '';
  private quad = new FullscreenQuad();
  private matDetail: THREE.ShaderMaterial;
  private matDensity: THREE.ShaderMaterial;
  private matLight: THREE.ShaderMaterial;
  private matMarch: THREE.ShaderMaterial;
  private matResolve: THREE.ShaderMaterial;
  private matMul: THREE.ShaderMaterial;
  private matAdd: THREE.ShaderMaterial;
  private lowRT: THREE.WebGLRenderTarget | null = null;
  private hist: THREE.WebGLRenderTarget[] = [];
  private histIdx = 0;
  private hasHistory = false;
  private staticFrames = 0;
  private frameIndex = 0;
  private readonly prevVP = new THREE.Matrix4();
  private readonly vp = new THREE.Matrix4();
  private readonly invModel = new THREE.Matrix4();
  private readonly viewToLocal4 = new THREE.Matrix4();
  private readonly viewToLocal3 = new THREE.Matrix3();
  private readonly camLocal = new THREE.Vector3();
  private readonly jitter = new THREE.Vector2();
  private paramsVersion = 0;
  private seenVersion = -1;
  private probeRT: THREE.WebGLRenderTarget | null = null;
  private matProbe: THREE.ShaderMaterial | null = null;
  private probeBusy = false;

  constructor(o: NebulaVolumeOptions = {}) {
    const variant = o.variant ?? DEFAULT_VARIANT[o.type ?? 'emission'];
    this.preset = getPreset(variant);
    this.seed = o.seed ?? 0;
    this.quality = qualityFor(o.detail ?? 1);
    this.N = this.quality.N;
    this.palette = o.palette ?? this.preset.palette;
    this.teff = this.preset.source.teff;
    this.age = this.preset.ageYears;
    this.layout = buildLayout(this.preset, this.seed);
    this.baseGain = this.preset.gain;
    const s = (o.radius ?? this.preset.half) / this.preset.half;
    this.object.scale.setScalar(s);

    const opts3 = (type: THREE.TextureDataType, wrap: THREE.Wrapping): THREE.RenderTargetOptions => ({
      type,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: wrap,
      wrapT: wrap,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    const N = this.N;
    this.dens = new THREE.WebGL3DRenderTarget(N, N, N, opts3(THREE.HalfFloatType, THREE.ClampToEdgeWrapping));
    this.fields = [
      new THREE.WebGL3DRenderTarget(N, N, N, opts3(THREE.HalfFloatType, THREE.ClampToEdgeWrapping)),
      new THREE.WebGL3DRenderTarget(N, N, N, opts3(THREE.HalfFloatType, THREE.ClampToEdgeWrapping)),
    ];
    const dn = this.quality.detailN;
    this.detailRT = new THREE.WebGL3DRenderTarget(dn, dn, dn, opts3(THREE.UnsignedByteType, THREE.RepeatWrapping));
    // (wrapR is not a RenderTarget option; set it on the 3D textures directly.)
    this.detailRT.texture.wrapR = THREE.RepeatWrapping;
    for (const t of [this.dens, ...this.fields]) t.texture.wrapR = THREE.ClampToEdgeWrapping;

    const base = { vertexShader: FULLSCREEN_VERT, glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false };
    this.matDetail = new THREE.ShaderMaterial({
      ...base,
      fragmentShader: DETAIL_FRAGMENT,
      uniforms: { uN: { value: dn }, uLayer: { value: 0 }, uSeed: { value: (this.seed % 97) + 0.5 } },
    });
    this.matDensity = new THREE.ShaderMaterial({
      ...base,
      fragmentShader: densityFragment(this.preset.variant),
      uniforms: {
        uHalf: { value: this.preset.half },
        uN: { value: N },
        uLayer: { value: 0 },
        uSeedOff: { value: new THREE.Vector3(...this.layout.seedOffset) },
        ...this.layout.densityUniforms,
      },
    });
    this.matLight = new THREE.ShaderMaterial({
      ...base,
      fragmentShader: LIGHT_FRAGMENT,
      uniforms: {
        uDens: { value: this.dens.texture },
        uN: { value: N },
        uLayer: { value: 0 },
        uHalf: { value: this.preset.half },
        uSource: { value: new THREE.Vector3(...this.layout.source) },
        uK: { value: 0 },
        uDensScale: { value: 1 },
        uKappa: { value: 0 },
        uIonDust: { value: this.preset.ionDust },
        uStepVox: { value: this.quality.lightStep },
      },
    });
    this.matMarch = new THREE.ShaderMaterial({
      ...base,
      fragmentShader: marchFragment({ layout: this.preset.layout, synchrotron: this.preset.variant === 'crab' }),
      uniforms: this.marchUniforms(false),
    });
    this.matResolve = new THREE.ShaderMaterial({
      ...base,
      fragmentShader: RESOLVE_FRAGMENT,
      uniforms: {
        uCur: { value: null },
        uCurAux: { value: null },
        uHist: { value: null },
        uLowSize: { value: new THREE.Vector2(1, 1) },
        uFullSize: { value: new THREE.Vector2(1, 1) },
        uJitter: { value: this.jitter },
        uProjInv: { value: new THREE.Matrix4() },
        uViewToLocal: { value: this.viewToLocal3 },
        uCamLocal: { value: this.camLocal },
        uPrevVP: { value: this.prevVP },
        uAlpha: { value: 1 },
        uClip: { value: 1 },
        uHasHist: { value: 0 },
        // The low tier marches few steps: reconstruct fully with the Gaussian so its step noise
        // never shows as a lattice (or as shimmer while the camera drifts).
        uSharp: { value: this.quality.steps < 50 ? 0.8 : 1.1 },
        uDenoise: { value: this.quality.steps < 50 ? 1 : 0.85 },
        uStill: { value: 0 },
      },
    });
    const kExt = this.kExt();
    this.matMul = new THREE.ShaderMaterial({
      ...base,
      fragmentShader: COMPOSITE_MUL_FRAGMENT,
      uniforms: { uHist: { value: null }, uKExt: { value: kExt } },
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.ZeroFactor,
      blendDst: THREE.SrcColorFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    this.matAdd = new THREE.ShaderMaterial({
      ...base,
      fragmentShader: COMPOSITE_ADD_FRAGMENT,
      uniforms: { uHist: { value: null } },
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    this.applyParams();
  }

  // ——— public API —————————————————————————————————————————————————————————————

  get type(): NebulaType {
    return this.preset.type;
  }
  get variant(): NebulaVariant {
    return this.preset.variant;
  }
  /** Stars embedded in the nebula (cluster members, central star, pulsar…), nebula-local pc. */
  get stars(): NebulaStar[] {
    return this.layout.stars;
  }
  /** Position of the ionizing source (nebula-local pc, before expansion). */
  get source(): Vec3 {
    return this.layout.source;
  }
  /** True once the first bake has completed. */
  get ready(): boolean {
    return this.hasField;
  }
  /** Fraction of the current bake done (1 when idle). */
  get bakeProgress(): number {
    if (this.stage === 'done') return 1;
    const dn = this.quality.detailN;
    const N = this.N;
    const total = dn * 0.3 + N * 1 + N * 2;
    let done = 0;
    if (this.stage === 'detail') done = this.layer * 0.3;
    else if (this.stage === 'density') done = dn * 0.3 + this.layer;
    else done = dn * 0.3 + N + this.layer * 2;
    return this.hasField && this.stage === 'light' ? this.layer / N : done / total;
  }
  /** Current homologous expansion factor R(t)/R(t_ref) (1 for static nebulae). */
  get expansion(): number {
    const p = this.preset;
    if (p.expansionKmS <= 0) return 1;
    const t = Math.max(this.age, p.ageYears * 0.05);
    if (p.variant === 'veil') return Math.pow(t / p.ageYears, 0.4); // Sedov–Taylor R ∝ t^{2/5}
    return t / p.ageYears; // free / homologous expansion R ∝ t
  }

  /** Call after changing palette, exposure, teff, emission (cheap: uniforms only). */
  applyParams(): void {
    const p = this.preset;
    const u = this.matMarch.uniforms;
    const cols = paletteLineColours(this.palette);
    const ids = NEBULA_LINES.map((l) => l.id);
    for (let i = 0; i < 4; i++) {
      (u.uColA.value[i] as THREE.Vector3).set(...cols[ids[i]]);
      (u.uColB.value[i] as THREE.Vector3).set(...cols[ids[i + 4]]);
    }
    u.uGain.value = this.baseGain * this.exposure;
    u.uEmission.value = this.emission;
    const T = this.teff;
    (u.uLnZone.value as THREE.Vector3).set(
      Math.log(zoneThreshold(T, 'He+')),
      // Near the front the ionization parameter collapses and low ions (O⁺, N⁺, S⁺) take over even
      // around hot stars (O&F §5.4): the O²⁺ zone never reaches the last ~40 % of the photon budget.
      Math.min(Math.log(zoneThreshold(T, 'O++')), -0.5),
      Math.log(zoneThreshold(T, 'He++')),
    );
    const L = p.lines;
    (u.uRatiosA.value as THREE.Vector4).set(BALMER_CASE_B.Ha, BALMER_CASE_B.Hb, BALMER_CASE_B.Hg, L.O3);
    (u.uRatiosB.value as THREE.Vector4).set(L.N2, L.S2, L.He1, L.He2);
    u.uKappa.value = tauVPerPc(1, p.dustToGas * this.dustScale);
    const star = this.starRGB(T, p.source.lum);
    (u.uStarRGB.value as THREE.Vector3).set(star[0], star[1], star[2]);
    this.paramsVersion++;
    // Physical inputs of the ionization bake.
    const key = `${this.densityScale.toFixed(4)}|${this.fluxScale.toFixed(4)}|${this.dustScale.toFixed(4)}`;
    if (key !== this.bakedKey && this.hasField) this.invalidateLight();
    this.bakedKey = key;
  }

  /** Cheap per-frame update of the emission fade (no history reset). */
  applyEmission(): void {
    this.matMarch.uniforms.uEmission.value = this.emission;
  }

  /** Current gain applied to radiance (baseGain × exposure) — stars use the same scale. */
  get gain(): number {
    return this.baseGain * this.exposure;
  }

  /**
   * Meter the preset's default view once (like a camera's auto-exposure) so every nebula and
   * every seed lands at a good exposure: the 99.5th-percentile pixel maps to `target`.
   * Resolves after a tiny GPU readback; later calls are no-ops.
   */
  async calibrate(renderer: THREE.WebGLRenderer, target = this.preset.meter ?? 1.6): Promise<void> {
    if (this.calibrated || !this.hasField) return;
    this.calibrated = true;
    try {
      await this.meter(renderer, target);
    } finally {
      this.metered = true;
    }
  }

  private async meter(renderer: THREE.WebGLRenderer, target: number): Promise<void> {
    const W = 96;
    const H = 54;
    const rt = (this.calibRT = new THREE.WebGLRenderTarget(W, H, { count: 2, type: THREE.FloatType, depthBuffer: false }));
    const v = this.preset.views.default;
    const cam = new THREE.PerspectiveCamera(42, W / H, 1e-4, 1e4);
    const t = new THREE.Vector3(...(v.target ?? [0, 0, 0]));
    const cp = Math.cos(v.pitch);
    cam.position.set(t.x + v.distance * cp * Math.sin(v.yaw), t.y + v.distance * Math.sin(v.pitch), t.z + v.distance * cp * Math.cos(v.yaw));
    cam.lookAt(t);
    cam.updateMatrixWorld();
    cam.updateProjectionMatrix();
    const mu = this.matMarch.uniforms;
    const inv = new THREE.Matrix4().copy(this.object.matrixWorld).invert();
    const v2l = new THREE.Matrix4().multiplyMatrices(inv, cam.matrixWorld);
    const saved = { g: mu.uGain.value as number, e: mu.uEmission.value as number, jx: this.jitter.x, jy: this.jitter.y };
    this.viewToLocal3.setFromMatrix4(v2l);
    this.camLocal.setFromMatrixPosition(v2l);
    (mu.uProjInv.value as THREE.Matrix4).copy(cam.projectionMatrixInverse);
    mu.uRes.value.set(W, H);
    mu.uGain.value = 1;
    mu.uEmission.value = 1;
    mu.uExpand.value = this.expansion;
    this.jitter.set(0, 0);
    const prev = renderer.getRenderTarget();
    this.quad.material = this.matMarch;
    renderer.setRenderTarget(rt);
    renderer.render(this.quad.scene, this.quad.camera);
    renderer.setRenderTarget(prev);
    mu.uGain.value = saved.g;
    mu.uEmission.value = saved.e;
    this.jitter.set(saved.jx, saved.jy);
    const px = new Float32Array(W * H * 4);
    try {
      await renderer.readRenderTargetPixelsAsync(rt, 0, 0, W, H, px, undefined, 0);
    } catch {
      return;
    } finally {
      rt.dispose();
      this.calibRT = null;
    }
    const lum: number[] = [];
    for (let i = 0; i < W * H; i++) {
      const l = 0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2];
      if (Number.isFinite(l) && l > 0) lum.push(l);
    }
    if (lum.length < 20) return;
    lum.sort((a, b) => a - b);
    const idx = Math.max(Math.floor(0.995 * W * H) - (W * H - lum.length), Math.floor(0.9 * lum.length));
    const p = lum[Math.min(lum.length - 1, idx)];
    if (p > 0) {
      this.baseGain = target / p;
      this.applyParams();
    }
  }

  /** Re-run only the ionization/lighting bake (after density/flux/dust changes). */
  invalidateLight(): void {
    if (this.preset.layout === 'shock') return;
    if (this.stage === 'done' || this.stage === 'light') {
      this.stage = 'light';
      this.layer = 0;
    }
  }

  /** Bake everything now, yielding to the event loop between chunks. */
  async bake(renderer: THREE.WebGLRenderer, onProgress?: (f: number) => void): Promise<void> {
    while (this.stage !== 'done') {
      this.bakeStep(renderer, 6);
      onProgress?.(this.bakeProgress);
      await new Promise((r) => setTimeout(r, 0));
    }
    onProgress?.(1);
  }

  /** Advance the bake by roughly `budget` layer-units (a lighting layer costs 2). */
  bakeStep(renderer: THREE.WebGLRenderer, budget: number): void {
    const prevTarget = renderer.getRenderTarget();
    const scene = this.quad.scene;
    const cam = this.quad.camera;
    while (budget > 0 && this.stage !== 'done') {
      if (this.stage === 'detail') {
        this.matDetail.uniforms.uLayer.value = this.layer;
        this.quad.material = this.matDetail;
        renderer.setRenderTarget(this.detailRT, this.layer);
        renderer.render(scene, cam);
        budget -= 0.3;
        if (++this.layer >= this.quality.detailN) this.nextStage('density');
      } else if (this.stage === 'density') {
        this.matDensity.uniforms.uLayer.value = this.layer;
        this.quad.material = this.matDensity;
        renderer.setRenderTarget(this.dens, this.layer);
        renderer.render(scene, cam);
        budget -= 1;
        if (++this.layer >= this.N) {
          if (this.preset.layout === 'shock') {
            // Shock layouts carry their own field (distance to the sheets); nothing to ionize.
            this.hasField = true;
            this.matMarch.uniforms.uField.value = this.dens.texture;
            this.nextStage('done');
            this.paramsVersion++;
          } else this.nextStage('light');
        }
      } else {
        if (this.layer === 0) this.prepareLight();
        this.matLight.uniforms.uLayer.value = this.layer;
        this.quad.material = this.matLight;
        const back = this.fields[1 - this.front];
        renderer.setRenderTarget(back, this.layer);
        renderer.render(scene, cam);
        budget -= 2;
        if (++this.layer >= this.N) {
          this.front = 1 - this.front;
          this.hasField = true;
          this.matMarch.uniforms.uField.value = this.fields[this.front].texture;
          this.stage = 'done';
          this.layer = 0;
          this.paramsVersion++;
        }
      }
    }
    renderer.setRenderTarget(prevTarget);
  }

  /**
   * Draw the nebula into `target` (linear HDR). Whatever is already in `target` is extinguished
   * (and reddened) by the nebula's dust; the nebula's own light is added on top.
   */
  render(renderer: THREE.WebGLRenderer, camera: THREE.Camera, target: THREE.WebGLRenderTarget | null, o: NebulaRenderOptions = {}): void {
    if (this.stage !== 'done') this.bakeStep(renderer, this.hasField ? 12 : 48);
    // Homologous expansion: re-bake the ionization as the shell grows.
    const s = this.expansion;
    if (this.preset.layout === 'photo' && this.hasField && this.stage === 'done' && Math.abs(s / this.bakedExpand - 1) > 0.004) this.invalidateLight();
    if (!this.hasField) {
      renderer.setRenderTarget(target);
      return;
    }
    const w = target ? target.width : renderer.domElement.width;
    const h = target ? target.height : renderer.domElement.height;
    this.ensureTargets(w, h);
    const lowRT = this.lowRT!;

    // Camera in nebula-local coordinates.
    camera.updateMatrixWorld();
    this.object.updateMatrixWorld();
    this.invModel.copy(this.object.matrixWorld).invert();
    this.viewToLocal4.multiplyMatrices(this.invModel, camera.matrixWorld);
    this.viewToLocal3.setFromMatrix4(this.viewToLocal4);
    this.camLocal.setFromMatrixPosition(this.viewToLocal4);
    this.vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(this.object.matrixWorld);

    // Temporal accumulation policy.
    const moved = !matricesClose(this.vp, this.prevVP);
    const changed = this.paramsVersion !== this.seenVersion;
    this.seenVersion = this.paramsVersion;
    let alpha = 1;
    let clip = 1;
    const cut = o.cut || !this.hasHistory;
    if (cut) {
      this.staticFrames = 0;
    } else if (moved) {
      this.staticFrames = 0;
      alpha = 0.24;
    } else if (changed) {
      this.staticFrames = 0;
      alpha = 0.5;
    } else {
      this.staticFrames++;
      alpha = Math.max(1 / (this.staticFrames + 2), o.animating || this.animating ? 1 / 10 : 1 / 48);
      clip = this.staticFrames < 3 ? 1 : 0;
    }
    const k = (this.frameIndex % 16) + 1;
    this.jitter.set(halton(k, 2) - 0.5, halton(k, 3) - 0.5);
    this.frameIndex++;

    // 1. Ray march (low resolution, MRT: radiance+T, depth).
    const mu = this.matMarch.uniforms;
    mu.uRes.value.set(lowRT.width, lowRT.height);
    const fov = (camera as THREE.PerspectiveCamera).fov ?? 50;
    mu.uPixAngle.value = (2 * Math.tan(THREE.MathUtils.degToRad(fov) / 2)) / lowRT.height;
    mu.uFrame.value = this.frameIndex % 4096;
    (mu.uProjInv.value as THREE.Matrix4).copy((camera as THREE.PerspectiveCamera).projectionMatrixInverse);
    mu.uExpand.value = s;
    const voxel = (2 * this.preset.half) / this.N;
    mu.uNearScale.value = 2.5 * voxel * s;
    this.updateDrift(mu);
    this.quad.material = this.matMarch;
    renderer.setRenderTarget(lowRT);
    renderer.render(this.quad.scene, this.quad.camera);

    // 2. Temporal resolve at full resolution.
    const ru = this.matResolve.uniforms;
    const src = this.hist[this.histIdx];
    const dst = this.hist[1 - this.histIdx];
    ru.uCur.value = lowRT.textures[0];
    ru.uCurAux.value = lowRT.textures[1];
    ru.uHist.value = src.texture;
    ru.uLowSize.value.set(lowRT.width, lowRT.height);
    ru.uFullSize.value.set(dst.width, dst.height);
    (ru.uProjInv.value as THREE.Matrix4).copy((camera as THREE.PerspectiveCamera).projectionMatrixInverse);
    ru.uAlpha.value = alpha;
    ru.uClip.value = clip;
    ru.uHasHist.value = cut ? 0 : 1;
    ru.uStill.value = moved ? 0 : 1;
    this.quad.material = this.matResolve;
    renderer.setRenderTarget(dst);
    renderer.render(this.quad.scene, this.quad.camera);
    this.histIdx = 1 - this.histIdx;
    this.hasHistory = true;
    this.prevVP.copy(this.vp);

    // 3. Composite: extinguish what is behind, then add the nebula's light.
    renderer.setRenderTarget(target);
    this.matMul.uniforms.uHist.value = dst.texture;
    this.quad.material = this.matMul;
    renderer.render(this.quad.scene, this.quad.camera);
    this.matAdd.uniforms.uHist.value = dst.texture;
    this.quad.material = this.matAdd;
    renderer.render(this.quad.scene, this.quad.camera);
  }

  /**
   * V-band optical depth of the nebula's dust between two nebula-local points (CPU-free estimate
   * is done on the GPU by NebulaStars; this is the shader-side contract): exposes the field.
   */
  get fieldTexture(): THREE.Data3DTexture | null {
    if (!this.hasField) return null;
    return this.preset.layout === 'shock' ? this.dens.texture : this.fields[this.front].texture;
  }
  /** τ_V per pc per unit of the field's x channel (dust-bearing density). */
  get kappa(): number {
    return this.matMarch.uniforms.uKappa.value as number;
  }
  get ionDust(): number {
    return this.preset.ionDust;
  }

  /**
   * Spectrograph: integrate the eight emission lines along the ray through normalised device
   * coordinates (ndcX, ndcY) of `camera`. Resolves asynchronously (GPU readback).
   */
  async probe(renderer: THREE.WebGLRenderer, camera: THREE.Camera, ndcX: number, ndcY: number): Promise<NebulaSpectrum | null> {
    if (!this.hasField || this.probeBusy) return null;
    this.probeBusy = true;
    try {
      if (!this.probeRT) {
        this.probeRT = new THREE.WebGLRenderTarget(1, 1, { count: 3, type: THREE.FloatType, depthBuffer: false });
        this.matProbe = new THREE.ShaderMaterial({
          vertexShader: FULLSCREEN_VERT,
          fragmentShader: marchFragment({ layout: this.preset.layout, synchrotron: this.preset.variant === 'crab', probe: true }),
          glslVersion: THREE.GLSL3,
          depthTest: false,
          depthWrite: false,
          uniforms: { ...this.marchUniforms(true) },
        });
      }
      const mp = this.matProbe!;
      // Share every march uniform value, then set the probe ray.
      for (const [k, v] of Object.entries(this.matMarch.uniforms)) if (mp.uniforms[k]) mp.uniforms[k].value = v.value;
      camera.updateMatrixWorld();
      this.object.updateMatrixWorld();
      const inv = new THREE.Matrix4().copy(this.object.matrixWorld).invert();
      const v2l = new THREE.Matrix4().multiplyMatrices(inv, camera.matrixWorld);
      mp.uniforms.uViewToLocal.value = new THREE.Matrix3().setFromMatrix4(v2l);
      mp.uniforms.uCamLocal.value = new THREE.Vector3().setFromMatrixPosition(v2l);
      mp.uniforms.uProjInv.value = (camera as THREE.PerspectiveCamera).projectionMatrixInverse.clone();
      mp.uniforms.uProbeNdc.value = new THREE.Vector2(ndcX, ndcY);
      mp.uniforms.uSteps.value = 200;
      const prev = renderer.getRenderTarget();
      this.quad.material = mp;
      renderer.setRenderTarget(this.probeRT);
      renderer.render(this.quad.scene, this.quad.camera);
      renderer.setRenderTarget(prev);
      const a = new Float32Array(4);
      const b = new Float32Array(4);
      const c = new Float32Array(4);
      await renderer.readRenderTargetPixelsAsync(this.probeRT, 0, 0, 1, 1, a, undefined, 0);
      await renderer.readRenderTargetPixelsAsync(this.probeRT, 0, 0, 1, 1, b, undefined, 1);
      await renderer.readRenderTargetPixelsAsync(this.probeRT, 0, 0, 1, 1, c, undefined, 2);
      const lines: Record<string, number> = {};
      NEBULA_LINES.forEach((l, i) => (lines[l.id] = i < 4 ? a[i] : b[i - 4]));
      return { lines, continuum: [c[0], c[1], c[2]], tauV: c[3] };
    } catch {
      return null;
    } finally {
      this.probeBusy = false;
    }
  }

  dispose(): void {
    this.dens.dispose();
    this.fields[0].dispose();
    this.fields[1].dispose();
    this.detailRT.dispose();
    this.lowRT?.dispose();
    for (const h of this.hist) h.dispose();
    this.probeRT?.dispose();
    this.calibRT?.dispose();
    this.matProbe?.dispose();
    this.matDetail.dispose();
    this.matDensity.dispose();
    this.matLight.dispose();
    this.matMarch.dispose();
    this.matResolve.dispose();
    this.matMul.dispose();
    this.matAdd.dispose();
  }

  // ——— internals ——————————————————————————————————————————————————————————————

  private nextStage(s: Stage): void {
    this.stage = s;
    this.layer = 0;
  }

  /** Physical constants of the lighting bake, including homologous expansion (see march notes). */
  private prepareLight(): void {
    const p = this.preset;
    const s = this.expansion;
    const u = this.matLight.uniforms;
    const Q = p.source.Q * this.fluxScale;
    // Bake in comoving coordinates: n_phys = n₀ s⁻³, u_phys = s u  ⇒  K' = K s³, κ' = κ s.
    u.uK.value = Q > 0 ? photonBudgetK(Q) * s * s * s : 0;
    u.uDensScale.value = this.densityScale / (s * s * s);
    u.uKappa.value = tauVPerPc(1, p.dustToGas * this.dustScale) * s;
    this.bakedExpand = s;
  }

  private kExt(): THREE.Vector3 {
    return new THREE.Vector3(ccm89(610), ccm89(549), ccm89(465));
  }

  /** Source luminosity × colour in Hβ emission-measure units at 1 pc (for dust scattering). */
  starRGB(teff: number, lumSun: number): [number, number, number] {
    const [r, g, b] = blackbodyRGB(teff);
    const k = LSUN_AT_1PC_EM * lumSun * blackbodyVisibleFraction(teff);
    return [r * k, g * k, b * k];
  }

  private marchUniforms(probe: boolean): Record<string, THREE.IUniform> {
    const p = this.preset;
    const kExt = this.kExt();
    const scatterPos = Array.from({ length: 8 }, () => new THREE.Vector4());
    const scatterRGB = Array.from({ length: 8 }, () => new THREE.Vector3());
    this.layout.scatter.slice(0, 8).forEach((st, i) => {
      scatterPos[i].set(st.pos[0], st.pos[1], st.pos[2], 0.0025);
      scatterRGB[i].set(...this.starRGB(st.teff, st.lum));
    });
    const u: Record<string, THREE.IUniform> = {
      uField: { value: this.fields[this.front].texture },
      uDetail: { value: this.detailRT.texture },
      uRes: { value: new THREE.Vector2(1, 1) },
      uJitter: { value: this.jitter },
      uFrame: { value: 0 },
      uProjInv: { value: new THREE.Matrix4() },
      uViewToLocal: { value: this.viewToLocal3 },
      uCamLocal: { value: this.camLocal },
      uHalf: { value: p.half },
      uExpand: { value: 1 },
      uSteps: { value: this.quality.steps },
      uNearScale: { value: 0.1 },
      uMaxT: { value: 1e9 },
      uDetailFreq: { value: new THREE.Vector2(1 / p.detailScale[0], 1 / p.detailScale[1]) },
      uTexel: { value: new THREE.Vector3(p.detailScale[0] / this.quality.detailN, p.detailScale[1] / this.quality.detailN, 1 / this.quality.detailN) },
      uPixAngle: { value: 0 },
      uDrift1: { value: new THREE.Vector3() },
      uDrift2: { value: new THREE.Vector3() },
      uTurb: { value: p.turbulence },
      uFrontNoise: { value: p.frontNoise },
      uStreak: { value: new THREE.Vector3(p.streak?.[0] ?? 0, p.streak?.[1] ?? 0, p.streak?.[2] ?? 0) },
      uLnZone: { value: new THREE.Vector3() },
      uRatiosA: { value: new THREE.Vector4() },
      uRatiosB: { value: new THREE.Vector4() },
      uKappa: { value: 0 },
      uIonDust: { value: p.ionDust },
      uAlbedo: { value: DUST_ALBEDO_V },
      uHG: { value: DUST_HG_G },
      uKScat: { value: kExt.clone() },
      uKExt: { value: kExt },
      uKLine: { value: new THREE.Vector3(ccm89(660), ccm89(500), ccm89(450)) },
      uSource: { value: new THREE.Vector3(...this.layout.source) },
      uStarRGB: { value: new THREE.Vector3() },
      uScatCount: { value: Math.min(8, this.layout.scatter.length) },
      uScatPos: { value: scatterPos },
      uScatRGB: { value: scatterRGB },
      uScatShadow: { value: p.layout === 'photo' && p.source.Q > 0 ? 4 : 0 },
      uScatShadowLen: { value: p.half * 0.6 },
      uEmission: { value: 1 },
      uSheetR: { value: new THREE.Vector4() },
      uSheetO: { value: new THREE.Vector4() },
      uSheetB: { value: new THREE.Vector4() },
      uRipple: { value: 0 },
      uSynAxes: { value: new THREE.Vector3(1, 1, 1) },
      uSynRot: { value: new THREE.Matrix3() },
      uSynCore: { value: new THREE.Vector3() },
      uSynEdge: { value: new THREE.Vector3() },
      uWisp: { value: new THREE.Vector4() },
    };
    if (probe) {
      u.uProbeNdc = { value: new THREE.Vector2() };
    } else {
      u.uColA = { value: Array.from({ length: 4 }, () => new THREE.Vector3()) };
      u.uColB = { value: Array.from({ length: 4 }, () => new THREE.Vector3()) };
      u.uGain = { value: 1 };
    }
    // Variant-specific uniforms (sheets, synchrotron) are merged in by the layout.
    for (const [k, v] of Object.entries(this.layout.densityUniforms)) {
      if (k.startsWith('uMarch_')) u[k.slice(7)] = v;
    }
    return u;
  }

  private updateDrift(mu: Record<string, THREE.IUniform>): void {
    const p = this.preset;
    // Turbulent flow at `flowKmS`: 1 km/s ≈ 1.0227e-6 pc/yr. Two octaves drift in different
    // directions so the pattern evolves instead of sliding.
    const d = p.flowKmS * 1.0227e-6 * this.age;
    const f = mu.uDetailFreq.value as THREE.Vector2;
    (mu.uDrift1.value as THREE.Vector3).set(0.61 * d * f.x, 0.23 * d * f.x, -0.37 * d * f.x);
    (mu.uDrift2.value as THREE.Vector3).set(-0.42 * d * f.y, 0.51 * d * f.y, 0.3 * d * f.y);
  }

  private ensureTargets(w: number, h: number): void {
    const q = this.quality;
    let lw = Math.max(1, Math.round(w * q.scale));
    let lh = Math.max(1, Math.round(h * q.scale));
    const px = lw * lh;
    if (px > q.maxLowPixels) {
      const k = Math.sqrt(q.maxLowPixels / px);
      lw = Math.max(1, Math.round(lw * k));
      lh = Math.max(1, Math.round(lh * k));
    }
    if (!this.lowRT || this.lowRT.width !== lw || this.lowRT.height !== lh) {
      this.lowRT?.dispose();
      this.lowRT = new THREE.WebGLRenderTarget(lw, lh, {
        count: 2,
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false,
      });
      this.hasHistory = false;
    }
    if (!this.hist.length || this.hist[0].width !== w || this.hist[0].height !== h) {
      for (const t of this.hist) t.dispose();
      this.hist = [0, 1].map(
        () =>
          new THREE.WebGLRenderTarget(w, h, {
            type: THREE.HalfFloatType,
            format: THREE.RGBAFormat,
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            depthBuffer: false,
            stencilBuffer: false,
          }),
      );
      this.hasHistory = false;
    }
  }
}

function matricesClose(a: THREE.Matrix4, b: THREE.Matrix4): boolean {
  const x = a.elements;
  const y = b.elements;
  for (let i = 0; i < 16; i++) {
    const d = Math.abs(x[i] - y[i]);
    if (d > 1e-6 * (1 + Math.abs(x[i]))) return false;
  }
  return true;
}
