/**
 * A small-body population drawn as GPU points that move on their own Kepler orbits.
 *
 * Vertex shader: M = M0 + n·t (+ resonant libration), Kepler's equation by Newton iteration,
 * rotation Rz(Ω)Rx(i)Rz(ω). Brightness follows the physical reflected flux
 * F ∝ p·D²·Φ(α)/(r²Δ²) (Lambert-sphere phase law), compressed with a power law so faint
 * members stay visible; colour from taxonomy. Unresolved members are PSF points; once an
 * asteroid spans more than ~1.5 px it becomes a lit, irregular impostor (Lommel–Seeliger).
 *
 * `eccentricity` (0..1) scales every e: at 0 each body sits on a circle at its semi-major axis,
 * which is the only view in which the Kirkwood gaps (gaps in *orbital period*) become visible.
 * Time is re-based on the CPU every few thousand days so float32 stays smooth at any date.
 */
import * as THREE from 'three';
import { KEPLER_GLSL, OCCLUDE_GLSL, PHOTOMETRY_GLSL, PSF_GLSL } from './glsl';
import { BELT_EPOCH, TAXON_COLOR, type Population } from '../belts';
import { COMMON_GLSL } from '../../../shaders/lib/common';

const VERT = /* glsl */ `
precision highp float;
${KEPLER_GLSL}
${PHOTOMETRY_GLSL}
${OCCLUDE_GLSL}
in vec4 aOrbA;
in vec4 aOrbB;
in vec4 aPhys;
uniform float uT;
uniform float uLibOmega;
uniform float uEcc;
uniform float uFlat;
uniform float uPixelAngle;
uniform float uPixelRatio;
uniform float uBright;
uniform float uFluxRef;
uniform float uGamma;
uniform float uMaxSize;
uniform vec3 uTaxon[9];
uniform ivec4 uHide[4];
uniform float uFade;
out vec3 vColor;
out float vRadiusPx;
out float vSizePx;
out vec3 vSunDir;
out float vSeed;

void main() {
  vColor = vec3(0.0);
  vRadiusPx = 0.0;
  vSizePx = 1.0;
  vSunDir = vec3(0.0, 0.0, 1.0);
  vSeed = float(gl_VertexID);
  for (int k = 0; k < 4; k++) {
    if (any(equal(uHide[k], ivec4(gl_VertexID)))) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  }
  float M = aOrbB.y + aOrbB.z * uT;
  if (aOrbB.w != 0.0) M += aOrbB.w * sin(aPhys.w + uLibOmega * uT);
  M = wrapPi(M);
  float e = aOrbA.y * uEcc;
  float E = solveKeplerE(M, e);
  vec3 h = orbitPoint(aOrbA.x, e, aOrbA.z * uFlat, aOrbA.w, aOrbB.x, E);
  if (occlusion((modelMatrix * vec4(h, 1.0)).xyz) > 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  vec4 mv = modelViewMatrix * vec4(h, 1.0);
  gl_Position = projectionMatrix * mv;
  // Geometry for photometry (view space): sun at the object origin.
  vec3 sunV = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vec3 toSun = sunV - mv.xyz;
  float r = length(toSun);
  float dist = length(mv.xyz);
  float cosA = dot(normalize(toSun), normalize(-mv.xyz));
  float phase = lambertPhase(acos(clamp(cosA, -1.0, 1.0)));
  float Dau = aPhys.x * 6.6845871e-9;
  float flux = aPhys.y * Dau * Dau * max(phase, 0.02) / (r * r * dist * dist);
  float I = uBright * pow(flux / uFluxRef, uGamma) * uFade;
  float radPx = 0.5 * Dau / max(dist, 1e-12) / uPixelAngle;
  vRadiusPx = radPx * uPixelRatio;
  float size = clamp(2.0 * vRadiusPx + 5.0 * uPixelRatio, 3.0 * uPixelRatio, uMaxSize);
  gl_PointSize = size;
  vSizePx = size;
  vec3 tint = uTaxon[int(aPhys.z + 0.5)];
  vColor = tint * min(I, 40.0);
  vSunDir = normalize(toSun);
}`;

const FRAG = /* glsl */ `
precision highp float;
${COMMON_GLSL}
${PSF_GLSL}
${PHOTOMETRY_GLSL}
in vec3 vColor;
in float vRadiusPx;
in float vSizePx;
in vec3 vSunDir;
in float vSeed;
uniform float uPixelRatio;
out vec4 outColor;
void main() {
  vec2 q = (gl_PointCoord - 0.5) * vSizePx; // device pixels from the centre
  q.y = -q.y;
  float sigma = 0.62 * uPixelRatio;
  // Unresolved: PSF carrying the whole flux. Resolved (> 1.5 px): a lit irregular impostor.
  float res = smoothstep(1.2 * uPixelRatio, 2.5 * uPixelRatio, vRadiusPx);
  vec3 col = vec3(0.0);
  if (res < 1.0) {
    col += vColor * psf(q, sigma) * (1.0 - res);
  }
  if (res > 0.0) {
    float ang = atan(q.y, q.x);
    float wob = 1.0 + 0.16 * sin(ang * 2.0 + vSeed) + 0.07 * sin(ang * 5.0 + vSeed * 1.7);
    float R = vRadiusPx * wob;
    float d = length(q) / max(R, 1e-3);
    if (d < 1.0) {
      vec3 n = vec3(q / max(R, 1e-3), sqrt(max(1.0 - d * d, 0.0)));
      n = normalize(n + 0.25 * (hash33(floor(vec3(q * 3.0 / max(R, 1.0), vSeed))) - 0.5));
      float mu0 = dot(n, vSunDir);
      float mu = n.z;
      float ls = lommelSeeliger(max(mu0, 0.0), mu) * 2.0;
      float aa = clamp(1.0 - (length(q) - R + 0.5), 0.0, 1.0);
      // Flux-conserving surface brightness: total ≈ vColor spread over the disc.
      col += vColor * ls / (3.14159 * R * R) * aa * res;
    }
  }
  if (max(col.r, max(col.g, col.b)) < 1e-6) discard;
  outColor = vec4(col, 1.0);
}`;

