import { COMMON_GLSL } from '../../../shaders/lib/common';
import { NEBULA_COMMON_GLSL } from './common';

/**
 * Ray-marched radiative transfer through the baked nebula.
 *
 * Along each view ray, front to back, we integrate
 *   dI_line/ds = j_line(s) · e^{−τ_V(s) k_line},   dτ_V/ds = σ_V(s),
 * for eight emission lines (Hα, Hβ, Hγ, [OIII], [NII], [SII], He I, He II), where k_line = A_λ/A_V
 * from the CCM89 law at each line's wavelength group, plus a continuum (dust-scattered starlight
 * with a Henyey–Greenstein phase function, synchrotron). Lines stay separate until the very end,
 * where a 8 → RGB palette matrix turns them into true colour or a narrowband (Hubble) palette.
 *
 * Emissivities come from the bake: n_eff² = Γ/α_B (photon-conserving recombination rate), times
 * Case-B ratios for the Balmer lines and zone-dependent ratios for the metals:
 *   [OIII] where C < C(O²⁺) (hard photons), He II where C < C(He²⁺), [NII] outside the O²⁺ zone,
 *   [SII] in the partially ionized skin around the front (ξ = ln C ≈ 0), He I in the He⁺ zone.
 * Units: accumulators are emission measures (pc cm⁻⁶) weighted by line strength relative to Hβ;
 * scattered light is expressed in the same units (see NebulaVolume.starRGB).
 *
 * Stratified jitter along the ray (interleaved gradient noise + golden-ratio sequence) and a
 * sub-pixel jitter make every frame an unbiased sample that the temporal resolve accumulates.
 */
export interface MarchDefines {
  layout: 'photo' | 'shock';
  /** Extra continuum emission (Crab synchrotron nebula, wisps). */
  synchrotron?: boolean;
  /** Output the raw line accumulators of one ray (the spectrograph probe). */
  probe?: boolean;
}

