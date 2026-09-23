import * as THREE from 'three';
import { Rng } from '../../physics/random';
import { OBLIQUITY_J2000 } from '../../physics/constants';
import { COMMON_GLSL } from '../../shaders/lib/common';
import { NOISE_GLSL } from '../../shaders/lib/noise';
import { BLACKBODY_GLSL } from '../../shaders/lib/blackbody';

export type SkyFrame = 'galactic' | 'equatorial' | 'ecliptic';

export interface SkyOptions {
  seed?: number;
  /** Number of point stars (scaled by quality detail by the caller if desired). */
  stars?: number;
  /** Milky Way band intensity (0 disables the band). */
  milkyWay?: number;
  /** Overall brightness multiplier for stars. */
  brightness?: number;
  /** Point sprite size multiplier. */
  starSize?: number;
  /** Which astronomical frame the sky is expressed in (three.js y-up mapping, see physics/kepler astroToThree). */
  frame?: SkyFrame;
  /** Faintest apparent magnitude generated. */
  limitingMagnitude?: number;
}

/**
 * Galactic (l,b) → equatorial J2000 rotation (transpose of the Hipparcos A_G matrix, ESA 1997 eq. 1.5.11).
 * Rows map galactic unit vectors to equatorial.
 */
const GAL_TO_EQ = new THREE.Matrix3().set(
  -0.0548755604, 0.4941094279, -0.867666149,
  -0.8734370902, -0.44482963, -0.1980763734,
  -0.4838350155, 0.7469822445, 0.4559837762,
);

/** Rotation that takes galactic-frame three.js vectors into the requested frame (three.js axes). */
export function skyFrameMatrix(frame: SkyFrame): THREE.Matrix4 {
  const P = new THREE.Matrix3().set(1, 0, 0, 0, 0, 1, 0, -1, 0); // astro → three
  const Pt = P.clone().transpose();
  let M = new THREE.Matrix3(); // astro galactic → astro target
  if (frame === 'equatorial') M = GAL_TO_EQ.clone();
  else if (frame === 'ecliptic') {
    const c = Math.cos(OBLIQUITY_J2000), s = Math.sin(OBLIQUITY_J2000);
    const EQ_TO_ECL = new THREE.Matrix3().set(1, 0, 0, 0, c, s, 0, -s, c);
    M = EQ_TO_ECL.multiply(GAL_TO_EQ.clone());
  }
  const T = P.clone().multiply(M).multiply(Pt);
  return new THREE.Matrix4().setFromMatrix3(T);
}

const BAND_VERT = /* glsl */ `
out vec3 vDir;
void main() {
  vDir = position;
  vec3 d = mat3(viewMatrix) * (mat3(modelMatrix) * position);
  vec4 clip = projectionMatrix * vec4(d, 1.0);
  clip.z = clip.w * 0.99999;
  gl_Position = clip;
}`;

