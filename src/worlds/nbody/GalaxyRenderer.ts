import * as THREE from 'three';
import { FULLSCREEN_VERT, FullscreenQuad } from '../../core/post/FullscreenQuad';
import { BLACKBODY_GLSL } from '../../shaders/lib/blackbody';
import { COMMON_GLSL } from '../../shaders/lib/common';
import { TRACER_WIDTH, SKELETON_WIDTH, type ScenarioData } from './scenario';
import { SF_EFFICIENCY } from './starformation';
import { blackbodyRGB } from '../../physics/blackbody';
import { ADD_ONE_ONE } from './NBodySystem';

/**
 * Renders a galaxy-collision system as light, the way a deep telescope image records it.
 *
 * Every tracer is a star cluster of ~10⁵ M☉. Its light is split in two:
 *  • DIFFUSE (1 − f★): deposited as a single texel into a half-resolution HDR buffer whose alpha
 *    counts particles. After mip-mapping, each screen pixel reads the finest pyramid level whose
 *    texel holds ≥ N_ngb particles — adaptive kernel smoothing (the screen-space analogue of an SPH
 *    smoothing length) at the cost of one point per particle. Mip averages conserve surface
 *    brightness, so the smooth glow is photometrically exact at every level.
 *  • RESOLVED (f★): a sub-pixel Gaussian point at full resolution — the granular sparkle of
 *    clusters that a real image of a nearby tail resolves. Points are energy-normalised and move
 *    continuously across pixels, so they fade rather than flicker.
 * Gas parcels deposit dust optical depth into 8 view-depth slices (a deep opacity map, Yuksel &
 * Keyser 2008) in a quarter-resolution, mip-smoothed buffer; stars are dimmed and reddened by the
 * dust in front of them. Young clusters and their HII regions (from each gas parcel's latest
 * star-formation burst) are drawn as sprites in dust-reddened Balmer + [NII] light.
 * Optional: the live dark-matter halo particles through the same adaptive pyramid, in violet.
 *
 * Photometry: particle luminosity L = M / (M/L)(age) with M/L ≈ 3 (t/10 Gyr)^0.8 (V band, a fit to
 * Bruzual & Charlot 2003 SSPs); colour a blackbody at T ≈ 4500 K (t/10 Gyr)^−0.18. Pixel values are
 * surface brightness in 10¹⁰ L☉ kpc⁻² × exposure, independent of distance (as for real extended
 * sources). Dust: τ_V = κ Σ_gas with κ ≈ 470 (10¹⁰ M☉ kpc⁻²)⁻¹, i.e. A_V/N_H = 1/1.9×10²¹ cm⁻²
 * (Bohlin et al. 1978) at solar metallicity; A_λ/A_V = 0.91, 1.00, 1.29 for R, G, B (Cardelli
 * et al. 1989).
 */

const PARTICLE_GLSL = /* glsl */ `
uniform sampler2D tPos;
uniform sampler2D tVel;
uniform sampler2D tAttr;
uniform int uWidth;
uniform float uTime;
uniform float uExtrap;
uniform float uProj;
vec4 P_pos;
vec4 P_attr;
vec3 particleWorld() {
  int id = gl_VertexID;
  ivec2 t = ivec2(id % uWidth, id / uWidth);
  P_pos = texelFetch(tPos, t, 0);
  P_attr = texelFetch(tAttr, t, 0);
  vec3 v = texelFetch(tVel, t, 0).xyz;
  return P_pos.xyz + v * uExtrap;
}
float massToLight(float ageMyr) {
  return 3.0 * pow(clamp(ageMyr, 3.0, 13000.0) / 10000.0, 0.8);
}
float popTemp(float ageMyr) {
  return clamp(4500.0 * pow(clamp(ageMyr, 3.0, 13000.0) / 10000.0, -0.18), 3500.0, 30000.0);
}
void offscreen() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; }
// White balance: the integrated light of an average spiral (≈ 5300 K) maps to neutral white, the
// reference astronomers use for photometric colour calibration of galaxy images.
uniform vec3 uWhite;
vec3 wb(vec3 c) { return c * uWhite; }
`;

