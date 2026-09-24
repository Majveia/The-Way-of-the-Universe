import { COMMON_GLSL } from '../../../shaders/lib/common';
import { BLACKBODY_GLSL } from '../../../shaders/lib/blackbody';
import { GALAXY_COMMON_GLSL, GALAXY_UNIFORMS_GLSL } from './galaxyGlsl';
import { ERF_GLSL, ISM_GLSL, ISM_LOCAL_COLUMN_GLSL, ISM_UNIFORMS_GLSL } from './ismGlsl';

/**
 * GPU twin of localStars.ts: one draw per luminosity tier, N³ cells around the camera's cell ×
 * maxPer slots; each vertex rebuilds its cell's star count and its own star from the shared hash
 * and culls itself when its slot is empty. Must stay line-for-line equivalent to the CPU code.
 */
export const LOCAL_STAR_VERT = /* glsl */ `
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
uniform int uTier;
uniform float uCell;
uniform int uN;
uniform int uMaxPer;
uniform vec3 uCamCell;      // integer cell of the camera (model frame)
uniform vec4 uTierL;        // lLo, lHi, n0, giant fraction
uniform float uRadius;      // fade-out distance (pc)
uniform float uBeta;        // luminosity-function slope in the tier
uniform uint uSeed;
uniform vec3 uThin;         // j0, R_d, h_z
uniform vec3 uThick;
uniform vec3 uBulge;        // L, a, flatten
uniform vec2 uFlareP;
uniform float uTrunc;
uniform float uRef;
uniform vec3 uCamModel;
uniform vec3 uOrigin;
uniform float uFluxToRad;
uniform float uMinRad;
uniform float uSizeRef;
uniform float uMaxSize;
uniform float uGain;
uniform float uSaturation;
out vec3 vColor;
out float vSize;
out float vK;

float sech2L(float x) { float c = cosh(min(30.0, abs(x))); return 1.0 / (c * c); }
float lumDensity(vec3 m) {
  float R = length(m.xy);
  float fl = uFlareP.x > 0.0 ? exp(max(0.0, R - uFlareP.y) / uFlareP.x) : 1.0;
  float tr = 1.0 - gsmooth(uTrunc * 0.88, uTrunc * 1.06, R);
  float j = uThin.x * exp(-R / uThin.y) * sech2L(m.z / (uThin.z * fl)) / fl * tr;
  j += uThick.x * exp(-R / uThick.y) * sech2L(m.z / (uThick.z * fl)) / fl * tr;
  float rb = length(vec3(m.xy, m.z / uBulge.z));
  float a = uBulge.y;
  if (uBulge.x > 0.0) j += uBulge.x * a / (6.283185307 * max(rb, 0.05 * a) * pow(rb + a, 3.0)) / uBulge.z;
  return j;
}

void cull() {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  gl_PointSize = 0.0;
  vColor = vec3(0.0);
  vSize = 0.0;
  vK = 0.0;
}

void main() {
  int id = gl_VertexID;
  int slot = id % uMaxPer;
  int c = id / uMaxPer;
  int half_ = uN / 2;
  ivec3 o = ivec3(c % uN, (c / uN) % uN, c / (uN * uN)) - ivec3(half_);
  ivec3 ic = ivec3(uCamCell) + o;
  uint h = hash4u(uint(ic.x), uint(ic.y), uint(ic.z), uint(uTier) * 7919u + uSeed * 104729u);
  float C = uCell;
  float jd = lumDensity((vec3(ic) + 0.5) * C) / uRef;
  float nExp = uTierL.z * jd * C * C * C;
  float nRaw = floor(nExp + u01(h));
  float n = min(nRaw, float(uMaxPer));
  if (float(slot) >= n) { cull(); return; }
  float boost = nRaw > float(uMaxPer) ? nExp / float(uMaxPer) : 1.0;

  uint s = hash3u(h, uint(slot), 0x51f15eu);
  float fx = u01(s); s = hnext(s);
  float fy = u01(s); s = hnext(s);
  float fz = u01(s); s = hnext(s);
  float uL = u01(s); s = hnext(s);
  float uT = u01(s); s = hnext(s);
  bool giant = u01(s) < uTierL.w;
  float e = 1.0 - uBeta;
  float a = pow(uTierL.x, e), b = pow(uTierL.y, e);
  float L = pow(a + uL * (b - a), 1.0 / e);
  float T;
  if (giant) {
    float cool = L > 400.0 ? 0.55 : 0.15;
    T = uT < cool ? 3400.0 + 500.0 * (uT / cool) : 4300.0 + 800.0 * ((uT - cool) / (1.0 - cool));
  } else {
    float m = L < 16.0 ? pow(L, 0.25) : pow(L / 1.4, 1.0 / 3.5);
    m = max(0.08, m);
    float R = m < 1.66 ? 1.06 * pow(m, 0.945) : 1.33 * pow(m, 0.555);
    T = 5772.0 * pow(L, 0.25) / sqrt(R) * (0.97 + 0.06 * uT);
  }
  L *= boost;

  vec3 P = (vec3(ic) + vec3(fx, fy, fz)) * C;
  vec3 d = P - uCamModel;
  float dist = length(d);
  float fade = 1.0 - smoothstep(0.7 * uRadius, uRadius, dist);
  if (fade <= 0.0) { cull(); return; }
  vec3 world = toRender(P) - uOrigin;
  vec4 mv = viewMatrix * vec4(world, 1.0);
  float d2 = dot(mv.xyz, mv.xyz);
  if (mv.z > -1e-3) { cull(); return; }
  float rad = L * visEff(T) * fade * uGain * uFluxToRad / max(d2, 1e-6);
  if (rad < uMinRad) { cull(); return; }
  float tau = dustColumn(uCamModel, P, 3);
  vec3 col = blackbody(T);
  float lc = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = max(vec3(lc) + uSaturation * (col - vec3(lc)), 0.0) * rad * exp(-tau * uExtRGB);
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  if (lum < uMinRad) { cull(); return; }
  float size = clamp(2.6 + 1.1 * log2(1.0 + lum / uSizeRef), 2.6, uMaxSize);
  float sigma = size / 6.0;
  gl_PointSize = size;
  vSize = size;
  vK = 1.0 / (2.0 * sigma * sigma);
  vColor = col / (6.2831853 * sigma * sigma);
  gl_Position = projectionMatrix * mv;
}
`;
