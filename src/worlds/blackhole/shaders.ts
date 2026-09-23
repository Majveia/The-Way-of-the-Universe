/**
 * GLSL for the black-hole renderer. Four passes:
 *
 *  1. DISK_TEXTURE — the accretion flow's state on a (φ, ln r) grid: vertical optical depth τ,
 *     temperature T/T_peak (Page–Thorne profile × turbulence), u^t and Ω of circular orbits.
 *     Turbulence rotates with the Keplerian Ω(r) of each radius; the pattern regenerates on a
 *     local orbital cadence (per radial zone, crossfaded) so differential rotation shears it into
 *     streaks without winding it up forever.
 *  2. TRACE — one null geodesic per pixel, integrated backwards from the camera in Kerr–Schild
 *     coordinates (adaptive RK4; the same Hamiltonian as kerr.ts). The disk is a thin Gaussian
 *     slab (H = h·r) sampled along each step chord that enters the wedge |z| < 3.5 h ϖ, with LTE
 *     radiative transfer: source = Planck(g·T) (exact for thermal light), dτ from the slab.
 *     Outputs (MRT): [0] disk radiance + transmittance, [1] asymptotic sky direction + g_sky.
 *  3. ACCUMULATE — temporal anti-aliasing (jittered rays, exponential history).
 *  4. COMPOSITE — full resolution: upsampled disk light over the lensed sky. The Milky Way comes
 *     from a cube map with textureGrad footprints from the lens map; stars are point sources
 *     lensed analytically: each star's image is a Gaussian with covariance σ²JJᵀ + σ_src² in the
 *     source plane (J = ∂(sky direction)/∂(pixel)), so magnified images brighten and stretch into
 *     arcs while conserving flux — and demagnified sky fades into its mean surface brightness.
 */
import { COMMON_GLSL } from '../../shaders/lib/common';
import { NOISE_GLSL } from '../../shaders/lib/noise';

// ————————————————————————————————————————————————————————————————— shared Kerr–Schild code
export const KERR_GLSL = /* glsl */ `
uniform float uA;          // spin a/M
uniform float uLensing;    // 1 = curved spacetime, 0 = straight lines (comparison mode)

float ksR(vec3 x) {
  float a2 = uA * uA;
  float A = dot(x, x) - a2;
  return sqrt(0.5 * (A + sqrt(A * A + 4.0 * a2 * x.z * x.z)));
}

// Hamilton's equations for H = ½ g^μν p_μ p_ν in Cartesian Kerr–Schild coordinates.
// x: position, p: covariant spatial momentum, pt: p_t (conserved).
// v = dx/dλ, f = dp/dλ; also returns Boyer–Lindquist r and dr/dλ.
void ksRhs(vec3 x, vec3 p, float pt, out vec3 v, out vec3 f, out float r, out float vr) {
  float a = uA;
  float a2 = a * a;
  float A = dot(x, x) - a2;
  float D = max(sqrt(A * A + 4.0 * a2 * x.z * x.z), 1e-9);
  float r2 = 0.5 * (A + D);
  r = sqrt(r2);
  float S = r2 + a2;
  float iS = 1.0 / S;
  vec3 gr = vec3(r * x.x, r * x.y, x.z * S / r) / D;   // ∇r
  if (uLensing < 0.5) {
    v = p;
    f = vec3(0.0);
    vr = dot(gr, v);
    return;
  }
  vec3 l = vec3((r * x.x + a * x.y) * iS, (r * x.y - a * x.x) * iS, x.z / r);
  float Q = r2 * r2 + a2 * x.z * x.z;
  float fK = 2.0 * r2 * r / Q;
  float L = dot(l, p) - pt;
  float fL = fK * L;
  v = p - fL * l;
  float cf = (2.0 * r2 / Q) / Q;
  float tf = 3.0 * a2 * x.z * x.z - r2 * r2;
  vec3 gf = cf * (gr * tf - vec3(0.0, 0.0, 2.0 * a2 * r * x.z));
  float Wxy = (r * x.x + a * x.y) * p.x + (r * x.y - a * x.x) * p.y;
  float xp = x.x * p.x + x.y * p.y;
  float k12 = 2.0 * r * Wxy * iS * iS + x.z * p.z / r2;
  vec3 gW = (gr * xp + vec3(r * p.x - a * p.y, a * p.x + r * p.y, 0.0)) * iS - k12 * gr + vec3(0.0, 0.0, p.z / r);
  f = (0.5 * L * L) * gf + fL * gW;
  vr = dot(gr, v);
}

void ksRhs(vec3 x, vec3 p, float pt, out vec3 v, out vec3 f) {
  float r, vr;
  ksRhs(x, p, pt, v, f, r, vr);
}
`;

