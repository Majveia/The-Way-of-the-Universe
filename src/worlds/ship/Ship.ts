import * as THREE from 'three';
import { BLACKBODY_GLSL } from '../../shaders/lib/blackbody';
import { buildShipGeometry, type ShipGeometry } from './shipGeometry';
import { EnginePlume } from './Plume';

/**
 * The Ship of the Imagination: procedural hull + physically based shading + engine plume + nav lights.
 *
 * Lighting is physical and driven by the caller: `setKeyLight()` takes the direction to the brightest
 * star and its illuminance in display units (see voyage `starIlluminance`), so the hull is brilliantly
 * lit 200 AU from the Sun and a dark silhouette between the stars — where the engine glow, running
 * lights and reflections of the (aberrated) sky are all that remain. A small cube probe of the sky
 * (`SkyProbe`) provides reflections and ambient light; a shadow map gives crisp self-shadowing.
 *
 * Units: metres, ship-local frame (nose −Z). Render in its own layer with a camera near 0.05 m.
 */
const HULL_VERT = /* glsl */ `
in float part;
out vec3 vN;
out vec3 vPosW;
out vec3 vPosL;
out vec3 vNL;
out vec2 vUv;
out float vPart;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vPosW = wp.xyz;
  vPosL = position;
  vNL = normal;
  vN = normalize(mat3(modelMatrix) * normal);
  vUv = uv;
  vPart = part;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const HULL_FRAG = /* glsl */ `
precision highp float;
${BLACKBODY_GLSL}
in vec3 vN;
in vec3 vPosW;
in vec3 vPosL;
in vec3 vNL;
in vec2 vUv;
in float vPart;
out vec4 outColor;
uniform mat4 uShadowMatrix;
uniform vec3 uKeyDir;
uniform vec3 uKeyColor;
uniform vec3 uFillDir;
uniform vec3 uFillColor;
uniform samplerCube uEnv;
uniform float uEnvOn;
uniform float uEnvMaxLod;
uniform float uEnvGain;
uniform vec3 uAmbient;
uniform vec3 uEnginePos;
uniform vec3 uEngineColor;
uniform float uThrust;
uniform float uTime;
uniform sampler2D uShadowMap;
uniform float uShadowOn;
uniform float uShadowTexel;
uniform float uExposure;
uniform float uCockpit;

const float PI = 3.141592653589793;

float seam(float x, float w) {
  float fw = max(fwidth(x), 1e-5);
  return 1.0 - smoothstep(w - fw, w + fw, abs(x));
}
float seamPeriodic(float x, float period, float w) {
  float d = (fract(x / period + 0.5) - 0.5) * period;
  return seam(d, w);
}
float D_GGX(float NoH, float a) {
  float a2 = a * a;
  float f = NoH * NoH * (a2 - 1.0) + 1.0;
  return a2 / (PI * f * f);
}
float V_Smith(float NoV, float NoL, float a) {
  float a2 = a * a;
  float gv = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2);
  float gl = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2);
  return 0.5 / max(gv + gl, 1e-5);
}
vec3 F_Schlick(vec3 f0, float VoH) {
  float f = pow(1.0 - VoH, 5.0);
  return f0 + (1.0 - f0) * f;
}
// Karis 2014 analytic approximation of the split-sum environment BRDF.
vec2 envBRDF(float NoV, float r) {
  const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
  const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 rr = r * c0 + c1;
  float a004 = min(rr.x * rr.x, exp2(-9.28 * NoV)) * rr.x + rr.y;
  return vec2(-1.04, 1.04) * a004 + rr.zw;
}
float shadowAt(vec3 posW, vec3 N, float NoL) {
  if (uShadowOn < 0.5) return 1.0;
  // Normal-offset lookup (≈ 2 shadow texels along the normal, more at grazing light).
  vec3 q = posW + N * (0.035 + 0.06 * (1.0 - NoL));
  vec4 sp = uShadowMatrix * vec4(q, 1.0);
  vec3 p = sp.xyz / sp.w;
  if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0 || p.z > 1.0) return 1.0;
  float bias = 0.00025;
  float s = 0.0;
  for (int i = -1; i <= 1; i++)
  for (int j = -1; j <= 1; j++) {
    vec2 o = vec2(float(i), float(j)) * uShadowTexel * 1.2;
    s += step(p.z - bias, texture(uShadowMap, p.xy + o).r);
  }
  return s / 9.0;
}

