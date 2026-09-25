/**
 * GLSL for the cosmic-web renderer. All passes write linear radiance (or linear accumulators).
 *
 * Particle positions live in RGBA16UI textures (16-bit box fractions) fetched by gl_VertexID, so
 * every pass (density deposit, light accumulation, galaxies, replicas) reads the same data.
 */
import { BLACKBODY_GLSL } from '../../shaders/lib/blackbody';
import { COMMON_GLSL } from '../../shaders/lib/common';

/** Position fetch + interpolation between two keyframes, and the density atlas sampler. */
export const FETCH_GLSL = /* glsl */ `
uniform highp usampler2D uPosA;
uniform highp usampler2D uPosB;
uniform int uTexW;
uniform float uMix;        // growth-weighted interpolation A→B
uniform float uZA;         // < 0: interpolate; ≥ 0: Zel'dovich back-scaling of A by this factor
uniform float uNp;         // particles per side
uniform float uLatOff;     // lattice offset (box fraction)
uniform float uLatStep;    // lattice spacing (box fraction)

vec3 latticeQ(int id) {
  int np = int(uNp + 0.5);
  int i = id / (np * np);
  int j = (id / np) - i * np;
  int k = id - (id / np) * np;
  return vec3(float(i), float(j), float(k)) * uLatStep + uLatOff;
}

vec3 fetchBox(int id) {
  ivec2 tc = ivec2(id % uTexW, id / uTexW);
  vec3 a = vec3(texelFetch(uPosA, tc, 0).xyz) * (1.0 / 65536.0);
  if (uZA >= 0.0) {
    vec3 q = latticeQ(id);
    vec3 d = a - q;
    d -= floor(d + 0.5);
    return fract(q + uZA * d);
  }
  vec3 b = vec3(texelFetch(uPosB, tc, 0).xyz) * (1.0 / 65536.0);
  vec3 d = b - a;
  d -= floor(d + 0.5);
  return fract(a + uMix * d);
}
`;

/** Trilinear sampling of the density atlas: G³ cells tiled as tilesX × tilesY slices. */
export const DENSITY_SAMPLE_GLSL = /* glsl */ `
uniform sampler2D uDensity;
uniform float uGrid;       // G
uniform float uTilesX;
uniform float uDensDec;    // 1 for float atlases; undoes the 8-bit fallback's scaling
float densityTexel(ivec3 c) {
  int G = int(uGrid + 0.5);
  c = (c + 4 * G) % G;   // % is undefined for negative operands in GLSL ES 3.00
  int tx = c.z % int(uTilesX + 0.5);
  int ty = c.z / int(uTilesX + 0.5);
  return texelFetch(uDensity, ivec2(tx * G + c.x, ty * G + c.y), 0).r * uDensDec;
}
float sampleDensity(vec3 u) {
  vec3 g = u * uGrid - 0.5;
  vec3 f = fract(g);
  ivec3 c = ivec3(floor(g));
  float d000 = densityTexel(c);
  float d100 = densityTexel(c + ivec3(1, 0, 0));
  float d010 = densityTexel(c + ivec3(0, 1, 0));
  float d110 = densityTexel(c + ivec3(1, 1, 0));
  float d001 = densityTexel(c + ivec3(0, 0, 1));
  float d101 = densityTexel(c + ivec3(1, 0, 1));
  float d011 = densityTexel(c + ivec3(0, 1, 1));
  float d111 = densityTexel(c + ivec3(1, 1, 1));
  float x00 = mix(d000, d100, f.x), x10 = mix(d010, d110, f.x);
  float x01 = mix(d001, d101, f.x), x11 = mix(d011, d111, f.x);
  return mix(mix(x00, x10, f.y), mix(x01, x11, f.y), f.z);
}
`;

