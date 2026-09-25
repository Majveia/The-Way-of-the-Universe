import * as THREE from 'three';
import { cieXYZ, xyzToLinearSRGB } from '../../physics/blackbody';
import { LINES } from '../../physics/spectrum';
import { COMMON_GLSL } from '../../shaders/lib/common';
import { NOISE_GLSL } from '../../shaders/lib/noise';
import { BLACKBODY_GLSL } from '../../shaders/lib/blackbody';

/**
 * The drive plume: an optically thin, ray-marched emission volume behind the ring drive.
 *
 * Physics of the look: the exhaust of a hydrogen fusion torch leaves a magnetic nozzle as a fully
 * ionised jet. Near the throat it is hot and dense — a blue-white continuum; further out the plasma
 * cools and recombines, and the light is dominated by the Balmer lines in their case-B recombination
 * ratios (Hα : Hβ : Hγ : Hδ ≈ 2.86 : 1 : 0.47 : 0.26, Osterbrock & Ferland 2006) — the pink-violet of
 * glowing hydrogen. In vacuum the jet expands freely at a fixed divergence: there are no shock diamonds
 * (those need ambient pressure). Emissivity ∝ n² is modelled with Gaussian radial profiles whose width
 * grows linearly with distance, and exponential decay along the jet.
 */
export function balmerColor(): THREE.Color {
  const lines: Array<[number, number]> = [
    [LINES.H_ALPHA, 2.86],
    [LINES.H_BETA, 1],
    [LINES.H_GAMMA, 0.468],
    [410.17, 0.259],
  ];
  let X = 0, Y = 0, Z = 0;
  for (const [nm, f] of lines) {
    const [x, y, z] = cieXYZ(nm);
    X += f * x;
    Y += f * y;
    Z += f * z;
  }
  let [r, g, b] = xyzToLinearSRGB(X / Y, 1, Z / Y);
  const m = Math.min(r, g, b);
  if (m < 0) {
    const t = -m / (1 - m);
    r += (1 - r) * t;
    g += (1 - g) * t;
    b += (1 - b) * t;
  }
  return new THREE.Color(r, g, b);
}

const VERT = /* glsl */ `
out vec3 vPosL;
void main() {
  vPosL = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */ `
precision highp float;
${COMMON_GLSL}
${NOISE_GLSL}
${BLACKBODY_GLSL}
in vec3 vPosL;
out vec4 outColor;
uniform vec3 uCamL;      // camera position in plume-local coordinates
uniform float uLen;      // plume length (m)
uniform float uR0;       // radius at the exit
uniform float uDiv;      // tan(half-angle)
uniform float uThrust;
uniform float uTime;
uniform float uExposure;
uniform vec3 uBalmer;
uniform float uSteps;
uniform float uGain;
uniform float uOctaves;
uniform vec3 uMesh;      // bounding mesh: radius at z = 0, radius at z = length, length
// Plume axis: +Z from z = 0 (throat exit). Jet radius (a cone of half-angle atan(uDiv)):
float width(float z) { return uR0 + uDiv * max(z, 0.0); }

