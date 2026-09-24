import * as THREE from 'three';
import { FullscreenQuad, FULLSCREEN_VERT } from '../../core/post/FullscreenQuad';
import { G_GAL, type PotentialComponent } from '../../physics/galaxyPotential';
import { STRIDE } from './model';
import { GALAXY_COMMON_GLSL, GALAXY_PARTICLE_GLSL, GALAXY_UNIFORMS_GLSL } from './shaders/galaxyGlsl';

/**
 * The dark-matter demonstration: at the moment the halo is removed every star keeps its position
 * and velocity (taken from its analytic orbit by a central difference), and from then on moves
 * under gravity alone in the remaining (baryonic) potential. Orbits are integrated on the GPU with
 * the symplectic kick–drift–kick leapfrog (Binney & Tremaine 2008 §3.4.1), several sub-steps per
 * frame, in a ping-pong pair of float render targets (position, velocity) — the GPU twin of
 * `leapfrogStep` in physics/galaxyPotential.ts. Leapfrog is time-reversible, so running the clock
 * backwards un-does the disruption.
 *
 * State textures hold model-frame positions (pc) and velocities (pc/Myr), one texel per particle.
 */
const MAX_COMP = 8;

const ACCEL_GLSL = /* glsl */ `
uniform int uCompN;
uniform vec4 uComp[${MAX_COMP}];   // kind (0 point, 1 Hernquist, 2 Miyamoto–Nagai, 3 NFW), mass, a|soft|r_s, b
uniform float uG;
float nfwShapeG(float x) { return x < 1e-3 ? x * x * (0.5 - 0.6666667 * x) : log(1.0 + x) - x / (1.0 + x); }
vec3 accel(vec3 p) {
  vec3 acc = vec3(0.0);
  for (int i = 0; i < ${MAX_COMP}; i++) {
    if (i >= uCompN) break;
    vec4 c = uComp[i];
    float GM = uG * c.y;
    if (c.x < 0.5) {
      float r2 = dot(p, p) + c.z * c.z;
      acc -= GM * p / (r2 * sqrt(r2));
    } else if (c.x < 1.5) {
      float r = length(p) + 1e-6;
      float s = r + c.z;
      acc -= GM * p / (r * s * s);
    } else if (c.x < 2.5) {
      float zeta = sqrt(p.z * p.z + c.w * c.w);
      float s = c.z + zeta;
      float d2 = dot(p.xy, p.xy) + s * s;
      float f = GM / (d2 * sqrt(d2));
      acc -= f * vec3(p.x, p.y, p.z * s / zeta);
    } else {
      float r = length(p) + 1e-6;
      float m = nfwShapeG(r / c.z);
      acc -= GM * m * p / (r * r * r);
    }
  }
  return acc;
}
`;

const INIT_FRAG = /* glsl */ `
precision highp float;
precision highp int;
${GALAXY_UNIFORMS_GLSL}
${GALAXY_COMMON_GLSL}
${GALAXY_PARTICLE_GLSL}
uniform sampler2D uData;   // 3 RGBA texels per particle
uniform int uW;
uniform int uCount;
uniform float uT;
uniform float uDt;
layout(location = 0) out vec4 outPos;
layout(location = 1) out vec4 outVel;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  int id = px.y * uW + px.x;
  if (id >= uCount) { outPos = vec4(0.0); outVel = vec4(0.0); return; }
  vec4 a0 = texelFetch(uData, ivec2(px.x * 3, px.y), 0);
  vec4 a1 = texelFetch(uData, ivec2(px.x * 3 + 1, px.y), 0);
  vec4 a2 = texelFetch(uData, ivec2(px.x * 3 + 2, px.y), 0);
  vec3 P0, P1, P;
  float L, T;
  particleState(a0, a1, a2, uT - uDt, P0, L, T);
  particleState(a0, a1, a2, uT + uDt, P1, L, T);
  particleState(a0, a1, a2, uT, P, L, T);
  vec3 v = (P1 - P0) / (2.0 * uDt);
  // A young cluster changing cycle inside the stencil has no meaningful derivative.
  float vl = length(v);
  if (!(vl < 1500.0)) v = vec3(0.0);
  outPos = vec4(P, 1.0);
  outVel = vec4(v, 0.0);
}
`;

const STEP_FRAG = /* glsl */ `
precision highp float;
precision highp int;
${ACCEL_GLSL}
uniform sampler2D uPos;
uniform sampler2D uVel;
uniform int uSteps;
uniform float uH;
layout(location = 0) out vec4 outPos;
layout(location = 1) out vec4 outVel;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec4 P = texelFetch(uPos, px, 0);
  vec4 V = texelFetch(uVel, px, 0);
  vec3 x = P.xyz;
  vec3 v = V.xyz;
  for (int i = 0; i < 32; i++) {
    if (i >= uSteps) break;
    v += 0.5 * uH * accel(x);
    x += uH * v;
    v += 0.5 * uH * accel(x);
  }
  // Escapers far beyond the halo are parked (still finite) rather than overflowing half floats downstream.
  if (!(dot(x, x) < 1e14)) { x = normalize(P.xyz + 1e-3) * 1e7; v = vec3(0.0); }
  outPos = vec4(x, P.w);
  outVel = vec4(v, 0.0);
}
`;

