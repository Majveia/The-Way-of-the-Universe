import * as THREE from 'three';
import { FullscreenQuad, FULLSCREEN_VERT } from './FullscreenQuad';

export type ToneMap = 'aces' | 'agx' | 'agx-punchy' | 'linear';

/**
 * The single, shared "look" of the project. Every experience renders linear HDR
 * radiance into Engine.hdr; this pass turns it into display pixels.
 * Tuned for OLED: black stays exactly (0,0,0) — no lifted blacks, no grain on black,
 * dither only where there is signal.
 */
export interface PostSettings {
  /** Linear exposure multiplier applied before tone mapping. */
  exposure: number;
  /** 0..1 fraction of energy redistributed into the bloom halo (energy conserving mix). */
  bloomStrength: number;
  /** 0..1 how far bloom spreads into the large, soft mip levels. */
  bloomRadius: number;
  tonemap: ToneMap;
  /** Linear-light saturation around luminance (1 = unchanged). */
  saturation: number;
  /** 0..1 corner darkening. */
  vignette: number;
  /** Radial chromatic aberration in uv units at the corners (0 = off, 0.002 subtle). */
  chromaticAberration: number;
  /** Global fade (0 = black, 1 = visible). Driven by the App for transitions. */
  fade: number;
}

export const defaultPostSettings = (): PostSettings => ({
  exposure: 1,
  bloomStrength: 0.05,
  bloomRadius: 0.8,
  tonemap: 'aces',
  saturation: 1,
  vignette: 0.15,
  chromaticAberration: 0,
  fade: 1,
});

const DOWNSAMPLE_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D tSrc;
uniform vec2 srcTexel;
uniform bool karis;
vec3 s(vec2 o) { return min(texture(tSrc, vUv + o * srcTexel).rgb, vec3(6.0e4)); }
float kw(vec3 c) { return 1.0 / (1.0 + max(max(c.r, c.g), c.b)); }
void main() {
  // 13-tap downsample (Jimenez 2014, "Next generation post processing in Call of Duty: AW").
  vec3 a = s(vec2(-2.0, 2.0)), b = s(vec2(0.0, 2.0)), c = s(vec2(2.0, 2.0));
  vec3 d = s(vec2(-2.0, 0.0)), e = s(vec2(0.0, 0.0)), f = s(vec2(2.0, 0.0));
  vec3 g = s(vec2(-2.0, -2.0)), h = s(vec2(0.0, -2.0)), i = s(vec2(2.0, -2.0));
  vec3 j = s(vec2(-1.0, 1.0)), k = s(vec2(1.0, 1.0)), l = s(vec2(-1.0, -1.0)), m = s(vec2(1.0, -1.0));
  vec3 col;
  if (karis) {
    // Karis average on the first mip suppresses fireflies from sub-pixel stars.
    vec3 g0 = (a + b + d + e) * 0.25, g1 = (b + c + e + f) * 0.25;
    vec3 g2 = (d + e + g + h) * 0.25, g3 = (e + f + h + i) * 0.25;
    vec3 g4 = (j + k + l + m) * 0.25;
    float w0 = kw(g0) * 0.125, w1 = kw(g1) * 0.125, w2 = kw(g2) * 0.125, w3 = kw(g3) * 0.125, w4 = kw(g4) * 0.5;
    col = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
  } else {
    col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  }
  outColor = vec4(col, 1.0);
}`;

const UPSAMPLE_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D tSrc;
uniform vec2 srcTexel;
uniform float weight;
vec3 s(vec2 o) { return texture(tSrc, vUv + o * srcTexel).rgb; }
void main() {
  // 3x3 tent filter; result is added onto the next-larger mip.
  vec3 col = s(vec2(0.0)) * 4.0
    + (s(vec2(-1.0, 0.0)) + s(vec2(1.0, 0.0)) + s(vec2(0.0, -1.0)) + s(vec2(0.0, 1.0))) * 2.0
    + (s(vec2(-1.0, -1.0)) + s(vec2(1.0, -1.0)) + s(vec2(-1.0, 1.0)) + s(vec2(1.0, 1.0)));
  outColor = vec4(col * (weight / 16.0), 1.0);
}`;

