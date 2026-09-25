/**
 * GLSL for the black-hole renderer. Four passes:
 *
 *  1. DISK_TEXTURE — the accretion flow's state on a (φ, ln r) grid: vertical optical depth τ,
 *     temperature T/T_peak (Page–Thorne profile × turbulence), u^t and Ω of circular orbits.
 *     Turbulence rotates with the Keplerian Ω(r) of each radius; the pattern regenerates on a
 *     local orbital cadence (per radial zone, crossfaded) so differential rotation shears it into
 *     streaks without winding it up forever. The noise itself is baked once (DISK_NOISE).
 *  2. TRACE — one null geodesic per pixel, integrated backwards from the camera in Kerr–Schild
 *     coordinates (adaptive RK4; the same Hamiltonian as kerr.ts). The disk is a thin Gaussian
 *     slab (H = h·r) sampled along each step chord that enters the wedge |z| < 3.5 h ϖ, with LTE
 *     radiative transfer: source = Planck(g·T) (exact for thermal light), dτ from the slab.
 *     Outputs (MRT): [0] disk radiance + transmittance, [1] asymptotic sky direction + g_sky.
 *     Lens cache: while the camera only turns about the spin axis (the idle orbit) the geometry is
 *     unchanged, so rays that never met the disk are reused and only the rest are traced again.
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
// Turbulent streaks in log-polar coordinates, seamless in φ; zero-mean, unit-ish variance.
// One noise unit spans 1/AZ rad in azimuth and 1/RAD in ln r, so at any radius features are
// RAD/AZ ≈ 20× (growing with each octave) longer along the orbit than across it before shear (which
// winds them further) — MRI turbulence is dominated by azimuthally stretched structures (e.g. Hawley &
// Balbus 1991; Guan et al. 2009). Thin ridged sheets carry the hottest gas; octave count scales with
// quality.
const STREAKS_GLSL = /* glsl */ `
#ifndef DISK_OCT
#define DISK_OCT 4
#endif
float streaks(float lr, float ph, float seed) {
  const float AZ = 1.3, RAD = 26.0;
  vec3 q = vec3(cos(ph) * AZ, sin(ph) * AZ, lr * RAD) + vec3(seed * 1.7, seed * 0.37, seed * 3.1);
  float n = 0.0, amp = 1.0, norm = 0.0;
  vec3 qq = q;
  for (int i = 0; i < DISK_OCT; i++) {
    n += amp * snoise(qq);
    norm += amp;
    qq = qq * vec3(1.7, 1.7, 2.5) + vec3(17.1, -9.3, 5.7);   // finer octaves are ever more streaky
    amp *= 0.5;
  }
  n /= norm;
  // Thin, hot current sheets: ridges of a higher-frequency field.
  float f = 1.0 - abs(snoise(q * vec3(2.2, 2.2, 3.2) + 11.0));
  f *= f;
  f *= f;
  f *= f;
  // Broad cooler, denser lanes.
  float lanes = smoothstep(0.2, 0.75, snoise(q * vec3(0.55, 0.55, 0.8) - 4.0));
  return n * 2.1 + (f - 0.08) * 2.4 - lanes * 1.2;
}`;

/**
 * 1a. Noise bake (once per disk geometry/seed): three independent realisations of the streak field
 * (RGB) and the fine axisymmetric ring structure (A) on the disk texture's own (φ, ln r) grid. It
 * holds all the simplex noise (≈ 30 evaluations per texel), so the per-frame pass below only has to
 * shear and crossfade it: ~0.2 ms instead of ~5 ms at 2048 × 512 on a mid laptop GPU.
 */
export const DISK_NOISE_FRAG = /* glsl */ `
precision highp float;
${COMMON_GLSL}
${NOISE_GLSL}
${STREAKS_GLSL}
in vec2 vUv;
out vec4 outColor;
uniform float uLnR0;       // ln r at v = 0
uniform float uLnSpan;     // ln(r_out / r_0)
uniform float uSeed;
void main() {
  float lr = uLnR0 + vUv.y * uLnSpan;
  float phi = vUv.x * TAU;
  float rings = snoise(vec3(lr * 64.0, uSeed * 0.71, 0.3)) * 0.6 + snoise(vec3(lr * 150.0, uSeed * 1.37, 2.1)) * 0.4;
  outColor = vec4(streaks(lr, phi, uSeed + 1.0), streaks(lr, phi, uSeed + 14.1), streaks(lr, phi, uSeed + 27.3), rings);
}`;

