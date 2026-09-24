/**
 * Comet comae and tails (see ../comets.ts for the physics).
 *
 * For up to MAX_ACTIVE comets at a time (the selected one first, then the most conspicuous), the
 * CPU propagates an exact Finson–Probstein grid each frame — AGES × BETAS dust grains released
 * with the nucleus' velocity and moving under µ(1 − β), plus ION_N ion release points carried
 * off by the solar wind — and uploads it as a small float texture / uniform array. On the GPU,
 * tens of thousands of splats sample that grid bilinearly (continuous β and age) and add the
 * scatter that thickens real tails: ejection velocity for dust, magnetic-field-aligned rays and
 * kinks that travel outward for the plasma tail, and an isotropic fountain for the coma.
 *
 * Light: dust scatters sunlight (slightly reddened, forward-scattering Henyey–Greenstein g = 0.6,
 * so a comet between you and the Sun blazes); the ion tail fluoresces blue (CO⁺ at ≈ 426 nm);
 * the coma glows green in the C₂ Swan bands (≈ 516 nm) around a dusty white core. Surface
 * brightness follows the SBDB magnitude law at the time each parcel was released.
 */
import * as THREE from 'three';
import { OCCLUDE_GLSL } from './glsl';
import { COMMON_GLSL } from '../../../shaders/lib/common';
import type { SolarBody } from '../SolarSystemModel';
import {
  ION_MAX_AGE,
  cometActivity,
  computeTailGrid,
  dustBetas,
  dustMaxAge,
  gasSpeedKms,
  ionTailAxis,
  makeTailGrid,
  tailAges,
  KMS_TO_AUD,
  type CometTailGrid,
} from '../comets';
import { conicState } from '../ephem/conic';

export const MAX_ACTIVE = 3;
const AGES = 40;
const BETAS = 16;
const ION_N = 32;
const AGE_POW = 1.7;
const KM_AU = 1 / 149_597_870.7;

/** Linear-RGB emission colours (luminance ≈ 1). */
const DUST_RGB = new THREE.Color(1.0, 0.93, 0.8);
const ION_RGB = new THREE.Color(0.16, 0.42, 1.0).multiplyScalar(1 / (0.2126 * 0.16 + 0.7152 * 0.42 + 0.0722));
const GAS_RGB = new THREE.Color(0.32, 1.0, 0.52).multiplyScalar(1 / (0.2126 * 0.32 + 0.7152 + 0.0722 * 0.52));

const SPLAT_FRAG = /* glsl */ `
precision highp float;
in vec3 vColor;
out vec4 outColor;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(q, q);
  if (r2 > 1.0) discard;
  // Truncated Gaussian (σ = ⅓ of the sprite radius), energy-normalised in the vertex shader.
  float w = exp(-r2 * 4.5) - 0.011;
  outColor = vec4(vColor * max(w, 0.0), 1.0);
}`;

/** Shared header: projection to a flux-conserving splat. */
const SPLAT_COMMON = /* glsl */ `
${OCCLUDE_GLSL}
uniform vec3 uNucleus;      // camera-relative nucleus (three axes, AU)
uniform vec3 uSunRel;       // camera-relative Sun
uniform float uPixelAngle;  // rad per device px
uniform float uMaxSize;
uniform float uBright;      // display scale (÷ exposure)
out vec3 vColor;
// Place a splat: world position p (camera-relative), world σ (AU) and world flux (radiance × AU²).
// Peak radiance = F / (2π σ_w²) — independent of distance, as surface brightness must be; when the
// sprite hits its size limits the pixel flux F / (d·pixelAngle)² is conserved instead.
void splat(vec3 p, float sigmaW, vec3 flux) {
  if (occlusion(p) > 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vColor = vec3(0.0); return; }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = max(-mv.z, 1e-12);
  float sigPx = sigmaW / (d * uPixelAngle);
  // Sprite radius = 3σ, at least 1.5 px, at most the hardware limit.
  float size = clamp(6.0 * sigPx, 3.0, uMaxSize);
  gl_PointSize = size;
  float s = size / 6.0;
  // Energy normalisation of the truncated Gaussian: ∫ = 2π s² (1 − e^{-4.5}) ≈ 2π s² · 0.95.
  float dp = d * uPixelAngle;
  vColor = flux / (dp * dp) * uBright / (6.2832 * s * s * 0.95);
  if (-mv.z <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; }
}
// Henyey–Greenstein phase (normalised to 1 at 90°), mixed with isotropic.
float hgPhase(vec3 p, float g) {
  vec3 din = normalize(p - uSunRel);
  vec3 dout = -normalize(p);
  float c = dot(din, dout);
  float hg = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * c, 1.5);
  float hg90 = (1.0 - g * g) / pow(1.0 + g * g, 1.5);
  return 0.35 + 0.65 * hg / hg90;
}
`;

