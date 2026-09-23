import * as THREE from 'three';
import { BLACKBODY_GLSL } from '../../shaders/lib/blackbody';
import { NOISE_GLSL } from '../../shaders/lib/noise';

/**
 * Stars close enough to be resolved (or bright enough to need exact positions): drawn as camera-facing
 * billboards at infinity, from directions computed in float64 on the CPU, so a binary 20 AU apart is
 * placed exactly even 4 light-years from home.
 *
 * One point-spread model covers every distance, consistent with the sky's star sprites: a Gaussian
 * core that turns continuously into a limb-darkened photosphere (linear law, u = 0.6 in V; Cox 2000)
 * once the disc is larger than the core, plus the same Moffat glare halo. Energy is conserved: the
 * disc's surface brightness is the star's flux spread over its apparent area.
 */
export interface NearStarView {
  /** Observed direction, world frame (unit). */
  dir: THREE.Vector3;
  /** Apparent angular radius, radians. */
  angularRadius: number;
  /** Observed colour temperature, K. */
  temperature: number;
  /** Observed apparent V magnitude. */
  mag: number;
  /** Seed for surface texture. */
  seed: number;
}

const MAX = 8;

const VERT = /* glsl */ `
in vec2 corner;
in vec3 iDir;
in vec4 iSize;   // x: quad half-size (px), y: disc radius (px), z: core sigma (px), w: halo alpha (px)
in vec4 iEnergy; // x: disc/core energy, y: halo central intensity, z: seed, w: visible
in vec3 iColor;
uniform vec2 uViewport;
out vec2 vP;
out vec4 vSize;
out vec4 vEnergy;
out vec3 vColor;
void main() {
  vec4 clip = projectionMatrix * vec4(mat3(viewMatrix) * iDir, 1.0);
  if (clip.w <= 0.0 || iEnergy.w < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  clip.xy += corner * iSize.x * 2.0 / uViewport * clip.w;
  clip.z = clip.w * 0.99999;
  gl_Position = clip;
  vP = corner * iSize.x;
  vSize = iSize;
  vEnergy = iEnergy;
  vColor = iColor;
}`;

const FRAG = /* glsl */ `
precision highp float;
${BLACKBODY_GLSL}
${NOISE_GLSL}
in vec2 vP;
in vec4 vSize;
in vec4 vEnergy;
in vec3 vColor;
uniform float uTime;
out vec4 outColor;
void main() {
  float r = length(vP);
  float R = vSize.x;
  if (r >= R) discard;
  float rho = vSize.y, sigma = vSize.z, a = vSize.w;
  float E = vEnergy.x;
  // Gaussian core (unresolved) and limb-darkened disc (resolved), blended by disc size.
  float kDisc = smoothstep(1.2 * sigma, 2.6 * sigma, rho);
  float sEff = sqrt(sigma * sigma + 0.25 * rho * rho);
  float core = exp(-0.5 * r * r / (sEff * sEff)) / (6.2831853 * sEff * sEff);
  float disc = 0.0;
  if (kDisc > 0.0) {
    float x = r / rho;
    float edge = 1.0 - smoothstep(1.0 - 0.7 / rho, 1.0 + 0.7 / rho, x);
    float mu = sqrt(max(0.0, 1.0 - x * x));
    float limb = 1.0 - 0.6 * (1.0 - mu);
    // Granulation: a few per cent of convective mottling on a well-resolved photosphere.
    float gran = 1.0;
    if (rho > 14.0 && x < 1.0) {
      vec3 n = vec3(vP / rho, mu);
      float g = snoise(n * 38.0 + vEnergy.z + vec3(0.0, 0.0, uTime * 0.02)) * 0.6 + snoise(n * 90.0 + vEnergy.z * 1.7) * 0.4;
      gran = 1.0 + 0.05 * g * smoothstep(14.0, 60.0, rho) * mu;
    }
    disc = edge * limb * gran / (3.14159265 * rho * rho * (1.0 - 0.6 / 3.0));
  }
  float body = mix(core, disc, kDisc) * E;
  // Glare halo (Moffat β = 1.8), tapered to zero at the quad edge.
  float halo = vEnergy.y * pow(1.0 + r * r / (a * a), -1.8);
  float t = 1.0 - (r * r) / (R * R);
  halo *= t * t;
  // Limb reddening: the outer photosphere is cooler.
  vec3 col = vColor * body * (kDisc > 0.0 ? mix(vec3(1.0), vec3(1.05, 0.93, 0.82), smoothstep(0.6, 1.0, r / max(rho, 1e-3)) * kDisc) : vec3(1.0)) + vColor * halo;
  outColor = vec4(min(col, vec3(6.0e4)), 1.0);
}`;