/**
 * 1b. The accretion flow's state on a (φ, ln r) grid, every frame: vertical optical depth τ,
 * temperature T/T_peak (Page–Thorne profile × turbulence), u^t and Ω of circular orbits.
 * Turbulence rotates with the Keplerian Ω(r) of each radius; the pattern regenerates on a local
 * orbital cadence (per radial zone, crossfaded) so differential rotation shears it into streaks
 * without winding it up forever. Each regeneration picks one of the baked realisations, mirrored
 * and turned by a random angle.
 */
export const DISK_TEXTURE_FRAG = /* glsl */ `
precision highp float;
${COMMON_GLSL}
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
uniform sampler2D uNoise;    // baked streaks (rgb) and rings (a) on this texture's grid
uniform vec4 uHot;         // hot spot: r, azimuth now, size (r_g), strength (0 = off)

const float ZONE_W = 0.35; // radial zone width in ln r (one zone per ~42 % in radius)

float omegaK(float r) { return 1.0 / (r * sqrt(r) + uA); }

// One regeneration of the streak field, turned by ph (radians).
float streakAt(float v, float ph, float seed) {
  float h = hash11(seed * 0.618 + 0.13);
  float ch = floor(h * 3.0);
  float turn = fract(h * 7.37 + 0.31);
  float mirror = fract(h * 13.1) < 0.5 ? 1.0 : -1.0;
  vec3 n = textureLod(uNoise, vec2(mirror * ph * (1.0 / TAU) + turn, v), 0.0).rgb;
  return ch < 0.5 ? n.r : (ch < 1.5 ? n.g : n.b);
}

// Pattern of zone k: regenerates every ~0.55 local orbits, crossfading two phases.
float zonePattern(float k, float v, float phi, float r) {
  float rk = exp(uLnR0 + (k + 0.5) * ZONE_W);
  float Tk = 0.55 * TAU / omegaK(rk);
  float ph = uTime / Tk + hash11(k * 7.13 + uSeed) ;
  float s0 = fract(ph);
  float s1 = fract(ph + 0.5);
  float w0 = 1.0 - abs(2.0 * s0 - 1.0);
  float w1 = 1.0 - w0;
  float om = omegaK(r);
  float n0 = streakAt(v, phi - om * s0 * Tk, floor(ph) * 13.1 + k * 7.3 + uSeed);
  float n1 = streakAt(v, phi - om * s1 * Tk, floor(ph + 0.5) * 13.1 + k * 7.3 + 3.7 + uSeed);
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
  float n = mix(zonePattern(k0, vUv.y, phi, r), zonePattern(k0 + 1.0, vUv.y, phi, r), fz);
  n /= sqrt(fz * fz + (1.0 - fz) * (1.0 - fz)) ;
  // Fine concentric structure (axisymmetric, so it needs no shear treatment).
  float rings = textureLod(uNoise, vec2(0.0, vUv.y), 0.0).a;
  n = clamp(n * 0.55 + 0.35 * rings, -1.8, 1.8);

  float tProf = texture(uProfile, vec2(vUv.y, 0.5)).r;
  float edgeIn = smoothstep(uRin * 0.985, uRin * 1.03, r);
  float edgeOut = 1.0 - smoothstep(uRout * 0.45, uRout, r);
  // Log-normal density (MRI-like), thinner and wispier outwards.
  float outer = smoothstep(uRout * 0.25, uRout * 0.9, r);
  float tau = uTau0 * edgeIn * edgeOut * edgeOut * exp(uTurb * (1.5 + 1.0 * outer) * n - uTurb * (0.6 + 0.6 * outer));
  // Flux fluctuations of order unity (MRI simulations) → T = F^{1/4} varies by ~±25 %.
  float temp = tProf * exp(uTurb * 0.28 * n);

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
uniform mat3 uKsToCam;      // Kerr–Schild direction → camera frame (right, up, back)
uniform float uFrame;
// Lens cache: 1 = the geometry (up to a rotation about the spin axis) is that of uSkyCache's frame;
// rays that never met the disk are then taken from the cache instead of being traced again.
uniform float uCached;
uniform sampler2D uSkyCache;

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
uniform float uDebug;       // 0 off; 1 T/Tpeak, 2 g, 3 lod, 4 tau, 13 fate, 14 r_min/steps, 15 cost
vec3 dbgCol = vec3(-1.0);
int dbgSamples = 0;         // disk samples taken (cost profiling, debug mode 15)
bool touched = false;       // the ray passed through the disk slab (whatever its opacity now)

vec3 planck(float T) {
  float u = (log(max(T, 1.0)) - uPlanckMap.x) * uPlanckMap.y;
  if (u <= 0.0) return vec3(0.0);
  // Explicit LOD: implicit-derivative lookups inside data-dependent loops are undefined in GLSL ES
  // and make D3D (ANGLE) compilers try to unroll the whole march.
  vec4 s = textureLod(uPlanck, vec2(clamp(u, 0.0, 1.0), 0.5), 0.0);
  return s.rgb * exp2(s.a);
}

// erf(x), Abramowitz & Stegun 7.1.26 (|error| < 1.5e-7).
float erfApprox(float x) {
  float s = sign(x);
  x = abs(x);
  float t = 1.0 / (1.0 + 0.3275911 * x);
  float y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-x * x);
  return s * y;
}

// Radiative transfer through the disk slab along the chord a → b (≈ the geodesic over one step).
void diskChord(vec3 a, vec3 b, float N, float ptS, float kphiS, float jit, float dist, inout vec3 L, inout float T) {
  float c = 2.8 * uH;   // wedge |z| < 2.8 H: 99.5 % of the Gaussian column
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
  // Segments short enough that r (and so T, H, the texture) is nearly constant along each; the
  // vertical structure is integrated exactly per segment (Gaussian column through a straight chord).
  float horiz = length(D.xy) * (s1 - s0);
  // Grazing rays cross a wide range of radii inside the slab: sample every ~4 % in radius (the
  // loop exits as soon as the gas turns opaque, so the extra samples cost little).
  int n = int(clamp(ceil(horiz / (0.04 * rm)), 1.0, float(DISK_SAMPLES)));
  float sinInc = abs(D.z) / max(length(D), 1e-9);
  float segL = len / float(n);
  dbgSamples += 1000;          // one chord (profiling: chords × 1000 + samples)
  for (int j = 0; j < DISK_SAMPLES; j++) {
    if (j >= n) break;
    dbgSamples++;
    float sa = s0 + (s1 - s0) * float(j) / float(n);
    float sb = s0 + (s1 - s0) * float(j + 1) / float(n);
    vec3 qa = a + D * sa;
    vec3 qb = a + D * sb;
    vec3 q = mix(qa, qb, 0.25 + 0.5 * jit);   // jittered point for the (smooth) radial quantities
    float r = ksR(q);
    if (r < uDiskR.x * 0.97 || r > uDiskR.y) continue;
    float Hs = uH * r;
    float ia = qa.z / (1.41421356 * Hs), ib = qb.z / (1.41421356 * Hs);
    float dz = abs(ib - ia);
    // ∫ exp(−z²/2H²) ds along the segment, divided by √(2π) H  (so that ∫ over z gives 1).
    float colFrac = dz > 1e-3 ? segL * abs(erfApprox(ib) - erfApprox(ia)) / (2.0 * dz * 1.41421356 * Hs)
                              : segL * exp(-0.25 * (ia + ib) * (ia + ib)) / (2.5066283 * Hs);
    if (colFrac < 1e-7) continue;
    touched = true;
    float v = (log(r) - uDiskMap.x) * uDiskMap.y;
    float u = atan(q.y, q.x) * (1.0 / TAU);
    // Anisotropic footprint: the pixel cone's width along the orbit, and stretched by 1/sin(i)
    // across radii where the ray grazes the disk. Hardware anisotropic filtering does the rest.
    float foot = (dist + length(q - a)) * uPixAngle;
    vec2 gU = vec2(foot / (TAU * r), 0.0);
    vec2 gV = vec2(0.0, foot / max(sinInc, 0.03) / r * uDiskMap.y);
    vec4 tex = textureGrad(uDisk, vec2(u, v), gU, gV);
    float dtau = tex.r * colFrac;
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
    if (uDebug > 0.5 && dbgCol.x < 0.0) {
      dbgCol = uDebug < 1.5 ? vec3(tex.g) : uDebug < 2.5 ? vec3(g * 0.5) : uDebug < 3.5 ? vec3(log2(max(gV.y * uDiskTexel.y, 1.0)) * 0.1) : uDebug < 4.5 ? vec3(tex.r * 0.01) : uDebug < 9.5 ? vec3(v, r / 20.0, 0.0) : uDebug < 10.5 ? vec3(fract(u), uDiskMap.x, uDiskMap.y) : vec3(g * tex.g * uTpeak / 30000.0, N * 0.5, ptS);
    }
    vec3 S = planck(g * tex.g * uTpeak) * uDiskNorm;
    float att = 1.0 - exp(-dtau);
    L += T * att * S;
    T *= 1.0 - att;
    if (T < 2e-3) return;
  }
}

// Remaining bending beyond the escape sphere, first order in M/r (see weakFieldTail in kerr.ts):
// Einstein's 4M/b split along the path, evaluated in isotropic coordinates. The Kerr–Schild chart is
// Schwarzschild-like (areal r), where a ray's angle ψ to the radial direction obeys
// tan ψ_iso = (1 − M/r) tan ψ and ρ_iso ≈ r − M. Skipping that change of chart made the sky
// direction depend on where the march stopped (≈ M b / r², several pixels at r = 60).
vec3 weakTail(vec3 x, vec3 v) {
  float r = length(x);
  vec3 n = x / r;
  float c = dot(v, n);
  vec3 t = v - c * n;
  float s = length(t);
  if (s < 1e-6) return v;
  t /= s;
  float psi = atan(s, c) - uLensing * s * c / r;
  float b = max((r - uLensing) * sin(psi), 1e-3);
  float ang = psi + uLensing * (2.0 / b) * (1.0 - cos(psi));
  return cos(ang) * n + sin(ang) * t;
}

void main() {
  if (uCached > 0.5) {
    // Same geometry as the cached frame: a ray that never met the disk has the same fate and sky
    // direction (in the camera frame), so only its transmittance is needed. Rays next to the disk
    // or on the shadow's edge are traced again (with this frame's jitter) to keep them antialiased.
    ivec2 q = ivec2(gl_FragCoord.xy);
    ivec2 hi = ivec2(uRes) - 1;
    vec4 c = texelFetch(uSkyCache, q, 0);
    float wa = texelFetch(uSkyCache, min(q + ivec2(1, 0), hi), 0).w;
    float wb = texelFetch(uSkyCache, max(q - ivec2(1, 0), ivec2(0)), 0).w;
    float wc = texelFetch(uSkyCache, min(q + ivec2(0, 1), hi), 0).w;
    float wd = texelFetch(uSkyCache, max(q - ivec2(0, 1), ivec2(0)), 0).w;
    bool esc = c.w > 0.0;
    bool quiet = min(min(c.w, wa), min(min(wb, wc), wd)) >= 0.0
      && (wa > 0.0) == esc && (wb > 0.0) == esc && (wc > 0.0) == esc && (wd > 0.0) == esc;
    if (quiet) {
      oLight = vec4(0.0, 0.0, 0.0, esc ? 1.0 : 0.0);
      oSky = c;
      return;
    }
  }
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
  float rMinDbg = rStart;
  int nStepDbg = 0;
  // Per-ray step scale. A ray whose impact parameter b = |x × p|/E is large never comes close and
  // bends gently everywhere, so it tolerates proportionally longer steps (RK4's error is set by the
  // curvature, ∝ b²/r⁴): ≈ 30 % fewer steps in the default view at the same sky/disk accuracy
  // (checked against float64 integrations at 1/20 of the step, see tests/gargantua.test.ts).
  float kb = uInside > 0.5 ? 1.0 : clamp(length(cross(x, p)) / max(abs(pt), 1e-6) * (1.0 / 8.0), 1.0, 2.5);
  float wedge = 2.8 * uH;                      // disk slab half-opening |z| < wedge · ϖ
  float wA = length(x.xy);

  for (int i = 0; i < MAX_STEPS; i++) {
    vec3 v1, f1;
    float r, vr;
    ksRhs(x, p, pt, v1, f1, r, vr);
    vEnd = v1;
    rMinDbg = min(rMinDbg, r);
    // No photon that reaches infinity ever dips below the prograde photon orbit, so from outside
    // the horizon anything inside uCapR is captured whatever its (numerically fragile) direction.
    if (uInside > 0.5 ? (vr < 0.0 && r < uHorizon * 1.0005) : r < uCapR) { fate = 2.0; break; }
    if (vr > 0.0 && r > uEscR * 0.9995) { fate = 1.0; break; }
    float speed = length(v1) + 1e-9;
    float grow = 1.0 + 2.0 * smoothstep(25.0, 120.0, r);
    float hc = uEps * r * min(grow * kb, 2.5);   // coordinate length of this step
    float h = hc / speed;
    h = min(h, 8.0 * uEps * length(p) / (length(f1) + 1e-9));
    // The last step lands on the escape sphere (dr/dλ is known), where the analytic tail takes
    // over: every ray hands over at the same radius, so the lens map has no step-count seams
    // (which would ring the lens Jacobian and streak the stars) and no step is ever redone.
    if (vr > 0.0 && r + h * vr > uEscR) h = max((uEscR - r) / vr, 1e-3);
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
    nStepDbg = i;
    // A chord much longer than the step asked for means RK4 blew up (a ray whipping round just
    // outside the horizon in single precision): never let such a chord paint the disk.
    float chord = length(xn - x);
    bool sane = chord < 3.0 * hc;
    // Exact cheap rejection: on one side of the plane |z| is linear along the chord and ϖ convex,
    // so a chord whose two ends lie outside the wedge |z| < wedge·ϖ never enters it.
    float wB = length(xn.xy);
    bool nearDisk = x.z * xn.z <= 0.0 || abs(x.z) < wedge * wA || abs(xn.z) < wedge * wB;
    if (uDiskOn > 0.5 && sane && nearDisk) diskChord(x, xn, N, pt, kphi, jit, dist, L, T);
    if (!sane && r < 3.0) { fate = 2.0; break; }
    dist += chord;
    x = xn;
    p = pn;
    wA = wB;
    if (T < 2e-3) { fate = 3.0; break; }
    // NaN guard: rays grazing the ring singularity or diving at the horizon faster than the
    // step control can follow can only have come from the hole.
    if (!(dot(x, x) < 1e14) || !(dot(p, p) < 1e20)) { fate = 2.0; break; }
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

  // Sky, in the camera frame (invariant when the camera only turns about the spin axis): the
  // deflection relative to the unlensed pixel direction (small almost everywhere, so even half
  // floats keep sub-pixel precision) and g_sky = ν_camera/ν_emitted of starlight. The sign of w
  // records whether the ray met the disk (for the lens cache): escaped w = ±g, otherwise 0 / −1e-6.
  oSky = vec4(0.0, 0.0, 0.0, touched ? -1e-6 : 0.0);
  if (fate == 1.0) {
    vec3 dirCam = normalize(uKsToCam * weakTail(x, normalize(vEnd)));
    float g = clamp(1.0 / max(N * pt, 1e-6), 1e-3, 1e4);
    oSky = vec4(dirCam - d, touched ? -g : g);
  } else {
    T = 0.0;
  }
  if (uDebug > 14.5) { oLight = vec4(float(nStepDbg + 1), float(dbgSamples / 1000), float(dbgSamples - (dbgSamples / 1000) * 1000), fate); return; }
  if (uDebug > 13.5) { oLight = vec4(rMinDbg / 5.0, rc0 / 5.0, float(nStepDbg) / float(MAX_STEPS), 0.0); return; }
  if (uDebug > 12.5) { oLight = vec4(fate == 1.0 ? 1.0 : 0.0, fate == 2.0 ? 1.0 : 0.0, fate == 0.0 ? 1.0 : (fate == 3.0 ? 0.5 : 0.0), 0.0); return; }
  if (uDebug > 11.5) { float TT = 1000.0 * pow(40.0, vUv.x); oLight = vec4(vUv.y > 0.5 ? planck(TT) * 0.25 : vec3(texture(uPlanck, vec2((log(TT) - uPlanckMap.x) * uPlanckMap.y, 0.5)).a / -20.0 + 0.5), 0.0); return; }
  if (uDebug > 4.5 && uDebug < 8.5) { vec4 tt = textureLod(uDisk, vUv, 0.0); oLight = vec4(uDebug < 5.5 ? vec3(tt.g) : uDebug < 6.5 ? vec3(tt.a * 4.0) : uDebug < 7.5 ? vec3(tt.b * 0.5) : vec3(tt.r * 0.01), 0.0); return; }
  if (uDebug > 0.5) { oLight = vec4(max(dbgCol, 0.0), 0.0); return; }
  oLight = vec4(L, T);
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

// ————————————————————————————————————————————————————————————————— metering (auto exposure)
// Each output texel averages log₂ luminance of a 4×4 grid of trace texels in its cell; the CPU
// reads the tiny target back asynchronously and exposes for a high percentile (the highlights).
export const METER_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uAccum;
uniform vec2 uCells;
void main() {
  vec2 cell = floor(vUv * uCells);
  float s = 0.0;
  for (int j = 0; j < 4; j++)
    for (int i = 0; i < 4; i++) {
      vec2 uv = (cell + (vec2(float(i), float(j)) + 0.5) / 4.0) / uCells;
      vec3 c = texture(uAccum, uv).rgb;
      s += log2(dot(c, vec3(0.2126, 0.7152, 0.0722)) + 1e-4);
    }
  outColor = vec4(clamp((s / 16.0 + 16.0) / 24.0, 0.0, 1.0), 0.0, 0.0, 1.0);
}`;

