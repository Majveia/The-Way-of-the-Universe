import * as THREE from 'three';
import { Rng } from '../../physics/random';

/**
 * Imagination-drive streaks — the one openly non-physical effect in Starflight (the UI labels it).
 * A periodic box of motes around the camera is swept past along the direction of travel and drawn
 * as streaks whose length follows the apparent speed; ahead they are tinted blue, behind red, a
 * stylised nod to the Doppler shift. When the drive is idle the field is invisible.
 */
const VERT = /* glsl */ `
in float aEnd;
uniform vec3 uOffset;    // accumulated travel (box units)
uniform vec3 uDir;       // direction of travel (world, unit)
uniform float uLen;      // streak length (box units)
uniform float uBox;      // box size
uniform float uIntensity;
out float vFade;
out float vAhead;
void main() {
  vec3 p = mod(position - uOffset + 0.5 * uBox, uBox) - 0.5 * uBox;
  vec3 w = p - uDir * uLen * aEnd;
  float r = length(p) / (0.5 * uBox);
  vFade = smoothstep(1.0, 0.55, r) * smoothstep(0.02, 0.12, r) * (1.0 - 0.6 * aEnd) * uIntensity;
  vAhead = dot(normalize(p), uDir);
  gl_Position = projectionMatrix * mat4(mat3(viewMatrix)) * vec4(w, 1.0);
}`;

const FRAG = /* glsl */ `
precision highp float;
in float vFade;
in float vAhead;
out vec4 outColor;
void main() {
  vec3 ahead = vec3(0.55, 0.75, 1.0);
  vec3 behind = vec3(1.0, 0.45, 0.25);
  vec3 c = mix(behind, ahead, smoothstep(-0.6, 0.6, vAhead)) * vFade;
  outColor = vec4(c, 1.0);
}`;

export class WarpField {
  readonly object: THREE.LineSegments;
  private mat: THREE.ShaderMaterial;
  private offset = new THREE.Vector3();
  private box: number;

  constructor(count = 2400, box = 600) {
    this.box = box;
    const rng = new Rng(7331);
    const pos = new Float32Array(count * 6);
    const end = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const x = rng.range(-box / 2, box / 2), y = rng.range(-box / 2, box / 2), z = rng.range(-box / 2, box / 2);
      pos.set([x, y, z, x, y, z], i * 6);
      end[i * 2] = 0;
      end[i * 2 + 1] = 1;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uOffset: { value: this.offset },
        uDir: { value: new THREE.Vector3(0, 0, -1) },
        uLen: { value: 0 },
        uBox: { value: box },
        uIntensity: { value: 0 },
      },
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      transparent: true,
    });
    this.object = new THREE.LineSegments(g, this.mat);
    this.object.frustumCulled = false;
    this.object.renderOrder = 5;
    this.object.visible = false;
  }

  /**
   * @param dir world direction of travel
   * @param speed 0..1 visual warp factor
   */
  update(dt: number, dir: THREE.Vector3, speed: number, exposure: number): void {
    const u = this.mat.uniforms;
    const s = THREE.MathUtils.clamp(speed, 0, 1);
    (u.uDir.value as THREE.Vector3).copy(dir).normalize();
    const v = this.box * 1.6 * s; // box units per second
    this.offset.addScaledVector(u.uDir.value as THREE.Vector3, v * dt);
    // Keep the offset bounded (periodic box).
    this.offset.set(this.offset.x % this.box, this.offset.y % this.box, this.offset.z % this.box);
    u.uLen.value = Math.min(this.box * 0.45, v * 0.09);
    u.uIntensity.value = s * 2.2 * Math.max(0.2, Math.min(1, exposure * 2));
    this.object.visible = s > 0.01;
  }

  dispose(): void {
    this.object.geometry.dispose();
    this.mat.dispose();
  }
}
