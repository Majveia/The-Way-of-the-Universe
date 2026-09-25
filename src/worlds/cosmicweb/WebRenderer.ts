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

interface Slot {
  tex: THREE.DataTexture;
  data: Uint16Array;
  frame: number;
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
/** Importance thinning of sub-mean-density sprites: below ρ/ρ̄ = x keep (ρ/x)^y of them, at least z. */
const THIN = new THREE.Vector3(1.0, 1.0, 0.12);

const tmpColor = new THREE.Color();
const tmpSize = new THREE.Vector2();

export class WebRenderer {
  readonly opts: WebRendererOptions;
  private renderer: THREE.WebGLRenderer;
  private texW: number;
  private texH: number;
  private slots: Slot[];
  /** A keyframe pre-packed into upload layout ahead of time (see stage()). */
  private staged: { data: Uint16Array | null; frame: number; src: Uint16Array | null; i: number } = { data: null, frame: -1, src: null, i: 0 };
  /** Keyframe index currently bound as A and B. */
  private boundA = -1;
  private boundB = -1;
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
  private sizedFor = { w: 0, h: 0, pr: 0 };
  /** Screen-space pixel density (device px per CSS px of the target) for sprite sizes. */
  pixelRatio = 1;
  /** Composite brightness (× exposure) and galaxy brightness; tunable. */
  readonly look = { bright: 0.3, galaxy: 2.2e-4 };

  constructor(renderer: THREE.WebGLRenderer, opts: WebRendererOptions) {
    this.renderer = renderer;
    this.opts = opts;
    const N = opts.count;
    const gl = renderer.getContext();
    const range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array | null;
    this.maxPointSize = range && range[1] > 1 ? range[1] : 64;
    const fm = chooseFormats({
      colorBufferFloat: renderer.extensions.has('EXT_color_buffer_float'),
      colorBufferHalfFloat: renderer.extensions.has('EXT_color_buffer_half_float'),
      floatBlend: renderer.extensions.has('EXT_float_blend'),
    });
    // Keyframe textures.
    this.texW = N >= 1 << 21 ? 2048 : 1024;
    this.texH = Math.ceil(N / this.texW);
    // RGBA16UI (three's WebGL backend has no RGB integer upload path); xyz = position, w unused.
    this.slots = [0, 1].map(() => {
      const data = new Uint16Array(this.texW * this.texH * 4);
      const tex = new THREE.DataTexture(data, this.texW, this.texH, THREE.RGBAIntegerFormat, THREE.UnsignedShortType);
      tex.internalFormat = 'RGBA16UI';
      tex.minFilter = THREE.NearestFilter;
      tex.magFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
      tex.flipY = false;
      tex.unpackAlignment = 8;
      tex.needsUpdate = true;
      return { tex, data, frame: -1 };
    });
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
    const all = new Uint32Array(N);
    let nIdx = 0;
    for (let i = 0; i < N; i++) if (hash01(i, 9173) < frac) all[nIdx++] = i;
    const idx = all.slice(0, nIdx);
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
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
    });
    this.cmbGeo = new THREE.SphereGeometry(1, 96, 48);
    this.cmbMesh = new THREE.Mesh(this.cmbGeo, this.cmbMat);
    this.cmbMesh.frustumCulled = false;
    this.cmbMesh.renderOrder = 0;

    this.hdrScene.add(this.cmbMesh, this.compositeMesh, this.fieldPoints, this.galaxyPoints, this.outline);
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

  /** Is this target renderable on this device? (Bind it once and ask the driver.) */
  private complete(rt: THREE.WebGLRenderTarget): boolean {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    r.setRenderTarget(rt);
    const gl = r.getContext();
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    r.setRenderTarget(prev);
    return ok;
  }