/** World placement shared by particle passes: box centred at the origin or wrapped around a point. */
export const PLACE_GLSL = /* glsl */ `
uniform float uBoxWorld;   // box side in world units (Mpc, × a in physical mode)
uniform vec3 uWrapCenter;  // box fraction the view is wrapped around
uniform float uWrap;       // 1 = periodic wrap around uWrapCenter (immersive), 0 = box at origin
uniform vec3 uOffset;      // replica offset in boxes
uniform vec4 uSlab;        // xyz = axis (unit), w = half thickness (box fraction; 0 = off)
uniform float uSlabCenter;
#ifdef REPLICAS
in vec3 aOffset;           // periodic image of the box (instanced: one draw for all 26 neighbours)
#define OFFSET aOffset
#else
#define OFFSET uOffset
#endif
vec3 placeWorld(vec3 u, out float keep) {
  keep = 1.0;
  vec3 rel;
  if (uWrap > 0.5) rel = fract(u - uWrapCenter + 0.5) - 0.5 + (uWrapCenter - 0.5);
  else rel = u - 0.5;
  if (uSlab.w > 0.0) {
    float s = dot(u, uSlab.xyz) - uSlabCenter;
    s -= floor(s + 0.5);
    keep = 1.0 - smoothstep(uSlab.w * 0.8, uSlab.w, abs(s));
  }
  return (rel + OFFSET) * uBoxWorld;
}
`;

// ——— Density atlas ———

export const DEPOSIT_VERT = /* glsl */ `
${FETCH_GLSL}
uniform float uGrid;
uniform float uTilesX;
uniform vec2 uAtlas;       // atlas size in texels
uniform float uWeight;
out float vW;
void main() {
  vec3 u = fetchBox(gl_VertexID);
  vec3 c = floor(u * uGrid);
  c = min(c, vec3(uGrid - 1.0));
  float tx = mod(c.z, uTilesX), ty = floor(c.z / uTilesX);
  vec2 px = vec2(tx * uGrid + c.x + 0.5, ty * uGrid + c.y + 0.5);
  gl_Position = vec4(px / uAtlas * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
  vW = uWeight;
}`;

export const DEPOSIT_FRAG = /* glsl */ `
precision highp float;
in float vW;
out vec4 outColor;
void main() { outColor = vec4(vW, 0.0, 0.0, 1.0); }`;

