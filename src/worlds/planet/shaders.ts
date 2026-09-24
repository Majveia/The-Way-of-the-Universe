import { COMMON_GLSL } from '../../shaders/lib/common';
import { NOISE_GLSL } from '../../shaders/lib/noise';
import { BLACKBODY_GLSL } from '../../shaders/lib/blackbody';
import { ATMO_GLSL, ATMO_INTEGRATE_GLSL, ATMO_LOOKUP_GLSL, AURORA_GLSL, RING_TAU_GLSL, SURFACE_UTIL_GLSL } from './glsl';

/**
 * Planet render passes. All fragment shaders ray-trace the exact sphere/ellipsoid from a proxy mesh:
 * the ray is anchored on the proxy vertex (not at a distant camera) so precision holds from a few
 * kilometres to billions of kilometres.
 */

export const PROXY_VERT = /* glsl */ `
out vec3 vPos;
void main() {
  vPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const HEADER = /* glsl */ `
precision highp float;
precision highp sampler2D;
precision highp samplerCube;
${COMMON_GLSL}
${NOISE_GLSL}
${BLACKBODY_GLSL}
${ATMO_GLSL}
${ATMO_LOOKUP_GLSL}
${ATMO_INTEGRATE_GLSL}
${AURORA_GLSL}
${SURFACE_UTIL_GLSL}
${RING_TAU_GLSL}
in vec3 vPos;
out vec4 outColor;
// three.js declares these only for the vertex stage; they link by name.
uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;
uniform vec3 uCamPos;
uniform vec3 uEllipsoid;
uniform vec3 uSunColor;
uniform float uTime;
uniform float uPixelRadius;
uniform float uPixelAngle;
uniform int uDepthMode;
uniform float uLogDepthFC;
uniform int uAtmoSteps;
uniform float uAtmoIntensity;
uniform vec3 uAtmoTint;
uniform vec2 uCloudLayer;
uniform float uCloudOpacity;
uniform float uCloudTime;
uniform float uCloudDensityScale;
uniform float uLights;
uniform vec3 uLightsColorA;
uniform vec3 uLightsColorB;
uniform float uRoughness;
uniform float uLavaT;
uniform float uEmission;
uniform float uRelief;
uniform float uBandTime;
uniform vec3 uTintRT;
uniform float uBakeTexel;
uniform vec3 uSeedOffRT;

#if defined(KIND_EARTH)
uniform sampler2D uDayA;
uniform sampler2D uDayB;
uniform float uDayMix;
uniform sampler2D uNight;
uniform sampler2D uClouds;
uniform sampler2D uTopo;
#elif defined(TEX_MOON)
uniform sampler2D uMoonColor;
uniform sampler2D uMoonHeight;
#else
uniform samplerCube uCubeA;
uniform samplerCube uCubeB;
uniform samplerCube uCubeC;
#endif

float depthOf(vec3 pObj) {
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(pObj, 1.0);
  if (uDepthMode == 2) return log2(max(1e-6, 1.0 + clip.w)) * uLogDepthFC * 0.5;
  float z = clip.z / clip.w;
  return uDepthMode == 1 ? z : z * 0.5 + 0.5;
}

vec3 rotY(vec3 v, float a) {
  float c = cos(a), s = sin(a);
  return vec3(c * v.x + s * v.z, v.y, -s * v.x + c * v.z);
}

// Zonal wind profile (rad per flow cycle): easterly trades, mid-latitude westerlies, polar easterlies.
float windProfile(float lat) {
  float a = abs(lat);
  return -0.6 * exp(-sqr(a / 0.28)) + 1.0 * exp(-sqr((a - 0.8) / 0.25)) - 0.3 * smoothstep(1.1, 1.4, a);
}