struct Mat { vec3 albedo; float rough; float metal; float coat; float coatRough; vec3 emit; };

Mat hullMaterial() {
  Mat m;
  m.metal = 0.0; m.coat = 0.0; m.coatRough = 0.06; m.emit = vec3(0.0);
  vec3 ivory = vec3(0.80, 0.765, 0.70);
  vec3 ceramic = vec3(0.035, 0.036, 0.04);
  vec3 graphite = vec3(0.07, 0.072, 0.078);
  int part = int(vPart + 0.5);
  float u = vUv.x, v = vUv.y;
  if (part == 0) {
    // Fuselage: u = station nose→tail, v = angle (0 = starboard, 0.25 = top).
    float th = v * 6.2831853;
    float sn = sin(th);
    float belly = smoothstep(-0.2, -0.3, sn);
    m.albedo = mix(ivory, ceramic, belly);
    m.rough = mix(0.34, 0.72, belly);
    m.coat = 1.0 - belly;
    // Seams: frames every ~2 m, stringers along the flanks and the spine, the belly waterline.
    float frames = seamPeriodic(u, 0.074, 0.0016) * step(0.06, u);
    float stringers = seam(sn - 0.42, 0.006) + seam(sn + 0.22, 0.005) + seam(cos(th), 0.0045) * step(0.0, sn);
    float line = clamp(frames + stringers, 0.0, 1.0);
    // Tile grid on the belly.
    vec2 tq = vec2(u * 26.0 / 0.32, th * 2.2 / 0.32);
    float tiles = belly * max(seamPeriodic(tq.x, 1.0, 0.035), seamPeriodic(tq.y, 1.0, 0.035));
    m.albedo *= 1.0 - 0.45 * line - 0.35 * tiles;
    m.rough = mix(m.rough, 0.8, max(line, tiles));
    m.coat *= 1.0 - line;
    // Access hatch outlines on the flanks.
    vec2 h = vec2((u - 0.52) / 0.05, (abs(sn) - 0.05) / 0.12);
    float hatch = seam(max(abs(h.x), abs(h.y)) - 1.0, 0.03) * step(0.0, cos(th) * cos(th) - 0.3);
    m.albedo *= 1.0 - 0.4 * hatch;
    // Status line: a thin, cool emissive stripe along each flank.
    float stripe = seam(sn + 0.02, 0.0035) * smoothstep(0.17, 0.2, u) * (1.0 - smoothstep(0.63, 0.67, u));
    m.emit += vec3(0.45, 0.72, 1.0) * stripe * 0.9;
    // Cabin portholes: warm light from inside.
    float ph = (fract(u / 0.022) - 0.5) * 0.022;
    float port = (1.0 - smoothstep(0.004, 0.0052, length(vec2(ph, (sn - 0.18) * 0.12)))) * step(0.46, u) * step(u, 0.58) * step(0.2, abs(cos(th)));
    m.emit += blackbody(2900.0) * port * 1.6;
    m.albedo *= 1.0 - port;
  } else if (part == 1 || part == 2) {
    // Wings and fins: u = span, v around the airfoil (v < 0.5 upper surface, TE → LE).
    bool upper = v < 0.5;
    float k = upper ? 1.0 - v * 2.0 : (v - 0.5) * 2.0;
    float xc = 0.5 - 0.5 * cos(k * PI);
    float lead = smoothstep(0.09, 0.05, xc);
    bool fin = part == 2;
    bool dark = !upper && !fin;
    m.albedo = dark ? ceramic : ivory;
    m.rough = dark ? 0.72 : 0.34;
    m.coat = dark ? 0.0 : 1.0;
    m.albedo = mix(m.albedo, graphite, lead);
    m.rough = mix(m.rough, 0.5, lead);
    m.coat *= 1.0 - lead;
    float flap = seam(xc - 0.74, 0.004) + seamPeriodic(u, 0.16, 0.003) * step(0.74, xc);
    float spar = seam(xc - 0.3, 0.003) * 0.6;
    float tip = smoothstep(0.93, 0.96, u);
    m.albedo = mix(m.albedo, graphite, tip);
    float line = clamp(flap + spar, 0.0, 1.0);
    m.albedo *= 1.0 - 0.45 * line;
    m.coat *= 1.0 - line;
  } else if (part == 3) {
    // Canopy: dark smoked glass with a faint instrument glow inside.
    m.albedo = vec3(0.004, 0.005, 0.006);
    m.rough = 0.035;
    m.coat = 0.0;
    float frame = seamPeriodic(vUv.x, 0.33, 0.012) + seam(vUv.y - 0.5, 0.004);
    m.albedo = mix(m.albedo, graphite, clamp(frame, 0.0, 1.0));
    m.rough = mix(m.rough, 0.5, clamp(frame, 0.0, 1.0));
    m.emit += vec3(1.0, 0.55, 0.25) * 0.05 * (1.0 - clamp(frame, 0.0, 1.0)) * (0.6 + 0.4 * sin(vUv.x * 40.0));
  } else if (part == 4) {
    // Drive ring: brushed titanium.
    m.albedo = vec3(0.54, 0.55, 0.57);
    m.metal = 1.0;
    m.rough = 0.3;
    float g = seamPeriodic(vUv.x, 1.0 / 24.0, 0.0012);
    m.albedo *= 1.0 - 0.5 * g;
  } else if (part == 5) {
    // Nozzle bell interior: refractory metal, lit by the drive.
    m.albedo = vec3(0.3, 0.3, 0.32);
    m.metal = 1.0;
    m.rough = 0.45;
    float depth = 1.0 - vUv.x;
    // Standby: the magnetic nozzle's faint cool glow; under thrust the throat runs white-hot.
    m.emit += vec3(0.35, 0.5, 1.0) * 0.012 * pow(depth, 3.0);
    m.emit += blackbody(1400.0 + 1800.0 * uThrust) * 0.35 * uThrust * pow(depth, 2.0);
    m.emit += uEngineColor * 0.03 * uThrust * pow(depth, 3.0);
  } else {
    // Tail cap: ceramic, heat-tinted near the drive.
    m.albedo = ceramic * 1.4;
    m.rough = 0.65;
    m.emit += blackbody(950.0) * 0.08 * uThrust * smoothstep(0.5, 1.0, vUv.x);
  }
  return m;
}

