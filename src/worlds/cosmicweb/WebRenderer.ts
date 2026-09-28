/**
 * GPU renderer for the cosmic web (module: cosmos).
 *
 * Passes per frame (all additive, linear HDR, no depth buffer):
 *   1. density   — particles NGP-deposited into a G³ grid tiled in a 2D atlas, then a separable
 *                  periodic Gaussian blur → local ρ/ρ̄ for colour and adaptive smoothing lengths.
 *                  Only redone when the displayed positions change (playback), not when paused.
 *   2. accum     — every particle as an energy-normalised sprite with SPH-like smoothing length
 *                  h ∝ (ρ/ρ̄)^(−1/3); channels Σw (projected density) and Σw·log10ρ, into a
 *                  half-float RG target at ≤ 1 pixel per CSS pixel (it is a smooth field).
 *   3. hdr       — ONE draw call list into the caller's HDR target: the primordial glow, the
 *                  composite (asinh stretch of the projected density, hue from the mean log
 *                  density), field and halo galaxies as point sources, and the box outline.
 *                  (three.js resolves a multisampled target after every render() call, so
 *                  batching them into one scene saves up to four full-screen MSAA resolves.)
 * Positions come from two RGBA16UI keyframe textures and are interpolated in the vertex shaders.
 *
 * Portability: no float32 filtering or float32 blending is required (see formats.ts); targets are
 * checked for framebuffer completeness and fall back to 8-bit encodings rather than render black.
 */
import * as THREE from 'three';
import { FullscreenQuad, FULLSCREEN_VERT } from '../../core/post/FullscreenQuad';
import {
  ACCUM_FRAG,
  ACCUM_VERT,
  BLUR_FRAG,
  CMB_FRAG,
  CMB_VERT,
  COMPOSITE_FRAG,
  DEPOSIT_FRAG,
  DEPOSIT_VERT,
  FIELD_VERT,
  GALAXY_FRAG,
  GALAXY_VERT,
} from './shaders';
import { hash01 } from '../../physics/random';
import type { GalaxyCatalog } from './types';
import {
  accumScaleFor,
  accumSpec,
  atlasSpec,
  chooseFormats,
  fallbackAccum,
  fallbackAtlas,
  type AccumMode,
  type AtlasMode,
  type TargetSpec,
  type WebFormats,
} from './formats';

export interface WebRendererOptions {
  /** Particles per side and total. */
  np: number;
  count: number;
  /** Mesh cells per side of the simulation (for the lattice offset). */
  nm: number;
  /** Comoving box side in world units (Mpc). */
  boxWorld: number;
  /** Lagrangian overdensity per particle (δL/σL·32, int8). */
  deltaL: Int8Array;
  sigmaL: number;
  /** σ²(M_min) − σR² and σ²(10¹¹ M☉) − σR² for the field-galaxy collapsed fractions. */
  varDwarf: number;
  varBright: number;
  /** Quality detail (0.35 … 1.6). */
  detail: number;
  /** Force target formats (testing the fallback paths); normally chosen from the device's extensions. */
  formats?: Partial<WebFormats>;
}

export interface WebFrameState {
  /** Keyframe interpolation: A→B with weight mix, or Zel'dovich back-scaling of A (za ≥ 0). */
  mix: number;
  za: number;
  /** Linear growth factor (1 today) and redshift at the displayed time. */
  D: number;
  z: number;
  /** World scale: 1 = comoving, a = physical coordinates. */
  scale: number;
  /** Periodic wrap around the camera (immersive) and the wrap centre in box fractions. */
  wrap: boolean;
  wrapCenter: THREE.Vector3;
  /** World distance at which immersive views fade (0 = none). */
  fadeFar: number;
  /** Slab: axis + half thickness (box fraction), null for the whole volume. */
  slab: { axis: THREE.Vector3; center: number; half: number } | null;
  /** 0–1 intensities. */
  darkMatter: number;
  galaxies: number;
  fieldGalaxies: number;
  replicas: number;
  outline: number;
  /** Brightness controls. */
  exposure: number;
  /** Star-formation brightening of blue galaxies (cosmic noon), environment quenching 0–1. */
  sfrBoost: number;
  quench: number;
  /** Primordial glow: temperature (K), visible radiance, displayed anisotropy (0 while opaque). */
  cmb: { T: number; radiance: number; aniso: number } | null;
}

/**
 * One keyframe texture: RGB16UI, 16-bit box fractions, one texel per particle. Uploaded with raw
 * texSubImage2D straight from the decoded keyframe (no repacking on the main thread), in row
 * slices when it is staged ahead of time.
 */
interface Slot {
  tex: THREE.ExternalTexture;
  gl: WebGLTexture;
  /** Keyframe whose upload is complete (−1: none). */
  frame: number;
  /** Keyframe being uploaded in slices (−1: none), its source array and the rows done. */
  pending: number;
  src: Uint16Array | null;
  rows: number;
  /** Last use (for choosing which slot to overwrite). */
  used: number;
}

/** Pure additive blending (ONE, ONE): three's AdditiveBlending multiplies by source alpha. */
const ADDITIVE = {
  blending: THREE.CustomBlending,
  blendEquation: THREE.AddEquation,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneFactor,
  blendSrcAlpha: THREE.OneFactor,
  blendDstAlpha: THREE.OneFactor,
} as const;

/** The 26 periodic neighbours of the box (instance offsets for the replica draw). */
const REPLICA_OFFSETS = (() => {
  const a: number[] = [];
  for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) if (x || y || z) a.push(x, y, z);
  return new Float32Array(a);
})();

/**
 * Void fade of the dark-matter sprites (ρ/ρ̄): particles below `x` emit nothing, fading in up to
 * `y`. With emission ∝ ρ² these particles carry ≈ 1 % of the light but, with the largest
 * smoothing lengths, most of the sprite fill (see docs in the accumulation shader).
 */
const VOID_FADE = new THREE.Vector2(0.12, 0.3);
/**
 * Importance thinning of low-density sprites: below ρ/ρ̄ = x keep (ρ/x)^y of them, at least z.
 * x follows the growth of structure (1 + D, see render()): the young, low-contrast web is thinned
 * only below the mean density, the contrasted web of today below twice the mean.
 */
const THIN = new THREE.Vector3(2.0, 1.0, 0.1);

