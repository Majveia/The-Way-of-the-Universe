/**
 * Irregular small bodies: procedurally shaped rubble-pile asteroids, moonlets, contact binaries
 * and comet nuclei, lit with the Lommel–Seeliger law of airless regolith surfaces
 * (I ∝ μ₀/(μ₀+μ)) blended with a little Lambert term, and a small opposition surge.
 *
 * Shapes are star-shaped displacement fields on an icosphere: low-order lumps (fBm), a power-law
 * population of simple bowl craters with raised rims, and for contact binaries the smooth union
 * of two lobes (Arrokoth, 67P, Kerberos, Hektor) found by bisection along each vertex direction.
 * Geometry is unit-scale; the caller applies the body's triaxial radii with `object.scale`.
 */
import * as THREE from 'three';
import { Simplex3 } from '../../../physics/noise';
import { Rng, hashString } from '../../../physics/random';
import type { ShapeKind } from '../data/types';
import { NOISE_GLSL } from '../../../shaders/lib/noise';
import { COMMON_GLSL } from '../../../shaders/lib/common';

interface Crater {
  c: THREE.Vector3;
  r: number;
  depth: number;
}

function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/** Unit-scale rock geometry (longest semi-axis ≈ 1). */
export function rockGeometry(seedKey: string, shape: ShapeKind, subdiv: number): THREE.BufferGeometry {
  const seed = hashString(seedKey);
  const rng = new Rng(seed);
  const noise = new Simplex3(seed);
  const geo = new THREE.IcosahedronGeometry(1, subdiv);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const craters: Crater[] = [];
  const nC = shape === 'ellipsoid' ? 26 : 44;
  for (let k = 0; k < nC; k++) {
    const v = new THREE.Vector3(rng.normal(), rng.normal(), rng.normal()).normalize();
    const r = Math.min(0.55, 0.05 * Math.pow(1 - rng.next(), -1 / 1.6)); // power-law sizes
    craters.push({ c: v, r, depth: r * (0.18 + 0.1 * rng.next()) });
  }
  if (shape === 'ellipsoid') craters.push({ c: new THREE.Vector3(0, -1, 0.2).normalize(), r: 0.75, depth: 0.12 }); // a Rheasilvia-like basin
  const lobeA = { c: new THREE.Vector3(-0.42, 0, 0), r: 0.6 };
  const lobeB = { c: new THREE.Vector3(0.5, 0.03, 0.02), r: 0.45 + 0.08 * rng.next() };
  const v = new THREE.Vector3();
  const p = new THREE.Vector3();
  const lumpAmp = shape === 'ellipsoid' ? 0.05 : shape === 'bilobed' ? 0.07 : 0.16;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    let r: number;
    if (shape === 'bilobed') {
      // Distance along v to the surface of smin(sphere A, sphere B) by bisection.
      const sdf = (t: number) => {
        p.copy(v).multiplyScalar(t);
        return smin(p.distanceTo(lobeA.c) - lobeA.r, p.distanceTo(lobeB.c) - lobeB.r, 0.28);
      };
      let lo = 0, hi = 1.4;
      for (let k = 0; k < 28; k++) {
        const mid = 0.5 * (lo + hi);
        if (sdf(mid) < 0) lo = mid;
        else hi = mid;
      }
      r = 0.5 * (lo + hi);
    } else r = 1;
    // Lumps: two octaves of low-frequency noise.
    r *= 1 + lumpAmp * (noise.fbm(v.x * 1.3 + 3.1, v.y * 1.3, v.z * 1.3, 3) + 0.35 * noise.noise(v.x * 4, v.y * 4, v.z * 4));
    // Craters: bowl with a raised rim.
    for (const c of craters) {
      const d = v.angleTo(c.c) / c.r;
      if (d < 1.35) {
        const bowl = d < 1 ? (d * d - 1) : 0;
        const rim = Math.exp(-((d - 1) * (d - 1)) / 0.03) * 0.28;
        r += c.depth * (bowl + rim);
      }
    }
    pos.setXYZ(i, v.x * r, v.y * r, v.z * r);
  }
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  // Normalise so the largest extent is 1 along its axis.
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const ext = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z) / 2;
  geo.scale(1 / ext, 1 / ext, 1 / ext);
  geo.computeBoundingSphere();
  return geo;
}

const VERT = /* glsl */ `
out vec3 vN;
out vec3 vW;
out vec3 vObj;
void main() {
  vN = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vW = mv.xyz;
  vObj = position;
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
precision highp float;
${COMMON_GLSL}
${NOISE_GLSL}
in vec3 vN;
in vec3 vW;
in vec3 vObj;
uniform vec3 uSunView;     // sun position in view space
uniform vec3 uSunColor;    // colour × intensity
uniform vec3 uAlbedo;      // linear albedo colour
uniform float uSeed;
out vec4 outColor;
void main() {
  // Fine regolith texture: bumps and albedo mottling in object space.
  vec3 p = vObj * 9.0 + uSeed;
  float n1 = fbm3(p, 4);
  vec3 n = normalize(vN + 0.18 * vec3(fbm3(p + 17.0, 3), fbm3(p + 31.0, 3), fbm3(p + 47.0, 3)));
  vec3 L = normalize(uSunView - vW);
  vec3 V = normalize(-vW);
  float mu0 = max(dot(n, L), 0.0);
  float mu = max(dot(n, V), 0.0);
  float ls = mu0 > 0.0 ? mu0 / max(mu0 + mu, 1e-4) : 0.0;
  float phaseCos = dot(L, V);
  float surge = 1.0 + 0.4 * smoothstep(0.985, 1.0, phaseCos);
  float lit = (0.75 * 2.0 * ls + 0.25 * mu0) * surge;
  vec3 alb = uAlbedo * (0.85 + 0.3 * n1);
  outColor = vec4(uSunColor * alb * lit, 1.0);
}`;

export function rockMaterial(albedo: THREE.Color, seed: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uSunView: { value: new THREE.Vector3() },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uAlbedo: { value: albedo.clone() },
      uSeed: { value: (seed % 1000) * 0.137 },
    },
  });
}
