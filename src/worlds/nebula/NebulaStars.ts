import * as THREE from 'three';
import { COMMON_GLSL } from '../../shaders/lib/common';
import { BLACKBODY_GLSL } from '../../shaders/lib/blackbody';
import { Rng } from '../../physics/random';
import { ccm89 } from '../../physics/nebulae';
import { absoluteMagnitude, msLuminosity, msTemperature, sampleKroupa } from './stars';
import type { NebulaStar } from './types';
import type { NebulaVolume } from './NebulaVolume';

export type SpikeStyle = 'none' | 'hubble' | 'jwst';

export interface NebulaStarsOptions {
  /** Stars in nebula-local parsecs (usually `volume.stars`). */
  stars: NebulaStar[];
  /** Additional field stars scattered around the nebula (fore- and background, parallax). */
  fieldStars?: number;
  /** Outer radius (pc) of the field-star population. */
  fieldRadius?: number;
  /** Keep field stars at least this far (pc) from the origin. */
  fieldInner?: number;
  seed?: number;
}

const VERT = /* glsl */ `
precision highp float;
precision highp sampler3D;
${COMMON_GLSL}
${BLACKBODY_GLSL}
in float part;
in vec3 iPos;
in float iTeff;
in float iMv;
in float iKind;
uniform sampler3D uField;
uniform float uHasField;
uniform float uHalf;
uniform float uExpand;
uniform float uKappa;
uniform float uIonDust;
uniform vec3 uKExt;
uniform vec3 uCamLocal;
uniform vec2 uViewport;
uniform float uPixelSolidAngle;
uniform float uGain;
uniform float uKnee;
uniform float uSpikes;
uniform float uSpikeGain;
uniform float uPulse;
uniform float uPixelRatio;
out vec2 vOff;
out vec3 vColor;
out float vSigma;
out float vSpike;
out float vPart;
out vec2 vDir;
out float vAmp;

float dustTau(vec3 a, vec3 b) {
  if (uHasField < 0.5) return 0.0;
  float H = uHalf * uExpand;
  vec3 d = b - a;
  float L = length(d);
  vec3 rd = d / max(L, 1e-6);
  vec3 inv = 1.0 / rd;
  vec3 t0 = (-vec3(H) - a) * inv;
  vec3 t1 = (vec3(H) - a) * inv;
  vec3 tmin = min(t0, t1);
  vec3 tmax = max(t0, t1);
  float tn = max(max(max(tmin.x, tmin.y), tmin.z), 0.0);
  float tf = min(min(min(tmax.x, tmax.y), tmax.z), L);
  if (tf <= tn) return 0.0;
  float tau = 0.0;
  float dt = (tf - tn) / 16.0;
  for (int i = 0; i < 16; i++) {
    vec3 p = a + rd * (tn + (float(i) + 0.5) * dt);
    vec4 F = texture(uField, (p / uExpand) / (2.0 * uHalf) + 0.5);
    float zH = 1.0 - smoothstep(-0.3, 0.3, F.y);
    tau += F.x * mix(1.0, uIonDust, zH);
  }
  return tau * dt * uKappa;
}

void main() {
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  vec4 clip = projectionMatrix * mv;
  float dist = max(length(iPos - uCamLocal), 1e-3);
  // Flux in emission-measure units: 10^(-0.4(M_V - 4.83)) L☉,V × 0.1348 (photopic fraction of the Sun)
  // × 1050 (1 L☉ at 1 pc) / d².
  float fluxEM = 141.6 * pow(10.0, -0.4 * (iMv - 4.83)) / (dist * dist);
  fluxEM *= iKind > 0.5 && iKind < 1.5 ? uPulse : 1.0;
  float tau = dustTau(uCamLocal, iPos);
  vec3 col = blackbody(iTeff) * exp(-tau * uKExt);
  // Radiance of a pixel holding all the flux, then a soft knee for the camera's dynamic range.
  float I = fluxEM * uGain / uPixelSolidAngle;
  float Ik = I < uKnee ? I : uKnee * pow(I / uKnee, 0.5);
  vColor = col * Ik;
  float sigma = 0.72 * uPixelRatio;
  vSigma = sigma;
  float lum = luma(vColor);
  // Spikes appear on stars well above the knee and lengthen with log brightness (as on real
  // detectors, where each magnitude adds a similar length of visible spike).
  float over = lum * uSpikeGain / (4.0 * uKnee);
  vSpike = uSpikes > 0.5 && over > 1.0 ? min(26.0 * sigma * log2(over), 180.0 * uPixelRatio) : 0.0;
  vPart = part;
  vDir = vec2(1.0, 0.0);
  vAmp = 1.0;
  vec2 off;
  if (part < 0.5) {
    // Core PSF (+ aureole for bright stars).
    float halfSize = (lum > 2.0 ? 11.0 : 4.5) * sigma + 1.0;
    off = position.xy * halfSize;
  } else {
    // One diffraction spike: a thin rectangle along its direction.
    float k = part;
    bool jw = uSpikes > 1.5;
    if (!jw && k > 2.5) vSpike = 0.0;
    vDir = jw ? (k < 1.5 ? vec2(0.0, 1.0) : k < 2.5 ? vec2(0.8660254, 0.5) : k < 3.5 ? vec2(0.8660254, -0.5) : vec2(1.0, 0.0))
              : (k < 1.5 ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
    vAmp = jw && k > 3.5 ? 0.35 : 1.0;
    vec2 perp = vec2(-vDir.y, vDir.x);
    off = vDir * position.x * (vSpike + 1.0) + perp * position.y * (4.0 * sigma + 1.0);
    if (vSpike <= 0.0) off = vec2(0.0);
  }
  if (lum < 1e-5 || clip.w <= 0.0 || (part > 0.5 && vSpike <= 0.0)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vOff = off;
  clip.xy += off * 2.0 / uViewport * clip.w;
  gl_Position = clip;
}`;

