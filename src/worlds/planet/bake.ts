import * as THREE from 'three';
import { FULLSCREEN_VERT } from '../../core/post/FullscreenQuad';
import { COMMON_GLSL } from '../../shaders/lib/common';
import { NOISE_GLSL } from '../../shaders/lib/noise';
import type { PlanetKind, PlanetSpec } from './types';
import { Rng } from '../../physics/random';

/**
 * Procedural surfaces, baked on the GPU into cube maps (seamless, no pole pinching):
 *   A: albedo (√-encoded linear RGB) + specular mask (water/ice)
 *   B: shading normal (object space, relief included) + emission parameter (city lights, lava heat)
 *   C: cloud coverage (+ a second octave for runtime detail)
 * Height is first baked to a packed 16-bit cube (H), from which albedo and normals are derived, then
 * discarded. The terrain's sea level is set from the requested ocean fraction by reading back a small
 * equirectangular height map and taking the area-weighted quantile.
 *
 * Geology, by kind: continents from domain-warped fbm (Quilez), mountain belts from ridged
 * multifractals, craters as bowl + rim + ejecta profiles with power-law sizes (Moon/Mercury), maria
 * as flooded low basins, lineae as zero-crossings of noise (Europa), glowing lava in Voronoi cracks,
 * gas-giant belts/zones sheared by jets with curl-noise vortices and a Great-Red-Spot-like anticyclone.
 */

export const BAKE_KINDS: ReadonlySet<PlanetKind> = new Set(['terrestrial', 'ocean', 'desert', 'lava', 'ice', 'barren', 'venus', 'gas-giant', 'ice-giant']);
const HEIGHT_KINDS: ReadonlySet<PlanetKind> = new Set(['terrestrial', 'ocean', 'desert', 'lava', 'ice', 'barren']);

const KIND_DEFINE: Record<PlanetKind, string> = {
  earth: 'KIND_EARTH',
  terrestrial: 'KIND_TERRESTRIAL',
  ocean: 'KIND_OCEAN',
  desert: 'KIND_DESERT',
  lava: 'KIND_LAVA',
  ice: 'KIND_ICE',
  barren: 'KIND_BARREN',
  venus: 'KIND_VENUS',
  'gas-giant': 'KIND_GAS',
  'ice-giant': 'KIND_ICEGIANT',
};
export const kindDefine = (k: PlanetKind) => KIND_DEFINE[k];

/** Uniforms describing a procedural world (shared by the bake passes and, partly, the runtime shader). */
export function worldUniforms(spec: PlanetSpec): Record<string, THREE.IUniform> {
  const rng = new Rng(spec.seed * 7919 + 17);
  const off = new THREE.Vector3(rng.range(-80, 80), rng.range(-80, 80), rng.range(-80, 80));
  const kind = spec.kind;
  const T = spec.temperatureK ?? defaultTemperature(kind);
  const bands = (spec.bands && spec.bands.length >= 2 ? spec.bands : defaultBands(spec, rng)).slice(0, 8);
  const bandArr: THREE.Vector3[] = [];
  for (let i = 0; i < 8; i++) {
    const b = bands[Math.min(i, bands.length - 1)];
    bandArr.push(new THREE.Vector3(b[0], b[1], b[2]));
  }
  const tint = spec.color ?? [1, 1, 1];
  // Storm placement (southern hemisphere, like the GRS at 22°S) and other seeded features.
  const stormLat = -(18 + rng.range(0, 10)) * (Math.PI / 180);
  const stormLon = rng.range(-Math.PI, Math.PI);
  return {
    uSeedOff: { value: off },
    uSeaLevel: { value: 0 },
    uTempK: { value: T },
    uIce: { value: spec.ice ?? defaultIce(kind, T) },
    uVeg: { value: spec.vegetation ?? (kind === 'terrestrial' ? 0.7 : kind === 'ocean' ? 0.5 : 0) },
    uCraters: { value: spec.craters ?? (kind === 'barren' ? 1 : kind === 'desert' ? 0.45 : kind === 'ice' ? 0.15 : 0.05) },
    uTint: { value: new THREE.Vector3(tint[0], tint[1], tint[2]) },
    uCity: { value: spec.cityLights ?? 0 },
    uCloudAmount: { value: spec.clouds ?? 0 },
    uBands: { value: bandArr },
    uBandCount: { value: bands.length },
    uStorm: { value: spec.storm ? 1 : 0 },
    uStormPos: { value: new THREE.Vector2(stormLat, stormLon) },
    uHexagon: { value: spec.hexagon ? 1 : 0 },
    uVariant: { value: rng.next() },
    uRelief: { value: spec.relief ?? defaultRelief(kind) },
  };
}

export function defaultTemperature(kind: PlanetKind): number {
  switch (kind) {
    case 'lava': return 900;
    case 'ice': return 110;
    case 'barren': return 250;
    case 'desert': return 230;
    case 'venus': return 735;
    case 'gas-giant': return 125;
    case 'ice-giant': return 60;
    case 'ocean': return 285;
    default: return 288;
  }
}
function defaultIce(kind: PlanetKind, T: number): number {
  if (kind === 'ice') return 1;
  if (kind === 'desert') return 0.25;
  if (kind === 'terrestrial' || kind === 'ocean') return T < 260 ? 0.8 : T > 300 ? 0.05 : 0.3;
  return 0;
}
function defaultRelief(kind: PlanetKind): number {
  switch (kind) {
    case 'barren': return 1.6;
    case 'desert': return 1.4;
    case 'ice': return 0.8;
    case 'lava': return 1.2;
    default: return 1;
  }
}
function defaultBands(spec: PlanetSpec, rng: Rng): Array<[number, number, number]> {
  if (spec.kind === 'ice-giant') {
    // Neptune (deep azure) or Uranus (pale cyan).
    return rng.next() < 0.5
      ? [[0.3, 0.52, 0.85], [0.2, 0.4, 0.78], [0.14, 0.3, 0.68], [0.1, 0.22, 0.55]]
      : [[0.62, 0.8, 0.84], [0.56, 0.76, 0.8], [0.5, 0.72, 0.78], [0.46, 0.68, 0.76]];
  }
  if (spec.rings || spec.hexagon) {
    // Saturn: pale butterscotch, low contrast.
    return [[0.86, 0.76, 0.56], [0.8, 0.68, 0.48], [0.74, 0.6, 0.4], [0.66, 0.53, 0.36], [0.55, 0.47, 0.36]];
  }
  // Jupiter: cream zones, rusty belts.
  return [[0.64, 0.57, 0.44], [0.58, 0.45, 0.3], [0.47, 0.3, 0.16], [0.36, 0.2, 0.1], [0.26, 0.15, 0.08]];
}