const DUST_READ_GLSL = /* glsl */ `
uniform sampler2D tDust0;
uniform sampler2D tDust1;
uniform float uDepth0;
uniform float uDepthStep;
uniform float uDustOn;
uniform float uDustLod;
uniform vec2 uDustTexel;
// V-band optical depth in front of view depth z at screen uv.
float tauAt(vec2 uv, float z) {
  if (uDustOn < 0.5) return 0.0;
  // 4-tap tent at the chosen level: smooth, block-free column densities.
  vec2 o = uDustTexel * exp2(floor(uDustLod)) * 0.5;
  vec4 a = 0.25 * (textureLod(tDust0, uv + o, uDustLod) + textureLod(tDust0, uv - o, uDustLod)
    + textureLod(tDust0, uv + vec2(o.x, -o.y), uDustLod) + textureLod(tDust0, uv + vec2(-o.x, o.y), uDustLod));
  vec4 b = 0.25 * (textureLod(tDust1, uv + o, uDustLod) + textureLod(tDust1, uv - o, uDustLod)
    + textureLod(tDust1, uv + vec2(o.x, -o.y), uDustLod) + textureLod(tDust1, uv + vec2(-o.x, o.y), uDustLod));
  float u = clamp((z - uDepth0) / uDepthStep, 0.0, 7.0);
  float s[8] = float[8](a.x, a.y, a.z, a.w, b.x, b.y, b.z, b.w);
  int k = int(min(floor(u), 6.0));
  return mix(s[k], s[k + 1], u - float(k));
}
const vec3 REDDEN = vec3(0.91, 1.0, 1.29);
`;

/** Gas → dust optical depth in 8 depth slices (1 texel per parcel). */
const DUST_VERT = /* glsl */ `
${PARTICLE_GLSL}
uniform float uKappa;
uniform float uDepth0;
uniform float uDepthStep;
uniform float uProjD;
out vec4 vF0;
out vec4 vF1;
void main() {
  vec3 x = particleWorld();
  vec4 mv = modelViewMatrix * vec4(x, 1.0);
  vec4 clip = projectionMatrix * mv;
  if (clip.w <= 0.0) { offscreen(); return; }
  gl_Position = clip;
  gl_PointSize = 1.0;
  float d = max(-mv.z, 1e-3);
  // Column density of this parcel spread over one texel → optical depth.
  float tau = uKappa * P_attr.w * (uProjD * uProjD) / (d * d);
  float w = 0.35;
  vec4 D0 = uDepth0 + uDepthStep * vec4(0.0, 1.0, 2.0, 3.0);
  vec4 D1 = uDepth0 + uDepthStep * vec4(4.0, 5.0, 6.0, 7.0);
  vF0 = smoothstep(vec4(d - w), vec4(d + w), D0) * tau;
  vF1 = smoothstep(vec4(d - w), vec4(d + w), D1) * tau;
}`;
const DUST_FRAG = /* glsl */ `
in vec4 vF0;
in vec4 vF1;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
void main() { o0 = vF0; o1 = vF1; }`;

/** Shared stellar photometry for the diffuse deposit and the resolved points. */
const STAR_LIGHT_GLSL = /* glsl */ `
${BLACKBODY_GLSL}
${PARTICLE_GLSL}
${DUST_READ_GLSL}
uniform float uExposure;
uniform float uBulgeTemp;
uniform float uYoungBoost;
// Dust-attenuated luminosity × colour (10¹⁰ L☉), and clip-space position.
vec3 starLight(out vec4 clip, out float d) {
  vec3 x = particleWorld();
  vec4 mv = modelViewMatrix * vec4(x, 1.0);
  clip = projectionMatrix * mv;
  d = max(-mv.z, 1e-3);
  int kind = int(P_attr.x + 0.5);
  float age = P_attr.z + uTime;
  float L = P_attr.w / massToLight(age);
  vec3 col = kind == 0 ? blackbody(uBulgeTemp) : blackbody(popTemp(age));
  vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
  return wb(col) * L * exp(-tauAt(uv, d) * REDDEN);
}
`;