// ——— Cloud coverage (0..1) at a direction on the cloud shell ———
float cloudCover(vec3 d, float footprint) {
#if defined(KIND_EARTH)
  float lat = asin(clamp(d.y, -1.0, 1.0));
  float f1 = fract(uCloudTime);
  float f2 = fract(uCloudTime + 0.5);
  float w = windProfile(lat) * 0.05;
  vec2 uv = equirectUV(d);
  float fx = footprint / TAU;
  vec2 g = vec2(fx / max(cos(lat), 0.05), footprint / PI);
  float c1 = textureGrad(uClouds, uv + vec2(w * (f1 - 0.5), 0.0), vec2(g.x, 0.0), vec2(0.0, g.y)).r;
  float c2 = textureGrad(uClouds, uv + vec2(w * (f2 - 0.5), 0.0), vec2(g.x, 0.0), vec2(0.0, g.y)).r;
  // The composite is a gamma-encoded image of cloud brightness: linearise to reflectance.
  float c = pow(mix(c1, c2, abs(2.0 * f1 - 1.0)), 2.2);
  // Sub-texel detail when close: erode/sharpen edges with fbm (real clouds are fractal).
  float texel = PI / 2048.0;
  float detail = smoothstep(texel, texel * 0.1, footprint);
  if (detail > 0.0) {
    float n = fbm3(d * 900.0 + vec3(uCloudTime * 0.3), 4);
    c = clamp(c + detail * (n * 0.35) * (1.0 - c) * c * 4.0, 0.0, 1.0);
  }
  return c;
#elif defined(TEX_MOON)
  return 0.0;
#else
  float lat = asin(clamp(d.y, -1.0, 1.0));
  float f1 = fract(uCloudTime);
  float f2 = fract(uCloudTime + 0.5);
  float w = windProfile(lat) * 0.3;
  float c1 = texture(uCubeC, rotY(d, w * (f1 - 0.5))).r;
  float c2 = texture(uCubeC, rotY(d, w * (f2 - 0.5))).r;
  float c = mix(c1, c2, abs(2.0 * f1 - 1.0));
  float detail = smoothstep(uBakeTexel * 2.0, uBakeTexel * 0.2, footprint);
  if (detail > 0.0) {
    float n = fbm3(d * 260.0 + uSeedOffRT, 4);
    c = clamp(c + detail * n * 0.5 * c * (1.0 - c) * 4.0, 0.0, 1.0);
  }
  return c;
#endif
}

// Vertical optical depth from observed cloud brightness c (inverting the two-stream albedo).
float cloudTau(float c) {
  c = clamp(c, 0.0, 0.93);
  return uCloudDensityScale * 2.0 * c / (0.15 * (1.0 - c));
}
float cloudR(float tau) {
  float t = 0.15 * tau;
  return t / (2.0 + t);
}

struct Surf {
  vec3 albedo;
  vec3 N;
  float spec;
  float emission;
  int photometry;
};

// City-light glow averaged over a few km (lights clouds from below).
vec3 cityGlow(vec3 d, float footprint) {
#if defined(KIND_EARTH)
  vec2 uv = equirectUV(d);
  float l = pow(textureLod(uNight, uv, 4.0).r, 2.2);
  return mix(uLightsColorA, uLightsColorB, 0.35) * l * uLights;
#else
  return vec3(0.0);
#endif
}

