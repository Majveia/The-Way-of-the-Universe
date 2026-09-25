import * as THREE from 'three';
import { Rng } from '../../physics/random';
import { OBLIQUITY_J2000 } from '../../physics/constants';
import { COMMON_GLSL } from '../../shaders/lib/common';
import { NOISE_GLSL } from '../../shaders/lib/noise';
import { BLACKBODY_GLSL } from '../../shaders/lib/blackbody';
import {
  LUMINANCE_LUT,
  SUN_CMB_DIPOLE,
  T_CMB,
  addVelocities,
  aberrateDirection,
  createLuminanceLUT,
  gammaOf,
  logBlackbodyLuminance,
} from '../../physics/voyage-relativity';
import { RELATIVITY_GLSL, RELATIVITY_UNIFORMS_GLSL } from './relativityGlsl';
import { galacticLBToThree, loadStarCatalog, starCatalogIfLoaded, type StarCatalog } from './catalog';
import { ConstellationLines } from './ConstellationLines';

export type SkyFrame = 'galactic' | 'equatorial' | 'ecliptic';

export interface SkyOptions {
  seed?: number;
  /** Number of point stars (scaled by quality detail by the caller if desired). */
  stars?: number;
  /** Milky Way band intensity (0 disables the band). */
  milkyWay?: number;
  /** Overall brightness multiplier for stars. */
  brightness?: number;
  /** Point sprite size multiplier. */
  starSize?: number;
  /** Which astronomical frame the sky is expressed in (three.js y-up mapping, see physics/kepler astroToThree). */
  frame?: SkyFrame;
  /** Faintest apparent magnitude generated. */
  limitingMagnitude?: number;
  /**
   * Real star catalogue (HYG v4.4: every star to V = 6.5 plus all within 25 pc) placed in 3D.
   * 'auto' (default) = on for the 'equatorial' and 'ecliptic' frames (solar-system and Earth views),
   * off for 'galactic'. Pass a loaded StarCatalog to avoid the async load. Procedural stars then fill
   * in magnitudes fainter than 6.5.
   */
  catalog?: boolean | 'auto' | StarCatalog;
  /** Constellation stick-figure opacity (0 = hidden, the default). Needs the catalogue. */
  constellations?: number;
  /** Pre-exposure multiplier applied to all sky radiance (default 1). */
  exposure?: number;
  /**
   * Face size (texels) of the cube map the Milky Way band is baked into on first render (default
   * 1024 ≈ 0.09°/texel; 0 = evaluate the procedural band per pixel every frame, as before). The bake
   * turns 21 octaves of 3D simplex noise per pixel (~10 ms/frame at 1080p on a 2.5-TFLOPS GPU) into
   * one cube-map fetch. Falls back to the procedural band where float render targets are unavailable.
   */
  bandResolution?: number;
}

/** Which relativistic effects to show for a moving observer (all physical by default). */
export interface RelativityFlags {
  /** Aberration: directions crowd toward the direction of motion. */
  aberration: boolean;
  /** Doppler shift of colour temperature (T' = δT). */
  doppler: boolean;
  /** Relativistic beaming / searchlight effect on brightness. */
  beaming: boolean;
}

/** A catalogue star as seen by the (possibly moving) observer. */
export interface ApparentStar {
  /** Observed direction, world frame (unit). */
  dir: THREE.Vector3;
  /** Rest-frame direction, world frame (unit). */
  restDir: THREE.Vector3;
  /** Distance from the observer, pc. */
  distance: number;
  /** Observed apparent visual magnitude (after beaming, if enabled). */
  mag: number;
  /** Observed colour temperature, K (after Doppler, if enabled). */
  temperature: number;
  /** Doppler factor δ. */
  delta: number;
}

/**
 * Galactic (l,b) → equatorial J2000 rotation (transpose of the Hipparcos A_G matrix, ESA 1997 eq. 1.5.11).
 * Rows map galactic unit vectors to equatorial.
 */
const GAL_TO_EQ = new THREE.Matrix3().set(
  -0.0548755604, 0.4941094279, -0.867666149,
  -0.8734370902, -0.44482963, -0.1980763734,
  -0.4838350155, 0.7469822445, 0.4559837762,
);

/** Rotation that takes galactic-frame three.js vectors into the requested frame (three.js axes). */
export function skyFrameMatrix(frame: SkyFrame): THREE.Matrix4 {
  const P = new THREE.Matrix3().set(1, 0, 0, 0, 0, 1, 0, -1, 0); // astro → three
  const Pt = P.clone().transpose();
  let M = new THREE.Matrix3(); // astro galactic → astro target
  if (frame === 'equatorial') M = GAL_TO_EQ.clone();
  else if (frame === 'ecliptic') {
    const c = Math.cos(OBLIQUITY_J2000), s = Math.sin(OBLIQUITY_J2000);
    const EQ_TO_ECL = new THREE.Matrix3().set(1, 0, 0, 0, c, s, 0, -s, c);
    M = EQ_TO_ECL.multiply(GAL_TO_EQ.clone());
  }
  const T = P.clone().multiply(M).multiply(Pt);
  return new THREE.Matrix4().setFromMatrix3(T);
}

const BAND_VERT = /* glsl */ `
out vec3 vDir;
out vec3 vWorld;
void main() {
  vDir = position;
  vWorld = mat3(modelMatrix) * position;
  vec3 d = mat3(viewMatrix) * vWorld;
  vec4 clip = projectionMatrix * vec4(d, 1.0);
  clip.z = clip.w * 0.99999;
  gl_Position = clip;
}`;

/**
 * The procedural Milky Way (galactic three.js frame: +X = galactic centre, +Y = north galactic pole).
 * `band(d)` returns (emission·transmission, warm fraction, transmission) for a unit direction d.
 * The warm fraction is a smooth analytic function of direction (`bandWarm`), so the bake stores only
 * the two noisy channels (emission·transmission, transmission) and the warm term is recomputed.
 */
