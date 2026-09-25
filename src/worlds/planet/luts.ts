import * as THREE from 'three';
import { FULLSCREEN_VERT } from '../../core/post/FullscreenQuad';
import { COMMON_GLSL } from '../../shaders/lib/common';
import type { AtmosphereRenderParams } from '../../physics/planets-atmosphere';
import { ATMO_GLSL, ATMO_LOOKUP_GLSL } from './glsl';

/**
 * Precomputed atmosphere look-up tables, generated on the GPU once per unique atmosphere:
 *  - transmittance to the top of the atmosphere, T(r, μ)            256 × 64  (Bruneton 2017)
 *  - isotropic multiple-scattering contribution Ψ_ms(r, μ_s)        32 × 32   (Hillaire 2020, §5.5)
 *  - sky irradiance on a horizontal surface E_sky(r, μ_s)          64 × 16
 * All per unit *true* solar irradiance. Shared between planets with identical parameters.
 *
 * Portability: the tables are RGBA16F render targets (EXT_color_buffer_float or _half_float; half
 * floats are filterable in core WebGL2). Where those are not renderable the framebuffer is
 * incomplete and the tables would silently stay zero — a black planet — so generateLUTs checks and
 * falls back to RGBA8 targets storing sqrt(value / LUT_SCALE) (uLutEnc = 1).
 */
/** Encoding ranges for the RGBA8 fallback: transmittance, multiple scattering, sky irradiance. */
export const LUT_SCALE: readonly [number, number, number] = [1, 4, 2];

const TRANS_FRAG = /* glsl */ `
precision highp float;
${COMMON_GLSL}
${ATMO_GLSL}
out vec4 outColor;
void main() {
  vec2 uv = gl_FragCoord.xy / vec2(TRANS_W, TRANS_H);
  float xm = clamp((uv.x - 0.5 / TRANS_W) / (1.0 - 1.0 / TRANS_W), 0.0, 1.0);
  float xr = clamp((uv.y - 0.5 / TRANS_H) / (1.0 - 1.0 / TRANS_H), 0.0, 1.0);
  float H = sqrt(uTop * uTop - 1.0);
  float rho = H * xr;
  float r = sqrt(rho * rho + 1.0);
  float dmin = uTop - r;
  float dmax = rho + H;
  float d = dmin + xm * (dmax - dmin);
  float mu = d <= 0.0 ? 1.0 : clamp((H * H - rho * rho - d * d) / (2.0 * r * d), -1.0, 1.0);
  float dist = distToTop(r, mu);
  const int N = 80;
  float dt = dist / float(N);
  vec3 tau = vec3(0.0);
  for (int i = 0; i < N; i++) {
    float t = (float(i) + 0.5) * dt;
    float ri = sqrt(max(r * r + t * t + 2.0 * r * mu * t, 0.0));
    vec3 dn = atmoDensity(ri - 1.0);
    tau += (uRay * dn.x + uMieE * dn.y + uAbsorb * dn.z) * dt;
  }
  outColor = vec4(lutEncode(exp(-tau), uLutScale.x), 1.0);
}`;

