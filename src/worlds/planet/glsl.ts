/**
 * GLSL for the planet renderer (planets module).
 *
 * Space: every pass works in the planet's *spin frame* in units of the equatorial radius
 * (ground = unit sphere; oblate planets are handled by dividing by uEllipsoid first).
 * Radiance convention: see src/physics/planets-photometry.ts — `uSunColor` is the star's
 * irradiance E divided by π, so a white Lambertian surface at normal incidence has radiance E.
 * The atmosphere LUTs are computed per unit *true* irradiance, so scattered radiance is
 * multiplied by π·uSunColor.
 */

/** Uniform block + helpers shared by the surface, atmosphere and LUT passes. */
export const ATMO_GLSL = /* glsl */ `
uniform float uTop;          // atmosphere top radius (ground = 1)
uniform vec3 uRay;           // Rayleigh scattering at ground, per radius
uniform float uRayH;         // Rayleigh scale height, radii
uniform vec3 uMieS;          // Mie scattering, per radius
uniform vec3 uMieE;          // Mie extinction, per radius
uniform float uMieH;
uniform vec3 uMieG;          // HG asymmetry per channel
uniform vec3 uAbsorb;        // absorbing layer peak coefficient, per radius
uniform float uAbsC;         // absorbing layer centre altitude, radii
uniform float uAbsW;         // absorbing layer half-width, radii
uniform vec3 uGroundAlbedo;
uniform float uSunAng;       // angular radius of the star seen from the planet

#define TRANS_W 256.0
#define TRANS_H 64.0
#define MS_W 32.0
#define MS_H 32.0
#define IRR_W 64.0
#define IRR_H 16.0

vec3 atmoDensity(float h) {
  return vec3(exp(-h / uRayH), exp(-h / uMieH), max(0.0, 1.0 - abs(h - uAbsC) / uAbsW));
}

float distToTop(float r, float mu) {
  float disc = r * r * (mu * mu - 1.0) + uTop * uTop;
  return max(0.0, -r * mu + sqrt(max(disc, 0.0)));
}

// Bruneton (2017) transmittance parameterisation: x_r = ρ/H, x_μ = (d − d_min)/(d_max − d_min).
vec2 transmittanceUV(float r, float mu) {
  float H = sqrt(max(0.0, uTop * uTop - 1.0));
  float rho = sqrt(max(0.0, r * r - 1.0));
  float d = distToTop(r, mu);
  float dmin = uTop - r;
  float dmax = rho + H;
  float xm = clamp((d - dmin) / max(dmax - dmin, 1e-12), 0.0, 1.0);
  float xr = clamp(rho / H, 0.0, 1.0);
  return vec2(0.5 / TRANS_W + xm * (1.0 - 1.0 / TRANS_W), 0.5 / TRANS_H + xr * (1.0 - 1.0 / TRANS_H));
}

vec2 msUV(float r, float muS) {
  float x = clamp(muS * 0.5 + 0.5, 0.0, 1.0);
  float y = clamp((r - 1.0) / (uTop - 1.0), 0.0, 1.0);
  return vec2(0.5 / MS_W + x * (1.0 - 1.0 / MS_W), 0.5 / MS_H + y * (1.0 - 1.0 / MS_H));
}
vec2 irrUV(float r, float muS) {
  float x = clamp(muS * 0.5 + 0.5, 0.0, 1.0);
  float y = clamp((r - 1.0) / (uTop - 1.0), 0.0, 1.0);
  return vec2(0.5 / IRR_W + x * (1.0 - 1.0 / IRR_W), 0.5 / IRR_H + y * (1.0 - 1.0 / IRR_H));
}

// Fraction of the stellar disk above the local horizon (soft terminator from the star's size).
float sunVisibility(float r, float muS) {
  float muH = -sqrt(max(0.0, 1.0 - 1.0 / (r * r)));
  return smoothstep(-uSunAng, uSunAng, muS - muH);
}
`;