const BAND_FN_GLSL = /* glsl */ `
uniform float uSeed;
float bandWarm(vec3 d) {
  // Colour: old warm light toward the bulge, bluer star-forming disk elsewhere.
  float l = atan(-d.z, d.x);
  float bulge = exp(-(l * l) / (2.0 * 0.26 * 0.26)) * exp(-abs(d.y) / 0.14);
  return clamp(bulge * 1.6 + 0.2, 0.0, 1.0);
}
vec3 band(vec3 d) {
  float sb = d.y;                       // sin(b)
  float l = atan(-d.z, d.x);            // galactic longitude, 0 at the centre
  float cl = cos(l);
  vec3 p = d * 2.4 + uSeed;
  // Thin disk + central bulge brightness (exponential in |sin b|).
  float disk = exp(-abs(sb) / 0.07) * (0.5 + 0.5 * max(cl, 0.0) * max(cl, 0.0) + 0.12);
  float thick = exp(-abs(sb) / 0.2) * 0.12;
  float bulge = exp(-(l * l) / (2.0 * 0.26 * 0.26)) * exp(-abs(sb) / 0.14);
  // Star clouds and dust are sheared along the plane (differential rotation stretches them in
  // longitude), so sample the noise anisotropically: finer in latitude than in longitude.
  const vec3 ANISO = vec3(1.0, 2.2, 1.0);
  float clouds = 0.5 + 0.5 * fbm3(p * 1.6 * ANISO, 5);
  float granular = 0.55 + 0.45 * fbm3(d * 16.0 + uSeed * 1.7, 5);
  float emission = disk * clouds * granular * 1.3 + thick + 1.5 * bulge * (0.75 + 0.25 * granular);
  // Dust: the Great Rift — filamentary absorbing lanes hugging the plane.
  float dn = fbm3(d * 6.0 * ANISO + 11.0, 6);
  float fil = 1.0 - abs(fbm3(d * 13.0 * ANISO + 3.0, 5));
  float dust = (smoothstep(-0.05, 0.45, dn) * 0.8 + 0.6 * smoothstep(0.6, 0.95, fil))
             * exp(-abs(sb + 0.01 * sin(l * 3.0)) / 0.035);
  float trans = exp(-dust * 2.4);
  // (dust reddens: the caller tints by the transmission)
  return vec3(emission * trans, bandWarm(d), trans);
}`;

/**
 * Bakes the band into one face of a cube map. Face/texel → direction follows the GL cube-map
 * convention (OpenGL ES 3.0 §3.8.10, Table 3.21), so `texture(samplerCube, d)` returns band(d).
 */
const BAND_BAKE_FRAG = /* glsl */ `
precision highp float;
${NOISE_GLSL}
out vec4 outColor;
uniform int uFace;
uniform float uSize;
${BAND_FN_GLSL}
void main() {
  vec2 st = gl_FragCoord.xy / uSize * 2.0 - 1.0;
  vec3 d;
  if (uFace == 0) d = vec3(1.0, -st.y, -st.x);
  else if (uFace == 1) d = vec3(-1.0, -st.y, st.x);
  else if (uFace == 2) d = vec3(st.x, 1.0, st.y);
  else if (uFace == 3) d = vec3(st.x, -1.0, -st.y);
  else if (uFace == 4) d = vec3(st.x, -st.y, 1.0);
  else d = vec3(-st.x, -st.y, -1.0);
  vec3 b = band(normalize(d));
  outColor = vec4(b.x, b.z, 0.0, 1.0);
}`;

const BAND_FRAG = /* glsl */ `
precision highp float;
${COMMON_GLSL}
${NOISE_GLSL}
${BLACKBODY_GLSL}
${RELATIVITY_UNIFORMS_GLSL}
${RELATIVITY_GLSL}
in vec3 vDir;
in vec3 vWorld;
out vec4 outColor;
uniform float uIntensity;
uniform float uExposure;
uniform mat3 uSkyRotInv;
uniform vec3 uCmbBeta;
uniform float uCmbBetaMag;
uniform float uCmbGamma;
uniform float uCmbLogScale;
uniform float uCmbOn;
${BAND_FN_GLSL}
#ifdef BAND_BAKED
uniform samplerCube uBandTex;
// One (seamless, bilinear) cube-map fetch instead of 21 octaves of simplex noise.
vec3 bandAt(vec3 d) {
  vec2 e = texture(uBandTex, d).rg;
  return vec3(e.x, bandWarm(d), e.y);
}
#else
vec3 bandAt(vec3 d) { return band(d); }
#endif

void main() {
  vec3 col = vec3(0.0);
  if (uBetaMag < 1e-7) {
    vec3 b = bandAt(normalize(vDir));
    vec3 c = mix(blackbody(8200.0), blackbody(4200.0), b.y);
    c *= mix(vec3(1.0, 0.78, 0.6), vec3(1.0), b.z);
    col = c * b.x * uIntensity * 0.075;
  } else {
    // Moving observer: find the rest-frame direction this pixel sees, then Doppler-shift the light.
    float delta;
    vec3 dRest = relDeaberrate(normalize(vWorld), delta);
    vec3 b = bandAt(normalize(uSkyRotInv * dRest));
    float dc = uRelFlags.y > 0.5 ? delta : 1.0;
    // Diluted starlight keeps its spectral shape: I'_V / I_V = L(δT) / L(T) (no δ² for extended light).
    float kCool = uRelFlags.z > 0.5 ? pow(10.0, clamp(logLum(8200.0 * delta) - logLum(8200.0), -30.0, 12.0)) : 1.0;
    float kWarm = uRelFlags.z > 0.5 ? pow(10.0, clamp(logLum(4200.0 * delta) - logLum(4200.0), -30.0, 12.0)) : 1.0;
    vec3 c = mix(blackbody(8200.0 * dc) * kCool, blackbody(4200.0 * dc) * kWarm, b.y);
    c *= mix(vec3(1.0, 0.78, 0.6), vec3(1.0), b.z);
    col = c * b.x * uIntensity * 0.075;
  }
  if (uCmbOn > 0.5) {
    // The cosmic microwave background, a 2.7255 K blackbody, Doppler-boosted into the visible ahead.
    float dObs = dot(normalize(vWorld), uCmbBeta / max(uCmbBetaMag, 1e-12));
    float delta = 1.0 / (uCmbGamma * (1.0 - uCmbBetaMag * dObs));
    float T = ${T_CMB.toFixed(4)} * delta;
    float l = logLum(T) + uCmbLogScale;
    if (l > -8.0) col += blackbody(T) * pow(10.0, min(l, 4.6)) / max(uExposure, 1e-30);
  }
  outColor = vec4(min(col * uExposure, vec3(6.0e4)), 1.0);
}`;

