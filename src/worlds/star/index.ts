import * as THREE from 'three';
import type { StarSpec, StarView } from '../planet/types';
import { COMMON_GLSL } from '../../shaders/lib/common';
import { NOISE_GLSL } from '../../shaders/lib/noise';
import { BLACKBODY_GLSL } from '../../shaders/lib/blackbody';
import { Rng } from '../../physics/random';
import { lineColor, planckRatio555 } from '../../physics/planets-photometry';
import { blackbodyRGB } from '../../physics/blackbody';

/**
 * A star (planets module): photosphere ray-traced on an exact sphere with
 *  - limb darkening and limb reddening from the Eddington grey atmosphere via the Eddington–Barbier
 *    relation, I_λ(μ) ≈ B_λ(T(τ = μ)), T⁴(τ) = ¾T_eff⁴(τ + ⅔) — colour from the blackbody at T(μ);
 *  - granulation (convection cells, ~1 Mm, lifetime ~10 min) and supergranulation network;
 *  - sunspots (umbra ~0.7 T_eff, filamentary penumbra ~0.9 T_eff) in activity belts, faculae that
 *    brighten toward the limb, all carried by differential rotation Ω(φ) = A + B sin²φ + C sin⁴φ;
 *  - a faint K-corona with streamers (brightness ∝ r^−2.5…−3) and Hα prominences at the limb.
 * Radiance at disk centre ≈ 40 × intensity (bloom-friendly); set `intensity` for physical scenes
 * (the Sun seen from 1 AU in renderer units is ≈ 46 000).
 */

export interface StarRenderer extends StarView {
  /** Disk-centre radiance multiplier (live). */
  setIntensity(v: number): void;
  /** Linear colour of the starlight (luminance 1), for lighting planets. */
  readonly lightColor: THREE.Color;
}

const STAR_VERT = /* glsl */ `
out vec3 vPos;
void main() {
  vPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const STAR_FRAG = /* glsl */ `
precision highp float;
${COMMON_GLSL}
${NOISE_GLSL}
${BLACKBODY_GLSL}
uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;
in vec3 vPos;
out vec4 outColor;
uniform vec3 uCamPos;
uniform float uTeff;
uniform float uIntensity;
uniform float uTime;        // days
uniform float uActivity;
uniform vec4 uSpots[12];    // lat, lon, radius (rad), strength
uniform int uSpotCount;
uniform float uPixelAngle;
uniform float uPixelRadius;
uniform float uSeed;
uniform int uDepthMode;

// Visible-band Planck ratio B555(T)/B555(T0).
float planck555(float T, float T0) { return (exp(25925.0 / T0) - 1.0) / (exp(25925.0 / T) - 1.0); }

float depthOf(vec3 pObj) {
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(pObj, 1.0);
  float z = clip.z / clip.w;
  return uDepthMode == 1 ? z : z * 0.5 + 0.5;
}