/** Separable periodic Gaussian (5 taps, σ ≈ 1 cell) along one axis of the tiled volume. */
export const BLUR_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D tSrc;
uniform float uGrid;
uniform float uTilesX;
uniform int uAxis;
float at(ivec3 c) {
  int G = int(uGrid + 0.5);
  c = (c + 4 * G) % G;   // % is undefined for negative operands in GLSL ES 3.00
  int tx = c.z % int(uTilesX + 0.5);
  int ty = c.z / int(uTilesX + 0.5);
  return texelFetch(tSrc, ivec2(tx * G + c.x, ty * G + c.y), 0).r;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int G = int(uGrid + 0.5);
  int tx = p.x / G, ty = p.y / G;
  ivec3 c = ivec3(p.x - tx * G, p.y - ty * G, ty * int(uTilesX + 0.5) + tx);
  ivec3 e = uAxis == 0 ? ivec3(1, 0, 0) : uAxis == 1 ? ivec3(0, 1, 0) : ivec3(0, 0, 1);
  float v = 0.375 * at(c) + 0.25 * (at(c + e) + at(c - e)) + 0.0625 * (at(c + 2 * e) + at(c - 2 * e));
  outColor = vec4(v, 0.0, 0.0, 1.0);
}`;

// ——— Light accumulation (dark matter) ———

export const ACCUM_VERT = /* glsl */ `
${FETCH_GLSL}
${DENSITY_SAMPLE_GLSL}
${PLACE_GLSL}
uniform float uSpacing;    // mean interparticle spacing, world units
uniform float uSmooth;     // smoothing length in units of the spacing at mean density
uniform float uHMax;       // largest smoothing length (deep voids), in units of the spacing
uniform vec2 uVoidFade;    // ρ/ρ̄ over which the emission of void particles fades in (y ≤ x: off)
uniform vec3 uThin;        // importance thinning below ρ/ρ̄ = x: keep fraction (ρ/x)^y, at least z (z = 0: off)
uniform float uFocalPx;    // focal length in pixels
uniform float uMinPx;
uniform float uMaxPx;
uniform float uFlux;       // normalisation (see WebRenderer)
uniform float uFadeFar;    // world distance where immersive views fade out (0 = off)
uniform float uNear;
uniform int uStride;       // draw every uStride-th particle (replicas)
uniform int uStrideOffset;
uniform float uGain;
uniform float uEmit;       // emissivity per unit mass ∝ (ρ/ρ̄)^uEmit (collisional emission ∝ ρ², clumping)
out float vW;
out float vLog;
flat out float vSeed;
void main() {
#ifdef REPLICAS
  // Each periodic image draws a different sparse subset of the particles.
  int off = int(dot(aOffset, vec3(1.0, 2.0, 3.0)) + 12.5);
  int id = gl_VertexID * uStride + (off - (off / uStride) * uStride);
#else
  int id = gl_VertexID * uStride + uStrideOffset;
#endif
  vec3 u = fetchBox(id);
  float rho = max(sampleDensity(u), 0.02);
  float keep;
  vec3 w = placeWorld(u, keep);
  vec4 mv = modelViewMatrix * vec4(w, 1.0);
  float dist = max(-mv.z, 1e-4);
  gl_Position = projectionMatrix * mv;
  // SPH-like adaptive smoothing: h ∝ (m/ρ)^{1/3}.
  float h = clamp(uSmooth * uSpacing * pow(rho, -1.0 / 3.0), 0.3 * uSpacing, uHMax * uSpacing);
  float r = clamp(h * uFocalPx / dist, uMinPx, uMaxPx);
  gl_PointSize = 2.0 * r;
  // Energy-normalised: the flux m/d² spreads over the sprite (mean kernel 1/4 over the disk).
  float flux = uFlux / (dist * dist);
  float w8 = flux / (3.14159265 * r * r * 0.25);
  // Fade particles at the near plane (inside the camera) and beyond the immersive radius.
  float fade = smoothstep(uNear, uNear + 2.0 * h, dist);
  if (uFadeFar > 0.0) fade *= 1.0 - smoothstep(0.78 * uFadeFar, uFadeFar, length(mv.xyz));
  fade *= keep;
  // Emission ∝ ρ² leaves the deepest voids almost dark, yet their particles carry the largest
  // sprites (h ∝ ρ^(−1/3)): fading them out keeps voids black and saves most of the fill rate.
  if (uVoidFade.y > uVoidFade.x) fade *= smoothstep(uVoidFade.x, uVoidFade.y, rho);
  // Importance thinning. Below mean density the sprites are big (h ∝ ρ^(−1/3)) but faint
  // (emission ∝ ρ²): at z = 0 they are over half of all sprite fragments for ~1 % of the light.
  // Draw only a fraction P(ρ) of them, chosen by a fixed per-particle random number u, and
  // divide by the expected acceptance E(P): the expected light is unchanged, dense particles
  // (P = 1) always count exactly once, and the linear band of width ε in u lets particles fade
  // in and out smoothly as their density evolves — nothing pops.
  if (uThin.z > 0.0 && rho < uThin.x) {
    const float EPS = 0.15;
    float P = max(pow(rho / uThin.x, uThin.y), uThin.z);
    uint hsh = uint(id) * 2654435761u;
    hsh ^= hsh >> 15;
    hsh *= 2246822519u;
    hsh ^= hsh >> 13;
    float u = float(hsh >> 8) * (1.0 / 16777216.0);
    float acc = clamp((P - u) / EPS + 1.0, 0.0, 1.0);
    float E = P <= 1.0 - EPS ? P + 0.5 * EPS : 1.0 - (1.0 - P) * (1.0 - P) / (2.0 * EPS);
    fade *= acc / E;
  }
  if (dot(OFFSET, OFFSET) > 0.0) {
    // Periodic replicas: a faint suggestion of the infinite universe — dimming with distance from
    // the simulated box and never close to the camera (no giant sprites across the view).
    vec3 outside = max(abs(w / uBoxWorld) - 0.5, 0.0);
    fade *= exp(-3.0 * length(outside)) * smoothstep(0.35 * uBoxWorld, 0.9 * uBoxWorld, dist);
  }
  vW = w8 * fade * uGain * pow(rho, uEmit);
  vLog = min(log2(rho) * 0.30103, 3.0);   // log10
  vSeed = float(id & 4095) * 0.6180339;
  // Culled: a point whose centre is outside the clip volume is discarded before rasterisation.
  if (fade <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 1.0;
  }
}`;

export const ACCUM_FRAG = /* glsl */ `
precision highp float;
in float vW;
in float vLog;
flat in float vSeed;
out vec4 outColor;
uniform float uEncode;     // 1 for half-float accumulators; < 1 for the 8-bit fallback
uniform float uDither;     // 0, or one 8-bit step: stochastic rounding for the 8-bit fallback
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(q, q);
  if (r2 >= 1.0) discard;
  float k = 1.0 - r2;
  k = k * k * k;                 // (1 − s²)³, mean 1/4 over the disk
  float w = vW * k * uEncode;
  if (uDither > 0.0) {
    // 8-bit sums: add ±½ LSB of noise so faint contributions round up as often as they would
    // have added up, and store the (non-negative) mean-log channel as (log10ρ + 2)/5.
    float n = (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233)) + vSeed) * 43758.5453) - 0.5) * uDither;
    outColor = vec4(w + n, w * (vLog + 2.0) * 0.2 + n, 0.0, 0.0);
    return;
  }
  outColor = vec4(w, w * vLog, 0.0, 0.0);
}`;

/**
 * Composite: projected density → brightness through an asinh stretch (Lupton et al. 2004,
 * PASP 116, 133 — the stretch used for SDSS colour images), hue from the density-weighted mean
 * log local density along the line of sight (Springel et al. 2005's Millennium colouring idea).
 */
export const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D tAccum;
uniform float uSoft;
uniform float uBright;
uniform float uFloor;
uniform float uSat;
uniform float uDecode;     // 1 / the accumulator's encoding scale
uniform float uLogMode;    // 0: g = Σw·log10ρ; 1 (8-bit): g = Σw·(log10ρ + 2)/5
vec3 palette(float x) {
  // x = mean log10(ρ/ρ̄): voids → filaments → nodes
  const vec3 c0 = vec3(0.045, 0.030, 0.200);   // deep indigo
  const vec3 c1 = vec3(0.150, 0.055, 0.420);   // violet
  const vec3 c2 = vec3(0.520, 0.090, 0.520);   // magenta
  const vec3 c3 = vec3(0.950, 0.220, 0.360);   // rose
  const vec3 c4 = vec3(1.000, 0.480, 0.160);   // orange
  const vec3 c5 = vec3(1.000, 0.760, 0.420);   // gold
  const vec3 c6 = vec3(1.000, 0.930, 0.820);   // white-gold
  float t = clamp((x + 0.6) / 2.6, 0.0, 1.0) * 6.0;
  if (t < 1.0) return mix(c0, c1, t);
  if (t < 2.0) return mix(c1, c2, t - 1.0);
  if (t < 3.0) return mix(c2, c3, t - 2.0);
  if (t < 4.0) return mix(c3, c4, t - 3.0);
  if (t < 5.0) return mix(c4, c5, t - 4.0);
  return mix(c5, c6, t - 5.0);
}
void main() {
  vec4 a = texture(tAccum, vUv);
  float col = max(a.r, 0.0) * uDecode;
  if (col <= 1e-7) { outColor = vec4(0.0); return; }
  float mlog = a.g / max(a.r, 1e-12);
  if (uLogMode > 0.5) mlog = mlog * 5.0 - 2.0;
  float b = asinh(col / uSoft);
  b = max(b - uFloor, 0.0);
  vec3 c = palette(mlog);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = max(vec3(l) + uSat * (c - vec3(l)), 0.0);
  // Hotter, denser gas also glows more strongly.
  float boost = 1.0 + 0.35 * clamp(mlog, 0.0, 3.0);
  outColor = vec4(c * b * uBright * boost, 0.0);
}`;

