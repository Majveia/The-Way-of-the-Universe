import * as THREE from 'three';
import { BLACKBODY_GLSL } from '../../shaders/lib/blackbody';
import { TRACER_WIDTH } from './scenario';

/**
 * Draws the tracer particles of an NBodySystem as additive, energy-conserving sprites in linear HDR.
 *
 * Photometry: each particle carries a stellar mass (weight) and an age; its luminosity follows a
 * simple stellar-population fading law, M/L ≈ 3 (t / 10 Gyr)^0.8 (V band, roughly Bruzual &
 * Charlot 2003), and its colour a blackbody at T ≈ 4500 K (t / 10 Gyr)^−0.18. A sprite of world
 * radius h at distance d covers (2hP/d)² pixels (P = pixels per radian); spreading the flux
 * L/(4πd²) over it gives a pixel value ∝ L/h², independent of distance — surface brightness is
 * conserved, as for real extended sources. Below the pixel scale sprites keep a minimum size and
 * fade as point sources (flux ∝ 1/d²) instead of flickering.
 */
const VERT = /* glsl */ `
${BLACKBODY_GLSL}
uniform sampler2D tPos;
uniform sampler2D tVel;
uniform sampler2D tAttr;
uniform int uWidth;
uniform float uTime;
uniform float uExtrap;
uniform float uProj;
uniform float uExposure;
uniform float uMinPx;
uniform float uMaxPx;
out vec3 vColor;
float massToLight(float ageMyr) {
  return 3.0 * pow(clamp(ageMyr, 3.0, 13000.0) / 10000.0, 0.8);
}
float popTemp(float ageMyr) {
  return clamp(4500.0 * pow(clamp(ageMyr, 3.0, 13000.0) / 10000.0, -0.18), 3600.0, 32000.0);
}
void main() {
  int id = gl_VertexID;
  ivec2 t = ivec2(id % uWidth, id / uWidth);
  vec4 p = texelFetch(tPos, t, 0);
  vec4 v = texelFetch(tVel, t, 0);
  vec4 a = texelFetch(tAttr, t, 0);
  vec3 x = p.xyz + v.xyz * uExtrap;
  vec4 mv = modelViewMatrix * vec4(x, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = max(-mv.z, 1e-3);
  int kind = int(a.x + 0.5);
  float h;
  float L;
  vec3 col;
  if (kind == 0) {
    h = 0.22;
    L = a.w / massToLight(a.z + uTime);
    col = blackbody(4300.0);
  } else if (kind == 1) {
    float age = a.z + uTime;
    h = 0.16;
    L = a.w / massToLight(age);
    col = blackbody(popTemp(age));
  } else {
    // Gas: shines only while its latest starburst is young (clusters + HII region).
    float tb = uTime - p.w;
    h = 0.14;
    float sf = 0.06 * a.w;
    L = tb < 400.0 ? sf / massToLight(max(tb, 3.0)) : 0.0;
    col = mix(vec3(1.0, 0.32, 0.55), blackbody(popTemp(tb + 3.0)), smoothstep(2.0, 12.0, tb));
  }
  float sizePx = clamp(2.0 * h * uProj / d, uMinPx, uMaxPx);
  gl_PointSize = sizePx;
  // Flux conservation: pixel value = L P² / (d² sizePx²) (normalised kernel in the fragment shader).
  vColor = col * (L * uExposure * uProj * uProj / (d * d * sizePx * sizePx));
  if (L <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;

const FRAG = /* glsl */ `
in vec3 vColor;
out vec4 outColor;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(q, q);
  if (r2 > 1.0) discard;
  // Gaussian kernel normalised over the sprite square: ∫ e^{-4r²} over the unit disk = 0.7706 (radius units).
  float k = exp(-4.0 * r2) * (4.0 / 0.7706);
  outColor = vec4(vColor * k, 1.0);
}`;

export interface GalaxyRendererOptions {
  count: number;
  exposure?: number;
}

export class GalaxyRenderer {
  readonly points: THREE.Points;
  readonly material: THREE.ShaderMaterial;
  private geometry: THREE.BufferGeometry;

  constructor(o: GalaxyRendererOptions) {
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setDrawRange(0, o.count);
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        tPos: { value: null },
        tVel: { value: null },
        tAttr: { value: null },
        uWidth: { value: TRACER_WIDTH },
        uTime: { value: 0 },
        uExtrap: { value: 0 },
        uProj: { value: 1000 },
        uExposure: { value: o.exposure ?? 1 },
        uMinPx: { value: 1.5 },
        uMaxPx: { value: 64 },
      },
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
  }

  /** Bind the latest simulation textures and view parameters. */
  update(p: {
    pos: THREE.Texture;
    vel: THREE.Texture;
    attr: THREE.Texture;
    time: number;
    extrapolate: number;
    camera: THREE.PerspectiveCamera;
    heightPx: number;
    pixelRatio: number;
  }): void {
    const u = this.material.uniforms;
    u.tPos.value = p.pos;
    u.tVel.value = p.vel;
    u.tAttr.value = p.attr;
    u.uTime.value = p.time;
    u.uExtrap.value = p.extrapolate;
    u.uProj.value = p.heightPx / (2 * Math.tan((p.camera.fov * Math.PI) / 360));
    u.uMinPx.value = 1.5 * p.pixelRatio;
    u.uMaxPx.value = 96 * p.pixelRatio;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
