import * as THREE from 'three';
import { FullscreenQuad, FULLSCREEN_VERT } from '../../core/post/FullscreenQuad';

/**
 * Cross-fades a layer that has no opacity control of its own: while 0 < weight < 1 the layer is drawn
 * into an off-screen HDR target (cleared to black, own depth) and added to the scene with that weight;
 * at full weight it draws straight into the scene target at no extra cost. All layers are emissive
 * (linear radiance), so a weighted sum is exactly a cross-fade of their light.
 */
export class LayerFader {
  private rt: THREE.WebGLRenderTarget | null = null;
  private quad: FullscreenQuad;
  private mat: THREE.ShaderMaterial;
  private target: THREE.WebGLRenderTarget | null = null;
  private weight = 1;

  /**
   * mode 'add': the layer's light is added with its weight (emissive layers over the scene).
   * mode 'mix': the layer replaces the scene with its weight, (1 − w)·scene + w·layer — for layers that
   * redraw the whole view themselves (a lensed sky around a black hole).
   */
  constructor(
    private renderer: THREE.WebGLRenderer,
    mode: 'add' | 'mix' = 'add',
  ) {
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        precision highp float;
        in vec2 vUv;
        out vec4 outColor;
        uniform sampler2D tSrc;
        uniform float uWeight;
        uniform float uMix;
        void main() {
          vec3 c = max(texture(tSrc, vUv).rgb, 0.0);
          outColor = uMix > 0.5 ? vec4(c, uWeight) : vec4(c * uWeight, 1.0);
        }`,
      uniforms: { tSrc: { value: null }, uWeight: { value: 1 }, uMix: { value: mode === 'mix' ? 1 : 0 } },
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: mode === 'mix' ? THREE.SrcAlphaFactor : THREE.OneFactor,
      blendDst: mode === 'mix' ? THREE.OneMinusSrcAlphaFactor : THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullscreenQuad(this.mat);
  }

  /** Returns the target the layer should draw into (already bound). */
  begin(target: THREE.WebGLRenderTarget, weight: number): THREE.WebGLRenderTarget {
    this.target = target;
    this.weight = weight;
    const r = this.renderer;
    if (weight >= 0.999) {
      r.setRenderTarget(target);
      return target;
    }
    if (!this.rt || this.rt.width !== target.width || this.rt.height !== target.height) {
      this.rt?.dispose();
      this.rt = new THREE.WebGLRenderTarget(target.width, target.height, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: true,
        stencilBuffer: false,
        generateMipmaps: false,
      });
    }
    r.setRenderTarget(this.rt);
    r.setClearColor(0x000000, 1);
    r.clear(true, true, false);
    return this.rt;
  }

  /** Composite (if drawing off-screen) and re-bind the scene target. */
  end(): void {
    const r = this.renderer;
    const t = this.target!;
    if (this.weight < 0.999 && this.rt) {
      this.mat.uniforms.tSrc.value = this.rt.texture;
      this.mat.uniforms.uWeight.value = this.weight;
      r.setRenderTarget(t);
      r.render(this.quad.scene, this.quad.camera);
    }
    r.setRenderTarget(t);
  }

  dispose(): void {
    this.rt?.dispose();
    this.mat.dispose();
  }
}
