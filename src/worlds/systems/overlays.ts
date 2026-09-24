import * as THREE from 'three';
import type { OrbitalElements } from '../../physics/kepler';
import { solveKepler } from '../../physics/kepler';

/**
 * Thin, emissive overlays for the system view: orbit lines with a fading trail behind each planet,
 * and the habitable zone / snow line drawn in the reference plane. All geometry is stored in true
 * AU (three.js frame) and remapped in the vertex/fragment shader by the radial display mapping
 * r' = r^γ (γ = 1: true distances), so toggling the compression animates without rebuilding.
 */

export const MAP_GLSL = /* glsl */ `
uniform float uGamma;
vec3 mapRadial(vec3 p) {
  float r = length(p);
  return r > 0.0 ? p * pow(r, uGamma - 1.0) : p;
}`;

const ORBIT_VERT = /* glsl */ `
${MAP_GLSL}
in float aPhase;
out float vPhase;
void main() {
  vPhase = aPhase;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(mapRadial(position), 1.0);
}`;

const ORBIT_FRAG = /* glsl */ `
precision highp float;
in float vPhase;
out vec4 outColor;
uniform float uPlanetPhase;
uniform vec3 uColor;
uniform float uBase;
uniform float uTrail;
void main() {
  // Mean-anomaly distance behind the planet (0 at the planet, → 1 a full orbit behind).
  float behind = fract(uPlanetPhase - vPhase);
  float trail = pow(1.0 - behind, 6.0);
  outColor = vec4(uColor * (uBase + uTrail * trail), 1.0);
}`;

