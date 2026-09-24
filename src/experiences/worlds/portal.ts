import * as THREE from 'three';
import { COMMON_GLSL } from '../../shaders/lib/common';
import { NOISE_GLSL } from '../../shaders/lib/noise';
import { lineColor } from '../../physics/planets-photometry';

/**
 * The portal: a swirling green vortex that opens over the old system, carries us through a short
 * tunnel, and irises open on the new one. Its green is the 557.7 nm forbidden line of atomic
 * oxygen (the aurora's green) — a wink, but a physical colour.
 *
 * Drawn as a full-screen pass over the HDR target, premultiplied: inside the annulus
 * [inner, outer] the portal replaces the scene; its rims add light outside it.
 * Radii are in units of the half-diagonal of the screen (1 = corners).
 */

const VERT = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const FRAG = /* glsl */ `
precision highp float;
${COMMON_GLSL}
${NOISE_GLSL}
in vec2 vUv;
out vec4 outColor;
uniform float uOuter;
uniform float uInner;
uniform float uTime;
uniform float uAspect;
uniform float uIntensity;
uniform vec3 uGreen;
uniform vec2 uCentre;
void main() {
  vec2 p = (vUv - 0.5 - uCentre) * vec2(uAspect, 1.0) * 2.0;
  float diag = length(vec2(uAspect, 1.0));
  float d = length(p) / diag;
  float ang = atan(p.y, p.x);
  vec2 cs = vec2(cos(ang), sin(ang));
  // Living edges.
  float wob = 0.035 * snoise(vec3(cs * 1.7, uTime * 0.7)) + 0.012 * snoise(vec3(cs * 6.0, uTime * 1.9));
  float outer = uOuter * (1.0 + wob);
  float inner = uInner * (1.0 - wob * 0.8);
  float aa = 1.5 / (diag * 540.0);
  float inside = smoothstep(outer + aa, outer - aa, d) * smoothstep(inner - aa, inner + aa, d);

  // Logarithmic spiral coordinates: arms wind inward and rotate.
  float r = d / max(uOuter, 1e-3);
  float lr = log(max(r, 1e-3));
  float swirl = ang + 2.6 * lr + uTime * 1.6;
  vec2 sp = vec2(cos(swirl), sin(swirl));
  float n = fbm3(vec3(sp * 1.4, lr * 1.3 - uTime * 0.9), 5) * 0.5 + 0.5;
  float fil = pow(1.0 - abs(snoise(vec3(sp * 2.4, lr * 2.2 - uTime * 1.4))), 16.0) * smoothstep(0.35, 0.75, n);
  float fil2 = pow(1.0 - abs(snoise(vec3(sp * 6.0 + 3.1, lr * 4.0 - uTime * 2.1))), 24.0);
  float depth = smoothstep(0.05, 1.0, r);                 // the throat recedes into darkness…
  float core = exp(-r * 9.0);                             // …toward a pale far opening
  // Mostly dark, with luminous gas streaming along the spiral: OLED-friendly, not a green wall.
  // Filaments thin out toward the throat so the centre stays black until the iris opens.
  float wall = smoothstep(0.12, 0.7, r);
  vec3 col = uGreen * (0.001 + 0.05 * pow(n, 5.0)) * depth;
  col += uGreen * (fil * 0.3 + fil2 * 0.14) * wall * (0.3 + 0.7 * depth);
  col += mix(uGreen, vec3(1.0), 0.5) * exp(-r * 40.0) * 0.8;
  col *= uIntensity;

  // Rims: a thin hot edge and a soft halo (they add light over the scene as well).
  float rimO = uOuter > 0.001 ? exp(-abs(d - outer) / 0.004) * 1.4 + exp(-abs(d - outer) / 0.04) * 0.18 : 0.0;
  float rimI = uInner > 0.001 ? exp(-abs(d - inner) / 0.004) * 1.4 + exp(-abs(d - inner) / 0.04) * 0.18 : 0.0;
  float flick = 0.85 + 0.15 * snoise(vec3(cs * 4.0, uTime * 3.0));
  vec3 rim = mix(uGreen, vec3(1.0), 0.25) * (rimO + rimI) * flick * uIntensity;

  outColor = vec4(col * inside + rim, inside);
}`;

export class Portal {
  private mat: THREE.ShaderMaterial;
  private mesh: THREE.Mesh;
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  outer = 0;
  inner = 0;

  constructor() {
    const g = lineColor(557.73);
    const y = 0.2126 * g[0] + 0.7152 * g[1] + 0.0722 * g[2];
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uOuter: { value: 0 },
        uInner: { value: 0 },
        uTime: { value: 0 },
        uAspect: { value: 16 / 9 },
        uIntensity: { value: 1.6 },
        uGreen: { value: new THREE.Vector3(g[0] / y, g[1] / y, g[2] / y) },
        uCentre: { value: new THREE.Vector2(0, 0) },
      },
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  get active(): boolean {
    return this.outer > 0.0005 && this.inner < 1.3;
  }

  render(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget, time: number, intensity = 1.6): void {
    if (!this.active) return;
    const u = this.mat.uniforms;
    u.uOuter.value = this.outer;
    u.uInner.value = this.inner;
    u.uTime.value = time;
    u.uAspect.value = target.width / Math.max(1, target.height);
    u.uIntensity.value = intensity;
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.cam);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}