const DUST_VERT = /* glsl */ `
precision highp float;
precision highp sampler2D;
${COMMON_GLSL}
${SPLAT_COMMON}
in vec4 aRand;   // u_age, u_beta, ejection dir (2)
in vec4 aRand2;  // gauss-ish (3), brightness jitter
uniform sampler2D uGrid;   // BETAS × AGES: xyz = offset from nucleus (three axes), w = r at release
uniform float uMaxAge;
uniform float uLogBMin;
uniform float uLogBMax;
uniform float uEject;      // ejection speed at β = 0.1 (AU/day)
uniform float uFlux;       // total dust flux (display)
uniform float uRN;         // heliocentric distance of the nucleus
uniform float uSizeW;      // splat σ at the head (AU)
uniform float uCount;
uniform vec3 uSunDir;      // unit, nucleus → Sun
uniform vec3 uTint;
uniform float uSoft;
uniform float uM1;
uniform float uK1;
uniform float uNorm;       // display normalisation: A_display / production now

vec4 grid(float fj, float fi) {
  fj = clamp(fj, 0.0, float(${BETAS - 1}) - 0.0001);
  fi = clamp(fi, 0.0, float(${AGES - 1}) - 0.0001);
  int j = int(floor(fj)); int i = int(floor(fi));
  float tj = fj - float(j), ti = fi - float(i);
  vec4 a = texelFetch(uGrid, ivec2(j, i), 0);
  vec4 b = texelFetch(uGrid, ivec2(j + 1, i), 0);
  vec4 c = texelFetch(uGrid, ivec2(j, i + 1), 0);
  vec4 d = texelFetch(uGrid, ivec2(j + 1, i + 1), 0);
  return mix(mix(a, b, tj), mix(c, d, tj), ti);
}

void main() {
  // Age uniform in time (steady release, weighted by production below), β log-uniform.
  float ageF = aRand.x;
  float age = uMaxAge * ageF;
  float fi = float(${AGES - 1}) * pow(ageF, 1.0 / ${AGE_POW.toFixed(2)});
  float fj = float(${BETAS - 1}) * aRand.y;
  vec4 g = grid(fj, fi);
  float beta = exp(mix(uLogBMin, uLogBMax, aRand.y));
  // Ejection: a sunward-biased cone at v ∝ √β (Whipple 1951), drifting for the age days.
  float ph = aRand.z * 6.2832;
  float ct = aRand.w * 2.0 - 1.0;
  vec3 dir = vec3(sqrt(1.0 - ct * ct) * cos(ph), ct, sqrt(1.0 - ct * ct) * sin(ph));
  dir = normalize(dir + uSunDir * 0.7);
  float v = uEject * sqrt(beta / 0.1) * (0.4 + 0.6 * aRand2.w);
  vec3 off = g.xyz + dir * v * age * 0.35 + aRand2.xyz * uSizeW * 0.4;
  vec3 p = uNucleus + off;
  // Production at release (SBDB law, soft) and sunlight where the grain is now.
  float rRel = max(g.w, 0.01);
  float mag = uM1 + uK1 * log(rRel) / log(10.0);
  float prod = pow(10.0, -0.4 * uSoft * (mag - 5.5)) * uNorm;
  float rNow = length(p - uSunRel);
  float sun = pow(uRN / max(rNow, 1e-3), 2.0);
  // Scattering cross-section per log β ∝ β^{0.5} for dn/ds ∝ s^{-3.5}; sub-micron grains scatter poorly.
  float w = pow(beta / 0.1, 0.5) * (1.0 - smoothstep(0.35, 0.9, beta));
  // Grains spread out with age: splat grows so the sheet stays continuous.
  float sig = uSizeW * (0.5 + 5.0 * ageF) * (0.7 + 0.6 * aRand2.w);
  float F = uFlux * prod * sun * w * hgPhase(p, 0.6) / uCount;
  splat(p, sig, uTint * F);
}`;

