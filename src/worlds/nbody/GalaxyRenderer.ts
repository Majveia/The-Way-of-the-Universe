import * as THREE from 'three';
import { BLACKBODY_GLSL } from '../../shaders/lib/blackbody';
import { COMMON_GLSL } from '../../shaders/lib/common';
import { TRACER_WIDTH, SKELETON_WIDTH, type ScenarioData } from './scenario';

/**
 * Renders a galaxy-collision system as light, the way a telescope would see it.
 *
 * Passes (each particle is one tracer of the N-body system, read from the state textures):
 *  1. COUNT (¼ res)  — projected particle density per population (stars R, gas G).
 *  2. DUST  (½ res)  — gas splats deposit V-band optical depth into 8 view-depth slices (a deep
 *                      opacity map, Yuksel & Keyser 2008): channel k holds τ in front of depth D_k.
 *  3. STARS (full)   — each stellar tracer is an energy-conserving Gaussian splat whose radius
 *                      adapts to the projected density (≈ 12 neighbours, an SPH-like smoothing
 *                      length in screen space), dimmed and reddened by the dust in front of it.
 *  4. GAS            — young star clusters (from each gas particle's latest burst) and their HII
 *                      glow in dust-reddened Balmer + [NII] light.
 *  5. DARK MATTER    — optional faint violet haze from the live halo particles.
 *
 * Photometry: particle luminosity L = M / (M/L)(age) with M/L ≈ 3 (t/10 Gyr)^0.8 (V band, a fit to
 * Bruzual & Charlot 2003 SSPs); colour a blackbody at T ≈ 4500 K (t/10 Gyr)^−0.18. Pixel values are
 * surface brightness in 10¹⁰ L☉ kpc⁻², independent of distance (as for real extended sources).
 * Dust: τ_V = κ Σ_gas with κ ≈ 470 (10¹⁰ M☉ kpc⁻²)⁻¹, i.e. A_V/N_H = 1/1.9×10²¹ cm⁻² (Bohlin et
 * al. 1978) at solar metallicity; reddening A_λ/A_V = 0.91, 1.00, 1.29 for R, G, B (Cardelli et
 * al. 1989).
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
`;

const DENSITY_GLSL = /* glsl */ `
uniform sampler2D tCount;
uniform vec2 uCountTexel;
uniform float uNgb;
uniform float uMinR;
uniform float uMaxR;
// Blurred projected count (particles per count texel) at screen uv.
vec2 countAt(vec2 uv) {
  vec2 o = uCountTexel;
  return (texture(tCount, uv).rg * 2.0
    + texture(tCount, uv + vec2(o.x, o.y)).rg + texture(tCount, uv + vec2(-o.x, o.y)).rg
    + texture(tCount, uv + vec2(o.x, -o.y)).rg + texture(tCount, uv + vec2(-o.x, -o.y)).rg) / 6.0;
}
// Splat radius (full-res px) enclosing ~uNgb neighbours; a count texel covers 16 px².
float splatRadius(float n) {
  return clamp(sqrt(uNgb * 16.0 / (3.14159265 * max(n, 0.01))), uMinR, uMaxR);
}
`;

const DUST_READ_GLSL = /* glsl */ `
uniform sampler2D tDust0;
uniform sampler2D tDust1;
uniform float uDepth0;
uniform float uDepthStep;
uniform float uDustOn;
// V-band optical depth in front of view depth z at screen uv.
float tauAt(vec2 uv, float z) {
  if (uDustOn < 0.5) return 0.0;
  vec4 a = texture(tDust0, uv);
  vec4 b = texture(tDust1, uv);
  float u = clamp((z - uDepth0) / uDepthStep, 0.0, 7.0);
  float s[8] = float[8](a.x, a.y, a.z, a.w, b.x, b.y, b.z, b.w);
  int k = int(min(floor(u), 6.0));
  return mix(s[k], s[k + 1], u - float(k));
}
`;

const COUNT_VERT = /* glsl */ `
${PARTICLE_GLSL}
uniform float uChannel;
out float vCh;
void main() {
  vec3 x = particleWorld();
  gl_Position = projectionMatrix * modelViewMatrix * vec4(x, 1.0);
  gl_PointSize = 1.0;
  vCh = uChannel;
}`;
const COUNT_FRAG = /* glsl */ `
in float vCh;
out vec4 outColor;
void main() { outColor = vec4(1.0 - vCh, vCh, 0.0, 0.0); }`;

