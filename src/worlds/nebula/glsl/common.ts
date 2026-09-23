/**
 * GLSL shared by the nebula passes.
 *
 * - `nebErf`, `sheetSeg`: exact line integral of a thin Gaussian sheet (ionization front,
 *   shock) across a ray segment when the signed distance varies linearly along it. This
 *   makes razor-thin emitting layers independent of the step size and gives the physical
 *   limb brightening (1/|cos θ|) of sheets seen edge-on — the reason supernova-remnant
 *   filaments look like threads.
 * - `segW`: energy-conserving in-scattering/emission weight (1 − e^{−τ})/τ for a segment
 *   (Hillaire 2015, "Physically based sky, atmosphere and cloud rendering in Frostbite").
 * - Periodic gradient and cellular noise for the tileable detail texture.
 */
export const NEBULA_COMMON_GLSL = /* glsl */ `
#ifndef NEB_COMMON
#define NEB_COMMON
float nebErf(float x) {
  // Abramowitz & Stegun 7.1.26, |ε| < 1.5e-7.
  float s = sign(x);
  float a = abs(x);
  float t = 1.0 / (1.0 + 0.3275911 * a);
  float y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-a * a);
  return s * y;
}
// ∫ over a segment of length dt of (1/(w√π)) exp(-(d/w)²), with d varying linearly d0 → d1.
float sheetSeg(float d0, float d1, float dt, float w) {
  float a = d0 / w;
  float b = d1 / w;
  if (abs(b - a) < 2e-3) {
    float m = 0.5 * (a + b);
    return exp(-m * m) * dt / (w * 1.7724539);
  }
  return 0.5 * dt * (nebErf(b) - nebErf(a)) / (d1 - d0);
}
vec3 segW(vec3 x) {
  vec3 big = (1.0 - exp(-x)) / max(x, vec3(1e-5));
  return mix(1.0 - 0.5 * x, big, step(vec3(1e-3), x));
}
float segW1(float x) {
  return x < 1e-3 ? 1.0 - 0.5 * x : (1.0 - exp(-x)) / x;
}
float sq(float x) { return x * x; }
float nebSmooth(float e0, float e1, float x) { return smoothstep(e0, e1, x); }
// Ray vs axis-aligned cube [-h, h]^3: returns (tNear, tFar).
vec2 rayBox(vec3 ro, vec3 rd, float h) {
  vec3 inv = 1.0 / rd;
  vec3 t0 = (-vec3(h) - ro) * inv;
  vec3 t1 = (vec3(h) - ro) * inv;
  vec3 tmin = min(t0, t1);
  vec3 tmax = max(t0, t1);
  return vec2(max(max(tmin.x, tmin.y), tmin.z), min(min(tmax.x, tmax.y), tmax.z));
}
#endif
`;

/** Periodic (tileable) gradient and cellular noise, for baking the detail texture. */
export const NEBULA_PERIODIC_NOISE_GLSL = /* glsl */ `
#ifndef NEB_PNOISE
#define NEB_PNOISE
vec3 nebGrad(vec3 i, float P, float seed) {
  i = mod(i, P);
  vec3 h = hash33(i * 1.0 + vec3(seed * 17.31, seed * 3.7, seed * 11.1));
  return normalize(h * 2.0 - 1.0 + 1e-4);
}
float pnoise(vec3 p, float P, float seed) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n000 = dot(nebGrad(i, P, seed), f);
  float n100 = dot(nebGrad(i + vec3(1, 0, 0), P, seed), f - vec3(1, 0, 0));
  float n010 = dot(nebGrad(i + vec3(0, 1, 0), P, seed), f - vec3(0, 1, 0));
  float n110 = dot(nebGrad(i + vec3(1, 1, 0), P, seed), f - vec3(1, 1, 0));
  float n001 = dot(nebGrad(i + vec3(0, 0, 1), P, seed), f - vec3(0, 0, 1));
  float n101 = dot(nebGrad(i + vec3(1, 0, 1), P, seed), f - vec3(1, 0, 1));
  float n011 = dot(nebGrad(i + vec3(0, 1, 1), P, seed), f - vec3(0, 1, 1));
  float n111 = dot(nebGrad(i + vec3(1, 1, 1), P, seed), f - vec3(1, 1, 1));
  return 1.7 * mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y), mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
float pworley(vec3 p, float P, float seed) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  float d = 8.0;
  for (int z = -1; z <= 1; z++)
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec3 b = vec3(float(x), float(y), float(z));
    vec3 cell = mod(i + b, P);
    vec3 o = hash33(cell + vec3(seed * 9.13, seed * 1.7, seed * 5.3));
    vec3 r = b + o - f;
    d = min(d, dot(r, r));
  }
  return sqrt(d);
}
float pfbm(vec3 q, float P, float seed, int oct) {
  float s = 0.0, a = 0.5, norm = 0.0, per = P;
  for (int k = 0; k < 6; k++) {
    if (k >= oct) break;
    s += a * pnoise(q * per, per, seed + float(k) * 3.1);
    norm += a;
    a *= 0.5;
    per *= 2.0;
  }
  return s / norm;
}
#endif
`;