const ION_VERT = /* glsl */ `
precision highp float;
${COMMON_GLSL}
${SPLAT_COMMON}
in vec4 aRand;   // u_age, ray pick, lateral gauss (2)
in vec4 aRand2;
uniform vec4 uIon[${ION_N}];   // xyz = offset from nucleus (three axes), w = r at release
uniform vec3 uE1;
uniform vec3 uE2;
uniform float uFlux;
uniform float uCount;
uniform float uWidth;       // tail half-width scale (AU)
uniform float uJD;
uniform float uSeed;
uniform float uSizeW;
uniform float uSoft;
uniform float uM1;
uniform float uK1;
uniform float uNorm;
uniform vec3 uTint;

void main() {
  float ageF = aRand.x;
  float age = ${ION_MAX_AGE.toFixed(2)} * ageF;
  float fi = float(${ION_N - 1}) * pow(ageF, 1.0 / ${AGE_POW.toFixed(2)});
  fi = clamp(fi, 0.0, float(${ION_N - 1}) - 0.0001);
  int i = int(floor(fi));
  vec4 g = mix(uIon[i], uIon[i + 1], fi - float(i));
  // Magnetic-field-aligned rays: a few discrete streamers that fan out with age...
  float ray = floor(aRand.y * 9.0);
  float rph = hash11(ray * 1.37 + uSeed) * 6.2832;
  float rr = (0.15 + 0.85 * hash11(ray * 7.91 + uSeed)) * (ray < 1.0 ? 0.0 : 1.0);
  vec2 lat = vec2(cos(rph), sin(rph)) * rr + aRand.zw * (ray < 1.0 ? 0.3 : 0.12);
  // ...and kinks carried outward with the plasma: phase fixed to the release time t − τ.
  float tr = uJD - age;
  float kink = sin(tr * 6.2832 / 0.9 + uSeed) * 0.6 + sin(tr * 6.2832 / 0.37 + uSeed * 2.1) * 0.3;
  float wAge = uWidth * (0.08 + 1.2 * ageF);
  vec3 off = g.xyz + (uE1 * (lat.x + kink * ageF) + uE2 * lat.y) * wAge;
  vec3 p = uNucleus + off;
  float rRel = max(g.w, 0.01);
  float mag = uM1 + uK1 * log(rRel) / log(10.0);
  float prod = pow(10.0, -0.4 * uSoft * (mag - 5.5)) * uNorm;
  // Ions fluoresce ∝ r⁻² and are lost by recombination/escape: weight decays with age.
  float fade = exp(-ageF * 1.6) * (0.75 + 0.5 * aRand2.w);
  float sig = uSizeW * (0.35 + 2.5 * ageF);
  float F = uFlux * prod * fade / uCount;
  splat(p, sig, uTint * F);
}`;