/** Lookups that need the LUT samplers (not used by the transmittance LUT pass itself). */
export const ATMO_LOOKUP_GLSL = /* glsl */ `
uniform sampler2D uTransLUT;
uniform sampler2D uMSLUT;
uniform sampler2D uIrrLUT;

vec3 transmittanceToTop(float r, float mu) { return texture(uTransLUT, transmittanceUV(r, mu)).rgb; }
vec3 sunTransmittance(float r, float muS) { return transmittanceToTop(r, muS) * sunVisibility(r, muS); }
vec3 msLookup(float r, float muS) { return texture(uMSLUT, msUV(r, muS)).rgb; }
vec3 skyIrradiance(float r, float muS) { return texture(uIrrLUT, irrUV(r, muS)).rgb; }
`;

/**
 * Single + multiple scattering along a ray segment [t0, t1] (per unit true irradiance).
 * Samples are distributed quadratically toward the point of closest approach to the planet centre
 * (the tangent point of limb rays, the ground end of downward rays), where the air is densest.
 * Analytic integration over each step (Hillaire 2015/2020): ∫ S·T = S (1 − e^{−σ_t Δt}) / σ_t.
 */
export const ATMO_INTEGRATE_GLSL = /* glsl */ `
uniform vec3 uSunDir;

struct AtmoSeg { vec3 L; vec3 T; };

void atmoStep(vec3 p, float dt, float pR, vec3 pM, inout vec3 L, inout vec3 T) {
  float r = length(p);
  vec3 d = atmoDensity(r - 1.0);
  vec3 sR = uRay * d.x;
  vec3 sM = uMieS * d.y;
  vec3 sigT = sR + uMieE * d.y + uAbsorb * d.z;
  float muS = dot(p, uSunDir) / r;
  vec3 S = (sR * pR + sM * pM) * sunTransmittance(r, muS) + (sR + sM) * msLookup(r, muS);
  vec3 Ts = exp(-sigT * dt);
  L += T * (S - S * Ts) / max(sigT, vec3(1e-9));
  T *= Ts;
}

AtmoSeg integrateAtmo(vec3 ro, vec3 rd, float t0, float t1, int n, float jitter) {
  vec3 L = vec3(0.0);
  vec3 T = vec3(1.0);
  if (t1 <= t0 || n <= 0) return AtmoSeg(L, T);
  float c = dot(rd, uSunDir);
  float pR = phaseRayleigh(c);
  vec3 pM = vec3(phaseHG(c, uMieG.x), phaseHG(c, uMieG.y), phaseHG(c, uMieG.z));
  float tm = clamp(-dot(ro, rd), t0, t1);
  float la = tm - t0;
  float lb = t1 - tm;
  int na = la > 0.0 ? max(1, int(float(n) * la / (la + lb) + 0.5)) : 0;
  int nb = lb > 0.0 ? max(1, n - na) : 0;
  float prev = 0.0;
  for (int i = 0; i < 64; i++) {
    if (i >= na) break;
    float s = float(i + 1) / float(na);
    float u0 = 1.0 - (1.0 - prev) * (1.0 - prev);
    float u1 = 1.0 - (1.0 - s) * (1.0 - s);
    float a = t0 + la * u0;
    float b = t0 + la * u1;
    atmoStep(ro + rd * mix(a, b, jitter), b - a, pR, pM, L, T);
    prev = s;
  }
  prev = 0.0;
  for (int i = 0; i < 64; i++) {
    if (i >= nb) break;
    float s = float(i + 1) / float(nb);
    float a = tm + lb * prev * prev;
    float b = tm + lb * s * s;
    atmoStep(ro + rd * mix(a, b, jitter), b - a, pR, pM, L, T);
    prev = s;
  }
  return AtmoSeg(L, T);
}
`;