// ——— GLSL ———

const BAKE_COMMON = /* glsl */ `
precision highp float;
${COMMON_GLSL}
${NOISE_GLSL}
// Band-limited fbm for the bake: octaves finer than ~2 texels of the target (measured with
// screen-space derivatives of the noise coordinate) fade out instead of aliasing into speckle.
float fbm3aa(vec3 p, int octaves) {
  float w = max(length(fwidth(p)), 1e-7);
  float nmax = log2(0.5 / w) + 1.0;
  float sum = 0.0, amp = 0.5, norm = 0.0;
  for (int i = 0; i < 12; i++) {
    if (i >= octaves) break;
    sum += amp * clamp(nmax - float(i), 0.0, 1.0) * snoise(p);
    norm += amp;
    p *= 2.0;
    amp *= 0.5;
  }
  return sum / norm;
}
float ridged3aa(vec3 p, int octaves, float lacunarity, float gain) {
  float w = max(length(fwidth(p)), 1e-7);
  float nmax = log2(0.5 / w) / log2(lacunarity) + 1.0;
  float sum = 0.0, amp = 0.5, norm = 0.0, prev = 1.0;
  for (int i = 0; i < 12; i++) {
    if (i >= octaves) break;
    float n = 1.0 - abs(snoise(p));
    n *= n;
    float f = clamp(nmax - float(i), 0.0, 1.0);
    // A faded octave contributes its mean (≈ 0.45) rather than noise.
    sum += mix(0.45, n, f) * amp * prev;
    norm += amp;
    prev = mix(prev, n, f);
    p *= lacunarity;
    amp *= gain;
  }
  return sum / norm;
}
#define fbm3(p, o) fbm3aa(p, o)
#define ridged3(p, o, l, g) ridged3aa(p, o, l, g)
uniform vec3 uSeedOff;
uniform float uSeaLevel;
uniform float uTempK;
uniform float uIce;
uniform float uVeg;
uniform float uCraters;
uniform vec3 uTint;
uniform float uCity;
uniform float uCloudAmount;
uniform vec3 uBands[8];
uniform int uBandCount;
uniform float uStorm;
uniform vec2 uStormPos;
uniform float uHexagon;
uniform float uVariant;
uniform float uRelief;
uniform int uFace;
uniform float uSize;
uniform samplerCube uHeightCube;
out vec4 outColor;

// Direction for a texel of cube face uFace (OpenGL cube-map conventions).
vec3 cubeDir(vec2 fragCoord) {
  vec2 st = fragCoord / uSize;
  float sc = st.x * 2.0 - 1.0;
  float tc = st.y * 2.0 - 1.0;
  vec3 d;
  if (uFace == 0) d = vec3(1.0, -tc, -sc);
  else if (uFace == 1) d = vec3(-1.0, -tc, sc);
  else if (uFace == 2) d = vec3(sc, 1.0, tc);
  else if (uFace == 3) d = vec3(sc, -1.0, -tc);
  else if (uFace == 4) d = vec3(sc, -tc, 1.0);
  else d = vec3(-sc, -tc, -1.0);
  return normalize(d);
}
vec3 equiDir(vec2 fragCoord, vec2 size) {
  vec2 uv = fragCoord / size;
  float lon = (uv.x - 0.5) * TAU;
  float lat = (uv.y - 0.5) * PI;
  return vec3(cos(lat) * cos(lon), sin(lat), -cos(lat) * sin(lon));
}

vec4 packHeight(float h) {
  float x = clamp((h + 2.0) * 0.25, 0.0, 1.0) * 65535.0;
  float hi = floor(x / 256.0);
  float lo = x - hi * 256.0;
  return vec4(hi / 255.0, lo / 255.0, 0.0, 0.0);
}
float unpackHeight(vec4 c) {
  float x = (floor(c.r * 255.0 + 0.5) * 256.0 + floor(c.g * 255.0 + 0.5)) / 65535.0;
  return x * 4.0 - 2.0;
}

// ——— Craters: bowl, raised rim, ejecta blanket; sizes ~ power law; 3D cells so rims stay circular ———
float craterProfile(float d) {
  float bowl = d < 1.0 ? (d * d - 1.0) * 0.9 : 0.0;
  float rim = 0.28 * exp(-sqr((d - 1.0) / 0.16));
  float ejecta = d > 1.0 ? 0.1 * exp(-(d - 1.0) * 2.5) : 0.0;
  return bowl + rim + ejecta;
}
// Returns (height, fresh-ray brightness) contributions.
vec2 craterField(vec3 p, float freq, float density, float seed) {
  vec3 q = p * freq;
  vec3 id = floor(q);
  vec3 f = fract(q);
  float h = 0.0;
  float rays = 0.0;
  for (int k = -1; k <= 1; k++)
  for (int j = -1; j <= 1; j++)
  for (int i = -1; i <= 1; i++) {
    vec3 b = vec3(float(i), float(j), float(k));
    vec3 cell = id + b;
    vec3 rnd = hash33(cell + seed);
    if (rnd.z > density) continue;
    vec3 c = b + 0.15 + 0.7 * rnd - f;
    float rr = 0.12 + 0.38 * pow(hash13(cell * 1.37 + seed), 2.5);
    float d = length(c) / rr;
    if (d > 3.5) continue;
    float age = hash13(cell * 3.1 + seed + 7.0);
    float soft = mix(1.0, 0.45, age);     // older craters are degraded
    h += craterProfile(d) * rr * soft;
    if (age < 0.12 && d > 0.9) {
      // Young craters: bright radial ejecta rays.
      vec3 dir = normalize(c + 1e-4);
      float ang = snoise(dir * 9.0 + cell) * 0.5 + 0.5;
      rays += smoothstep(0.55, 0.9, ang) * exp(-(d - 1.0) * 0.9) * (1.0 - age / 0.12);
    }
  }
  return vec2(h, rays);
}

// ——— Terrain height by kind (arbitrary units; sea level from the quantile) ———
float terrainHeight(vec3 p, out vec4 aux) {
  vec3 q = p + uSeedOff;
  aux = vec4(0.0);
#if defined(KIND_TERRESTRIAL) || defined(KIND_OCEAN)
  vec3 w = vec3(fbm3(q * 0.9, 4), fbm3(q * 0.9 + vec3(5.2, 1.3, 2.8), 4), fbm3(q * 0.9 + vec3(1.7, 9.2, 3.4), 4));
  float c = fbm3(q * 1.15 + 1.2 * w, 7);
  float belts = smoothstep(0.15, 0.75, fbm3(q * 1.9 + vec3(3.1, 7.7, 1.3), 3) * 0.5 + 0.5);
  float m = ridged3(q * 3.3 + w * 0.6, 7, 2.07, 0.5);
  float land = smoothstep(-0.05, 0.3, c);
  float h = c + belts * m * 0.42 * land + (m - 0.5) * 0.05;
#if defined(KIND_OCEAN)
  // Volcanic island chains on a deep ocean world.
  float chain = pow(max(0.0, 1.0 - abs(fbm3(q * 1.3 + vec3(9.0), 3)) * 6.0), 3.0);
  h = c * 0.6 + chain * 0.45 * (0.6 + 0.4 * m);
#endif
  aux.x = fbm3(q * 2.1 + vec3(11.0, 3.0, 5.0), 5) * 0.5 + 0.5;   // moisture noise
  aux.y = m;
  vec2 cr = craterField(p, 7.0, 0.12 * uCraters, 3.0);
  h += cr.x * 0.15;
  return h;
#elif defined(KIND_DESERT)
  // Hemispheric dichotomy (smooth northern lowlands), old cratered highlands, shield volcanoes, a rift canyon.
  float dich = smoothstep(-0.35, 0.35, dot(normalize(p), normalize(vec3(0.3, -1.0, 0.2))) + 0.25 * fbm3(q * 1.1, 4));
  float h = (dich - 0.5) * 0.55 + fbm3(q * 2.0, 6) * 0.22;
  vec2 c1 = craterField(p, 5.0, 0.55 * uCraters, 1.0);
  vec2 c2 = craterField(p, 12.0, 0.6 * uCraters, 2.0);
  vec2 c3 = craterField(p, 28.0, 0.55 * uCraters, 5.0);
  h += (c1.x * 0.5 + c2.x * 0.32 + c3.x * 0.18) * mix(0.35, 1.0, dich);
  // Shield volcanoes (Tharsis-like): a few broad cones.
  for (int i = 0; i < 3; i++) {
    vec3 cpos = normalize(hash31(float(i) + uVariant * 17.0) * 2.0 - 1.0 + vec3(0.0, 0.0, 0.3));
    float d = acos(clamp(dot(normalize(p), cpos), -1.0, 1.0));
    h += 0.55 * exp(-d * d / 0.012) + 0.08 * exp(-d * d / 0.08);
  }
  // Canyon system along a great circle segment.
  vec3 axis = normalize(vec3(0.2, 1.0, 0.1) + (hash31(uVariant * 31.0) - 0.5) * 0.6);
  float gc = dot(normalize(p), axis);
  float along = atan(dot(normalize(p), normalize(cross(axis, vec3(0.0, 0.0, 1.0)))), dot(normalize(p), normalize(cross(axis, vec3(1.0, 0.0, 0.0)))));
  float trough = exp(-sqr(gc / (0.018 + 0.012 * snoise(q * 6.0)))) * smoothstep(0.9, 0.2, abs(along - 0.4));
  h -= trough * 0.4;
  aux.x = fbm3(q * 1.6 + vec3(4.0), 5) * 0.5 + 0.5;   // albedo provinces (dark basalt vs bright dust)
  aux.y = dich;
  aux.z = c1.y + c2.y;
  return h;
#elif defined(KIND_ICE)
  float h = fbm3(q * 2.0, 5) * 0.06;
  // Double ridges: zero-crossings of noise, raised.
  float l1 = snoise(q * 1.7 + vec3(2.0)) + 0.35 * snoise(q * 5.0);
  float l2 = snoise(q * 2.9 + vec3(7.0)) + 0.3 * snoise(q * 9.0);
  float ridge = exp(-sqr(l1 / 0.025)) + 0.7 * exp(-sqr(l2 / 0.02));
  h += ridge * 0.05;
  vec2 cr = craterField(p, 9.0, 0.25 * uCraters, 4.0);
  h += cr.x * 0.12;
  aux.x = ridge;
  aux.y = smoothstep(0.35, 0.75, fbm3(q * 3.1 + vec3(1.0, 2.0, 9.0), 5) * 0.5 + 0.5);   // chaos terrain
  aux.z = exp(-sqr(l1 / 0.09)) + exp(-sqr(l2 / 0.07));   // broad lineae stain
  return h;
#elif defined(KIND_LAVA)
  // Plate boundaries: F2 − F1 of 3D cellular noise, divided by its gradient along the surface so
  // the cracks keep a constant width even where a cell wall meets the sphere at a grazing angle.
  vec3 pe = normalize(vec3(p.z, 0.0, -p.x) + vec3(1e-5, 0.0, 0.0));
  vec3 pn = cross(normalize(p), pe);
  const float EPS = 0.004;
  vec2 wv = worley3(q * 3.2);
  float plates = wv.y - wv.x;
  vec2 wva = worley3((q + pe * EPS) * 3.2), wvb = worley3((q + pn * EPS) * 3.2);
  float gp = length(vec2(wva.y - wva.x - plates, wvb.y - wvb.x - plates)) / EPS;
  float dPlate = plates / max(gp, 1e-3);          // ≈ angular distance to the nearest boundary (radii)
  float h = fbm3(q * 1.8, 6) * 0.35 + smoothstep(0.0, 0.08, dPlate) * 0.12;
  vec2 wv2 = worley3(q * 9.0 + vec3(3.0));
  vec2 wv2a = worley3((q + pe * EPS) * 9.0 + vec3(3.0)), wv2b = worley3((q + pn * EPS) * 9.0 + vec3(3.0));
  float f2 = wv2.y - wv2.x;
  float g2 = length(vec2(wv2a.y - wv2a.x - f2, wv2b.y - wv2b.x - f2)) / EPS;
  float cracks = 1.0 - smoothstep(0.004, 0.014, dPlate);
  float fine = 1.0 - smoothstep(0.002, 0.006, f2 / max(g2, 1e-3));
  aux.x = cracks;
  aux.y = fine;
  aux.z = fbm3(q * 4.0 + vec3(5.0), 4) * 0.5 + 0.5;
  if (uTempK < 450.0) {
    // Io: a cold sulphur-frosted crust with a few dozen active paterae (volcanic depressions with
    // lava lakes), not a global network of cracks.
    // Hot spots placed on the surface (angular radius 0.8°–3°, i.e. ~25–100 km on Io), some with
    // large red plume-deposit rings.
    vec3 pu = normalize(p);
    float spots = 0.0, halo = 0.0;
    for (int i = 0; i < 56; i++) {
      vec3 h3 = hash31(float(i) * 7.13 + uVariant * 13.0);
      vec3 h4 = hash31(float(i) * 3.71 + uVariant * 29.0 + 5.0);
      float z = h4.x * 2.0 - 1.0, ph = h4.y * TAU;
      vec3 c = vec3(sqrt(1.0 - z * z) * cos(ph), z, sqrt(1.0 - z * z) * sin(ph));
      float r = radians(0.8 + 2.4 * h3.x * h3.y);
      float a = acos(clamp(dot(pu, c), -1.0, 1.0));
      spots = max(spots, (1.0 - smoothstep(r * 0.55, r, a)) * (0.5 + 0.5 * h3.z));
      halo = max(halo, (1.0 - smoothstep(r * 1.5, r * 5.0, a)) * step(0.72, h3.z));
    }
    aux.x = spots;
    aux.y = max(halo, spots);
    h = fbm3(q * 1.8, 6) * 0.12 - aux.x * 0.05;
  }
  vec2 cr = craterField(p, 6.0, 0.1 * uCraters, 6.0);
  h += cr.x * 0.1;
  return h;
#elif defined(KIND_BARREN)
  float h = fbm3(q * 1.5, 6) * 0.12;
  float maria = smoothstep(0.52, 0.64, fbm3(q * 0.8 + vec3(2.0, 8.0, 1.0), 4) * 0.5 + 0.5 + 0.08 * snoise(q * 4.0));
  vec2 c0 = craterField(p, 2.2, 0.35 * uCraters, 11.0);
  vec2 c1 = craterField(p, 5.0, 0.6 * uCraters, 1.0);
  vec2 c2 = craterField(p, 11.0, 0.75 * uCraters, 2.0);
  vec2 c3 = craterField(p, 24.0, 0.8 * uCraters, 3.0);
  vec2 c4 = craterField(p, 52.0, 0.85 * uCraters, 4.0);
  h += c0.x * 0.8 + c1.x * 0.55 + c2.x * 0.36 + c3.x * 0.22 + c4.x * 0.13;
  // Maria: flooded, smoothed lowlands.
  h = mix(h, h * 0.25 - 0.12, maria);
  aux.x = maria;
  aux.y = c0.y + c1.y + c2.y * 0.6;
  return h;
#else
  return 0.0;
#endif
}
`;