const STAR_VERT = /* glsl */ `
${BLACKBODY_GLSL}
${RELATIVITY_UNIFORMS_GLSL}
${RELATIVITY_GLSL}
in float mag;
in float temp;
uniform float uPixelRatio;
uniform float uSize;
uniform float uBrightness;
uniform float uSaturation;
uniform float uExposure;
uniform float uFade;
out vec3 vColor;
void main() {
  vec3 dir = mat3(modelMatrix) * position;
  float T = temp;
  float m = mag;
  if (uBetaMag >= 1e-7) {
    float delta;
    dir = relAberrate(normalize(dir), delta);
    float Tobs = T * delta;
    if (uRelFlags.z > 0.5) m -= 2.5 * (logLum(Tobs) - logLum(T) - 2.0 * log(delta) * 0.4342944819);
    if (uRelFlags.y > 0.5) T = Tobs;
  }
  vec3 d = mat3(viewMatrix) * dir;
  vec4 clip = projectionMatrix * vec4(d, 1.0);
  clip.z = clip.w * 0.99999;
  gl_Position = clip;
  float flux = pow(10.0, -0.4 * (min(m, 60.0) - 1.0));
  float size = clamp(uSize * (1.6 + 2.2 * pow(flux, 0.3)), 1.6, 18.0) * uPixelRatio;
  gl_PointSize = size;
  vec3 c = blackbody(T);
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = max(vec3(lum) + uSaturation * (c - vec3(lum)), 0.0);
  // Energy-normalised so the integrated flux does not depend on sprite size.
  vColor = c * flux * uBrightness * uExposure * uFade * 10.0 * uPixelRatio * uPixelRatio / (size * size);
}`;

const STAR_FRAG = /* glsl */ `
precision highp float;
in vec3 vColor;
out vec4 outColor;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(q, q);
  if (r2 > 1.0) discard;
  // Airy-like core plus a faint wing.
  float core = exp(-r2 * 9.0);
  float wing = 0.06 * exp(-r2 * 2.5) * (1.0 - r2);
  outColor = vec4(min(vColor * (core + wing) * 3.2, vec3(6.0e4)), 1.0);
}`;

/**
 * Stars placed in 3D (parsecs, galactic frame): parallax, distance modulus, proper motion, relativity.
 * Point-spread function: a Gaussian core (≈ 2 px FWHM) holding 97 % of the light plus a Moffat
 * (β = 2.4) glare halo whose visible radius grows with brightness — bright stars look bigger for the
 * same reason they do to eyes and cameras, while every sprite conserves its flux.
 */
const STAR3D_VERT = /* glsl */ `
${BLACKBODY_GLSL}
${RELATIVITY_UNIFORMS_GLSL}
${RELATIVITY_GLSL}
in vec3 posLo;
in vec3 vel;
in float absMag;
in float temp;
uniform vec3 uObsHi;
uniform vec3 uObsLo;
uniform float uEpoch;
uniform float uPixelRatio;
uniform float uSize;
uniform float uBrightness;
uniform float uSaturation;
uniform float uExposure;
uniform float uFade;
uniform float uMinDist;
uniform float uMaxRadius;
uniform float uLimit;
uniform int uHide[8];
out vec3 vCore;
out vec3 vHalo;
out float vRadius;
out float vSigma;
out float vAlpha;
const float LOG10E = 0.4342944819;
void cull() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vCore = vHalo = vec3(0.0); vRadius = vSigma = vAlpha = 1.0; }
void main() {
  for (int k = 0; k < 8; k++) if (uHide[k] == gl_VertexID) { cull(); return; }
  // Relative position with double-single precision (hi/lo parts) so directions stay exact near stars.
  vec3 rel = (position - uObsHi) + (posLo - uObsLo) + vel * uEpoch;
  float d = length(rel);
  if (d < uMinDist) { cull(); return; }
  vec3 dir = normalize(mat3(modelMatrix) * (rel / d));
  float T = temp;
  float m = absMag + 5.0 * (log(d) * LOG10E - 1.0);
  if (uBetaMag >= 1e-7) {
    float delta;
    dir = relAberrate(dir, delta);
    float Tobs = T * delta;
    if (uRelFlags.z > 0.5) m -= 2.5 * (logLum(Tobs) - logLum(T) - 2.0 * log(delta) * LOG10E);
    if (uRelFlags.y > 0.5) T = Tobs;
  }
  // Energy in display units × device px² (3.17 matches the legacy sprite calibration at V = 1).
  float E = 3.17 * pow(10.0, -0.4 * (clamp(m, -40.0, 60.0) - 1.0)) * uBrightness * uExposure * uFade * uPixelRatio * uPixelRatio;
  if (E < 2e-5) { cull(); return; }
  vec3 dv = mat3(viewMatrix) * dir;
  vec4 clip = projectionMatrix * vec4(dv, 1.0);
  clip.z = clip.w * 0.99999;
  gl_Position = clip;
  float sigma = 0.85 * sqrt(uPixelRatio) * uSize;
  float peak = 0.97 * E / (6.2831853 * sigma * sigma);
  float a = 2.0 * uPixelRatio * uSize;
  // Moffat β = 2.4 halo holding 3 % of the light: normalisation (β − 1)/(π a²).
  float h0 = 0.03 * E * 1.4 / (3.14159265 * a * a);
  float R = 3.2 * sigma;
  if (h0 > uLimit) R = max(R, a * sqrt(pow(h0 / uLimit, 1.0 / 2.4) - 1.0));
  if (peak > uLimit) R = max(R, sigma * sqrt(2.0 * log(peak / uLimit)));
  R = min(R, uMaxRadius);
  gl_PointSize = 2.0 * R;
  vec3 c = blackbody(T);
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = max(vec3(lum) + uSaturation * (c - vec3(lum)), 0.0);
  vCore = c * peak;
  vHalo = c * h0;
  vRadius = R;
  vSigma = sigma;
  vAlpha = a;
}`;