const BAND_FRAG = /* glsl */ `
precision highp float;
${COMMON_GLSL}
${NOISE_GLSL}
${BLACKBODY_GLSL}
in vec3 vDir;
out vec4 outColor;
uniform float uIntensity;
uniform float uSeed;
void main() {
  // vDir is in the galactic three.js frame: +X = galactic centre, +Y = north galactic pole.
  vec3 d = normalize(vDir);
  float sb = d.y;                       // sin(b)
  float l = atan(-d.z, d.x);            // galactic longitude, 0 at the centre
  float cl = cos(l);
  vec3 p = d * 2.4 + uSeed;
  // Thin disk + central bulge brightness (exponential in |sin b|).
  float disk = exp(-abs(sb) / 0.07) * (0.5 + 0.5 * max(cl, 0.0) * max(cl, 0.0) + 0.12);
  float thick = exp(-abs(sb) / 0.2) * 0.12;
  float bulge = exp(-(l * l) / (2.0 * 0.26 * 0.26)) * exp(-abs(sb) / 0.14);
  float clouds = 0.5 + 0.5 * fbm3(p * 1.6, 5);
  float granular = 0.55 + 0.45 * fbm3(d * 16.0 + uSeed * 1.7, 5);
  float emission = disk * clouds * granular * 1.3 + thick + 1.5 * bulge * (0.75 + 0.25 * granular);
  // Dust: the Great Rift — filamentary absorbing lanes hugging the plane.
  float dn = fbm3(d * 6.0 + 11.0, 6);
  float fil = 1.0 - abs(fbm3(d * 13.0 + 3.0, 5));
  float dust = (smoothstep(-0.05, 0.45, dn) * 0.8 + 0.6 * smoothstep(0.6, 0.95, fil))
             * exp(-abs(sb + 0.01 * sin(l * 3.0)) / 0.035);
  float trans = exp(-dust * 2.4);
  // Colour: old warm light toward the bulge, bluer star-forming disk elsewhere; dust reddens.
  float warm = clamp(bulge * 1.6 + 0.2, 0.0, 1.0);
  vec3 col = mix(blackbody(8200.0), blackbody(4200.0), warm);
  col *= mix(vec3(1.0, 0.7, 0.5), vec3(1.0), trans);
  float glow = emission * trans * uIntensity * 0.075;
  outColor = vec4(col * glow, 1.0);
}`;

const STAR_VERT = /* glsl */ `
${BLACKBODY_GLSL}
in float mag;
in float temp;
uniform float uPixelRatio;
uniform float uSize;
uniform float uBrightness;
uniform float uSaturation;
out vec3 vColor;
void main() {
  vec3 d = mat3(viewMatrix) * (mat3(modelMatrix) * position);
  vec4 clip = projectionMatrix * vec4(d, 1.0);
  clip.z = clip.w * 0.99999;
  gl_Position = clip;
  float flux = pow(10.0, -0.4 * (mag - 1.0));
  float size = clamp(uSize * (1.6 + 2.2 * pow(flux, 0.3)), 1.6, 18.0) * uPixelRatio;
  gl_PointSize = size;
  vec3 c = blackbody(temp);
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = max(vec3(lum) + uSaturation * (c - vec3(lum)), 0.0);
  // Energy-normalised so the integrated flux does not depend on sprite size.
  vColor = c * flux * uBrightness * 10.0 * uPixelRatio * uPixelRatio / (size * size);
}`;

const STAR_FRAG = /* glsl */ `
precision highp float;
in vec3 vColor;
out vec4 outColor;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(q, q);
  if (r2 > 1.0) discard;
  // Airy-like core plus a faint wing.
  float core = exp(-r2 * 9.0);
  float wing = 0.06 * exp(-r2 * 2.5) * (1.0 - r2);
  outColor = vec4(vColor * (core + wing) * 3.2, 1.0);
}`;

/**
 * Procedural all-sky background: a magnitude-distributed starfield concentrated toward
 * the galactic plane, plus a diffuse Milky Way band with a dust rift. Rendered at
 * infinity (only the camera's rotation matters). Call `render()` first in a frame,
 * then clear depth and draw foreground layers.
 */
export class Sky {
  readonly scene = new THREE.Scene();
  readonly group = new THREE.Group();
  private starMat: THREE.ShaderMaterial;
  private bandMat: THREE.ShaderMaterial;
  private stars: THREE.Points;
  private band: THREE.Mesh;