  /** Point the A/B slots at two decoded keyframes (uploads only what changed). */
  setKeyframes(a: number, posA: Uint16Array, b: number, posB: Uint16Array): void {
    if (this.boundA === a && this.boundB === b) return;
    const s = this.slots;
    const find = (k: number) => (s[0].frame === k ? 0 : s[1].frame === k ? 1 : -1);
    let ia = find(a);
    let ib = find(b);
    if (ia < 0 && ib < 0) {
      ia = 0;
      ib = a === b ? 0 : 1;
      this.upload(ia, a, posA);
      if (ib !== ia) this.upload(ib, b, posB);
    } else if (ia < 0) {
      ia = ib === 0 ? 1 : 0;
      if (a === b) ia = ib;
      else this.upload(ia, a, posA);
    } else if (ib < 0) {
      ib = ia === 0 ? 1 : 0;
      if (a === b) ib = ia;
      else this.upload(ib, b, posB);
    }
    this.shared.uPosA.value = s[ia].tex;
    this.shared.uPosB.value = s[ib].tex;
    this.boundA = a;
    this.boundB = b;
    this.densityDirty = true;
  }

  private upload(slot: number, frame: number, pos: Uint16Array): void {
    const s = this.slots[slot];
    const g = this.staged;
    const n = Math.min(pos.length / 3, s.data.length / 4);
    if (g.data && g.frame === frame && g.src === pos && g.i >= n) {
      // Already packed during the previous frames: swap buffers, upload only.
      const t = s.data;
      s.data = g.data;
      g.data = t;
      g.frame = -1;
      g.src = null;
      (s.tex.image as { data: Uint16Array }).data = s.data;
    } else {
      const d = s.data;
      for (let i = 0, j = 0, k = 0; i < n; i++, j += 3, k += 4) {
        d[k] = pos[j];
        d[k + 1] = pos[j + 1];
        d[k + 2] = pos[j + 2];
      }
    }
    s.tex.needsUpdate = true;
    s.frame = frame;
  }

  /**
   * Pack keyframe `frame` (decoded positions `pos`) into upload layout, at most `budget` particles
   * per call. Called once per frame while playback approaches it, so the switch costs only the
   * GPU upload. Returns true when the frame is ready (or already resident).
   */
  stage(frame: number, pos: Uint16Array, budget: number): boolean {
    if (this.slots[0].frame === frame || this.slots[1].frame === frame) return true;
    const g = this.staged;
    g.data ??= new Uint16Array(this.texW * this.texH * 4);
    if (g.frame !== frame || g.src !== pos) {
      g.frame = frame;
      g.src = pos;
      g.i = 0;
    }
    const d = g.data;
    const n = Math.min(pos.length / 3, d.length / 4);
    const end = Math.min(n, g.i + budget);
    for (let i = g.i, j = 3 * g.i, k = 4 * g.i; i < end; i++, j += 3, k += 4) {
      d[k] = pos[j];
      d[k + 1] = pos[j + 1];
      d[k + 2] = pos[j + 2];
    }
    g.i = end;
    return end >= n;
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
    const s = accumScaleFor(this.opts.detail, this.pixelRatio);
    const aw = Math.max(1, Math.round(this.targetW * s)), ah = Math.max(1, Math.round(this.targetH * s));
    if (aw !== this.accum.width || ah !== this.accum.height) this.accum.setSize(aw, ah);
    this.sizedFor.w = width;
    this.sizedFor.h = height;
    this.sizedFor.pr = this.pixelRatio;
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

  /** Render the web into `target` (linear HDR, already cleared) with `camera`. */
  render(target: THREE.WebGLRenderTarget | null, camera: THREE.PerspectiveCamera, st: WebFrameState, hasParticles: boolean): void {
    const r = this.renderer;
    const S = this.shared;
    // Follow the target (dynamic resolution) and the pixel density.
    const tw = target ? target.width : r.getDrawingBufferSize(tmpSize).x;
    const th = target ? target.height : tmpSize.y;
    const z = this.sizedFor;
    if (tw !== z.w || th !== z.h || this.pixelRatio !== z.pr) this.resize(tw, th);
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
        if (k === 'thinRho') t.x = v;
        else if (k === 'thinExp') t.y = v;
        else t.z = v;
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
    for (const s of this.slots) s.tex.dispose();
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
