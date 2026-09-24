/** Shared GLSL for the solar-system layer. */

/** Kepler's equation and orbit placement on the GPU (float32; inputs kept small by CPU re-basing). */
export const KEPLER_GLSL = /* glsl */ `
#ifndef SOLAR_KEPLER
#define SOLAR_KEPLER
// Solve M = E − e sin E (M in [−π, π]); Newton from a safe start, 8 iterations (e ≤ 0.95).
float solveKeplerE(float M, float e) {
  float E = e < 0.8 ? M + e * sin(M) : (M >= 0.0 ? 3.14159265 : -3.14159265) * 0.85;
  for (int k = 0; k < 8; k++) {
    float f = E - e * sin(E) - M;
    E -= f / (1.0 - e * cos(E));
  }
  return E;
}
float wrapPi(float x) { return x - 6.28318530718 * floor((x + 3.14159265359) / 6.28318530718); }
// Ecliptic (astro, z-up) position of an ellipse point, rotated Rz(Ω) Rx(i) Rz(ω); returns three.js axes.
vec3 orbitPoint(float a, float e, float inc, float node, float peri, float E) {
  float xp = a * (cos(E) - e);
  float yp = a * sqrt(max(1.0 - e * e, 0.0)) * sin(E);
  float cO = cos(node), sO = sin(node), ci = cos(inc), si = sin(inc), cw = cos(peri), sw = sin(peri);
  float x = (cO * cw - sO * sw * ci) * xp + (-cO * sw - sO * cw * ci) * yp;
  float y = (sO * cw + cO * sw * ci) * xp + (-sO * sw + cO * cw * ci) * yp;
  float z = (sw * si) * xp + (cw * si) * yp;
  return vec3(x, z, -y);
}
#endif
`;

/**
 * Point-spread function for unresolved sources: a Gaussian core (σ ≈ 0.6 px) and a faint 1/r³ wing,
 * energy-normalised so the integrated flux does not depend on sprite size. `q` in pixels.
 */
export const PSF_GLSL = /* glsl */ `
#ifndef SOLAR_PSF
#define SOLAR_PSF
float psf(vec2 qPx, float sigma) {
  float r2 = dot(qPx, qPx);
  float core = exp(-r2 / (2.0 * sigma * sigma)) / (6.28318530718 * sigma * sigma);
  float wing = 0.018 / (6.28318530718 * pow(1.0 + r2 / (4.0 * sigma * sigma), 1.5) * 4.0 * sigma * sigma);
  return core * 0.96 + wing;
}
#endif
`;

/** Lommel–Seeliger (regolith) + Lambert mix: the classic photometric law for airless bodies. */
export const PHOTOMETRY_GLSL = /* glsl */ `
#ifndef SOLAR_PHOTO
#define SOLAR_PHOTO
float lommelSeeliger(float mu0, float mu) { return mu0 > 0.0 ? mu0 / max(mu0 + mu, 1e-4) : 0.0; }
// Disc-integrated phase function of a Lambert sphere, α in radians.
float lambertPhase(float alpha) { return (sin(alpha) + (3.14159265 - alpha) * cos(alpha)) / 3.14159265; }
#endif
`;

/**
 * Analytic occlusion for overlay geometry (lines, points, sprites, tails) drawn in one pass after
 * the bodies: a camera-relative point is hidden when the ray to it enters a resolved body first.
 * Occluders are spheres (xyz = camera-relative centre, w = radius), nearest-important first.
 */
export const OCCLUDE_GLSL = /* glsl */ `
#ifndef SOLAR_OCCLUDE
#define SOLAR_OCCLUDE
uniform vec4 uOcc[8];
uniform int uOccN;
float occlusion(vec3 p) {
  float dp = length(p);
  if (dp <= 0.0) return 0.0;
  vec3 dir = p / dp;
  for (int i = 0; i < 8; i++) {
    if (i >= uOccN) break;
    vec3 c = uOcc[i].xyz;
    float r = uOcc[i].w;
    float tc = dot(c, dir);
    if (tc <= 0.0) continue;
    vec3 perp = c - dir * tc;
    float d2 = dot(perp, perp);
    if (d2 >= r * r) continue;
    float t0 = tc - sqrt(r * r - d2);
    if (t0 < dp) return 1.0;
  }
  return 0.0;
}
#endif
`;