const COMA_VERT = /* glsl */ `
precision highp float;
${COMMON_GLSL}
${SPLAT_COMMON}
in vec4 aRand;   // u_time, dir (2), species
in vec4 aRand2;
uniform float uFlux;
uniform float uCount;
uniform float uApex;       // fountain apex distance (AU)
uniform vec3 uSunDir;
uniform vec3 uGas;
uniform vec3 uDust;
void main() {
  // Isotropic outflow at speed v for time t, pushed anti-sunward by a = v²/(2 R_apex):
  // r(t) = v t n̂ − ½ a t² ŝ. Uniform t ⇒ column density ∝ 1/ρ (Haser without decay).
  float t = aRand.x * 3.0;            // in units of R_apex / v
  float ph = aRand.y * 6.2832;
  float ct = aRand.z * 2.0 - 1.0;
  vec3 n = vec3(sqrt(1.0 - ct * ct) * cos(ph), ct, sqrt(1.0 - ct * ct) * sin(ph));
  vec3 off = (n * t - uSunDir * 0.25 * t * t) * uApex;
  vec3 p = uNucleus + off;
  bool gas = aRand.w < 0.62;
  float sig = uApex * (0.06 + 0.22 * aRand.x) * (0.6 + 0.8 * aRand2.w);
  // Photodissociation: C₂ radicals fade over the outer coma (Haser daughter scale).
  float life = gas ? exp(-t / 2.2) : 1.0;
  vec3 col = gas ? uGas : uDust * hgPhase(p, 0.6) * 0.8;
  splat(p, sig, col * uFlux * life / uCount);
}`;

function randomGeometry(n: number, seed: number): THREE.BufferGeometry {
  let s = seed >>> 0 || 1;
  const rnd = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) + 0.5) / 4294967296;
  };
  const gauss = () => {
    const u = rnd(), v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(6.2831853 * v);
  };
  const a = new Float32Array(n * 4);
  const b = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    a[i * 4] = rnd();
    a[i * 4 + 1] = rnd();
    a[i * 4 + 2] = rnd();
    a[i * 4 + 3] = rnd();
    b[i * 4] = gauss();
    b[i * 4 + 1] = gauss();
    b[i * 4 + 2] = gauss();
    b[i * 4 + 3] = rnd();
  }
  // Ion lateral offsets: gaussian in (z, w) — overwrite with gauss for a tighter core.
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute('aRand', new THREE.BufferAttribute(a, 4));
  g.setAttribute('aRand2', new THREE.BufferAttribute(b, 4));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e12);
  return g;
}

function ionGeometry(n: number, seed: number): THREE.BufferGeometry {
  const g = randomGeometry(n, seed);
  const a = g.getAttribute('aRand') as THREE.BufferAttribute;
  const b = g.getAttribute('aRand2') as THREE.BufferAttribute;
  for (let i = 0; i < n; i++) {
    a.setZ(i, b.getX(i) * 0.5);
    a.setW(i, b.getY(i) * 0.5);
  }
  return g;
}

interface Slot {
  body: SolarBody | null;
  grid: CometTailGrid;
  tex: THREE.DataTexture;
  texData: Float32Array;
  dust: THREE.Points;
  ion: THREE.Points;
  coma: THREE.Points;
  dustMat: THREE.ShaderMaterial;
  ionMat: THREE.ShaderMaterial;
  comaMat: THREE.ShaderMaterial;
  ages: Float64Array;
  maxAge: number;
}

export interface CometFrame {
  jd: number;
  sunRel: THREE.Vector3;
  pixelAngle: number;
  maxPointSize: number;
  exposure: number;
  selected: SolarBody | null;
  occ: Record<string, THREE.IUniform>;
}

export interface CometCandidate {
  body: SolarBody;
  rel: THREE.Vector3;
  dist: number;
}

const _r = new THREE.Vector3();
const _v = new THREE.Vector3();
const _ax = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();
const _s = new THREE.Vector3();
const astroToThree = (x: number, y: number, z: number, out: THREE.Vector3) => out.set(x, z, -y);

export class CometTails {
  readonly object = new THREE.Group();
  private slots: Slot[] = [];
  private betas = dustBetas(BETAS);
  private ionAges = tailAges(ION_N, ION_MAX_AGE, AGE_POW);
  private cands: Array<{ c: CometCandidate; score: number }> = [];
  private geos: THREE.BufferGeometry[] = [];
  /** Brightness multiplier (display). */
  brightness = 1;