const STAR3D_FRAG = /* glsl */ `
precision highp float;
in vec3 vCore;
in vec3 vHalo;
in float vRadius;
in float vSigma;
in float vAlpha;
out vec4 outColor;
void main() {
  vec2 q = (gl_PointCoord * 2.0 - 1.0) * vRadius;
  float r2 = dot(q, q);
  float R2 = vRadius * vRadius;
  if (r2 >= R2) discard;
  float core = exp(-0.5 * r2 / (vSigma * vSigma));
  float halo = pow(1.0 + r2 / (vAlpha * vAlpha), -2.4);
  float taper = 1.0 - r2 / R2;
  vec3 col = vCore * core + vHalo * halo * taper * taper;
  outColor = vec4(min(col, vec3(6.0e4)), 1.0);
}`;

/** Uniforms shared by every relativistic sky material (same objects → one update per frame). */
interface SharedUniforms {
  uBeta: THREE.IUniform<THREE.Vector3>;
  uBetaMag: THREE.IUniform<number>;
  uGamma: THREE.IUniform<number>;
  uRelFlags: THREE.IUniform<THREE.Vector3>;
  uLumLUT: THREE.IUniform<THREE.Texture>;
  uLumLUTRange: THREE.IUniform<THREE.Vector3>;
  uExposure: THREE.IUniform<number>;
  uPixelRatio: THREE.IUniform<number>;
  uObsHi: THREE.IUniform<THREE.Vector3>;
  uObsLo: THREE.IUniform<THREE.Vector3>;
  uEpoch: THREE.IUniform<number>;
}

let sharedLUT: THREE.DataTexture | null = null;
let sharedLUTUsers = 0;

/**
 * All-sky background: stars and a diffuse Milky Way band with a dust rift, rendered at infinity (only
 * the camera's rotation matters). Call `render()` first in a frame, then clear depth and draw
 * foreground layers.
 *
 * Optional (additive) features for the Voyage explorer: the real HYG catalogue in 3D with parallax for
 * a moving observer (`setObserver`, parsecs), special-relativistic aberration, Doppler colour and
 * beaming for a moving observer (`setVelocity`, fraction of c) including the CMB becoming visible at
 * extreme Lorentz factors, proper motions over deep time (`setEpoch`), constellation figures and a
 * pre-exposure (`exposure`) for scenes with a huge dynamic range.
 */
export class Sky {
  readonly scene = new THREE.Scene();
  readonly group = new THREE.Group();
  private starMat: THREE.ShaderMaterial;
  private bandMat: THREE.ShaderMaterial;
  private stars: THREE.Points;
  private band: THREE.Mesh;
  private shared: SharedUniforms;
  private star3dMat: THREE.ShaderMaterial | null = null;
  private catalogPoints: THREE.Points | null = null;
  private proc3d = false;
  private cat: StarCatalog | null = null;
  private lines: ConstellationLines | null = null;
  private constellationOpacity: number;
  private opts: SkyOptions;
  private disposed = false;
  private fadeT = 1;
  private hide = new Int32Array(8).fill(-1);
  private observer = new THREE.Vector3();
  private observerGal = new THREE.Vector3();
  private velocity = new THREE.Vector3();
  private flags: RelativityFlags = { aberration: true, doppler: true, beaming: true };
  private epoch = 0;
  private invRot = new THREE.Matrix3();
  private tmpM4 = new THREE.Matrix4();
  private maxPointRadius = 0;
  private cmbScale = 0;
  /** The band baked into a cube map (galactic frame): state, target and the material that samples it. */
  private bandBake: 'pending' | 'done' | 'failed' | 'off' = 'pending';
  private bandCube: THREE.WebGLCubeRenderTarget | null = null;
  private bandMatBaked: THREE.ShaderMaterial | null = null;
  /**
   * Use the baked band once available (default). Set false to draw the procedural band every frame
   * (debug / A–B comparison); the bake is kept.
   */
  bakeBand = true;
  /** Resolves once the catalogue (if requested) is on the GPU. */
  readonly ready: Promise<void>;

