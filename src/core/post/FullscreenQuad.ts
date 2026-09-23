import * as THREE from 'three';

/** Shared oversized triangle covering clip space; uv spans [0,1] over the viewport. */
let sharedGeometry: THREE.BufferGeometry | null = null;
function triangle(): THREE.BufferGeometry {
  if (sharedGeometry) return sharedGeometry;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  sharedGeometry = g;
  return g;
}

/** Vertex shader for full-screen passes (use with ShaderMaterial). */
export const FULLSCREEN_VERT = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

/** Renders a material over the whole viewport of the bound render target. */
export class FullscreenQuad {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  readonly mesh: THREE.Mesh;

  constructor(material?: THREE.Material) {
    this.mesh = new THREE.Mesh(triangle(), material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  get material(): THREE.Material {
    return this.mesh.material as THREE.Material;
  }
  set material(m: THREE.Material) {
    this.mesh.material = m;
  }

  render(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null): void {
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
  }
}
