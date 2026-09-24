import { COMMON_GLSL } from '../../../shaders/lib/common';
import { GALAXY_COMMON_GLSL, GALAXY_UNIFORMS_GLSL } from './galaxyGlsl';
import { ERF_GLSL, ISM_GLSL, ISM_LOCAL_COLUMN_GLSL, ISM_UNIFORMS_GLSL } from './ismGlsl';

/**
 * Low-resolution volumetric pass: the unresolved starlight of every stellar component, the Hα
 * glow of ionised gas, and absorption + reddening by dust, integrated front to back along each
 * camera ray (emission–absorption radiative transfer, dI/ds = j − σI, per RGB channel with the
 * Cardelli extinction curve). Output: rgb = radiance, a = mean transmittance (for the background).
 *
 * Radiance unit: L☉ pc⁻² sr⁻¹ × radiance scale, the same unit the star sprites use, so point
 * sources and diffuse light keep their physical ratio at every distance.
 */
export const VOLUME_FRAG = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler3D;
${GALAXY_UNIFORMS_GLSL}
${ISM_UNIFORMS_GLSL}
${COMMON_GLSL}
${GALAXY_COMMON_GLSL}
${ERF_GLSL}
${ISM_LOCAL_COLUMN_GLSL}
${ISM_GLSL}
in vec2 vUv;
out vec4 outColor;
uniform vec2 uTanFov;      // tan(fov/2)·aspect, tan(fov/2)
uniform mat4 uCamWorld;
uniform vec3 uCamModel;
uniform vec2 uBounds;      // Rmax, Zmax
uniform float uMaxSteps;
uniform float uStepK;
uniform vec2 uStepRange;   // min, max step (pc)
uniform float uFrame;
uniform vec3 uColDisk;
uniform vec3 uColThick;
uniform vec3 uColBulge;
uniform vec3 uColBar;
uniform vec3 uColYoung;
uniform vec3 uColHII;
uniform vec3 uColOIII;
uniform vec3 uColScatter;
uniform vec4 uDiskP;       // norm, Rd, h, truncation
uniform vec4 uThickP;      // norm, Rd, h, truncation
uniform vec2 uFlare;       // e-fold length (0 = none), onset radius
uniform vec4 uBulgeP;      // norm, a, flatten, rmax
uniform vec4 uBarP;        // norm core, norm long, halfLength, axis ratio
uniform vec4 uNucP;        // NSC norm, radius, nuclear-disk norm, radius
uniform vec2 uYoungP;      // norm, scale height
uniform vec2 uHIIP;        // norm, scale height
uniform float uScatter;
uniform sampler3D uNoise;
uniform float uNoiseTile;
uniform float uGain;
uniform float uNearCut;    // emission closer than this (pc) is drawn as individual stars instead
uniform int uDebug;
uniform int uMask;         // component bits: 1 disk, 2 thick, 4 bulge, 8 bar, 16 young, 32 HII, 64 scattering, 128 dust

float sech2(float x) { float c = cosh(clamp(x, -30.0, 30.0)); return 1.0 / (c * c); }

// Interval of the ray inside the cylinder R < Rmax and slab |H| < Zmax.
vec2 bounds(vec3 ro, vec3 rd) {
  float Rm = uBounds.x, Zm = uBounds.y;
  float a = dot(rd.xy, rd.xy);
  float b = dot(ro.xy, rd.xy);
  float c = dot(ro.xy, ro.xy) - Rm * Rm;
  vec2 tc = vec2(-1e30, 1e30);
  if (a > 1e-12) {
    float disc = b * b - a * c;
    if (disc < 0.0) return vec2(1.0, -1.0);
    float s = sqrt(disc);
    tc = vec2((-b - s) / a, (-b + s) / a);
  } else if (c > 0.0) return vec2(1.0, -1.0);
  vec2 tz = vec2(-1e30, 1e30);
  if (abs(rd.z) > 1e-9) {
    float t0 = (-Zm - ro.z) / rd.z, t1 = (Zm - ro.z) / rd.z;
    tz = vec2(min(t0, t1), max(t0, t1));
  } else if (abs(ro.z) > Zm) return vec2(1.0, -1.0);
  return vec2(max(max(tc.x, tz.x), 0.0), min(tc.y, tz.y));
}