export class GalaxyIntegrator {
  readonly width: number;
  readonly height: number;
  /** Largest leapfrog sub-step (Myr): ≥ 25 steps per orbit down to R ≈ 300 pc. */
  maxStep = 0.4;
  private rts: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private cur = 0;
  private dataTex: THREE.DataTexture;
  private initMat: THREE.ShaderMaterial;
  private stepMat: THREE.ShaderMaterial;
  private quad = new FullscreenQuad();

  constructor(
    private renderer: THREE.WebGLRenderer,
    data: Float32Array,
    private count: number,
    shared: Record<string, { value: unknown }>,
  ) {
    const maxTex = renderer.capabilities.maxTextureSize;
    this.width = maxTex >= 3 * 1024 ? 1024 : 512;
    this.height = Math.max(1, Math.ceil(count / this.width));
    const padded = new Float32Array(this.width * this.height * STRIDE);
    padded.set(data.subarray(0, count * STRIDE));
    this.dataTex = new THREE.DataTexture(padded, this.width * 3, this.height, THREE.RGBAFormat, THREE.FloatType);
    this.dataTex.minFilter = this.dataTex.magFilter = THREE.NearestFilter;
    this.dataTex.needsUpdate = true;
    const mk = () => {
      const rt = new THREE.WebGLRenderTarget(this.width, this.height, {
        count: 2,
        type: THREE.FloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
      });
      return rt;
    };
    this.rts = [mk(), mk()];
    this.initMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: INIT_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        ...shared,
        uData: { value: this.dataTex },
        uW: { value: this.width },
        uCount: { value: count },
        uT: { value: 0 },
        uDt: { value: 0.25 },
      },
    });
    this.stepMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: STEP_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uCompN: { value: 0 },
        uComp: { value: Array.from({ length: MAX_COMP }, () => new THREE.Vector4()) },
        uG: { value: G_GAL },
        uPos: { value: null },
        uVel: { value: null },
        uSteps: { value: 1 },
        uH: { value: 0.1 },
      },
    });
  }

  /** The potential to integrate in (dark components are skipped when `withDark` is false). */
  setPotential(components: PotentialComponent[], withDark: boolean): void {
    const arr = this.stepMat.uniforms.uComp.value as THREE.Vector4[];
    let n = 0;
    for (const c of components) {
      if (c.dark && !withDark) continue;
      if (n >= MAX_COMP) break;
      if (c.kind === 'point') arr[n].set(0, c.M, c.soft, 0);
      else if (c.kind === 'hernquist') arr[n].set(1, c.M, c.a, 0);
      else if (c.kind === 'mn') arr[n].set(2, c.M, c.a, c.b);
      else arr[n].set(3, c.Ms, c.rs, 0);
      n++;
    }
    this.stepMat.uniforms.uCompN.value = n;
  }

  /** Capture every particle's position and velocity from its analytic orbit at time t (Myr). */
  init(t: number): void {
    this.initMat.uniforms.uT.value = t;
    this.run(this.initMat, this.rts[0]);
    this.cur = 0;
  }

  /** Advance by dt Myr (negative runs the leapfrog backwards). */
  step(dt: number): void {
    if (dt === 0) return;
    const n = Math.min(32, Math.max(1, Math.ceil(Math.abs(dt) / this.maxStep)));
    const u = this.stepMat.uniforms;
    u.uSteps.value = n;
    u.uH.value = dt / n;
    const src = this.rts[this.cur];
    const dst = this.rts[1 - this.cur];
    u.uPos.value = src.textures[0];
    u.uVel.value = src.textures[1];
    this.run(this.stepMat, dst);
    this.cur = 1 - this.cur;
  }

  get positions(): THREE.Texture {
    return this.rts[this.cur].textures[0];
  }

  /** Read back model-frame positions (tests / picking; slow — not for per-frame use). */
  readPositions(): Float32Array {
    const out = new Float32Array(this.width * this.height * 4);
    this.renderer.readRenderTargetPixels(this.rts[this.cur], 0, 0, this.width, this.height, out, undefined, 0);
    return out;
  }

  private run(mat: THREE.ShaderMaterial, rt: THREE.WebGLRenderTarget): void {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    this.quad.material = mat;
    r.setRenderTarget(rt);
    r.render(this.quad.scene, this.quad.camera);
    r.setRenderTarget(prev);
  }

  dispose(): void {
    this.rts[0].dispose();
    this.rts[1].dispose();
    this.dataTex.dispose();
    this.initMat.dispose();
    this.stepMat.dispose();
  }
}