Surf surfaceAt(vec3 d, vec3 n, float footprint) {
  Surf s;
  s.N = n;
  s.spec = 0.0;
  s.emission = 0.0;
  s.photometry = 0;
  vec3 east, north;
  tangentFrame(n, east, north);
  float lat = asin(clamp(d.y, -1.0, 1.0));
#if defined(KIND_EARTH)
  EquiUV e = equirect(d);
  vec3 day = mix(sampleEqui(uDayA, e).rgb, sampleEqui(uDayB, e).rgb, uDayMix);
  float tv = sampleEqui(uTopo, e).r * 255.0;
  float water = smoothstep(134.0, 122.0, tv);
  // Ocean: Blue Marble fills open ocean with a flat colour; replace it by a physical water-leaving
  // reflectance, turquoise over shelves, keeping real inland/coastal water colour where MODIS saw it.
  float depth = sqr(1.0 - clamp(tv / 118.0, 0.0, 1.0));
  vec3 ocean = mix(vec3(0.012, 0.045, 0.06), vec3(0.0035, 0.012, 0.03), smoothstep(0.0, 0.08, depth));
  float fill = 1.0 - smoothstep(0.004, 0.02, abs(day.b - 0.0070) + abs(day.r - 0.0006) * 4.0);
  vec3 wcol = mix(max(day * 1.6, ocean * 0.6), ocean, fill);
  // Sea ice / ice shelves in the imagery are bright: keep them.
  float iceLike = smoothstep(0.25, 0.5, luma(day));
  s.albedo = mix(day * 0.82, wcol, water * (1.0 - iceLike));
  s.spec = water * (1.0 - iceLike);
  // Relief from GEBCO elevation at the pixel footprint (≥ 1 texel), exaggerated by uRelief.
  if (uRelief > 0.0 && water < 0.99) {
    float cl = max(cos(lat), 0.05);
    float du = max(1.0 / 4096.0, footprint / TAU / cl);
    float dv = max(1.0 / 2048.0, footprint / PI);
    float hE = textureGrad(uTopo, e.uv + vec2(du, 0.0), e.dx, e.dy).r * 255.0;
    float hW = textureGrad(uTopo, e.uv - vec2(du, 0.0), e.dx, e.dy).r * 255.0;
    float hN = textureGrad(uTopo, e.uv + vec2(0.0, dv), e.dx, e.dy).r * 255.0;
    float hS = textureGrad(uTopo, e.uv - vec2(0.0, dv), e.dx, e.dy).r * 255.0;
    // metres
    hE = sqr(max(hE - 138.0, 0.0) / 117.0) * 6400.0;
    hW = sqr(max(hW - 138.0, 0.0) / 117.0) * 6400.0;
    hN = sqr(max(hN - 138.0, 0.0) / 117.0) * 6400.0;
    hS = sqr(max(hS - 138.0, 0.0) / 117.0) * 6400.0;
    float sx = (hE - hW) / (2.0 * du * TAU * cl * 6.371e6);
    float sy = (hN - hS) / (2.0 * dv * PI * 6.371e6);
    s.N = normalize(n - uRelief * (sx * east + sy * north));
  }
  // Black Marble radiance, stored as L^(1/2.2).
  float lights = pow(sampleEqui(uNight, e).r, 2.2);
  s.emission = lights * (1.0 - water * 0.9);
#elif defined(TEX_MOON)
  EquiUV e = equirect(d);
  s.albedo = sampleEqui(uMoonColor, e).rgb * 0.62 * uTintRT;
  float cl = max(cos(lat), 0.05);
  float du = max(1.0 / 1024.0, footprint / TAU / cl);
  float dv = max(1.0 / 512.0, footprint / PI);
  float hE = textureGrad(uMoonHeight, e.uv + vec2(du, 0.0), e.dx, e.dy).r;
  float hW = textureGrad(uMoonHeight, e.uv - vec2(du, 0.0), e.dx, e.dy).r;
  float hN = textureGrad(uMoonHeight, e.uv + vec2(0.0, dv), e.dx, e.dy).r;
  float hS = textureGrad(uMoonHeight, e.uv - vec2(0.0, dv), e.dx, e.dy).r;
  // LOLA 8-bit relief spans ~20 km over 255 levels on a 1737 km radius.
  float k = 20.0 / 1737.4;
  float sx = (hE - hW) * k / (2.0 * du * TAU * cl);
  float sy = (hN - hS) * k / (2.0 * dv * PI);
  vec3 N = normalize(n - uRelief * (sx * east + sy * north));
  // Sub-texel craters and regolith when very close.
  float detail = smoothstep(PI / 512.0, PI / 4096.0, footprint);
  if (detail > 0.0) {
    vec3 q = d * 420.0;
    float n1 = fbm3(q, 5);
    vec2 w = worley3(q * 0.5);
    float cr = smoothstep(0.35, 0.0, w.x) * 0.5;
    N = normalize(N + detail * 0.15 * (east * (n1 - fbm3(q + vec3(0.03, 0.0, 0.0), 5)) / 0.03 * 0.01 + north * cr * 0.2));
    s.albedo *= 1.0 + detail * 0.15 * n1;
  }
  s.N = N;
  s.photometry = 1;
#else
  // Procedural kinds: baked cube maps (+ runtime detail when a bake texel exceeds the pixel).
  vec3 dd = d;
#if defined(KIND_GAS) || defined(KIND_ICEGIANT) || defined(KIND_VENUS)
  // Differential rotation of the cloud bands, as a two-phase flow map (no unbounded shear).
  float f1 = fract(uBandTime);
  float f2 = fract(uBandTime + 0.5);
  float jets = sin(lat * 18.0 + uSeedOffRT.x) * 0.5 + 0.35 * sin(lat * 7.0 + uSeedOffRT.y);
#if defined(KIND_VENUS)
  jets = 1.0;   // super-rotation of the whole cloud deck
#endif
  float amp = 0.12;
  vec4 a1 = texture(uCubeA, rotY(d, jets * amp * (f1 - 0.5)));
  vec4 a2 = texture(uCubeA, rotY(d, jets * amp * (f2 - 0.5)));
  vec4 A = mix(a1, a2, abs(2.0 * f1 - 1.0));
  s.albedo = A.rgb * A.rgb;
  float detail = smoothstep(uBakeTexel * 1.5, uBakeTexel * 0.2, footprint);
  if (detail > 0.0) {
    vec3 q = d + uSeedOffRT * 0.01;
    float fil = fbm3(vec3(q.x * 90.0, q.y * 700.0, q.z * 90.0), 4);
    s.albedo *= 1.0 + detail * 0.12 * fil;
  }
  s.photometry = 2;
#else
  vec4 A = texture(uCubeA, dd);
  vec4 B = texture(uCubeB, dd);
  s.albedo = A.rgb * A.rgb;
  s.spec = A.a;
  vec3 N = normalize(B.rgb * 2.0 - 1.0);
  // Keep the baked normal in this frame (the bake normal is in the same object space).
  s.N = normalize(mix(n, N, clamp(uRelief, 0.0, 3.0)));
  s.emission = B.a;
  float detail = smoothstep(uBakeTexel * 1.5, uBakeTexel * 0.15, footprint);
  if (detail > 0.0 && s.spec < 0.5) {
    vec3 q = d * 180.0 + uSeedOffRT;
    float e0 = fbm3(q, 5);
    float ex = fbm3(q + east * 0.02, 5);
    float ey = fbm3(q + north * 0.02, 5);
    vec3 g = (east * (ex - e0) + north * (ey - e0)) / 0.02;
    s.N = normalize(s.N - detail * 0.004 * uRelief * g * 180.0 * 0.12);
    s.albedo *= 1.0 + detail * 0.2 * e0;
  }
#if defined(KIND_BARREN) || defined(KIND_ICE) || defined(KIND_LAVA)
  s.photometry = 1;
#endif
#endif
#endif
  return s;
}