// ————————————————————————————————————————————————————————————————— 1. disk texture
export const DISK_TEXTURE_FRAG = /* glsl */ `
precision highp float;
${COMMON_GLSL}
${NOISE_GLSL}
in vec2 vUv;
out vec4 outColor;
uniform float uA;
uniform float uTime;       // M
uniform float uLnR0;       // ln r at v = 0
uniform float uLnSpan;     // ln(r_out / r_0)
uniform float uRin;
uniform float uRout;
uniform float uTau0;       // vertical optical depth of the inner disk
uniform float uTurb;       // 0..1 turbulence contrast
uniform float uSeed;
uniform sampler2D uProfile;  // T/T_peak along v
uniform vec4 uHot;         // hot spot: r, azimuth now, size (r_g), strength (0 = off)

const float ZONE_W = 0.35; // radial zone width in ln r (one zone per ~42 % in radius)

float omegaK(float r) { return 1.0 / (r * sqrt(r) + uA); }

// Turbulent streaks in log-polar coordinates, seamless in φ; zero-mean, unit-ish variance.
float streaks(float lr, float ph, float seed) {
  vec3 q = vec3(cos(ph) * 6.5, sin(ph) * 6.5, lr * 19.0) + vec3(seed * 1.7, seed * 0.37, seed * 3.1);
  float n = fbm3(q, 3);
  float fil = 1.0 - abs(snoise(q * vec3(2.3, 2.3, 1.6) + 11.0));
  return n * 1.6 + (fil * fil - 0.45) * 0.9;
}

// Pattern of zone k: regenerates every ~0.55 local orbits, crossfading two phases.
float zonePattern(float k, float lr, float phi, float r) {
  float rk = exp(uLnR0 + (k + 0.5) * ZONE_W);
  float Tk = 0.55 * TAU / omegaK(rk);
  float ph = uTime / Tk + hash11(k * 7.13 + uSeed) ;
  float s0 = fract(ph);
  float s1 = fract(ph + 0.5);
  float w0 = 1.0 - abs(2.0 * s0 - 1.0);
  float w1 = 1.0 - w0;
  float om = omegaK(r);
  float n0 = streaks(lr, phi - om * s0 * Tk, floor(ph) * 13.1 + k * 7.3 + uSeed);
  float n1 = streaks(lr, phi - om * s1 * Tk, floor(ph + 0.5) * 13.1 + k * 7.3 + 3.7 + uSeed);
  return (w0 * n0 + w1 * n1) / sqrt(w0 * w0 + w1 * w1);
}

void main() {
  float lr = uLnR0 + vUv.y * uLnSpan;
  float r = exp(lr);
  float phi = vUv.x * TAU;
  float sr = sqrt(r);
  float r32 = r * sr;
  float Om = 1.0 / (r32 + uA);
  float den = r32 - 3.0 * sr + 2.0 * uA;
  float ut = den > 0.0 ? (r32 + uA) / (pow(r, 0.75) * sqrt(den)) : 0.0;

  // Two nearest radial zones, blended.
  float zc = (lr - uLnR0) / ZONE_W - 0.5;
  float k0 = floor(zc);
  float fz = smoothstep(0.0, 1.0, zc - k0);
  float n = mix(zonePattern(k0, lr, phi, r), zonePattern(k0 + 1.0, lr, phi, r), fz);
  n /= sqrt(fz * fz + (1.0 - fz) * (1.0 - fz)) ;
  n = clamp(n * 0.55, -1.6, 1.6);

  float tProf = texture(uProfile, vec2(vUv.y, 0.5)).r;
  float edgeIn = smoothstep(uRin * 0.985, uRin * 1.03, r);
  float edgeOut = 1.0 - smoothstep(uRout * 0.45, uRout, r);
  // Log-normal density (MRI-like), thinner and wispier outwards.
  float outer = smoothstep(uRout * 0.25, uRout * 0.9, r);
  float tau = uTau0 * edgeIn * edgeOut * edgeOut * exp(uTurb * (1.5 + 1.2 * outer) * n - uTurb * 0.6 * outer);
  float temp = tProf * (1.0 + uTurb * 0.085 * n);

  // Orbiting hot spot (a compact flare, cf. GRAVITY 2018 near-infrared flares of Sgr A*).
  if (uHot.w > 0.0) {
    float dphi = phi - uHot.y;
    dphi -= TAU * floor(dphi / TAU + 0.5);
    float dr = r - uHot.x;
    float sig = uHot.z;
    float gsp = exp(-0.5 * (dr * dr + uHot.x * uHot.x * dphi * dphi * 0.35) / (sig * sig));
    temp *= 1.0 + uHot.w * gsp;
    tau *= 1.0 + 3.0 * gsp;
  }
  outColor = vec4(tau, temp, ut, Om);
}`;

