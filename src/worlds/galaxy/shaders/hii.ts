import { COMMON_GLSL } from '../../../shaders/lib/common';
import { GALAXY_COMMON_GLSL, GALAXY_PARTICLE_GLSL, GALAXY_UNIFORMS_GLSL } from './galaxyGlsl';
import { ERF_GLSL, ISM_GLSL, ISM_LOCAL_COLUMN_GLSL, ISM_UNIFORMS_GLSL } from './ismGlsl';

/**
 * HII regions: every massive young star (m ≳ 12 M☉) ionises a Strömgren sphere around itself.
 *   Q_H(m)   ionising photons/s (Martins et al. 2005 fit, as physics/galaxyStars.ionisingPhotonRate)
 *   R_S      = (3 Q / 4π n² α_B)^{1/3},  α_B = 2.6 × 10⁻¹³ cm³ s⁻¹ (10⁴ K)
 *   R(age)   = R_S (1 + 7 c_i t / 4 R_S)^{4/7}  (Spitzer D-type expansion, c_i ≈ 10 km/s)
 *   L_lines  = 0.6 · 0.45 · hν_Hα · Q · 3  (case B; Hα ≈ ⅓ of the optical line energy)
 * The region is drawn as a centrally concentrated emission measure (∝ (1 − q²)²), pink from Hα + Hβ, with a
 * teal [OIII] core around the hottest stars; it fades when its star dies. Extinction as for stars.
 */
export const HII_VERT = /* glsl */ `
precision highp float;
precision highp int;
${GALAXY_UNIFORMS_GLSL}
${ISM_UNIFORMS_GLSL}
${COMMON_GLSL}
${GALAXY_COMMON_GLSL}
${ERF_GLSL}
${ISM_LOCAL_COLUMN_GLSL}
${ISM_GLSL}
${GALAXY_PARTICLE_GLSL}
in vec4 a0;
in vec4 a1;
in vec4 a2;
uniform vec3 uCamModel;
uniform vec3 uOrigin;
uniform float uFluxToRad;
uniform float uMinRad;
uniform float uMaxSize;
uniform float uPxPerRad;
uniform int uExtSamples;
uniform float uDensity;     // n_e (cm⁻³)
uniform float uGain;
uniform float uYoungMult;  // stars per young particle
uniform vec3 uColHII;       // luminance-normalised line colours × line efficacy
uniform vec3 uColOIII;
uniform float uMode;
uniform sampler2D uStatePos;
uniform int uStateW;
uniform float uSwitchTime;
out vec3 vColor;
out vec3 vCore;
out float vR;
out float vSize;

void cull() {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  gl_PointSize = 0.0;
  vColor = vec3(0.0);
  vCore = vec3(0.0);
  vR = 1.0;
  vSize = 0.0;
}

void main() {
  float mass = a1.x;
  if (a0.x < 2.5 || a0.x > 3.5 || mass < 12.0) { cull(); return; }
  float tau = a1.y, Tc = a1.z, off = a1.w;
  float tt = uTime + off;
  float age = tt - floor(tt / Tc) * Tc;
  if (age > tau) { cull(); return; }
  vec3 P;
  float L, T;
  particleState(a0, a1, a2, uTime, P, L, T);
  if (uMode > 0.5) {
    int id = gl_VertexID;
    P = texelFetch(uStatePos, ivec2(id % uStateW, id / uStateW), 0).xyz;
    if (floor((uSwitchTime + off) / Tc) != floor(tt / Tc)) L = 0.0;
  }
  if (L <= 0.0) { cull(); return; }

  float lm = log(mass / 20.0) * 0.4342944819;
  float lq = mass < 20.0 ? 48.0 + 8.0 * lm : mass < 30.0 ? 48.0 + 5.1 * lm : 48.9 + 3.2 * log(mass / 30.0) * 0.4342944819;
  float Q = pow(10.0, lq - 48.0);                        // in units of 10⁴⁸ s⁻¹
  // R_S in pc: (3Q / 4π n² α_B)^{1/3} = 31.5 pc for Q = 10⁴⁸ s⁻¹, n = 1 cm⁻³.
  float rS = 31.5 * pow(Q * uYoungMult / (uDensity * uDensity), 1.0 / 3.0);
  float R = rS * pow(1.0 + 7.0 * 10.2 * age / (4.0 * rS), 4.0 / 7.0);
  // Line luminosity (L☉): 0.6·0.45·3.03e-12 erg · 3 · Q / L☉ = 6.41e2 L☉ per 10⁴⁸ s⁻¹.
  float Lline = 641.0 * Q * uSfrBright * uYoungMult;
  // Fade in over the first 0.3 Myr and out over the last 15% of the star's life.
  Lline *= smoothstep(0.0, 0.3, age) * (1.0 - smoothstep(0.85 * tau, tau, age));

  vec3 world = toRender(P) - uOrigin;
  vec4 mv = viewMatrix * vec4(world, 1.0);
  float d2 = dot(mv.xyz, mv.xyz);
  if (mv.z > -1e-3) { cull(); return; }
  float rad = Lline * uGain * uFluxToRad / max(d2, 1e-4);
  if (rad < uMinRad) { cull(); return; }
  float tauD = dustColumn(uCamModel, P, uExtSamples);
  vec3 trans = exp(-tauD * uExtRGB);
  // Hotter (more massive) stars → higher excitation → more [OIII] in the core.
  float exc = clamp((mass - 18.0) / 40.0, 0.0, 1.0);
  vec3 col = uColHII * rad * trans;
  if (dot(col, vec3(0.2126, 0.7152, 0.0722)) < uMinRad) { cull(); return; }
  float Rpx = R / sqrt(d2) * uPxPerRad;
  float Reff = max(Rpx, 1.2);
  float size = min(2.0 * Reff + 2.0, uMaxSize);
  Reff = min(Reff, 0.5 * size - 1.0);
  gl_PointSize = size;
  vSize = size;
  vR = Reff;
  // Emission measure ∝ (1 − q²)²: centrally concentrated gas with a soft, ragged ionisation front
  // rather than a hard-edged uniform sphere; ∫ over the disk = (π/3) R².
  vColor = col * (1.0 - 0.45 * exc) / (1.0471976 * Reff * Reff);
  vCore = uColOIII * rad * trans * 0.45 * exc / (0.4 * 3.14159265 * Reff * Reff);
  gl_Position = projectionMatrix * mv;
}
`;

export const HII_FRAG = /* glsl */ `
precision highp float;
in vec3 vColor;
in vec3 vCore;
in float vR;
in float vSize;
out vec4 outColor;
void main() {
  vec2 q = (gl_PointCoord - 0.5) * vSize / vR;
  float r2 = dot(q, q);
  if (r2 >= 1.0) discard;
  float em = (1.0 - r2) * (1.0 - r2);
  float core = exp(-r2 / 0.2);              // [OIII] zone: the inner, most highly ionised gas
  outColor = vec4(vColor * em + vCore * core, 1.0);
}
`;