struct CloudHit { vec3 L; float T; };

// A cloud layer crossed over [a, b]: two-stream reflectance for the illumination/view geometry,
// direct transmission for what lies behind, silver lining when backlit, city glow from below.
CloudHit cloudSlab(vec3 ro, vec3 rd, float a, float b, float footprint, vec3 E0) {
  CloudHit h;
  vec3 pm = ro + rd * (0.5 * (a + b));
  float rm = length(pm);
  vec3 dm = pm / rm;
  float c = cloudCover(dm, footprint) * uCloudOpacity;
  float thick = uCloudLayer.y - uCloudLayer.x;
  float tauV = cloudTau(c);
  float tauS = tauV * (b - a) / thick;
  h.T = exp(-tauS);
  float muS = dot(dm, uSunDir);
  float mu = clamp(dot(dm, -rd), 0.03, 1.0);
  float R = cloudR(tauV * (0.5 / max(muS, 0.1) + 0.5 / mu));
#ifdef HAS_ATMO
  vec3 Ts = sunTransmittance(rm, muS);
  vec3 Esky = skyIrradiance(rm, muS) * uSunColor;
#else
  vec3 Ts = vec3(sunVisibility(rm, muS));
  vec3 Esky = vec3(0.0);
#endif
  float umb;
  vec3 Es = uSunColor * Ts * occlusion(pm * uEllipsoid, umb) * E0;
  vec3 L = Es * max(muS, 0.0) * R * 0.96 + Esky * R;
  // Forward-scattering (silver lining) from thin cloud edges.
  float back = phaseHG(dot(rd, uSunDir), 0.7) * 4.0 * PI;
  L += Es * back * max(muS + 0.1, 0.0) * (1.0 - h.T) * (1.0 - R) * 0.12;
  // Lit from below by cities.
  L += cityGlow(dm, footprint) * max(1.0 - R - h.T, 0.0) * 0.9;
  h.L = L * (1.0 - h.T * 0.0);
  return h;
}