/** Sample an orbit uniformly in eccentric anomaly; three.js frame (astro x,y,z → x,z,−y), AU. */
function orbitGeometry(el: OrbitalElements, segments: number): THREE.BufferGeometry {
  const pos = new Float32Array((segments + 1) * 3);
  const ph = new Float32Array(segments + 1);
  const cO = Math.cos(el.node), sO = Math.sin(el.node);
  const ci = Math.cos(el.i), si = Math.sin(el.i);
  const cw = Math.cos(el.peri), sw = Math.sin(el.peri);
  const b = el.a * Math.sqrt(1 - el.e * el.e);
  for (let k = 0; k <= segments; k++) {
    const E = (k / segments) * 2 * Math.PI;
    const x = el.a * (Math.cos(E) - el.e);
    const y = b * Math.sin(E);
    const X = (cO * cw - sO * sw * ci) * x + (-cO * sw - sO * cw * ci) * y;
    const Y = (sO * cw + cO * sw * ci) * x + (-sO * sw + cO * cw * ci) * y;
    const Z = sw * si * x + cw * si * y;
    pos[k * 3] = X;
    pos[k * 3 + 1] = Z;
    pos[k * 3 + 2] = -Y;
    const M = E - el.e * Math.sin(E);
    ph[k] = M / (2 * Math.PI);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aPhase', new THREE.BufferAttribute(ph, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return g;
}

export class OrbitLine {
  readonly line: THREE.Line;
  readonly material: THREE.ShaderMaterial;
  constructor(el: OrbitalElements, gamma: THREE.IUniform<number>, color: THREE.Color, segments = 384) {
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: ORBIT_VERT,
      fragmentShader: ORBIT_FRAG,
      uniforms: {
        uGamma: gamma,
        uPlanetPhase: { value: 0 },
        uColor: { value: new THREE.Vector3(color.r, color.g, color.b) },
        uBase: { value: 0.18 },
        uTrail: { value: 0.9 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.line = new THREE.Line(orbitGeometry(el, segments), this.material);
    this.line.frustumCulled = false;
  }
  /** Mean anomaly of the body now, as a fraction of an orbit. */
  setPhase(meanAnomaly: number): void {
    this.material.uniforms.uPlanetPhase.value = meanAnomaly / (2 * Math.PI);
  }
  setStyle(color: THREE.Color, base: number, trail: number): void {
    (this.material.uniforms.uColor.value as THREE.Vector3).set(color.r, color.g, color.b);
    this.material.uniforms.uBase.value = base;
    this.material.uniforms.uTrail.value = trail;
  }
  dispose(): void {
    this.line.geometry.dispose();
    this.material.dispose();
  }
}

/** Mean anomaly now (rad) for elements with epoch 0 and time t in the same units as n. */
export const meanAnomalyAt = (el: OrbitalElements, n: number, t: number) => el.M0 + n * (t - el.epoch);
export { solveKepler };

const ZONE_VERT = /* glsl */ `
out vec2 vP;
void main() {
  vP = (modelMatrix * vec4(position, 1.0)).xz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const ZONE_FRAG = /* glsl */ `
precision highp float;
in vec2 vP;
out vec4 outColor;
uniform float uGamma;
uniform vec4 uHZ;        // recentVenus, runaway, maxGreenhouse, earlyMars (AU)
uniform float uSnow;     // AU
uniform float uCleared;  // AU (engulfed region for evolved hosts), 0 = none
uniform vec3 uHZColor;
uniform vec3 uSnowColor;
uniform float uHZOn;
uniform float uSnowOn;
float band(float r, float a, float b, float soft) {
  return smoothstep(a - soft, a + soft, r) * (1.0 - smoothstep(b - soft, b + soft, r));
}
void main() {
  float rd = length(vP);                     // displayed (mapped) radius
  float r = pow(max(rd, 1e-9), 1.0 / uGamma); // true radius, AU
  float aa = fwidth(rd);
  // Conservative HZ (runaway → maximum greenhouse) with soft optimistic wings.
  float soft = 0.06 * uHZ.y;
  float cons = band(r, uHZ.y, uHZ.z, soft);
  float opt = band(r, uHZ.x, uHZ.w, soft) - cons;
  // Faint radial texture: the zone is warmest at its inner edge.
  float t = clamp((r - uHZ.x) / max(uHZ.w - uHZ.x, 1e-6), 0.0, 1.0);
  vec3 col = uHZColor * (cons * (0.2 + 0.2 * (1.0 - t)) + opt * 0.05) * uHZOn;
  // Edge hairlines of the conservative zone.
  float rIn = pow(uHZ.y, uGamma), rOut = pow(uHZ.z, uGamma);
  float line = (1.0 - smoothstep(0.0, 1.2 * aa, abs(rd - rIn))) + (1.0 - smoothstep(0.0, 1.2 * aa, abs(rd - rOut)));
  col += uHZColor * line * 1.6 * uHZOn;
  // Snow line: a dotted hairline.
  float rs = pow(uSnow, uGamma);
  float ang = atan(vP.y, vP.x);
  float dots = step(0.5, fract(ang * 90.0 / 6.2831853));
  float sl = (1.0 - smoothstep(0.0, 1.2 * aa, abs(rd - rs))) * dots;
  col += uSnowColor * sl * uSnowOn;
  // Engulfed region of a red giant / white dwarf progenitor: a faint dashed boundary.
  if (uCleared > 0.0) {
    float rc = pow(uCleared, uGamma);
    float dash = step(0.6, fract(ang * 48.0 / 6.2831853));
    col += vec3(1.0, 0.45, 0.25) * 0.5 * (1.0 - smoothstep(0.0, 1.2 * aa, abs(rd - rc))) * dash;
  }
  if (dot(col, col) < 1e-12) discard;
  outColor = vec4(col, 1.0);
}`;

export class ZoneDisk {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  constructor(hz: [number, number, number, number], snow: number, cleared: number, gamma: THREE.IUniform<number>) {
    const extent = 1;
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: ZONE_VERT,
      fragmentShader: ZONE_FRAG,
      uniforms: {
        uGamma: gamma,
        uHZ: { value: new THREE.Vector4(...hz) },
        uSnow: { value: snow },
        uCleared: { value: cleared },
        // Linear radiance: a faint green-teal (chlorophyll-free; just "water can be liquid here").
        uHZColor: { value: new THREE.Vector3(0.012, 0.05, 0.034) },
        uSnowColor: { value: new THREE.Vector3(0.06, 0.08, 0.11) },
        uHZOn: { value: 1 },
        uSnowOn: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2 * extent, 2 * extent), this.material);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.frustumCulled = false;
  }
  /** Size the quad to cover `displayRadius` (mapped units). */
  setExtent(displayRadius: number): void {
    this.mesh.scale.setScalar(displayRadius);
  }
  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