const MS_FRAG = /* glsl */ `
precision highp float;
${COMMON_GLSL}
${ATMO_GLSL}
${ATMO_LOOKUP_GLSL}
out vec4 outColor;
void main() {
  vec2 uv = gl_FragCoord.xy / vec2(MS_W, MS_H);
  float x = clamp((uv.x - 0.5 / MS_W) / (1.0 - 1.0 / MS_W), 0.0, 1.0);
  float y = clamp((uv.y - 0.5 / MS_H) / (1.0 - 1.0 / MS_H), 0.0, 1.0);
  float muS = x * 2.0 - 1.0;
  float r = 1.0 + clamp(y, 1e-3, 0.999) * (uTop - 1.0);
  vec3 sunDir = vec3(sqrt(max(0.0, 1.0 - muS * muS)), muS, 0.0);
  vec3 p0 = vec3(0.0, r, 0.0);
  vec3 Lsum = vec3(0.0);
  vec3 Fsum = vec3(0.0);
  const int SQ = 8;
  const int N = 20;
  for (int i = 0; i < SQ; i++) {
    for (int j = 0; j < SQ; j++) {
      float ct = 1.0 - 2.0 * (float(i) + 0.5) / float(SQ);
      float st = sqrt(max(0.0, 1.0 - ct * ct));
      float ph = TAU * (float(j) + 0.5) / float(SQ);
      vec3 dir = vec3(st * cos(ph), ct, st * sin(ph));
      vec2 top = raySphere(p0, dir, vec3(0.0), uTop);
      vec2 g = raySphere(p0, dir, vec3(0.0), 1.0);
      bool hitG = g.x <= g.y && g.x > 0.0;
      float tMax = hitG ? g.x : max(top.y, 0.0);
      float dt = tMax / float(N);
      vec3 T = vec3(1.0), L = vec3(0.0), F = vec3(0.0);
      for (int k = 0; k < N; k++) {
        vec3 p = p0 + dir * ((float(k) + 0.5) * dt);
        float rr = length(p);
        vec3 dn = atmoDensity(rr - 1.0);
        vec3 sigS = uRay * dn.x + uMieS * dn.y;
        vec3 sigT = uRay * dn.x + uMieE * dn.y + uAbsorb * dn.z;
        float mu = dot(p, sunDir) / rr;
        vec3 S = sigS * sunTransmittance(rr, mu) * (1.0 / (4.0 * PI));
        vec3 Ts = exp(-sigT * dt);
        vec3 inv = 1.0 / max(sigT, vec3(1e-9));
        L += T * (S - S * Ts) * inv;
        F += T * (sigS - sigS * Ts) * inv;
        T *= Ts;
      }
      if (hitG) {
        vec3 pg = normalize(p0 + dir * tMax);
        float mg = dot(pg, sunDir);
        L += T * sunTransmittance(1.0, mg) * max(mg, 0.0) * uGroundAlbedo / PI;
      }
      Lsum += L;
      Fsum += F;
    }
  }
  float n = float(SQ * SQ);
  Lsum /= n;
  Fsum /= n;
  outColor = vec4(lutEncode(Lsum / max(vec3(1.0) - Fsum, vec3(0.05)), uLutScale.y), 1.0);
}`;

const IRR_FRAG = /* glsl */ `
precision highp float;
${COMMON_GLSL}
${ATMO_GLSL}
${ATMO_LOOKUP_GLSL}
out vec4 outColor;
void main() {
  vec2 uv = gl_FragCoord.xy / vec2(IRR_W, IRR_H);
  float x = clamp((uv.x - 0.5 / IRR_W) / (1.0 - 1.0 / IRR_W), 0.0, 1.0);
  float y = clamp((uv.y - 0.5 / IRR_H) / (1.0 - 1.0 / IRR_H), 0.0, 1.0);
  float muS = x * 2.0 - 1.0;
  float r = 1.0 + clamp(y, 1e-4, 0.999) * (uTop - 1.0);
  vec3 sunDir = vec3(sqrt(max(0.0, 1.0 - muS * muS)), muS, 0.0);
  vec3 p0 = vec3(0.0, r, 0.0);
  vec3 E = vec3(0.0);
  const int NI = 6;
  const int NJ = 8;
  const int N = 16;
  for (int i = 0; i < NI; i++) {
    for (int j = 0; j < NJ; j++) {
      // Cosine-weighted hemisphere: E = π · mean(L).
      float u1 = (float(i) + 0.5) / float(NI);
      float u2 = (float(j) + 0.5) / float(NJ);
      float st = sqrt(u1);
      float ct = sqrt(1.0 - u1);
      float ph = TAU * u2;
      vec3 dir = vec3(st * cos(ph), ct, st * sin(ph));
      float tMax = max(raySphere(p0, dir, vec3(0.0), uTop).y, 0.0);
      float dt = tMax / float(N);
      float c = dot(dir, sunDir);
      float pR = phaseRayleigh(c);
      vec3 pM = vec3(phaseHG(c, uMieG.x), phaseHG(c, uMieG.y), phaseHG(c, uMieG.z));
      vec3 T = vec3(1.0), L = vec3(0.0);
      for (int k = 0; k < N; k++) {
        vec3 p = p0 + dir * ((float(k) + 0.5) * dt);
        float rr = length(p);
        vec3 dn = atmoDensity(rr - 1.0);
        vec3 sR = uRay * dn.x;
        vec3 sM = uMieS * dn.y;
        vec3 sigT = sR + uMieE * dn.y + uAbsorb * dn.z;
        float mu = dot(p, sunDir) / rr;
        vec3 S = (sR * pR + sM * pM) * sunTransmittance(rr, mu) + (sR + sM) * msLookup(rr, mu);
        vec3 Ts = exp(-sigT * dt);
        L += T * (S - S * Ts) / max(sigT, vec3(1e-9));
        T *= Ts;
      }
      E += L;
    }
  }
  outColor = vec4(lutEncode(PI * E / float(NI * NJ), uLutScale.z), 1.0);
}`;