export class NearStars {
  readonly scene = new THREE.Scene();
  private mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  private geo: THREE.InstancedBufferGeometry;
  private aDir: THREE.InstancedBufferAttribute;
  private aSize: THREE.InstancedBufferAttribute;
  private aEnergy: THREE.InstancedBufferAttribute;
  private aColor: THREE.InstancedBufferAttribute;
  private col = new THREE.Color();
  /** Display threshold at which the halo is allowed to end (matches Sky's sprites). */
  limit = 2.5e-3;
  brightness = 1;
  starSize = 1;

  constructor() {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('corner', new THREE.Float32BufferAttribute([-1, -1, 1, -1, 1, 1, -1, 1], 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.aDir = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
    this.aSize = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4);
    this.aEnergy = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4);
    this.aColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
    for (const a of [this.aDir, this.aSize, this.aEnergy, this.aColor]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iDir', this.aDir);
    g.setAttribute('iSize', this.aSize);
    g.setAttribute('iEnergy', this.aEnergy);
    g.setAttribute('iColor', this.aColor);
    g.instanceCount = 0;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uViewport: { value: new THREE.Vector2(1, 1) }, uTime: { value: 0 } },
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  /**
   * Update the instances. `pxAngle` = radians per device pixel at the view centre; `pr` = device pixel
   * ratio; `exposure` the pre-exposure shared with the sky.
   */
  set(stars: readonly NearStarView[], pxAngle: number, pr: number, exposure: number, viewportW: number, viewportH: number, maxRadiusPx: number): void {
    const n = Math.min(MAX, stars.length);
    (this.mat.uniforms.uViewport.value as THREE.Vector2).set(viewportW, viewportH);
    for (let i = 0; i < n; i++) {
      const s = stars[i];
      this.aDir.setXYZ(i, s.dir.x, s.dir.y, s.dir.z);
      // Same calibration as Sky's STAR3D sprites: E = 3.17 · 10^(−0.4 (m − 1)) · pr² display·px².
      const E = 3.17 * Math.pow(10, -0.4 * (Math.max(s.mag, -40) - 1)) * this.brightness * exposure * pr * pr;
      const sigma = 0.85 * Math.sqrt(pr) * this.starSize;
      const rho = s.angularRadius / pxAngle;
      const a = 2.2 * pr * this.starSize;
      const h0 = (0.1 * E * 0.8) / (Math.PI * a * a);
      let R = Math.max(3.2 * sigma, rho * 1.25 + 2);
      if (h0 > this.limit) R = Math.max(R, a * Math.sqrt(Math.pow(h0 / this.limit, 1 / 1.8) - 1));
      R = Math.min(R, Math.max(maxRadiusPx, rho * 1.25 + 2));
      this.aSize.setXYZW(i, R, rho, sigma, a);
      this.aEnergy.setXYZW(i, 0.9 * E, h0, s.seed, E > 1e-7 ? 1 : 0);
      this.blackbody(s.temperature, this.col);
      this.aColor.setXYZ(i, this.col.r, this.col.g, this.col.b);
    }
    this.geo.instanceCount = n;
    this.aDir.needsUpdate = this.aSize.needsUpdate = this.aEnergy.needsUpdate = this.aColor.needsUpdate = true;
  }

  set time(t: number) {
    this.mat.uniforms.uTime.value = t;
  }

  /** Krystek (1985) Planckian locus → linear sRGB, luminance 1 (CPU twin of BLACKBODY_GLSL), saturation 1.25. */
  private blackbody(Tin: number, out: THREE.Color): THREE.Color {
    const T = Math.min(Math.max(Tin, 800), 60000);
    const u = (0.860117757 + 1.54118254e-4 * T + 1.28641212e-7 * T * T) / (1 + 8.42420235e-4 * T + 7.08145163e-7 * T * T);
    const v = (0.317398726 + 4.22806245e-5 * T + 4.20481691e-8 * T * T) / (1 - 2.89741816e-5 * T + 1.61456053e-7 * T * T);
    const d = 2 * u - 8 * v + 4;
    const x = (3 * u) / d, y = (2 * v) / d;
    const X = x / y, Z = (1 - x - y) / y;
    let r = 3.2404542 * X - 1.5371385 - 0.4985314 * Z;
    let g = -0.969266 * X + 1.8760108 + 0.041556 * Z;
    let b = 0.0556434 * X - 0.2040259 + 1.0572252 * Z;
    r = Math.max(r, 0); g = Math.max(g, 0); b = Math.max(b, 0);
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const s = 1.25;
    return out.setRGB(Math.max(0, l + s * (r - l)), Math.max(0, l + s * (g - l)), Math.max(0, l + s * (b - l)));
  }

  render(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void {
    if (this.geo.instanceCount > 0) renderer.render(this.scene, camera);
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
