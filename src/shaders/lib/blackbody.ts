/**
 * GLSL blackbody colour. `blackbody(T)` uses Krystek's (1985) rational fit of the
 * Planckian locus in CIE 1960 UCS (valid 1000–15000 K, well-behaved beyond), converted
 * to linear sRGB and normalised to luminance Y = 1. Multiply by your own intensity.
 * `blackbodyLUT` samples the exact-integration texture from physics/blackbody.ts.
 */
export const BLACKBODY_GLSL = /* glsl */ `
#ifndef TWU_BLACKBODY
#define TWU_BLACKBODY
vec3 blackbody(float T) {
  T = clamp(T, 800.0, 60000.0);
  float u = (0.860117757 + 1.54118254e-4 * T + 1.28641212e-7 * T * T) / (1.0 + 8.42420235e-4 * T + 7.08145163e-7 * T * T);
  float v = (0.317398726 + 4.22806245e-5 * T + 4.20481691e-8 * T * T) / (1.0 - 2.89741816e-5 * T + 1.61456053e-7 * T * T);
  float d = 2.0 * u - 8.0 * v + 4.0;
  float x = 3.0 * u / d;
  float y = 2.0 * v / d;
  vec3 XYZ = vec3(x / y, 1.0, (1.0 - x - y) / y);
  const mat3 XYZ2RGB = mat3(3.2404542, -0.9692660, 0.0556434, -1.5371385, 1.8760108, -0.2040259, -0.4985314, 0.0415560, 1.0572252);
  return max(XYZ2RGB * XYZ, vec3(0.0));
}
vec3 blackbodyLUT(sampler2D lut, float T, float minT, float maxT) {
  float u = (log(T) - log(minT)) / (log(maxT) - log(minT));
  return texture(lut, vec2(clamp(u, 0.0, 1.0), 0.5)).rgb;
}
#endif
`;