export interface AtmosphereLUTs {
  key: string;
  transmittance: THREE.WebGLRenderTarget;
  multiScatter: THREE.WebGLRenderTarget;
  irradiance: THREE.WebGLRenderTarget;
  /** True when the tables fell back to sqrt-encoded RGBA8 (no renderable half floats). */
  encoded: boolean;
  /** Uniform values describing the atmosphere (shared objects; merge into materials). */
  uniforms: Record<string, THREE.IUniform>;
  ready: boolean;
  refs: number;
}

const cache = new Map<string, AtmosphereLUTs>();

function makeTarget(w: number, h: number, type: THREE.TextureDataType = THREE.HalfFloatType): THREE.WebGLRenderTarget {
  const t = new THREE.WebGLRenderTarget(w, h, {
    type,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  t.texture.name = 'planet-atmo-lut';
  return t;
}

const v3 = (a: [number, number, number]) => new THREE.Vector3(a[0], a[1], a[2]);

/** Uniform set for an atmosphere (the LUT samplers are filled when generated). */
export function atmosphereUniforms(a: AtmosphereRenderParams, sunAngularRadius = 0.00465): Record<string, THREE.IUniform> {
  return {
    uTop: { value: a.top },
    uRay: { value: v3(a.rayleigh) },
    uRayH: { value: a.rayleighH },
    uMieS: { value: v3(a.mieScattering) },
    uMieE: { value: v3(a.mieExtinction) },
    uMieH: { value: a.mieH },
    uMieG: { value: v3(a.mieG) },
    uAbsorb: { value: v3(a.absorption) },
    uAbsC: { value: a.absorptionCenter },
    uAbsW: { value: Math.max(a.absorptionWidth, 1e-6) },
    uGroundAlbedo: { value: v3(a.groundAlbedo) },
    uSunAng: { value: sunAngularRadius },
    uTransLUT: { value: null },
    uMSLUT: { value: null },
    uIrrLUT: { value: null },
    uLutEnc: { value: 0 },
    uLutScale: { value: new THREE.Vector3(...LUT_SCALE) },
  };
}

const keyOf = (a: AtmosphereRenderParams) =>
  JSON.stringify([a.top, a.rayleigh, a.rayleighH, a.mieScattering, a.mieExtinction, a.mieH, a.mieG, a.absorption, a.absorptionCenter, a.absorptionWidth, a.groundAlbedo].flat().map((x) => +Number(x).toPrecision(6)));

/** Get (or create) the shared LUT set for an atmosphere. Call `release` when done. */
export function acquireLUTs(a: AtmosphereRenderParams): AtmosphereLUTs {
  const key = keyOf(a);
  let e = cache.get(key);
  if (!e) {
    e = {
      key,
      transmittance: makeTarget(256, 64),
      multiScatter: makeTarget(32, 32),
      irradiance: makeTarget(64, 16),
      encoded: false,
      uniforms: atmosphereUniforms(a, 0.00465),
      ready: false,
      refs: 0,
    };
    e.uniforms.uTransLUT.value = e.transmittance.texture;
    e.uniforms.uMSLUT.value = e.multiScatter.texture;
    e.uniforms.uIrrLUT.value = e.irradiance.texture;
    cache.set(key, e);
  }
  e.refs++;
  return e;
}

export function releaseLUTs(e: AtmosphereLUTs): void {
  e.refs--;
  if (e.refs <= 0) {
    e.transmittance.dispose();
    e.multiScatter.dispose();
    e.irradiance.dispose();
    cache.delete(e.key);
  }
}

/** Render the three tables (idempotent). Safe to call from inside onBeforeRender. */
export function generateLUTs(renderer: THREE.WebGLRenderer, e: AtmosphereLUTs): void {
  if (e.ready) return;
  const prevTarget = renderer.getRenderTarget();
  const prevFace = renderer.getActiveCubeFace();
  const prevMip = renderer.getActiveMipmapLevel();
  if (!e.encoded && !halfFloatRenderable(renderer, e.transmittance)) {
    // Fall back to sqrt-encoded RGBA8 tables (see LUT_SCALE).
    for (const t of [e.transmittance, e.multiScatter, e.irradiance]) t.dispose();
    e.transmittance = makeTarget(256, 64, THREE.UnsignedByteType);
    e.multiScatter = makeTarget(32, 32, THREE.UnsignedByteType);
    e.irradiance = makeTarget(64, 16, THREE.UnsignedByteType);
    e.uniforms.uTransLUT.value = e.transmittance.texture;
    e.uniforms.uMSLUT.value = e.multiScatter.texture;
    e.uniforms.uIrrLUT.value = e.irradiance.texture;
    e.uniforms.uLutEnc.value = 1;
    e.encoded = true;
    console.info('planet: half-float render targets unavailable; atmosphere tables use RGBA8');
  }
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  const mk = (frag: string) =>
    new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: frag,
      // A small but non-zero stellar radius keeps smoothstep() well defined; the target being
      // written is never bound as an input (no feedback loop).
      uniforms: { ...e.uniforms, uSunAng: { value: 0.002 }, uTransLUT: { value: frag === TRANS_FRAG ? null : e.transmittance.texture }, uMSLUT: { value: frag === TRANS_FRAG || frag === MS_FRAG ? null : e.multiScatter.texture }, uIrrLUT: { value: null } },
      depthTest: false,
      depthWrite: false,
    });
  const mats = [mk(TRANS_FRAG), mk(MS_FRAG), mk(IRR_FRAG)];
  const targets = [e.transmittance, e.multiScatter, e.irradiance];
  const mesh = new THREE.Mesh(geo, mats[0]);
  mesh.frustumCulled = false;
  scene.add(mesh);
  const prevXR = renderer.xr.enabled;
  renderer.xr.enabled = false;
  for (let i = 0; i < 3; i++) {
    mesh.material = mats[i];
    renderer.setRenderTarget(targets[i]);
    renderer.render(scene, camera);
  }
  renderer.xr.enabled = prevXR;
  renderer.setRenderTarget(prevTarget, prevFace, prevMip);
  for (const m of mats) m.dispose();
  geo.dispose();
  e.ready = true;
}

/** Whether `rt` (a half-float target) can be rendered to on this device. */
function halfFloatRenderable(renderer: THREE.WebGLRenderer, rt: THREE.WebGLRenderTarget): boolean {
  const ext = renderer.extensions;
  if (ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float')) return true;
  const gl = renderer.getContext();
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(rt);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  renderer.setRenderTarget(prev);
  return ok;
}