  constructor(o: SkyOptions = {}) {
    const rng = new Rng(o.seed ?? 20250923);
    const n = Math.max(100, Math.floor(o.stars ?? 22000));
    const mMax = o.limitingMagnitude ?? 8.5;
    const mMin = -1.5;
    const pos = new Float32Array(n * 3);
    const mags = new Float32Array(n);
    const temps = new Float32Array(n);
    const k = 0.8; // dN/dm ∝ e^{k m} ≈ 10^{0.35 m} (star counts)
    const e0 = Math.exp(k * mMin), e1 = Math.exp(k * mMax);
    for (let i = 0; i < n; i++) {
      const m = Math.log(e0 + rng.next() * (e1 - e0)) / k;
      // Fainter stars crowd the galactic plane more strongly.
      const scaleB = THREE.MathUtils.lerp(0.9, 0.18, THREE.MathUtils.clamp((m - 2) / 6.5, 0, 1));
      let sb: number;
      if (rng.next() < 0.3) sb = rng.range(-1, 1);
      else {
        const e = rng.exponential(scaleB) * (rng.next() < 0.5 ? -1 : 1);
        sb = Math.max(-1, Math.min(1, Math.sin(Math.atan(e))));
      }
      // Longitude: mild concentration toward the galactic centre for faint stars.
      let l = rng.range(-Math.PI, Math.PI);
      if (m > 5 && rng.next() < 0.35) l = rng.normal(0, 0.6);
      const cb = Math.sqrt(1 - sb * sb);
      pos[i * 3] = cb * Math.cos(l);
      pos[i * 3 + 1] = sb;
      pos[i * 3 + 2] = -cb * Math.sin(l);
      mags[i] = m;
      const u = rng.next();
      temps[i] =
        u < 0.08 ? rng.range(3000, 3900)
        : u < 0.32 ? rng.range(3900, 5200)
        : u < 0.52 ? rng.range(5200, 6000)
        : u < 0.72 ? rng.range(6000, 7500)
        : u < 0.9 ? rng.range(7500, 10000)
        : rng.range(10000, 28000);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('mag', new THREE.BufferAttribute(mags, 1));
    g.setAttribute('temp', new THREE.BufferAttribute(temps, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    this.starMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      uniforms: {
        uPixelRatio: { value: 1 },
        uSize: { value: o.starSize ?? 1 },
        uBrightness: { value: o.brightness ?? 1 },
        uSaturation: { value: 1.25 },
      },
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    this.stars = new THREE.Points(g, this.starMat);
    this.stars.frustumCulled = false;

    this.bandMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: BAND_VERT,
      fragmentShader: BAND_FRAG,
      uniforms: { uIntensity: { value: o.milkyWay ?? 1 }, uSeed: { value: (rng.next() * 100) | 0 } },
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
    });
    this.band = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 48), this.bandMat);
    this.band.frustumCulled = false;
    this.band.renderOrder = -2;
    this.stars.renderOrder = -1;
    this.band.visible = (o.milkyWay ?? 1) > 0;
    this.group.add(this.band, this.stars);
    this.group.matrixAutoUpdate = false;
    this.group.matrix.copy(skyFrameMatrix(o.frame ?? 'galactic'));
    this.scene.add(this.group);
  }

  /** Extra rotation applied after the frame matrix (e.g. to align with a scene). */
  setRotation(m: THREE.Matrix4, frame: SkyFrame = 'galactic'): void {
    this.group.matrix.copy(m).multiply(skyFrameMatrix(frame));
    this.group.matrixWorldNeedsUpdate = true;
  }

  set brightness(v: number) {
    this.starMat.uniforms.uBrightness.value = v;
  }
  set milkyWay(v: number) {
    this.bandMat.uniforms.uIntensity.value = v;
    this.band.visible = v > 0;
  }
  set starSize(v: number) {
    this.starMat.uniforms.uSize.value = v;
  }

  /** Draw the sky into the currently bound render target using the camera's rotation. */
  render(renderer: THREE.WebGLRenderer, camera: THREE.Camera, pixelRatio = 1): void {
    this.starMat.uniforms.uPixelRatio.value = pixelRatio;
    renderer.render(this.scene, camera);
  }

  dispose(): void {
    this.stars.geometry.dispose();
    this.band.geometry.dispose();
    this.starMat.dispose();
    this.bandMat.dispose();
  }
}