const HEIGHT_FRAG = /* glsl */ `
${BAKE_COMMON}
uniform vec2 uEquiSize;
void main() {
#ifdef PREPASS
  vec3 d = equiDir(gl_FragCoord.xy, uEquiSize);
#else
  vec3 d = cubeDir(gl_FragCoord.xy);
#endif
  vec4 aux;
  float h = terrainHeight(d, aux);
  vec4 c = packHeight(h);
  outColor = vec4(c.rg, clamp(aux.x, 0.0, 1.0), clamp(aux.y, 0.0, 1.0));
}`;

/** Albedo, specular mask, normals, emission and clouds from the height cube (or directly for giants). */
const SURFACE_BAKE = /* glsl */ `
${BAKE_COMMON}
float H(vec3 d) { return unpackHeight(texture(uHeightCube, d)); }
// Auxiliary fields stored next to the packed height: .x = texel.b, .y = texel.a.
vec4 AUX(vec3 d) { vec4 c = texture(uHeightCube, d); return vec4(c.b, c.a, 0.0, 0.0); }

vec3 bandColor(float x) {
  x = clamp(x, 0.0, 1.0) * float(uBandCount - 1);
  int i = int(floor(x));
  float f = fract(x);
  vec3 a = uBands[0], b = uBands[0];
  for (int k = 0; k < 8; k++) {
    if (k == i) a = uBands[k];
    if (k == min(i + 1, uBandCount - 1)) b = uBands[k];
  }
  return mix(a, b, smoothstep(0.0, 1.0, f));
}

// Surface temperature with latitude and altitude (lapse ~6.5 K/km on Earth-like worlds).
float surfaceT(float lat, float elevKm) {
  return uTempK + 12.0 - 48.0 * sqr(sin(lat)) - 6.5 * max(elevKm, 0.0);
}

// Jupiter-like belt profile: 0 in zones, → 1 in belts (planetographic latitude, degrees).
float beltFn(float x, float a, float b) {
  return smoothstep(a - 1.3, a + 1.3, x) * (1.0 - smoothstep(b - 1.3, b + 1.3, x));
}
float jovianBelts(float l) {
  float b = beltFn(l, 7.0, 17.5)          // North Equatorial Belt
          + 0.95 * beltFn(l, -20.0, -7.5)   // South Equatorial Belt
          + 0.55 * beltFn(l, 23.0, 28.5)    // North Temperate Belt
          + 0.5 * beltFn(l, -34.0, -27.0)   // South Temperate Belt
          + 0.4 * beltFn(l, 34.0, 38.5)
          + 0.35 * beltFn(l, -44.0, -39.0)
          + 0.3 * beltFn(l, 44.0, 49.0)
          + 0.3 * beltFn(l, -54.0, -48.0)
          + 0.12 * beltFn(l, -2.0, 2.0);   // equatorial band
  return clamp(b, 0.0, 1.0);
}

vec4 albedoPass(vec3 d) {
  vec3 q = d + uSeedOff;
  float lat = asin(clamp(d.y, -1.0, 1.0));
#if defined(KIND_TERRESTRIAL) || defined(KIND_OCEAN)
  float h = H(d);
  vec4 aux = AUX(d);
  float elev = h - uSeaLevel;
  float elevKm = elev * 9.0;
  float T = surfaceT(lat, elevKm);
  float iceT = 262.0 + 22.0 * (uIce - 0.3);
  if (elev < 0.0) {
    float depth = smoothstep(0.0, 0.22, -elev);
    vec3 water = mix(vec3(0.03, 0.12, 0.13), vec3(0.004, 0.018, 0.045), depth);
    float seaIce = smoothstep(iceT + 3.0, iceT - 6.0, T + 4.0 * snoise(q * 6.0));
    water = mix(water, vec3(0.62, 0.68, 0.74) * (0.85 + 0.15 * snoise(q * 20.0)), seaIce);
    return vec4(sqrt(water * uTint), 1.0 - seaIce * 0.8);
  }
  // Moisture: wet tropics (ITCZ), dry subtropics (Hadley descent), wet storm tracks, dry poles; + noise + rain shadow.
  float al = abs(degrees(lat));
  float climate = 0.62 * exp(-sqr(al / 11.0)) - 0.42 * exp(-sqr((al - 24.0) / 9.0)) + 0.28 * exp(-sqr((al - 52.0) / 14.0)) - 0.2 * smoothstep(60.0, 85.0, al);
  float moist = clamp(0.45 + climate + (aux.x - 0.5) * 0.9 - 0.25 * smoothstep(0.25, 0.9, elev * 3.0), 0.0, 1.0) * mix(0.2, 1.0, uVeg);
  vec3 sand = mix(vec3(0.48, 0.36, 0.22), vec3(0.42, 0.22, 0.11), smoothstep(0.3, 0.8, snoise(q * 1.7) * 0.5 + 0.5));
  vec3 grass = vec3(0.14, 0.14, 0.065);
  vec3 forest = vec3(0.035, 0.07, 0.028);
  vec3 jungle = vec3(0.022, 0.06, 0.02);
  vec3 boreal = vec3(0.03, 0.05, 0.03);
  vec3 tundra = vec3(0.17, 0.16, 0.13);
  vec3 rock = vec3(0.17, 0.15, 0.13) * (0.8 + 0.4 * aux.y);
  vec3 snow = vec3(0.86, 0.89, 0.93);
  float hot = smoothstep(285.0, 300.0, T);
  float cold = smoothstep(278.0, 266.0, T);
  vec3 wet = mix(mix(forest, jungle, hot), boreal, cold);
  vec3 dry = mix(sand, grass, smoothstep(0.25, 0.5, moist));
  vec3 col = mix(dry, wet, smoothstep(0.45, 0.72, moist));
  col = mix(col, tundra, smoothstep(272.0, 262.0, T) * 0.8);
  col = mix(col, rock, smoothstep(0.35, 0.65, elev * 2.2) * 0.8);
  float snowLine = smoothstep(iceT + 2.0, iceT - 5.0, T + 3.0 * snoise(q * 11.0));
  col = mix(col, snow, snowLine);
  col *= 0.88 + 0.24 * (snoise(q * 14.0) * 0.5 + 0.5);
  return vec4(sqrt(col * uTint), snowLine * 0.25);
#elif defined(KIND_DESERT)
  float h = H(d);
  vec4 aux = AUX(d);
  vec3 dust = vec3(0.44, 0.24, 0.12);
  vec3 dark = vec3(0.14, 0.09, 0.06);
  vec3 bright = vec3(0.56, 0.36, 0.2);
  float prov = smoothstep(0.43, 0.6, aux.x + 0.08 * snoise(q * 8.0));
  vec3 col = mix(dark, dust, prov);
  col = mix(col, bright, smoothstep(0.62, 0.85, aux.x) * 0.6);
  // Bright dust settles in low basins; dark sand in crater floors.
  col *= 0.9 + 0.25 * smoothstep(-0.1, 0.3, h - uSeaLevel);
  // Polar caps (CO₂ + water ice) with swirled troughs.
  float capLat = radians(90.0 - 44.0 * uIce);
  float swirl = snoise(vec3(d.x * 7.0 + d.z * 3.0, d.y * 3.0, d.z * 7.0 - d.x * 3.0) + uSeedOff);
  float cap = smoothstep(capLat - 0.06, capLat + 0.02, abs(lat) + 0.04 * swirl) * (0.75 + 0.25 * step(0.0, swirl + 0.6));
  col = mix(col, vec3(0.84, 0.82, 0.8), cap);
  col *= 0.9 + 0.2 * (snoise(q * 20.0) * 0.5 + 0.5);
  return vec4(sqrt(col * uTint), cap * 0.3);
#elif defined(KIND_ICE)
  vec4 aux = AUX(d);
  float l1 = snoise(q * 1.7 + vec3(2.0)) + 0.35 * snoise(q * 5.0);
  float l2 = snoise(q * 2.9 + vec3(7.0)) + 0.3 * snoise(q * 9.0);
  aux.z = exp(-sqr(l1 / 0.09)) + exp(-sqr(l2 / 0.07));
  vec3 ice = vec3(0.86, 0.84, 0.8);
  vec3 stain = vec3(0.48, 0.3, 0.18);
  vec3 col = ice * (0.94 + 0.06 * snoise(q * 25.0));
  col = mix(col, stain, clamp(aux.z * 0.45 + aux.x * 0.35, 0.0, 0.85));
  col = mix(col, mix(stain, vec3(0.7, 0.55, 0.42), 0.4), aux.y * 0.55 * (0.6 + 0.4 * snoise(q * 12.0)));
  return vec4(sqrt(col * uTint), 0.35);
#elif defined(KIND_LAVA)
  vec4 aux = AUX(d);
  float h = H(d);
  if (uTempK < 450.0) {
    // Io palette: yellow sulphur and white SO₂ frost, reddish-brown poles, black paterae ringed by
    // red short-chain sulphur plume deposits (Pele-like).
    vec3 col = mix(vec3(0.62, 0.53, 0.25), vec3(0.74, 0.72, 0.6), smoothstep(0.35, 0.75, aux.z));
    col = mix(col, vec3(0.52, 0.4, 0.2), smoothstep(0.4, 0.7, snoise(q * 3.0) * 0.5 + 0.5) * 0.5);
    col = mix(col, vec3(0.34, 0.24, 0.16), smoothstep(radians(50.0), radians(75.0), abs(lat)) * 0.8);
    col = mix(col, vec3(0.55, 0.22, 0.09), smoothstep(0.0, 0.6, aux.y - aux.x) * 0.55);
    col = mix(col, vec3(0.035, 0.03, 0.028), smoothstep(0.05, 0.5, aux.x));
    return vec4(sqrt(col * uTint), 0.0);
  }
  vec3 crust = vec3(0.055, 0.047, 0.043) * (0.8 + 0.4 * (snoise(q * 11.0) * 0.5 + 0.5));
  vec3 sulfur = vec3(0.45, 0.37, 0.12);
  // Sulphur frosts (Io-like) survive only on cooler crusts.
  float s = smoothstep(0.55, 0.8, aux.y) * smoothstep(450.0, 300.0, uTempK);
  vec3 col = mix(crust, sulfur, s * 0.5);
  float lake = smoothstep(uSeaLevel + 0.02, uSeaLevel - 0.02, h);
  col = mix(col, vec3(0.03, 0.02, 0.02), lake);
  return vec4(sqrt(col * uTint), 0.0);
#elif defined(KIND_BARREN)
  vec4 aux = AUX(d);
  vec3 high = vec3(0.24, 0.23, 0.21);
  vec3 mare = vec3(0.085, 0.082, 0.08);
  vec3 col = mix(high, mare, aux.x);
  col *= 0.85 + 0.3 * (fbm3(q * 6.0, 4) * 0.5 + 0.5);
  col = mix(col, vec3(0.42, 0.41, 0.39), clamp(aux.y, 0.0, 1.0) * 0.8);
  return vec4(sqrt(col * uTint), 0.0);
#elif defined(KIND_VENUS)
  // Cloud tops in visible light: creamy, low contrast; faint UV-absorber streaks bent into the
  // characteristic Y/ψ pattern by the equatorial super-rotation.
  float lon = atan(-d.z, d.x);
  float chevron = lon + 1.6 * abs(lat);
  float streak = snoise(vec3(cos(chevron) * 1.4, sin(chevron) * 1.4, lat * 5.0) + uSeedOff) ;
  float zonal = fbm3(vec3(d.x * 2.0, d.y * 9.0, d.z * 2.0) + uSeedOff, 5);
  vec3 base = vec3(0.86, 0.78, 0.58);
  vec3 col = base * (1.0 - 0.07 * smoothstep(-0.2, 0.8, streak) - 0.05 * zonal);
  col *= 1.0 - 0.06 * smoothstep(0.9, 1.3, abs(lat));
  return vec4(sqrt(col * uTint), 0.0);
#elif defined(KIND_GAS) || defined(KIND_ICEGIANT)
  // Belts and zones from a Jupiter-like latitude profile (NEB, SEB, NTB, STB… with sharp edges);
  // zonally stretched turbulence strongest inside belts and at their edges; festoons along the
  // equatorial zone; white ovals; a Great-Red-Spot-like anticyclone with a turbulent wake.
#if defined(KIND_ICEGIANT)
  float turb = 0.3;
  float latScale = 2.2;
#else
  float turb = 1.0;
  float latScale = uHexagon > 0.0 ? 1.35 : 1.0;   // Saturn's bands are broader
#endif
  vec3 p = d;
  // Storm swirl: rotate the local frame around the storm centre.
  vec3 sc = vec3(cos(uStormPos.x) * cos(uStormPos.y), sin(uStormPos.x), -cos(uStormPos.x) * sin(uStormPos.y));
  vec3 se = normalize(vec3(sc.z, 0.0, -sc.x));   // east
  vec3 sn = cross(sc, se);                        // north
  vec2 sl = vec2(dot(d, se), dot(d, sn));
  float sr = dot(d, sc) > 0.0 ? length(sl / vec2(0.19, 0.105)) : 99.0;   // near hemisphere only
  float stormMask = uStorm * smoothstep(1.05, 0.85, sr);
  if (uStorm > 0.0 && sr < 2.2) {
    float ang = 4.0 * exp(-sr * sr * 1.1) * (1.0 - 0.3 * sr);
    vec2 rl = rot2(ang) * sl;
    p = normalize(sc * sqrt(max(0.0, 1.0 - dot(rl, rl))) + se * rl.x + sn * rl.y);
  }
  float la0 = asin(clamp(p.y, -1.0, 1.0));
  float lon0 = atan(-p.z, p.x);
  // Turbulence: small meridional displacement, larger zonal stretching; stronger in belts.
  vec3 zq = vec3(cos(lon0) * 3.0, la0 * 9.0, sin(lon0) * 3.0) + uSeedOff;
  float latDeg0 = degrees(la0) / latScale + (uVariant - 0.5) * 3.0;
  float beltness = jovianBelts(latDeg0);
  float t1 = fbm3(zq * 1.7, 5);
  float t2 = fbm3(vec3(zq.x * 4.0, zq.y * 3.0, zq.z * 4.0) + 7.0, 5);
  float dLat = turb * radians(1.8) * (0.3 + beltness) * t1;
  // Wake west of the storm (the SEB's chaotic region).
  float wake = uStorm * exp(-sqr((degrees(la0 - uStormPos.x)) / 5.0)) * smoothstep(0.0, 0.6, sin(uStormPos.y - lon0));
  dLat += wake * radians(1.5) * t2;
  float la = la0 + dLat;
  float latDeg = degrees(la) / latScale + (uVariant - 0.5) * 3.0;
  float x = jovianBelts(latDeg);
  // Polar regions: mottled, darker, bluer (Jupiter) — or Saturn's hexagon.
  float polar = smoothstep(55.0, 70.0, abs(degrees(la)));
  vec3 col = bandColor(clamp(0.05 + 0.9 * x + 0.22 * t2 * turb * (0.4 + beltness), 0.0, 1.0));
  // Fine zonal filaments.
  float fil = fbm3(vec3(cos(lon0) * 8.0, la * 90.0, sin(lon0) * 8.0) + uSeedOff * 1.3 + vec3(t1 * 0.6), 5);
  col *= 1.0 + 0.22 * fil * turb * (0.4 + beltness);
  // Festoons: dark blue-grey plumes from the NEB's southern edge into the equatorial zone.
  float edge = exp(-sqr((degrees(la) / latScale - 6.0) / 2.2));
  float fest = smoothstep(0.35, 0.75, snoise(vec3(cos(lon0) * 9.0, la * 12.0, sin(lon0) * 9.0) + 5.0)) * edge * (1.0 - uHexagon);
  col = mix(col, vec3(0.34, 0.36, 0.4), fest * 0.5 * turb);
  vec3 polarCol = mix(uBands[uBandCount - 1], vec3(0.36, 0.38, 0.42), 0.45);
  col = mix(col, polarCol * (0.85 + 0.3 * (fbm3(p * 14.0 + uSeedOff, 4) * 0.5 + 0.5)), polar * 0.7 * (1.0 - uHexagon));
  if (uHexagon > 0.0) {
    float lon = atan(-d.z, d.x);
    float hexR = radians(90.0 - 78.0) / cos(mod(lon + uVariant, TAU / 6.0) - PI / 6.0);
    float hx = smoothstep(0.012, 0.0, abs((PI * 0.5 - abs(lat)) - hexR)) * step(0.0, d.y);
    col = mix(col, uBands[uBandCount - 1] * 0.8, hx * 0.8);
    col = mix(col, vec3(0.3, 0.34, 0.4), smoothstep(radians(80.0), radians(89.0), lat) * 0.6);
  }
  // White ovals in the southern temperate belts.
  for (int i = 0; i < 5; i++) {
    vec3 h3 = hash31(float(i) * 13.1 + uVariant * 71.0);
    float olat = radians(-(31.0 + 10.0 * h3.x) * latScale);
    float olon = h3.y * TAU;
    vec3 oc = vec3(cos(olat) * cos(olon), sin(olat), -cos(olat) * sin(olon));
    vec3 oe = normalize(vec3(oc.z, 0.0, -oc.x));
    vec3 on = cross(oc, oe);
    vec2 ol = vec2(dot(d, oe), dot(d, on)) / (radians(1.4 + 1.6 * h3.z) * vec2(1.6, 1.0));
    col = mix(col, vec3(0.8, 0.78, 0.74), step(0.0, dot(d, oc)) * exp(-dot(ol, ol) * 1.5) * 0.85 * turb * (1.0 - uHexagon));
  }
  // The storm: brick-red core, pale collar (the "Red Spot Hollow").
  vec3 stormCol = vec3(0.56, 0.24, 0.11);
  col = mix(col, uBands[0] * 1.04, uStorm * smoothstep(1.6, 1.15, sr) * smoothstep(0.8, 1.1, sr) * 0.7);
  col = mix(col, stormCol * (0.9 + 0.25 * fil), stormMask * 0.9);
#if defined(KIND_ICEGIANT)
  // Neptune-like dark spot with bright methane-ice companions.
  vec3 dc = vec3(cos(-0.35) * cos(uVariant * 6.0), sin(-0.35), -cos(-0.35) * sin(uVariant * 6.0));
  float dd = acos(clamp(dot(d, dc), -1.0, 1.0));
  col *= 1.0 - 0.35 * exp(-sqr(dd / 0.09)) * step(0.5, uVariant);
  float cirrus = smoothstep(0.7, 0.95, snoise(vec3(p.x * 5.0, p.y * 26.0, p.z * 5.0) + 9.0));
  col = mix(col, vec3(0.9, 0.93, 0.95), cirrus * 0.35 * smoothstep(0.1, 0.6, abs(d.y)));
#endif
  return vec4(sqrt(max(col, 0.0) * uTint), 0.0);
#else
  return vec4(sqrt(uTint * 0.5), 0.0);
#endif
}

vec4 normalPass(vec3 d) {
#if defined(KIND_TERRESTRIAL) || defined(KIND_OCEAN) || defined(KIND_DESERT) || defined(KIND_ICE) || defined(KIND_LAVA) || defined(KIND_BARREN)
  // Central differences on the height cube, one texel apart, in the tangent plane.
  vec3 e = normalize(vec3(d.z, 0.0, -d.x) + vec3(1e-6, 0.0, 0.0));
  vec3 n = cross(d, e);
  float eps = 2.0 / uSize;
  float h0 = H(d);
  float hx = H(normalize(d + e * eps)) - H(normalize(d - e * eps));
  float hy = H(normalize(d + n * eps)) - H(normalize(d - n * eps));
#if defined(KIND_TERRESTRIAL) || defined(KIND_OCEAN)
  // Oceans are flat.
  float land = step(uSeaLevel, h0);
  hx *= land;
  hy *= land;
#endif
  float k = 0.012 * uRelief / (2.0 * eps);
  vec3 N = normalize(d - (e * hx + n * hy) * k);
  float emission = 0.0;
  vec4 aux = AUX(d);
#if defined(KIND_TERRESTRIAL) || defined(KIND_OCEAN)
  // City lights: temperate, low, near-coast land; clustered (Voronoi) with road-like filaments.
  if (uCity > 0.0 && h0 > uSeaLevel) {
    float lat = asin(clamp(d.y, -1.0, 1.0));
    float T = surfaceT(lat, (h0 - uSeaLevel) * 9.0);
    float habit = smoothstep(268.0, 285.0, T) * smoothstep(312.0, 300.0, T);
    float coast = exp(-(h0 - uSeaLevel) * 14.0);
    vec3 q = d + uSeedOff;
    vec2 w = worley3(q * 38.0);
    float city = exp(-w.x * w.x * 22.0) * step(0.55, hash13(floor(q * 38.0) + 0.3));
    float sprawl = smoothstep(0.35, 0.8, fbm3(q * 11.0, 4) * 0.5 + 0.5);
    float roads = exp(-sqr((w.y - w.x) / 0.03)) * 0.25;
    emission = clamp((city * 1.2 + roads) * sprawl * habit * (0.25 + 0.75 * coast) * uCity, 0.0, 1.0);
  }
#elif defined(KIND_LAVA)
  float lake = smoothstep(uSeaLevel + 0.02, uSeaLevel - 0.02, h0);
  float heat = fbm3((d + uSeedOff) * 4.0 + vec3(5.0), 4) * 0.5 + 0.5;
  emission = clamp(max(aux.x * 0.95, aux.y * 0.55) * (0.6 + 0.4 * heat) + lake * 0.85, 0.0, 1.0);
  if (uTempK < 450.0) emission = clamp(aux.x * (0.5 + 0.5 * heat), 0.0, 1.0);
#endif
  return vec4(N * 0.5 + 0.5, emission);
#else
  return vec4(d * 0.5 + 0.5, 0.0);
#endif
}

// Cloud coverage: latitude climatology (ITCZ, subtropical clearings, mid-latitude cyclones) + swirled fbm.
vec4 cloudPass(vec3 d) {
  vec3 q = d + uSeedOff * 1.7;
  float lat = asin(clamp(d.y, -1.0, 1.0));
  float al = abs(degrees(lat));
  vec3 p = d;
  // Cyclones: spiral the domain around a few mid-latitude centres (rotation sense by hemisphere).
  for (int i = 0; i < 7; i++) {
    vec3 h3 = hash31(float(i) * 7.3 + uVariant * 53.0);
    float clat = radians((35.0 + 30.0 * h3.x) * (h3.z > 0.5 ? 1.0 : -1.0));
    float clon = h3.y * TAU;
    vec3 c = vec3(cos(clat) * cos(clon), sin(clat), -cos(clat) * sin(clon));
    float dist = acos(clamp(dot(p, c), -1.0, 1.0));
    float ang = (clat > 0.0 ? 1.0 : -1.0) * 2.8 * exp(-dist * dist / 0.035);
    // rotate p around c
    float ca = cos(ang), sa = sin(ang);
    p = normalize(p * ca + cross(c, p) * sa + c * dot(c, p) * (1.0 - ca));
  }
  vec3 w = vec3(fbm3(q * 1.3, 3), fbm3(q * 1.3 + 5.0, 3), fbm3(q * 1.3 + 9.0, 3));
  float n = fbm3((p + uSeedOff * 1.7) * 3.0 + w * 0.8, 7);
  float streak = fbm3(vec3(p.x * 4.0, p.y * 14.0, p.z * 4.0) + uSeedOff, 5);
  float clim = 0.25 * exp(-sqr(al / 8.0)) - 0.22 * exp(-sqr((al - 22.0) / 9.0)) + 0.18 * exp(-sqr((al - 55.0) / 13.0));
  float cov = n + 0.35 * streak + clim + (uCloudAmount - 0.5) * 0.9;
  float c = smoothstep(-0.05, 0.45, cov);
  // Cellular convection texture for the detail channel.
  vec2 wv = worley3(q * 24.0);
  return vec4(c, clamp(wv.x * 1.3, 0.0, 1.0), 0.0, 1.0);
}
`;