float cloudShadowAt(vec3 p) {
#ifdef HAS_CLOUDS
  float rc = 0.5 * (uCloudLayer.x + uCloudLayer.y);
  vec2 t = raySphere(p, uSunDir, vec3(0.0), rc);
  if (t.y <= 0.0) return 1.0;
  vec3 q = normalize(p + uSunDir * t.y);
  float c = cloudCover(q, uBakeTexel) * uCloudOpacity;
  float tau = cloudTau(c);
  return mix(1.0, 1.0 - cloudR(tau * 2.0), 0.92);
#else
  return 1.0;
#endif
}
`;

export const SURFACE_FRAG = /* glsl */ `${HEADER}
void main() {
  vec3 S = uEllipsoid;
  vec3 ro = vPos / S;
  vec3 cam = uCamPos / S;
  vec3 rv = ro - cam;
  float camDist = length(rv);
  vec3 rd = rv / camDist;
  float tCam = -camDist;
  vec2 hit = raySphere(ro, rd, vec3(0.0), 1.0);
  if (hit.x > hit.y || uPixelRadius < 1.0) discard;
  float tHit = hit.x >= tCam ? hit.x : hit.y;
  if (tHit < tCam) discard;
  vec3 p = ro + rd * tHit;
  vec3 n = normalize(p / S);
  vec3 d = normalize(p);
  float dist = tHit - tCam;
  float footprint = dist * uPixelAngle / max(dot(n, -rd), 0.2);
  // Ground-hitting rays integrate a smooth, monotonic density: midpoint samples are accurate and
  // noise-free. (Limb rays in the atmosphere pass are jittered instead.)
  float jitter = 0.5;
  vec3 pReal = p * S;

  Surf s = surfaceAt(d, n, footprint);
  vec3 V = -rd;
  float NoV = max(dot(n, V), 1e-4);
  float muS = dot(n, uSunDir);
#ifdef HAS_ATMO
  vec3 Tsun = sunTransmittance(1.0, muS);
  vec3 Esky = skyIrradiance(1.0, muS) * uSunColor * uAtmoIntensity;
#else
  vec3 Tsun = vec3(sunVisibility(1.0, muS));
  vec3 Esky = vec3(0.0);
#endif
  float umbra;
  float occ = occlusion(pReal, umbra);
#ifdef HAS_RINGS
  float rsh = ringShadow(pReal);
#else
  float rsh = 1.0;
#endif
  float csh = cloudShadowAt(p);
  vec3 Esun = uSunColor * Tsun * occ * rsh * csh;
  Esky *= mix(1.0, occ, 0.9) * mix(1.0, rsh, 0.5);
  float NoL = max(dot(s.N, uSunDir), 0.0);
  float brdf = NoL;
  if (s.photometry == 1) {
    // Lommel–Seeliger with a gentle opposition surge (airless regolith).
    float alpha = acos(clamp(dot(V, uSunDir), -1.0, 1.0));
    brdf = 2.0 * NoL / (NoL + NoV) * (1.0 + 0.35 * exp(-alpha / 0.08)) * 0.72;
  } else if (s.photometry == 2) {
    // Minnaert limb darkening for giant-planet cloud decks.
    brdf = pow(max(NoL, 0.0), 0.92) * pow(NoV, -0.08);
  }
  vec3 Lg = s.albedo * (Esun * brdf + Esky * (0.5 + 0.5 * dot(s.N, n)));
  // Umbra lit by light refracted through the occluder's atmosphere (lunar eclipse).
  Lg += s.albedo * uUmbraLight * uSunColor * umbra * max(dot(n, uSunDir), 0.0);
  if (s.spec > 0.0) {
    vec3 H = normalize(uSunDir + V);
    float NoLg = max(muS, 0.0);
    float a = uRoughness;
    float D = D_GGX(max(dot(n, H), 0.0), a);
    float Vis = V_SmithGGX(NoV, NoLg, a);
    float F = fresnelSchlick(dot(V, H), 0.02);
    vec3 glint = PI * Esun * D * Vis * F * NoLg;
    float Fv = fresnelSchlick(NoV, 0.02);
    Lg = Lg * (1.0 - Fv * s.spec) + (glint + Fv * Esky) * s.spec;
  }
  // Emission: city lights (drowned by daylight), molten rock (blackbody, physically scaled).
  float daylight = luma(Esun * max(muS, 0.0) + Esky);
  if (s.emission > 0.0) {
#if defined(KIND_LAVA)
    float T = mix(650.0, uLavaT, s.emission) * (0.94 + 0.06 * snoise(vec3(d * 40.0) + uTime * 0.02));
    float c2 = 25925.0;   // hc/(λk) at 555 nm
    float rad = 46200.0 * (exp(c2 / 5772.0) - 1.0) / (exp(c2 / T) - 1.0);
    Lg += blackbody(T) * rad * uEmission * smoothstep(0.02, 0.2, s.emission);
#else
    float h = hash12(floor(gl_FragCoord.xy * 0.25));
    vec3 lc = mix(uLightsColorA, uLightsColorB, clamp(s.emission * 3.0 + h * 0.2, 0.0, 1.0));
    Lg += lc * s.emission * uLights * exp(-daylight * 60.0);
#endif
  }

  float tTopEntry = raySphere(ro, rd, vec3(0.0), uTop).x;
  float tEntry = max(tTopEntry, tCam);
  vec3 color;
  vec3 k = PI * uSunColor * uAtmoIntensity * uAtmoTint;
#ifdef HAS_ATMO
  int nSteps = uAtmoSteps;
#ifdef HAS_CLOUDS
  vec2 co = raySphere(ro, rd, vec3(0.0), uCloudLayer.y);
  vec2 ci = raySphere(ro, rd, vec3(0.0), uCloudLayer.x);
  float ca = max(co.x, tCam);
  float cb = min(ci.x, tHit);
  if (uCloudOpacity > 0.0 && cb > ca && camDist > 0.0) {
    AtmoSeg A1 = integrateAtmo(ro, rd, tEntry, ca, nSteps, jitter);
    AtmoSeg A2 = integrateAtmo(ro, rd, cb, tHit, 3, jitter);
    CloudHit c = cloudSlab(ro, rd, ca, cb, footprint, vec3(1.0));
    color = A1.L * k + A1.T * (c.L + c.T * (A2.L * k + A2.T * Lg));
  } else {
    AtmoSeg A = integrateAtmo(ro, rd, tEntry, tHit, nSteps, jitter);
    color = A.L * k + A.T * Lg;
  }
#else
  AtmoSeg A = integrateAtmo(ro, rd, tEntry, tHit, nSteps, jitter);
  color = A.L * k + A.T * Lg;
#endif
#ifdef HAS_AURORA
  color += auroraEmission(ro, rd, tEntry, tHit, jitter) + airglowEmission(ro, rd, tEntry, tHit, jitter);
#endif
#else
  color = Lg;
#endif
  outColor = vec4(max(color, vec3(0.0)), 1.0);
  gl_FragDepth = depthOf(pReal);
}`;

/** Sky/limb pass. TRANSMIT: per-channel transmittance (multiply blend); else in-scattered light (add). */
export const ATMO_FRAG = /* glsl */ `${HEADER}
void main() {
  vec3 S = uEllipsoid;
  vec3 ro = vPos / S;
  vec3 cam = uCamPos / S;
  vec3 rv = ro - cam;
  float camDist = length(rv);
  vec3 rd = rv / camDist;
  float tCam = -camDist;
  if (uPixelRadius < 1.0) discard;
  vec2 top = raySphere(ro, rd, vec3(0.0), uTop);
  if (top.x > top.y) discard;
  float t0 = max(top.x, tCam);
  float t1 = top.y;
  if (t1 <= t0) discard;
  vec2 g = raySphere(ro, rd, vec3(0.0), 1.0);
  if (g.x <= g.y && g.y > tCam) discard;   // the surface pass owns rays that hit the ground
  float jitter = ign(gl_FragCoord.xy);
  float footprint = (t0 - tCam) * uPixelAngle;
  // Cloud segments along the limb ray (up to two: near and far side of the cloud shell).
  vec2 segA = vec2(0.0), segB = vec2(0.0);
  int nseg = 0;
#ifdef HAS_CLOUDS
  if (uCloudOpacity > 0.0) {
    vec2 co = raySphere(ro, rd, vec3(0.0), uCloudLayer.y);
    vec2 ci = raySphere(ro, rd, vec3(0.0), uCloudLayer.x);
    if (co.x < co.y && co.y > t0) {
      if (ci.x > ci.y) {
        segA = vec2(max(co.x, t0), co.y);
        nseg = 1;
      } else {
        segA = vec2(max(co.x, t0), ci.x);
        segB = vec2(max(ci.y, t0), co.y);
        nseg = segA.y > segA.x ? 2 : 1;
        if (segA.y <= segA.x) segA = segB;
      }
    }
  }
#endif
#ifdef TRANSMIT
  float r0 = length(ro + rd * t0);
  float mu0 = dot(ro + rd * t0, rd) / r0;
  vec3 T = transmittanceToTop(r0, mu0);
#ifdef HAS_CLOUDS
  if (nseg >= 1) T *= cloudSlab(ro, rd, segA.x, segA.y, footprint, vec3(0.0)).T;
  if (nseg >= 2) T *= cloudSlab(ro, rd, segB.x, segB.y, footprint, vec3(0.0)).T;
#endif
  outColor = vec4(T, 1.0);
#else
  vec3 k = PI * uSunColor * uAtmoIntensity * uAtmoTint;
  vec3 L = vec3(0.0), T = vec3(1.0);
  float cur = t0;
  int budget = uAtmoSteps + 4;
  for (int i = 0; i < 2; i++) {
    if (i >= nseg) break;
    vec2 sg = i == 0 ? segA : segB;
    int n = max(3, int(float(budget) * (sg.x - cur) / max(t1 - t0, 1e-6)));
    AtmoSeg A = integrateAtmo(ro, rd, cur, sg.x, n, jitter);
    L += T * A.L * k;
    T *= A.T;
    CloudHit c = cloudSlab(ro, rd, sg.x, sg.y, footprint, vec3(1.0));
    L += T * c.L;
    T *= c.T;
    cur = sg.y;
  }
  AtmoSeg A = integrateAtmo(ro, rd, cur, t1, nseg > 0 ? max(4, budget / 2) : budget, jitter);
  L += T * A.L * k;
#ifdef HAS_AURORA
  L += auroraEmission(ro, rd, t0, t1, jitter) + airglowEmission(ro, rd, t0, t1, jitter);
#endif
  outColor = vec4(max(L, vec3(0.0)), 1.0);
#endif
}`;

export const RING_FRAG = /* glsl */ `
precision highp float;
${COMMON_GLSL}
uniform vec3 uSunDir;
${RING_TAU_GLSL}
in vec3 vPos;
out vec4 outColor;
uniform vec3 uCamPos;
uniform vec3 uSunColor;
uniform float uSunAng;
uniform vec3 uEllipsoid;
uniform vec3 uRingColor;
uniform vec3 uRingColorB;
uniform float uRingAlbedo;
uniform float uHalf;
uniform float uPixelRadius;
uniform float uDust;
uniform vec3 uPlanetAlbedo;