const FRAG = /* glsl */ `
precision highp float;
${COMMON_GLSL}
in vec2 vOff;
in vec3 vColor;
in float vSigma;
in float vSpike;
in float vPart;
in vec2 vDir;
in float vAmp;
uniform float uSpikeGain;
out vec4 outColor;
const vec3 LAM = vec3(610.0, 549.0, 465.0) / 549.0;
void main() {
  vec3 c;
  float s2 = vSigma * vSigma;
  if (vPart < 0.5) {
    float r2 = dot(vOff, vOff);
    c = vColor * (exp(-r2 / (2.0 * s2)) / (6.2831853 * s2));
    // Faint aureole from scattering in the optics.
    c += vColor * 0.012 * exp(-sqrt(r2) / (4.0 * vSigma)) / (50.0 * s2);
  } else {
    float a = abs(dot(vOff, vDir));
    float b = dot(vOff, vec2(-vDir.y, vDir.x));
    float w = 0.55 * vSigma;
    float across = exp(-b * b / (2.0 * w * w));
    // Diffraction angle ∝ λ: the red end of each spike reaches farther than the blue.
    vec3 sN = a / (LAM * vSigma * 2.2);
    vec3 along = 1.0 / (1.0 + sN * sN);
    float fade = 1.0 - smoothstep(0.55 * vSpike, vSpike, a);
    // Leave the core to the core quad.
    float hole = smoothstep(1.0 * vSigma, 2.5 * vSigma, a);
    c = vColor * (uSpikeGain * 0.006 / s2) * vAmp * across * along * fade * hole;
  }
  if (max(c.r, max(c.g, c.b)) < 1e-5) discard;
  outColor = vec4(c, 1.0);
}`;

/**
 * Stars inside and around a nebula, rendered as energy-normalised point-spread functions.
 * Each star's light is extinguished and reddened by the nebula's dust on the way to the camera
 * (CCM89 per channel), so stars embedded in pillars glow deep orange through A_V of several
 * magnitudes, and field stars behind the cloud wink out.
 */
export class NebulaStars {
  readonly object = new THREE.Object3D();
  spikes: SpikeStyle = 'jwst';
  /** Exposure of the stars relative to the nebula. */
  brightness = 1;
  private scene = new THREE.Scene();
  private mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  private geo: THREE.InstancedBufferGeometry;
  private volume: NebulaVolume | null = null;
  private readonly camLocal = new THREE.Vector3();
  private readonly inv = new THREE.Matrix4();
  readonly count: number;

