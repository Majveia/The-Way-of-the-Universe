import * as THREE from 'three';
import { COMMON_GLSL } from '../../shaders/lib/common';

/**
 * Stray sunlight inside a narrow-angle camera pointed a degree or two from the Sun — the streaks
 * that cross Voyager 1's "Pale Blue Dot" frame (sunlight reflected within the camera optics; the
 * Earth happened to sit in one of them). Drawn additively into the HDR target in screen space:
 * a few soft bands running along the direction to the Sun, brighter toward it, with fine
 * striations. Outside the bands the output is exactly zero, so OLED black stays black.
 */
const VERT = /* glsl */ `
out vec2 vNdc;
void main() {
  vNdc = position.xy;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const FRAG = /* glsl */ `
precision highp float;
${COMMON_GLSL}
in vec2 vNdc;
out vec4 outColor;
uniform vec2 uSunDir;     // unit, screen space (aspect-corrected), toward the Sun
uniform vec2 uAnchor;     // screen point (aspect-corrected) a band passes through (the Earth)
uniform float uAspect;
uniform float uIntensity;
uniform vec3 uColor;
void main() {
  vec2 p = vec2(vNdc.x * uAspect, vNdc.y);
  vec2 q = p - uAnchor;
  vec2 perp = vec2(-uSunDir.y, uSunDir.x);
  float s = dot(q, perp);        // across the bands
  float a = dot(q, uSunDir);     // along the bands (toward the Sun = positive)
  // Band centres (screen units) and widths: one through the anchor, others to either side.
  float b = 0.0;
  b += 1.00 * exp(-sqr(s / 0.11));
  b += 0.45 * exp(-sqr((s - 0.58) / 0.08));
  b += 0.35 * exp(-sqr((s + 0.66) / 0.14));
  b += 0.18 * exp(-sqr((s - 1.15) / 0.07));
  // Faint striations along the bands (the camera's internal baffles).
  float st = 0.9 + 0.1 * sin(s * 97.0 + 1.3);
  // Gently brighter toward the Sun (outside the frame).
  float along = exp(clamp(a, -3.0, 3.0) * 0.3);
  float v = b * st * along;
  // Hard zero where the stray light is negligible.
  v = max(v - 0.02, 0.0);
  outColor = vec4(uColor * v * uIntensity, 1.0);
}`;

export class Sunbeam {
  readonly mesh: THREE.Mesh;
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private mat: THREE.ShaderMaterial;
  private geo: THREE.BufferGeometry;
  private v = new THREE.Vector3();
  private w = new THREE.Vector3();

  constructor() {
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uSunDir: { value: new THREE.Vector2(0, 1) },
        uAnchor: { value: new THREE.Vector2(0, 0) },
        uAspect: { value: 1 },
        uIntensity: { value: 0 },
        uColor: { value: new THREE.Vector3(1.0, 0.93, 0.84) },
      },
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  /**
   * @param intensity HDR radiance of the brightest band (0 disables).
   * @param sunWorld  Sun position (world); @param anchorWorld point a band passes through.
   */
  render(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, sunWorld: THREE.Vector3, anchorWorld: THREE.Vector3, intensity: number): void {
    if (intensity <= 0) return;
    const u = this.mat.uniforms;
    const aspect = camera.aspect;
    u.uAspect.value = aspect;
    u.uIntensity.value = intensity;
    // Screen-space direction toward the Sun: project a point slightly toward it (works when the
    // Sun itself is outside the frame or behind the camera).
    const a = this.v.copy(anchorWorld).project(camera);
    const ax = a.x, ay = a.y;
    const fwd = this.v.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const dirToSun = this.w.copy(sunWorld).sub(camera.position).normalize();
    // Keep the probe point in front of the camera.
    if (dirToSun.dot(fwd) <= 0.05) return;
    const sp = dirToSun.multiplyScalar(camera.position.distanceTo(anchorWorld)).add(camera.position).project(camera);
    const dx = (sp.x - ax) * aspect;
    const dy = sp.y - ay;
    const len = Math.hypot(dx, dy) || 1;
    u.uSunDir.value.set(dx / len, dy / len);
    u.uAnchor.value.set(ax * aspect, ay);
    renderer.render(this.scene, this.cam);
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