const ALBEDO_FRAG = /* glsl */ `${SURFACE_BAKE}
void main() { outColor = albedoPass(cubeDir(gl_FragCoord.xy)); }`;
const NORMAL_FRAG = /* glsl */ `${SURFACE_BAKE}
void main() { outColor = normalPass(cubeDir(gl_FragCoord.xy)); }`;
const CLOUD_FRAG = /* glsl */ `${SURFACE_BAKE}
void main() { outColor = cloudPass(cubeDir(gl_FragCoord.xy)); }`;

export interface BakedSurface {
  albedo: THREE.WebGLCubeRenderTarget | null;
  normal: THREE.WebGLCubeRenderTarget | null;
  clouds: THREE.WebGLCubeRenderTarget | null;
  size: number;
  ready: boolean;
  dispose(): void;
}

function cubeTarget(size: number, mips: boolean, nearest = false): THREE.WebGLCubeRenderTarget {
  const t = new THREE.WebGLCubeRenderTarget(size, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    generateMipmaps: mips,
    minFilter: nearest ? THREE.NearestFilter : mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter,
    magFilter: nearest ? THREE.NearestFilter : THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
  });
  t.texture.name = 'planet-bake';
  return t;
}

/** Bake size for a spec: 256 … 1024 per cube face. */
export function bakeSize(spec: PlanetSpec): number {
  const d = spec.detail ?? 1;
  return d < 0.5 ? 256 : d < 1.2 ? 512 : 1024;
}