/** Framebuffer-completeness answers per renderer and target format (see complete()). */
const completeCache = new WeakMap<THREE.WebGLRenderer, Map<string, boolean>>();
/** ALIASED_POINT_SIZE_RANGE per renderer (a synchronous query; asked once). */
const pointSizeCache = new WeakMap<THREE.WebGLRenderer, number>();

const tmpColor = new THREE.Color();
const tmpSize = new THREE.Vector2();

export class WebRenderer {
  readonly opts: WebRendererOptions;
  private renderer: THREE.WebGLRenderer;
  private texW: number;
  private texH: number;
  /** Three keyframe slots: A, B and one being filled ahead of time for the next interval. */
  private slots: Slot[];
  private useClock = 0;
  /** Keyframe index currently bound as A and B, and their slots. */
  private boundA = -1;
  private boundB = -1;
  private slotA = -1;
  private slotB = -1;
  /**
   * True once every program is compiled and linked. Programs are compiled asynchronously
   * (KHR_parallel_shader_compile via compileAsync) and nothing is drawn before, so first use never
   * blocks a frame on a driver compile (tens to hundreds of ms per program on ANGLE/D3D11).
   */
  ready = false;
  readonly whenReady: Promise<void>;
  private disposed = false;
  /** The one-off warm-up draw has been made (see warmDraw()). */
  private warmed = false;
  // Density atlas
  readonly grid: number;
  private tilesX: number;
  private tilesY: number;
  private atlasA: THREE.WebGLRenderTarget;
  private atlasB: THREE.WebGLRenderTarget;
  readonly atlasMode: AtlasMode;
  private blurMat: THREE.ShaderMaterial;
  private quad = new FullscreenQuad();
  // Accumulation
  private accum: THREE.WebGLRenderTarget;
  readonly accumMode: AccumMode;
  private compositeMat: THREE.ShaderMaterial;
  /** Largest point sprite the device rasterises (ALIASED_POINT_SIZE_RANGE), px. */
  private readonly maxPointSize: number;
  // Scenes
  private depositScene = new THREE.Scene();
  private accumScene = new THREE.Scene();
  private replicaScene = new THREE.Scene();
  /** Everything that lands in the caller's (possibly multisampled) HDR target: one render() call. */
  private hdrScene = new THREE.Scene();
  private depositMat: THREE.ShaderMaterial;
  private accumMat: THREE.ShaderMaterial;
  private replicaMat: THREE.ShaderMaterial;
  private galaxyMat: THREE.ShaderMaterial;
  private fieldMat: THREE.ShaderMaterial;
  private cmbMat: THREE.ShaderMaterial;
  private outlineMat: THREE.LineBasicMaterial;
  private particleGeo: THREE.BufferGeometry;
  private replicaGeo: THREE.InstancedBufferGeometry;
  private fieldGeo: THREE.BufferGeometry;
  private galaxyGeo: THREE.BufferGeometry;
  private fsGeo: THREE.BufferGeometry;
  private cmbGeo: THREE.SphereGeometry;
  private accumPoints: THREE.Points;
  private galaxyPoints: THREE.Points;
  private fieldPoints: THREE.Points;
  private compositeMesh: THREE.Mesh;
  private cmbMesh: THREE.Mesh;
  private outline: THREE.LineSegments;
  private orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private shared: Record<string, THREE.IUniform>;
  private galaxyCount = 0;
  private galaxyCap = 0;
  private fieldCount = 0;
  private densityDirty = true;
  private lastA = -2;
  private lastB = -2;
  private lastMix = NaN;
  private lastZA = NaN;
  private targetW = 1;
  private targetH = 1;
  private sizedFor = { w: 0, h: 0, pr: 0, imm: false };
  /** Camera inside the box (wrapped views): coarser accumulator, no thinning (see accumScaleFor). */
  private immersive = false;
  /** Least fraction of sub-mean-density sprites drawn outside the box (0 = thinning off; tunable). */
  private thinMin = THIN.z;
  /** Set when tune() fixed the thinning threshold (experiments); otherwise it follows D. */
  private thinPinned = false;
  /** Screen-space pixel density (device px per CSS px of the target) for sprite sizes. */
  pixelRatio = 1;
  /** Composite brightness (× exposure) and galaxy brightness; tunable. */
  readonly look = { bright: 0.3, galaxy: 2.2e-4 };

  constructor(renderer: THREE.WebGLRenderer, opts: WebRendererOptions) {
    this.renderer = renderer;
    this.opts = opts;
    const N = opts.count;
    let maxPt = pointSizeCache.get(renderer);
    if (maxPt === undefined) {
      const gl = renderer.getContext();
      const range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array | null;
      maxPt = range && range[1] > 1 ? range[1] : 64;
      pointSizeCache.set(renderer, maxPt);
    }
    this.maxPointSize = maxPt;
    const fm = {
      ...chooseFormats({
        colorBufferFloat: renderer.extensions.has('EXT_color_buffer_float'),
        colorBufferHalfFloat: renderer.extensions.has('EXT_color_buffer_half_float'),
        floatBlend: renderer.extensions.has('EXT_float_blend'),
      }),
      ...opts.formats,
    };
    // Keyframe textures (see Slot).
    this.texW = N >= 1 << 21 ? 2048 : 1024;
    this.texH = Math.ceil(N / this.texW);
    this.slots = [0, 1, 2].map(() => this.makeSlot());
    // Density atlas: G³ with G ≈ 64 (a few Mpc) — smooth enough for colour and smoothing lengths.
    const G = opts.np >= 128 ? 96 : Math.min(64, opts.np);
    this.grid = G;
    this.tilesX = Math.ceil(Math.sqrt(G));
    while (G % this.tilesX !== 0) this.tilesX++;
    this.tilesY = G / this.tilesX;
    let atlasMode: AtlasMode | null = fm.atlas;
    let atlas: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] | null = null;
    while (atlasMode) {
      const spec = atlasSpec(atlasMode);
      const a = this.makeTarget(this.tilesX * G, this.tilesY * G, spec);
      const b = this.makeTarget(this.tilesX * G, this.tilesY * G, spec);
      if (this.complete(a)) {
        atlas = [a, b];
        break;
      }
      a.dispose();
      b.dispose();
      atlasMode = fallbackAtlas(atlasMode);
    }
    if (!atlas || !atlasMode) {
      atlasMode = 'rgba8';
      const spec = atlasSpec(atlasMode);
      atlas = [this.makeTarget(this.tilesX * G, this.tilesY * G, spec), this.makeTarget(this.tilesX * G, this.tilesY * G, spec)];
    }
    this.atlasMode = atlasMode;
    [this.atlasA, this.atlasB] = atlas;
    const atlasEncode = atlasSpec(atlasMode).encode;
    let accumMode: AccumMode | null = fm.accum;
    let accum: THREE.WebGLRenderTarget | null = null;
    while (accumMode) {
      const t = this.makeTarget(4, 4, accumSpec(accumMode));
      if (this.complete(t)) {
        accum = t;
        break;
      }
      t.dispose();
      accumMode = fallbackAccum(accumMode);
    }
    if (!accum || !accumMode) {
      accumMode = 'rgba8';
      accum = this.makeTarget(4, 4, accumSpec(accumMode));
    }
    this.accumMode = accumMode;
    this.accum = accum;
    const accSpec = accumSpec(accumMode);

