/**
 * Tileable 3D noise baked once into a 3D texture (RGBA8): periodic Perlin gradient noise
 * (Perlin 2002 quintic fade) summed into fBm with the period doubling each octave, so the
 * texture wraps seamlessly on all three axes.
 *   R: fBm  G: ridged (filaments)  B: billow (clouds)  A: decorrelated fBm
 */
export const NOISE3D_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform float uZ;       // slice coordinate in [0, 1)
uniform float uSeed;

vec3 hash33p(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973) + uSeed * 0.0137);
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}
vec3 gradAt(vec3 i, float period) {
  vec3 g = hash33p(mod(i, period)) * 2.0 - 1.0;
  return g / max(length(g), 1e-4);
}
float pnoise(vec3 x, float period) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n000 = dot(gradAt(i, period), f);
  float n100 = dot(gradAt(i + vec3(1, 0, 0), period), f - vec3(1, 0, 0));
  float n010 = dot(gradAt(i + vec3(0, 1, 0), period), f - vec3(0, 1, 0));
  float n110 = dot(gradAt(i + vec3(1, 1, 0), period), f - vec3(1, 1, 0));
  float n001 = dot(gradAt(i + vec3(0, 0, 1), period), f - vec3(0, 0, 1));
  float n101 = dot(gradAt(i + vec3(1, 0, 1), period), f - vec3(1, 0, 1));
  float n011 = dot(gradAt(i + vec3(0, 1, 1), period), f - vec3(0, 1, 1));
  float n111 = dot(gradAt(i + vec3(1, 1, 1), period), f - vec3(1, 1, 1));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y), mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
void main() {
  vec3 p = vec3(vUv, uZ);
  float base = 4.0;
  float fbm = 0.0, ridged = 0.0, billow = 0.0, fbm2 = 0.0, amp = 0.5, norm = 0.0;
  float prev = 1.0;
  for (int o = 0; o < 5; o++) {
    float per = base * pow(2.0, float(o));
    float n = pnoise(p * per, per);
    float n2 = pnoise(p * per + 17.31, per);
    fbm += amp * n;
    fbm2 += amp * n2;
    billow += amp * abs(n);
    float r = 1.0 - abs(n);
    r *= r;
    ridged += amp * r * prev;
    prev = clamp(r * 1.6, 0.0, 1.0);
    norm += amp;
    amp *= 0.5;
  }
  fbm /= norm;
  fbm2 /= norm;
  billow /= norm;
  ridged /= norm;
  outColor = vec4(clamp(0.5 + 0.9 * fbm, 0.0, 1.0), clamp(ridged * 1.4, 0.0, 1.0), clamp(billow * 2.0, 0.0, 1.0), clamp(0.5 + 0.9 * fbm2, 0.0, 1.0));
}
`;