/**
 * Aurora and airglow (Earth-like worlds). Emission in renderer radiance units per radius of path.
 * The auroral oval is centred on the geomagnetic pole, displaced toward the night side (magnetic
 * midnight ~23° from the pole, noon ~15°), brightest near midnight. Vertical profiles follow the
 * emission physics: O 557.7 nm peaks ~110 km; O 630.0 nm dominates above ~200 km; N₂⁺ 427.8 nm at
 * the lower border. Airglow: thin O 557.7/Na layer near 95 km.
 */
export const AURORA_GLSL = /* glsl */ `
uniform float uAurora;       // 0..1 intensity
uniform float uAirglow;      // 0..1
uniform vec3 uMagAxis;       // geomagnetic north dipole axis (spin frame)
uniform vec3 uAuroraGreen;
uniform vec3 uAuroraRed;
uniform vec3 uAuroraBlue;
uniform vec3 uAirglowColor;
uniform float uAuroraTime;

// Radii of the emitting shells (set per planet, ground = 1).
uniform vec4 uAuroraShell;   // x: bottom r, y: top r, z: km→radius factor, w: unused

float auroraCurtain(vec3 p, out float r) {
  r = length(p);
  vec3 d = p / r;
  float sm = dot(d, uMagAxis);                       // sin(magnetic latitude)
  float colat = acos(clamp(abs(sm), 0.0, 1.0));      // from the nearer magnetic pole
  vec3 noon = normalize(uSunDir - uMagAxis * dot(uSunDir, uMagAxis) + vec3(1e-5));
  vec3 dusk = cross(uMagAxis, noon);
  vec3 dh = d - uMagAxis * sm;
  float phi = atan(dot(dh, dusk), dot(dh, noon));    // 0 = magnetic noon, ±π = midnight
  float midnight = 0.5 - 0.5 * cos(phi);
  float hemi = sm > 0.0 ? 0.0 : 2.1;
  float t = uAuroraTime;
  // Large folds (analytic, periodic in φ) and a westward-travelling surge.
  float fold = 0.03 * sin(3.0 * phi + hemi + t * 0.07) * sin(5.0 * phi - t * 0.11 + 1.3)
             + 0.012 * sin(11.0 * phi + t * 0.23 + hemi);
  float theta0 = radians(15.5 + 7.5 * midnight) + fold;
  float width = radians(0.8 + 2.4 * midnight);
  float x = (colat - theta0) / width;
  float band = exp(-x * x);
  float x2 = (colat - theta0 + radians(3.5)) / (width * 0.45);
  band += 0.35 * exp(-x2 * x2) * midnight;
  if (band < 0.01) return 0.0;
  // Rays: fine structure along the arc (one noise evaluation), flickering slowly.
  float rays = 0.55 + 0.45 * snoise(vec3(cos(phi) * 30.0, sin(phi) * 30.0, t * 0.25 + hemi));
  return band * max(rays, 0.0) * (0.25 + 0.75 * midnight);
}

vec3 auroraEmission(vec3 ro, vec3 rd, float t0, float t1, float jitter) {
  vec3 E = vec3(0.0);
  if (uAurora <= 0.0) return E;
  vec2 hs = raySphere(ro, rd, vec3(0.0), uAuroraShell.y);
  float a = max(t0, hs.x);
  float b = min(t1, hs.y);
  if (b <= a) return E;
  // Reject rays that never come near an auroral oval (colatitude ~10°–32°).
  float lo = 10.0, hi = 0.0;
  for (int k = 0; k < 5; k++) {
    vec3 pk = normalize(ro + rd * mix(a, b, float(k) * 0.25));
    float cl = degrees(acos(clamp(abs(dot(pk, uMagAxis)), 0.0, 1.0)));
    lo = min(lo, abs(cl - 20.0));
  }
  if (lo > 12.0) return E;
  const int N = 16;
  float dt = (b - a) / float(N);
  float km = uAuroraShell.z;   // radii per km
  for (int i = 0; i < N; i++) {
    vec3 p = ro + rd * (a + (float(i) + jitter) * dt);
    float r;
    float c = auroraCurtain(p, r);
    if (c < 0.003) continue;
    float hkm = (r - 1.0) / km;
    // Vertical emission profiles (per line), sharp lower border ~95 km.
    float lower = smoothstep(88.0, 102.0, hkm);
    float green = lower * exp(-max(hkm - 112.0, 0.0) / 38.0) * exp(-max(108.0 - hkm, 0.0) / 6.0);
    float red = smoothstep(150.0, 230.0, hkm) * exp(-max(hkm - 260.0, 0.0) / 90.0) * 0.32;
    float blue = lower * exp(-abs(hkm - 100.0) / 9.0) * 0.45;
    E += c * (uAuroraGreen * green + uAuroraRed * red + uAuroraBlue * blue) * dt;
  }
  return E * uAurora;
}

vec3 airglowEmission(vec3 ro, vec3 rd, float t0, float t1, float jitter) {
  if (uAirglow <= 0.0) return vec3(0.0);
  float km = uAuroraShell.z;
  float rc = 1.0 + 95.0 * km;
  float s = 6.0 * km;
  vec2 o = raySphere(ro, rd, vec3(0.0), rc + 3.0 * s);
  float a = max(t0, o.x);
  float b = min(t1, o.y);
  if (b <= a) return vec3(0.0);
  vec2 inner = raySphere(ro, rd, vec3(0.0), rc - 3.0 * s);
  float sum = 0.0;
  const int N = 12;
  // March only the part outside the inner sphere (two segments for rays that cross it).
  float tm = clamp(-dot(ro, rd), a, b);
  for (int i = 0; i < N; i++) {
    float u = (float(i) + jitter) / float(N);
    // Quadratic sampling toward the tangent point on both sides.
    float ta = tm - (tm - a) * u * u;
    float tb = tm + (b - tm) * u * u;
    float wa = (tm - a) * 2.0 * u / float(N);
    float wb = (b - tm) * 2.0 * u / float(N);
    float ra = length(ro + rd * ta), rb = length(ro + rd * tb);
    sum += exp(-sqr((ra - rc) / s)) * wa + exp(-sqr((rb - rc) / s)) * wb;
  }
  // Night side only (drowned by daylight elsewhere).
  vec3 pm = normalize(ro + rd * tm);
  float night = smoothstep(0.05, -0.2, dot(pm, uSunDir));
  return uAirglowColor * sum * night * uAirglow;
}
`;