const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform float bloomStrength;
uniform float bloomNorm;
uniform float exposure;
uniform float saturation;
uniform float vignette;
uniform float chromatic;
uniform float fade;
uniform float time;
uniform int tonemap;
uniform vec2 resolution;

// ACES filmic fit (Stephen Hill), matrices column-major.
const mat3 ACESIn = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
const mat3 ACESOut = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
vec3 rrtOdt(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 aces(vec3 c) { return clamp(ACESOut * rrtOdt(ACESIn * (c / 0.6)), 0.0, 1.0); }

// AgX (Troy Sobotka), as ported in three.js; optional "punchy" look.
const mat3 SRGB_TO_2020 = mat3(0.6274, 0.0691, 0.0164, 0.3293, 0.9195, 0.0880, 0.0433, 0.0113, 0.8956);
const mat3 R2020_TO_SRGB = mat3(1.6605, -0.1246, -0.0182, -0.5876, 1.1329, -0.1006, -0.0728, -0.0083, 1.1187);
vec3 agxContrast(vec3 x) {
  vec3 x2 = x * x; vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
vec3 agx(vec3 color, bool punchy) {
  const mat3 inset = mat3(vec3(0.856627153315983, 0.137318972929847, 0.11189821299995),
                          vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
                          vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
  const mat3 outset = mat3(vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
                           vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
                           vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
  const float minEv = -12.47393, maxEv = 4.026069;
  color = inset * (SRGB_TO_2020 * color);
  color = clamp((log2(max(color, 1e-10)) - minEv) / (maxEv - minEv), 0.0, 1.0);
  color = agxContrast(color);
  if (punchy) {
    float l = dot(color, vec3(0.2126, 0.7152, 0.0722));
    color = pow(max(color, 0.0), vec3(1.35));
    color = l + 1.4 * (color - l);
  }
  color = outset * color;
  color = pow(max(vec3(0.0), color), vec3(2.2));
  return clamp(R2020_TO_SRGB * color, 0.0, 1.0);
}

vec3 toSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
float rand(vec2 co) { return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec3 hdr;
  if (chromatic > 0.0) {
    vec2 d = vUv - 0.5;
    float k = chromatic * dot(d, d) * 4.0;
    hdr = vec3(texture(tScene, vUv - d * k).r, texture(tScene, vUv).g, texture(tScene, vUv + d * k).b);
  } else {
    hdr = texture(tScene, vUv).rgb;
  }
  vec3 bloom = texture(tBloom, vUv).rgb * bloomNorm;
  vec3 c = mix(hdr, bloom, bloomStrength) * exposure;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = max(l + saturation * (c - l), 0.0);
  if (tonemap == 0) c = aces(c);
  else if (tonemap == 1) c = agx(c, false);
  else if (tonemap == 2) c = agx(c, true);
  else c = clamp(c, 0.0, 1.0);
  vec2 p = (vUv - 0.5) * vec2(resolution.x / resolution.y, 1.0);
  float r2 = dot(p, p) / (0.25 * (resolution.x * resolution.x / (resolution.y * resolution.y)) + 0.25);
  c *= 1.0 - vignette * r2 * r2;
  c *= fade;
  vec3 s = toSRGB(clamp(c, 0.0, 1.0));
  // Triangular dither, disabled on true black so OLED blacks stay off.
  float m = max(s.r, max(s.g, s.b));
  float n = rand(gl_FragCoord.xy + fract(time) * 17.0) + rand(gl_FragCoord.xy + fract(time * 1.37) * 23.0 + 0.59) - 1.0;
  s += step(0.5 / 255.0, m) * n / 255.0;
  outColor = vec4(s, 1.0);
}`;

const TONEMAP_ID: Record<ToneMap, number> = { aces: 0, agx: 1, 'agx-punchy': 2, linear: 3 };

function makeTarget(w: number, h: number): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
}

/** Physically based mip-chain bloom + tone mapping + dithering. */
export class Post {
  settings: PostSettings = defaultPostSettings();
  private mips: THREE.WebGLRenderTarget[] = [];
  private quad = new FullscreenQuad();
  private down: THREE.ShaderMaterial;
  private up: THREE.ShaderMaterial;
  private composite: THREE.ShaderMaterial;
  private width = 1;
  private height = 1;

  constructor(private renderer: THREE.WebGLRenderer) {
    const common = { vertexShader: FULLSCREEN_VERT, glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false };
    this.down = new THREE.ShaderMaterial({
      ...common,
      fragmentShader: DOWNSAMPLE_FRAG,
      uniforms: { tSrc: { value: null }, srcTexel: { value: new THREE.Vector2() }, karis: { value: false } },
    });
    this.up = new THREE.ShaderMaterial({
      ...common,
      fragmentShader: UPSAMPLE_FRAG,
      blending: THREE.AdditiveBlending,
      uniforms: { tSrc: { value: null }, srcTexel: { value: new THREE.Vector2() }, weight: { value: 1 } },
    });
    this.composite = new THREE.ShaderMaterial({
      ...common,
      fragmentShader: COMPOSITE_FRAG,
      uniforms: {
        tScene: { value: null },
        tBloom: { value: null },
        bloomStrength: { value: 0 },
        bloomNorm: { value: 1 },
        exposure: { value: 1 },
        saturation: { value: 1 },
        vignette: { value: 0 },
        chromatic: { value: 0 },
        fade: { value: 1 },
        time: { value: 0 },
        tonemap: { value: 0 },
        resolution: { value: new THREE.Vector2(1, 1) },
      },
    });
  }

  setSize(width: number, height: number): void {
    if (width === this.width && height === this.height && this.mips.length) return;
    this.width = width;
    this.height = height;
    for (const m of this.mips) m.dispose();
    this.mips = [];
    let w = width;
    let h = height;
    const levels = Math.max(1, Math.min(7, Math.floor(Math.log2(Math.min(width, height))) - 2));
    for (let i = 0; i < levels; i++) {
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
      this.mips.push(makeTarget(w, h));
    }
  }

  /** Bloom + tone map `src` (linear HDR) to the canvas. */
  render(src: THREE.WebGLRenderTarget, time: number): void {
    const r = this.renderer;
    const s = this.settings;
    const useBloom = s.bloomStrength > 0 && this.mips.length > 0;
    let norm = 1;
    if (useBloom) {
      // Downsample chain.
      let prev: THREE.Texture = src.texture;
      let pw = src.width;
      let ph = src.height;
      this.quad.material = this.down;
      for (let i = 0; i < this.mips.length; i++) {
        const u = this.down.uniforms;
        u.tSrc.value = prev;
        u.srcTexel.value.set(1 / pw, 1 / ph);
        u.karis.value = i === 0;
        this.quad.render(r, this.mips[i]);
        prev = this.mips[i].texture;
        pw = this.mips[i].width;
        ph = this.mips[i].height;
      }
      // Upsample and accumulate: mip[i-1] += tent(mip[i]) * radius.
      this.quad.material = this.up;
      const wgt = THREE.MathUtils.clamp(s.bloomRadius, 0, 1);
      for (let i = this.mips.length - 1; i > 0; i--) {
        const u = this.up.uniforms;
        u.tSrc.value = this.mips[i].texture;
        u.srcTexel.value.set(1 / this.mips[i].width, 1 / this.mips[i].height);
        u.weight.value = wgt;
        this.quad.render(r, this.mips[i - 1]);
      }
      // Normalise the geometric sum 1 + w + w^2 + ... so strength stays meaningful.
      let sum = 0;
      for (let i = 0; i < this.mips.length; i++) sum += Math.pow(wgt, i);
      norm = 1 / sum;
    }
    const u = this.composite.uniforms;
    u.tScene.value = src.texture;
    u.tBloom.value = useBloom ? this.mips[0].texture : src.texture;
    u.bloomStrength.value = useBloom ? s.bloomStrength : 0;
    u.bloomNorm.value = norm;
    u.exposure.value = s.exposure;
    u.saturation.value = s.saturation;
    u.vignette.value = s.vignette;
    u.chromatic.value = s.chromaticAberration;
    u.fade.value = s.fade;
    u.time.value = time;
    u.tonemap.value = TONEMAP_ID[s.tonemap] ?? 0;
    u.resolution.value.set(this.width, this.height);
    this.quad.material = this.composite;
    this.quad.render(r, null);
  }

  dispose(): void {
    for (const m of this.mips) m.dispose();
    this.down.dispose();
    this.up.dispose();
    this.composite.dispose();
  }
}