  constructor(detail: number, shared: Record<string, THREE.IUniform>) {
    const nDust = Math.round(26000 * detail);
    const nIon = Math.round(12000 * detail);
    const nComa = Math.round(9000 * detail);
    const dustGeo = randomGeometry(nDust, 17);
    const ionGeo = ionGeometry(nIon, 29);
    const comaGeo = randomGeometry(nComa, 43);
    this.geos.push(dustGeo, ionGeo, comaGeo);
    const common = () => ({
      uNucleus: { value: new THREE.Vector3() },
      uSunRel: { value: new THREE.Vector3() },
      uPixelAngle: { value: 1e-3 },
      uMaxSize: { value: 64 },
      uBright: { value: 1 },
      uFlux: { value: 0 },
      ...shared,
    });
    const mk = (vert: string, uniforms: Record<string, THREE.IUniform>) =>
      new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: vert,
        fragmentShader: SPLAT_FRAG,
        uniforms,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
    for (let k = 0; k < MAX_ACTIVE; k++) {
      const texData = new Float32Array(BETAS * AGES * 4);
      const tex = new THREE.DataTexture(texData, BETAS, AGES, THREE.RGBAFormat, THREE.FloatType);
      tex.minFilter = tex.magFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
      tex.needsUpdate = true;
      const dustMat = mk(DUST_VERT, {
        ...common(),
        uGrid: { value: tex },
        uMaxAge: { value: 30 },
        uLogBMin: { value: Math.log(this.betas[0]) },
        uLogBMax: { value: Math.log(this.betas[BETAS - 1]) },
        uEject: { value: 0.3 * KMS_TO_AUD },
        uRN: { value: 1 },
        uSizeW: { value: 1e-4 },
        uCount: { value: nDust },
        uSunDir: { value: new THREE.Vector3() },
        uTint: { value: DUST_RGB.clone() },
        uSoft: { value: 0.3 },
        uM1: { value: 5 },
        uK1: { value: 10 },
        uNorm: { value: 1 },
      });
      const ionMat = mk(ION_VERT, {
        ...common(),
        uIon: { value: Array.from({ length: ION_N }, () => new THREE.Vector4()) },
        uE1: { value: new THREE.Vector3() },
        uE2: { value: new THREE.Vector3() },
        uCount: { value: nIon },
        uWidth: { value: 1e-3 },
        uJD: { value: 0 },
        uSeed: { value: k * 3.1 },
        uSizeW: { value: 1e-4 },
        uSoft: { value: 0.3 },
        uM1: { value: 5 },
        uK1: { value: 10 },
        uNorm: { value: 1 },
        uTint: { value: ION_RGB.clone() },
      });
      const comaMat = mk(COMA_VERT, {
        ...common(),
        uCount: { value: nComa },
        uApex: { value: 1e-3 },
        uSunDir: { value: new THREE.Vector3() },
        uGas: { value: GAS_RGB.clone() },
        uDust: { value: DUST_RGB.clone() },
      });
      const dust = new THREE.Points(dustGeo, dustMat);
      const ion = new THREE.Points(ionGeo, ionMat);
      const coma = new THREE.Points(comaGeo, comaMat);
      for (const o of [dust, ion, coma]) {
        o.frustumCulled = false;
        o.visible = false;
        o.renderOrder = 2;
        this.object.add(o);
      }
      this.slots.push({
        body: null,
        grid: makeTailGrid(AGES, BETAS, ION_N),
        tex,
        texData,
        dust,
        ion,
        coma,
        dustMat,
        ionMat,
        comaMat,
        ages: tailAges(AGES, 30, AGE_POW),
        maxAge: 30,
      });
    }
  }

