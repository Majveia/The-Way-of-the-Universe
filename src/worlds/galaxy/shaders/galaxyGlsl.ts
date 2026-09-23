import { HASH_GLSL } from '../hash';

/**
 * GLSL shared by every galaxy pass. Mirrors src/worlds/galaxy/model.ts line by line
 * (Kinematics, particleState, youngState) so that the CPU can reproduce what the GPU draws.
 * Model frame: (X, Y) disk plane, azimuth increasing along rotation; H = height.
 */
export const GALAXY_UNIFORMS_GLSL = /* glsl */ `
#ifndef TWU_GALAXY_UNIFORMS
#define TWU_GALAXY_UNIFORMS
#define MAX_ARMS 12
uniform sampler2D uLUT;     // (lutN × 2) RGBA32F: Ω, κ, ν, v_c ; row 0 with dark matter, row 1 baryons
uniform float uLutRmax;
uniform float uLutN;
uniform float uTime;        // Myr
uniform float uSpin;        // +1 CCW (seen from +y), −1 CW
uniform float uOmegaP;      // spiral pattern speed (rad/Myr)
uniform float uOmegaB;      // bar pattern speed (rad/Myr)
uniform float uBarAngle0;
uniform float uBarStrength; // effective 0..1
uniform float uWaveM;
uniform float uWaveCot;
uniform float uWavePhase;
uniform float uWaveR0;
uniform float uWaveAmp;
uniform vec2 uWaveRange;    // rInner, rOuter
uniform vec3 uWarp;         // amplitude, rStart, node angle
uniform int uArmCount;
uniform vec4 uArmA[MAX_ARMS]; // cot(pitch), phase, ln r0, strength
uniform vec4 uArmB[MAX_ARMS]; // rStart, rEnd, width, sin(pitch)
uniform float uYoungArmFrac;
uniform float uYoungScaleH;
uniform float uSfrActive;   // fraction of clusters forming stars
uniform float uSfrBright;   // brightness multiplier above 1
#endif
`;

export const GALAXY_COMMON_GLSL = /* glsl */ `
${HASH_GLSL}
#ifndef TWU_GALAXY_COMMON
#define TWU_GALAXY_COMMON
#ifndef PI
#define PI 3.141592653589793
#endif
#define TAU_G 6.283185307179586

// Manual linear interpolation of the radial LUT (u = sqrt(R / Rmax)), identical to Kinematics.lutAt.
vec4 lutAt(float R, int row) {
  float u = sqrt(clamp(R / uLutRmax, 0.0, 1.0)) * (uLutN - 1.0);
  float i0 = min(uLutN - 2.0, floor(u));
  float f = u - i0;
  vec4 a = texelFetch(uLUT, ivec2(int(i0), row), 0);
  vec4 b = texelFetch(uLUT, ivec2(int(i0) + 1, row), 0);
  return mix(a, b, f);
}

float gsmooth(float a, float b, float x) {
  float t = clamp((x - a) / (b - a), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

float wrapPi(float x) {
  return x - TAU_G * floor((x + PI) / TAU_G);
}

float waveAlpha(float R) {
  float phiArm = uWavePhase - log(max(R, 1.0) / uWaveR0) * uWaveCot;
  return phiArm + PI / (2.0 * max(1.0, uWaveM));
}

float waveTaper(float R) {
  return gsmooth(uWaveRange.x * 0.75, uWaveRange.x * 1.1, R) * (1.0 - gsmooth(uWaveRange.y * 0.8, uWaveRange.y * 1.05, R));
}

float warpH(float R, float phi) {
  if (uWarp.x == 0.0 || R <= uWarp.y) return 0.0;
  float s = (R - uWarp.y) / max(1.0, 20000.0 - uWarp.y);
  return uWarp.x * s * s * sin(phi - uWarp.z);
}

vec3 toRender(vec3 m) { return vec3(m.x, m.z, -uSpin * m.y); }
vec3 fromRender(vec3 r) { return vec3(r.x, -uSpin * r.z, r.y); }

float armPhiK(int k, float R) {
  vec4 a = uArmA[k];
  return a.y - (log(max(R, 1.0)) - a.z) * a.x;
}
float armWeightK(int k, float R) {
  vec4 a = uArmA[k];
  vec4 b = uArmB[k];
  return a.w * gsmooth(b.x, b.x * 1.15, R) * (1.0 - gsmooth(b.y * 0.85, b.y, R));
}
#endif
`;