// ——— Galaxies ———

/** Resolved galaxies (FoF halos): each rides on a particle; blends host A→B and luminosity A→B. */
export const GALAXY_VERT = /* glsl */ `
${BLACKBODY_GLSL}
${FETCH_GLSL}
${PLACE_GLSL}
in float aHostA;
in float aHostB;
in vec2 aLum;      // luminosity at A, B (arbitrary units, 0 = absent)
in vec2 aBlue;     // star-forming fraction at A, B
in float aSeed;
uniform float uFocalPx;
uniform float uLumScale;
uniform float uMinPx;
uniform float uSfrBoost;
uniform float uFadeFar;
uniform float uNear;
out vec3 vColor;
out float vSize;
void main() {
  vec3 ua = fetchBox(int(aHostA + 0.5));
  vec3 ub = fetchBox(int(aHostB + 0.5));
  vec3 d = ub - ua;
  d -= floor(d + 0.5);
  vec3 u = fract(ua + uMix * d);
  float keep;
  vec3 w = placeWorld(u, keep);
  vec4 mv = modelViewMatrix * vec4(w, 1.0);
  float dist = max(-mv.z, 1e-4);
  gl_Position = projectionMatrix * mv;
  float lum = mix(aLum.x, aLum.y, uMix);
  float blue = mix(aBlue.x, aBlue.y, uMix);
  lum *= 1.0 + blue * uSfrBoost;
  // Colour: old red stellar populations ~4300 K; young star-forming disks ~9000 K with a hint of Hα.
  float T = mix(4300.0, 9000.0, blue) * (0.94 + 0.12 * fract(aSeed * 7.13));
  vec3 col = blackbody(T) + blue * vec3(0.10, 0.0, 0.035);
  float flux = uLumScale * lum / (dist * dist);
  float r = uMinPx * (1.0 + 0.35 * clamp(log2(1.0 + flux * 40.0), 0.0, 4.0));
  float fade = smoothstep(uNear, uNear * 3.0, dist) * keep;
  if (uFadeFar > 0.0) fade *= 1.0 - smoothstep(0.78 * uFadeFar, uFadeFar, length(mv.xyz));
  gl_PointSize = 2.0 * r;
  vSize = r;
  vColor = col * flux * fade / (3.14159265 * r * r * 0.18);
  if (lum <= 0.0 || fade <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;

export const GALAXY_FRAG = /* glsl */ `
precision highp float;
in vec3 vColor;
in float vSize;
out vec4 outColor;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(q, q);
  if (r2 >= 1.0) discard;
  // Seeing-like PSF: tight core and a faint halo (normalised mean ≈ 0.18 over the disk).
  float core = exp(-r2 * 10.0);
  float halo = 0.08 * (1.0 - r2) * (1.0 - r2);
  outColor = vec4(vColor * (core + halo), 1.0);
}`;

/**
 * Field galaxies below the simulation's mass resolution, lit by extended Press–Schechter:
 * the collapsed fraction of the particle's Lagrangian patch (overdensity δL, variance σR²) in
 * halos above M_min at growth D is erfc[(δc/D − δL)/√(2(σmin² − σR²))]. The highest peaks
 * collapse first — the first galaxies light up in what will become the densest knots.
 */
export const FIELD_VERT = /* glsl */ `
${COMMON_GLSL}
${BLACKBODY_GLSL}
${FETCH_GLSL}
${DENSITY_SAMPLE_GLSL}
${PLACE_GLSL}
in float aDelta;           // δL/σL · 32 (int8 normalised to ±1 → ×127/32)
uniform float uD;          // linear growth factor now (1 today)
uniform float uSigmaL;     // σ of the Lagrangian field at the smoothing scale (today)
uniform float uVarDwarf;   // σ²(M_min) − σR² for the first (atomic-cooling) halos
uniform float uVarBright;  // σ²(10¹¹ M☉) − σR² for luminous galaxies
uniform float uFocalPx;
uniform float uLumScale;
uniform float uMinPx;
uniform float uQuench;     // 0..1: how strongly dense environments are quenched (late times)
uniform float uSfrBoost;
uniform float uFadeFar;
uniform float uNear;
uniform float uCount;      // candidates per particle (for brightness normalisation)
out vec3 vColor;
out float vSize;
float erfcApprox(float x) {
  // Abramowitz & Stegun 7.1.26 (|ε| < 1.5e-7) for x ≥ 0, reflected for x < 0.
  float z = abs(x);
  float t = 1.0 / (1.0 + 0.3275911 * z);
  float y = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  float e = y * exp(-z * z);
  return x >= 0.0 ? e : 2.0 - e;
}
void main() {
  int id = gl_VertexID;
  vec3 u = fetchBox(id);
  float dl = aDelta * (127.0 / 32.0) * uSigmaL;
  float nu = 1.686 / max(uD, 1e-4);
  // A region that has itself collapsed (δL ≥ δc/D) is entirely in halos: f ≤ 1.
  float fDwarf = min(erfcApprox((nu - dl) / sqrt(2.0 * uVarDwarf)), 1.0);
  float fBright = min(erfcApprox((nu - dl) / sqrt(2.0 * uVarBright)), 1.0);
  float lum = 0.06 * fDwarf + fBright;
  float rho = max(sampleDensity(u), 0.02);
  float keep;
  vec3 w = placeWorld(u, keep);
  vec4 mv = modelViewMatrix * vec4(w, 1.0);
  float dist = max(-mv.z, 1e-4);
  gl_Position = projectionMatrix * mv;
  float h = hash11(float(id) * 0.61803);
  // Environment quenching: dense regions turn red late in cosmic history (morphology–density).
  float q = uQuench * smoothstep(6.0, 60.0, rho * (0.6 + 0.8 * h));
  float blue = 1.0 - q;
  lum *= (1.0 + blue * uSfrBoost) * (0.5 + h);
  float T = mix(4400.0, 9500.0, blue) * (0.92 + 0.16 * fract(h * 13.7));
  vec3 col = blackbody(T) + blue * vec3(0.08, 0.0, 0.03);
  float flux = uLumScale * lum / (dist * dist) / uCount;
  float fade = smoothstep(uNear, uNear * 3.0, dist) * keep;
  if (uFadeFar > 0.0) fade *= 1.0 - smoothstep(0.78 * uFadeFar, uFadeFar, length(mv.xyz));
  float r = uMinPx;
  gl_PointSize = 2.0 * r;
  vSize = r;
  vColor = col * flux * fade / (3.14159265 * r * r * 0.18);
  if (lum < 1e-5 || fade <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;

// ——— The primordial fireball and the cosmic microwave background ———

export const CMB_VERT = /* glsl */ `
out vec3 vDir;
void main() {
  vDir = position;
  vec3 d = mat3(viewMatrix) * position;
  vec4 clip = projectionMatrix * vec4(d, 1.0);
  clip.z = clip.w * 0.99999;
  gl_Position = clip;
}`;

export const CMB_FRAG = /* glsl */ `
precision highp float;
${COMMON_GLSL}
${BLACKBODY_GLSL}
in vec3 vDir;
out vec4 outColor;
uniform float uT;          // radiation temperature, K
uniform float uRadiance;   // visible-band radiance relative to the reference
uniform float uAniso;      // displayed δT/T amplitude (exaggerated, 0 while opaque)
uniform float uSeed;
// Cheap isotropic value noise on the sphere, summed over octaves with a spectrum that peaks near
// ~1° like the acoustic peaks (the pattern is illustrative; its amplitude is exaggerated ×10⁴).
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i), n100 = hash13(i + vec3(1, 0, 0)), n010 = hash13(i + vec3(0, 1, 0)), n110 = hash13(i + vec3(1, 1, 0));
  float n001 = hash13(i + vec3(0, 0, 1)), n101 = hash13(i + vec3(1, 0, 1)), n011 = hash13(i + vec3(0, 1, 1)), n111 = hash13(i + vec3(1, 1, 1));
  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y), mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z) * 2.0 - 1.0;
}
void main() {
  vec3 d = normalize(vDir);
  float n = 0.0;
  n += 0.30 * vnoise(d * 6.0 + uSeed);
  n += 0.45 * vnoise(d * 18.0 + uSeed * 1.3);
  n += 0.35 * vnoise(d * 42.0 + uSeed * 1.7);
  n += 0.18 * vnoise(d * 95.0 + uSeed * 2.1);
  float T = uT * (1.0 + uAniso * n);
  // Deepen the chroma a little: the tone mapper washes a bright 3000 K field toward cream.
  vec3 c = blackbody(T);
  c = pow(c / max(c.r, 1e-6), vec3(1.35)) * c.r;
  // Radiance of a blackbody in the visible rises steeply with T (Wien tail): δI/I ≈ (hν/kT) δT/T.
  float gain = pow(T / uT, 8.0);
  outColor = vec4(c * uRadiance * gain, 1.0);
}`;