  /** Choose which comets get tails this frame and update them. */
  update(cands: CometCandidate[], n: number, f: CometFrame): void {
    const list = this.cands;
    list.length = 0;
    for (let i = 0; i < n; i++) {
      const c = cands[i];
      const cp = c.body.def.comet;
      if (!cp) continue;
      const A = cometActivity(cp, c.body.sunDistance);
      if (A <= 1e-3) continue;
      // Rough apparent tail size in px × activity.
      const tailPx = (0.05 + 0.25 * Math.sqrt(A)) / Math.max(c.dist, 1e-6) / f.pixelAngle;
      if (tailPx < 3 && c.body !== f.selected) continue;
      list.push({ c, score: (c.body === f.selected ? 1e9 : 0) + Math.min(tailPx, 1e4) * A });
    }
    list.sort((a, b) => b.score - a.score);
    const chosen = list.length > MAX_ACTIVE ? MAX_ACTIVE : list.length;
    // Keep assignments stable: comets already in a slot stay there.
    for (const s of this.slots) {
      let keep = false;
      for (let i = 0; i < chosen; i++) if (list[i].c.body === s.body) keep = true;
      if (!keep) s.body = null;
    }
    for (let i = 0; i < chosen; i++) {
      const c = list[i].c;
      let slot = this.slots.find((s) => s.body === c.body);
      if (!slot) {
        slot = this.slots.find((s) => s.body === null)!;
        slot.body = c.body;
      }
      this.updateSlot(slot, c, f);
    }
    for (const s of this.slots) {
      const on = s.body !== null;
      s.dust.visible = on && s.dust.visible;
      s.ion.visible = on && s.ion.visible;
      s.coma.visible = on && s.coma.visible;
      if (!on) s.dust.visible = s.ion.visible = s.coma.visible = false;
    }
  }