vec3 envSample(vec3 dir, float lod) {
  return uEnvOn > 0.5 ? textureLod(uEnv, dir, lod).rgb * uEnvGain : uAmbient;
}

vec3 shade(Mat m, vec3 N, vec3 V, vec3 L, vec3 E, float sh) {
  float NoL = dot(N, L);
  if (NoL <= 0.0) return vec3(0.0);
  vec3 H = normalize(L + V);
  float NoV = max(dot(N, V), 1e-4);
  float NoH = max(dot(N, H), 0.0);
  float VoH = max(dot(V, H), 0.0);
  float a = max(m.rough * m.rough, 0.002);
  vec3 f0 = mix(vec3(0.04), m.albedo, m.metal);
  vec3 F = F_Schlick(f0, VoH);
  vec3 spec = D_GGX(NoH, a) * V_Smith(NoV, NoL, a) * F;
  vec3 diff = (1.0 - F) * (1.0 - m.metal) * m.albedo / PI;
  vec3 base = diff + spec;
  if (m.coat > 0.0) {
    float ac = m.coatRough * m.coatRough;
    float Fc = 0.04 + 0.96 * pow(1.0 - VoH, 5.0);
    float sc = D_GGX(NoH, ac) * V_Smith(NoV, NoL, ac) * Fc * m.coat;
    base = base * (1.0 - Fc * m.coat) + sc;
  }
  return base * E * NoL * sh;
}