  constructor(o: SkyOptions = {}) {
    this.opts = o;
    const frame = o.frame ?? 'galactic';
    const wantCatalog = o.catalog === 'auto' || o.catalog === undefined ? frame !== 'galactic' : !!o.catalog;
    this.constellationOpacity = o.constellations ?? 0;

    if (!sharedLUT) sharedLUT = createLuminanceLUT();
    sharedLUTUsers++;
    const { minT, maxT, size } = LUMINANCE_LUT;
    this.shared = {
      uBeta: { value: new THREE.Vector3() },
      uBetaMag: { value: 0 },
      uGamma: { value: 1 },
      uRelFlags: { value: new THREE.Vector3(1, 1, 1) },
      uLumLUT: { value: sharedLUT },
      uLumLUTRange: { value: new THREE.Vector3(Math.log(minT), Math.log(maxT), size) },
      uExposure: { value: o.exposure ?? 1 },
      uPixelRatio: { value: 1 },
      uObsHi: { value: new THREE.Vector3() },
      uObsLo: { value: new THREE.Vector3() },
      uEpoch: { value: 0 },
    };

    const catalog = typeof o.catalog === 'object' ? o.catalog : wantCatalog ? starCatalogIfLoaded() : null;
    // With the real catalogue the procedural field only fills in the stars fainter than V = 6.5
    // and lives in 3D so that it shows parallax as well.
    this.proc3d = wantCatalog;
    this.stars = this.buildProcedural(o, this.proc3d);
    this.starMat = this.stars.material as THREE.ShaderMaterial;

    // One uniforms object shared by the procedural and the baked band materials.
    const bandUniforms = {
      ...this.shared,
      uIntensity: { value: o.milkyWay ?? 1 },
      uSeed: { value: this.bandSeed },
      uSkyRotInv: { value: new THREE.Matrix3() },
      uCmbBeta: { value: new THREE.Vector3(1, 0, 0) },
      uCmbBetaMag: { value: 0 },
      uCmbGamma: { value: 1 },
      uCmbLogScale: { value: 0 },
      uCmbOn: { value: 0 },
      uBandTex: { value: null as THREE.Texture | null },
    };
    this.bandMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: BAND_VERT,
      fragmentShader: BAND_FRAG,
      uniforms: bandUniforms,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
    });
    if ((o.bandResolution ?? 1024) <= 0) this.bandBake = 'off';
    this.band = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 48), this.bandMat);
    this.band.frustumCulled = false;
    this.band.renderOrder = -2;
    this.stars.renderOrder = -1;
    this.band.visible = (o.milkyWay ?? 1) > 0;
    this.group.add(this.band, this.stars);
    this.group.matrixAutoUpdate = false;
    this.group.matrix.copy(skyFrameMatrix(frame));
    this.group.updateMatrixWorld(true);
    this.scene.add(this.group);

    if (catalog) {
      this.attachCatalog(catalog, false);
      this.ready = Promise.resolve();
    } else if (wantCatalog) {
      this.ready = loadStarCatalog().then(
        (c) => {
          if (!this.disposed) this.attachCatalog(c, true);
        },
        (err) => console.warn('Sky: star catalogue unavailable, using procedural stars', err),
      );
    } else {
      this.ready = Promise.resolve();
    }
  }

  private bandSeed = 0;

  private buildProcedural(o: SkyOptions, threeD: boolean): THREE.Points {
    const rng = new Rng(o.seed ?? 20250923);
    const count = Math.max(100, Math.floor(o.stars ?? 22000));
    const mMax = o.limitingMagnitude ?? 8.5;
    const mMin = threeD ? 6.5 : -1.5;
    const k = 0.8; // dN/dm ∝ e^{k m} ≈ 10^{0.35 m} (star counts)
    // In 3D mode keep the same sky density per magnitude as the full procedural sky.
    const n = threeD ? Math.max(100, Math.round(count * ((Math.exp(k * mMax) - Math.exp(k * mMin)) / (Math.exp(k * mMax) - Math.exp(k * -1.5))))) : count;
    const pos = new Float32Array(n * 3);
    const mags = new Float32Array(n);
    const temps = new Float32Array(n);
    const posLo = threeD ? new Float32Array(n * 3) : null;
    const vel = threeD ? new Float32Array(n * 3) : null;
    const e0 = Math.exp(k * mMin), e1 = Math.exp(k * mMax);
    for (let i = 0; i < n; i++) {
      const m = Math.log(e0 + rng.next() * (e1 - e0)) / k;
      // Fainter stars crowd the galactic plane more strongly.
      const scaleB = THREE.MathUtils.lerp(0.9, 0.18, THREE.MathUtils.clamp((m - 2) / 6.5, 0, 1));
      let sb: number;
      if (rng.next() < 0.3) sb = rng.range(-1, 1);
      else {
        const e = rng.exponential(scaleB) * (rng.next() < 0.5 ? -1 : 1);
        sb = Math.max(-1, Math.min(1, Math.sin(Math.atan(e))));
      }
      // Longitude: mild concentration toward the galactic centre for faint stars.
      let l = rng.range(-Math.PI, Math.PI);
      if (m > 5 && rng.next() < 0.35) l = rng.normal(0, 0.6);
      const cb = Math.sqrt(1 - sb * sb);
      let x = cb * Math.cos(l), y = sb, z = -cb * Math.sin(l);
      const u = rng.next();
      temps[i] =
        u < 0.08 ? rng.range(3000, 3900)
        : u < 0.32 ? rng.range(3900, 5200)
        : u < 0.52 ? rng.range(5200, 6000)
        : u < 0.72 ? rng.range(6000, 7500)
        : u < 0.9 ? rng.range(7500, 10000)
        : rng.range(10000, 28000);
      if (threeD) {
        // Place the star at a plausible distance: absolute magnitudes of 6.5–8.5 mag field stars
        // are mostly −1…+4, i.e. 50–1500 pc away (the parallax you see when you fly).
        const M = rng.range(-1.2, 4.2);
        const d = Math.pow(10, (m - M + 5) / 5);
        x *= d; y *= d; z *= d;
        mags[i] = M;
        const hx = Math.fround(x), hy = Math.fround(y), hz = Math.fround(z);
        posLo![i * 3] = x - hx;
        posLo![i * 3 + 1] = y - hy;
        posLo![i * 3 + 2] = z - hz;
      } else {
        mags[i] = m;
      }
      pos[i * 3] = x;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = z;
    }
    this.bandSeed = (rng.next() * 100) | 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('temp', new THREE.BufferAttribute(temps, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    let mat: THREE.ShaderMaterial;
    if (threeD) {
      g.setAttribute('absMag', new THREE.BufferAttribute(mags, 1));
      g.setAttribute('posLo', new THREE.BufferAttribute(posLo!, 3));
      g.setAttribute('vel', new THREE.BufferAttribute(vel!, 3));
      mat = this.makeStar3DMaterial(o, 1, this.noHide);
    } else {
      g.setAttribute('mag', new THREE.BufferAttribute(mags, 1));
      mat = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: STAR_VERT,
        fragmentShader: STAR_FRAG,
        uniforms: {
          ...this.shared,
          uSize: { value: o.starSize ?? 1 },
          uBrightness: { value: o.brightness ?? 1 },
          uSaturation: { value: 1.25 },
          uFade: { value: 1 },
        },
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
        transparent: true,
      });
    }
    const pts = new THREE.Points(g, mat);
    pts.frustumCulled = false;
    return pts;
  }

  private noHide = new Int32Array(8).fill(-1);

  private makeStar3DMaterial(o: SkyOptions, fade: number, hide: Int32Array): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: STAR3D_VERT,
      fragmentShader: STAR3D_FRAG,
      uniforms: {
        ...this.shared,
        uSize: { value: o.starSize ?? 1 },
        uBrightness: { value: o.brightness ?? 1 },
        uSaturation: { value: 1.25 },
        uFade: { value: fade },
        uMinDist: { value: 1e-3 },
        uMaxRadius: { value: 128 },
        uLimit: { value: 2.5e-3 },
        uHide: { value: hide },
      },
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
  }

  private attachCatalog(c: StarCatalog, fadeIn: boolean): void {
    this.cat = c;
    const n = c.count;
    const pos = new Float32Array(n * 3);
    const lo = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) {
      const v = c.position[i];
      const h = Math.fround(v);
      pos[i] = h;
      lo[i] = v - h;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('posLo', new THREE.BufferAttribute(lo, 3));
    g.setAttribute('vel', new THREE.BufferAttribute(c.velocity, 3));
    g.setAttribute('absMag', new THREE.BufferAttribute(new Float32Array(c.absMag), 1));
    g.setAttribute('temp', new THREE.BufferAttribute(new Float32Array(c.temperature), 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    this.star3dMat = this.makeStar3DMaterial(this.opts, fadeIn ? 0 : 1, this.hide);
    this.catalogPoints = new THREE.Points(g, this.star3dMat);
    this.catalogPoints.frustumCulled = false;
    this.catalogPoints.renderOrder = 0;
    this.group.add(this.catalogPoints);
    this.fadeT = fadeIn ? 0 : 1;
    this.lines = new ConstellationLines(c, this.shared);
    this.lines.opacity = this.constellationOpacity;
    this.lines.object.renderOrder = -1.5;
    this.group.add(this.lines.object);
  }

  /** Extra rotation applied after the frame matrix (e.g. to align with a scene). */
  setRotation(m: THREE.Matrix4, frame: SkyFrame = 'galactic'): void {
    this.group.matrix.copy(m).multiply(skyFrameMatrix(frame));
    this.group.matrixWorldNeedsUpdate = true;
    this.group.updateMatrixWorld(true);
    this.frameDirty = true;
  }

  set brightness(v: number) {
    this.starMat.uniforms.uBrightness.value = v;
    if (this.star3dMat) this.star3dMat.uniforms.uBrightness.value = v;
    this.opts = { ...this.opts, brightness: v };
  }
  set milkyWay(v: number) {
    this.bandMat.uniforms.uIntensity.value = v;
    this.band.visible = v > 0;
  }
  set starSize(v: number) {
    this.starMat.uniforms.uSize.value = v;
    if (this.star3dMat) this.star3dMat.uniforms.uSize.value = v;
    this.opts = { ...this.opts, starSize: v };
  }
  /** Pre-exposure multiplier for all sky radiance (1 = default calibration). */
  set exposure(v: number) {
    this.shared.uExposure.value = v;
  }
  get exposure(): number {
    return this.shared.uExposure.value;
  }
  /** Constellation figure opacity (0 hides them). */
  set constellations(v: number) {
    this.constellationOpacity = v;
    if (this.lines) this.lines.opacity = v;
  }
  get constellations(): number {
    return this.constellationOpacity;
  }
  /** The real star catalogue once loaded (null for procedural-only skies). */
  get catalog(): StarCatalog | null {
    return this.cat;
  }
  /** Constellation figures (null until the catalogue is attached). */
  get constellationLines(): ConstellationLines | null {
    return this.lines;
  }

  /** Observer position relative to the Sun, parsecs, in the sky's world frame (default: the origin). */
  setObserver(pc: THREE.Vector3): void {
    this.observer.copy(pc);
    this.frameDirty = true;
  }
  getObserver(out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(this.observer);
  }
  /** Observer velocity as a fraction of c in the world frame (|β| < 1). Zero = at rest (default). */
  setVelocity(beta: THREE.Vector3): void {
    this.velocity.copy(beta);
    const b = beta.length();
    if (b >= 1) this.velocity.multiplyScalar(0.999999999 / b);
  }
  getVelocity(out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(this.velocity);
  }
  setRelativity(f: Partial<RelativityFlags>): void {
    Object.assign(this.flags, f);
  }
  get relativity(): Readonly<RelativityFlags> {
    return this.flags;
  }
  /** Years since J2000 for stellar proper motions (deep time; linear motion, fine for ~±1 Myr nearby). */
  setEpoch(yearsSinceJ2000: number): void {
    this.epoch = yearsSinceJ2000;
  }
  get epochYears(): number {
    return this.epoch;
  }
  /** Hide up to 8 catalogue stars (e.g. ones drawn as resolved discs by the caller). */
  hideStars(indices: readonly number[]): void {
    this.hide.fill(-1);
    for (let i = 0; i < Math.min(8, indices.length); i++) this.hide[i] = indices[i];
  }
  /** Stars closer than this (pc) are not drawn as points (default 1e-3 pc ≈ 206 AU hides the Sun at home). */
  set minStarDistance(pc: number) {
    if (this.star3dMat) this.star3dMat.uniforms.uMinDist.value = pc;
    if (this.proc3d) this.starMat.uniforms.uMinDist.value = pc;
    this.minDist = pc;
  }
  private minDist = 1e-3;
  /** Override a catalogue star's temperature / absolute magnitude (e.g. curated modern values). */
  overrideStar(index: number, v: { temperature?: number; absMag?: number }): void {
    const g = this.catalogPoints?.geometry;
    if (!g || index < 0 || index >= (this.cat?.count ?? 0)) return;
    if (v.temperature !== undefined) {
      const a = g.getAttribute('temp') as THREE.BufferAttribute;
      a.setX(index, v.temperature);
      a.needsUpdate = true;
    }
    if (v.absMag !== undefined) {
      const a = g.getAttribute('absMag') as THREE.BufferAttribute;
      a.setX(index, v.absMag);
      a.needsUpdate = true;
    }
  }
  /** Current (possibly overridden) temperature and absolute magnitude of a catalogue star. */
  starProps(index: number): { temperature: number; absMag: number } {
    const g = this.catalogPoints?.geometry;
    if (!g) return { temperature: 5772, absMag: 4.83 };
    return { temperature: g.getAttribute('temp').getX(index), absMag: g.getAttribute('absMag').getX(index) };
  }

  /**
   * CPU mirror of the star shader: where and how bright catalogue star `index` appears to the observer.
   * Returns false if there is no catalogue.
   */
  apparent(index: number, out: ApparentStar): boolean {
    const c = this.cat;
    const g = this.catalogPoints?.geometry;
    if (!c || !g || index < 0 || index >= c.count) return false;
    const p = c.position, v = c.velocity;
    const t = this.epoch;
    const o = this.observerGal;
    // (called for every label and light each frame: no allocations, frame matrices cached)
    if (this.frameDirty) this.updateObserverGal();
    const rx = p[index * 3] + v[index * 3] * t - o.x;
    const ry = p[index * 3 + 1] + v[index * 3 + 1] * t - o.y;
    const rz = p[index * 3 + 2] + v[index * 3 + 2] * t - o.z;
    const d = Math.hypot(rx, ry, rz);
    out.distance = d;
    out.restDir.set(rx, ry, rz).applyMatrix4(this.tmpM4).normalize();
    const absMag = (g.getAttribute('absMag') as THREE.BufferAttribute).array[index];
    let m = absMag + 5 * (Math.log10(Math.max(d, 1e-12)) - 1);
    let T = (g.getAttribute('temp') as THREE.BufferAttribute).array[index];
    let delta = 1;
    if (this.velocity.lengthSq() > 1e-14) {
      delta = aberrateDirection(out.restDir, this.velocity, out.dir);
      if (!this.flags.aberration) out.dir.copy(out.restDir);
      const Tobs = T * delta;
      if (this.flags.beaming) m -= (2.5 / Math.LN10) * (logBlackbodyLuminance(Tobs) - logBlackbodyLuminance(T) - 2 * Math.log(delta));
      if (this.flags.doppler) T = Tobs;
    } else out.dir.copy(out.restDir);
    out.mag = m;
    out.temperature = T;
    out.delta = delta;
    return true;
  }

  private rotOnly(m: THREE.Matrix4): THREE.Matrix4 {
    return this.tmpM4.extractRotation(m);
  }
  /** Observer and frame rotation in the galactic frame; recomputed when the observer or frame moved. */
  private frameDirty = true;
  private updateObserverGal(): void {
    this.invRot.setFromMatrix4(this.group.matrix).transpose();
    this.observerGal.copy(this.observer).applyMatrix3(this.invRot);
    this.rotOnly(this.group.matrix);
    this.frameDirty = false;
  }

  /**
   * Bake the band into a cube map once (all six faces, one-time ≈ 6·N² band evaluations: ~30 ms on a
   * mid laptop GPU at N = 1024, spent while the experience fades in). Restores the caller's render
   * target (which may itself be a cube face, e.g. an environment probe).
   */
  private bakeBandCube(renderer: THREE.WebGLRenderer): void {
    this.bandBake = 'failed';
    const ext = renderer.extensions;
    if (!(ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float'))) return;
    const gl = renderer.getContext();
    const maxCube = gl.getParameter(gl.MAX_CUBE_MAP_TEXTURE_SIZE) as number;
    const size = Math.max(64, Math.min(this.opts.bandResolution ?? 1024, maxCube || 1024));
    const prevRT = renderer.getRenderTarget();
    const prevFace = renderer.getActiveCubeFace();
    const prevMip = renderer.getActiveMipmapLevel();
    const bakeMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: BAND_BAKE_FRAG,
      uniforms: { uSeed: { value: this.bandSeed }, uFace: { value: 0 }, uSize: { value: size } },
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bakeMat);
    quad.frustumCulled = false;
    const scene = new THREE.Scene().add(quad);
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    try {
      // Two half-float channels (4 B/texel: 25 MB at N = 1024); RGBA16F if RG16F is not renderable.
      for (const format of [THREE.RGFormat, THREE.RGBAFormat] as const) {
        const rt = new THREE.WebGLCubeRenderTarget(size, {
          type: THREE.HalfFloatType,
          format,
          generateMipmaps: false,
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
          depthBuffer: false,
          stencilBuffer: false,
        });
        renderer.setRenderTarget(rt, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
          this.bandCube = rt;
          break;
        }
        rt.dispose();
      }
      if (!this.bandCube) return;
      for (let face = 0; face < 6; face++) {
        bakeMat.uniforms.uFace.value = face;
        renderer.setRenderTarget(this.bandCube, face);
        renderer.render(scene, cam);
      }
      // Same uniforms object as the procedural material, so every setter drives both.
      this.bandMatBaked = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: BAND_VERT,
        fragmentShader: BAND_FRAG,
        uniforms: this.bandMat.uniforms,
        defines: { BAND_BAKED: 1 },
        side: THREE.BackSide,
        depthTest: false,
        depthWrite: false,
      });
      this.bandMat.uniforms.uBandTex.value = this.bandCube.texture;
      this.bandBake = 'done';
    } catch (e) {
      console.warn('Sky: Milky Way bake failed, drawing it procedurally', e);
      this.bandCube?.dispose();
      this.bandCube = null;
    } finally {
      renderer.setRenderTarget(prevRT, prevFace, prevMip);
      quad.geometry.dispose();
      bakeMat.dispose();
    }
  }

  /** Draw the sky into the currently bound render target using the camera's rotation. */
  render(renderer: THREE.WebGLRenderer, camera: THREE.Camera, pixelRatio = 1): void {
    if (this.bandBake === 'pending' && this.band.visible) this.bakeBandCube(renderer);
    const baked = this.bandBake === 'done' && this.bakeBand && this.bandMatBaked;
    const bandMat = baked ? this.bandMatBaked! : this.bandMat;
    if (this.band.material !== bandMat) this.band.material = bandMat;
    const s = this.shared;
    s.uPixelRatio.value = pixelRatio;
    if (!this.maxPointRadius) {
      const gl = renderer.getContext();
      const range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array | number[] | null;
      this.maxPointRadius = Math.max(16, Math.min(256, (range ? range[1] : 64) / 2));
    }
    // Observer (double-single split) in the galactic frame.
    this.updateObserverGal();
    const o = this.observerGal;
    const hx = Math.fround(o.x), hy = Math.fround(o.y), hz = Math.fround(o.z);
    s.uObsHi.value.set(hx, hy, hz);
    s.uObsLo.value.set(o.x - hx, o.y - hy, o.z - hz);
    s.uEpoch.value = this.epoch;
    // Relativity.
    const b = this.velocity.length();
    s.uBeta.value.copy(this.velocity);
    s.uBetaMag.value = b < 1e-7 ? 0 : b;
    s.uGamma.value = gammaOf(b);
    s.uRelFlags.value.set(this.flags.aberration ? 1 : 0, this.flags.doppler ? 1 : 0, this.flags.beaming ? 1 : 0);
    const bu = this.bandMat.uniforms;
    (bu.uSkyRotInv.value as THREE.Matrix3).copy(this.invRot);
    this.updateCmb(camera, b);
    if (this.star3dMat) {
      if (this.fadeT < 1) this.fadeT = Math.min(1, this.fadeT + 1 / 30);
      this.star3dMat.uniforms.uFade.value = this.fadeT * this.fadeT * (3 - 2 * this.fadeT);
      this.star3dMat.uniforms.uMaxRadius.value = this.maxPointRadius;
      this.star3dMat.uniforms.uMinDist.value = this.minDist;
      if (!this.proc3d) this.starMat.uniforms.uFade.value = 1;
    }
    if (this.proc3d) {
      this.starMat.uniforms.uMaxRadius.value = this.maxPointRadius;
      this.starMat.uniforms.uMinDist.value = Math.max(this.minDist, 1e-3);
    }
    this.lines?.update(camera);
    renderer.render(this.scene, camera);
  }

  /**
   * CMB: the observer's velocity relative to the CMB frame is β_obs ⊕ β_sun (Planck dipole). The CMB
   * only reaches visible temperatures ahead for γ ≳ 100; below that it is skipped entirely.
   */
  private updateCmb(camera: THREE.Camera, b: number): void {
    const bu = this.bandMat.uniforms;
    if (!this.flags.doppler || b < 0.9) {
      bu.uCmbOn.value = 0;
      return;
    }
    const sun = _sunCmb.copy(galacticLBToThree(SUN_CMB_DIPOLE.l, SUN_CMB_DIPOLE.b, _tmpV)).multiplyScalar(SUN_CMB_DIPOLE.speed / 299792458);
    sun.applyMatrix4(this.rotOnly(this.group.matrix));
    const rel = addVelocities(sun, this.velocity, _relCmb);
    const bc = Math.min(rel.length(), 1 - 1e-12);
    const tMax = T_CMB * Math.sqrt((1 + bc) / (1 - bc));
    if (tMax < 350) {
      bu.uCmbOn.value = 0;
      return;
    }
    bu.uCmbOn.value = 1;
    (bu.uCmbBeta.value as THREE.Vector3).copy(rel);
    bu.uCmbBetaMag.value = bc;
    bu.uCmbGamma.value = gammaOf(bc);
    // Display radiance of a 5772 K blackbody surface, consistent with the star sprites: the Sun
    // (V = −26.74) spread over its disc (959.63″ radius) at this camera's pixel scale.
    let pxAngle = 1e-3;
    if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
      const pc = camera as THREE.PerspectiveCamera;
      pxAngle = (2 * Math.tan(THREE.MathUtils.degToRad(pc.fov) / 2)) / Math.max(1, this.cssHeight);
    }
    const E = 3.17 * Math.pow(10, 0.4 * (26.74 + 1));
    const alpha = (959.63 / 206264.806) * 1;
    this.cmbScale = (E * pxAngle * pxAngle) / (Math.PI * alpha * alpha);
    bu.uCmbLogScale.value = Math.log10(this.cmbScale * this.shared.uExposure.value);
  }
  /** CSS height of the viewport (for the CMB's pixel-scale calibration). */
  cssHeight = 1080;

  dispose(): void {
    this.disposed = true;
    this.stars.geometry.dispose();
    this.band.geometry.dispose();
    this.starMat.dispose();
    this.bandMat.dispose();
    this.bandMatBaked?.dispose();
    this.bandCube?.dispose();
    this.bandCube = null;
    this.catalogPoints?.geometry.dispose();
    this.star3dMat?.dispose();
    this.lines?.dispose();
    sharedLUTUsers--;
    if (sharedLUTUsers <= 0 && sharedLUT) {
      sharedLUT.dispose();
      sharedLUT = null;
      sharedLUTUsers = 0;
    }
  }
}

const _sunCmb = new THREE.Vector3();
const _relCmb = new THREE.Vector3();
const _tmpV = new THREE.Vector3();

export { loadStarCatalog, type StarCatalog };