/**
 * Bake the procedural surface for `spec` (synchronous GPU work; call once).
 * `uniforms` are the world uniforms (worldUniforms) — uSeaLevel is written here.
 */
export function bakeSurface(renderer: THREE.WebGLRenderer, spec: PlanetSpec, uniforms: Record<string, THREE.IUniform>): BakedSurface {
  const kind = spec.kind;
  const size = bakeSize(spec);
  const define = KIND_DEFINE[kind];
  const hasHeight = HEIGHT_KINDS.has(kind);
  const wantClouds = (spec.clouds ?? 0) > 0 && (kind === 'terrestrial' || kind === 'ocean' || kind === 'desert' || kind === 'ice');

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  const mesh = new THREE.Mesh(geo);
  mesh.frustumCulled = false;
  scene.add(mesh);
  const u: Record<string, THREE.IUniform> & { uFace: THREE.IUniform<number>; uSize: THREE.IUniform<number>; uHeightCube: THREE.IUniform<THREE.Texture | null> } = {
    ...uniforms,
    uFace: { value: 0 },
    uSize: { value: size },
    uEquiSize: { value: new THREE.Vector2(256, 128) },
    uHeightCube: { value: null as THREE.Texture | null },
  };
  const mk = (frag: string, extra: Record<string, string> = {}) =>
    new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: frag,
      uniforms: u,
      defines: { [define]: '', ...extra },
      depthTest: false,
      depthWrite: false,
    });

  const prevTarget = renderer.getRenderTarget();
  const prevFace = renderer.getActiveCubeFace();
  const prevMip = renderer.getActiveMipmapLevel();
  const prevXR = renderer.xr.enabled;
  renderer.xr.enabled = false;

  const renderCube = (target: THREE.WebGLCubeRenderTarget, mat: THREE.ShaderMaterial) => {
    mesh.material = mat;
    const mips = target.texture.generateMipmaps;
    for (let f = 0; f < 6; f++) {
      u.uFace.value = f;
      target.texture.generateMipmaps = mips && f === 5;
      renderer.setRenderTarget(target, f);
      renderer.render(scene, camera);
    }
    target.texture.generateMipmaps = mips;
  };

  let heightCube: THREE.WebGLCubeRenderTarget | null = null;
  const mats: THREE.ShaderMaterial[] = [];
  if (hasHeight) {
    // 1. Pre-pass: equirectangular height → read back → sea level at the requested fraction.
    const pre = new THREE.WebGLRenderTarget(256, 128, { type: THREE.UnsignedByteType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    const preMat = mk(HEIGHT_FRAG, { PREPASS: '' });
    mats.push(preMat);
    mesh.material = preMat;
    renderer.setRenderTarget(pre);
    renderer.render(scene, camera);
    const buf = new Uint8Array(256 * 128 * 4);
    renderer.readRenderTargetPixels(pre, 0, 0, 256, 128, buf);
    pre.dispose();
    const hs: number[] = [];
    const ws: number[] = [];
    for (let y = 0; y < 128; y++) {
      const lat = ((y + 0.5) / 128 - 0.5) * Math.PI;
      const w = Math.cos(lat);
      for (let x = 0; x < 256; x++) {
        const i = (y * 256 + x) * 4;
        const v = (buf[i] * 256 + buf[i + 1]) / 65535;
        hs.push(v * 4 - 2);
        ws.push(w);
      }
    }
    const frac =
      kind === 'terrestrial' ? spec.oceanFraction ?? 0.62
      : kind === 'ocean' ? spec.oceanFraction ?? 0.93
      : kind === 'lava' ? 0.12
      : kind === 'desert' ? 0.3
      : 0.5;
    u.uSeaLevel.value = weightedQuantile(hs, ws, frac);
    // 2. Height cube (nearest, packed 16-bit).
    heightCube = cubeTarget(size, false, true);
    const hMat = mk(HEIGHT_FRAG);
    mats.push(hMat);
    renderCube(heightCube, hMat);
    u.uHeightCube.value = heightCube.texture;
  }
  const albedo = cubeTarget(size, true);
  const aMat = mk(ALBEDO_FRAG);
  mats.push(aMat);
  renderCube(albedo, aMat);
  let normal: THREE.WebGLCubeRenderTarget | null = null;
  if (hasHeight) {
    normal = cubeTarget(size, true);
    const nMat = mk(NORMAL_FRAG);
    mats.push(nMat);
    renderCube(normal, nMat);
  }
  let clouds: THREE.WebGLCubeRenderTarget | null = null;
  if (wantClouds) {
    clouds = cubeTarget(Math.max(256, size / 2), true);
    const cMat = mk(CLOUD_FRAG);
    mats.push(cMat);
    u.uSize.value = clouds.width;
    renderCube(clouds, cMat);
    u.uSize.value = size;
  }
  renderer.xr.enabled = prevXR;
  renderer.setRenderTarget(prevTarget, prevFace, prevMip);
  for (const m of mats) m.dispose();
  geo.dispose();
  heightCube?.dispose();
  return {
    albedo,
    normal,
    clouds,
    size,
    ready: true,
    dispose() {
      albedo.dispose();
      normal?.dispose();
      clouds?.dispose();
    },
  };
}

/** Area-weighted quantile: the value below which a fraction `q` of the (weighted) samples lie. */
export function weightedQuantile(values: number[], weights: number[], q: number): number {
  const idx = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
  const total = weights.reduce((a, b) => a + b, 0);
  let acc = 0;
  const target = Math.min(1, Math.max(0, q)) * total;
  for (const i of idx) {
    acc += weights[i];
    if (acc >= target) return values[i];
  }
  return values[idx[idx.length - 1]];
}