export function marchFragment(d: MarchDefines): string {
  const defs = [
    d.layout === 'shock' ? '#define SHOCK 1' : '#define PHOTO 1',
    d.synchrotron ? '#define SYNCHROTRON 1' : '',
    d.probe ? '#define PROBE 1' : '',
  ].join('\n');
  return /* glsl */ `
precision highp float;
precision highp sampler3D;
${defs}
${COMMON_GLSL}
${NEBULA_COMMON_GLSL}
#define MAX_STEPS 256

uniform sampler3D uField;
uniform sampler3D uDetail;
uniform vec2 uRes;
uniform vec2 uJitter;
uniform float uFrame;
uniform mat4 uProjInv;
uniform mat3 uViewToLocal;
uniform vec3 uCamLocal;
uniform float uHalf;
uniform float uExpand;
uniform int uSteps;
uniform float uNearScale;
uniform float uMaxT;

uniform vec2 uDetailFreq;
uniform vec3 uDrift1;
uniform vec3 uDrift2;
uniform float uTurb;
uniform float uFrontNoise;

uniform vec3 uLnZone;      // ln C at the edge of the He⁺, O²⁺, He²⁺ zones
uniform vec4 uRatiosA;     // Hα, Hβ, Hγ (Case B), [OIII]
uniform vec4 uRatiosB;     // [NII], [SII], He I, He II
uniform float uKappa;      // not used for photo (baked); ambient dust for shock
uniform float uIonDust;
uniform float uAlbedo;
uniform float uHG;
uniform vec3 uKScat;       // scattering efficiency per RGB channel relative to V
uniform vec3 uKExt;        // extinction per RGB channel relative to V (continuum)
uniform vec3 uKLine;       // extinction of the red / green / blue line groups relative to V
uniform vec3 uSource;
uniform vec3 uStarRGB;     // source luminosity in emission-measure units × colour
uniform int uScatCount;
uniform vec4 uScatPos[8];  // xyz, softening² (pc²)
uniform vec3 uScatRGB[8];
uniform float uEmission;   // global emission multiplier (fade in/out)

#ifdef SHOCK
uniform vec4 uSheetR;      // red sheet: offset, width, strength, _
uniform vec4 uSheetO;      // [OIII] sheet: offset, width, strength, _
uniform vec4 uSheetB;      // Balmer-dominated sheet: offset, width, strength, _
uniform float uRipple;     // sub-voxel corrugation amplitude (pc)
#endif
#ifdef SYNCHROTRON
uniform vec3 uSynAxes;     // semi-axes of the synchrotron nebula (pc)
uniform mat3 uSynRot;      // local → synchrotron frame
uniform vec3 uSynCore;     // colour × brightness at the centre
uniform vec3 uSynEdge;     // colour × brightness at the edge (spectral ageing → redder)
uniform vec4 uWisp;        // wisp ring radius, width, height, brightness
#endif

#ifdef PROBE
uniform vec2 uProbeNdc;
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;
layout(location = 2) out vec4 oC;
#else
uniform vec3 uColA[4];
uniform vec3 uColB[4];
uniform float uGain;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oAux;
#endif

struct Medium {
  vec4 eA;
  vec4 eB;
  vec3 cont;
  float sigma;
  vec4 sheet;   // shock: (d, red, [OIII], Balmer strengths)
};

Medium medium(vec3 p, vec3 rd) {
  Medium M;
  M.sheet = vec4(0.0);
  vec3 pc = p / uExpand;
  vec3 uvw = pc / (2.0 * uHalf) + 0.5;
  vec4 F = texture(uField, uvw);
  vec4 D1 = texture(uDetail, pc * uDetailFreq.x + uDrift1);
  vec4 D2 = texture(uDetail, pc * uDetailFreq.y + uDrift2);
#ifdef PHOTO
  float turb = (D1.r - 0.5) * 1.4 + (D2.g - 0.45) * 1.1;
  float m = exp(uTurb * turb);
  float xi = F.y + uFrontNoise * ((D1.a - 0.5) * 1.6 + (D2.r - 0.5) * 0.9);
  float g2 = F.z * F.z * m;
  float zH = 1.0 - smoothstep(-0.3, 0.3, xi);
  float zHe1 = 1.0 - smoothstep(uLnZone.x - 0.35, uLnZone.x + 0.35, xi);
  float zHe2 = 1.0 - smoothstep(uLnZone.z - 0.35, uLnZone.z + 0.35, xi);
  float zO3 = (1.0 - smoothstep(uLnZone.y - 0.35, uLnZone.y + 0.35, xi)) * (1.0 - 0.85 * zHe2);
  float zS2 = exp(-sq((xi + 0.25) / 0.85));
  M.eA = g2 * vec4(uRatiosA.xyz, uRatiosA.w * zO3);
  M.eB = g2 * vec4(uRatiosB.x * (1.0 - zO3) * (1.0 - zHe2), uRatiosB.y * zS2, uRatiosB.z * zHe1 * (1.0 - zHe2), uRatiosB.w * zHe2);
  float dust = F.x * m * uKappa * mix(1.0, uIonDust, zH);
  M.sigma = dust;
  vec3 sd = p - uSource * uExpand;
  float r2 = dot(sd, sd) + 1e-4;
  float cosT = dot(sd, -rd) * inversesqrt(r2);
  vec3 Tsrc = exp(-F.w * uKExt);
  M.cont = dust * uAlbedo * uKScat * uStarRGB * Tsrc * phaseHG(cosT, uHG) / r2;
#else
  // Shock layout: F = (ambient n, signed distance to the shell [pc, comoving], brightness, [OIII] share).
  float dist = (F.y + uRipple * ((D1.b - 0.5) * 1.3 + (D2.r - 0.5) * 0.7)) * uExpand;
  float bright = F.z * (0.35 + 1.3 * D1.g) * (0.6 + 0.8 * D2.b);
  M.sheet = vec4(dist, bright * uSheetR.z, bright * F.w * uSheetO.z, (0.5 + D2.a) * uSheetB.z * F.z);
  M.eA = vec4(0.0);
  M.eB = vec4(0.0);
  M.sigma = F.x * uKappa;
  M.cont = vec3(0.0);
#endif
  for (int i = 0; i < 8; i++) {
    if (i >= uScatCount) break;
    vec3 e = p - uScatPos[i].xyz;
    float q2 = dot(e, e) + uScatPos[i].w;
    float c2 = dot(e, -rd) * inversesqrt(q2);
    M.cont += M.sigma * uAlbedo * uKScat * uScatRGB[i] * phaseHG(c2, uHG) / q2;
  }
#ifdef SYNCHROTRON
  {
    vec3 q = uSynRot * p / (uSynAxes * uExpand);
    float e2 = dot(q, q);
    float core = exp(-e2 * 2.2);
    float fib = 0.55 + 0.9 * D1.b * D2.b + 0.25 * D2.g;
    float edge = smoothstep(0.15, 1.0, sqrt(e2));
    M.cont += core * fib * mix(uSynCore, uSynEdge, edge) * step(e2, 1.8);
    // Wisps: thin synchrotron arcs in the pulsar's equatorial plane.
    vec3 w = uSynRot * p / uExpand;
    float rho = length(w.xz);
    float wisp = exp(-sq((rho - uWisp.x) / uWisp.y)) * exp(-sq(w.y / uWisp.z)) * (0.4 + 1.2 * D2.b);
    M.cont += uWisp.w * wisp * uSynCore;
  }
#endif
  M.eA *= uEmission;
  M.eB *= uEmission;
  M.cont *= uEmission;
  return M;
}

void main() {
#ifdef PROBE
  vec2 ndc = uProbeNdc;
#else
  vec2 frag = gl_FragCoord.xy + uJitter;
  vec2 ndc = frag / uRes * 2.0 - 1.0;
#endif
  vec4 v = uProjInv * vec4(ndc, 1.0, 1.0);
  vec3 dirV = normalize(v.xyz / v.w);
  vec3 rd = normalize(uViewToLocal * dirV);
  vec3 ro = uCamLocal;
  float H = uHalf * uExpand;
  vec2 tb = rayBox(ro, rd, H);
  float tn = max(tb.x, 0.0);
  float tf = min(tb.y, uMaxT);
  vec4 accA = vec4(0.0);
  vec4 accB = vec4(0.0);
  vec3 cont = vec3(0.0);
  float tauV = 0.0;
  float wDepth = 0.0;
  float sDepth = 0.0;
  float tOpaque = -1.0;
  if (tf > tn) {
#ifdef PROBE
    float jit = 0.5;
#else
    float jit = fract(ign(gl_FragCoord.xy) + uFrame * 0.61803398875);
#endif
    float N = float(uSteps);
    float c = max(tn, uNearScale);
    float beta = max(log(1.0 + (tf - tn) / c), 1e-4);
    float eb = exp(beta) - 1.0;
    float tPrev = tn;
    float dPrev = 0.0;
    bool havePrev = false;
    for (int i = 0; i < MAX_STEPS; i++) {
      if (i >= uSteps) break;
      float u0 = float(i) / N;
      float u1 = (float(i) + 1.0) / N;
      float us = (float(i) + jit) / N;
      float ta = tn + (tf - tn) * (exp(beta * u0) - 1.0) / eb;
      float tb2 = tn + (tf - tn) * (exp(beta * u1) - 1.0) / eb;
      float ts = tn + (tf - tn) * (exp(beta * us) - 1.0) / eb;
      float dt = tb2 - ta;
      vec3 p = ro + rd * ts;
      Medium M = medium(p, rd);
      float dTau = M.sigma * dt;
      vec3 Tl = exp(-tauV * uKLine);
      vec3 wl = segW(dTau * uKLine) * Tl * dt;
      vec3 Tc = exp(-tauV * uKExt) * segW(dTau * uKExt) * dt;
      vec4 dA = M.eA * vec4(wl.x, wl.y, wl.z, wl.y);
      vec4 dB = M.eB * vec4(wl.x, wl.x, wl.y, wl.z);
      vec3 dC = M.cont * Tc;
#ifdef SHOCK
      if (havePrev) {
        float seg = ts - tPrev;
        float sR = sheetSeg(dPrev + uSheetR.x, M.sheet.x + uSheetR.x, seg, uSheetR.y) * M.sheet.y;
        float sO = sheetSeg(dPrev + uSheetO.x, M.sheet.x + uSheetO.x, seg, uSheetO.y) * M.sheet.z;
        float sB = sheetSeg(dPrev + uSheetB.x, M.sheet.x + uSheetB.x, seg, uSheetB.y) * M.sheet.w;
        vec3 Ts = exp(-tauV * uKLine);
        dA += vec4((sR + sB) * uRatiosA.x * Ts.x, (sR + sB) * uRatiosA.y * Ts.y, (sR + sB) * uRatiosA.z * Ts.z, sO * uRatiosA.w * Ts.y);
        dB += vec4(sR * uRatiosB.x * Ts.x, sR * uRatiosB.y * Ts.x, sR * uRatiosB.z * Ts.y, 0.0);
      }
      dPrev = M.sheet.x;
      havePrev = true;
      tPrev = ts;
#endif
      accA += dA;
      accB += dB;
      cont += dC;
      float lum = dA.x * 0.08 + dA.w * 0.3 + dB.x * 0.08 + dot(dC, vec3(0.3));
      wDepth += lum;
      sDepth += lum * ts;
      float tauNew = tauV + dTau;
      if (tOpaque < 0.0 && tauNew > 0.7) tOpaque = ts;
      tauV = tauNew;
      if (tauV > 9.0) break;
    }
  }
#ifdef PROBE
  oA = accA;
  oB = accB;
  oC = vec4(cont, tauV);
#else
  vec3 rgb = accA.x * uColA[0] + accA.y * uColA[1] + accA.z * uColA[2] + accA.w * uColA[3]
           + accB.x * uColB[0] + accB.y * uColB[1] + accB.z * uColB[2] + accB.w * uColB[3]
           + cont;
  rgb *= uGain;
  float T = exp(-tauV);
  float depth = wDepth > 0.0 ? sDepth / wDepth : (tf > tn ? 0.5 * (tn + tf) : 1e4);
  if (tOpaque > 0.0) depth = mix(depth, tOpaque, clamp(1.0 - T, 0.0, 1.0));
  oColor = vec4(max(rgb, 0.0), T);
  oAux = vec4(depth, 0.0, 0.0, 1.0);
#endif
}`;
}