/** Particle counts (1 texel each) → mip-mapped count pyramid that sets each particle's smoothing level. */
const COUNT_VERT = /* glsl */ `
${PARTICLE_GLSL}
void main() {
  vec3 x = particleWorld();
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(x, 1.0);
  if (clip.w <= 0.0) { offscreen(); return; }
  gl_Position = clip;
  gl_PointSize = 1.0;
}`;
const COUNT_FRAG = /* glsl */ `
out vec4 outColor;
void main() { outColor = vec4(1.0); }`;

/**
 * Diffuse light, scattered into one of LEVELS resolution levels (texel = 2^k light pixels): the
 * particle's continuous level l* is where its neighbourhood holds uNgb particles; its light is
 * split linearly between the two nearest levels, so smoothing lengths vary continuously.
 */
const DEPOSIT_VERT = /* glsl */ `
${STAR_LIGHT_GLSL}
uniform sampler2D tCount;
uniform float uProjL;
uniform float uDiffuse;
uniform float uNgb;
uniform float uLevel;
uniform float uMaxLevel;
out vec4 vC;
float chooseLevel(vec2 uv) {
  float nPrev = textureLod(tCount, uv, 0.0).r;
  if (nPrev >= uNgb) return 0.0;
  for (int i = 1; i < 8; i++) {
    float l = float(i);
    if (l > uMaxLevel) break;
    float n = textureLod(tCount, uv, l).r * exp2(2.0 * l);
    if (n >= uNgb) {
      float a = log(uNgb / max(nPrev, 1e-3)) / log(max(n, 1e-3) / max(nPrev, 1e-3));
      return l - 1.0 + clamp(a, 0.0, 1.0);
    }
    nPrev = n;
  }
  return uMaxLevel;
}
void main() {
  vec4 clip; float d;
  vec3 c = starLight(clip, d);
  if (clip.w <= 0.0) { offscreen(); return; }
  float w = 1.0 - abs(chooseLevel(clip.xy / clip.w * 0.5 + 0.5) - uLevel);
  if (w <= 0.0) { offscreen(); return; }
  gl_Position = clip;
  gl_PointSize = 1.0;
  // Surface brightness of one level texel: L / (texel area in kpc²).
  float pl = uProjL * exp2(-uLevel);
  vC = vec4(c * (w * uDiffuse * uExposure * pl * pl / (d * d)), 1.0);
}`;

