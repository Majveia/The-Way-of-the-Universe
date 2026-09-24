/**
 * GPU renderer for the cosmic web (module: cosmos).
 *
 * Passes per frame (all additive, linear HDR, no depth buffer):
 *   1. density   — particles NGP-deposited into a G³ grid tiled in a 2D atlas, then a separable
 *                  periodic Gaussian blur → local ρ/ρ̄ for colour and adaptive smoothing lengths.
 *   2. accum     — every particle as an energy-normalised sprite with SPH-like smoothing length
 *                  h ∝ (ρ/ρ̄)^(−1/3); channels Σw (projected density) and Σw·log10ρ.
 *   3. composite — asinh stretch of the projected density, hue from the mean log density.
 *   4. galaxies  — resolved halo galaxies and sub-resolution field galaxies as point sources.
 * Positions come from two RGBA16UI keyframe textures and are interpolated in the vertex shaders.
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

const tmpV = new THREE.Vector3();

/** Pure additive blending (ONE, ONE): three's AdditiveBlending multiplies by source alpha. */
const ADDITIVE = {
  blending: THREE.CustomBlending,
  blendEquation: THREE.AddEquation,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneFactor,
  blendSrcAlpha: THREE.OneFactor,
  blendDstAlpha: THREE.OneFactor,
} as const;

export class WebRenderer {
  readonly opts: WebRendererOptions;
  private renderer: THREE.WebGLRenderer;
  private texW: number;
  private texH: number;
  private slots: Slot[];
  /** Keyframe index currently bound as A and B. */
  private boundA = -1;
  private boundB = -1;
  // Density atlas
  readonly grid: number;
  private tilesX: number;
  private tilesY: number;
  private atlasA: THREE.WebGLRenderTarget;
  private atlasB: THREE.WebGLRenderTarget;
  private blurMat: THREE.ShaderMaterial;
  private quad = new FullscreenQuad();
  // Accumulation
  private accum: THREE.WebGLRenderTarget;
  private accumScale: number;
  private compositeMat: THREE.ShaderMaterial;
  // Scenes
  private depositScene = new THREE.Scene();
  private accumScene = new THREE.Scene();
  private galaxyScene = new THREE.Scene();
  private fieldScene = new THREE.Scene();
  private outlineScene = new THREE.Scene();
  private cmbScene = new THREE.Scene();
  private depositMat: THREE.ShaderMaterial;
  private accumMat: THREE.ShaderMaterial;
  private galaxyMat: THREE.ShaderMaterial;
  private fieldMat: THREE.ShaderMaterial;
  private cmbMat: THREE.ShaderMaterial;
  private outlineMat: THREE.LineBasicMaterial;
  private particleGeo: THREE.BufferGeometry;
  private fieldGeo: THREE.BufferGeometry;
  private galaxyGeo: THREE.BufferGeometry;
  private accumPoints: THREE.Points;
  private galaxyPoints: THREE.Points;
  private outline: THREE.LineSegments;
  private orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private shared: Record<string, THREE.IUniform>;
  private galaxyCount = 0;
  private fieldCount = 0;
  private floatBlend: boolean;
  private densityDirty = true;
  private lastDensityKey = '';
  /** Screen-space pixel density for sprite sizes. */
  pixelRatio = 1;
  /** Composite brightness (× exposure) and galaxy brightness; tunable. */
  readonly look = { bright: 0.3, galaxy: 2.2e-4 };