vec3 emissivity(vec3 p) {
  float z = p.z;
  if (z < 0.0 || z > uLen) return vec3(0.0);
  float w = width(z);
  float r2 = dot(p.xy, p.xy);
  float zn = z / uLen;
  // Hot core: a narrow, bright blue-white spine that fades within the first third.
  float wc = 0.28 * w;
  float core = exp(-r2 / (2.0 * wc * wc)) * exp(-zn * 9.0) * (1.0 / (wc * wc));
  // Recombining envelope: Balmer glow, broader and longer.
  float we = 0.27 * w;
  float env = exp(-r2 / (2.0 * we * we)) * exp(-zn * 4.5) * (1.0 / (we * we));
  // Gentle turbulence advected downstream (instabilities in the expanding jet); the finer octave
  // only on the high tier.
  float n = snoise(vec3(p.xy * 1.3 / w, z * 0.18 - uTime * 6.0)) * 0.5;
  if (uOctaves > 1.5) n += snoise(vec3(p.xy * 3.1 / w, z * 0.5 - uTime * 11.0)) * 0.25;
  env *= 0.75 + 0.45 * n;
  env *= 1.0 - smoothstep(0.6 * w, w, sqrt(r2)); // nothing at the bounding surface — no visible edge
  core *= 0.9 + 0.15 * n;
  // Throat flare: the magnetic nozzle's hottest point.
  float throat = exp(-r2 / (2.0 * 0.25 * uR0 * uR0)) * exp(-z * 1.8) * 3.0;
  vec3 cCore = blackbody(16000.0) * 1.2;
  // The envelope is a mix of Balmer recombination lines and free–free (bremsstrahlung) continuum,
  // which dominates while the jet is still hot: pale violet-blue rather than a saturated neon pink.
  vec3 cEnv = mix(blackbody(14000.0), uBalmer, 0.45 * smoothstep(0.05, 0.6, zn));
  return uGain * (cCore * (core * 1.6 + throat) + cEnv * env * 0.9);
}