export interface BeltStyle {
  /** Display intensity multiplier. */
  brightness: number;
  /** Compression exponent on the physical flux (1 = linear). */
  gamma: number;
  /** Reference flux (display 1): p·D²·Φ/(r²Δ²) in AU units. */
  fluxRef: number;
}

export class BeltPoints {
  readonly object: THREE.Points;
  readonly pop: Population;
  private mat: THREE.ShaderMaterial;
  private geo: THREE.BufferGeometry;
  private epoch = BELT_EPOCH;
  private hideInts = new Int32Array(16).fill(-1);

  constructor(pop: Population, style: BeltStyle, boundRadius: number, shared: Record<string, THREE.IUniform>) {
    this.pop = pop;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pop.count * 3), 3));
    g.setAttribute('aOrbA', new THREE.BufferAttribute(pop.orbitA.subarray(0, pop.count * 4), 4));
    g.setAttribute('aOrbB', new THREE.BufferAttribute(pop.orbitB.subarray(0, pop.count * 4), 4));
    g.setAttribute('aPhys', new THREE.BufferAttribute(pop.phys.subarray(0, pop.count * 4), 4));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), boundRadius);
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uT: { value: 0 },
        uLibOmega: { value: pop.libOmega },
        uEcc: { value: 1 },
        uFlat: { value: 1 },
        uPixelAngle: { value: 1e-3 },
        uPixelRatio: { value: 1 },
        uBright: { value: style.brightness },
        uFluxRef: { value: style.fluxRef },
        uGamma: { value: style.gamma },
        uMaxSize: { value: 64 },
        uTaxon: { value: TAXON_COLOR.map((c) => new THREE.Vector3(c[0], c[1], c[2])) },
        uHide: { value: this.hideInts },
        uFade: { value: 1 },
        ...shared,
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.object = new THREE.Points(g, this.mat);
    this.object.renderOrder = 1;
  }

  /** Re-base M0 (and libration phases) to a new epoch in float64 so the GPU time stays small. */
  private rebase(jd: number): void {
    const p = this.pop;
    const dt = jd - BELT_EPOCH;
    const TAU = Math.PI * 2;
    for (let k = 0; k < p.count; k++) {
      let m = (p.M0[k] + p.n[k] * dt) % TAU;
      if (m < 0) m += TAU;
      p.orbitB[k * 4 + 1] = m;
      if (p.orbitB[k * 4 + 3] !== 0) p.phys[k * 4 + 3] = (p.libPhase[k] + p.libOmega * dt) % TAU;
    }
    this.geo.getAttribute('aOrbB').needsUpdate = true;
    this.geo.getAttribute('aPhys').needsUpdate = true;
    this.epoch = jd;
  }

  /**
   * @param jd TT Julian date
   * @param sunRel Sun position relative to the camera (AU)
   */
  update(jd: number, sunRel: THREE.Vector3, pixelAngle: number, pixelRatio: number, maxPointSize: number): void {
    if (Math.abs(jd - this.epoch) > 2000) this.rebase(jd);
    this.object.position.copy(sunRel);
    const u = this.mat.uniforms;
    u.uT.value = jd - this.epoch;
    u.uPixelAngle.value = pixelAngle;
    u.uPixelRatio.value = pixelRatio;
    u.uMaxSize.value = maxPointSize;
  }

  set eccentricity(v: number) {
    this.mat.uniforms.uEcc.value = v;
  }
  get eccentricity(): number {
    return this.mat.uniforms.uEcc.value;
  }
  set flatten(v: number) {
    this.mat.uniforms.uFlat.value = v;
  }
  set brightness(v: number) {
    this.mat.uniforms.uBright.value = v;
  }
  set fade(v: number) {
    this.mat.uniforms.uFade.value = v;
    this.object.visible = v > 0.002;
  }
  get fade(): number {
    return this.mat.uniforms.uFade.value;
  }

  /** Hide up to 16 members (drawn as meshes by the caller). */
  setHidden(ids: readonly number[]): void {
    this.hideInts.fill(-1);
    for (let i = 0; i < Math.min(16, ids.length); i++) this.hideInts[i] = ids[i];
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