  constructor(renderer: THREE.WebGLRenderer, opts: WebRendererOptions) {
    this.renderer = renderer;
    this.opts = opts;
    const N = opts.count;
    this.floatBlend = renderer.extensions.has('EXT_float_blend');
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
    const atlasOpts = {
      type: this.floatBlend ? THREE.FloatType : THREE.HalfFloatType,
      format: THREE.RedFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    } as const;
    this.atlasA = new THREE.WebGLRenderTarget(this.tilesX * G, this.tilesY * G, atlasOpts);
    this.atlasB = new THREE.WebGLRenderTarget(this.tilesX * G, this.tilesY * G, atlasOpts);
    this.accumScale = opts.detail >= 1 ? 1 : opts.detail >= 0.6 ? 0.85 : 0.7;
    this.accum = new THREE.WebGLRenderTarget(1, 1, {
      type: this.floatBlend ? THREE.FloatType : THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });

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
        uWeight: { value: (G * G * G) / N },
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

    this.accumMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: ACCUM_VERT,
      fragmentShader: ACCUM_FRAG,
      uniforms: {
        ...S,
        uSpacing: { value: opts.boxWorld / opts.np },
        uSmooth: { value: 1.1 },
        uMinPx: { value: 1.25 },
        uMaxPx: { value: 90 },
        uFlux: { value: 1 },
        uStride: { value: 1 },
        uStrideOffset: { value: 0 },
        uGain: { value: 1 },
        uEmit: { value: 1.0 },
      },
      ...ADDITIVE,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    this.accumPoints = new THREE.Points(this.particleGeo, this.accumMat);
    this.accumPoints.frustumCulled = false;
    this.accumScene.add(this.accumPoints);

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
      },
      ...ADDITIVE,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });

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
    this.galaxyScene.add(this.galaxyPoints);

    // Field galaxies: a fixed random subset of particles (index buffer over the particle attributes).
    const frac = Math.min(1, 0.05 * Math.pow(128 / opts.np, 3) * Math.max(0.6, opts.detail));
    const idx: number[] = [];
    for (let i = 0; i < N; i++) if (hash01(i, 9173) < frac) idx.push(i);
    this.fieldCount = idx.length;
    this.fieldGeo = new THREE.BufferGeometry();
    this.fieldGeo.setAttribute('aDelta', this.particleGeo.getAttribute('aDelta'));
    this.fieldGeo.setIndex(new THREE.BufferAttribute(Uint32Array.from(idx), 1));
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
        uCount: { value: idx.length / N },
      },
      ...ADDITIVE,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    const field = new THREE.Points(this.fieldGeo, this.fieldMat);
    field.frustumCulled = false;
    this.fieldScene.add(field);

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
    this.outlineScene.add(this.outline);

    // Primordial fireball / CMB sky.
    this.cmbMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: CMB_VERT,
      fragmentShader: CMB_FRAG,
      uniforms: { uT: { value: 3000 }, uRadiance: { value: 1 }, uAniso: { value: 0 }, uSeed: { value: 17.3 } },
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
    });
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 48), this.cmbMat);
    sphere.frustumCulled = false;
    this.cmbScene.add(sphere);
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
    const d = s.data;
    const n = Math.min(pos.length / 3, d.length / 4);
    for (let i = 0, j = 0, k = 0; i < n; i++, j += 3, k += 4) {
      d[k] = pos[j];
      d[k + 1] = pos[j + 1];
      d[k + 2] = pos[j + 2];
    }
    s.tex.needsUpdate = true;
    s.frame = frame;
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
    const seen = new Set<number>();
    const hostA: number[] = [], hostB: number[] = [], lum: number[] = [], blue: number[] = [], seed: number[] = [];
    const L = (m: number) => Math.pow(Math.max(m, 1e6) / 1e10, 0.75);
    for (let i = 0; i < a.count; i++) {
      const id = a.id[i];
      const j = idxB.get(id);
      seen.add(id);
      hostA.push(a.host[i]);
      hostB.push(j !== undefined ? b.host[j] : a.host[i]);
      lum.push(L(a.mstar[i]), j !== undefined ? L(b.mstar[j]) : 0);
      blue.push(a.blue[i], j !== undefined ? b.blue[j] : a.blue[i]);
      seed.push(hash01(id, 31));
    }
    for (let j = 0; j < b.count; j++) {
      if (seen.has(b.id[j])) continue;
      hostA.push(b.host[j]);
      hostB.push(b.host[j]);
      lum.push(0, L(b.mstar[j]));
      blue.push(b.blue[j], b.blue[j]);
      seed.push(hash01(b.id[j], 31));
    }
    const n = hostA.length;
    const g = this.galaxyGeo;
    g.setAttribute('aHostA', new THREE.BufferAttribute(Float32Array.from(hostA), 1));
    g.setAttribute('aHostB', new THREE.BufferAttribute(Float32Array.from(hostB), 1));
    g.setAttribute('aLum', new THREE.BufferAttribute(Float32Array.from(lum), 2));
    g.setAttribute('aBlue', new THREE.BufferAttribute(Float32Array.from(blue), 2));
    g.setAttribute('aSeed', new THREE.BufferAttribute(Float32Array.from(seed), 1));
    g.setDrawRange(0, n);
    this.galaxyCount = n;
  }

  /** Size of the accumulation target (pixels). */
  get accumSize(): { width: number; height: number } {
    return { width: this.accum.width, height: this.accum.height };
  }

  resize(width: number, height: number): void {
    this.accum.setSize(Math.max(1, Math.round(width * this.accumScale)), Math.max(1, Math.round(height * this.accumScale)));
  }

  /** Build the density atlas for the current interpolated positions. */
  private density(): void {
    const r = this.renderer;
    r.setRenderTarget(this.atlasA);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    r.render(this.depositScene, this.orthoCam);
    // x, y, z blur passes (A → B → A → B), result in B … keep it simple: 3 passes, final in atlasB.
    const passes: Array<[THREE.WebGLRenderTarget, THREE.WebGLRenderTarget, number]> = [
      [this.atlasA, this.atlasB, 0],
      [this.atlasB, this.atlasA, 1],
      [this.atlasA, this.atlasB, 2],
    ];
    this.quad.material = this.blurMat;
    for (const [src, dst, axis] of passes) {
      this.blurMat.uniforms.tSrc.value = src.texture;
      this.blurMat.uniforms.uAxis.value = axis;
      this.quad.render(r, dst);
    }
    this.shared.uDensity.value = this.atlasB.texture;
  }

  /** Render the web into `target` (linear HDR, already cleared) with `camera`. */
  render(target: THREE.WebGLRenderTarget | null, camera: THREE.PerspectiveCamera, st: WebFrameState, hasParticles: boolean): void {
    const r = this.renderer;
    const S = this.shared;
    // Primordial glow first (background at infinity).
    if (st.cmb && st.cmb.radiance > 1e-5) {
      this.cmbMat.uniforms.uT.value = st.cmb.T;
      this.cmbMat.uniforms.uRadiance.value = st.cmb.radiance;
      this.cmbMat.uniforms.uAniso.value = st.cmb.aniso;
      const pos = tmpV.copy(camera.position);
      camera.position.set(0, 0, 0);
      camera.updateMatrixWorld();
      r.setRenderTarget(target);
      r.render(this.cmbScene, camera);
      camera.position.copy(pos);
      camera.updateMatrixWorld();
    }
    if (!hasParticles) return;
    S.uMix.value = st.mix;
    S.uZA.value = st.za;
    S.uBoxWorld.value = this.opts.boxWorld * st.scale;
    S.uWrap.value = st.wrap ? 1 : 0;
    (S.uWrapCenter.value as THREE.Vector3).copy(st.wrapCenter);
    S.uFadeFar.value = st.fadeFar;
    S.uNear.value = camera.near * 2;
    const slab = S.uSlab.value as THREE.Vector4;
    if (st.slab) {
      slab.set(st.slab.axis.x, st.slab.axis.y, st.slab.axis.z, st.slab.half);
      S.uSlabCenter.value = st.slab.center;
    } else slab.w = 0;
    // Focal length in pixels of the accumulation target.
    const h = this.accum.height;
    const focal = h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    S.uFocalPx.value = focal;

    // 1. density
    const key = `${this.boundA}|${this.boundB}|${st.mix.toFixed(5)}|${st.za.toFixed(5)}`;
    if (this.densityDirty || key !== this.lastDensityKey) {
      this.density();
      this.lastDensityKey = key;
      this.densityDirty = false;
    }

    // 2. accumulate dark-matter light
    const N = this.opts.count;
    const boxW = this.opts.boxWorld * st.scale;
    const am = this.accumMat.uniforms;
    am.uSpacing.value = boxW / this.opts.np;
    // uFlux = f² L² / N: a path through the whole box at mean density accumulates ≈ 1.
    am.uFlux.value = (focal * focal * boxW * boxW) / N;
    am.uMinPx.value = Math.max(0.9, 1.1 * this.accumScale * this.pixelRatio);
    am.uMaxPx.value = 0.12 * h;
    am.uGain.value = st.darkMatter;
    r.setRenderTarget(this.accum);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    if (st.darkMatter > 0) {
      am.uStride.value = 1;
      am.uStrideOffset.value = 0;
      (S.uOffset.value as THREE.Vector3).set(0, 0, 0);
      this.particleGeo.setDrawRange(0, N);
      r.render(this.accumScene, camera);
      if (st.replicas > 0 && !st.wrap && !st.slab) {
        // Neighbouring periodic images, sparsely sampled and faint.
        const stride = N > 1e6 ? 16 : N > 3e5 ? 8 : 4;
        am.uStride.value = stride;
        am.uGain.value = st.darkMatter * st.replicas * stride;
        this.particleGeo.setDrawRange(0, Math.floor(N / stride));
        for (let x = -1; x <= 1; x++)
          for (let y = -1; y <= 1; y++)
            for (let z = -1; z <= 1; z++) {
              if (!x && !y && !z) continue;
              (S.uOffset.value as THREE.Vector3).set(x, y, z);
              am.uStrideOffset.value = (x + 2 * y + 3 * z + 12) % stride;
              r.render(this.accumScene, camera);
            }
        (S.uOffset.value as THREE.Vector3).set(0, 0, 0);
        this.particleGeo.setDrawRange(0, N);
        am.uStride.value = 1;
        am.uStrideOffset.value = 0;
      }
    }

    // 3. composite into the HDR target
    const cm = this.compositeMat.uniforms;
    cm.uBright.value = this.look.bright * st.exposure;
    this.quad.material = this.compositeMat;
    this.quad.render(r, target);

    // 4. galaxies (point sources, straight into HDR)
    const gl = focal * focal * this.look.galaxy * st.exposure;
    if (st.fieldGalaxies > 0 && this.fieldCount > 0) {
      const fm = this.fieldMat.uniforms;
      fm.uD.value = st.D;
      fm.uLumScale.value = gl * st.fieldGalaxies * 0.35;
      fm.uQuench.value = st.quench;
      fm.uSfrBoost.value = st.sfrBoost;
      fm.uMinPx.value = Math.max(0.9, 1.05 * this.pixelRatio);
      r.setRenderTarget(target);
      r.render(this.fieldScene, camera);
    }
    if (st.galaxies > 0 && this.galaxyCount > 0) {
      const gm = this.galaxyMat.uniforms;
      gm.uLumScale.value = gl * st.galaxies;
      gm.uSfrBoost.value = st.sfrBoost;
      gm.uMinPx.value = Math.max(1.0, 1.3 * this.pixelRatio);
      r.setRenderTarget(target);
      r.render(this.galaxyScene, camera);
    }

    // 5. box outline
    if (st.outline > 0 && !st.wrap) {
      this.outline.scale.setScalar(boxW);
      this.outline.updateMatrixWorld();
      this.outlineMat.color.setRGB(0.028 * st.outline, 0.026 * st.outline, 0.03 * st.outline);
      r.setRenderTarget(target);
      r.render(this.outlineScene, camera);
    }
  }

  /** Debug/tuning: set any accumulation or composite uniform by name. */
  tune(p: Record<string, number>): void {
    for (const [k, v] of Object.entries(p)) {
      if (k === 'bright' || k === 'galaxy') {
        this.look[k] = v;
        continue;
      }
      const u = this.accumMat.uniforms[k] ?? this.compositeMat.uniforms[k] ?? this.galaxyMat.uniforms[k];
      if (u) u.value = v;
    }
  }

  /** Debug: statistics of the accumulation and density targets (slow; GPU readback). */
  debugStats(): Record<string, number> {
    const r = this.renderer;
    const read = (rt: THREE.WebGLRenderTarget, ch: number) => {
      const w = rt.width, h = rt.height;
      const buf = rt.texture.type === THREE.FloatType ? new Float32Array(w * h * ch) : new Uint16Array(w * h * ch);
      r.readRenderTargetPixels(rt, 0, 0, w, h, buf as Float32Array);
      let sum = 0, max = 0, nz = 0;
      for (let i = 0; i < w * h; i++) {
        let v = buf[i * ch];
        if (buf instanceof Uint16Array) v = THREE.DataUtils.fromHalfFloat(v);
        sum += v;
        if (v > max) max = v;
        if (v > 0) nz++;
      }
      return { mean: sum / (w * h), max, nz: nz / (w * h) };
    };
    const a = read(this.accum, 4);
    const d = read(this.atlasB, 1);
    const u = this.accumMat.uniforms;
    return {
      accumMean: a.mean, accumMax: a.max, accumNZ: a.nz, densMean: d.mean, densMax: d.max, densNZ: d.nz,
      boundA: this.boundA, boundB: this.boundB, float: this.floatBlend ? 1 : 0,
      accW: this.accum.width, accH: this.accum.height,
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
    this.galaxyMat.dispose();
    this.fieldMat.dispose();
    this.cmbMat.dispose();
    this.outlineMat.dispose();
    this.particleGeo.dispose();
    this.fieldGeo.dispose();
    this.galaxyGeo.dispose();
    this.outline.geometry.dispose();
    (this.cmbScene.children[0] as THREE.Mesh).geometry.dispose();
  }
}