  private updateSlot(s: Slot, c: CometCandidate, f: CometFrame): void {
    const b = c.body;
    const cp = b.def.comet!;
    const el = b.conic!;
    const r = b.sunDistance;
    const A = cometActivity(cp, r);
    // Ages for this comet (dusty comets keep old dust in view).
    const maxAge = dustMaxAge(cp);
    if (maxAge !== s.maxAge) {
      s.maxAge = maxAge;
      s.ages = tailAges(AGES, maxAge, AGE_POW);
    }
    computeTailGrid(el, f.jd, s.ages, this.betas, this.ionAges, s.grid);
    // Upload the dust grid (astro → three axes) with the release distance in w.
    const g = s.grid;
    const td = s.texData;
    for (let i = 0; i < AGES; i++) {
      for (let j = 0; j < BETAS; j++) {
        const k = (i * BETAS + j) * 3;
        const t = (i * BETAS + j) * 4;
        td[t] = g.dust[k];
        td[t + 1] = g.dust[k + 2];
        td[t + 2] = -g.dust[k + 1];
        td[t + 3] = g.releaseR[i];
      }
    }
    s.tex.needsUpdate = true;
    const ionU = s.ionMat.uniforms.uIon.value as THREE.Vector4[];
    for (let i = 0; i < ION_N; i++) ionU[i].set(g.ion[i * 3], g.ion[i * 3 + 2], -g.ion[i * 3 + 1], g.ionReleaseR[i]);
    // Tail axis & its perpendiculars (three axes).
    conicState(el, f.jd, _r, _v);
    ionTailAxis(_r, _v, _s);
    astroToThree(_s.x, _s.y, _s.z, _ax);
    _e1.set(0, 1, 0).cross(_ax);
    if (_e1.lengthSq() < 1e-8) _e1.set(1, 0, 0).cross(_ax);
    _e1.normalize();
    _e2.crossVectors(_ax, _e1).normalize();
    const sunDir = _s.copy(b.position).negate().normalize();

    const expo = Math.max(1e-6, f.exposure);
    const bright = this.brightness / expo;
    const nuc = c.rel;
    const soft = 0.42;
    const dustiness = cp.dust;
    // Display brightness: the comet's current production, compressed and capped (a camera would
    // expose for a great comet; faint ones stay faint). The shaders keep the *relative* production
    // at each parcel's release, so tails still brighten toward perihelion.
    const prodNow = cometActivity(cp, r, soft);
    const Adisp = Math.min(1.25, 0.34 * Math.sqrt(prodNow));
    const norm = prodNow > 0 ? Adisp / prodNow : 0;
    // Characteristic scales (AU).
    const vGas = gasSpeedKms(r);
    const apexKm = 6e4 * Math.pow(A, 0.7) * Math.sqrt(vGas / 0.85);
    const apex = apexKm * KM_AU;
    const tailLen = Math.hypot(g.dust[(AGES - 1) * BETAS * 3 + (BETAS - 1) * 3], g.dust[(AGES - 1) * BETAS * 3 + (BETAS - 1) * 3 + 1], g.dust[(AGES - 1) * BETAS * 3 + (BETAS - 1) * 3 + 2]);
    const ionLen = Math.hypot(g.ion[(ION_N - 1) * 3], g.ion[(ION_N - 1) * 3 + 1], g.ion[(ION_N - 1) * 3 + 2]);

    const setCommon = (m: THREE.ShaderMaterial) => {
      const u = m.uniforms;
      (u.uNucleus.value as THREE.Vector3).copy(nuc);
      (u.uSunRel.value as THREE.Vector3).copy(f.sunRel);
      u.uPixelAngle.value = f.pixelAngle;
      u.uMaxSize.value = f.maxPointSize;
      u.uBright.value = bright;
    };
    // Dust.
    {
      const m = s.dustMat;
      setCommon(m);
      const u = m.uniforms;
      u.uMaxAge.value = maxAge;
      u.uRN.value = r;
      u.uSizeW.value = Math.max(apex * 0.5, tailLen * 0.004);
      (u.uSunDir.value as THREE.Vector3).copy(sunDir);
      u.uSoft.value = soft;
      u.uM1.value = cp.M1;
      u.uK1.value = cp.K1;
      u.uNorm.value = norm;
      // World flux = target surface brightness × tail area (the fan covers ~ ¼ tailLen²).
      u.uFlux.value = 1.6 * dustiness * Math.max(tailLen * tailLen * 0.25, apex * apex * 20);
      s.dust.visible = dustiness > 0.02;
    }
    // Ions.
    {
      const m = s.ionMat;
      setCommon(m);
      const u = m.uniforms;
      (u.uE1.value as THREE.Vector3).copy(_e1);
      (u.uE2.value as THREE.Vector3).copy(_e2);
      u.uWidth.value = Math.max(ionLen * 0.035, apex * 1.5);
      u.uJD.value = f.jd;
      u.uSizeW.value = Math.max(ionLen * 0.004, apex * 0.3);
      u.uSoft.value = soft;
      u.uM1.value = cp.M1;
      u.uK1.value = cp.K1;
      u.uNorm.value = norm;
      // Gas-rich comets have brighter plasma tails; the solar wind needs r ≲ 2 AU for bright CO⁺.
      const ionOn = 1 - THREE.MathUtils.smoothstep(r, 1.6, 3.2);
      u.uFlux.value = 0.9 * Math.sqrt(Adisp / 1.25) * (1.15 - 0.7 * dustiness) * ionOn * Math.max(ionLen, 1e-4) * (u.uWidth.value as number) * 1.5;
      s.ion.visible = ionOn > 0.01;
    }
    // Coma.
    {
      const m = s.comaMat;
      setCommon(m);
      const u = m.uniforms;
      u.uApex.value = apex;
      (u.uSunDir.value as THREE.Vector3).copy(sunDir);
      u.uFlux.value = 5 * Adisp * Math.PI * 4 * apex * apex;
      s.coma.visible = true;
    }
  }

  dispose(): void {
    for (const s of this.slots) {
      s.tex.dispose();
      s.dustMat.dispose();
      s.ionMat.dispose();
      s.comaMat.dispose();
    }
    for (const g of this.geos) g.dispose();
  }
}