// ————————————————————————————————————————————————————————————————— 2. trace
export function traceFrag(maxSteps: number, diskSamples: number): string {
  return /* glsl */ `
precision highp float;
#define MAX_STEPS ${maxSteps}
#define DISK_SAMPLES ${diskSamples}
${COMMON_GLSL}
${KERR_GLSL}
in vec2 vUv;
layout(location = 0) out vec4 oLight;
layout(location = 1) out vec4 oSky;

uniform vec2 uRes;          // trace target size (px)
uniform vec2 uJitter;       // sub-pixel offset (px)
uniform vec2 uTan;          // tan(half fov) x, y
uniform vec3 uCamPos;       // Kerr–Schild position of the camera (M)
uniform vec4 uE0, uE1, uE2, uE3;  // covariant tetrad components (x, y, z, t)
uniform float uCapR;        // capture radius (inward rays inside it cannot escape)
uniform float uHorizon;
uniform float uInside;      // 1 if the camera is inside the horizon
uniform float uEscR;        // escape radius
uniform float uEps;         // relative step
uniform mat3 uToSky;        // Kerr–Schild direction → sky (world) frame
uniform float uFrame;

// Disk
uniform float uDiskOn;
uniform sampler2D uDisk;    // (τ, T/Tpeak, u^t, Ω) on (φ/2π, (ln r − ln r0)/span)
uniform vec2 uDiskMap;      // ln r0, 1/span
uniform vec2 uDiskR;        // r_in, r_out
uniform float uH;           // thickness H/r
uniform float uTpeak;
uniform float uDiskNorm;    // HDR radiance of a blackbody at T_peak
uniform float uShift;       // bit 1: Doppler, bit 2: gravitational
uniform vec2 uDiskTexel;    // texture size (φ, r)
uniform float uPixAngle;    // radians per trace pixel
uniform sampler2D uPlanck;
uniform vec2 uPlanckMap;    // ln Tmin, 1/(ln Tmax − ln Tmin)

// Overlays (lensed rings in the equatorial plane): ISCO, prograde & retrograde photon orbits
uniform vec4 uRings;        // radii (0 = off)
uniform vec3 uRingColA, uRingColB;

vec3 planck(float T) {
  float u = (log(max(T, 1.0)) - uPlanckMap.x) * uPlanckMap.y;
  if (u <= 0.0) return vec3(0.0);
  vec4 s = texture(uPlanck, vec2(clamp(u, 0.0, 1.0), 0.5));
  return s.rgb * exp2(s.a);
}

// Radiative transfer through the disk slab along the chord a → b (≈ the geodesic over one step).
void diskChord(vec3 a, vec3 b, float N, float ptS, float kphiS, float jit, float dist, inout vec3 L, inout float T) {
  float c = 3.5 * uH;
  float c2 = c * c;
  vec3 D = b - a;
  float qa = D.z * D.z - c2 * dot(D.xy, D.xy);
  float qb = 2.0 * (a.z * D.z - c2 * dot(a.xy, D.xy));
  float qc = a.z * a.z - c2 * dot(a.xy, a.xy);
  float s0 = 0.0, s1 = 1.0;
  float disc = qb * qb - 4.0 * qa * qc;
  if (abs(qa) < 1e-12) {
    if (abs(qb) < 1e-12) { if (qc > 0.0) return; }
    else { float sr = -qc / qb; if (qb > 0.0) s1 = min(s1, sr); else s0 = max(s0, sr); }
  } else if (disc < 0.0) {
    if (qa > 0.0) return;          // never inside the wedge
  } else {
    float sq = sqrt(disc);
    float ra = (-qb - sq) / (2.0 * qa), rb = (-qb + sq) / (2.0 * qa);
    float lo = min(ra, rb), hi = max(ra, rb);
    if (qa > 0.0) { s0 = max(s0, lo); s1 = min(s1, hi); }
    else {
      // inside outside the roots: keep the hull of the parts within [0,1]
      bool left = lo > 0.0, right = hi < 1.0;
      if (!left && !right) return;
      if (!left) s0 = max(s0, hi);
      if (!right) s1 = min(s1, lo);
    }
  }
  if (s1 <= s0) return;
  float len = length(D) * (s1 - s0);
  vec3 mid = a + D * (0.5 * (s0 + s1));
  float rm = max(length(mid.xy), 0.5);
  if (rm > uDiskR.y * 1.02 + len || rm < uDiskR.x * 0.9 - len) return;
  int n = int(clamp(ceil(len / (0.75 * uH * rm)), 1.0, float(DISK_SAMPLES)));
  float ds = len / float(n);
  for (int j = 0; j < DISK_SAMPLES; j++) {
    if (j >= n) break;
    float s = s0 + (s1 - s0) * (float(j) + jit) / float(n);
    vec3 q = a + D * s;
    float r = ksR(q);
    if (r < uDiskR.x * 0.97 || r > uDiskR.y) continue;
    float Hs = uH * r;
    float zz = q.z / Hs;
    float prof = exp(-0.5 * zz * zz);
    if (prof < 2e-3) continue;
    float v = (log(r) - uDiskMap.x) * uDiskMap.y;
    float u = atan(q.y, q.x) * (1.0 / TAU);
    // Footprint-based LOD: pixel cone width at this distance vs texel size.
    float foot = (dist + length(q - a)) * uPixAngle;
    float texel = min(TAU * r / uDiskTexel.x, r / (uDiskMap.y * uDiskTexel.y));
    float lod = max(0.0, log2(foot / texel));
    vec4 tex = textureLod(uDisk, vec2(u, v), lod);
    float dtau = tex.r * prof / (2.5066283 * Hs) * ds;
    if (dtau < 1e-5) continue;
    float ut = tex.b, Om = tex.a;
    float e = ptS + Om * kphiS;                // (E − ΩL)/N
    if (e <= 0.0 || ut <= 0.0) continue;
    float g = 1.0 / (N * ut * e);
    if (uShift < 2.5) {
      float r2 = r * r, a2 = uA * uA;
      float del = r2 - 2.0 * r + a2;
      float Ab = (r2 + a2) * (r2 + a2) - a2 * del;
      float alpha = sqrt(max(r2 * del / Ab, 0.0));
      float w = 2.0 * uA * r / Ab;
      float gg = alpha / (N * max(ptS + w * kphiS, 1e-6));
      g = uShift > 1.5 ? gg : (uShift > 0.5 ? g / gg : 1.0);
    }
    vec3 S = planck(g * tex.g * uTpeak) * uDiskNorm;
    float att = 1.0 - exp(-dtau);
    L += T * att * S;
    T *= 1.0 - att;
    if (T < 2e-3) return;
  }
}

vec3 weakTail(vec3 x, vec3 v) {
  float s = dot(x, v);
  vec3 c = x - s * v;
  float b = length(c);
  if (b < 1e-6) return v;
  float defl = uLensing * (2.0 / b) * (1.0 - s / sqrt(b * b + s * s));
  return normalize(v - defl * c / b);
}

void main() {
  vec2 px = gl_FragCoord.xy + uJitter;
  vec2 ndc = px / uRes * 2.0 - 1.0;
  vec3 d = normalize(vec3(ndc.x * uTan.x, ndc.y * uTan.y, -1.0));
  vec4 kc = -uE0 + d.x * uE1 + d.y * uE2 + d.z * uE3;
  vec3 x = uCamPos;
  vec3 p = kc.xyz;
  float pt = kc.w;
  vec3 v0, f0;
  ksRhs(x, p, pt, v0, f0);
  float N = max(length(v0), 1e-6);
  p /= N;
  pt /= N;
  float kphi = x.x * p.y - x.y * p.x;         // conserved k_φ (scaled)

  float jit = fract(ign(gl_FragCoord.xy + vec2(uFrame * 5.588, uFrame * 1.13)));
  vec3 L = vec3(0.0);
  float T = 1.0;
  float fate = 0.0;                            // 0 lost, 1 escaped, 2 captured, 3 opaque
  float dist = 0.0;
  float rc0 = 0.0, rc1 = 0.0, tc0 = 0.0, tc1 = 0.0;
  int nCross = 0;
  vec3 vEnd = v0 / N;
  float rStart = ksR(x);

  for (int i = 0; i < MAX_STEPS; i++) {
    vec3 v1, f1;
    float r, vr;
    ksRhs(x, p, pt, v1, f1, r, vr);
    vEnd = v1;
    if (vr < 0.0 && r < (uInside > 0.5 ? uHorizon * 1.0005 : uCapR)) { fate = 2.0; break; }
    if (r > uEscR && vr > 0.0) { fate = 1.0; break; }
    float speed = length(v1) + 1e-9;
    float grow = 1.0 + 2.0 * smoothstep(25.0, 120.0, r);
    float h = uEps * r * grow / speed;
    h = min(h, 8.0 * uEps * length(p) / (length(f1) + 1e-9));
    // Classical RK4 (k1 reused from above).
    vec3 v2, f2, v3, f3, v4, f4;
    ksRhs(x + 0.5 * h * v1, p + 0.5 * h * f1, pt, v2, f2);
    ksRhs(x + 0.5 * h * v2, p + 0.5 * h * f2, pt, v3, f3);
    ksRhs(x + h * v3, p + h * f3, pt, v4, f4);
    vec3 xn = x + (h / 6.0) * (v1 + 2.0 * v2 + 2.0 * v3 + v4);
    vec3 pn = p + (h / 6.0) * (f1 + 2.0 * f2 + 2.0 * f3 + f4);
    // Equatorial crossing → overlay rings (drawn on the upper surface of the disk).
    if (x.z * xn.z < 0.0 && nCross < 2) {
      vec3 q = mix(x, xn, x.z / (x.z - xn.z));
      float rq = ksR(q);
      if (nCross == 0) { rc0 = rq; tc0 = T; } else { rc1 = rq; tc1 = T; }
      nCross++;
    }
    if (uDiskOn > 0.5) diskChord(x, xn, N, pt, kphi, jit, dist, L, T);
    dist += length(xn - x);
    x = xn;
    p = pn;
    if (T < 2e-3) { fate = 3.0; break; }
    if (!(abs(x.x) < 1e7)) { fate = 2.0; break; }  // NaN guard: diving into the horizon
  }

  // Overlay rings: thin lines of constant pixel width at the first two crossings.
  if (uRings.x + uRings.y + uRings.z + uRings.w > 0.0) {
    float w0 = max(fwidth(rc0), 1e-4), w1 = max(fwidth(rc1), 1e-4);
    for (int k = 0; k < 4; k++) {
      float R = uRings[k];
      if (R <= 0.0) continue;
      vec3 col = k == 0 ? uRingColA : uRingColB;
      if (rc0 > 0.0 && w0 < 0.6) L += col * tc0 * exp(-0.5 * pow((rc0 - R) / (0.7 * w0), 2.0));
      if (rc1 > 0.0 && w1 < 0.6) L += col * tc1 * 0.6 * exp(-0.5 * pow((rc1 - R) / (0.7 * w1), 2.0));
    }
  }

  vec3 dirSky = vec3(0.0);
  float gSky = 0.0;
  if (fate == 1.0) {
    vec3 dir = weakTail(x, normalize(vEnd));
    dirSky = normalize(uToSky * dir);
    gSky = 1.0 / max(N * pt, 1e-6);   // ν_camera / ν_emitted for starlight from infinity
  } else if (fate != 1.0) {
    T = fate == 3.0 ? T : 0.0;
  }
  if (fate == 3.0) T = 0.0;
  oLight = vec4(L, T);
  oSky = vec4(dirSky, gSky);
}`;
}

