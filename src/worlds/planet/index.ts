import * as THREE from 'three';
import type { PlanetSpec, PlanetUpdate, PlanetView } from './types';

export type * from './types';

/**
 * STUB implementation of the planet contract (types.ts) — a Lambert-lit sphere tinted by kind,
 * with optional flat rings. The `planets` module replaces this with the full renderer.
 */
const KIND_COLOR: Record<string, [number, number, number]> = {
  earth: [0.12, 0.25, 0.5],
  terrestrial: [0.18, 0.3, 0.45],
  ocean: [0.08, 0.2, 0.5],
  desert: [0.6, 0.35, 0.18],
  lava: [0.25, 0.08, 0.05],
  ice: [0.8, 0.85, 0.9],
  barren: [0.35, 0.33, 0.31],
  venus: [0.85, 0.75, 0.5],
  'gas-giant': [0.75, 0.62, 0.45],
  'ice-giant': [0.45, 0.7, 0.8],
};

export function createPlanet(spec: PlanetSpec): PlanetView {
  const c = KIND_COLOR[spec.kind] ?? [0.5, 0.5, 0.5];
  const mat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { uSun: { value: new THREE.Vector3(1, 0, 0) }, uColor: { value: new THREE.Color(c[0], c[1], c[2]) } },
    vertexShader: /* glsl */ `
      out vec3 vN; out vec3 vW;
      void main() { vN = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */ `
      precision highp float; in vec3 vN; in vec3 vW; out vec4 o; uniform vec3 uSun; uniform vec3 uColor;
      void main() { float l = max(dot(normalize(vN), normalize(uSun - vW)), 0.0); o = vec4(uColor * l * 1.5 + uColor * 0.002, 1.0); }`,
  });
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(spec.radius, 64, 32), mat);
  group.add(mesh);
  let ringMesh: THREE.Mesh | null = null;
  if (spec.rings) {
    const rg = new THREE.RingGeometry(spec.rings.inner * spec.radius, spec.rings.outer * spec.radius, 128, 1);
    rg.rotateX(-Math.PI / 2);
    const rc = spec.rings.color ?? [0.8, 0.72, 0.6];
    ringMesh = new THREE.Mesh(
      rg,
      new THREE.MeshBasicMaterial({ color: new THREE.Color(rc[0], rc[1], rc[2]).multiplyScalar(0.6), side: THREE.DoubleSide, transparent: true, opacity: spec.rings.opacity ?? 0.6, depthWrite: false }),
    );
    group.add(ringMesh);
  }
  return {
    object: group,
    spec,
    update(u: PlanetUpdate) {
      mat.uniforms.uSun.value.copy(u.sunPosition);
    },
    setRotation(a: number) {
      mesh.rotation.y = a;
    },
    dispose() {
      mesh.geometry.dispose();
      mat.dispose();
      if (ringMesh) {
        ringMesh.geometry.dispose();
        (ringMesh.material as THREE.Material).dispose();
      }
    },
  };
}
