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
uniform vec3 uTexel;       // detail texel size (pc) of the two octaves; z = 1 / texels per tile
uniform float uPixAngle;   // radians per low-res pixel (0 = full detail)
uniform vec3 uDrift1;
uniform vec3 uDrift2;
uniform float uTurb;
uniform float uFrontNoise;
uniform vec3 uStreak;      // radial streaks: (angular frequency, radial frequency, weight)

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
uniform int uScatShadow;     // shadow samples toward scatter stars (0 = unshadowed)
uniform float uScatShadowLen; // pc
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

Medium medium(vec3 p, vec3 rd, float tCam) {
  Medium M;
  M.sheet = vec4(0.0);
  vec3 pc = p / uExpand;
  vec3 uvw = pc / (2.0 * uHalf) + 0.5;
  vec4 F = texture(uField, uvw);
  // Detail LOD: a 3D texture has no mips here, so fade each octave to its mean once a texel
  // is smaller than the pixel footprint (otherwise it aliases into a moiré of dots).
  float fp = tCam * uPixAngle;
  vec4 D1 = mix(vec4(0.5), texture(uDetail, pc * uDetailFreq.x + uDrift1), 1.0 - smoothstep(0.6, 1.8, fp / uTexel.x));
  vec4 D2 = mix(vec4(0.5), texture(uDetail, pc * uDetailFreq.y + uDrift2), 1.0 - smoothstep(0.6, 1.8, fp / uTexel.y));
#ifdef PHOTO
  // Unit-variance sub-voxel fluctuation (the detail channels have σ ≈ 0.1–0.15).
  float turb = (D1.r - 0.5) * 6.0 + (D2.r - 0.5) * 3.5 + (D2.g - 0.45) * 1.5;
  if (uStreak.z > 0.0) {
    // Streaks along the radiation: photoevaporation flows and trunks point back at the source,
    // so structure is long radially and fine transversally (sampled in source-centred angles).
    vec3 rsv = pc - uSource;
    float rl = length(rsv) + 1e-3;
    vec4 D3 = mix(vec4(0.5), texture(uDetail, (rsv / rl) * uStreak.x + vec3(rl * uStreak.y) + uDrift1 * 0.5),
                  1.0 - smoothstep(0.6, 1.8, fp * uStreak.x / (rl * uTexel.z)));
    turb = mix(turb, (D3.r - 0.5) * 6.0 + (D3.a - 0.5) * 3.0 + (D2.r - 0.5) * 2.0, uStreak.z);
  }
  turb = clamp(turb, -3.0, 3.0);
  // Lognormal density PDF of supersonic turbulence, mean-preserving: <m> = 1, <m²> = e^{σ²}.
  float m = exp(uTurb * turb - 0.5 * uTurb * uTurb);
  float xi = F.y + uFrontNoise * ((D1.a - 0.5) * 7.0 + (D2.r - 0.5) * 4.0);
  float zH = 1.0 - smoothstep(-0.3, 0.3, xi);
  // The baked recombination rate is a voxel average; the front inside the voxel is much thinner.
  // Put that emission on the ionized side of the (noise-perturbed) sub-voxel front, keeping the
  // voxel's total: ∫ n_eff² dV is photon-conserving, only its placement is refined.
  // Emission ∝ n²: clumping raises it by m² / <m²> (the photon budget is fixed).
  float g2 = F.z * F.z * m * m * exp(-uTurb * uTurb) * zH * (1.0 + 0.9 * exp(-xi * xi));
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
  // Break each sheet into strands: ridged detail lines on the sheet (thin cooling filaments and
  // Rayleigh–Taylor fingers), so face-on parts stay dark and edge-on parts become threads.
  float strand = D1.b * D1.b * D1.b;
  float bright = F.z * (0.15 + 3.2 * strand) * (0.5 + 0.9 * D2.b) * (0.6 + 0.8 * D2.g);
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
    vec3 Ts = vec3(1.0);
    if (uScatShadow > 0 && M.sigma > 0.0) {
      // Short shadow ray toward the star through the dust field (τ_V → reddened per channel).
      float L = min(sqrt(q2), uScatShadowLen);
      vec3 dir = -e * inversesqrt(q2);
      float tau = 0.0;
      for (int k = 0; k < 6; k++) {
        if (k >= uScatShadow) break;
        vec3 q = (p + dir * (L * (float(k) + 0.5) / float(uScatShadow))) / uExpand;
        tau += texture(uField, q / (2.0 * uHalf) + 0.5).x;
      }
      Ts = exp(-tau * uKappa * L / float(uScatShadow) * uKExt);
    }
    M.cont += M.sigma * uAlbedo * uKScat * uScatRGB[i] * Ts * phaseHG(c2, uHG) / q2;
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
  // OLED rule: nothing may reveal the simulation cube. Fade all gas and dust over the outer
  // ~12 % of the box so a density field that reaches the walls ends in soft, ragged wisps
  // (the detail noise modulates the fade) instead of on a straight face.
  vec3 ab = abs(pc) / uHalf;
  float edgeR = max(max(ab.x, ab.y), ab.z) + 0.05 * (D1.g - 0.5);
  float edge = 1.0 - smoothstep(0.86, 0.985, edgeR);
  edge *= edge;
  M.sigma *= edge;
  M.sheet.yzw *= edge;
  float em = uEmission * edge;
  M.eA *= em;
  M.eB *= em;
  M.cont *= em;
  return M;
}