// ————————————————————————————————————————————————————————————————— 4. composite
export const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
${COMMON_GLSL}
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uAccum;    // disk light + transmittance (history)
uniform sampler2D uSky;      // lens map: camera-frame deflection Δ + g (see the trace pass)
uniform samplerCube uEnv;    // background cube map (Milky Way)
uniform float uEnvOn;
uniform vec2 uTraceRes;      // trace target size (px)
uniform vec2 uJitter;        // jitter of the lens map's samples (trace px)
uniform vec2 uTan;
uniform mat3 uCamToSky;      // camera axes (right, up, back) in the sky frame, this frame
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
uniform float uDbg;

vec4 planckS(float T) {
  float u = (log(max(T, 1.0)) - uPlanckMap.x) * uPlanckMap.y;
  vec4 s = textureLod(uPlanck, vec2(clamp(u, 0.0, 1.0), 0.5), 0.0);
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

// PCG4D (Jarzynski & Olano 2020, "Hash Functions for GPU Rendering"): a proper integer hash. The
// float "hash without sine" shows faint diagonal correlations between neighbouring integer cells,
// which lined stars up into streaks like satellite trails.
uvec4 pcg4d(uvec4 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.w; v.y += v.z * v.x; v.z += v.x * v.y; v.w += v.y * v.z;
  v ^= v >> 16u;
  v.x += v.y * v.w; v.y += v.z * v.x; v.z += v.x * v.y; v.w += v.y * v.z;
  return v;
}
vec4 cellHash(vec2 c, float face, float seed) {
  uvec4 h = pcg4d(uvec4(uint(c.x), uint(c.y), uint(face), uint(seed * 7.0 + 3.0)));
  return vec4(h) * (1.0 / 4294967296.0);
}

// Sum of lensed point stars of one layer near D. "reach" is the PSF's extent in the source plane
// (radians, ≈ 4.2 σ along its major axis): cells whose star region (the middle 70 % of the cell)
// lies further than that are skipped before hashing — in unlensed sky that is every neighbour, so
// the 3 × 3 search costs one hash instead of nine.
vec3 starLayer(vec3 D, vec3 t1, vec3 t2, mat2 Spix, float N, float mLo, float mHi, float seed, float dens, float g, float shiftOn, float reach) {
  vec3 acc = vec3(0.0);
  float k = 0.806; // 0.35 ln 10 : dN/dm ∝ 10^{0.35 m}
  float e0 = exp(k * mLo), e1 = exp(k * mHi);
  float det = Spix[0][0] * Spix[1][1] - Spix[0][1] * Spix[1][0];
  for (int f = 0; f < 2; f++) {
    vec3 fu = faceOf(D, f);
    if (f == 1 && max(abs(fu.y), abs(fu.z)) > 1.0 + 3.0 / N) break;   // far from any edge
    vec2 cp = (fu.yz * 0.5 + 0.5) * N;
    vec2 cell = floor(cp);
    vec2 fr = cp - cell;
    // Gnomonic face coordinates stretch by up to (1 + u² + v²) per radian; one cell is 2/N in uv.
    float rc = reach * (1.0 + dot(fu.yz, fu.yz)) * 0.5 * N;
    float rc2 = rc * rc;
    for (int j = -1; j <= 1; j++) {
      float dy = j == 0 ? max(max(0.15 - fr.y, fr.y - 0.85), 0.0) : (j < 0 ? fr.y + 0.15 : 1.15 - fr.y);
      if (dy * dy > rc2) continue;
      for (int i = -1; i <= 1; i++) {
        float dx = i == 0 ? max(max(0.15 - fr.x, fr.x - 0.85), 0.0) : (i < 0 ? fr.x + 0.15 : 1.15 - fr.x);
        if (dx * dx + dy * dy > rc2) continue;
        vec2 c = cell + vec2(float(i), float(j));
        if (c.x < 0.0 || c.y < 0.0 || c.x >= N || c.y >= N) continue;
        vec4 h = cellHash(c, fu.x, seed);
        if (h.w > dens) continue;
        vec2 suv = ((c + 0.15 + 0.7 * h.xy) / N) * 2.0 - 1.0;
        vec3 S = normalize(cubeDir(fu.x, suv));
        vec3 dd = S - D;
        vec2 delta = vec2(dot(dd, t1), dot(dd, t2));
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
    if (wPoint > 0.0) total += wPoint * starLayer(D, t1, t2, Spix, N, uMagLo[L], uMagHi[L], float(L) * 17.0 + 3.0, dens, g, shiftOn, 4.25 * foot);
    if (wPoint < 1.0) total += (1.0 - wPoint) * uAvgStarColor * dens * uLayerMean[L] / (cellAng * cellAng);
  }
  return total;
}

// Sky direction (sky frame) and g of one trace texel; w = 0 if that ray did not reach the sky. The
// trace stores the deflection in the camera frame against the unlensed direction of its (jittered)
// sample position, so the current camera rotation applies — which keeps a cached lens map valid
// while the camera turns about the spin axis.
vec4 fetchDir(ivec2 t) {
  // Outside the trace: invalid, so the Jacobian falls back to one-sided differences at the border.
  if (any(lessThan(t, ivec2(0))) || any(greaterThanEqual(t, ivec2(uTraceRes)))) return vec4(0.0);
  vec4 s = texelFetch(uSky, t, 0);
  float g = abs(s.w);
  if (g < 1e-4) return vec4(0.0);
  vec2 ndc = (vec2(t) + 0.5 + uJitter) / uTraceRes * 2.0 - 1.0;
  vec3 dCam = normalize(vec3(ndc * uTan, -1.0));
  return vec4(uCamToSky * normalize(dCam + s.xyz), g);
}

void main() {
  vec4 acc = texture(uAccum, vUv);
  vec3 col = acc.rgb;
  float T = acc.a;
  if (T > 1e-4) {
    // Manual, validity-aware bilinear reconstruction of the lens map (jitter-corrected), plus a
    // central-difference Jacobian at the nearest texel n. Six fetches: the plus stencil around n
    // and the one corner of the bilinear cell that is not in it.
    vec2 P = vUv * uTraceRes - uJitter - 0.5;
    vec2 fl = floor(P);
    vec2 fr = P - fl;
    ivec2 i0 = ivec2(fl);
    vec2 sn = step(0.5, fr);
    ivec2 n = i0 + ivec2(sn);
    ivec2 dir = ivec2(1) - 2 * ivec2(sn);          // from n towards the cell's other corners
    vec4 cm = fetchDir(n);
    vec4 xp = fetchDir(n + ivec2(1, 0)), xm = fetchDir(n - ivec2(1, 0));
    vec4 yp = fetchDir(n + ivec2(0, 1)), ym = fetchDir(n - ivec2(0, 1));
    vec4 cd = fetchDir(n + dir);
    vec4 cx = dir.x > 0 ? xp : xm, cy = dir.y > 0 ? yp : ym;
    float ax = sn.x > 0.5 ? fr.x : 1.0 - fr.x;      // bilinear weight of n's column / row
    float ay = sn.y > 0.5 ? fr.y : 1.0 - fr.y;
    float vm = step(1e-6, cm.w) * ax * ay, vx = step(1e-6, cx.w) * (1.0 - ax) * ay;
    float vy = step(1e-6, cy.w) * ax * (1.0 - ay), vd = step(1e-6, cd.w) * (1.0 - ax) * (1.0 - ay);
    float wsum = vm + vx + vy + vd;
    if (wsum > 1e-4) {
      vec3 D = normalize(cm.xyz * vm + cx.xyz * vx + cy.xyz * vy + cd.xyz * vd);
      float g = (cm.w * vm + cx.w * vx + cy.w * vy + cd.w * vd) / wsum;
      bool vxp = xp.w > 0.0, vxm = xm.w > 0.0, vyp = yp.w > 0.0, vym = ym.w > 0.0, vc = cm.w > 0.0;
      vec3 C = vc ? cm.xyz : D;
      vec3 Dx = vxp && vxm ? 0.5 * (xp.xyz - xm.xyz) : (vxp ? xp.xyz - C : (vxm ? C - xm.xyz : vec3(0.5)));
      vec3 Dy = vyp && vym ? 0.5 * (yp.xyz - ym.xyz) : (vyp ? yp.xyz - C : (vym ? C - ym.xyz : vec3(0.5)));
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
          float lnT = textureLod(uCT, vec2(clamp((q - uCTMap.x) * uCTMap.y, 0.0, 1.0), 0.5), 0.0).r;
          sky *= shiftRatio(exp(lnT), g);
        }
      }
      if (uDbg > 1.5) { vec3 fu = faceOf(D, 0); outColor = vec4(fract(fu.x * 0.37) , fu.y * 0.5 + 0.5, fu.z * 0.5 + 0.5, 1.0); return; }
      if (uDbg > 0.5) {
        vec3 t1 = normalize(abs(D.y) < 0.95 ? cross(D, vec3(0.0, 1.0, 0.0)) : cross(D, vec3(1.0, 0.0, 0.0)));
        vec3 t2 = cross(D, t1);
        mat2 J = mat2(dot(Dx, t1), dot(Dx, t2), dot(Dy, t1), dot(Dy, t2));
        float px = 2.0 * uTan.y / uTraceRes.y * uScale;
        mat2 JJ = J * transpose(J);
        float tr = JJ[0][0] + JJ[1][1], dt = JJ[0][0] * JJ[1][1] - JJ[0][1] * JJ[1][0];
        float l1 = 0.5 * tr + sqrt(max(0.25 * tr * tr - dt, 0.0)), l2 = max(0.5 * tr - sqrt(max(0.25 * tr * tr - dt, 0.0)), 1e-20);
        outColor = vec4(sqrt(l1) / px * 0.5, sqrt(l2) / px * 0.5, sqrt(l1 / l2) * 0.1, 1.0);
        return;
      }
      if (uStarsOn > 0.5) sky += stars(D, Dx, Dy, g, shiftOn, galDens) * uStarGain;
      col += T * sky;
    }
  }
  outColor = vec4(max(col, 0.0), 1.0);
}`;
