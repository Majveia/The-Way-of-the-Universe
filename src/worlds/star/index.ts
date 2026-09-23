import * as THREE from 'three';
import type { StarSpec, StarView } from '../planet/types';
import { blackbodyRGB } from '../../physics/blackbody';

/** STUB star (emissive blackbody sphere). Replaced by the `planets` module's full renderer. */
export function createStar(spec: StarSpec): StarView {
  const [r, g, b] = blackbodyRGB(spec.temperatureK);
  const k = 4 * (spec.intensity ?? 1);
  const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(r * k, g * k, b * k) });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(spec.radius, 48, 24), mat);
  return {
    object: mesh,
    spec,
    update() {},
    dispose() {
      mesh.geometry.dispose();
      mat.dispose();
    },
  };
}
