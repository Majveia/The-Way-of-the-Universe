import * as THREE from 'three';
import type { StarCatalog } from './catalog';
import { RELATIVITY_GLSL, RELATIVITY_UNIFORMS_GLSL } from './relativityGlsl';
import { CONSTELLATION_FIGURES } from './data/constellations';

/**
 * Constellation stick figures drawn between real catalogue stars. Each segment is subdivided along the
 * great circle between its two stars *as seen from the observer's position*, then every vertex is
 * aberrated — so figures distort with parallax when you travel and bend into arcs at relativistic
 * speeds, exactly as the stars they connect do. Lines stop short of the stars (planetarium style).
 */
const SUBDIV = 10;

const VERT = /* glsl */ `
${RELATIVITY_UNIFORMS_GLSL}
${RELATIVITY_GLSL}
in vec3 posB;
in float aT;
uniform vec3 uObsHi;
uniform vec3 uObsLo;
uniform float uEpoch;
in vec3 velA;
in vec3 velB;
uniform float uGap;
out float vAlpha;
void main() {
  vec3 ra = (position - uObsHi) - uObsLo + velA * uEpoch;
  vec3 rb = (posB - uObsHi) - uObsLo + velB * uEpoch;
  float da = length(ra), db = length(rb);
  vec3 a = normalize(mat3(modelMatrix) * ra);
  vec3 b = normalize(mat3(modelMatrix) * rb);
  float ang = acos(clamp(dot(a, b), -1.0, 1.0));
  // Keep a gap of uGap radians at each end; hide segments shorter than the gaps.
  float g = min(uGap / max(ang, 1e-6), 0.5);
  float t = mix(g, 1.0 - g, aT);
  // Slerp along the great circle between the two stars.
  float s = sin(ang);
  vec3 d = s > 1e-5 ? (sin((1.0 - t) * ang) * a + sin(t * ang) * b) / s : a;
  float delta;
  d = relAberrate(normalize(d), delta);
  vec4 clip = projectionMatrix * vec4(mat3(viewMatrix) * d, 1.0);
  clip.z = clip.w * 0.99999;
  gl_Position = clip;
  // Fade figures whose stars are very close to the observer (the figure loses its meaning there),
  // and soften the line ends.
  float nearFade = smoothstep(0.2, 1.0, min(da, db));
  float ends = smoothstep(0.0, 0.18, aT) * smoothstep(1.0, 0.82, aT);
  vAlpha = (ang > 2.0 * uGap ? 1.0 : 0.0) * nearFade * mix(0.55, 1.0, ends);
}`;

const FRAG = /* glsl */ `
precision highp float;
in float vAlpha;
uniform vec3 uColor;
uniform float uOpacity;
uniform float uExposureLines;
out vec4 outColor;
void main() {
  outColor = vec4(uColor * (vAlpha * uOpacity * uExposureLines), 1.0);
}`;

interface Shared {
  uBeta: THREE.IUniform<THREE.Vector3>;
  uBetaMag: THREE.IUniform<number>;
  uGamma: THREE.IUniform<number>;
  uRelFlags: THREE.IUniform<THREE.Vector3>;
  uLumLUT: THREE.IUniform<THREE.Texture>;
  uLumLUTRange: THREE.IUniform<THREE.Vector3>;
  uObsHi: THREE.IUniform<THREE.Vector3>;
  uObsLo: THREE.IUniform<THREE.Vector3>;
  uEpoch: THREE.IUniform<number>;
}

export interface ConstellationFigure {
  /** IAU abbreviation, e.g. "Ori". */
  con: string;
  /** Catalogue star indices, flattened pairs. */
  segments: readonly number[];
}

export class ConstellationLines {
  readonly object: THREE.LineSegments;
  readonly figures: readonly ConstellationFigure[];
  private mat: THREE.ShaderMaterial;
  private _opacity = 0;

  constructor(private catalog: StarCatalog, shared: Shared) {
    this.figures = CONSTELLATION_FIGURES.map(([con, segs]) => ({ con, segments: segs }));
    let nSeg = 0;
    for (const f of this.figures) nSeg += f.segments.length / 2;
    const nv = nSeg * SUBDIV * 2;
    const pa = new Float32Array(nv * 3);
    const pb = new Float32Array(nv * 3);
    const va = new Float32Array(nv * 3);
    const vb = new Float32Array(nv * 3);
    const tt = new Float32Array(nv);
    const P = catalog.position, V = catalog.velocity;
    let k = 0;
    for (const f of this.figures) {
      for (let s = 0; s < f.segments.length; s += 2) {
        const A = f.segments[s], B = f.segments[s + 1];
        for (let j = 0; j < SUBDIV; j++) {
          for (const t of [j / SUBDIV, (j + 1) / SUBDIV]) {
            for (let c = 0; c < 3; c++) {
              pa[k * 3 + c] = P[A * 3 + c];
              pb[k * 3 + c] = P[B * 3 + c];
              va[k * 3 + c] = V[A * 3 + c];
              vb[k * 3 + c] = V[B * 3 + c];
            }
            tt[k] = t;
            k++;
          }
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pa, 3));
    g.setAttribute('posB', new THREE.BufferAttribute(pb, 3));
    g.setAttribute('velA', new THREE.BufferAttribute(va, 3));
    g.setAttribute('velB', new THREE.BufferAttribute(vb, 3));
    g.setAttribute('aT', new THREE.BufferAttribute(tt, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uBeta: shared.uBeta,
        uBetaMag: shared.uBetaMag,
        uGamma: shared.uGamma,
        uRelFlags: shared.uRelFlags,
        uLumLUT: shared.uLumLUT,
        uLumLUTRange: shared.uLumLUTRange,
        uObsHi: shared.uObsHi,
        uObsLo: shared.uObsLo,
        uEpoch: shared.uEpoch,
        uGap: { value: THREE.MathUtils.degToRad(0.55) },
        uColor: { value: new THREE.Color(0.42, 0.55, 0.85) },
        uOpacity: { value: 0 },
        uExposureLines: { value: 0.16 },
      },
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    this.object = new THREE.LineSegments(g, this.mat);
    this.object.frustumCulled = false;
    this.object.visible = false;
  }

  set opacity(v: number) {
    this._opacity = v;
    this.mat.uniforms.uOpacity.value = v;
    this.object.visible = v > 0.001;
  }
  get opacity(): number {
    return this._opacity;
  }
  /** Linear brightness of the lines at opacity 1 (display units). */
  set brightness(v: number) {
    this.mat.uniforms.uExposureLines.value = v;
  }
  /** Angular gap left around each star, degrees. */
  set gapDegrees(v: number) {
    this.mat.uniforms.uGap.value = THREE.MathUtils.degToRad(v);
  }

  /** Stars used by a constellation's figure (for label placement). */
  starsOf(con: string): number[] {
    const f = this.figures.find((x) => x.con === con);
    return f ? [...new Set(f.segments)] : [];
  }

  update(_camera: THREE.Camera): void {
    // Uniforms are shared with the sky; nothing per-frame beyond that.
    void this.catalog;
  }

  dispose(): void {
    this.object.geometry.dispose();
    this.mat.dispose();
  }
}