float ringPhase(float alpha, float dust) {
  float lambert = (8.0 / (3.0 * PI)) * (sin(alpha) + (PI - alpha) * cos(alpha));
  float fwd = 4.0 * PI * phaseHG(-cos(alpha), 0.72);
  return mix(lambert, fwd, dust);
}

void main() {
  vec3 p = vPos;
  float r = length(p.xz);
  vec4 s = ringSample(r);
  float tau = s.r;
  if (tau < 1e-4 || uPixelRadius < 1.0) discard;
  if (dot(p, normalize(uCamPos)) * uHalf < 0.0) discard;
  vec3 V = normalize(uCamPos - p);
  float mu = max(abs(V.y), 2e-3);
  float mu0 = abs(uSunDir.y);
  bool lit = V.y * uSunDir.y > 0.0;
  float alpha = acos(clamp(dot(V, uSunDir), -1.0, 1.0));
  float P = ringPhase(alpha, clamp(s.g * uDust * 2.0, 0.0, 1.0));
  float kk = uRingAlbedo * P / 4.0;
  float I = 0.0;
  if (mu0 > 1e-4) {
    if (lit) I = kk * mu0 / (mu + mu0) * (1.0 - exp(-tau * (1.0 / mu + 1.0 / mu0)));
    else if (abs(mu - mu0) < 1e-3) I = kk * tau / mu0 * exp(-tau / mu0);
    else I = kk * mu0 / (mu - mu0) * (exp(-tau / mu) - exp(-tau / mu0));
  }
  // The planet's shadow on the rings (soft edge from the star's finite size).
  vec3 ps = p / uEllipsoid;
  vec3 ls = normalize(uSunDir / uEllipsoid);
  float tc = -dot(ps, ls);
  float shadow = 1.0;
  if (tc > 0.0) {
    float dperp = length(ps + ls * tc);
    float pen = max(tc * uSunAng, 0.002);
    shadow = smoothstep(1.0 - pen, 1.0 + pen, dperp);
  }
  vec3 col = mix(uRingColorB, uRingColor, s.a) * s.b;
  vec3 L = uSunColor * col * I * shadow;
  // Planetshine: the day side of the planet faintly lights the rings (both faces).
  float ps2 = max(dot(normalize(-p), uSunDir), 0.0);
  L += uSunColor * col * uPlanetAlbedo * 0.02 * ps2 * (1.0 - exp(-tau / mu)) / (r * r);
  float opacity = 1.0 - exp(-tau / mu);
  outColor = vec4(max(L, vec3(0.0)), opacity);
}`;

export const POINT_VERT = /* glsl */ `
uniform float uWorldRadius;
uniform float uViewportH;
uniform vec3 uPointColor;
out vec3 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  gl_Position = projectionMatrix * mv;
  float dist = max(-mv.z, 1e-12);
  float rpx = uWorldRadius / dist * projectionMatrix[1][1] * 0.5 * uViewportH;
  float on = rpx < 1.0 ? 1.0 : 0.0;
  gl_PointSize = on * 5.0;
  // Flux-conserving: the disk's integrated radiance (L̄ · π r²) spread over a σ≈0.75 px Gaussian.
  vColor = uPointColor * (3.14159265 * rpx * rpx) / 3.53 * on;
}`;

export const POINT_FRAG = /* glsl */ `
precision highp float;
in vec3 vColor;
out vec4 outColor;
void main() {
  vec2 q = (gl_PointCoord - 0.5) * 5.0;
  float w = exp(-dot(q, q) / (2.0 * 0.75 * 0.75));
  outColor = vec4(vColor * w, 1.0);
}`;