const DUST_VERT = /* glsl */ `
${PARTICLE_GLSL}
${DENSITY_GLSL}
uniform float uKappa;
uniform float uDepth0;
uniform float uDepthStep;
out float vTau;
out vec4 vF0;
out vec4 vF1;
void main() {
  vec3 x = particleWorld();
  vec4 mv = modelViewMatrix * vec4(x, 1.0);
  vec4 clip = projectionMatrix * mv;
  gl_Position = clip;
  float d = max(-mv.z, 1e-3);
  vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
  float r = splatRadius(countAt(uv).g);
  gl_PointSize = 2.0 * r * 0.5; // dust target is half resolution
  // Surface density of this splat → optical depth (per-pixel peak normalisation in the fragment).
  vTau = uKappa * P_attr.w * uProj * uProj / (d * d * 4.0 * r * r);
  float w = max(r * d / uProj, 0.15);
  vec4 D0 = uDepth0 + uDepthStep * vec4(0.0, 1.0, 2.0, 3.0);
  vec4 D1 = uDepth0 + uDepthStep * vec4(4.0, 5.0, 6.0, 7.0);
  vF0 = smoothstep(vec4(d - w), vec4(d + w), D0);
  vF1 = smoothstep(vec4(d - w), vec4(d + w), D1);
  if (clip.w <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;
const DUST_FRAG = /* glsl */ `
in float vTau;
in vec4 vF0;
in vec4 vF1;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(q, q);
  if (r2 > 1.0) discard;
  float k = exp(-4.0 * r2) * (4.0 / 0.7706) * vTau;
  o0 = vF0 * k;
  o1 = vF1 * k;
}`;

const STAR_VERT = /* glsl */ `
${BLACKBODY_GLSL}
${PARTICLE_GLSL}
${DENSITY_GLSL}
${DUST_READ_GLSL}
uniform float uExposure;
uniform float uBulgeTemp;
out vec3 vColor;
void main() {
  vec3 x = particleWorld();
  vec4 mv = modelViewMatrix * vec4(x, 1.0);
  vec4 clip = projectionMatrix * mv;
  gl_Position = clip;
  float d = max(-mv.z, 1e-3);
  vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
  float r = splatRadius(countAt(uv).r);
  gl_PointSize = 2.0 * r;
  int kind = int(P_attr.x + 0.5);
  float age = P_attr.z + uTime;
  float L = P_attr.w / massToLight(age);
  vec3 col = kind == 0 ? blackbody(uBulgeTemp) : blackbody(popTemp(age));
  float tau = tauAt(uv, d);
  vColor = col * exp(-tau * vec3(0.91, 1.0, 1.29)) * (L * uExposure * uProj * uProj / (d * d * 4.0 * r * r));
  if (clip.w <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;
const SPLAT_FRAG = /* glsl */ `
in vec3 vColor;
out vec4 outColor;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(q, q);
  if (r2 > 1.0) discard;
  outColor = vec4(vColor * (exp(-4.0 * r2) * (4.0 / 0.7706)), 1.0);
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
  vec4 mv = modelViewMatrix * vec4(x, 1.0);
  vec4 clip = projectionMatrix * mv;
  gl_Position = clip;
  float d = max(-mv.z, 1e-3);
  float tb = uTime - P_pos.w;           // Myr since this gas parcel's latest starburst
  float m = uSfEff * P_attr.w;          // stellar mass formed in the burst
  float Lc = tb < 500.0 ? m / massToLight(max(tb, 3.0)) : 0.0;
  // Ionising photons fade within ~10 Myr as the O stars die (Starburst99).
  float Lh = tb < 40.0 ? 0.9 * m / massToLight(3.0) * exp(-max(tb, 0.0) / 4.0) : 0.0;
  if (Lc + Lh <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  float rGlow = max(uMinR, 0.28 * uProj / d);   // HII region ~0.3 kpc
  float rCore = max(uMinR * 0.7, 0.05 * uProj / d);
  float r = max(rGlow, rCore);
  gl_PointSize = 2.0 * r;
  vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
  // Young clusters sit inside their dust: use τ at a slightly nearer depth (half the local column).
  vec3 ext = exp(-tauAt(uv, d - 0.1) * vec3(0.91, 1.0, 1.29));
  float k = uExposure * uProj * uProj / (d * d);
  vCore = blackbody(popTemp(tb + 3.0)) * ext * (Lc * k / (4.0 * rCore * rCore));
  vGlow = uHII * ext * (Lh * k / (4.0 * r * r));
  vCoreFrac = rCore / r;
  if (clip.w <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
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
  vec3 col = vGlow * exp(-4.0 * r2) * (4.0 / 0.7706);
  if (c2 < 1.0) col += vCore * exp(-4.0 * c2) * (4.0 / 0.7706);
  outColor = vec4(col, 1.0);
}`;

const DM_VERT = /* glsl */ `
uniform sampler2D tSPos;
uniform float uProj;
uniform float uDmExposure;
uniform float uHaloEnd;
out vec3 vColor;
void main() {
  int id = gl_VertexID;
  ivec2 t = ivec2(id % ${SKELETON_WIDTH}, id / ${SKELETON_WIDTH});
  vec4 p = texelFetch(tSPos, t, 0);
  vec4 mv = modelViewMatrix * vec4(p.xyz, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = max(-mv.z, 1e-3);
  float r = clamp(4.0 * uProj / d, 1.5, 80.0);
  gl_PointSize = 2.0 * r;
  vColor = vec3(0.42, 0.3, 1.0) * (p.w * uDmExposure * uProj * uProj / (d * d * 4.0 * r * r));
  if (float(id) >= uHaloEnd) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;

function hiiColor(): THREE.Vector3 {
  // Balmer (Case B) + [NII] + weak [OIII] through CIE 1931, internal A_V ≈ 1 (see header):
  // linear sRGB with luminance 1.
  return new THREE.Vector3(2.707, 0.436, 1.564);
}

export interface GalaxyRendererOptions {
  data: ScenarioData;
  /** Exposure in display units per 10¹⁰ L☉ kpc⁻². */
  exposure?: number;
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

const halfTarget = (w: number, h: number, count: number) =>
  new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    count,
  });

export class GalaxyRenderer {
  exposure: number;
  /** Dust on/off and strength multiplier (1 = solar metallicity dust-to-gas). */
  dust = 1;
  /** Show the live dark-matter halo particles. */
  darkMatter = false;
  darkMatterExposure = 0.8;
  private countRT = halfTarget(1, 1, 1);
  private dustRT = halfTarget(1, 1, 2);
  private countScene = new THREE.Scene();
  private dustScene = new THREE.Scene();
  private mainScene = new THREE.Scene();
  private dmScene = new THREE.Scene();
  private mats: THREE.ShaderMaterial[] = [];
  private geoms: THREE.BufferGeometry[] = [];
  private shared: Record<string, THREE.IUniform>;
  private countMatStar: THREE.ShaderMaterial;
  private countMatGas: THREE.ShaderMaterial;
  private dustMat: THREE.ShaderMaterial;
  private starMat: THREE.ShaderMaterial;
  private gasMat: THREE.ShaderMaterial;
  private dmMat: THREE.ShaderMaterial;
  private w = 0;
  private h = 0;

  constructor(o: GalaxyRendererOptions) {
    this.exposure = o.exposure ?? 20;
    const shared: Record<string, THREE.IUniform> = {
      tPos: { value: null },
      tVel: { value: null },
      tAttr: { value: null },
      uWidth: { value: TRACER_WIDTH },
      uTime: { value: 0 },
      uExtrap: { value: 0 },
      uProj: { value: 1000 },
      tCount: { value: this.countRT.texture },
      uCountTexel: { value: new THREE.Vector2(1, 1) },
      uNgb: { value: 12 },
      uMinR: { value: 0.75 },
      uMaxR: { value: 48 },
      tDust0: { value: this.dustRT.textures[0] },
      tDust1: { value: this.dustRT.textures[1] },
      uDepth0: { value: 0 },
      uDepthStep: { value: 1 },
      uDustOn: { value: 1 },
      uExposure: { value: this.exposure },
    };
    this.shared = shared;
    const mk = (vert: string, frag: string, extra: Record<string, THREE.IUniform>, blending = THREE.AdditiveBlending) => {
      const m = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: vert,
        fragmentShader: `${COMMON_GLSL}\n${frag}`,
        uniforms: { ...shared, ...extra },
        blending,
        depthTest: false,
        depthWrite: false,
        transparent: true,
      });
      this.mats.push(m);
      return m;
    };
    this.countMatStar = mk(COUNT_VERT, COUNT_FRAG, { uChannel: { value: 0 } });
    this.countMatGas = mk(COUNT_VERT, COUNT_FRAG, { uChannel: { value: 1 } });
    this.dustMat = mk(DUST_VERT, DUST_FRAG, { uKappa: { value: 470 } });
    this.starMat = mk(STAR_VERT, SPLAT_FRAG, { uBulgeTemp: { value: 4300 } });
    this.gasMat = mk(GAS_VERT, GAS_FRAG, { uSfEff: { value: 0.08 }, uHII: { value: hiiColor() } });
    this.dmMat = mk(DM_VERT, SPLAT_FRAG, {
      tSPos: { value: null },
      uHaloEnd: { value: 0 },
      uDmExposure: { value: 0.8 },
    });
    this.setData(o.data);
  }

  /** (Re)build draw ranges for a scenario. */
  setData(data: ScenarioData): void {
    for (const s of [this.countScene, this.dustScene, this.mainScene, this.dmScene]) s.clear();
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
    for (const r of stars) pts(r, this.countMatStar, this.countScene);
    for (const r of R.gas) pts(r, this.countMatGas, this.countScene);
    for (const r of R.gas) pts(r, this.dustMat, this.dustScene);
    for (const r of stars) pts(r, this.starMat, this.mainScene);
    for (const r of R.gas) pts(r, this.gasMat, this.mainScene);
    // Halo segments come first in the skeleton layout.
    const haloEnd = data.skeleton.segments.filter((s) => s.comp === 0).reduce((a, s) => Math.max(a, s.start + s.count), 0);
    this.dmMat.uniforms.uHaloEnd.value = haloEnd;
    pts([0, haloEnd], this.dmMat, this.dmScene);
  }

  resize(w: number, h: number): void {
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    const cw = Math.max(1, Math.ceil(w / 4)), ch = Math.max(1, Math.ceil(h / 4));
    this.countRT.setSize(cw, ch);
    this.dustRT.setSize(Math.max(1, Math.ceil(w / 2)), Math.max(1, Math.ceil(h / 2)));
    (this.shared.uCountTexel.value as THREE.Vector2).set(1 / cw, 1 / ch);
  }

  render(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, target: THREE.WebGLRenderTarget, p: RenderInputs): void {
    this.resize(target.width, target.height);
    const u = this.shared;
    u.tPos.value = p.pos;
    u.tVel.value = p.vel;
    u.tAttr.value = p.attr;
    u.uTime.value = p.time;
    u.uExtrap.value = p.extrapolate;
    u.uProj.value = target.height / (2 * Math.tan((camera.fov * Math.PI) / 360));
    u.uMinR.value = 0.75 * p.pixelRatio;
    u.uMaxR.value = 64 * p.pixelRatio;
    u.uNgb.value = 12;
    u.uExposure.value = this.exposure;
    u.uDustOn.value = this.dust > 0 ? 1 : 0;
    this.dustMat.uniforms.uKappa.value = 470 * this.dust;
    const near = Math.max(0.5, p.depthNear), far = Math.max(near + 1, p.depthFar);
    u.uDepth0.value = near;
    u.uDepthStep.value = (far - near) / 7;
    const prevClear = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(this.countRT);
    renderer.clear(true, false, false);
    renderer.render(this.countScene, camera);
    if (this.dust > 0) {
      renderer.setRenderTarget(this.dustRT);
      renderer.clear(true, false, false);
      renderer.render(this.dustScene, camera);
    }
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.setRenderTarget(target);
    renderer.render(this.mainScene, camera);
    if (this.darkMatter && p.skeletonPos) {
      this.dmMat.uniforms.tSPos.value = p.skeletonPos;
      this.dmMat.uniforms.uDmExposure.value = this.darkMatterExposure;
      renderer.render(this.dmScene, camera);
    }
  }

  dispose(): void {
    for (const g of this.geoms) g.dispose();
    for (const m of this.mats) m.dispose();
    this.countRT.dispose();
    this.dustRT.dispose();
  }
}
