import { COMMON_GLSL } from '../../../shaders/lib/common';

/**
 * Temporal upsampling resolve (TAAU): the low-resolution ray-march is jittered by a Halton
 * sequence at sub-pixel scale; each full-resolution pixel reconstructs the current frame with
 * a Gaussian kernel around the jittered samples, reprojects its history using the
 * emission-weighted depth, clips the history to the local colour distribution when the camera
 * moves, and blends. A still camera converges to a full-resolution, noise-free image.
 * Colours are blended in a luminance-compressed space (Karis 2014, "High quality temporal
 * supersampling") so bright rims and stars do not ghost.
 */
export const RESOLVE_FRAGMENT = /* glsl */ `
precision highp float;
${COMMON_GLSL}
uniform sampler2D uCur;
uniform sampler2D uCurAux;
uniform sampler2D uHist;
uniform vec2 uLowSize;
uniform vec2 uFullSize;
uniform vec2 uJitter;
uniform mat4 uProjInv;
uniform mat3 uViewToLocal;
uniform vec3 uCamLocal;
uniform mat4 uPrevVP;
uniform float uAlpha;
uniform float uClip;
uniform float uHasHist;
uniform float uSharp;
uniform float uStill;
uniform float uDenoise;
out vec4 outColor;

vec3 ctm(vec3 c) { return c / (1.0 + luma(c)); }

vec4 catmullRom(sampler2D tex, vec2 uv, vec2 size) {
  vec2 sp = uv * size;
  vec2 t1 = floor(sp - 0.5) + 0.5;
  vec2 f = sp - t1;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 t12 = (t1 + w2 / w12) / size;
  vec2 t0 = (t1 - 1.0) / size;
  vec2 t3 = (t1 + 2.0) / size;
  vec4 r = texture(tex, vec2(t12.x, t0.y)) * (w12.x * w0.y)
         + texture(tex, vec2(t0.x, t12.y)) * (w0.x * w12.y)
         + texture(tex, vec2(t12.x, t12.y)) * (w12.x * w12.y)
         + texture(tex, vec2(t3.x, t12.y)) * (w3.x * w12.y)
         + texture(tex, vec2(t12.x, t3.y)) * (w12.x * w3.y);
  float ws = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  return max(r / ws, vec4(0.0));
}

void main() {
  vec2 uv = gl_FragCoord.xy / uFullSize;
  vec2 lp = uv * uLowSize;
  vec2 cell = floor(lp - uJitter);
  ivec2 maxI = ivec2(uLowSize) - 1;
  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  float wmax = 0.0;
  vec4 m1 = vec4(0.0);
  vec4 m2 = vec4(0.0);
  float closest = 1e9;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 k = cell + vec2(float(i), float(j));
      ivec2 ik = clamp(ivec2(k), ivec2(0), maxI);
      vec4 c = texelFetch(uCur, ik, 0);
      c.rgb = ctm(c.rgb);
      vec2 d = lp - (k + 0.5 + uJitter);
      float w = exp(-uSharp * dot(d, d));
      sum += c * w;
      wsum += w;
      wmax = max(wmax, w);
      m1 += c;
      m2 += c * c;
      closest = min(closest, texelFetch(uCurAux, ik, 0).x);
    }
  }
  // Reconstruct the current frame by bicubic interpolation of the jittered low-resolution
  // samples at this pixel (continuous: no splat pattern); the Gaussian weights above only
  // measure how well this pixel is covered this frame.
  vec4 cur = catmullRom(uCur, uv - uJitter / uLowSize, uLowSize);
  cur.rgb = ctm(cur.rgb);
  // The ray-march jitter is interleaved gradient noise, which is built to cancel under a 3×3
  // neighbourhood filter (Jimenez 2014). Blend toward the Gaussian reconstruction of the nine
  // jittered samples: it removes the per-frame step noise at the low-res pixel frequency that
  // the exponential history alone cannot average below ~√α of its amplitude.
  cur = mix(cur, sum / max(wsum, 1e-6), uDenoise);
  vec4 res = cur;
  if (uHasHist > 0.5) {
    float depth = texture(uCurAux, uv).x;
    depth = min(depth, closest * 1.5 + 1e-3);
    vec2 ndc = uv * 2.0 - 1.0;
    vec4 v = uProjInv * vec4(ndc, -1.0, 1.0);
    vec3 rd = normalize(uViewToLocal * normalize(v.xyz / v.w));
    vec3 P = uCamLocal + rd * depth;
    vec4 pc = uPrevVP * vec4(P, 1.0);
    vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
    if (pc.w > 0.0 && all(greaterThanEqual(puv, vec2(0.0))) && all(lessThanEqual(puv, vec2(1.0)))) {
      // A still camera must not resample its history: repeated bicubic resampling at a tiny,
      // constant sub-pixel offset (float round-off in the reprojection) acts as a sharpening
      // filter and grows a checkerboard. Snap to the pixel when the motion is negligible.
      vec2 dpx = (puv - uv) * uFullSize;
      vec4 hist = (uStill > 0.5 || dot(dpx, dpx) < 1e-3) ? texelFetch(uHist, ivec2(gl_FragCoord.xy), 0) : catmullRom(uHist, puv, uFullSize);
      vec4 mean = m1 / 9.0;
      vec4 sd = sqrt(max(m2 / 9.0 - mean * mean, vec4(0.0)));
      vec4 lo = mean - 1.25 * sd - vec4(vec3(0.002), 0.01);
      vec4 hi = mean + 1.25 * sd + vec4(vec3(0.002), 0.01);
      hist = mix(hist, clamp(hist, lo, hi), uClip);
      float a = clamp(uAlpha * mix(0.7, 1.0, wmax), 0.0, 1.0);
      res = mix(hist, cur, a);
    }
  }
  outColor = res;
}`;

/** Multiplies the destination by the nebula's transmittance, reddened per channel: T_rgb = T_V^k. */
export const COMPOSITE_MUL_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D uHist;
uniform vec3 uKExt;
in vec2 vUv;
out vec4 outColor;
void main() {
  float T = clamp(texture(uHist, vUv).a, 1e-6, 1.0);
  outColor = vec4(pow(vec3(T), uKExt), 1.0);
}`;

/** Adds the nebula's emitted and scattered light (decompressed from the history space). */
export const COMPOSITE_ADD_FRAGMENT = /* glsl */ `
precision highp float;
${COMMON_GLSL}
uniform sampler2D uHist;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec3 c = texture(uHist, vUv).rgb;
  float l = luma(c);
  vec3 lin = c / max(1.0 - l, 1e-3);
  outColor = vec4(lin, 1.0);
}`;
