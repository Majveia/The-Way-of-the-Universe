/**
 * Reduced-resolution pass for the comet tails.
 *
 * Near a great comet the dust and plasma splats are tens to hundreds of pixels wide and overlap
 * ~100× — pure fill rate, blended into the (multisampled) HDR target. Splats wider than
 * TAIL_SPLIT_PX are instead drawn into this quarter-resolution RGBA16F target (1/16 of the
 * fragments, no MSAA) and added back with a cubic B-spline upsample (4 bilinear taps, positive
 * weights: no ringing, so black stays black). The splat shaders conserve flux per pass pixel, so
 * the composite is a plain additive upsample.
 *
 * Portability: rendering into RGBA16F needs EXT_color_buffer_float (or EXT_color_buffer_half_float);
 * the layer only creates this when one is present. Linear filtering of RGBA16F is core WebGL2.
 */
import * as THREE from 'three';

const VERT = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tLow;
uniform vec2 uSize;
in vec2 vUv;
out vec4 outColor;
vec4 bspline(float v) {
  vec4 n = vec4(1.0, 2.0, 3.0, 4.0) - v;
  vec4 s = n * n * n;
  float x = s.x;
  float y = s.y - 4.0 * s.x;
  float z = s.z - 4.0 * s.y + 6.0 * s.x;
  return vec4(x, y, z, 6.0 - x - y - z) * (1.0 / 6.0);
}
void main() {
  vec2 st = vUv * uSize - 0.5;
  vec2 f = fract(st);
  st -= f;
  vec4 xc = bspline(f.x);
  vec4 yc = bspline(f.y);
  vec4 c = st.xxyy + vec2(-0.5, 1.5).xyxy;
  vec4 s = vec4(xc.xz + xc.yw, yc.xz + yc.yw);
  vec4 o = (c + vec4(xc.yw, yc.yw) / s) / uSize.xxyy;
  vec3 s0 = texture(tLow, o.xz).rgb;
  vec3 s1 = texture(tLow, o.yz).rgb;
  vec3 s2 = texture(tLow, o.xw).rgb;
  vec3 s3 = texture(tLow, o.yw).rgb;
  float sx = s.x / (s.x + s.y);
  float sy = s.z / (s.z + s.w);
  vec3 col = mix(mix(s3, s2, sx), mix(s1, s0, sx), sy);
  if (max(col.r, max(col.g, col.b)) < 1e-7) discard;
  outColor = vec4(col, 1.0);
}`;

export class TailComposite {
  width = 0;
  height = 0;
  private rt: THREE.WebGLRenderTarget | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private mat: THREE.ShaderMaterial;
  private clear = new THREE.Color();
  private clearAlpha = 1;

  constructor() {
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { tLow: { value: null }, uSize: { value: new THREE.Vector2(1, 1) } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    quad.frustumCulled = false;
    this.scene.add(quad);
  }

  /** Size the target to `scale` × the full-resolution size (no-op when unchanged). */
  setSize(fullW: number, fullH: number, scale: number): void {
    const w = Math.max(1, Math.ceil(fullW * scale));
    const h = Math.max(1, Math.ceil(fullH * scale));
    if (this.rt && w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    if (this.rt) this.rt.setSize(w, h);
    else
      this.rt = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
      });
    this.mat.uniforms.tLow.value = this.rt.texture;
    (this.mat.uniforms.uSize.value as THREE.Vector2).set(w, h);
  }

  /** Bind and clear the reduced-resolution target. */
  begin(r: THREE.WebGLRenderer): void {
    r.getClearColor(this.clear);
    this.clearAlpha = r.getClearAlpha();
    r.setRenderTarget(this.rt);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
  }

  /** Add the upsampled result into `target` (left bound). */
  end(r: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null): void {
    r.setClearColor(this.clear, this.clearAlpha);
    r.setRenderTarget(target);
    r.render(this.scene, this.camera);
  }

  dispose(): void {
    this.rt?.dispose();
    this.rt = null;
    this.mat.dispose();
    (this.scene.children[0] as THREE.Mesh).geometry.dispose();
  }
}
