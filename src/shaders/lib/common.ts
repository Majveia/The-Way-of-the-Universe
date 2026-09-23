/**
 * Shared GLSL helpers. Concatenate into shader sources: `${COMMON_GLSL}\n...`.
 * NOTE: three.js already injects `float luminance(vec3)` into every ShaderMaterial
 * fragment shader — do not redefine it; use `luma()` (defined here) in vertex shaders.
 * `saturate` is guarded because three's <common> chunk defines it as a macro.
 */
export const COMMON_GLSL = /* glsl */ `
#ifndef TWU_COMMON
#define TWU_COMMON
#ifndef PI
#define PI 3.141592653589793
#endif
#define TAU 6.283185307179586
#define INV_PI 0.3183098861837907
#ifndef saturate
float saturate(float x) { return clamp(x, 0.0, 1.0); }
vec2 saturate(vec2 x) { return clamp(x, 0.0, 1.0); }
vec3 saturate(vec3 x) { return clamp(x, 0.0, 1.0); }
#endif
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float remap(float x, float a, float b, float c, float d) { return c + (d - c) * (x - a) / (b - a); }
float sqr(float x) { return x * x; }

// "Hash without Sine" — Dave Hoskins (MIT). Stable across GPUs, no trig precision issues.
float hash11(float p) { p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash13(vec3 p3) { p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
vec3 hash33(vec3 p3) { p3 = fract(p3 * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yxx) * p3.zyx); }
vec3 hash31(float p) { vec3 p3 = fract(vec3(p) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xxy + p3.yzz) * p3.zyx); }

// Interleaved gradient noise (Jimenez 2014) — per-pixel jitter for ray marching.
float ign(vec2 px) { return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715)))); }

// Ray–sphere intersection: returns (tNear, tFar); tNear > tFar means miss.
vec2 raySphere(vec3 ro, vec3 rd, vec3 c, float r) {
  vec3 oc = ro - c;
  float b = dot(oc, rd);
  float h = b * b - (dot(oc, oc) - r * r);
  if (h < 0.0) return vec2(1e30, -1e30);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}

// Henyey–Greenstein phase function.
float phaseHG(float cosTheta, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * cosTheta, 1e-4), 1.5));
}
float phaseRayleigh(float cosTheta) { return 3.0 / (16.0 * PI) * (1.0 + cosTheta * cosTheta); }

mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
#endif
`;
