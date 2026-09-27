import { COMMON_GLSL } from '../../../shaders/lib/common';
import { BLACKBODY_GLSL } from '../../../shaders/lib/blackbody';
import { GALAXY_COMMON_GLSL, GALAXY_PARTICLE_GLSL, GALAXY_UNIFORMS_GLSL } from './galaxyGlsl';
import { ERF_GLSL, ISM_GLSL, ISM_LOCAL_COLUMN_GLSL, ISM_UNIFORMS_GLSL } from './ismGlsl';

/**
 * Galaxy star particles. Every vertex evaluates its own orbit at uTime (no CPU work per frame),
 * or — after dark matter is switched off — reads its integrated position from the GPU state texture.
 * Light: flux = L/(4πd²) · e^{−τ_λ}, converted to summed pixel radiance (÷ pixel solid angle) and
 * spread over an energy-normalised Gaussian PSF of ≥ 2.6 px, so faint stars fade instead of
 * flickering and bright ones bloom without changing their total energy.
 */
export const STAR_VERT = /* glsl */ `
precision highp float;
precision highp int;
${GALAXY_UNIFORMS_GLSL}
${ISM_UNIFORMS_GLSL}
${COMMON_GLSL}
${BLACKBODY_GLSL}
${GALAXY_COMMON_GLSL}
${ERF_GLSL}
${ISM_LOCAL_COLUMN_GLSL}
${ISM_GLSL}
${GALAXY_PARTICLE_GLSL}
in vec4 a0;
in vec4 a1;
in vec4 a2;
uniform vec3 uCamModel;
uniform vec3 uOrigin;
uniform float uFluxToRad;    // exposure-scale / (4π Ω_pixel)
uniform float uMinRad;
uniform float uSizeRef;
uniform float uMaxSize;
uniform int uExtSamples;
uniform float uMode;         // 0 analytic orbits, 1 integrated state
uniform sampler2D uStatePos;
uniform int uStateW;
uniform float uSwitchTime;
uniform float uSaturation;
uniform float uYoungBoost;
uniform vec2 uPopGain;       // (old populations, young) brightness multipliers
uniform float uPxPerRad;     // target pixels per radian
uniform vec4 uSmooth;        // particle surface density Σ₀ (pc⁻²) and R_d of the thin and thick disks
uniform float uSmoothBar;    // bar particles per pc²
// Two-resolution splatting (fill rate): 0 = draw everything here; 1 = only the sharp (point-like)
// part; 2 = only the smooth part (wide aggregate sprites), into a target uLoScale × the size.
// A sprite of PSF width σ (full-resolution px) goes to the smooth pass with weight
// smoothstep(uSplit.x, uSplit.y, σ); its radiance is unchanged, only the pixel grid differs.
uniform int uPass;
uniform vec2 uSplit;
uniform float uLoScale;

// Physical extent of an aggregate particle: the mean spacing of its population (a particle is
// thousands of unresolved stars, not one super-luminous star). Young stars are single stars.
uniform float uYoungMult;
float smoothingLength(float kind, vec4 a1, float a2x, vec3 P) {
  if (kind < 0.5) {
    bool thin = a1.w > 0.52;
    float S = thin ? uSmooth.x * exp(-length(P.xy) / uSmooth.y) : uSmooth.z * exp(-length(P.xy) / uSmooth.w);
    return 0.7 / sqrt(max(S, 1e-12));
  }
  if (kind < 1.5) return 0.7 / sqrt(max(uSmoothBar, 1e-12));
  if (kind < 2.5) return 0.1 * length(P) + 5.0;
  if (kind < 3.5) {
    // A young particle is k stars spread through its association: initial size + expansion.
    float tt = uTime + a1.w;
    float age = tt - floor(tt / a1.z) * a1.z;
    return uYoungMult > 1.5 ? 0.5 * a2x + 3.0 * age : 0.0;
  }
  return 0.3;
}
out vec3 vColor;
out float vSize;
out float vK;

void cullStar() {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  gl_PointSize = 0.0;
  vColor = vec3(0.0);
  vSize = 0.0;
  vK = 0.0;
}

void main() {
  vec3 P;
  float L;
  float T;
  particleState(a0, a1, a2, uTime, P, L, T);
  bool young = a0.x > 2.5 && a0.x < 3.5;
  if (uMode > 0.5) {
    int id = gl_VertexID;
    P = texelFetch(uStatePos, ivec2(id % uStateW, id / uStateW), 0).xyz;
    if (young) {
      // No new clusters are born once the disk is flying apart; the existing ones age out.
      float tt0 = uSwitchTime + a1.w;
      float tt1 = uTime + a1.w;
      if (floor(tt0 / a1.z) != floor(tt1 / a1.z)) L = 0.0;
    }
  }
  L *= young ? uPopGain.y * uYoungBoost : uPopGain.x;
  vec3 world = toRender(P) - uOrigin;
  vec4 mv = viewMatrix * vec4(world, 1.0);
  float d2 = dot(mv.xyz, mv.xyz);
  if (L <= 0.0 || mv.z > -1e-3) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vColor = vec3(0.0);
    vSize = 0.0;
    vK = 0.0;
    return;
  }
  float rad = L * visEff(T) * uFluxToRad / max(d2, 1e-4);
  if (rad < uMinRad) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vColor = vec3(0.0);
    vSize = 0.0;
    vK = 0.0;
    return;
  }
  // Projected extent of the particle (px), before extinction: lets each pass skip the dust column
  // for sprites that belong entirely to the other pass.
  float hpx = 0.75 * smoothingLength(a0.x, a1, a2.x, P) * uPxPerRad / sqrt(d2);
  float fYoung = young && uYoungMult > 1.5 ? smoothstep(1.5, 6.0, hpx) : 0.0;
  // Close enough to resolve the association: show the particle's own star as a point and let
  // its k − 1 companions go (their light is a small part of what surrounds the viewer).
  hpx *= 1.0 - fYoung;
  vec3 c = blackbody(T);
  float lc = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = max(vec3(lc) + uSaturation * (c - vec3(lc)), 0.0);
  if (uPass == 1 && min(hpx, 2.0) >= uSplit.y) { cullStar(); return; }
  if (uPass == 2) {
    // Upper bound of σ (no extinction): wholly sharp sprites never reach the smooth pass.
    float lumUB = dot(c, vec3(0.2126, 0.7152, 0.0722)) * rad;
    float psfUB = clamp(2.6 + 1.1 * log2(1.0 + lumUB / uSizeRef), 2.6, uMaxSize) / 6.0;
    if (min(sqrt(psfUB * psfUB + hpx * hpx), max(psfUB, 2.0)) <= uSplit.x) { cullStar(); return; }
  }
  float tau = dustColumn(uCamModel, P, uExtSamples);
  vec3 trans = exp(-tau * uExtRGB);
  vec3 col = c * rad * trans;
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  if (lum < uMinRad) { cullStar(); return; }
  // Sprite diameter grows slowly with brightness (the visible wings of a bright PSF), combined in
  // quadrature with the particle's own projected extent. When that exceeds 12 px the particle fades
  // out: up close its light belongs to the smooth volume, not to a fake point star.
  float psf = clamp(2.6 + 1.1 * log2(1.0 + lum / uSizeRef), 2.6, uMaxSize) / 6.0;
  col *= mix(1.0, 1.0 / uYoungMult, fYoung);
  float sigma = sqrt(psf * psf + hpx * hpx);
  // Aggregate particles never exceed a 12 px sprite (fill rate: an elliptical is ~10⁶ of them);
  // only a genuinely bright point source may spread its PSF wider.
  float sMax = max(psf, 2.0);
  if (sigma > sMax) {
    float k = sMax / sigma;
    col *= k * k * k;
    sigma = sMax;
    if (dot(col, vec3(0.2126, 0.7152, 0.0722)) < uMinRad * 0.1) { cullStar(); return; }
  }
  if (uPass != 0) {
    float w = smoothstep(uSplit.x, uSplit.y, sigma);
    col *= uPass == 2 ? w : 1.0 - w;
    if (uPass == 1 ? w >= 1.0 : w <= 0.0) { cullStar(); return; }
    if (uPass == 2) {
      // Same radiance, coarser pixels: the PSF is σ·s pixels wide there.
      float sl = sigma * uLoScale;
      gl_PointSize = 6.0 * sl;
      vSize = 6.0 * sl;
      vK = 1.0 / (2.0 * sl * sl);
      vColor = col / (6.2831853 * sigma * sigma);
      gl_Position = projectionMatrix * mv;
      return;
    }
  }
  float size = 6.0 * sigma;
  gl_PointSize = size;
  vSize = size;
  vK = 1.0 / (2.0 * sigma * sigma);
  vColor = col / (6.2831853 * sigma * sigma);
  gl_Position = projectionMatrix * mv;
}
`;

export const STAR_FRAG = /* glsl */ `
precision highp float;
in vec3 vColor;
in float vSize;
in float vK;
out vec4 outColor;
void main() {
  vec2 q = (gl_PointCoord - 0.5) * vSize;
  float r2 = dot(q, q);
  float g = exp(-r2 * vK);
  outColor = vec4(vColor * g, 1.0);
}
`;
