/**
 * Orbit lines for every body in ONE instanced draw call.
 *
 * Each orbit is an analytic conic evaluated on the GPU *relative to its body* with the
 * cancellation-free difference formulas
 *   ellipse:   r(E) − r(E_b) = −2a sin(E_b + Δ/2) sin(Δ/2) P̂ + 2b cos(E_b + Δ/2) sin(Δ/2) Q̂
 *   hyperbola: r(H) − r(H_b) = −2a sinh(H_b + Δ/2) sinh(Δ/2) P̂ + 2b cosh(H_b + Δ/2) sinh(Δ/2) Q̂
 * so the line passes exactly through the body with float32 precision from Phobos to Sedna.
 * Vertices are concentrated near the body (Δ ∝ |u|^1.7). Segments are expanded to anti-aliased
 * screen-space quads (1–1.5 px), clipped against the near plane in view space, and faded along
 * the orbit (a comet-like trail behind the body) and near the body (lines emerge from it).
 * Per-orbit parameters live in a float texture (8 texels × MAX_ORBITS).
 */
import * as THREE from 'three';
import { OCCLUDE_GLSL } from './glsl';

export const MAX_ORBITS = 128;
const SEGMENTS = 720;
const TEXELS = 6;

const VERT = /* glsl */ `
precision highp float;
precision highp sampler2D;
in vec2 aSeg;
in float aOrbit;
uniform sampler2D uData;
uniform vec2 uViewport;
uniform float uWidth;
uniform float uNear;
out vec3 vColor;
out float vSide;
out float vHalf;
out vec3 vRel;

vec4 T(int k, int o) { return texelFetch(uData, ivec2(k, o), 0); }

// Offset of the conic point at parameter u (−1..1) from the body; returns (offset, Δ).
vec4 conicOffset(float u, int o, out float alongFade) {
  vec4 t0 = T(0, o), t1 = T(1, o), t2 = T(2, o), t4 = T(4, o);
  vec3 P = t0.xyz; float a = t0.w;
  vec3 Q = t1.xyz; float b = t1.w;
  float Eb = t2.w;
  float hyper = t4.y;
  float range = u < 0.0 ? t4.z : t4.w;
  float d = range * pow(abs(u), 1.7);
  float h = 0.5 * d;
  vec3 off;
  if (hyper < 0.5) {
    float s = sin(h);
    off = P * (-2.0 * a * sin(Eb + h) * s) + Q * (2.0 * b * cos(Eb + h) * s);
  } else {
    float s = sinh(h);
    off = P * (-2.0 * a * sinh(Eb + h) * s) + Q * (2.0 * b * cosh(Eb + h) * s);
  }
  // Along-orbit shaping: bright trail behind the body, dimmer ahead.
  float tr = T(5, o).z;
  float span = max(abs(t4.z), abs(t4.w));
  float x = abs(d) / max(span, 1e-6);
  alongFade = tr <= 0.0 ? 1.0 : d < 0.0 ? mix(0.22, 1.0, exp(-x * tr * 3.2)) : mix(0.22, 0.6, exp(-x * tr * 9.0));
  return vec4(off, d);
}

void main() {
  int o = int(aOrbit + 0.5);
  vec4 t3 = T(3, o);
  vec4 t5 = T(5, o);
  vec3 bodyRel = T(2, o).xyz;
  float alpha = t3.w;
  vColor = vec3(0.0);
  vSide = 0.0;
  vHalf = 1.0;
  vRel = vec3(0.0);
  if (alpha <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float f0, f1;
  vec4 o0 = conicOffset(aSeg.x, o, f0);
  vec4 o1 = conicOffset(aSeg.y, o, f1);
  vec3 w0 = bodyRel + o0.xyz;
  vec3 w1 = bodyRel + o1.xyz;
  vec4 v0 = modelViewMatrix * vec4(w0, 1.0);
  vec4 v1 = modelViewMatrix * vec4(w1, 1.0);
  float nz = -uNear;
  if (v0.z > nz && v1.z > nz) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  if (v0.z > nz) { float t = (nz - v0.z) / (v1.z - v0.z); v0 = mix(v0, v1, t); w0 = mix(w0, w1, t); }
  if (v1.z > nz) { float t = (nz - v1.z) / (v0.z - v1.z); v1 = mix(v1, v0, t); w1 = mix(w1, w0, t); }
  vec4 c0 = projectionMatrix * v0;
  vec4 c1 = projectionMatrix * v1;
  vec2 s0 = c0.xy / c0.w * 0.5 * uViewport;
  vec2 s1 = c1.xy / c1.w * 0.5 * uViewport;
  vec2 dir = s1 - s0;
  float len = length(dir);
  dir = len > 1e-6 ? dir / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  bool end = position.x > 0.5;
  vec4 c = end ? c1 : c0;
  float hw = 0.5 * uWidth + 1.0;
  vec2 offPx = nrm * position.y * hw;
  gl_Position = c + vec4(offPx / (0.5 * uViewport) * c.w, 0.0, 0.0);
  // Near-body fade: the line emerges from the body instead of crossing its disc.
  float rb = t5.x;
  float dist = length(end ? o1.xyz : o0.xyz);
  float nearFade = smoothstep(rb * 2.5, rb * 18.0, dist);
  float along = end ? f1 : f0;
  vColor = t3.rgb * alpha * along * nearFade;
  vSide = position.y * hw;
  vHalf = 0.5 * uWidth;
  vRel = end ? w1 : w0;
}`;