void main() {
#ifdef PROBE
  vec2 ndc = uProbeNdc;
#else
  vec2 frag = gl_FragCoord.xy + uJitter;
  vec2 ndc = frag / uRes * 2.0 - 1.0;
#endif
  vec4 v = uProjInv * vec4(ndc, -1.0, 1.0);
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
    // IGN shifted spatially every frame (Jimenez 2014) plus a golden-ratio offset: the per-pixel
    // error pattern decorrelates between frames, so the temporal resolve averages it away.
    // Per-pixel IGN phase plus a per-frame golden-ratio (R1) offset: every pixel walks the most
    // uniform 1D low-discrepancy sequence, so its running mean converges ~1/N. (Shifting the IGN
    // pattern spatially as well would add ≈ 0.6 per frame and collapse the combined increment
    // to ≈ 0.22 ≈ 1/5, which leaves a visible lattice after accumulation.)
    float fm = mod(uFrame, 4096.0);
    float jit = fract(ign(gl_FragCoord.xy) + fm * 0.61803398875);
#endif
    float N = float(uSteps);
    float c = max(tn, uNearScale);
    float beta = max(log(1.0 + (tf - tn) / c), 1e-4);
    float eb = exp(beta) - 1.0;
    float tPrev = tn;
    float dPrev = 0.0;
    bool havePrev = false;
    bool haveP2 = false;
    float dP2 = 0.0;
    float tP2 = tn;
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
      Medium M = medium(p, rd, ts);
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
        // A ray grazing a sheet between two samples never sees d change sign. Fit a parabola
        // through the last three samples; if |d| has a turning point inside this segment, split
        // the segment there so the linear-in-d sheet integral catches the (limb-brightened) graze.
        float tv = -1.0;
        float dv = 0.0;
        if (haveP2) {
          float s01 = (dPrev - dP2) / max(tPrev - tP2, 1e-6);
          float s12 = (M.sheet.x - dPrev) / max(seg, 1e-6);
          float a = (s12 - s01) / max(ts - tP2, 1e-6);
          if (abs(a) > 1e-9) {
            float tStar = 0.5 * (tPrev + ts) - s12 / (2.0 * a);
            if (tStar > tPrev && tStar < ts) {
              tv = tStar;
              dv = dPrev + s12 * (tStar - tPrev) + a * (tStar - tPrev) * (tStar - ts);
            }
          }
        }
        float wmin = 0.03 * seg;
        float sR, sO, sB;
        if (tv > 0.0) {
          float l1 = tv - tPrev, l2 = ts - tv;
          sR = sheetSeg(dPrev + uSheetR.x, dv + uSheetR.x, l1, max(uSheetR.y, wmin)) + sheetSeg(dv + uSheetR.x, M.sheet.x + uSheetR.x, l2, max(uSheetR.y, wmin));
          sO = sheetSeg(dPrev + uSheetO.x, dv + uSheetO.x, l1, max(uSheetO.y, wmin)) + sheetSeg(dv + uSheetO.x, M.sheet.x + uSheetO.x, l2, max(uSheetO.y, wmin));
          sB = sheetSeg(dPrev + uSheetB.x, dv + uSheetB.x, l1, max(uSheetB.y, wmin)) + sheetSeg(dv + uSheetB.x, M.sheet.x + uSheetB.x, l2, max(uSheetB.y, wmin));
        } else {
          sR = sheetSeg(dPrev + uSheetR.x, M.sheet.x + uSheetR.x, seg, max(uSheetR.y, wmin));
          sO = sheetSeg(dPrev + uSheetO.x, M.sheet.x + uSheetO.x, seg, max(uSheetO.y, wmin));
          sB = sheetSeg(dPrev + uSheetB.x, M.sheet.x + uSheetB.x, seg, max(uSheetB.y, wmin));
        }
        sR *= M.sheet.y;
        sO *= M.sheet.z;
        sB *= M.sheet.w;
        vec3 Ts = exp(-tauV * uKLine);
        dA += vec4((sR + sB) * uRatiosA.x * Ts.x, (sR + sB) * uRatiosA.y * Ts.y, (sR + sB) * uRatiosA.z * Ts.z, sO * uRatiosA.w * Ts.y);
        dB += vec4(sR * uRatiosB.x * Ts.x, sR * uRatiosB.y * Ts.x, sR * uRatiosB.z * Ts.y, 0.0);
      }
      haveP2 = havePrev;
      dP2 = dPrev;
      tP2 = tPrev;
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
