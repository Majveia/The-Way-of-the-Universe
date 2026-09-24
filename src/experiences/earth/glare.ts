import * as THREE from 'three';
import { COMMON_GLSL } from '../../shaders/lib/common';

/**
 * Veiling glare of the Sun in the camera: light scattered by the optics around a very bright point
 * source. Profile ∝ (1 + (r/r₀)²)^(−3/2) (a Moffat-like PSF wing) with six faint diffraction spikes
 * from a hexagonal aperture. It lives in the lens, so it is drawn after the scene, in screen space,
 * scaled by how much of the Sun is actually visible (hidden behind the Earth → no glare). Exactly zero
 * beyond its radius, so black space stays black.
 */
const VERT = /* glsl */ `
uniform vec2 uCentre;   // NDC
uniform float uSize;    // half-size in screen heights
uniform float uAspect;
out vec2 vQ;
void main() {
  vQ = position.xy;
  vec2 p = uCentre + position.xy * uSize * vec2(1.0 / uAspect, 1.0) * 2.0;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const FRAG = /* glsl */ `
precision highp float;
${COMMON_GLSL}
in vec2 vQ;
out vec4 outColor;
uniform float uIntensity;
uniform vec3 uColor;
void main() {
  float r = length(vQ);             // 0..1 over the quad
  if (r >= 1.0) discard;
  float r0 = 0.012;
  float halo = pow(1.0 + sqr(r / r0), -1.5);
  float wide = 0.02 * pow(1.0 + sqr(r / 0.12), -1.5);
  float a = atan(vQ.y, vQ.x);
  float spikes = pow(abs(cos(3.0 * a + 0.3)), 400.0) * 0.012 * pow(1.0 + r / 0.02, -1.2);
  float v = halo + wide + spikes;
  // Fade to exactly zero at the quad edge.
  v = max(v - 0.0012, 0.0) * (1.0 - smoothstep(0.8, 1.0, r));
  outColor = vec4(uColor * v * uIntensity, 1.0);
}`;

export class SunGlare {
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private mat: THREE.ShaderMaterial;
  private geo = new THREE.PlaneGeometry(2, 2);
  private v = new THREE.Vector3();
  private w = new THREE.Vector3();

  constructor() {
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uCentre: { value: new THREE.Vector2() },
        uSize: { value: 0.45 },
        uAspect: { value: 1 },
        uIntensity: { value: 0 },
        uColor: { value: new THREE.Vector3(1.0, 0.97, 0.92) },
      },
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: THREE.AdditiveBlending,
    });
    const m = new THREE.Mesh(this.geo, this.mat);
    m.frustumCulled = false;
    this.scene.add(m);
  }

  /**
   * Fraction of the solar disk visible from `eye`, given spherical occluders (centre, radius).
   * Smooth in the separation of the two disks (limb darkening ignored).
   */
  static visibility(eye: THREE.Vector3, sun: THREE.Vector3, sunRadius: number, occluders: ReadonlyArray<{ c: THREE.Vector3; r: number }>, tmp = new THREE.Vector3()): number {
    const ds = tmp.copy(sun).sub(eye);
    const dist = ds.length();
    const angSun = Math.asin(Math.min(1, sunRadius / dist));
    const sx = ds.x / dist, sy = ds.y / dist, sz = ds.z / dist;
    let vis = 1;
    for (const o of occluders) {
      const ox = o.c.x - eye.x, oy = o.c.y - eye.y, oz = o.c.z - eye.z;
      const od = Math.hypot(ox, oy, oz);
      if (od <= o.r) return 0;
      if (od > dist) continue;
      const angOcc = Math.asin(o.r / od);
      const sep = Math.acos(Math.max(-1, Math.min(1, (ox * sx + oy * sy + oz * sz) / od)));
      // Covered fraction ramps from 0 (disks touching) to full (sun disk inside the occluder).
      const t = (angOcc + angSun - sep) / (2 * angSun);
      const cover = Math.max(0, Math.min(1, t));
      vis *= 1 - cover * cover * (3 - 2 * cover);
    }
    return vis;
  }

  render(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, sunWorld: THREE.Vector3, intensity: number): void {
    if (intensity <= 1e-4) return;
    const fwd = this.w.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const dir = this.v.copy(sunWorld).sub(camera.position).normalize();
    if (dir.dot(fwd) <= 0.02) return;
    const p = this.v.copy(sunWorld).project(camera);
    if (Math.abs(p.x) > 1.6 || Math.abs(p.y) > 1.6) return;
    const u = this.mat.uniforms;
    u.uCentre.value.set(p.x, p.y);
    u.uAspect.value = camera.aspect;
    u.uIntensity.value = intensity;
    renderer.render(this.scene, this.cam);
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
