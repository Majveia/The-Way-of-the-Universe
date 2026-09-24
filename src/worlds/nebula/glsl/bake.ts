import { COMMON_GLSL } from '../../../shaders/lib/common';
import { NEBULA_COMMON_GLSL, NEBULA_PERIODIC_NOISE_GLSL } from './common';

/**
 * Tileable detail noise (one layer of a 3D texture). Channels, all in [0, 1]:
 *  r: gradient fBm (turbulent density), g: inverted cellular fBm (clumps, globules),
 *  b: ridged fBm (filaments, sheets), a: decorrelated gradient fBm (front jitter, drift).
 */
export const DETAIL_FRAGMENT = /* glsl */ `
precision highp float;
uniform float uN;
uniform float uLayer;
uniform float uSeed;
in vec2 vUv;
out vec4 outColor;
${COMMON_GLSL}
${NEBULA_PERIODIC_NOISE_GLSL}
void main() {
  vec3 q = vec3(vUv, (uLayer + 0.5) / uN);
  float r = pfbm(q, 4.0, uSeed, 5) * 0.5 + 0.5;
  float w = 0.625 * pworley(q * 4.0, 4.0, uSeed) + 0.25 * pworley(q * 8.0, 8.0, uSeed + 1.0) + 0.125 * pworley(q * 16.0, 16.0, uSeed + 2.0);
  float g = clamp(1.0 - w * 1.15, 0.0, 1.0);
  float rid = 0.0;
  float amp = 0.5, norm = 0.0, prev = 1.0, per = 4.0;
  for (int k = 0; k < 5; k++) {
    float n = 1.0 - abs(pnoise(q * per, per, uSeed + 7.0 + float(k)));
    n *= n;
    rid += n * amp * prev;
    norm += amp;
    prev = n;
    amp *= 0.5;
    per *= 2.0;
  }
  float b = clamp(rid / norm * 1.35, 0.0, 1.0);
  float a = pfbm(q, 4.0, uSeed + 31.0, 4) * 0.5 + 0.5;
  outColor = vec4(clamp(r, 0.0, 1.0), g, b, clamp(a, 0.0, 1.0));
}`;

/**
 * Photon-conserving photoionization bake (one layer).
 *
 * For every voxel x, march from the ionizing star s toward it and accumulate the photon budget
 *   C(r) = K ∫₀ʳ n(u)² u² du,     K = 4π α_B pc³ / Q,
 * i.e. the fraction of the star's ionizing photons (per steradian) already consumed by
 * recombinations along that ray (Strömgren 1939, applied ray by ray — dense clumps use their
 * share and leave neutral shadows: pillars). The recombination rate in the voxel is then taken
 * as the photons actually absorbed across it, following the photon-conserving scheme of
 * Mellema et al. (2006, New Astron. 11, 374, "C²-Ray"):
 *   n_eff² ≡ Γ/α_B = 3 [min(C_out,1) − min(C_in,1)] / (K (r_b³ − r_a³)),
 * which reduces to n² in optically thin gas and stays exact when the ionization front is much
 * thinner than a voxel. Also accumulates the V-band dust optical depth from the star.
 *
 * Output: (n·dust [cm⁻³], ξ = ln C, n_eff = √(Γ/α_B) [cm⁻³], τ_V from the star).
 */
export const LIGHT_FRAGMENT = /* glsl */ `
precision highp float;
precision highp sampler3D;
uniform sampler3D uDens;
uniform float uN;
uniform float uLayer;
uniform float uHalf;
uniform vec3 uSource;
uniform float uK;          // photon-budget constant (0 = no ionizing source)
uniform float uDensScale;
uniform float uKappa;      // τ_V per pc per cm⁻³ (includes dust-to-gas)
uniform float uIonDust;    // dust-to-gas in ionized gas relative to neutral
uniform float uStepVox;    // march step in voxels
in vec2 vUv;
out vec4 outColor;
${COMMON_GLSL}
${NEBULA_COMMON_GLSL}
#define MAX_STEPS 320
float nAt(vec3 p) {
  vec3 uvw = p / (2.0 * uHalf) + 0.5;
  if (any(lessThan(uvw, vec3(0.0))) || any(greaterThan(uvw, vec3(1.0)))) return 0.0;
  vec4 d = texture(uDens, uvw);
  return d.x * uDensScale;
}
vec2 nDust(vec3 p) {
  vec3 uvw = p / (2.0 * uHalf) + 0.5;
  if (any(lessThan(uvw, vec3(0.0))) || any(greaterThan(uvw, vec3(1.0)))) return vec2(0.0);
  vec4 d = texture(uDens, uvw);
  return vec2(d.x * uDensScale, d.y);
}
void main() {
  vec3 uvw = vec3(vUv, (uLayer + 0.5) / uN);
  vec3 x = (uvw * 2.0 - 1.0) * uHalf;
  vec4 D = texture(uDens, uvw);
  float nx = D.x * uDensScale;
  float voxel = 2.0 * uHalf / uN;
  float h = 0.5 * voxel;
  vec3 dvec = x - uSource;
  float r = length(dvec);
  vec3 w = dvec / max(r, 1e-6);
  float ra = max(r - h, 0.0);
  float rb = r + h;
  vec2 tb = rayBox(uSource, w, uHalf);
  float u0 = clamp(tb.x, 0.0, ra);
  float len = max(ra - u0, 0.0);
  float stepLen = max(uStepVox * voxel, len / float(MAX_STEPS));
  int M = int(ceil(len / stepLen));
  float du = len / max(float(M), 1.0);
  float C = 0.0;
  float tau = 0.0;
  for (int i = 0; i < MAX_STEPS; i++) {
    if (i >= M) break;
    float u = u0 + (float(i) + 0.5) * du;
    vec2 nd = nDust(uSource + w * u);
    float ion = uK > 0.0 ? step(C * uK, 1.0) : 0.0;
    C += nd.x * nd.x * u * u * du;
    tau += nd.x * nd.y * du * mix(1.0, uIonDust, ion);
  }
  float Cin = C * uK;
  // Through the voxel itself: two half-voxel segments (photon-conserving).
  float u1 = 0.5 * (ra + r);
  float u2 = r + 0.5 * h;
  float n1 = nAt(uSource + w * u1);
  float n2 = nAt(uSource + w * u2);
  float Cx = Cin + uK * n1 * n1 * u1 * u1 * (r - ra);
  float Cout = Cx + uK * n2 * n2 * u2 * u2 * h;
  float ionX = uK > 0.0 ? step(Cx, 1.0) : 0.0;
  tau += n1 * D.y * (r - ra) * mix(1.0, uIonDust, ionX);
  float xi = uK > 0.0 ? log(max(Cx, 1e-9)) : 30.0;
  float g2 = 0.0;
  if (uK > 0.0) {
    float vol = (rb * rb * rb - ra * ra * ra) / 3.0;
    g2 = (min(Cout, 1.0) - min(Cin, 1.0)) / (uK * max(vol, 1e-9));
  }
  // x carries the dust-bearing column (n × dust modifier): the only use of n at render time is extinction.
  outColor = vec4(nx * D.y, clamp(xi, -30.0, 30.0), sqrt(max(g2, 0.0)), tau * uKappa);
}`;