    const latStep = 1 / opts.np;
    const latOff = 0.5 / opts.nm;
    this.shared = {
      uPosA: { value: this.slots[0].tex },
      uPosB: { value: this.slots[1].tex },
      uTexW: { value: this.texW },
      uMix: { value: 0 },
      uZA: { value: -1 },
      uNp: { value: opts.np },
      uLatOff: { value: latOff },
      uLatStep: { value: latStep },
      uDensity: { value: this.atlasA.texture },
      uDensDec: { value: 1 / atlasEncode },
      uGrid: { value: G },
      uTilesX: { value: this.tilesX },
      uBoxWorld: { value: opts.boxWorld },
      uWrapCenter: { value: new THREE.Vector3(0.5, 0.5, 0.5) },
      uWrap: { value: 0 },
      uOffset: { value: new THREE.Vector3() },
      uSlab: { value: new THREE.Vector4(0, 0, 1, 0) },
      uSlabCenter: { value: 0.5 },
      uFocalPx: { value: 1000 },
      uFadeFar: { value: 0 },
      uNear: { value: 0.1 },
    };
    const S = this.shared;

    // Particle geometry: no positions — only the Lagrangian overdensity attribute; gl_VertexID indexes.
    this.particleGeo = new THREE.BufferGeometry();
    this.particleGeo.setAttribute('aDelta', new THREE.BufferAttribute(opts.deltaL, 1, true));
    this.particleGeo.setDrawRange(0, N);
    this.particleGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);

    this.depositMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: DEPOSIT_VERT,
      fragmentShader: DEPOSIT_FRAG,
      uniforms: {
        uPosA: S.uPosA, uPosB: S.uPosB, uTexW: S.uTexW, uMix: S.uMix, uZA: S.uZA, uNp: S.uNp, uLatOff: S.uLatOff, uLatStep: S.uLatStep,
        uGrid: S.uGrid, uTilesX: S.uTilesX,
        uAtlas: { value: new THREE.Vector2(this.tilesX * G, this.tilesY * G) },
        uWeight: { value: ((G * G * G) / N) * atlasEncode },
      },
      ...ADDITIVE,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    const dep = new THREE.Points(this.particleGeo, this.depositMat);
    dep.frustumCulled = false;
    this.depositScene.add(dep);

    this.blurMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: BLUR_FRAG,
      uniforms: { tSrc: { value: null }, uGrid: S.uGrid, uTilesX: S.uTilesX, uAxis: { value: 0 } },
      depthTest: false,
      depthWrite: false,
    });

    const accumUniforms = {
      ...S,
      uSpacing: { value: opts.boxWorld / opts.np },
      uSmooth: { value: 1.1 },
      uHMax: { value: 2.2 },
      uVoidFade: { value: VOID_FADE.clone() },
      uThin: { value: THIN.clone() },
      uMinPx: { value: 1.25 },
      uMaxPx: { value: 90 },
      uFlux: { value: 1 },
      uStride: { value: 1 },
      uStrideOffset: { value: 0 },
      uGain: { value: 1 },
      uEmit: { value: 1.0 },
      uEncode: { value: accSpec.encode },
      uDither: { value: accumMode === 'rgba8' ? 1 / 255 : 0 },
    };
    this.accumMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: ACCUM_VERT,
      fragmentShader: ACCUM_FRAG,
      uniforms: accumUniforms,
      ...ADDITIVE,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    this.accumPoints = new THREE.Points(this.particleGeo, this.accumMat);
    this.accumPoints.frustumCulled = false;
    this.accumScene.add(this.accumPoints);

    // Periodic neighbours: one instanced draw of a sparse particle subset for all 26 images.
    this.replicaGeo = new THREE.InstancedBufferGeometry();
    this.replicaGeo.setAttribute('aDelta', this.particleGeo.getAttribute('aDelta'));
    this.replicaGeo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(REPLICA_OFFSETS, 3));
    this.replicaGeo.instanceCount = 26;
    this.replicaGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    this.replicaMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      defines: { REPLICAS: 1 },
      vertexShader: ACCUM_VERT,
      fragmentShader: ACCUM_FRAG,
      // Shares every uniform object with the main pass except the gain and the stride.
      uniforms: { ...accumUniforms, uGain: { value: 1 }, uStride: { value: 4 } },
      ...ADDITIVE,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    const rep = new THREE.Points(this.replicaGeo, this.replicaMat);
    rep.frustumCulled = false;
    this.replicaScene.add(rep);

    this.compositeMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: COMPOSITE_FRAG,
      uniforms: {
        tAccum: { value: this.accum.texture },
        uSoft: { value: 2.0 },
        uBright: { value: 0.3 },
        uFloor: { value: 0.0 },
        uSat: { value: 1.0 },
        uDecode: { value: 1 / accSpec.encode },
        uLogMode: { value: accumMode === 'rgba8' ? 1 : 0 },
      },
      ...ADDITIVE,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    this.fsGeo = new THREE.BufferGeometry();
    this.fsGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.fsGeo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.compositeMesh = new THREE.Mesh(this.fsGeo, this.compositeMat);
    this.compositeMesh.frustumCulled = false;
    this.compositeMesh.renderOrder = 1;

    // Resolved galaxies (rebuilt per keyframe interval).
    this.galaxyGeo = new THREE.BufferGeometry();
    this.galaxyMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: GALAXY_VERT,
      fragmentShader: GALAXY_FRAG,
      uniforms: {
        ...S,
        uLumScale: { value: 1 },
        uMinPx: { value: 1.4 },
        uSfrBoost: { value: 0 },
      },
      ...ADDITIVE,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    this.galaxyPoints = new THREE.Points(this.galaxyGeo, this.galaxyMat);
    this.galaxyPoints.frustumCulled = false;
    this.galaxyPoints.renderOrder = 3;
    this.galaxyPoints.visible = false;

    // Field galaxies: a fixed random subset of particles (index buffer over the particle attributes).
    const frac = Math.min(1, 0.05 * Math.pow(128 / opts.np, 3) * Math.max(0.6, opts.detail));
    // Selection by an inline integer hash (a 2M-particle pass of the general hash01 cost ~50 ms here).
    const thr = Math.floor(frac * 4294967296);
    const pick = (i: number) => {
      let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
      h ^= h >>> 13;
      h = Math.imul(h, 0xc2b2ae35);
      h ^= h >>> 16;
      return h >>> 0 < thr;
    };
    // One pass into a buffer sized for the expected count (+10 σ); a second pass only on overflow.
    const cap = Math.min(N, Math.ceil(N * frac + 10 * Math.sqrt(N * frac + 1) + 64));
    let buf = new Uint32Array(cap);
    let nIdx = 0;
    for (let i = 0; i < N && nIdx <= cap; i++) if (pick(i)) {
      if (nIdx < cap) buf[nIdx] = i;
      nIdx++;
    }
    if (nIdx > cap) {
      nIdx = 0;
      for (let i = 0; i < N; i++) if (pick(i)) nIdx++;
      buf = new Uint32Array(nIdx);
      for (let i = 0, j = 0; i < N; i++) if (pick(i)) buf[j++] = i;
    }
    const idx = nIdx === buf.length ? buf : buf.slice(0, nIdx);
    this.fieldCount = nIdx;
    this.fieldGeo = new THREE.BufferGeometry();
    this.fieldGeo.setAttribute('aDelta', this.particleGeo.getAttribute('aDelta'));
    this.fieldGeo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.fieldMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FIELD_VERT,
      fragmentShader: GALAXY_FRAG,
      uniforms: {
        ...S,
        uD: { value: 0 },
        uSigmaL: { value: opts.sigmaL },
        uVarDwarf: { value: Math.max(opts.varDwarf, 0.5) },
        uVarBright: { value: Math.max(opts.varBright, 0.3) },
        uLumScale: { value: 1 },
        uMinPx: { value: 1.15 },
        uQuench: { value: 0 },
        uSfrBoost: { value: 0 },
        uCount: { value: nIdx / N },
      },
      ...ADDITIVE,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    this.fieldPoints = new THREE.Points(this.fieldGeo, this.fieldMat);
    this.fieldPoints.frustumCulled = false;
    this.fieldPoints.renderOrder = 2;

    // Box outline: hairlines, very faint.
    const box = new THREE.BoxGeometry(1, 1, 1);
    const edges = new THREE.EdgesGeometry(box);
    box.dispose();
    this.outlineMat = new THREE.LineBasicMaterial({
      color: new THREE.Color(0.02, 0.02, 0.025),
      ...ADDITIVE,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    this.outline = new THREE.LineSegments(edges, this.outlineMat);
    this.outline.frustumCulled = false;
    this.outline.renderOrder = 4;

    // Primordial fireball / CMB sky (direction only: the vertex shader drops the view translation).
    this.cmbMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: CMB_VERT,
      fragmentShader: CMB_FRAG,
      uniforms: { uT: { value: 3000 }, uRadiance: { value: 1 }, uAniso: { value: 0 }, uSeed: { value: 17.3 } },
      // Additive like every other pass (it is the first thing drawn into a cleared target, so the
      // result is the same), which keeps the warm-up draw invisible over a caller's scene too.
      ...ADDITIVE,
      transparent: true,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
    });
    this.cmbGeo = new THREE.SphereGeometry(1, 96, 48);
    this.cmbMesh = new THREE.Mesh(this.cmbGeo, this.cmbMat);
    this.cmbMesh.frustumCulled = false;
    this.cmbMesh.renderOrder = 0;

    this.hdrScene.add(this.cmbMesh, this.compositeMesh, this.fieldPoints, this.galaxyPoints, this.outline);
    this.whenReady = this.warm();
  }

  private makeTarget(w: number, h: number, spec: TargetSpec): THREE.WebGLRenderTarget {
    return new THREE.WebGLRenderTarget(w, h, {
      type: spec.type as THREE.TextureDataType,
      format: spec.format as THREE.PixelFormat,
      minFilter: spec.filter as THREE.MinificationTextureFilter,
      magFilter: spec.filter as THREE.MagnificationTextureFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
  }

  /**
   * Is this target renderable on this device? (Bind it once and ask the driver.) The answer depends
   * only on the format, and checkFramebufferStatus is a synchronous round trip to the GPU process
   * (it waits for all queued work: 70–200 ms mid-playback in tests), so it is asked once per
   * renderer and format — by the small glow renderer created at mount, not when a run starts.
   */
  private complete(rt: THREE.WebGLRenderTarget): boolean {
    const r = this.renderer;
    const key = `${rt.texture.type}:${rt.texture.format}`;
    let known = completeCache.get(r);
    if (!known) completeCache.set(r, (known = new Map()));
    const hit = known.get(key);
    if (hit !== undefined) return hit;
    const ok = this.checkComplete(rt);
    known.set(key, ok);
    return ok;
  }

  private checkComplete(rt: THREE.WebGLRenderTarget): boolean {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    r.setRenderTarget(rt);
    const gl = r.getContext();
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    r.setRenderTarget(prev);
    return ok;
  }

  private makeSlot(): Slot {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    const t = gl.createTexture()!;
    const st = this.renderer.state;
    st.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGB16UI, this.texW, this.texH);
    st.unbindTexture();
    return { tex: new THREE.ExternalTexture(t), gl: t, frame: -1, pending: -1, src: null, rows: 0, used: 0 };
  }

  /** Upload rows [r0, r1) of keyframe positions `pos` (xyz uint16 per particle) into a slot. */
  private uploadRows(s: Slot, pos: Uint16Array, r0: number, r1: number): void {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    const st = this.renderer.state;
    const W = this.texW;
    const n = Math.min(pos.length / 3, W * this.texH);
    const fullRows = Math.floor(n / W);
    st.bindTexture(gl.TEXTURE_2D, s.gl);
    st.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
    st.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    st.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    st.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    st.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false as unknown as number);
    st.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false as unknown as number);
    const a = r0, b = Math.min(r1, fullRows);
    if (b > a) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, a, W, b - a, gl.RGB_INTEGER, gl.UNSIGNED_SHORT, pos, a * W * 3);
    // A last, partial row.
    const rem = n - fullRows * W;
    if (rem > 0 && r1 > fullRows && r0 <= fullRows) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, fullRows, rem, 1, gl.RGB_INTEGER, gl.UNSIGNED_SHORT, pos, fullRows * W * 3);
    st.unbindTexture();
  }

  private findSlot(frame: number): number {
    for (let i = 0; i < 3; i++) if (this.slots[i].frame === frame) return i;
    return -1;
  }

  /** Slot (other than k1, k2) with an upload of `frame` in progress — from `src`, if given. */
  private pendingSlot(frame: number, src: Uint16Array | null, k1: number, k2: number): number {
    for (let j = 0; j < 3; j++) {
      const s = this.slots[j];
      if (j !== k1 && j !== k2 && s.pending === frame && (!src || s.src === src)) return j;
    }
    return -1;
  }

  /** Least recently used slot, other than those listed. */
  private victim(x: number, y: number): number {
    let best = -1;
    for (let i = 0; i < 3; i++) {
      if (i === x || i === y) continue;
      if (best < 0 || this.slots[i].used < this.slots[best].used) best = i;
    }
    return best;
  }

  /** Make keyframe `frame` resident in a slot other than `k1`/`k2` (synchronous upload if needed). */
  private ensure(frame: number, pos: Uint16Array, k1: number, k2: number): number {
    let i = this.findSlot(frame);
    if (i >= 0) return i;
    // A staged upload in progress for this frame: finish it.
    i = this.pendingSlot(frame, pos, k1, k2);
    if (i < 0) {
      i = this.victim(k1, k2);
      this.slots[i].rows = 0;
    }
    const s = this.slots[i];
    s.frame = -1;
    this.uploadRows(s, pos, s.rows, this.texH);
    s.frame = frame;
    s.pending = -1;
    s.src = null;
    s.rows = this.texH;
    return i;
  }

  /** Point the A/B slots at two decoded keyframes (uploads only what is not already resident). */
  setKeyframes(a: number, posA: Uint16Array, b: number, posB: Uint16Array): void {
    if (this.boundA === a && this.boundB === b) return;
    const ia = this.ensure(a, posA, this.findSlot(b), -1);
    this.slots[ia].used = ++this.useClock;
    const ib = a === b ? ia : this.ensure(b, posB, ia, -1);
    this.slots[ib].used = ++this.useClock;
    this.shared.uPosA.value = this.slots[ia].tex;
    this.shared.uPosB.value = this.slots[ib].tex;
    this.slotA = ia;
    this.slotB = ib;
    this.boundA = a;
    this.boundB = b;
    this.densityDirty = true;
  }

  /** Is keyframe `frame` fully uploaded (setKeyframes with it costs nothing)? */
  isResident(frame: number): boolean {
    return this.findSlot(frame) >= 0;
  }

  /**
   * Upload keyframe `frame` (decoded positions `pos`) ahead of time into the slot not bound as A or
   * B, at most `budget` particles per call. Called once per frame while playback approaches it, so
   * crossing into the next interval costs no upload at all. Returns true when the frame is resident.
   */
  stage(frame: number, pos: Uint16Array, budget: number): boolean {
    if (this.findSlot(frame) >= 0) return true;
    let i = this.pendingSlot(frame, null, this.slotA, this.slotB);
    if (i < 0) {
      i = this.victim(this.slotA, this.slotB);
      if (i < 0) return false;
    }
    const s = this.slots[i];
    if (s.pending !== frame || s.src !== pos) {
      s.pending = frame;
      s.src = pos;
      s.rows = 0;
      s.frame = -1;
    }
    const rows = Math.max(1, Math.ceil(budget / this.texW));
    const end = Math.min(this.texH, s.rows + rows);
    this.uploadRows(s, pos, s.rows, end);
    s.rows = end;
    if (end < this.texH) return false;
    s.frame = frame;
    s.pending = -1;
    s.src = null;
    s.used = ++this.useClock;
    return true;
  }

  /**
   * Compile every program without blocking (the promise resolves when they are linked; drawing
   * waits for it). Materials must exist; programs are shared with any renderer already using them.
   */
  private warm(): Promise<void> {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    // Program variants depend on the bound target (colour space, tone mapping): all passes draw
    // into render targets, so compile with one bound.
    r.setRenderTarget(this.accum);
    this.quad.material = this.blurMat;
    const scenes: THREE.Object3D[] = [this.depositScene, this.accumScene, this.replicaScene, this.hdrScene, this.quad.scene];
    // Without KHR_parallel_shader_compile (compileAsync would only warn and poll) link now: this
    // renderer is built at mount or when a run reports in, not in the middle of playback.
    const parallel = r.extensions.has('KHR_parallel_shader_compile');
    let jobs: Promise<unknown>[] = [];
    try {
      if (parallel) jobs = scenes.map((sc) => r.compileAsync(sc, this.orthoCam));
      else for (const sc of scenes) r.compile(sc, this.orthoCam);
    } catch {
      jobs = [];
    }
    r.setRenderTarget(prev);
    if (!parallel) {
      this.ready = true;
      return Promise.resolve();
    }
    // Never wait forever (a lost context or a driver that never reports completion).
    const timeout = new Promise<void>((res) => setTimeout(res, 4000));
    return Promise.race([Promise.all(jobs).then(() => undefined), timeout]).then(() => {
      if (!this.disposed) this.ready = true;
    });
  }

  /** Resolved galaxies for the displayed interval: merge catalogs A and B by galaxy id. */
  setGalaxies(A: GalaxyCatalog | null, B: GalaxyCatalog | null): void {
    const a = A ?? B, b = B ?? A;
    if (!a || !b) {
      this.galaxyCount = 0;
      return;
    }
    const idxB = new Map<number, number>();
    for (let j = 0; j < b.count; j++) idxB.set(b.id[j], j);
    // Upper bound on the merged count: every galaxy of A plus every galaxy of B.
    const cap = a.count + b.count;
    if (cap === 0) {
      this.galaxyCount = 0;
      return;
    }
    if (cap > this.galaxyCap) {
      // Grow the attribute buffers (and free the old GPU buffers with the geometry).
      const c = Math.max(64, Math.ceil(cap * 1.5));
      this.galaxyGeo.dispose();
      this.galaxyGeo.setAttribute('aHostA', new THREE.BufferAttribute(new Float32Array(c), 1));
      this.galaxyGeo.setAttribute('aHostB', new THREE.BufferAttribute(new Float32Array(c), 1));
      this.galaxyGeo.setAttribute('aLum', new THREE.BufferAttribute(new Float32Array(2 * c), 2));
      this.galaxyGeo.setAttribute('aBlue', new THREE.BufferAttribute(new Float32Array(2 * c), 2));
      this.galaxyGeo.setAttribute('aSeed', new THREE.BufferAttribute(new Float32Array(c), 1));
      this.galaxyCap = c;
    }
    const g = this.galaxyGeo;
    const hostA = g.getAttribute('aHostA') as THREE.BufferAttribute;
    const hostB = g.getAttribute('aHostB') as THREE.BufferAttribute;
    const lum = g.getAttribute('aLum') as THREE.BufferAttribute;
    const blue = g.getAttribute('aBlue') as THREE.BufferAttribute;
    const seed = g.getAttribute('aSeed') as THREE.BufferAttribute;
    const hA = hostA.array as Float32Array, hB = hostB.array as Float32Array, L2 = lum.array as Float32Array, B2 = blue.array as Float32Array, sd = seed.array as Float32Array;
    const L = (m: number) => Math.pow(Math.max(m, 1e6) / 1e10, 0.75);
    let n = 0;
    for (let i = 0; i < a.count; i++) {
      const id = a.id[i];
      const j = idxB.get(id);
      hA[n] = a.host[i];
      hB[n] = j !== undefined ? b.host[j] : a.host[i];
      L2[2 * n] = L(a.mstar[i]);
      L2[2 * n + 1] = j !== undefined ? L(b.mstar[j]) : 0;
      B2[2 * n] = a.blue[i];
      B2[2 * n + 1] = j !== undefined ? b.blue[j] : a.blue[i];
      sd[n] = hash01(id, 31);
      if (j !== undefined) idxB.set(id, -1); // matched
      n++;
    }
    for (let j = 0; j < b.count; j++) {
      if (idxB.get(b.id[j]) === -1) continue;
      hA[n] = b.host[j];
      hB[n] = b.host[j];
      L2[2 * n] = 0;
      L2[2 * n + 1] = L(b.mstar[j]);
      B2[2 * n] = b.blue[j];
      B2[2 * n + 1] = b.blue[j];
      sd[n] = hash01(b.id[j], 31);
      n++;
    }
    for (const at of [hostA, hostB, lum, blue, seed]) {
      at.clearUpdateRanges();
      at.addUpdateRange(0, n * at.itemSize);
      at.needsUpdate = true;
    }
    g.setDrawRange(0, n);
    this.galaxyCount = n;
  }

  /** Size of the accumulation target (pixels). */
  get accumSize(): { width: number; height: number } {
    return { width: this.accum.width, height: this.accum.height };
  }

  /** The HDR target is `width × height` pixels; the accumulator follows at its own scale. */
  resize(width: number, height: number): void {
    this.targetW = Math.max(1, width);
    this.targetH = Math.max(1, height);
    const s = accumScaleFor(this.opts.detail, this.pixelRatio, this.targetW * this.targetH, this.immersive);
    const aw = Math.max(1, Math.round(this.targetW * s)), ah = Math.max(1, Math.round(this.targetH * s));
    if (aw !== this.accum.width || ah !== this.accum.height) this.accum.setSize(aw, ah);
    this.sizedFor.w = width;
    this.sizedFor.h = height;
    this.sizedFor.pr = this.pixelRatio;
    this.sizedFor.imm = this.immersive;
  }

  /** Build the density atlas for the current interpolated positions. */
  private density(): void {
    const r = this.renderer;
    r.setRenderTarget(this.atlasA);
    r.clear(true, false, false);
    r.render(this.depositScene, this.orthoCam);
    // x, y, z blur passes: A → B → A → B.
    this.quad.material = this.blurMat;
    const u = this.blurMat.uniforms;
    u.tSrc.value = this.atlasA.texture;
    u.uAxis.value = 0;
    this.quad.render(r, this.atlasB);
    u.tSrc.value = this.atlasB.texture;
    u.uAxis.value = 1;
    this.quad.render(r, this.atlasA);
    u.tSrc.value = this.atlasA.texture;
    u.uAxis.value = 2;
    this.quad.render(r, this.atlasB);
    this.shared.uDensity.value = this.atlasB.texture;
  }

  /**
   * Draw every pass once — one invisible particle each — into the same target formats, blend
   * states and primitive types as real use. Drivers build some pipeline variants only at the first
   * draw (ANGLE/D3D11 compiles the point-sprite geometry shader then; Metal and Vulkan build a
   * pipeline per program × target format × blend state), which otherwise stalls the frame in which
   * e.g. the first galaxies appear, mid-playback. Done once per renderer, the first frame it is
   * ready: at mount (the small glow renderer) and when a run starts — never mid-playback. The GL
   * programs, and so the drivers' variant caches, are shared by every renderer.
   */
  private warmDraw(target: THREE.WebGLRenderTarget | null, camera: THREE.PerspectiveCamera): void {
    this.warmed = true;
    const r = this.renderer;
    const N = this.opts.count;
    const noGalaxies = this.galaxyCount === 0;
    if (noGalaxies) {
      const one = { count: 1, id: new Uint32Array(1), host: new Uint32Array(1), mstar: new Float32Array([1e10]), blue: new Float32Array(1) } as unknown as GalaxyCatalog;
      this.setGalaxies(one, one);
    }
    const am = this.accumMat.uniforms, rm = this.replicaMat.uniforms, cm = this.compositeMat.uniforms;
    const gm = this.galaxyMat.uniforms, fm = this.fieldMat.uniforms, km = this.cmbMat.uniforms;
    const saved = [am.uGain.value, rm.uGain.value, cm.uBright.value, gm.uLumScale.value, fm.uLumScale.value, km.uRadiance.value] as number[];
    am.uGain.value = rm.uGain.value = cm.uBright.value = gm.uLumScale.value = fm.uLumScale.value = km.uRadiance.value = 0;
    const vis = [this.cmbMesh.visible, this.compositeMesh.visible, this.fieldPoints.visible, this.galaxyPoints.visible, this.outline.visible];
    this.cmbMesh.visible = this.compositeMesh.visible = this.fieldPoints.visible = this.galaxyPoints.visible = this.outline.visible = true;
    const outlineColor = this.outlineMat.color.getHex();
    this.outlineMat.color.setRGB(0, 0, 0);
    this.particleGeo.setDrawRange(0, 1);
    this.replicaGeo.setDrawRange(0, 1);
    this.fieldGeo.setDrawRange(0, 1);
    const prevTarget = r.getRenderTarget();
    r.getClearColor(tmpColor);
    const clearAlpha = r.getClearAlpha();
    r.setClearColor(0x000000, 0);
    this.density();
    r.setRenderTarget(this.accum);
    r.clear(true, false, false);
    r.render(this.accumScene, camera);
    r.render(this.replicaScene, camera);
    r.setRenderTarget(target);
    r.render(this.hdrScene, camera);
    // Restore.
    r.setRenderTarget(this.accum);
    r.clear(true, false, false);
    r.setRenderTarget(prevTarget);
    r.setClearColor(tmpColor, clearAlpha);
    this.particleGeo.setDrawRange(0, N);
    this.replicaGeo.setDrawRange(0, Infinity);
    this.fieldGeo.setDrawRange(0, Infinity);
    this.outlineMat.color.setHex(outlineColor);
    [am.uGain.value, rm.uGain.value, cm.uBright.value, gm.uLumScale.value, fm.uLumScale.value, km.uRadiance.value] = saved;
    [this.cmbMesh.visible, this.compositeMesh.visible, this.fieldPoints.visible, this.galaxyPoints.visible, this.outline.visible] = vis;
    if (noGalaxies) this.galaxyCount = 0;
    this.densityDirty = true;
  }

  /** Render the web into `target` (linear HDR, already cleared) with `camera`. */
  render(target: THREE.WebGLRenderTarget | null, camera: THREE.PerspectiveCamera, st: WebFrameState, hasParticles: boolean): void {
    if (!this.ready) return;
    if (!this.warmed) this.warmDraw(target, camera);
    const r = this.renderer;
    const S = this.shared;
    // Follow the target (dynamic resolution) and the pixel density.
    const tw = target ? target.width : r.getDrawingBufferSize(tmpSize).x;
    const th = target ? target.height : tmpSize.y;
    this.immersive = st.wrap;
    const z = this.sizedFor;
    if (tw !== z.w || th !== z.h || this.pixelRatio !== z.pr || this.immersive !== z.imm) this.resize(tw, th);
    r.getClearColor(tmpColor);
    const clearAlpha = r.getClearAlpha();
    r.setClearColor(0x000000, 0);

    // Primordial glow (background at infinity).
    const cmbOn = !!st.cmb && st.cmb.radiance > 1e-5;
    this.cmbMesh.visible = cmbOn;
    if (st.cmb && cmbOn) {
      this.cmbMat.uniforms.uT.value = st.cmb.T;
      this.cmbMat.uniforms.uRadiance.value = st.cmb.radiance;
      this.cmbMat.uniforms.uAniso.value = st.cmb.aniso;
    }
    const boxW = this.opts.boxWorld * st.scale;
    // Focal lengths in pixels: of the accumulator (sprite sizes) and of the target (point sources).
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const focal = this.accum.height / (2 * tanHalf);
    const focalT = this.targetH / (2 * tanHalf);
    const showDM = hasParticles && st.darkMatter > 0;
    if (hasParticles) {
      S.uMix.value = st.mix;
      S.uZA.value = st.za;
      S.uBoxWorld.value = boxW;
      S.uWrap.value = st.wrap ? 1 : 0;
      (S.uWrapCenter.value as THREE.Vector3).copy(st.wrapCenter);
      S.uFadeFar.value = st.fadeFar;
      S.uNear.value = camera.near * 2;
      const slab = S.uSlab.value as THREE.Vector4;
      if (st.slab) {
        slab.set(st.slab.axis.x, st.slab.axis.y, st.slab.axis.z, st.slab.half);
        S.uSlabCenter.value = st.slab.center;
      } else slab.w = 0;
      S.uFocalPx.value = focal;

      // 1. density (only when the displayed positions changed)
      if (this.densityDirty || this.boundA !== this.lastA || this.boundB !== this.lastB || st.mix !== this.lastMix || st.za !== this.lastZA) {
        this.density();
        this.lastA = this.boundA;
        this.lastB = this.boundB;
        this.lastMix = st.mix;
        this.lastZA = st.za;
        this.densityDirty = false;
      }

      // 2. accumulate dark-matter light
      if (showDM) {
        const N = this.opts.count;
        const am = this.accumMat.uniforms;
        am.uSpacing.value = boxW / this.opts.np;
        // uFlux = f² L² / N: a path through the whole box at mean density accumulates ≈ 1.
        am.uFlux.value = (focal * focal * boxW * boxW) / N;
        const maxR = Math.max(2, this.maxPointSize / 2 - 1);
        am.uMinPx.value = Math.min(maxR, Math.max(0.9, 1.1 * (this.accum.height / this.targetH) * this.pixelRatio));
        am.uMaxPx.value = Math.min(maxR, 0.12 * this.accum.height);
        am.uGain.value = st.darkMatter;
        // Thinning only from outside the box: inside it, near sprites are large and a reweighted
        // one would show as a blotch; there the coarser accumulator carries the saving instead.
        const thin = am.uThin.value as THREE.Vector3;
        thin.z = st.wrap ? 0 : this.thinMin;
        if (!this.thinPinned) thin.x = 1 + Math.min(1, Math.max(0, st.D));
        r.setRenderTarget(this.accum);
        r.clear(true, false, false);
        r.render(this.accumScene, camera);
        if (st.replicas > 0 && !st.wrap && !st.slab) {
          // Neighbouring periodic images, sparsely sampled and faint (one instanced draw).
          const stride = N > 1e6 ? 16 : N > 3e5 ? 8 : 4;
          const rm = this.replicaMat.uniforms;
          rm.uStride.value = stride;
          rm.uGain.value = st.darkMatter * st.replicas * stride;
          this.replicaGeo.setDrawRange(0, Math.floor(N / stride));
          r.render(this.replicaScene, camera);
        }
      }
    }

    // 3. everything that goes into the HDR target, in one render() call.
    this.compositeMesh.visible = showDM;
    if (showDM) this.compositeMat.uniforms.uBright.value = this.look.bright * st.exposure;
    const gl = focalT * focalT * this.look.galaxy * st.exposure;
    this.fieldPoints.visible = hasParticles && st.fieldGalaxies > 0 && this.fieldCount > 0;
    if (this.fieldPoints.visible) {
      const fm = this.fieldMat.uniforms;
      fm.uD.value = st.D;
      fm.uLumScale.value = gl * st.fieldGalaxies * 0.35;
      fm.uQuench.value = st.quench;
      fm.uSfrBoost.value = st.sfrBoost;
      fm.uMinPx.value = Math.max(0.9, 1.05 * this.pixelRatio);
    }
    this.galaxyPoints.visible = hasParticles && st.galaxies > 0 && this.galaxyCount > 0;
    if (this.galaxyPoints.visible) {
      const gm = this.galaxyMat.uniforms;
      gm.uLumScale.value = gl * st.galaxies;
      gm.uSfrBoost.value = st.sfrBoost;
      gm.uMinPx.value = Math.max(1.0, 1.3 * this.pixelRatio);
    }
    this.outline.visible = hasParticles && st.outline > 0 && !st.wrap;
    if (this.outline.visible) {
      this.outline.scale.setScalar(boxW);
      this.outlineMat.color.setRGB(0.028 * st.outline, 0.026 * st.outline, 0.03 * st.outline);
    }
    if (cmbOn || this.compositeMesh.visible || this.fieldPoints.visible || this.galaxyPoints.visible || this.outline.visible) {
      r.setRenderTarget(target);
      r.render(this.hdrScene, camera);
    }
    r.setClearColor(tmpColor, clearAlpha);
  }

  /** Debug/tuning: set any accumulation or composite uniform by name. */
  tune(p: Record<string, number>): void {
    for (const [k, v] of Object.entries(p)) {
      if (k === 'bright' || k === 'galaxy') {
        this.look[k] = v;
        continue;
      }
      if (k === 'voidLo' || k === 'voidHi') {
        const f = this.accumMat.uniforms.uVoidFade.value as THREE.Vector2;
        if (k === 'voidLo') f.x = v;
        else f.y = v;
        continue;
      }
      if (k === 'thinRho' || k === 'thinExp' || k === 'thinMin') {
        const t = this.accumMat.uniforms.uThin.value as THREE.Vector3;
        if (k === 'thinRho') {
          t.x = v;
          this.thinPinned = true;
        }
        else if (k === 'thinExp') t.y = v;
        else t.z = this.thinMin = v;
        continue;
      }
      const u = this.accumMat.uniforms[k] ?? this.compositeMat.uniforms[k] ?? this.galaxyMat.uniforms[k];
      if (u) u.value = v;
    }
  }

  /** Debug: statistics of the accumulation and density targets (slow; GPU readback, never per frame). */
  debugStats(): Record<string, number | string> {
    const r = this.renderer;
    const read = (rt: THREE.WebGLRenderTarget) => {
      const w = rt.width, h = rt.height;
      const ch = rt.texture.format === THREE.RGBAFormat ? 4 : rt.texture.format === THREE.RGFormat ? 2 : 1;
      const t = rt.texture.type;
      const buf = t === THREE.FloatType ? new Float32Array(w * h * ch) : t === THREE.HalfFloatType ? new Uint16Array(w * h * ch) : new Uint8Array(w * h * ch);
      try {
        r.readRenderTargetPixels(rt, 0, 0, w, h, buf as Float32Array);
      } catch {
        return { mean: NaN, max: NaN, nz: NaN };
      }
      let sum = 0, max = 0, nz = 0;
      for (let i = 0; i < w * h; i++) {
        let v = buf[i * ch];
        if (buf instanceof Uint16Array) v = THREE.DataUtils.fromHalfFloat(v);
        else if (buf instanceof Uint8Array) v /= 255;
        sum += v;
        if (v > max) max = v;
        if (v > 0) nz++;
      }
      return { mean: sum / (w * h), max, nz: nz / (w * h) };
    };
    const a = read(this.accum);
    const d = read(this.atlasB);
    const u = this.accumMat.uniforms;
    return {
      accumMean: a.mean, accumMax: a.max, accumNZ: a.nz, densMean: d.mean, densMax: d.max, densNZ: d.nz,
      boundA: this.boundA, boundB: this.boundB, accumMode: this.accumMode, atlasMode: this.atlasMode,
      accW: this.accum.width, accH: this.accum.height, maxPointSize: this.maxPointSize,
      uFlux: u.uFlux.value, uMinPx: u.uMinPx.value, uMaxPx: u.uMaxPx.value, uFocal: this.shared.uFocalPx.value,
      uGain: u.uGain.value, uSpacing: u.uSpacing.value, uNear: this.shared.uNear.value, uBox: this.shared.uBoxWorld.value,
    };
  }

  dispose(): void {
    this.disposed = true;
    this.ready = false;
    const gl = this.renderer.getContext();
    for (const s of this.slots) {
      s.tex.dispose();
      gl.deleteTexture(s.gl);
    }
    this.atlasA.dispose();
    this.atlasB.dispose();
    this.accum.dispose();
    this.blurMat.dispose();
    this.compositeMat.dispose();
    this.depositMat.dispose();
    this.accumMat.dispose();
    this.replicaMat.dispose();
    this.galaxyMat.dispose();
    this.fieldMat.dispose();
    this.cmbMat.dispose();
    this.outlineMat.dispose();
    this.particleGeo.dispose();
    this.replicaGeo.dispose();
    this.fieldGeo.dispose();
    this.galaxyGeo.dispose();
    this.fsGeo.dispose();
    this.outline.geometry.dispose();
    this.cmbGeo.dispose();
  }
}