const FRAG = /* glsl */ `
precision highp float;
${OCCLUDE_GLSL}
in vec3 vColor;
in float vSide;
in float vHalf;
in vec3 vRel;
out vec4 outColor;
void main() {
  float cov = clamp(vHalf + 0.5 - abs(vSide), 0.0, 1.0);
  if (cov <= 0.0 || occlusion(vRel) > 0.5) discard;
  outColor = vec4(vColor * cov, 1.0);
}`;

export interface OrbitSlot {
  /** Unit vectors toward pericentre and 90° ahead (three.js frame). */
  P: THREE.Vector3;
  Q: THREE.Vector3;
  a: number;
  b: number;
  e: number;
  hyperbolic: boolean;
  /** Current eccentric/hyperbolic anomaly of the body. */
  anomaly: number;
  /** Parameter range behind/ahead of the body (≤ 0, ≥ 0). */
  rangeBack: number;
  rangeAhead: number;
  /** Body position relative to the camera (AU, float64 → uploaded as float32). */
  bodyRel: THREE.Vector3;
  /** Linear colour (display, will be multiplied by alpha). */
  color: THREE.Color;
  alpha: number;
  /** Rendered radius of the body (AU) for the near-body fade. */
  bodyRadius: number;
  /** Trail sharpness (1 = default). */
  trail: number;
}

export class OrbitLines {
  readonly object: THREE.Mesh;
  private data: Float32Array;
  private tex: THREE.DataTexture;
  private mat: THREE.ShaderMaterial;
  private geo: THREE.InstancedBufferGeometry;
  private used = 0;

  constructor(shared: Record<string, THREE.IUniform>) {
    this.data = new Float32Array(TEXELS * MAX_ORBITS * 4);
    this.tex = new THREE.DataTexture(this.data, TEXELS, MAX_ORBITS, THREE.RGBAFormat, THREE.FloatType);
    this.tex.minFilter = THREE.NearestFilter;
    this.tex.magFilter = THREE.NearestFilter;
    this.tex.needsUpdate = true;
    const g = new THREE.InstancedBufferGeometry();
    // Quad: x = endpoint (0/1), y = side (−1/1).
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, -1, 0, 0, 1, 0, 1, -1, 0, 1, 1, 0]), 3));
    g.setIndex([0, 2, 1, 1, 2, 3]);
    const seg = new Float32Array(MAX_ORBITS * SEGMENTS * 2);
    const orb = new Float32Array(MAX_ORBITS * SEGMENTS);
    for (let o = 0; o < MAX_ORBITS; o++) {
      for (let s = 0; s < SEGMENTS; s++) {
        const k = o * SEGMENTS + s;
        seg[k * 2] = -1 + (2 * s) / SEGMENTS;
        seg[k * 2 + 1] = -1 + (2 * (s + 1)) / SEGMENTS;
        orb[k] = o;
      }
    }
    g.setAttribute('aSeg', new THREE.InstancedBufferAttribute(seg, 2));
    g.setAttribute('aOrbit', new THREE.InstancedBufferAttribute(orb, 1));
    g.instanceCount = 0;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e12);
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uData: { value: this.tex },
        uViewport: { value: new THREE.Vector2(1, 1) },
        uWidth: { value: 1.1 },
        uNear: { value: 1e-9 },
        ...shared,
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      // MAX blending: overlapping segment quads (and crossing orbits) never double-count.
      blending: THREE.CustomBlending,
      blendEquation: THREE.MaxEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    });
    this.object = new THREE.Mesh(g, this.mat);
    this.object.frustumCulled = false;
    this.object.renderOrder = 2;
  }

  /** Write slot i. Call `commit(n)` after filling slots 0..n-1. */
  set(i: number, s: OrbitSlot): void {
    const d = this.data;
    const o = i * TEXELS * 4;
    d[o] = s.P.x; d[o + 1] = s.P.y; d[o + 2] = s.P.z; d[o + 3] = s.a;
    d[o + 4] = s.Q.x; d[o + 5] = s.Q.y; d[o + 6] = s.Q.z; d[o + 7] = s.b;
    d[o + 8] = s.bodyRel.x; d[o + 9] = s.bodyRel.y; d[o + 10] = s.bodyRel.z; d[o + 11] = s.anomaly;
    d[o + 12] = s.color.r; d[o + 13] = s.color.g; d[o + 14] = s.color.b; d[o + 15] = s.alpha;
    d[o + 16] = s.e; d[o + 17] = s.hyperbolic ? 1 : 0; d[o + 18] = s.rangeBack; d[o + 19] = s.rangeAhead;
    d[o + 20] = s.bodyRadius; d[o + 21] = 0; d[o + 22] = s.trail; d[o + 23] = 0;
  }

  /** Disable slot i. */
  hide(i: number): void {
    this.data[i * TEXELS * 4 + 15] = 0;
  }

  commit(count: number): void {
    this.used = Math.min(MAX_ORBITS, count);
    this.geo.instanceCount = this.used * SEGMENTS;
    this.tex.needsUpdate = true;
  }

  setViewport(w: number, h: number, pixelRatio: number): void {
    this.mat.uniforms.uViewport.value.set(w, h);
    this.mat.uniforms.uWidth.value = Math.max(1, 1.05 * pixelRatio);
  }

  /** Near-plane distance used for line clipping (set per depth slice). */
  set near(v: number) {
    this.mat.uniforms.uNear.value = v;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
    this.tex.dispose();
  }
}