/** Separable Gaussian, σ = 1 texel (7 taps). */
const BLUR_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uStep;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec4 s = texture(tSrc, vUv) * 0.39894;
  s += (texture(tSrc, vUv + uStep) + texture(tSrc, vUv - uStep)) * 0.24197;
  s += (texture(tSrc, vUv + 2.0 * uStep) + texture(tSrc, vUv - 2.0 * uStep)) * 0.05399;
  s += (texture(tSrc, vUv + 3.0 * uStep) + texture(tSrc, vUv - 3.0 * uStep)) * 0.00443;
  outColor = s;
}`;

const LEVELS = 6;
/** Sum of the blurred levels (bilinear up-sampling; tent taps on the coarse levels). */
const SUM_FRAG = /* glsl */ `
${Array.from({ length: LEVELS }, (_, k) => `uniform sampler2D tL${k};`).join('\n')}
uniform vec2 uTexel[${LEVELS}];
in vec2 vUv;
out vec4 outColor;
vec3 tent(sampler2D t, vec2 o) {
  return 0.25 * (texture(t, vUv + o).rgb + texture(t, vUv - o).rgb + texture(t, vUv + vec2(o.x, -o.y)).rgb + texture(t, vUv + vec2(-o.x, o.y)).rgb);
}
void main() {
  vec3 c = texture(tL0, vUv).rgb + texture(tL1, vUv).rgb;
  ${Array.from({ length: LEVELS - 2 }, (_, k) => `c += tent(tL${k + 2}, 0.5 * uTexel[${k + 2}]);`).join('\n  ')}
  outColor = vec4(c, 1.0);
}`;

const DEPOSIT_FRAG = /* glsl */ `
in vec4 vC;
out vec4 outColor;
void main() { outColor = vC; }`;

const POINT_VERT = /* glsl */ `
${STAR_LIGHT_GLSL}
uniform float uPoint;
uniform float uSigma;
uniform vec2 uRes;
out vec3 vC;
out vec2 vCenter;
void main() {
  vec4 clip; float d;
  vec3 c = starLight(clip, d);
  if (clip.w <= 0.0) { offscreen(); return; }
  gl_Position = clip;
  gl_PointSize = ceil(6.0 * uSigma) + 1.0;
  vCenter = (clip.xy / clip.w * 0.5 + 0.5) * uRes;
  vC = c * (uPoint * uExposure * uProj * uProj / (d * d)) / (6.2831853 * uSigma * uSigma);
}`;
const POINT_FRAG = /* glsl */ `
uniform float uSigma;
in vec3 vC;
in vec2 vCenter;
out vec4 outColor;
void main() {
  vec2 q = gl_FragCoord.xy - vCenter;
  outColor = vec4(vC * exp(-dot(q, q) / (2.0 * uSigma * uSigma)), 1.0);
}`;

/**
 * Adaptive pyramid read-out: the finest mip level whose texel holds ≥ uNgb particles (count in
 * alpha; mip averages × 4^level = sums), with a 4-tap tent at that level to hide texel blocks.
 * Where even the coarsest allowed level holds fewer, the diffuse light fades out (the resolved
 * points carry sparse regions) — so isolated particles never smear into haze.
 */
const PYRAMID_FRAG = /* glsl */ `
uniform sampler2D tL;
uniform vec2 uTexel;
uniform float uNgb;
uniform float uMaxLod;
uniform vec3 uTint;
in vec2 vUv;
out vec4 outColor;
float countAt(float l) { return textureLod(tL, vUv, l).a * exp2(2.0 * l); }
vec3 tentAt(float l) {
  vec2 o = uTexel * exp2(floor(l)) * 0.5;
  return 0.25 * (textureLod(tL, vUv + vec2(o.x, o.y), l).rgb + textureLod(tL, vUv + vec2(-o.x, o.y), l).rgb
    + textureLod(tL, vUv + vec2(o.x, -o.y), l).rgb + textureLod(tL, vUv + vec2(-o.x, -o.y), l).rgb);
}
void main() {
  float nPrev = countAt(0.0);
  float lod = 0.0;
  float fade = 1.0;
  if (nPrev < uNgb) {
    lod = uMaxLod;
    fade = 0.0;
    for (int i = 1; i < 12; i++) {
      float l = float(i);
      if (l > uMaxLod) break;
      float n = countAt(l);
      if (n >= uNgb) {
        float a = log(max(uNgb, 1e-3) / max(nPrev, 1e-3)) / log(max(n, 1e-3) / max(nPrev, 1e-3));
        lod = l - 1.0 + clamp(a, 0.0, 1.0);
        fade = 1.0;
        break;
      }
      nPrev = n;
    }
    if (fade == 0.0) fade = smoothstep(0.0, 1.0, countAt(uMaxLod) / uNgb);
  }
  if (fade <= 0.0) discard;
  outColor = vec4(uTint * tentAt(lod) * fade, 1.0);
}`;

const GAS_VERT = /* glsl */ `
${BLACKBODY_GLSL}
${PARTICLE_GLSL}
${DUST_READ_GLSL}
uniform float uExposure;
uniform float uSfEff;
uniform vec3 uHII;
uniform float uMinR;
out vec3 vCore;
out vec3 vGlow;
out float vCoreFrac;
void main() {
  vec3 x = particleWorld();
  float tb = uTime - P_pos.w;           // Myr since this gas parcel's latest starburst
  if (tb > 400.0 || tb < -1.0) { offscreen(); return; }
  vec4 mv = modelViewMatrix * vec4(x, 1.0);
  vec4 clip = projectionMatrix * mv;
  if (clip.w <= 0.0) { offscreen(); return; }
  gl_Position = clip;
  float d = max(-mv.z, 1e-3);
  tb = max(tb, 0.0);
  float m = uSfEff * P_attr.w;          // stellar mass formed in the burst
  float Lc = m / massToLight(max(tb, 3.0)) * smoothstep(400.0, 250.0, tb);
  // Ionising photons fade within ~10 Myr as the O stars die (Starburst99); the HII region
  // expands (≈ 10 km/s) and fades.
  float Lh = 0.5 * m / massToLight(3.0) * exp(-tb / 5.0) * smoothstep(0.0, 1.0, tb + 0.5);
  float rCore = max(uMinR, 0.03 * uProj / d);
  // The HII region only exists while O stars live (≲ 40 Myr); after that draw the bare cluster.
  if (tb > 40.0) Lh = 0.0;
  float rGlow = Lh > 0.0 ? min(max(uMinR * 2.0, (0.22 + 0.012 * tb) * uProj / d), 96.0) : rCore;
  float r = max(rGlow, rCore);
  gl_PointSize = 2.0 * r;
  vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
  // Young clusters sit inside their dust: τ at a slightly nearer depth (half the local column).
  vec3 ext = exp(-tauAt(uv, d - 0.1) * REDDEN);
  float k = uExposure * uProj * uProj / (d * d);
  vCore = wb(blackbody(popTemp(tb + 3.0))) * ext * (Lc * k / (0.771 * rCore * rCore));
  vGlow = wb(uHII) * ext * (Lh * k / (0.771 * r * r));
  vCoreFrac = rCore / r;
}`;
const GAS_FRAG = /* glsl */ `
in vec3 vCore;
in vec3 vGlow;
in float vCoreFrac;
out vec4 outColor;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(q, q);
  if (r2 > 1.0) discard;
  float c2 = r2 / max(vCoreFrac * vCoreFrac, 1e-4);
  vec3 col = vGlow * exp(-4.0 * r2);
  if (c2 < 1.0) col += vCore * exp(-4.0 * c2);
  outColor = vec4(col, 1.0);
}`;

const DM_VERT = /* glsl */ `
uniform sampler2D tSPos;
uniform float uProjL;
uniform float uHaloEnd;
out vec4 vC;
void main() {
  int id = gl_VertexID;
  ivec2 t = ivec2(id % ${SKELETON_WIDTH}, id / ${SKELETON_WIDTH});
  vec4 p = texelFetch(tSPos, t, 0);
  vec4 mv = modelViewMatrix * vec4(p.xyz, 1.0);
  vec4 clip = projectionMatrix * mv;
  if (clip.w <= 0.0 || float(id) >= uHaloEnd) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  gl_Position = clip;
  gl_PointSize = 1.0;
  float d = max(-mv.z, 1e-3);
  vC = vec4(vec3(p.w * uProjL * uProjL / (d * d)), 1.0);
}`;

/** Per-channel gains that map a blackbody of temperature T to luminance-preserving white. */
export function whiteBalance(T: number): THREE.Vector3 {
  const c = blackbodyRGB(T);
  const g = new THREE.Vector3(1 / c[0], 1 / c[1], 1 / c[2]);
  // Keep luminance of a 5300 K source unchanged, i.e. normalise to Rec.709 luminance.
  const lum = 0.2126 * g.x * c[0] + 0.7152 * g.y * c[1] + 0.0722 * g.z * c[2];
  return g.multiplyScalar(1 / lum);
}

function hiiColor(): THREE.Vector3 {
  // Balmer (Case B) + [NII] + weak [OIII] through CIE 1931, internal A_V ≈ 1:
  // linear sRGB with luminance 1 (Hα-dominated pink-red with a violet Hβ/Hγ contribution).
  return new THREE.Vector3(2.707, 0.436, 1.564);
}

export interface GalaxyRendererOptions {
  data: ScenarioData;
  /** Exposure in display units per 10¹⁰ L☉ kpc⁻². */
  exposure?: number;
  /** Resolution of the diffuse-light pyramid relative to the target (default ½). */
  lightScale?: number;
}

export interface RenderInputs {
  pos: THREE.Texture;
  vel: THREE.Texture;
  attr: THREE.Texture;
  skeletonPos?: THREE.Texture;
  time: number;
  extrapolate: number;
  /** View-depth range (kpc) that holds the system, for the dust slices. */
  depthNear: number;
  depthFar: number;
  pixelRatio: number;
}

const pyramidTarget = (count: number) =>
  new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: true,
    count,
  });

export class GalaxyRenderer {
  exposure: number;
  /** Dust strength multiplier (1 = solar-metallicity dust-to-gas; 0 = off). */
  dust = 1;
  /** Show the live dark-matter halo as a faint violet glow. */
  darkMatter = false;
  darkMatterExposure = 0.02;
  /** Show young clusters and HII regions. */
  youngStars = true;
  /** Fraction of stellar light drawn as resolved points (the rest is the smooth glow). */
  pointFraction = 0.22;
  /** Neighbour count for the adaptive smoothing. */
  ngb = 4;
  readonly lightScale: number;
  private countRT = pyramidTarget(1);
  private levelRT: THREE.WebGLRenderTarget[] = [];
  private blurRT: THREE.WebGLRenderTarget[] = [];
  private countScene = new THREE.Scene();
  private countMat!: THREE.ShaderMaterial;
  private blurMat!: THREE.ShaderMaterial;
  private sumMat!: THREE.ShaderMaterial;
  private dustRT = pyramidTarget(2);
  private dmRT = pyramidTarget(1);
  private dustScene = new THREE.Scene();
  private depositScene = new THREE.Scene();
  private pointScene = new THREE.Scene();
  private gasScene = new THREE.Scene();
  private dmScene = new THREE.Scene();
  private quad = new FullscreenQuad();
  private mats: THREE.ShaderMaterial[] = [];
  private geoms: THREE.BufferGeometry[] = [];
  private shared: Record<string, THREE.IUniform>;
  private dustMat: THREE.ShaderMaterial;
  private depositMat: THREE.ShaderMaterial;
  private pointMat: THREE.ShaderMaterial;
  private gasMat: THREE.ShaderMaterial;
  private dmMat: THREE.ShaderMaterial;
  private dmComposite: THREE.ShaderMaterial;
  private w = 0;
  private h = 0;
  private tmpColor = new THREE.Color();

  constructor(o: GalaxyRendererOptions) {
    this.exposure = o.exposure ?? 20;
    this.lightScale = o.lightScale ?? 0.5;
    const shared: Record<string, THREE.IUniform> = {
      tPos: { value: null },
      tVel: { value: null },
      tAttr: { value: null },
      uWidth: { value: TRACER_WIDTH },
      uTime: { value: 0 },
      uExtrap: { value: 0 },
      uProj: { value: 1000 },
      uProjL: { value: 500 },
      uProjD: { value: 250 },
      tDust0: { value: this.dustRT.textures[0] },
      tDust1: { value: this.dustRT.textures[1] },
      uDepth0: { value: 0 },
      uDepthStep: { value: 1 },
      uDustOn: { value: 1 },
      uDustLod: { value: 1.0 },
      uDustTexel: { value: new THREE.Vector2(1, 1) },
      uExposure: { value: this.exposure },
      uBulgeTemp: { value: 4200 },
      uMinR: { value: 1 },
      uWhite: { value: whiteBalance(5300) },
    };
    this.shared = shared;
    const mk = (vert: string, frag: string, extra: Record<string, THREE.IUniform>) => {
      const m = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: vert,
        fragmentShader: `${COMMON_GLSL}\n${frag}`,
        uniforms: { ...shared, ...extra },
        ...ADD_ONE_ONE,
        depthTest: false,
        depthWrite: false,
        transparent: true,
      });
      this.mats.push(m);
      return m;
    };
    this.dustMat = mk(DUST_VERT, DUST_FRAG, { uKappa: { value: 470 } });
    this.countMat = mk(COUNT_VERT, COUNT_FRAG, {});
    this.depositMat = mk(DEPOSIT_VERT, DEPOSIT_FRAG, {
      tCount: { value: this.countRT.texture },
      uDiffuse: { value: 0.7 },
      uNgb: { value: 4 },
      uLevel: { value: 0 },
      uMaxLevel: { value: LEVELS - 1 },
    });
    const level = () =>
      new THREE.WebGLRenderTarget(1, 1, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
      });
    for (let k = 0; k < LEVELS; k++) {
      this.levelRT.push(level());
      this.blurRT.push(level());
    }
    const fs = (frag: string, uniforms: Record<string, THREE.IUniform>, blend: boolean) => {
      const m = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: frag,
        uniforms,
        ...(blend ? ADD_ONE_ONE : { blending: THREE.NoBlending }),
        depthTest: false,
        depthWrite: false,
        transparent: blend,
      });
      this.mats.push(m);
      return m;
    };
    this.blurMat = fs(BLUR_FRAG, { tSrc: { value: null }, uStep: { value: new THREE.Vector2() } }, false);
    const sumU: Record<string, THREE.IUniform> = { uTexel: { value: this.levelRT.map(() => new THREE.Vector2(1, 1)) } };
    this.levelRT.forEach((rt, k) => (sumU[`tL${k}`] = { value: rt.texture }));
    this.sumMat = fs(SUM_FRAG, sumU, true);
    this.pointMat = mk(POINT_VERT, POINT_FRAG, { uPoint: { value: 0.3 }, uSigma: { value: 0.7 }, uRes: { value: new THREE.Vector2(1, 1) } });
    this.gasMat = mk(GAS_VERT, GAS_FRAG, { uSfEff: { value: SF_EFFICIENCY }, uHII: { value: hiiColor() } });
    this.dmMat = mk(DM_VERT, DEPOSIT_FRAG, { tSPos: { value: null }, uHaloEnd: { value: 0 } });
    const composite = (tex: THREE.Texture, tint: THREE.Vector3, ngb: number) => {
      const m = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: PYRAMID_FRAG,
        uniforms: {
          tL: { value: tex },
          uTexel: { value: new THREE.Vector2(1, 1) },
          uNgb: { value: ngb },
          uMaxLod: { value: 5 },
          uTint: { value: tint },
        },
        ...ADD_ONE_ONE,
        depthTest: false,
        depthWrite: false,
        transparent: true,
      });
      this.mats.push(m);
      return m;
    };
    // Dark matter emits nothing; this violet is a visualisation (λ ≈ 420 nm), clearly labelled in the UI.
    this.dmComposite = composite(this.dmRT.texture, new THREE.Vector3(0.45, 0.28, 1.0), 6);
    this.setData(o.data);
  }

  /** (Re)build draw ranges for a scenario. */
  setData(data: ScenarioData): void {
    for (const s of [this.dustScene, this.countScene, this.depositScene, this.pointScene, this.gasScene, this.dmScene]) s.clear();
    for (const g of this.geoms) g.dispose();
    this.geoms = [];
    const pts = (range: [number, number], mat: THREE.ShaderMaterial, scene: THREE.Scene) => {
      const g = new THREE.BufferGeometry();
      g.setDrawRange(range[0], range[1]);
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
      this.geoms.push(g);
      const p = new THREE.Points(g, mat);
      p.frustumCulled = false;
      scene.add(p);
    };
    const R = data.tracers.ranges;
    const stars = [...R.bulge, ...R.disk];
    for (const r of R.gas) pts(r, this.dustMat, this.dustScene);
    for (const r of stars) pts(r, this.countMat, this.countScene);
    for (const r of stars) pts(r, this.depositMat, this.depositScene);
    for (const r of stars) pts(r, this.pointMat, this.pointScene);
    for (const r of R.gas) pts(r, this.gasMat, this.gasScene);
    // Halo segments come first in the skeleton layout.
    const haloEnd = data.skeleton.segments.filter((s) => s.comp === 0).reduce((a, s) => Math.max(a, s.start + s.count), 0);
    this.dmMat.uniforms.uHaloEnd.value = haloEnd;
    pts([0, haloEnd], this.dmMat, this.dmScene);
  }

  resize(w: number, h: number): void {
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    const lw = Math.max(1, Math.round(w * this.lightScale)), lh = Math.max(1, Math.round(h * this.lightScale));
    this.countRT.setSize(lw, lh);
    this.levelRT.forEach((rt, k) => {
      const w2 = Math.max(1, Math.round(lw / 2 ** k)), h2 = Math.max(1, Math.round(lh / 2 ** k));
      rt.setSize(w2, h2);
      this.blurRT[k].setSize(w2, h2);
      (this.sumMat.uniforms.uTexel.value[k] as THREE.Vector2).set(1 / w2, 1 / h2);
    });
    const qw = Math.max(1, Math.round(w / 4)), qh = Math.max(1, Math.round(h / 4));
    this.dustRT.setSize(qw, qh);
    this.dmRT.setSize(qw, qh);
    (this.shared.uDustTexel.value as THREE.Vector2).set(1 / qw, 1 / qh);
    (this.dmComposite.uniforms.uTexel.value as THREE.Vector2).set(1 / qw, 1 / qh);
    this.dmComposite.uniforms.uMaxLod.value = Math.max(1, Math.log2((160 * h) / 720 / 4));
  }

  render(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, target: THREE.WebGLRenderTarget, p: RenderInputs): void {
    this.resize(target.width, target.height);
    const u = this.shared;
    u.tPos.value = p.pos;
    u.tVel.value = p.vel;
    u.tAttr.value = p.attr;
    u.uTime.value = p.time;
    u.uExtrap.value = p.extrapolate;
    const proj = target.height / (2 * Math.tan((camera.fov * Math.PI) / 360));
    u.uProj.value = proj;
    u.uProjL.value = proj * (this.countRT.height / target.height);
    u.uProjD.value = proj * (this.dustRT.height / target.height);
    u.uMinR.value = Math.max(1, 0.9 * p.pixelRatio);
    u.uExposure.value = this.exposure;
    u.uDustOn.value = this.dust > 0 ? 1 : 0;
    this.dustMat.uniforms.uKappa.value = 470 * this.dust;
    this.depositMat.uniforms.uDiffuse.value = 1 - this.pointFraction;
    this.pointMat.uniforms.uPoint.value = this.pointFraction;
    this.pointMat.uniforms.uSigma.value = 0.6 * Math.max(1, p.pixelRatio);
    (this.pointMat.uniforms.uRes.value as THREE.Vector2).set(target.width, target.height);
    this.depositMat.uniforms.uNgb.value = this.ngb;
    const near = Math.max(0.5, p.depthNear), far = Math.max(near + 1, p.depthFar);
    u.uDepth0.value = near;
    u.uDepthStep.value = (far - near) / 7;

    const prevClear = renderer.getClearColor(this.tmpColor);
    const prevAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    if (this.dust > 0) {
      renderer.setRenderTarget(this.dustRT);
      renderer.clear(true, false, false);
      renderer.render(this.dustScene, camera); // mipmaps regenerate after the draw
    }
    renderer.setRenderTarget(this.countRT);
    renderer.clear(true, false, false);
    renderer.render(this.countScene, camera); // count pyramid (mipmaps regenerate after the draw)
    for (let k = 0; k < LEVELS; k++) {
      this.depositMat.uniforms.uLevel.value = k;
      renderer.setRenderTarget(this.levelRT[k]);
      renderer.clear(true, false, false);
      renderer.render(this.depositScene, camera);
      const b = this.blurMat.uniforms;
      b.tSrc.value = this.levelRT[k].texture;
      (b.uStep.value as THREE.Vector2).set(1 / this.levelRT[k].width, 0);
      this.quad.material = this.blurMat;
      this.quad.render(renderer, this.blurRT[k]);
      b.tSrc.value = this.blurRT[k].texture;
      (b.uStep.value as THREE.Vector2).set(0, 1 / this.levelRT[k].height);
      this.quad.render(renderer, this.levelRT[k]);
    }
    if (this.darkMatter && p.skeletonPos) {
      this.dmMat.uniforms.tSPos.value = p.skeletonPos;
      this.dmComposite.uniforms.uTint.value.set(0.45, 0.28, 1.0).multiplyScalar(this.darkMatterExposure * this.exposure);
      renderer.setRenderTarget(this.dmRT);
      renderer.clear(true, false, false);
      renderer.render(this.dmScene, camera);
    }
    renderer.setClearColor(prevClear, prevAlpha);

    renderer.setRenderTarget(target);
    if (this.darkMatter && p.skeletonPos) {
      this.quad.material = this.dmComposite;
      this.quad.render(renderer, target);
    }
    this.quad.material = this.sumMat;
    this.quad.render(renderer, target);
    renderer.render(this.pointScene, camera);
    if (this.youngStars) renderer.render(this.gasScene, camera);
  }

  dispose(): void {
    for (const g of this.geoms) g.dispose();
    for (const m of this.mats) m.dispose();
    this.countRT.dispose();
    for (const rt of [...this.levelRT, ...this.blurRT]) rt.dispose();
    this.dustRT.dispose();
    this.dmRT.dispose();
  }
}