/**
 * Particle kinematics. Attributes: a0 = (kind, p1, p2, p3), a1 = (p4, p5, p6, p7), a2 = (p8, T, L, id).
 * Outputs the model-frame position, current luminosity (L☉) and temperature (K).
 */
export const GALAXY_PARTICLE_GLSL = /* glsl */ `
#ifndef TWU_GALAXY_PARTICLE
#define TWU_GALAXY_PARTICLE
void youngState(float Rg, float cidF, float midF, float mass, float tau, float Tc, float off, float scale, float T0, float L0,
                float t, out vec3 P, out float L, out float T, out float cycle) {
  uint cid = uint(int(cidF + 0.5));
  uint mid = uint(int(midF + 0.5));
  float tt = t + off;
  float nF = floor(tt / Tc);
  float age = tt - nF * Tc;
  float tb = t - age;
  cycle = nF;
  uint n = uint(int(nF));
  uint h = hash2u(cid, n);
  float sfOn = u01(hash2u(cid, 0x51abu)) < uSfrActive ? 1.0 : 0.0;

  float OmG = lutAt(Rg, 0).x;
  float wsum = 0.0;
  for (int k = 0; k < MAX_ARMS; k++) { if (k >= uArmCount) break; wsum += armWeightK(k, Rg); }
  h = hnext(h); float uArm = u01(h);
  h = hnext(h); float uPick = u01(h);
  h = hnext(h); float uJit = u01(h);
  h = hnext(h); float uJit2 = u01(h);
  float phiB;
  bool inArm = wsum > 1e-4 && uArm < uYoungArmFrac * min(1.0, wsum * 1.5);
  if (inArm) {
    float acc = 0.0;
    int chosen = 0;
    float target = uPick * wsum;
    for (int k = 0; k < MAX_ARMS; k++) {
      if (k >= uArmCount) break;
      acc += armWeightK(k, Rg);
      chosen = k;
      if (acc >= target) break;
    }
    float sinI = uArmB[chosen].w;
    float dir = OmG >= uOmegaP ? 1.0 : -1.0;
    float g = sqrt(-2.0 * log(max(1e-7, uJit))) * cos(TAU_G * uJit2);
    phiB = armPhiK(chosen, Rg) + (uArmB[chosen].z / sinI) * (dir * 0.45 + 0.55 * g);
  } else {
    phiB = uPick * TAU_G;
  }
  phiB += uOmegaP * tb;

  uint hm = hash3u(cid, mid, n);
  float cz = 2.0 * u01(hm) - 1.0;
  hm = hnext(hm); float az = TAU_G * u01(hm);
  hm = hnext(hm); float rr = pow(u01(hm), 1.0 / 3.0);
  hm = hnext(hm); float vexp = 1.2 + 3.5 * u01(hm);
  hm = hnext(hm); float hb = (u01(hm) - 0.5) * 2.0 * uYoungScaleH;
  float sz = sqrt(max(0.0, 1.0 - cz * cz));
  float rad = scale * (0.2 + 0.8 * rr) + vexp * age;
  float dR = rad * sz * cos(az);
  float dT = rad * sz * sin(az);
  float dH = rad * cz * 0.6;
  float Rm = max(30.0, Rg + dR);
  float Om = lutAt(Rm, 0).x;
  float nu = lutAt(Rg, 0).z;
  float phi = phiB + dT / Rg + Om * age;
  P = vec3(Rm * cos(phi), Rm * sin(phi), hb * cos(nu * age) + dH + warpH(Rm, phi));

  float x = age / tau;
  T = T0;
  L = 0.0;
  if (x < 1.0) {
    L = L0 * (1.0 + 0.8 * x);
    T = T0 * (1.0 - 0.18 * x);
  } else if (x < 1.1) {
    bool red = mass < 35.0;
    L = L0 * 1.6;
    T = red ? 3650.0 + 500.0 * u01(hash2u(cid, mid + 99u)) : T0 * 0.75;
  }
  L *= sfOn * uSfrBright;
}

void particleState(vec4 a0, vec4 a1, vec4 a2, float t, out vec3 P, out float L, out float T) {
  float kind = a0.x;
  float p1 = a0.y, p2 = a0.z, p3 = a0.w, p4 = a1.x, p5 = a1.y, p6 = a1.z, p7 = a1.w, p8 = a2.x;
  T = a2.y;
  L = a2.z;
  P = vec3(0.0);
  if (kind < 0.5) {
    // DISK
    float Rg = p1;
    vec4 f = lutAt(Rg, 0);
    float Om = f.x, ka = f.y, nu = f.z;
    float phig = p2 + Om * t;
    float x = -p3 * Rg * cos(ka * t + p4);
    float yph = (2.0 * Om / ka) * p3 * Rg * sin(ka * t + p4);
    if (uWaveM > 0.0) {
      float A = uWaveAmp * p7 * waveTaper(Rg);
      float th = uWaveM * (phig - uOmegaP * t - waveAlpha(Rg));
      x -= A * Rg * cos(th);
      yph += (2.0 * Om / ka) * A * Rg * sin(th);
    }
    float R = Rg + x;
    float phi = phig + yph / Rg;
    P = vec3(R * cos(phi), R * sin(phi), p5 * cos(nu * t + p6) + warpH(R, phi));
  } else if (kind < 1.5) {
    // BAR
    float a = p1;
    vec4 f = lutAt(a, 0);
    float th = p2 + (f.x - uOmegaB) * t;
    float s = uBarStrength;
    float q = 1.0 + (p3 - 1.0) * s;
    float xb = a * cos(th) + p7 * cos(p8);
    float yb = a * q * sin(th) + p7 * sin(p8);
    float H = p6 > 0.5 ? p4 * cos(2.0 * th + p5) * (0.35 + 0.65 * s) : p4 * cos(f.z * t + p5);
    float ang = uBarAngle0 + uOmegaB * t;
    float c = cos(ang), sn = sin(ang);
    P = vec3(xb * c - yb * sn, xb * sn + yb * c, H);
  } else if (kind < 2.5 || (kind > 3.5 && kind < 4.5)) {
    // SPHEROID or GLOBULAR CLUSTER member
    bool sph = kind < 2.5;
    float r0 = p1;
    vec4 f = lutAt(r0, 0);
    float Om = f.x, ka = f.y;
    float eR = sph ? p5 : 0.08;
    float psi = sph ? p6 : p2 * 3.1;
    float ph = ka * t + psi;
    float th = p2 + Om * t + (2.0 * Om / ka) * eR * sin(ph);
    float r = r0 * (1.0 - eR * cos(ph));
    float ci = p3, si = sqrt(max(0.0, 1.0 - ci * ci));
    float cn = cos(p4), sn = sin(p4);
    float ct = cos(th), st = sin(th);
    P = r * vec3(ct * cn - st * sn * ci, ct * sn + st * cn * ci, st * si);
    if (sph) P.z *= p7;
    else {
      float cz = 2.0 * p6 - 1.0;
      float sz = sqrt(max(0.0, 1.0 - cz * cz));
      float az = TAU_G * p7;
      P += p5 * vec3(sz * cos(az), sz * sin(az), cz);
    }
  } else {
    // YOUNG
    float cycle;
    youngState(p1, p2, p3, p4, p5, p6, p7, p8, T, L, t, P, L, T, cycle);
  }
}
#endif
`;