void main() {
  Mat m = hullMaterial();
  vec3 N = normalize(vN);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(cameraPosition - vPosW);
  float NoV = max(dot(N, V), 1e-4);
  vec3 col = vec3(0.0);
  // Key star with shadow; second star without.
  float sh = shadowAt(vPosW, N, max(dot(N, uKeyDir), 0.0));
  col += shade(m, N, V, uKeyDir, uKeyColor, sh);
  col += shade(m, N, V, uFillDir, uFillColor, 1.0);
  // Engine light: the drive plume as a point source behind the tail.
  vec3 toE = uEnginePos - vPosL;
  float dE = length(toE);
  vec3 Le = normalize(mat3(1.0) * toE);
  float nle = max(dot(normalize(vNL), Le), 0.0);
  col += m.albedo * (1.0 - m.metal * 0.5) / PI * uEngineColor * uThrust * nle / (1.0 + dE * dE) * 6.0;
  // Image-based light from the sky probe (reflections of stars and the Milky Way, ambient).
  vec3 R = reflect(-V, N);
  vec3 f0 = mix(vec3(0.04), m.albedo, m.metal);
  vec2 ab = envBRDF(NoV, m.rough);
  vec3 specIBL = envSample(R, m.rough * uEnvMaxLod) * (f0 * ab.x + ab.y);
  vec3 diffIBL = envSample(N, uEnvMaxLod) * m.albedo * (1.0 - m.metal);
  vec3 ibl = diffIBL + specIBL;
  if (m.coat > 0.0) {
    float Fc = 0.04 + 0.96 * pow(1.0 - NoV, 5.0);
    ibl = ibl * (1.0 - Fc * m.coat) + envSample(R, m.coatRough * uEnvMaxLod) * Fc * m.coat;
  }
  col += ibl;
  col += m.emit * uExposure * (int(vPart + 0.5) == 3 ? 1.0 : 1.0);
  outColor = vec4(min(col, vec3(6.0e4)), 1.0);
}`;

const LIGHTS_VERT = /* glsl */ `
in vec3 color;
in float phase;
in float kind;
uniform float uTime;
uniform float uPixelRatio;
uniform float uExposure;
uniform float uScale;
out vec3 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float on = 1.0;
  float t = uTime + phase;
  if (kind > 1.5 && kind < 2.5) on = step(fract(t / 1.3), 0.045);                  // white strobe
  else if (kind > 2.5) on = 0.15 + 0.85 * pow(0.5 + 0.5 * sin(t * 3.14159), 6.0);  // red beacon
  // Physical-ish size: a 12 cm lamp with a glow that stays visible from afar.
  float dist = max(-mv.z, 0.1);
  float px = clamp(uScale * 900.0 / dist, 3.0, 28.0) * uPixelRatio;
  gl_PointSize = px;
  vColor = color * on * uExposure * 60.0 / (px * px) * uPixelRatio * uPixelRatio;
}`;

const LIGHTS_FRAG = /* glsl */ `
precision highp float;
in vec3 vColor;
out vec4 outColor;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(q, q);
  if (r2 > 1.0) discard;
  float core = exp(-r2 * 30.0) * 8.0;
  float halo = exp(-r2 * 5.0) * (1.0 - r2);
  outColor = vec4(min(vColor * (core + halo), vec3(6.0e4)), 1.0);
}`;

/** A small cube map of the sky around the ship, refreshed one face per frame. */
export class SkyProbe {
  readonly target: THREE.WebGLCubeRenderTarget;
  readonly camera: THREE.CubeCamera;
  private face = 0;
  private faces: THREE.PerspectiveCamera[];
  readonly maxLod: number;

  constructor(size: number, halfFloat: boolean) {
    this.target = new THREE.WebGLCubeRenderTarget(size, {
      type: halfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });
    this.camera = new THREE.CubeCamera(0.1, 10, this.target);
    this.faces = this.camera.children as THREE.PerspectiveCamera[];
    this.maxLod = Math.log2(size);
  }

  /** Render `faces` faces of the sky (round-robin); `draw` renders the sky with the given camera. */
  update(renderer: THREE.WebGLRenderer, draw: (camera: THREE.Camera) => void, faces = 1): void {
    const prevTarget = renderer.getRenderTarget();
    const cc = this.camera;
    if (cc.coordinateSystem !== renderer.coordinateSystem) {
      cc.coordinateSystem = renderer.coordinateSystem;
      cc.updateCoordinateSystem();
    }
    cc.updateMatrixWorld(true);
    for (let k = 0; k < faces; k++) {
      const f = this.face;
      this.face = (this.face + 1) % 6;
      // Only regenerate mipmaps after the last face of a sweep (as CubeCamera does).
      this.target.texture.generateMipmaps = f === 5;
      renderer.setRenderTarget(this.target, f);
      renderer.setClearColor(0x000000, 1);
      renderer.clear(true, false, false);
      draw(this.faces[f]);
    }
    this.target.texture.generateMipmaps = true;
    renderer.setRenderTarget(prevTarget);
  }

  dispose(): void {
    this.target.dispose();
  }
}

export interface ShipOptions {
  /** Geometry/shadow detail (quality.detail). */
  detail?: number;
  shadowSize?: number;
}

export class Ship {
  readonly group = new THREE.Group();
  readonly geometry: ShipGeometry;
  readonly hull: THREE.Mesh;
  readonly plume: EnginePlume;
  private hullMat: THREE.ShaderMaterial;
  private lights: THREE.Points;
  private lightsMat: THREE.ShaderMaterial;
  private shadowRT: THREE.WebGLRenderTarget;
  private shadowCam: THREE.OrthographicCamera;
  private shadowScene = new THREE.Scene();
  private shadowMesh: THREE.Mesh;
  private depthMat: THREE.MeshDepthMaterial;
  private keyDir = new THREE.Vector3(1, 1, 1).normalize();
  private lastShadowDir = new THREE.Vector3();
  private lastShadowQuat = new THREE.Quaternion();
  private biasM = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
  private tmpM = new THREE.Matrix4();
  thrust = 0;

  constructor(o: ShipOptions = {}) {
    const detail = o.detail ?? 1;
    this.geometry = buildShipGeometry(detail);
    const size = o.shadowSize ?? (detail >= 1 ? 2048 : 1024);
    this.shadowRT = new THREE.WebGLRenderTarget(size, size, {
      depthBuffer: true,
      depthTexture: new THREE.DepthTexture(size, size, THREE.UnsignedIntType),
    });
    this.shadowRT.depthTexture!.minFilter = THREE.NearestFilter;
    this.shadowRT.depthTexture!.magFilter = THREE.NearestFilter;
    const R = this.geometry.boundingRadius;
    this.shadowCam = new THREE.OrthographicCamera(-R, R, R, -R, 0.1, 4 * R);
    this.hullMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: HULL_VERT,
      fragmentShader: HULL_FRAG,
      uniforms: {
        uKeyDir: { value: new THREE.Vector3(1, 1, 1).normalize() },
        uKeyColor: { value: new THREE.Color(0, 0, 0) },
        uFillDir: { value: new THREE.Vector3(-1, 0, 0) },
        uFillColor: { value: new THREE.Color(0, 0, 0) },
        uEnv: { value: null },
        uEnvOn: { value: 0 },
        uEnvMaxLod: { value: 6 },
        uEnvGain: { value: 1 },
        uAmbient: { value: new THREE.Color(0.002, 0.002, 0.0025) },
        uEnginePos: { value: this.geometry.nozzle.clone().add(new THREE.Vector3(0, 0, 2.2)) },
        uEngineColor: { value: new THREE.Color(0.55, 0.45, 1.0) },
        uThrust: { value: 0 },
        uTime: { value: 0 },
        uShadowMap: { value: this.shadowRT.depthTexture },
        uShadowOn: { value: 1 },
        uShadowTexel: { value: 1 / size },
        uShadowMatrix: { value: new THREE.Matrix4() },
        uExposure: { value: 1 },
        uCockpit: { value: 0 },
      },
    });
    this.hull = new THREE.Mesh(this.geometry.hull, this.hullMat);
    this.hull.frustumCulled = false;
    this.group.add(this.hull);
    this.depthMat = new THREE.MeshDepthMaterial({ side: THREE.DoubleSide });
    this.shadowMesh = new THREE.Mesh(this.geometry.hull, this.depthMat);
    this.shadowMesh.matrixAutoUpdate = false;
    this.shadowScene.add(this.shadowMesh);

    // Navigation lights: red port, green starboard (nautical convention), white strobes, red beacon.
    const L = this.geometry.lights;
    const pos = new Float32Array(L.length * 3), col = new Float32Array(L.length * 3), ph = new Float32Array(L.length), kind = new Float32Array(L.length);
    L.forEach((l, i) => {
      l.position.toArray(pos, i * 3);
      const c = l.kind === 'port' ? [1, 0.05, 0.03] : l.kind === 'starboard' ? [0.05, 1, 0.25] : l.kind === 'strobe' ? [1, 1, 1] : [1, 0.08, 0.04];
      col.set(c, i * 3);
      ph[i] = l.kind === 'strobe' ? (i % 2) * 0.12 : 0;
      kind[i] = l.kind === 'port' || l.kind === 'starboard' ? 0 : l.kind === 'strobe' ? 2 : 3;
    });
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    lg.setAttribute('color', new THREE.BufferAttribute(col, 3));
    lg.setAttribute('phase', new THREE.BufferAttribute(ph, 1));
    lg.setAttribute('kind', new THREE.BufferAttribute(kind, 1));
    this.lightsMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: LIGHTS_VERT,
      fragmentShader: LIGHTS_FRAG,
      uniforms: { uTime: { value: 0 }, uPixelRatio: { value: 1 }, uExposure: { value: 1 }, uScale: { value: 0.12 } },
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    this.lights = new THREE.Points(lg, this.lightsMat);
    this.lights.frustumCulled = false;
    this.lights.renderOrder = 2;
    this.group.add(this.lights);

    this.plume = new EnginePlume(this.geometry.nozzle, this.geometry.nozzleRadius);
    this.plume.object.renderOrder = 3;
    this.group.add(this.plume.object);
  }

  /** Direction to the key star (world frame) and its illuminance (display units × exposure). */
  setKeyLight(dirWorld: THREE.Vector3, illuminance: THREE.Color): void {
    this.keyDir.copy(dirWorld).normalize();
    (this.hullMat.uniforms.uKeyDir.value as THREE.Vector3).copy(this.keyDir);
    (this.hullMat.uniforms.uKeyColor.value as THREE.Color).copy(illuminance);
  }
  setFillLight(dirWorld: THREE.Vector3, illuminance: THREE.Color): void {
    (this.hullMat.uniforms.uFillDir.value as THREE.Vector3).copy(dirWorld).normalize();
    (this.hullMat.uniforms.uFillColor.value as THREE.Color).copy(illuminance);
  }
  /** Sky probe for reflections/ambient (null → flat ambient). */
  setEnvironment(probe: SkyProbe | null, gain = 1): void {
    const u = this.hullMat.uniforms;
    u.uEnv.value = probe ? probe.target.texture : null;
    u.uEnvOn.value = probe ? 1 : 0;
    u.uEnvMaxLod.value = probe ? probe.maxLod : 6;
    u.uEnvGain.value = gain;
  }
  set exposure(e: number) {
    this.hullMat.uniforms.uExposure.value = e;
    this.lightsMat.uniforms.uExposure.value = e;
    this.plume.exposure = e;
  }
  /** Seconds (blinking lights, plume flicker). */
  setTime(t: number): void {
    this.hullMat.uniforms.uTime.value = t;
    this.lightsMat.uniforms.uTime.value = t;
    this.plume.time = t;
  }
  setThrust(t: number): void {
    this.thrust = t;
    this.hullMat.uniforms.uThrust.value = t;
    this.plume.thrust = t;
    const c = this.plume.color;
    (this.hullMat.uniforms.uEngineColor.value as THREE.Color).setRGB(c.r * this.plume.brightness, c.g * this.plume.brightness, c.b * this.plume.brightness);
  }
  set pixelRatio(pr: number) {
    this.lightsMat.uniforms.uPixelRatio.value = pr;
    this.plume.pixelRatio = pr;
  }
  set shadows(on: boolean) {
    this.hullMat.uniforms.uShadowOn.value = on ? 1 : 0;
  }
  /** Hide the canopy glow etc. when the camera sits in the cockpit. */
  set cockpit(on: boolean) {
    this.hullMat.uniforms.uCockpit.value = on ? 1 : 0;
  }

  /**
   * Re-render the shadow map when the light or the ship's attitude changed. Call before drawing,
   * with the ship's world matrix up to date (the ship layer's world = camera-relative frame).
   */
  updateShadow(renderer: THREE.WebGLRenderer): void {
    this.group.updateMatrixWorld(true);
    const q = this.group.quaternion;
    if (this.keyDir.dot(this.lastShadowDir) > 0.99999 && Math.abs(q.dot(this.lastShadowQuat)) > 0.9999999) {
      this.updateShadowMatrix();
      return;
    }
    this.lastShadowDir.copy(this.keyDir);
    this.lastShadowQuat.copy(q);
    const R = this.geometry.boundingRadius;
    const c = this.group.position;
    this.shadowCam.position.copy(c).addScaledVector(this.keyDir, 2 * R);
    this.shadowCam.up.set(0, 1, 0);
    if (Math.abs(this.keyDir.y) > 0.99) this.shadowCam.up.set(1, 0, 0);
    this.shadowCam.lookAt(c);
    this.shadowCam.updateMatrixWorld(true);
    this.shadowCam.updateProjectionMatrix();
    this.shadowMesh.matrix.copy(this.hull.matrixWorld);
    this.shadowMesh.matrixWorld.copy(this.hull.matrixWorld);
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.shadowRT);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, true, false);
    renderer.render(this.shadowScene, this.shadowCam);
    renderer.setRenderTarget(prev);
    this.updateShadowMatrix();
  }

  private updateShadowMatrix(): void {
    const m = this.hullMat.uniforms.uShadowMatrix.value as THREE.Matrix4;
    this.tmpM.multiplyMatrices(this.shadowCam.projectionMatrix, this.shadowCam.matrixWorldInverse);
    m.multiplyMatrices(this.biasM, this.tmpM);
  }

  dispose(): void {
    this.geometry.hull.dispose();
    this.hullMat.dispose();
    this.lights.geometry.dispose();
    this.lightsMat.dispose();
    this.depthMat.dispose();
    this.shadowRT.dispose();
    this.plume.dispose();
  }
}
