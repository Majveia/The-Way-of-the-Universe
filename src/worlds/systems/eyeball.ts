import * as THREE from 'three';
import { NOISE_GLSL } from '../../shaders/lib/noise';
import { COMMON_GLSL } from '../../shaders/lib/common';

/**
 * "Eyeball" ice for a synchronously rotating temperate world (Pierrehumbert 2011, ApJL 726, L8):
 * the substellar hemisphere keeps open water while ice covers the rest. The planet renderer's ice
 * follows latitude (spin axis), so this thin shell draws the star-fixed ice sheet. It is rendered
 * *before* the planet's atmosphere (renderOrder −1) so the air still reddens and scatters over it.
 *
 * The open-water radius follows a simple energy balance: water stays liquid where the local
 * absorbed flux S cos θ (1−A) exceeds that needed for ~271 K; for our planets this gives a pupil
 * of 30–70° half-angle (warmer worlds: wider eyes).
 */
const VERT = /* glsl */ `
out vec3 vN;
out vec3 vW;
void main() {
  vN = normalize(mat3(modelMatrix) * position);
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const FRAG = /* glsl */ `
precision highp float;
${COMMON_GLSL}
${NOISE_GLSL}
in vec3 vN;
in vec3 vW;
out vec4 outColor;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uCosOpen;
uniform float uSeed;
void main() {
  vec3 n = normalize(vN);
  vec3 S = normalize(uSunDir);
  vec3 T = normalize(abs(S.y) < 0.95 ? cross(S, vec3(0.0, 1.0, 0.0)) : cross(S, vec3(1.0, 0.0, 0.0)));
  vec3 B = cross(S, T);
  // Star-fixed coordinates: the ice edge does not slide as the planet orbits.
  vec3 q = vec3(dot(n, S), dot(n, T), dot(n, B));
  float mu = q.x;
  float edge = uCosOpen + 0.09 * fbm3(q * 3.2 + uSeed, 4) + 0.035 * snoise(q * 11.0 + uSeed);
  float ice = smoothstep(edge + 0.012, edge - 0.03, mu);
  // Sea ice thins toward the pupil: grey-blue floes, then bright sheet ice.
  float floes = smoothstep(edge - 0.1, edge - 0.01, mu) * (0.6 + 0.4 * snoise(q * 40.0 + uSeed));
  // Wind-scoured sheet ice: bright snow, blue glacial ice where the snow is stripped, pressure ridges.
  float scour = smoothstep(0.1, 0.6, fbm3(q * 14.0 + uSeed * 2.0, 4));
  float ridge = pow(1.0 - abs(snoise(q * 60.0 + uSeed)), 12.0);
  vec3 snow = vec3(0.9, 0.93, 0.97);
  vec3 blueIce = vec3(0.55, 0.72, 0.86);
  vec3 alb = mix(snow, blueIce, scour * 0.55) * (1.0 - 0.15 * ridge);
  alb = mix(alb, vec3(0.5, 0.6, 0.68), floes * 0.8);
  // Snow/ice: Lambertian with a gentle forward lobe.
  float lit = max(mu, 0.0);
  vec3 col = alb * lit * uSunColor;
  if (ice < 0.002) discard;
  outColor = vec4(col, ice * 0.97);
}`;

export class EyeballIce {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  constructor(openHalfAngle: number, seed: number) {
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uSunDir: { value: new THREE.Vector3(1, 0, 0) },
        uSunColor: { value: new THREE.Vector3(1, 1, 1) },
        uCosOpen: { value: Math.cos(openHalfAngle) },
        uSeed: { value: (seed % 97) * 0.37 },
      },
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1.0015, 24), this.mat);
    this.mesh.renderOrder = -1;
    this.mesh.name = 'eyeball-ice';
  }
  update(sunDirWorld: THREE.Vector3, sunColor: THREE.Color): void {
    (this.mat.uniforms.uSunDir.value as THREE.Vector3).copy(sunDirWorld);
    (this.mat.uniforms.uSunColor.value as THREE.Vector3).set(sunColor.r, sunColor.g, sunColor.b);
  }
  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}

/**
 * Open-water half-angle (rad) for an eyeball world. With weak heat transport the sub-stellar
 * temperature is ≈ √2 T_eq (plus some greenhouse warming); water stays open where the local
 * temperature T_ss cos^¼ θ exceeds 271 K: cos θ > (271 / T_ss)⁴.
 */
export function eyeballOpening(teq: number): number {
  const Tss = Math.SQRT2 * teq + 15;
  const c = Math.pow(271 / Tss, 4);
  return Math.acos(Math.min(0.94, Math.max(0.35, c)));
}
