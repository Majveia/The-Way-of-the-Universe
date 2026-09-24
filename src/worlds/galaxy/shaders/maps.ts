import { NOISE_GLSL } from '../../../shaders/lib/noise';
import { GALAXY_COMMON_GLSL, GALAXY_UNIFORMS_GLSL } from './galaxyGlsl';

/**
 * Face-on ISM map in the pattern frame, log-polar (see ismGlsl.ts for the channel layout).
 *
 * Gas physics encoded here (Roberts 1969; Elmegreen 2011 review): inside corotation gas overtakes
 * the density wave and shocks on the arm's *upstream* (concave, inner) edge — the dust lane.
 * Stars form in the compressed gas and appear downstream: first HII regions (≲ 10 Myr, pink),
 * then blue associations drifting out of the arm. Outside corotation the order reverses.
 */
export const MAP_FRAG = /* glsl */ `
precision highp float;
precision highp int;
${GALAXY_UNIFORMS_GLSL}
${GALAXY_COMMON_GLSL}
${NOISE_GLSL}
in vec2 vUv;
out vec4 outColor;
uniform vec3 uMapGeom;       // ln Rmin, 1/ln(Rmax/Rmin), Rmin
uniform vec2 uSeedOff;
uniform vec3 uYoungEnv;      // scale length, rInner, rOuter
uniform vec4 uDustP;         // τ0 (smooth, at R = 0), scale length, hole radius, lane τ
uniform float uFloc;         // flocculence 0..1
uniform float uClump;        // clumpiness 0..1 (irregulars)
uniform float uArmFrac;      // fraction of star formation in arms
uniform float uTrunc;        // outer truncation radius of the gas disk
uniform vec2 uDiskSigma;     // thin-disk σ_R at 3.15 R_d (pc/Myr), R_d (pc)

float sq(float x) { return x * x; }

void main() {
  float R = exp(uMapGeom.x + vUv.x / uMapGeom.y);
  float phi = vUv.y * TAU_G;
  vec2 XY = R * vec2(cos(phi), sin(phi));

  // Downstream direction: +1 inside corotation (gas overtakes the pattern), −1 outside.
  float Om = lutAt(R, 0).x;
  float sd = clamp((Om - uOmegaP) / (0.12 * uOmegaP + 1e-5), -1.0, 1.0);

  vec2 q = XY + uSeedOff * 1000.0;
  float nLarge = fbm3(vec3(q / 3600.0, 1.7), 4);
  float nMid = fbm3(vec3(q / 950.0, 4.2), 5);
  float nFine = fbm3(vec3(q / 240.0, 9.1), 4);
  float nKnot = fbm3(vec3(q / 420.0, 13.3), 4);

  // Old stars: the kinematic density wave in linear theory, δΣ/Σ = −A m cot(i) sin m(φ − α),
  // reduced by the random epicycles exactly as the particles are: for Rayleigh-distributed
  // amplitudes of scale s = σ_R/κ the average of J₀(kX) is e^{−k²s²/2}, k = m cot(i)/R
  // (the Lin–Shu reduction factor of a hot disk).
  float oldMod = 1.0;
  if (uWaveM > 0.0) {
    float sig = uDiskSigma.x * exp(-(R - 3.15 * uDiskSigma.y) / (2.0 * uDiskSigma.y));
    float s = min(0.28 * R, sig / max(lutAt(R, 0).y, 1e-6));
    float kk = uWaveM * uWaveCot / R;
    float red = exp(-0.5 * kk * kk * s * s);
    float c = clamp(uWaveAmp * uWaveM * uWaveCot * red, 0.0, 0.85);
    oldMod = 1.0 - c * sin(uWaveM * (phi - waveAlpha(R))) * waveTaper(R);
  }

  float young = 0.0, hii = 0.0, lane = 0.0, armGas = 0.0;
  for (int k = 0; k < MAX_ARMS; k++) {
    if (k >= uArmCount) break;
    float w = armWeightK(k, R);
    if (w <= 0.0) continue;
    float sinI = uArmB[k].w;
    float sig = uArmB[k].z * R;
    // Flocculent arms wander and break up.
    float wig = uFloc * (0.22 * nLarge + 0.1 * nMid);
    float d = wrapPi(phi - armPhiK(k, R) + wig) * R * sinI;
    float brk = mix(1.0, smoothstep(-0.35, 0.25, nLarge + 0.3 * nMid), uFloc * 0.8);
    // Across the arm, in the direction of the gas flow: the shock and its dust lane first (upstream,
    // inner/concave edge inside corotation), then HII regions, then the young stars drifting out.
    young += w * brk * exp(-0.5 * sq((d - sd * 0.35 * sig) / (0.9 * sig)));
    hii += w * brk * exp(-0.5 * sq((d - sd * 0.1 * sig) / (0.55 * sig)));
    lane += w * mix(1.0, brk, 0.6) * exp(-0.5 * sq((d + sd * 0.8 * sig) / (0.45 * sig)));
    armGas += w * exp(-0.5 * sq((d + sd * 0.3 * sig) / (1.3 * sig)));
  }

  // Radial envelopes.
  float env = exp(-R / uYoungEnv.x) * gsmooth(uYoungEnv.y * 0.7, max(uYoungEnv.y, 1.0), R) * (1.0 - gsmooth(uYoungEnv.z * 0.8, uYoungEnv.z, R));
  float trunc = 1.0 - gsmooth(uTrunc * 0.85, uTrunc * 1.05, R);

  // Scattered (non-arm) star formation: clumps and a faint floor.
  float clumps = pow(max(0.0, nKnot + 0.25), 2.0) * (0.4 + 1.6 * uClump) + pow(max(0.0, nMid + 0.1), 3.0) * 2.0 * uClump;
  float field = (1.0 - uArmFrac) * clumps + 0.025;

  float youngS = env * (uArmFrac * young * (0.75 + 0.5 * max(0.0, nMid + 0.5)) + field * 0.9);
  // HII regions are knots: thresholded noise along the star-forming ridge.
  float knots = pow(max(0.0, nKnot + 0.12), 3.2) * 9.0 + 0.08 * pow(max(0.0, nFine + 0.3), 2.0);
  float hiiS = env * (uArmFrac * hii * knots + field * knots * 0.7);

  // Dust: a smooth exponential disk with a bar-swept hole, plus arm lanes and clumpy clouds.
  float hole = gsmooth(uDustP.z * 0.55, max(uDustP.z, 1.0), R);
  float smoothDust = uDustP.x * exp(-R / uDustP.y) * hole * (0.55 + 0.45 * (0.5 + 0.5 * nLarge));
  float clumpy = 0.6 + 0.8 * max(0.0, nMid + 0.35) + 0.35 * nFine;
  float laneDust = uDustP.w * (lane * clumpy + 0.22 * armGas * (0.6 + 0.6 * max(0.0, nMid + 0.4)));
  float flocDust = uFloc * uDustP.x * exp(-R / uDustP.y) * hole * 0.9 * max(0.0, nMid + 0.1) * (0.6 + 0.4 * nFine);
  float dust = (smoothDust * (0.75 + 0.25 * nFine) + (laneDust + flocDust) * hole) * trunc;

  outColor = vec4(oldMod, youngS * trunc, max(dust, 0.0), max(hiiS, 0.0) * trunc);
}
`;