  constructor(o: NebulaStarsOptions) {
    const all: NebulaStar[] = [...o.stars];
    const nField = Math.max(0, Math.floor(o.fieldStars ?? 0));
    if (nField > 0) {
      const rng = new Rng(o.seed ?? 99).fork('field');
      const R = o.fieldRadius ?? 60;
      const R0 = o.fieldInner ?? 0;
      for (let i = 0; i < nField; i++) {
        // Uniform in volume between R0 and R.
        const u = rng.next();
        const r = Math.cbrt(R0 * R0 * R0 + u * (R * R * R - R0 * R0 * R0));
        const d = rng.onSphere();
        const giant = rng.chance(0.08);
        let teff: number;
        let mv: number;
        if (giant) {
          teff = rng.range(3800, 5200);
          mv = rng.range(-1.5, 1.2);
        } else {
          const m = sampleKroupa(rng, 0.5, 6);
          teff = msTemperature(m);
          mv = absoluteMagnitude(msLuminosity(m), teff);
        }
        all.push({ pos: [d.x * r, d.y * r, d.z * r], teff, mv });
      }
    }
    this.count = all.length;
    const pos = new Float32Array(all.length * 3);
    const teff = new Float32Array(all.length);
    const mv = new Float32Array(all.length);
    const kind = new Float32Array(all.length);
    all.forEach((s, i) => {
      pos.set(s.pos, i * 3);
      teff[i] = s.teff;
      mv[i] = s.mv;
      kind[i] = s.kind === 'pulsar' ? 1 : s.kind === 'yso' ? 2 : s.kind === 'ionizing' ? 3 : 0;
    });
    // Five sub-quads per star: the PSF core and up to four thin diffraction-spike strips.
    const geo = new THREE.InstancedBufferGeometry();
    const corners: number[] = [];
    const parts: number[] = [];
    const index: number[] = [];
    for (let q = 0; q < 5; q++) {
      corners.push(-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0);
      parts.push(q, q, q, q);
      const b = q * 4;
      index.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    geo.setAttribute('position', new THREE.Float32BufferAttribute(corners, 3));
    geo.setAttribute('part', new THREE.Float32BufferAttribute(parts, 1));
    geo.setIndex(index);
    geo.setAttribute('iPos', new THREE.InstancedBufferAttribute(pos, 3));
    geo.setAttribute('iTeff', new THREE.InstancedBufferAttribute(teff, 1));
    geo.setAttribute('iMv', new THREE.InstancedBufferAttribute(mv, 1));
    geo.setAttribute('iKind', new THREE.InstancedBufferAttribute(kind, 1));
    geo.instanceCount = all.length;
    this.geo = geo;
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uField: { value: null },
        uHasField: { value: 0 },
        uHalf: { value: 1 },
        uExpand: { value: 1 },
        uKappa: { value: 0 },
        uIonDust: { value: 1 },
        uKExt: { value: new THREE.Vector3(ccm89(610), ccm89(549), ccm89(465)) },
        uCamLocal: { value: this.camLocal },
        uViewport: { value: new THREE.Vector2(1, 1) },
        uPixelSolidAngle: { value: 1e-6 },
        uGain: { value: 1 },
        uKnee: { value: 3 },
        uSpikes: { value: 2 },
        uSpikeGain: { value: 1 },
        uPulse: { value: 1 },
        uPixelRatio: { value: 1 },
      },
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.object.add(this.mesh);
    this.scene.add(this.object);
  }

  /** Nebula whose dust extinguishes these stars (shares its local frame). */
  setVolume(v: NebulaVolume | null): void {
    this.volume = v;
    if (v) this.object.scale.copy(v.object.scale);
  }

  /** Brightness multiplier for pulsar instances (e.g. from pulsarExposure). */
  set pulse(v: number) {
    this.mat.uniforms.uPulse.value = v;
  }

  render(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, target: THREE.WebGLRenderTarget | null, pixelRatio = 1): void {
    const u = this.mat.uniforms;
    const v = this.volume;
    const tex = v?.fieldTexture ?? null;
    u.uField.value = tex;
    u.uHasField.value = tex ? 1 : 0;
    if (v) {
      u.uHalf.value = v.preset.half;
      u.uExpand.value = v.expansion;
      u.uKappa.value = v.kappa;
      u.uIonDust.value = v.ionDust;
      u.uGain.value = v.preset.gain * v.exposure * this.brightness;
      this.object.position.copy(v.object.position);
      this.object.quaternion.copy(v.object.quaternion);
    } else {
      u.uGain.value = this.brightness * 2.5e-5;
    }
    this.object.updateMatrixWorld();
    camera.updateMatrixWorld();
    this.inv.copy(this.object.matrixWorld).invert();
    this.camLocal.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(this.inv);
    const w = target ? target.width : renderer.domElement.width;
    const h = target ? target.height : renderer.domElement.height;
    u.uViewport.value.set(w, h);
    const pix = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / h;
    u.uPixelSolidAngle.value = pix * pix;
    u.uPixelRatio.value = pixelRatio;
    u.uSpikes.value = this.spikes === 'none' ? 0 : this.spikes === 'hubble' ? 1 : 2;
    renderer.setRenderTarget(target);
    renderer.render(this.scene, camera);
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
