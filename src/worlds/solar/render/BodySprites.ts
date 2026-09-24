/**
 * Point-spread-function sprites for bodies too small to resolve: the way a planet really looks
 * from far away — a point of light. Each sprite carries the body's disc-integrated flux
 * (Lambert-sphere phase law), compressed and floored so every planet stays findable; the Sun
 * gets a brilliant energy-conserving core. Depth-tested at the body centre, so a resolved
 * sphere hides its own sprite and only the soft wing remains while they cross-fade.
 */
import * as THREE from 'three';
import { OCCLUDE_GLSL, PSF_GLSL } from './glsl';

const VERT = /* glsl */ `
precision highp float;
${OCCLUDE_GLSL}
in vec4 aColor;   // rgb × intensity, a = sigma (device px)
out vec3 vColor;
out float vSigma;
out float vSize;
void main() {
  vColor = vec3(0.0);
  vSigma = 1.0;
  vSize = 1.0;
  if (occlusion(position) > 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  vSigma = aColor.a;
  vSize = max(3.0, ceil(vSigma * 7.0));
  gl_PointSize = vSize;
  vColor = aColor.rgb;
}`;

const FRAG = /* glsl */ `
precision highp float;
${PSF_GLSL}
in vec3 vColor;
in float vSigma;
in float vSize;
out vec4 outColor;
void main() {
  vec2 q = (gl_PointCoord - 0.5) * vSize;
  vec3 c = vColor * psf(q, vSigma);
  if (max(c.r, max(c.g, c.b)) < 1e-7) discard;
  outColor = vec4(c, 1.0);
}`;

export class BodySprites {
  readonly object: THREE.Points;
  private pos: Float32Array;
  private col: Float32Array;
  private geo: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;
  private n = 0;
  readonly max: number;

  constructor(max: number, shared: Record<string, THREE.IUniform>) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e12);
    g.setDrawRange(0, 0);
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { ...shared },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.object = new THREE.Points(g, this.mat);
    this.object.frustumCulled = false;
    this.object.renderOrder = 3;
  }

  begin(): void {
    this.n = 0;
  }

  /** Add a sprite at a camera-relative position with linear colour × intensity and PSF sigma (device px). */
  add(rel: THREE.Vector3, r: number, g: number, b: number, sigma: number): void {
    if (this.n >= this.max) return;
    const i = this.n++;
    this.pos[i * 3] = rel.x;
    this.pos[i * 3 + 1] = rel.y;
    this.pos[i * 3 + 2] = rel.z;
    this.col[i * 4] = r;
    this.col[i * 4 + 1] = g;
    this.col[i * 4 + 2] = b;
    this.col[i * 4 + 3] = sigma;
  }

  end(): void {
    this.geo.setDrawRange(0, this.n);
    const p = this.geo.getAttribute('position') as THREE.BufferAttribute;
    const c = this.geo.getAttribute('aColor') as THREE.BufferAttribute;
    p.clearUpdateRanges();
    c.clearUpdateRanges();
    p.addUpdateRange(0, this.n * 3);
    c.addUpdateRange(0, this.n * 4);
    p.needsUpdate = true;
    c.needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