// ————————————————————————————————————————————————————————————————— 3. accumulate
export const ACCUM_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uCurrent;
uniform sampler2D uHistory;
uniform float uAlpha;
void main() {
  vec4 c = texture(uCurrent, vUv);
  vec4 h = texture(uHistory, vUv);
  outColor = uAlpha >= 1.0 ? c : mix(h, c, uAlpha);
}`;

// ————————————————————————————————————————————————————————————————— 4. composite
export const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
${COMMON_GLSL}
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uAccum;    // disk light + transmittance (history)
uniform sampler2D uSky;      // sky direction + g (current frame, jittered)
uniform samplerCube uEnv;    // background cube map (Milky Way)
uniform float uEnvOn;
uniform vec2 uTraceTexel;
uniform vec2 uJitterUV;
uniform float uScale;        // trace px per output px
uniform float uEnvGain;
uniform float uStarGain;
uniform float uStarsOn;
uniform float uSigmaPix;     // star PSF in output pixels
uniform float uSigmaSrc;     // intrinsic source size (rad) — regularises caustics
uniform vec3 uLayerN;        // cells per cube-face edge
uniform vec3 uLayerMean;     // mean flux per cell (for the unresolved limit)
uniform vec4 uMagLo, uMagHi; // per layer magnitude range
uniform vec3 uAvgStarColor;
uniform sampler2D uPlanck;
uniform vec2 uPlanckMap;
uniform sampler2D uCT;       // colour → temperature
uniform vec2 uCTMap;         // qMin, 1/(qMax − qMin)
uniform float uSkyShift;     // 1 = apply g to the sky

vec4 planckS(float T) {
  float u = (log(max(T, 1.0)) - uPlanckMap.x) * uPlanckMap.y;
  vec4 s = texture(uPlanck, vec2(clamp(u, 0.0, 1.0), 0.5));
  return vec4(s.rgb, u <= 0.0 ? -60.0 : s.a);
}

// Absolute Planck RGB ratio between T·g and T (Doppler/gravitational shift of thermal light).
vec3 shiftRatio(float T, float g) {
  vec4 a = planckS(T);
  vec4 b = planckS(T * g);
  return (b.rgb + 1e-6) / (a.rgb + 1e-6) * exp2(b.a - a.a);
}

vec3 cubeDir(float face, vec2 uv) {
  if (face < 0.5) return vec3(1.0, uv.x, uv.y);
  if (face < 1.5) return vec3(-1.0, uv.x, uv.y);
  if (face < 2.5) return vec3(uv.x, 1.0, uv.y);
  if (face < 3.5) return vec3(uv.x, -1.0, uv.y);
  if (face < 4.5) return vec3(uv.x, uv.y, 1.0);
  return vec3(uv.x, uv.y, -1.0);
}

// Face index and in-face coordinates (−1..1) of direction D, for the major (k = 0) or
// second-largest (k = 1) axis — the latter finds stars across a cube edge.
vec3 faceOf(vec3 D, int k) {
  vec3 a = abs(D);
  int ax;
  if (k == 0) ax = (a.x >= a.y && a.x >= a.z) ? 0 : (a.y >= a.z ? 1 : 2);
  else {
    int m = (a.x >= a.y && a.x >= a.z) ? 0 : (a.y >= a.z ? 1 : 2);
    if (m == 0) ax = a.y >= a.z ? 1 : 2;
    else if (m == 1) ax = a.x >= a.z ? 0 : 2;
    else ax = a.x >= a.y ? 0 : 1;
  }
  if (ax == 0) return vec3(D.x > 0.0 ? 0.0 : 1.0, D.yz / a.x);
  if (ax == 1) return vec3(D.y > 0.0 ? 2.0 : 3.0, D.xz / a.y);
  return vec3(D.z > 0.0 ? 4.0 : 5.0, D.xy / a.z);
}

float starTemp(float u) {
  if (u < 0.10) return mix(2900.0, 3800.0, u / 0.10);
  if (u < 0.36) return mix(3800.0, 5200.0, (u - 0.10) / 0.26);
  if (u < 0.58) return mix(5200.0, 6200.0, (u - 0.36) / 0.22);
  if (u < 0.78) return mix(6200.0, 7800.0, (u - 0.58) / 0.20);
  if (u < 0.93) return mix(7800.0, 11000.0, (u - 0.78) / 0.15);
  return mix(11000.0, 30000.0, (u - 0.93) / 0.07);
}

// Sum of lensed point stars of one layer near D.
vec3 starLayer(vec3 D, vec3 t1, vec3 t2, mat2 Spix, float N, float mLo, float mHi, float seed, float dens, float g, float shiftOn) {
  vec3 acc = vec3(0.0);
  float k = 0.806; // 0.35 ln 10 : dN/dm ∝ 10^{0.35 m}
  float e0 = exp(k * mLo), e1 = exp(k * mHi);
  for (int f = 0; f < 2; f++) {
    vec3 fu = faceOf(D, f);
    if (f == 1 && max(abs(fu.y), abs(fu.z)) > 1.0 + 3.0 / N) break;   // far from any edge
    vec2 cell = floor((fu.yz * 0.5 + 0.5) * N);
    for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
      vec2 c = cell + vec2(float(i), float(j));
      if (c.x < 0.0 || c.y < 0.0 || c.x >= N || c.y >= N) continue;
      vec4 h = vec4(hash33(vec3(c, fu.x * 131.0 + seed)), hash13(vec3(c.yx + 17.0, fu.x * 71.0 + seed * 1.3)));
      if (h.w > dens) continue;
      vec2 suv = ((c + 0.15 + 0.7 * h.xy) / N) * 2.0 - 1.0;
      vec3 S = normalize(cubeDir(fu.x, suv));
      vec3 dd = S - D;
      vec2 delta = vec2(dot(dd, t1), dot(dd, t2));
      float det = Spix[0][0] * Spix[1][1] - Spix[0][1] * Spix[1][0];
      float q = (Spix[1][1] * delta.x * delta.x - 2.0 * Spix[0][1] * delta.x * delta.y + Spix[0][0] * delta.y * delta.y) / det;
      if (q > 18.0) continue;
      float m = log(e0 + h.z * (e1 - e0)) / k;
      float flux = exp2(-1.3288 * m);            // 10^{−0.4 m}
      float T = starTemp(fract(h.w * 7.31 + h.x));
      vec3 col;
      if (shiftOn > 0.5) {
        vec4 a = planckS(T);
        vec4 b = planckS(T * g);
        col = b.rgb * exp2(b.a - a.a);
      } else col = planckS(T).rgb;
      float l = luma(col);
      col = max(vec3(l) + 1.2 * (col - vec3(l)), 0.0);
      acc += col * flux * exp(-0.5 * q) / (6.2831853 * sqrt(det));
    }
  }
  return acc;
}

vec3 stars(vec3 D, vec3 Dx, vec3 Dy, float g, float shiftOn, float galDens) {
  vec3 t1 = normalize(abs(D.y) < 0.95 ? cross(D, vec3(0.0, 1.0, 0.0)) : cross(D, vec3(1.0, 0.0, 0.0)));
  vec3 t2 = cross(D, t1);
  mat2 J = mat2(dot(Dx, t1), dot(Dx, t2), dot(Dy, t1), dot(Dy, t2)); // columns: ∂/∂x, ∂/∂y
  mat2 JJ = J * transpose(J);
  float sp2 = uSigmaPix * uSigmaPix;
  float ss2 = uSigmaSrc * uSigmaSrc;
  mat2 Spix = JJ * sp2 + mat2(ss2, 0.0, 0.0, ss2);
  float tr = Spix[0][0] + Spix[1][1];
  float dt = Spix[0][0] * Spix[1][1] - Spix[0][1] * Spix[1][0];
  float lmax = 0.5 * tr + sqrt(max(0.25 * tr * tr - dt, 0.0));
  float foot = sqrt(lmax);
  vec3 total = vec3(0.0);
  for (int L = 0; L < 3; L++) {
    float N = uLayerN[L];
    float cellAng = 2.0 / N;
    float wPoint = 1.0 - smoothstep(0.22, 0.45, foot / cellAng);
    float dens = L == 0 ? 0.85 : clamp(0.55 + 0.45 * galDens * float(L), 0.0, 1.0);
    if (wPoint > 0.0) total += wPoint * starLayer(D, t1, t2, Spix, N, uMagLo[L], uMagHi[L], float(L) * 17.0 + 3.0, dens, g, shiftOn);
    if (wPoint < 1.0) total += (1.0 - wPoint) * uAvgStarColor * dens * uLayerMean[L] / (cellAng * cellAng);
  }
  return total;
}

void main() {
  vec4 acc = texture(uAccum, vUv);
  vec3 col = acc.rgb;
  float T = acc.a;
  if (T > 1e-4) {
    vec2 uv = vUv - uJitterUV;
    vec4 c = texture(uSky, uv);
    float lc = length(c.xyz);
    if (lc > 0.02) {
      vec3 D = c.xyz / lc;
      float g = c.w / max(lc, 0.5);
      vec2 ex = vec2(uTraceTexel.x, 0.0), ey = vec2(0.0, uTraceTexel.y);
      vec4 xp = texture(uSky, uv + ex), xm = texture(uSky, uv - ex);
      vec4 yp = texture(uSky, uv + ey), ym = texture(uSky, uv - ey);
      bool vxp = length(xp.xyz) > 0.9, vxm = length(xm.xyz) > 0.9;
      bool vyp = length(yp.xyz) > 0.9, vym = length(ym.xyz) > 0.9;
      vec3 Dx = vxp && vxm ? 0.5 * (normalize(xp.xyz) - normalize(xm.xyz)) : (vxp ? normalize(xp.xyz) - D : (vxm ? D - normalize(xm.xyz) : vec3(0.5)));
      vec3 Dy = vyp && vym ? 0.5 * (normalize(yp.xyz) - normalize(ym.xyz)) : (vyp ? normalize(yp.xyz) - D : (vym ? D - normalize(ym.xyz) : vec3(0.5)));
      Dx *= uScale;
      Dy *= uScale;
      float shiftOn = (uSkyShift > 0.5 && abs(g - 1.0) > 0.004) ? 1.0 : 0.0;
      vec3 sky = vec3(0.0);
      float galDens = 0.0;
      if (uEnvOn > 0.5) {
        sky = textureGrad(uEnv, D, Dx, Dy).rgb * uEnvGain;
        vec3 coarse = textureLod(uEnv, D, 6.0).rgb;
        galDens = clamp(luma(coarse) * 25.0, 0.0, 1.0);
        if (shiftOn > 0.5) {
          float q = log(max(sky.b, 1e-7) / max(sky.r, 1e-7));
          float lnT = texture(uCT, vec2(clamp((q - uCTMap.x) * uCTMap.y, 0.0, 1.0), 0.5)).r;
          sky *= shiftRatio(exp(lnT), g);
        }
      }
      if (uStarsOn > 0.5) sky += stars(D, Dx, Dy, g, shiftOn, galDens) * uStarGain;
      col += T * sky;
    }
  }
  outColor = vec4(max(col, 0.0), 1.0);
}`;
