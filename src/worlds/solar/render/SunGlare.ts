/**
 * The Sun's glare: the wide wings of an optical point-spread function (scattering in the eye or in
 * a camera lens, I(θ) ∝ θ⁻²…θ⁻³ far from the core — cf. Vos et al. 1976 on the human PSF). A
 * screen-aligned quad centred on the Sun, sized in pixels, faded when a body covers the Sun's centre.
 * The Post bloom handles the near halo; this adds the long, soft wings that give the Sun presence.
 */
import * as THREE from 'three';
import { OCCLUDE_GLSL } from './glsl';

const VERT = /* glsl */ `
precision highp float;
${OCCLUDE_GLSL}
uniform vec3 uCenter;     // camera-relative position of the Sun
uniform float uRadiusPx;  // quad half-size in device pixels
uniform vec2 uViewport;
out vec2 vPx;
out float vVis;
void main() {
  vec4 c = projectionMatrix * viewMatrix * vec4(uCenter, 1.0);
  vVis = (c.w > 0.0 && occlusion(uCenter) < 0.5) ? 1.0 : 0.0;
  vPx = position.xy * uRadiusPx;
  vec2 ndc = c.xy / c.w + position.xy * uRadiusPx / (0.5 * uViewport);
  gl_Position = vec4(ndc, 0.0, 1.0);
  if (vVis < 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;

const FRAG = /* glsl */ `
precision highp float;
in vec2 vPx;
in float vVis;
uniform vec3 uColor;
uniform float uCorePx;
uniform float uRadiusPx;
out vec4 outColor;
void main() {
  float r = length(vPx);
  float x = r / uCorePx;
  // Two-component wing: a θ⁻² inner glow and a broad θ⁻¹·⁵ aureole, softly windowed at the quad edge.
  float wing = 1.0 / (1.0 + x * x) + 0.08 / pow(1.0 + x, 1.5);
  float win = 1.0 - smoothstep(0.55, 1.0, r / uRadiusPx);
  vec3 col = uColor * wing * win * vVis;
  if (max(col.r, max(col.g, col.b)) < 1e-6) discard;
  outColor = vec4(col, 1.0);
}`;

export class SunGlare {
  readonly object: THREE.Mesh;
  private mat: THREE.ShaderMaterial;

  constructor(shared: Record<string, THREE.IUniform>) {
    const g = new THREE.PlaneGeometry(2, 2);
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uCenter: { value: new THREE.Vector3() },
        uRadiusPx: { value: 300 },
        uCorePx: { value: 6 },
        uViewport: { value: new THREE.Vector2(1, 1) },
        uColor: { value: new THREE.Color() },
        ...shared,
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.object = new THREE.Mesh(g, this.mat);
    this.object.frustumCulled = false;
    this.object.renderOrder = 0;
  }

  /** @param sunRel camera-relative Sun position; strength in display units; corePx/radiusPx device px. */
  update(sunRel: THREE.Vector3, rgb: readonly [number, number, number], strength: number, corePx: number, radiusPx: number, w: number, h: number): void {
    const u = this.mat.uniforms;
    u.uCenter.value.copy(sunRel);
    u.uCorePx.value = corePx;
    u.uRadiusPx.value = radiusPx;
    u.uViewport.value.set(w, h);
    u.uColor.value.setRGB(rgb[0] * strength, rgb[1] * strength, rgb[2] * strength);
    this.object.visible = strength > 1e-5;
  }

  dispose(): void {
    this.object.geometry.dispose();
    this.mat.dispose();
  }
}