void main() {
  vec3 ro = vPos;
  vec3 rv = ro - uCamPos;
  float camDist = length(rv);
  vec3 rd = rv / camDist;
  vec2 hit = raySphere(ro, rd, vec3(0.0), 1.0);
  if (hit.x > hit.y || uPixelRadius < 1.0) discard;   // sub-pixel: the point sprite takes over
  float t = hit.x >= -camDist ? hit.x : hit.y;
  vec3 p = ro + rd * t;
  vec3 n = normalize(p);
  float mu = clamp(dot(n, -rd), 0.0, 1.0);
  float lat = asin(clamp(n.y, -1.0, 1.0));
  float lon = atan(-n.z, n.x);
  // Differential rotation (solar: 14.713 − 2.396 sin²φ − 1.787 sin⁴φ °/day), relative to the frame.
  float s2 = sqr(sin(lat));
  float omega = radians(-2.396 * s2 - 1.787 * s2 * s2);
  // Shear accumulates without bound; spot groups live weeks, so wrap the shear over 60 days.
  float lonR = lon - omega * mod(uTime, 60.0);
  vec3 q = vec3(cos(lat) * cos(lonR), sin(lat), -cos(lat) * sin(lonR));
  float footprint = (t + camDist) * uPixelAngle;

  // Temperature perturbations: granulation (bright cells, dark lanes) + supergranular network.
  float dT = 0.0;
  float gScale = 180.0;
  float gDetail = smoothstep(4.0 / gScale, 0.5 / gScale, footprint);
  if (gDetail > 0.0) {
    float tt = uTime * 144.0;   // ~10-minute granule lifetimes
    // Granules live ~10 minutes: sample them unsheared (n), evolving in time.
    vec2 w1 = worley3(n * gScale + vec3(0.0, 0.0, tt * 0.05));
    vec2 w2 = worley3(n * gScale * 1.9 + vec3(tt * 0.04, 3.1, 0.0));
    float cell = smoothstep(0.0, 0.35, w1.y - w1.x);
    float fine = smoothstep(0.0, 0.3, w2.y - w2.x);
    dT += gDetail * (0.045 * (cell - 0.55) + 0.02 * (fine - 0.5));
  }
  float nDetail = smoothstep(4.0 / 22.0, 0.4 / 22.0, footprint);
  vec2 sg = worley3(q * 22.0 + vec3(uSeed));
  float network = 1.0 - smoothstep(0.0, 0.08, sg.y - sg.x);

  // Sunspots and faculae.
  float spot = 0.0, pen = 0.0, fac = 0.0;
  for (int i = 0; i < 12; i++) {
    if (i >= uSpotCount) break;
    vec4 s = uSpots[i];
    vec3 c = vec3(cos(s.x) * cos(s.y), sin(s.x), -cos(s.x) * sin(s.y));
    float d = acos(clamp(dot(q, c), -1.0, 1.0)) / s.z;
    if (d > 6.0) continue;
    vec3 dir = normalize(q - c * dot(q, c) + 1e-6);
    float ang = atan(dot(dir, cross(c, vec3(0.0, 1.0, 0.0))), dot(dir, vec3(0.0, 1.0, 0.0)));
    float fil = 0.8 + 0.2 * sin(ang * 40.0 + snoise(q * 90.0) * 3.0);
    spot = max(spot, s.w * (1.0 - smoothstep(0.35, 0.5, d)));
    pen = max(pen, s.w * (1.0 - smoothstep(0.85, 1.05, d)) * fil);
    fac = max(fac, s.w * exp(-sqr((d - 2.2) / 1.5)) * (0.6 + 0.4 * snoise(q * 60.0 + float(i))));
  }
  // Limb: Eddington–Barbier temperature for the local optical depth τ = μ.
  float Tmu = uTeff * pow(0.75 * (mu + 2.0 / 3.0), 0.25);
  float T = Tmu * (1.0 + dT);
  T = mix(T, uTeff * 0.9, pen);
  T = mix(T, uTeff * 0.68, spot);
  // Faculae and network show best near the limb (hot walls seen obliquely).
  float limbBoost = pow(1.0 - mu, 1.5);
  T *= 1.0 + (0.05 * fac * uActivity + 0.02 * network * nDetail) * limbBoost;
  float T1 = uTeff * pow(1.25, 0.25);     // disk-centre temperature
  vec3 col = blackbody(T) * planck555(T, T1) * uIntensity;
  // Thin chromospheric rim (Hα-pink) right at the limb.
  col += vec3(1.0, 0.25, 0.3) * uIntensity * 0.02 * smoothstep(0.08, 0.0, mu);
  outColor = vec4(col, 1.0);
  gl_FragDepth = depthOf(p);
}`;

const CORONA_VERT = /* glsl */ `
uniform float uExtent;
out vec2 vQ;
void main() {
  // Camera-facing quad of half-size uExtent (stellar radii) around the centre.
  vQ = position.xy * uExtent;
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float s = length(vec3(modelMatrix[0].xyz));
  mv.xy += position.xy * uExtent * s;
  gl_Position = projectionMatrix * mv;
}`;

const CORONA_FRAG = /* glsl */ `
precision highp float;
${COMMON_GLSL}
${NOISE_GLSL}
in vec2 vQ;
out vec4 outColor;
uniform float uIntensity;
uniform float uCorona;
uniform float uActivity;
uniform float uTime;
uniform vec3 uCoronaColor;
uniform vec3 uHalpha;
uniform float uSeed;
void main() {
  float b = length(vQ);
  if (b < 1.0) discard;
  float ang = atan(vQ.y, vQ.x);
  vec2 cs = vec2(cos(ang), sin(ang));
  float h = b - 1.0;
  // K-corona: steep power law with helmet streamers (brighter at low latitudes) and polar plumes.
  float streamers = 0.55 + 0.45 * snoise(vec3(cs * 2.2, uSeed)) + 0.25 * snoise(vec3(cs * 7.0, uSeed + 3.0));
  streamers *= mix(0.6, 1.0, sqr(cs.x));
  float corona = pow(b, -3.0) * max(streamers, 0.08) * uCorona;
  // Prominences: Hα loops a few % of R above the limb.
  float loops = snoise(vec3(cs * 9.0, uSeed + uTime * 0.2)) * 0.5 + 0.5;
  float arch = abs(snoise(vec3(cs * 26.0, h * 14.0 + uSeed)));
  float prom = smoothstep(0.72, 0.9, loops) * smoothstep(0.25, 0.0, arch) * exp(-h / 0.045) * smoothstep(0.0, 0.004, h);
  // Spicule forest just above the chromosphere.
  float spic = exp(-h / 0.006) * (0.5 + 0.5 * snoise(vec3(cs * 180.0, uTime * 3.0)));
  vec3 col = uCoronaColor * corona * 0.004 + uHalpha * (prom * 0.08 * uActivity + spic * 0.015);
  outColor = vec4(col * uIntensity, 1.0);
}`;

const STAR_POINT_VERT = /* glsl */ `
uniform float uWorldRadius;
uniform float uViewportH;
uniform vec3 uColor;
uniform float uIntensity;
out vec3 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  gl_Position = projectionMatrix * mv;
  float rpx = uWorldRadius / max(-mv.z, 1e-12) * projectionMatrix[1][1] * 0.5 * uViewportH;
  float on = (rpx < 1.0 && mv.z < 0.0) ? 1.0 : 0.0;
  gl_PointSize = on * 5.0;
  vColor = uColor * uIntensity * (3.14159265 * rpx * rpx) / 3.53 * on;
}`;

const STAR_POINT_FRAG = /* glsl */ `
precision highp float;
in vec3 vColor;
out vec4 outColor;
void main() {
  vec2 q = (gl_PointCoord - 0.5) * 5.0;
  outColor = vec4(vColor * exp(-dot(q, q) / (2.0 * 0.75 * 0.75)), 1.0);
}`;

export function createStar(spec: StarSpec): StarRenderer {
  const rng = new Rng(spec.seed * 31 + 5);
  const T = spec.temperatureK;
  const activity = spec.activity ?? 0.5;
  const object = new THREE.Group();
  object.name = 'star';
  const body = new THREE.Group();
  body.scale.setScalar(spec.radius);
  object.add(body);

  // Spot groups in the activity belts (Spörer: ±5–35°), leading/following pairs.
  const spots: THREE.Vector4[] = [];
  const nGroups = Math.round(activity * 6);
  for (let g = 0; g < nGroups && spots.length < 12; g++) {
    const lat = (rng.next() < 0.5 ? -1 : 1) * rng.range(6, 32) * (Math.PI / 180);
    const lon = rng.range(-Math.PI, Math.PI);
    const r = rng.range(0.008, 0.022);
    spots.push(new THREE.Vector4(lat, lon, r, 1));
    if (spots.length < 12) spots.push(new THREE.Vector4(lat + rng.range(-0.02, 0.02), lon - rng.range(0.05, 0.12), r * rng.range(0.4, 0.8), 0.9));
  }
  while (spots.length < 12) spots.push(new THREE.Vector4(0, 0, 0.001, 0));

  const K = 40 * (spec.intensity ?? 1);
  // Disk-centre radiance normalisation: a hotter star is brighter per unit area (visible band).
  const surf = K * planckRatio555(T * Math.pow(1.25, 0.25), 5772 * Math.pow(1.25, 0.25)) ** 0.25;
  const uniforms = {
    uCamPos: { value: new THREE.Vector3(0, 0, 10) },
    uTeff: { value: T },
    uIntensity: { value: surf },
    uTime: { value: 0 },
    uActivity: { value: activity },
    uSpots: { value: spots },
    uSpotCount: { value: spots.length },
    uPixelAngle: { value: 1e-3 },
    uPixelRadius: { value: 1000 },
    uSeed: { value: rng.range(0, 100) },
    uDepthMode: { value: 0 },
  };
  const mat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: STAR_VERT, fragmentShader: STAR_FRAG, uniforms });
  const geo = new THREE.IcosahedronGeometry(1.0015, 16);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'star-photosphere';
  body.add(mesh);

  const ha = lineColor(656.28);
  const he = lineColor(587.56);
  const coronaMat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: CORONA_VERT,
    fragmentShader: CORONA_FRAG,
    uniforms: {
      uExtent: { value: 6 },
      uIntensity: { value: surf },
      uCorona: { value: spec.corona ?? 1 },
      uActivity: { value: activity },
      uTime: { value: 0 },
      uCoronaColor: { value: new THREE.Vector3(1, 0.97, 0.94) },
      uHalpha: { value: new THREE.Vector3(ha[0] * 0.85 + he[0] * 0.15, ha[1] * 0.85 + he[1] * 0.15, ha[2] * 0.85 + he[2] * 0.15) },
      uSeed: { value: uniforms.uSeed.value },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const quad = new THREE.PlaneGeometry(2, 2);
  const corona = new THREE.Mesh(quad, coronaMat);
  corona.name = 'star-corona';
  corona.frustumCulled = false;
  body.add(corona);

  const tmpM = new THREE.Matrix4();
  const tmpP = new THREE.Vector3();
  mesh.onBeforeRender = (renderer, _s, camera) => {
    tmpM.copy(mesh.matrixWorld).invert();
    uniforms.uCamPos.value.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(tmpM);
    const rt = renderer.getRenderTarget();
    const h = rt ? rt.height : renderer.domElement.height;
    const p11 = camera.projectionMatrix.elements[5];
    uniforms.uPixelAngle.value = 2 / (p11 * h);
    mesh.getWorldPosition(tmpP);
    const worldR = spec.radius * (object.matrixWorld.getMaxScaleOnAxis() || 1);
    uniforms.uPixelRadius.value = (worldR / Math.max(tmpP.distanceTo(camera.position), 1e-12)) * p11 * 0.5 * h;
    const caps = renderer.capabilities as unknown as { reverseDepthBuffer?: boolean };
    uniforms.uDepthMode.value = caps.reverseDepthBuffer ? 1 : 0;
  };

  // Starlight colour (luminance 1) from the blackbody at T_eff.
  const [br, bg, bb] = blackbodyRGB(T);
  const by = 0.2126 * br + 0.7152 * bg + 0.0722 * bb;
  const lightColor = new THREE.Color().setRGB(br / by, bg / by, bb / by, THREE.LinearSRGBColorSpace);

  // Sub-pixel star: a flux-conserving point (disk-averaged radiance × π r², spread over a σ ≈ 0.75 px
  // Gaussian), so a distant star fades smoothly instead of flickering. Eddington limb darkening makes
  // the disk average ≈ 0.83 × the centre.
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
  pg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.5);
  const pointMat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: STAR_POINT_VERT,
    fragmentShader: STAR_POINT_FRAG,
    uniforms: {
      uWorldRadius: { value: spec.radius },
      uViewportH: { value: 1080 },
      uColor: { value: new THREE.Vector3(lightColor.r, lightColor.g, lightColor.b).multiplyScalar(0.83) },
      uIntensity: uniforms.uIntensity,
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const point = new THREE.Points(pg, pointMat);
  point.name = 'star-point';
  point.frustumCulled = false;
  point.onBeforeRender = (renderer) => {
    const rt = renderer.getRenderTarget();
    pointMat.uniforms.uViewportH.value = rt ? rt.height : renderer.domElement.height;
    pointMat.uniforms.uWorldRadius.value = spec.radius * (object.matrixWorld.getMaxScaleOnAxis() || 1);
  };
  object.add(point);

  return {
    object,
    spec,
    lightColor,
    update(u: { time: number; camera: THREE.Camera }) {
      uniforms.uTime.value = u.time / 86400;
      coronaMat.uniforms.uTime.value = u.time / 86400;
    },
    setIntensity(v: number) {
      const s = 40 * v * planckRatio555(T * Math.pow(1.25, 0.25), 5772 * Math.pow(1.25, 0.25)) ** 0.25;
      uniforms.uIntensity.value = s;
      coronaMat.uniforms.uIntensity.value = s;
    },
    dispose() {
      object.removeFromParent();
      geo.dispose();
      mat.dispose();
      quad.dispose();
      coronaMat.dispose();
      pg.dispose();
      pointMat.dispose();
    },
  };
}