void main() {
  // View ray from the field of view (exact; un-projecting the far plane loses all precision
  // when far/near ~ 10⁹).
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 dirV = normalize(vec3(ndc * uTanFov, -1.0));
  vec3 dirW = normalize(mat3(uCamWorld) * dirV);
  vec3 ro = uCamModel;
  vec3 rd = fromRender(dirW);
  vec2 iv = bounds(ro, rd);
  if (uDebug == 1) { outColor = vec4(1.0, 0.2, 0.1, 0.5); return; }
  if (uDebug == 2) { outColor = vec4(iv.y > iv.x ? 1.0 : 0.0, abs(rd.z), max(iv.y - iv.x, 0.0) / 50000.0, 0.0); return; }
  if (uDebug == 3) { outColor = vec4(abs(ro) / 40000.0, 0.0); return; }
  if (iv.y <= iv.x) { outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

  vec3 L = vec3(0.0);
  vec3 T = vec3(1.0);
  float t = iv.x;
  float jitter = ign(gl_FragCoord.xy + vec2(uFrame * 5.588238, uFrame * 3.1));
  float absRdz = abs(rd.z);
  float steps = 0.0;
  float barAng = uBarAngle0 + uOmegaB * uTime;
  float cb = cos(barAng), sb = sin(barAng);
  bool first = true;

  for (int i = 0; i < 400; i++) {
    if (steps >= uMaxSteps || t >= iv.y) break;
    vec3 m0 = ro + rd * t;
    float h0 = m0.z;
    // Step: resolve the vertical structure (∝ |h| + 20 pc along the ray), the neighbourhood of the
    // camera (∝ distance) and the bulge (∝ r); far above the plane only smooth, faint light remains.
    float ds = uStepK * (abs(h0) + 20.0) / max(absRdz, 0.012);
    float r0 = length(m0);
    ds = min(ds, min(0.03 * t + 3.0, 0.22 * r0 + 30.0));
    ds = clamp(ds, uStepRange.x, max(uStepRange.y, 0.35 * abs(h0)));
    ds = max(ds, (iv.y - t) / max(1.0, uMaxSteps - steps));
    float tm = t + ds * (first ? jitter : 0.5);
    if (first) { ds *= jitter + 0.5; first = false; }
    vec3 m = ro + rd * tm;
    steps += 1.0;
    t += ds;

    float R = length(m.xy);
    float phi = atan(m.y, m.x);
    float h = m.z - warpH(R, phi);
    vec4 mp = mapAt(m.xy);
    vec3 j = vec3(0.0);

    // Thin and thick disks (sech² vertical profile, flaring outer disk, truncation).
    float fl = uFlare.x > 0.0 ? exp(max(0.0, R - uFlare.y) / uFlare.x) : 1.0;
    float trunc = 1.0 - gsmooth(uDiskP.w * 0.88, uDiskP.w * 1.06, R);
    if ((uMask & 1) != 0) {
      float hz = uDiskP.z * fl;
      j += uColDisk * (uDiskP.x * exp(-R / uDiskP.y) * sech2(h / hz) / (2.0 * hz) * mp.r * trunc);
    }
    if ((uMask & 2) != 0) {
      float hk = uThickP.z * fl;
      j += uColThick * (uThickP.x * exp(-R / uThickP.y) * sech2(h / hk) / (2.0 * hk) * (0.8 + 0.2 * mp.r) * trunc);
    }

    // Bulge (flattened Hernquist with a small core — pseudo-bulges are not cuspy) and the
    // nuclear star cluster / nuclear stellar disk.
    float r3 = length(m);
    if ((uMask & 4) != 0) {
      float rb = length(vec3(m.xy, m.z / uBulgeP.z));
      if (rb < uBulgeP.w) {
        float rc = 0.12 * uBulgeP.y;
        float rs = sqrt(rb * rb + rc * rc);
        j += uColBulge * (uBulgeP.x / (rs * pow(rs + uBulgeP.y, 3.0)) / uBulgeP.z);
      }
      if (uNucP.x > 0.0 && r3 < uNucP.y * 12.0) {
        float x = r3 / uNucP.y;
        j += uColBulge * (uNucP.x * pow(1.0 + x * x, -2.5));
      }
      if (uNucP.z > 0.0 && R < uNucP.w * 5.0 && abs(m.z) < 400.0) {
        j += uColBulge * (uNucP.z * exp(-R / uNucP.w) * sech2(m.z / 45.0));
      }
    }

    // Bar: boxy/peanut core + long thin bar, in the bar frame (Wegg, Gerhard & Portail 2015).
    if (uBarP.x > 0.0 && (uMask & 8) != 0) {
      vec2 b = vec2(m.x * cb + m.y * sb, -m.x * sb + m.y * cb);
      float Lb = uBarP.z;
      if (abs(b.x) < Lb * 1.4 && abs(b.y) < Lb * 0.9 && abs(m.z) < Lb * 0.45) {
        float q = mix(1.0, uBarP.w, uBarStrength);
        float ac = 0.36 * Lb, bc = ac * mix(1.0, 0.62, uBarStrength);
        float azc = 0.14 * Lb * (0.5 + 0.9 * min(1.0, abs(b.x) / (0.55 * ac)));
        float zc = m.z / azc;
        float mc = pow(pow(abs(b.x / ac), 3.0) + pow(abs(b.y / bc), 3.0), 2.0 / 3.0) + zc * zc;
        float al = Lb, bl = Lb * q;
        float zl = m.z / 150.0;
        float ml = sqrt(pow(abs(b.x / al), 4.0) + pow(abs(b.y / bl), 4.0)) + zl * zl;
        j += uColBar * (uBarP.x * exp(-mc) + uBarP.y * exp(-ml * 2.2));
      }
    }

    // ISM: noise in the gas frame (fixed to the pattern here), dust with a ragged top surface.
    vec4 n = texture(uNoise, vec3(m.x, m.y, m.z * 2.5) / uNoiseTile);
    vec4 n2 = texture(uNoise, vec3(m.y, m.z * 3.0, m.x) / (uNoiseTile * 0.23) + 0.37);
    float hdEff = uDustH * (0.65 + 0.9 * n.a);
    float dustV = (mp.b + barDust(m.xy)) * uDustAmount;
    float rho = dustV * exp(-abs(h) / hdEff) / (2.0 * hdEff);
    rho *= (0.2 + 1.35 * n.r * (0.45 + 1.1 * n2.b)) * bubbleFactor(m);
    rho += localDustRho(m);
    if ((uMask & 128) == 0) rho = 0.0;

    // Young stars (diffuse, clumped into associations) and HII regions ([OIII] cores where brightest).
    if ((uMask & 16) != 0) {
      // OB associations and star complexes: strongly clumped (mean ≈ 1).
      float c4 = n2.r * n2.r;
      float clump = 0.12 + 11.0 * c4 * c4 * (0.6 + 0.8 * n.b);
      j += uColYoung * (uYoungP.x * mp.g * clump * exp(-abs(h) / uYoungP.y) / (2.0 * uYoungP.y));
    }
    if ((uMask & 32) != 0) {
      float knot = pow(n2.b, 2.0) * 3.2;
      float hiiK = mp.a * uHIIP.x * exp(-abs(h) / uHIIP.y) / (2.0 * uHIIP.y) * knot;
      float core = smoothstep(0.6, 0.95, n2.b);
      j += mix(uColHII, uColOIII, 0.4 * core) * hiiK;
    }

    // Dust-scattered disk light (albedo ≈ 0.6; bluer than the stars that light it).
    if ((uMask & 64) != 0) j += uColScatter * (uScatter * rho * (uDiskP.x * exp(-R / uDiskP.y) + 4.0 * uYoungP.x * mp.g));

    // Nearby light belongs to the resolved local star field, not to a glow around the viewer.
    if (uNearCut > 0.0) j *= smoothstep(0.45 * uNearCut, uNearCut, tm);
    vec3 sig = rho * uExtRGB;
    vec3 att = exp(-sig * ds);
    vec3 w = mix(vec3(ds), (1.0 - att) / max(sig, vec3(1e-8)), step(vec3(1e-5), sig * ds));
    L += T * j * w;
    T *= att;
    if (max(T.r, max(T.g, T.b)) < 0.002) break;
  }
  if (uDebug == 4) { outColor = vec4(steps / uMaxSteps, 0.0, 0.0, 0.0); return; }
  if (uDebug == 5) { outColor = vec4(L * 0.1, 0.0); return; }
  if (uDebug == 6) { outColor = vec4(1.0 - T, 0.0); return; }
  vec3 outL = L * uGain;
  float outT = dot(T, vec3(0.2126, 0.7152, 0.0722));
  // Guard against NaN without isnan() (unreliable on some drivers): NaN fails every comparison.
  bool ok = (outL.r >= 0.0 || outL.r < 0.0) && (outL.g >= 0.0 || outL.g < 0.0) && (outL.b >= 0.0 || outL.b < 0.0) && (outT >= 0.0 || outT < 0.0);
  if (!ok) { outL = vec3(0.0); outT = 1.0; }
  outL = min(max(outL, vec3(0.0)), vec3(6.0e4));
  outColor = vec4(outL, outT);
}
`;

/** Upsample + composite: dst = volume.rgb + dst × volume.a (blend ONE, SRC_ALPHA). */
export const VOLUME_COMPOSITE_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D tVol;
uniform vec2 uTexel;
// 9-tap Catmull–Rom via 4 bilinear fetches (smooth, sharper than bilinear on dust lanes).
vec4 sampleBicubic(vec2 uv) {
  vec2 p = uv / uTexel - 0.5;
  vec2 f = fract(p);
  vec2 i = floor(p);
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 o12 = w2 / w12;
  vec2 t0 = (i - 0.5) * uTexel;
  vec2 t3 = (i + 2.5) * uTexel;
  vec2 t12 = (i + 0.5 + o12) * uTexel;
  vec4 c = texture(tVol, vec2(t12.x, t0.y)) * w12.x * w0.y
         + texture(tVol, vec2(t0.x, t12.y)) * w0.x * w12.y
         + texture(tVol, vec2(t12.x, t12.y)) * w12.x * w12.y
         + texture(tVol, vec2(t3.x, t12.y)) * w3.x * w12.y
         + texture(tVol, vec2(t12.x, t3.y)) * w12.x * w3.y;
  return c / (w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y);
}
void main() {
  vec4 c = sampleBicubic(vUv);
  outColor = vec4(max(c.rgb, vec3(0.0)), clamp(c.a, 0.0, 1.0));
}
`;