void main() {
  // Ray from the camera through this fragment, in plume-local space.
  vec3 ro = uCamL;
  vec3 rd = normalize(vPosL - uCamL);
  // Only one of the bounding mesh's two faces contributes: the front face, or the back face when the
  // camera is inside the (closed, convex) mesh.
  float meshR = uMesh.x + (uMesh.y - uMesh.x) * clamp(ro.z / uMesh.z, 0.0, 1.0);
  bool inside = dot(ro.xy, ro.xy) < meshR * meshR && ro.z > 0.0 && ro.z < uMesh.z;
  if (gl_FrontFacing == inside) discard;
  // Exact interval inside the jet cone r ≤ R0 + k z (the emission vanishes outside it), clipped to
  // 0 < z < uLen. The cone's interior on the nappe z > −R0/k is convex, so this is one interval.
  // Quadratic Q(t) = A t² + 2B t + C ≤ 0.
  float k = uDiv;
  float w0 = uR0 + k * ro.z;
  float A = dot(rd.xy, rd.xy) - k * k * rd.z * rd.z;
  float B = dot(ro.xy, rd.xy) - k * w0 * rd.z;
  float C = dot(ro.xy, ro.xy) - w0 * w0;
  float disc = B * B - A * C;
  float t0 = 0.0, t1 = 1e9;
  if (abs(A) < 1e-7) {
    if (abs(B) < 1e-9) { if (C > 0.0) discard; }
    else if (B > 0.0) t1 = -C / (2.0 * B);
    else t0 = -C / (2.0 * B);
  } else if (A > 0.0) {
    if (disc < 0.0) discard;
    float h = sqrt(disc);
    t0 = (-B - h) / A;
    t1 = (-B + h) / A;
  } else {
    // Steeper than the cone: inside for t ≤ tLo or t ≥ tHi; the half toward +z is our nappe.
    float h = sqrt(max(disc, 0.0));
    float tLo = (-B + h) / A, tHi = (-B - h) / A;
    if (rd.z > 0.0) t0 = tHi; else t1 = tLo;
  }
  if (abs(rd.z) > 1e-9) {
    float z0 = (0.0 - ro.z) / rd.z, z1 = (uLen - ro.z) / rd.z;
    t0 = max(t0, min(z0, z1));
    t1 = min(t1, max(z0, z1));
  } else if (ro.z < 0.0 || ro.z > uLen) discard;
  t0 = max(t0, 0.0);
  if (t1 <= t0) discard;
  // Steps: about four per local jet width along the chord (a Gaussian profile of σ ≈ 0.27 w needs
  // no more), capped by the tier's budget.
  float zMid = ro.z + rd.z * 0.5 * (t0 + t1);
  float steps = clamp(ceil((t1 - t0) / (0.25 * width(zMid))), 6.0, uSteps);
  float dt = (t1 - t0) / steps;
  float j = ign(gl_FragCoord.xy + fract(uTime * 7.1) * 97.0);
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 48; i++) {
    if (float(i) >= steps) break;
    vec3 p = ro + rd * (t0 + (float(i) + j) * dt);
    acc += emissivity(p);
  }
  acc *= dt * uThrust * uExposure;
  outColor = vec4(min(acc, vec3(6.0e4)), 1.0);
}`;

export class EnginePlume {
  readonly object: THREE.Mesh;
  readonly color: THREE.Color;
  private mat: THREE.ShaderMaterial;
  private camL = new THREE.Vector3();
  private inv = new THREE.Matrix4();
  private _thrust = 0;
  time = 0;
  exposure = 1;
  pixelRatio = 1;
  /** Radiant strength used by the hull's engine light (arbitrary display units per unit thrust). */
  readonly brightness = 1.2;
  private maxLen = 60;

  constructor(nozzle: THREE.Vector3, radius: number, steps = 28) {
    this.color = balmerColor();
    const R = radius * 0.62;
    const div = Math.tan(THREE.MathUtils.degToRad(3.5));
    const Rmax = R + div * this.maxLen;
    // Bounding cone (open cylinder frustum) along +Z starting at the throat exit.
    const g = new THREE.CylinderGeometry(R * 1.3, Rmax * 1.05, this.maxLen, 32, 1, false);
    g.rotateX(-Math.PI / 2); // cylinder axis +Y → −Z: the narrow top ends up at the nozzle after the shift
    g.translate(0, 0, this.maxLen / 2);
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uCamL: { value: new THREE.Vector3() },
        uLen: { value: this.maxLen },
        uR0: { value: R },
        uDiv: { value: div },
        uThrust: { value: 0 },
        uTime: { value: 0 },
        uExposure: { value: 1 },
        uBalmer: { value: this.color },
        uSteps: { value: steps },
        uGain: { value: 0.032 },
        uOctaves: { value: 2 },
        uMesh: { value: new THREE.Vector3(R * 1.3, Rmax * 1.05, this.maxLen) },
      },
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      transparent: true,
    });
    this.object = new THREE.Mesh(g, this.mat);
    this.object.position.set(nozzle.x, nozzle.y, nozzle.z + 0.95);
    this.object.frustumCulled = false;
    this.object.onBeforeRender = (_r, _s, camera) => this.beforeRender(camera);
    this.object.visible = false;
  }

  /** Engine output 0..1 (the plume is hidden at zero thrust). */
  set thrust(t: number) {
    this._thrust = t;
    this.object.visible = t > 0.002;
  }
  get thrust(): number {
    return this._thrust;
  }

  /** Overall emissivity scale (display units). */
  set gain(g: number) {
    this.mat.uniforms.uGain.value = g;
  }

  /** Maximum ray-march samples per pixel (the march takes ~4 per jet width along the ray, at least 6). */
  set steps(n: number) {
    this.mat.uniforms.uSteps.value = n;
  }

  /** Turbulence octaves (1 or 2): the finer octave doubles the noise cost per sample. */
  set octaves(n: number) {
    this.mat.uniforms.uOctaves.value = n;
  }

  private beforeRender(camera: THREE.Camera): void {
    const u = this.mat.uniforms;
    this.object.updateMatrixWorld();
    this.inv.copy(this.object.matrixWorld).invert();
    this.camL.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(this.inv);
    (u.uCamL.value as THREE.Vector3).copy(this.camL);
    const t = THREE.MathUtils.clamp(this._thrust, 0, 1);
    u.uThrust.value = t * 1.4;
    u.uLen.value = this.maxLen * (0.25 + 0.75 * Math.sqrt(t));
    u.uTime.value = this.time;
    u.uExposure.value = this.exposure;
  }

  dispose(): void {
    this.object.geometry.dispose();
    this.mat.dispose();
  }
}
