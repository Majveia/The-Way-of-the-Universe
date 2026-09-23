import { COMMON_GLSL } from '../../../shaders/lib/common';
import { NOISE_GLSL } from '../../../shaders/lib/noise';
import { NEBULA_COMMON_GLSL } from './common';
import type { NebulaVariant } from '../types';

/**
 * Density generators, one per nebula variant. Each defines `vec4 nebDensity(vec3 p)` for a point
 * p in nebula-local parsecs and returns:
 *   photo layout: (n_H [cm⁻³], dust-to-gas modifier, 0, 0)
 *   shock layout: (n_H of ambient gas [cm⁻³], signed distance to the shock sheet [pc],
 *                  sheet brightness, [OIII] fraction (shock-speed proxy))
 * The densities are lognormal-turbulent (the density PDF of supersonic turbulence,
 * Vázquez-Semadeni 1994; Padoan, Nordlund & Jones 1997) around analytic shapes.
 */

const PILLARS = /* glsl */ `
uniform vec3 uSource;
uniform float uCavityR;
uniform vec4 uPillarA[6];   // base.xyz, base radius
uniform vec4 uPillarB[6];   // unit axis.xyz, length
uniform int uPillarCount;
uniform vec4 uGlob[16];     // centre.xyz, radius
uniform int uGlobCount;

float pillarDist(vec3 p, vec4 A, vec4 B, float ph) {
  vec3 ax = B.xyz;
  float L = B.w;
  float r0 = A.w;
  vec3 q = p - A.xyz;
  float h = dot(q, ax);
  float t = clamp(h / L, 0.0, 1.0);
  vec3 side = normalize(cross(ax, vec3(0.0, 0.0, 1.0)) + vec3(1e-4));
  vec3 side2 = cross(ax, side);
  // The column wanders and swells like the Eagle's pillars; a denser head caps it.
  vec3 c = A.xyz + ax * clamp(h, 0.0, L) + (side * sin(2.3 * t + ph) + side2 * cos(1.7 * t + 2.0 * ph)) * (0.22 * r0 * t);
  float r = r0 * (1.0 - 0.45 * t) * (1.0 + 0.16 * sin(8.0 * t + 3.0 * ph));
  r += r0 * 0.26 * exp(-sq((t - 0.9) / 0.09));
  return length(p - c) - r;
}

vec4 nebDensity(vec3 p) {
  vec3 s = p + uSeedOff;
  float g1 = fbm3(s * 0.32, 5);
  float g2 = fbm3(s * 0.95 + 11.3, 5);
  float g3 = snoise(s * 2.7 + 3.1);
  // Molecular cloud: a floor and a back wall, both corrugated.
  float floorY = -1.35 + 1.1 * fbm3(vec3(p.x * 0.24, 1.7, p.z * 0.24) + uSeedOff, 4);
  float backZ = -2.0 + 1.1 * fbm3(vec3(p.x * 0.22, p.y * 0.22, 4.2) + uSeedOff.yzx, 4);
  float inCloud = max(smoothstep(0.3, -0.3, p.y - floorY - 0.35 * g2), smoothstep(0.4, -0.4, p.z - backZ - 0.45 * g2));
  // Cavity blown by the cluster's winds and radiation pressure.
  float rs = length(p - uSource);
  float R = uCavityR * (1.0 + 0.3 * g1 + 0.12 * g2);
  float cloud = inCloud * smoothstep(R - 0.3, R + 0.3, rs);
  float n = 2200.0 * cloud * exp(1.4 * g2 + 0.5 * g3);
  // Tenuous, streaky gas inside the cavity, denser toward its walls.
  vec3 radial = (p - uSource) / max(rs, 1e-3);
  float streak = fbm3(radial * 3.2 + s * 0.2 + 7.7, 4);
  n += 22.0 * exp(1.6 * g1 + 0.9 * streak) * (0.35 + 0.65 * smoothstep(0.2 * R, R, rs));
  // Pillars (elephant trunks) pointing at the cluster, with evaporating heads.
  vec3 wob = vec3(snoise(s * 1.6), snoise(s * 1.6 + 5.1), snoise(s * 1.6 + 9.7));
  vec3 pw = p + 0.1 * wob;
  for (int i = 0; i < 6; i++) {
    if (i >= uPillarCount) break;
    float d = pillarDist(pw, uPillarA[i], uPillarB[i], float(i) * 1.7) + 0.045 * g3;
    float m = smoothstep(0.05, -0.05, d);
    n = max(n, 6500.0 * m * exp(0.8 * g2 + 0.45 * g3));
  }
  // Bok globules and evaporating gaseous globules (EGGs).
  for (int i = 0; i < 16; i++) {
    if (i >= uGlobCount) break;
    float d = length(pw - uGlob[i].xyz) - uGlob[i].w * (1.0 + 0.35 * g3);
    n = max(n, 8000.0 * smoothstep(0.025, -0.025, d));
  }
  return vec4(n, 1.0, 0.0, 0.0);
}
`;

const SOURCES: Partial<Record<NebulaVariant, string>> = {
  pillars: PILLARS,
};

export function hasGenerator(v: NebulaVariant): boolean {
  return SOURCES[v] !== undefined;
}

/** Fragment shader that writes one z-layer of the density cube. */
export function densityFragment(variant: NebulaVariant): string {
  const body = SOURCES[variant] ?? SOURCES.pillars!;
  return /* glsl */ `
precision highp float;
uniform float uHalf;
uniform float uN;
uniform float uLayer;
uniform vec3 uSeedOff;
in vec2 vUv;
out vec4 outColor;
${COMMON_GLSL}
${NOISE_GLSL}
${NEBULA_COMMON_GLSL}
${body}
void main() {
  vec3 uvw = vec3(vUv, (uLayer + 0.5) / uN);
  vec3 p = (uvw * 2.0 - 1.0) * uHalf;
  vec4 d = nebDensity(p);
  // Soft fade toward the cube faces so the box is never visible.
  vec3 e = 1.0 - smoothstep(vec3(0.82 * uHalf), vec3(0.985 * uHalf), abs(p));
  d.x *= e.x * e.y * e.z;
  outColor = d;
}`;
}
