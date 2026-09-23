/**
 * GLSL for a moving observer (see src/physics/voyage-relativity.ts for the equations and references).
 * Uniforms (declare via RELATIVITY_UNIFORMS_GLSL):
 *   uBeta      world-frame velocity / c        uBetaMag |β|        uGamma  γ
 *   uRelFlags  x: aberration, y: Doppler colour, z: beaming (intensity)   (0 or 1)
 *   uLumLUT    log10 photopic luminance of a blackbody, L(T)/L(5772 K), log-spaced in T
 */
export const RELATIVITY_UNIFORMS_GLSL = /* glsl */ `
uniform vec3 uBeta;
uniform float uBetaMag;
uniform float uGamma;
uniform vec3 uRelFlags;
uniform sampler2D uLumLUT;
uniform vec3 uLumLUTRange; // (log minT, log maxT, texel count)
`;

export const RELATIVITY_GLSL = /* glsl */ `
#ifndef TWU_RELATIVITY
#define TWU_RELATIVITY
// log10 of the photopic luminance of a blackbody surface at T, relative to the Sun's photosphere.
float logLum(float T) {
  float x = (log(max(T, 1.0)) - uLumLUTRange.x) / (uLumLUTRange.y - uLumLUTRange.x);
  float n = uLumLUTRange.z;
  float u = (clamp(x, 0.0, 1.0) * (n - 1.0) + 0.5) / n;
  return texture(uLumLUT, vec2(u, 0.5)).r;
}
// Rest-frame direction d (unit, world) → observed direction; returns Doppler factor in 'delta'.
vec3 relAberrate(vec3 d, out float delta) {
  if (uBetaMag < 1e-7) { delta = 1.0; return d; }
  vec3 bh = uBeta / uBetaMag;
  float mu = dot(d, bh);
  delta = uGamma * (1.0 + uBetaMag * mu);
  if (uRelFlags.x < 0.5) return d;
  float muObs = (mu + uBetaMag) / (1.0 + uBetaMag * mu);
  vec3 p = d - mu * bh;
  float pl = length(p);
  vec3 ph = pl > 1e-9 ? p / pl : vec3(0.0);
  return muObs * bh + sqrt(max(0.0, 1.0 - muObs * muObs)) * ph;
}
// Observed direction (unit, world) → rest-frame direction; returns Doppler factor in 'delta'.
vec3 relDeaberrate(vec3 dObs, out float delta) {
  if (uBetaMag < 1e-7) { delta = 1.0; return dObs; }
  vec3 bh = uBeta / uBetaMag;
  float muObs = dot(dObs, bh);
  delta = 1.0 / (uGamma * (1.0 - uBetaMag * muObs));
  if (uRelFlags.x < 0.5) {
    // Without aberration the rest direction is the observed one; δ still follows the rest angle.
    delta = uGamma * (1.0 + uBetaMag * muObs);
    return dObs;
  }
  float mu = (muObs - uBetaMag) / (1.0 - uBetaMag * muObs);
  vec3 p = dObs - muObs * bh;
  float pl = length(p);
  vec3 ph = pl > 1e-9 ? p / pl : vec3(0.0);
  return mu * bh + sqrt(max(0.0, 1.0 - mu * mu)) * ph;
}
#endif
`;
