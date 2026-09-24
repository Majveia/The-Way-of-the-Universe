import * as THREE from 'three';

/**
 * Point glare for a star seen from a planet. A star that is only a pixel or two across (0.09°
 * for two M dwarfs seen from 1.5 AU) still floods an eye or a lens with light: the diffraction/
 * scatter halo carries far more visible energy than its resolved disk. This draws that halo as a
 * camera-facing quad of fixed apparent size in the star's own colour. It is drawn with the star's
 * depth slice, so the planet drawn afterwards hides it behind the limb pixel by pixel (sunsets clip
 * correctly), and it fades as the disk grows large enough to be seen for itself.
 * (A quad rather than a point sprite: points are dropped by some drivers at these depth ranges.)
 */
const VERT = /* glsl */ `
out vec2 vQ;
void main() {
  vQ = position.xy * 2.0;                                 // −1…1 across the quad
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */ `
precision highp float;
in vec2 vQ;
out vec4 outColor;
uniform vec3 uColor;
uniform float uStrength;
void main() {
  float r = length(vQ);                                   // 0 centre → 1 quad edge
  if (r > 1.0) discard;
  // Bright core + a wide, soft scatter halo (≈ r⁻² like a real PSF wing), zero at the edge.
  float core = exp(-r * r * 110.0) * 5.0;
  float halo = 0.1 / (r * r * 30.0 + 1.0);
  float edge = 1.0 - smoothstep(0.6, 1.0, r);
  outColor = vec4(uColor * (core + halo) * edge * uStrength, 1.0);
}`;

const tmp = new THREE.Vector3();

export class StarGlare {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  constructor(color: THREE.Color, strength: number) {
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uColor: { value: new THREE.Vector3(color.r, color.g, color.b) },
        uStrength: { value: strength },
      },
      transparent: true,
      depthWrite: false,
      // No depth test: the planet's slice is drawn after this one and hides the glare behind the limb.
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
  }
  /** Face the camera and span `fraction` of the vertical field of view. */
  orient(camera: THREE.PerspectiveCamera, fraction: number): void {
    const d = tmp.copy(this.mesh.position).sub(camera.position).length();
    const theta = fraction * THREE.MathUtils.degToRad(camera.fov);
    this.mesh.quaternion.copy(camera.quaternion);
    this.mesh.scale.setScalar(2 * d * Math.tan(theta / 2));
  }
  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}

/** Glare weight for a star disk of the given apparent diameter (degrees): full when unresolved. */
export function glareStrength(diameterDeg: number): number {
  return Math.min(1, Math.max(0, 0.6 / Math.max(diameterDeg, 1e-6) - 0.25));
}