/** Shared utilities for the surface pass. */
export const SURFACE_UTIL_GLSL = /* glsl */ `
vec2 equirectUV(vec3 d) {
  float lon = atan(-d.z, d.x);
  float lat = asin(clamp(d.y, -1.0, 1.0));
  return vec2(lon * (0.5 / PI) + 0.5, lat / PI + 0.5);
}

// Seam-free gradients for an equirectangular lookup (Tarini 2012): pick the u-parameterisation whose
// screen-space derivative is continuous at this pixel.
struct EquiUV { vec2 uv; vec2 dx; vec2 dy; };
EquiUV equirect(vec3 d) {
  vec2 uv = equirectUV(d);
  float u2 = fract(uv.x + 0.5) - 0.5;
  vec2 d1 = vec2(dFdx(uv.x), dFdy(uv.x));
  vec2 d2 = vec2(dFdx(u2), dFdy(u2));
  vec2 du = dot(d1, d1) <= dot(d2, d2) ? d1 : d2;
  EquiUV e;
  e.uv = uv;
  e.dx = vec2(du.x, dFdx(uv.y));
  e.dy = vec2(du.y, dFdy(uv.y));
  return e;
}
vec4 sampleEqui(sampler2D t, EquiUV e) { return textureGrad(t, e.uv, e.dx, e.dy); }
vec4 sampleEquiBias(sampler2D t, EquiUV e, float scale) { return textureGrad(t, e.uv, e.dx * scale, e.dy * scale); }

// Tangent frame (east, north) on the unit sphere, spin axis +Y.
void tangentFrame(vec3 n, out vec3 east, out vec3 north) {
  east = normalize(vec3(-n.z, 0.0, -n.x) + vec3(1e-6, 0.0, 0.0));
  // east = d/dlon of (cos lat cos lon, sin lat, −cos lat sin lon) ∝ (−sin lon, 0, −cos lon)
  north = normalize(cross(east, n));
  north = -north;
}

float D_GGX(float NoH, float a) {
  float a2 = a * a;
  float d = NoH * NoH * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}
float V_SmithGGX(float NoV, float NoL, float a) {
  float a2 = a * a;
  float gv = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2);
  float gl = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2);
  return 0.5 / max(gv + gl, 1e-6);
}
float fresnelSchlick(float c, float f0) { return f0 + (1.0 - f0) * pow(1.0 - clamp(c, 0.0, 1.0), 5.0); }

// Soft shadow of spherical occluders (moons, planets) with the star's finite size: fraction of the
// stellar disk visible, from the angular separation of the two disks.
uniform vec4 uOccluder0;   // xyz centre (spin frame, radii), w radius (0 = none)
uniform vec4 uOccluder1;
uniform vec3 uUmbraLight;  // light refracted into an umbra by the occluder's atmosphere (Earth → red Moon)
float occluderVisibility(vec3 p, vec4 occ, out float umbra) {
  umbra = 0.0;
  if (occ.w <= 0.0) return 1.0;
  vec3 v = occ.xyz - p;
  float dist = length(v);
  float along = dot(v, uSunDir);
  if (along <= 0.0) return 1.0;
  float angSep = acos(clamp(along / dist, -1.0, 1.0));
  float angOcc = asin(clamp(occ.w / dist, 0.0, 1.0));
  float angSun = uSunAng;
  // Overlap fraction of two disks (smooth approximation of the lens area).
  float full = angOcc - angSun;                  // > 0: occluder can cover the sun completely
  float edge = angOcc + angSun;
  float cover = 1.0 - smoothstep(abs(full), edge, angSep);
  float maxCover = min(1.0, (angOcc * angOcc) / (angSun * angSun));
  umbra = full > 0.0 ? 1.0 - smoothstep(full * 0.85, full, angSep) : 0.0;
  return 1.0 - cover * maxCover;
}
float occlusion(vec3 p, out float umbra) {
  float u0, u1;
  float v = occluderVisibility(p, uOccluder0, u0) * occluderVisibility(p, uOccluder1, u1);
  umbra = max(u0, u1);
  return v;
}
`;

/** Ring optical-depth lookup shared by the ring pass and the planet (ring shadows). */
export const RING_TAU_GLSL = /* glsl */ `
uniform sampler2D uRingTex;    // x: radius in [inner, outer]; r: τ, g: dust fraction, b: brightness, a: colour var
uniform vec2 uRingRange;       // inner, outer (radii)
uniform float uRingOpacity;
vec4 ringSample(float r) {
  if (r < uRingRange.x || r > uRingRange.y) return vec4(0.0);
  float x = (r - uRingRange.x) / (uRingRange.y - uRingRange.x);
  vec4 s = texture(uRingTex, vec2(x, 0.5));
  s.r *= uRingOpacity;
  return s;
}
// Transmittance of sunlight through the ring plane for a point p (planet frame) toward uSunDir.
float ringShadow(vec3 p) {
  if (uRingRange.y <= 0.0 || abs(uSunDir.y) < 1e-4) return 1.0;
  float t = -p.y / uSunDir.y;
  if (t <= 0.0) return 1.0;
  vec3 q = p + uSunDir * t;
  float tau = ringSample(length(q.xz)).r;
  return exp(-tau / abs(uSunDir.y));
}
`;
