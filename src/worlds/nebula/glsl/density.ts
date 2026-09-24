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
  // Molecular cloud: a floor and a back wall, both corrugated, inside an organic envelope
  // (a finite cloud, so the simulation cube never shows).
  float floorY = -1.7 + 1.0 * fbm3(vec3(p.x * 0.24, 1.7, p.z * 0.24) + uSeedOff, 4);
  float backZ = -2.3 + 0.7 * fbm3(vec3(p.x * 0.2, p.y * 0.2, 4.2) + uSeedOff.yzx, 4);
  float inCloud = max(smoothstep(0.3, -0.3, p.y - floorY - 0.35 * g2), smoothstep(0.4, -0.4, p.z - backZ - 0.45 * g2));
  // Ragged outer edge: the cloud thins out along fractal lanes instead of ending on a surface.
  float edgeN = fbm3(s * 0.55 + 21.0, 5);
  vec3 ec = (p - vec3(-0.3, -1.0, -1.1)) / vec3(1.25, 0.95, 0.9);
  float envelope = 1.0 - smoothstep(0.55 * uHalf, 1.0 * uHalf, length(ec) * (1.0 + 0.55 * edgeN));
  inCloud *= envelope;
  // Cavity blown by the cluster's winds and radiation pressure.
  float rs = length(p - uSource);
  float R = uCavityR * (1.0 + 0.3 * g1 + 0.12 * g2);
  float cloud = inCloud * smoothstep(R - 0.3, R + 0.3, rs);
  // Smooth, large-scale lognormal structure on the walls; small scales come from the detail field.
  float n = 2200.0 * cloud * exp(1.0 * g2 + 0.2 * g3);
  // Tenuous, streaky ionized gas filling the cavity (and only the cavity), denser toward its walls.
  vec3 radial = (p - uSource) / max(rs, 1e-3);
  float streak = fbm3(radial * 3.2 + s * 0.2 + 7.7, 4);
  float bubble = 1.0 - smoothstep(0.85 * R, 1.25 * R, rs);
  n += 14.0 * exp(1.5 * g1 + 0.9 * streak) * (0.3 + 0.7 * smoothstep(0.2 * R, R, rs)) * bubble * (0.4 + 0.6 * envelope);
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

/**
 * Planetary nebulae (photo layout). The central white dwarf sits at the origin. Shapes follow
 * the kinematic 3D models: M57 as a thick equatorial barrel seen nearly pole-on with faint
 * prolate lobes and a halo of concentric arcs from periodic AGB mass loss (O'Dell et al. 2013;
 * JWST 2023); NGC 7293 as two nearly perpendicular rings with radially elongated cometary
 * knots on the inner edge (O'Dell et al. 2004); NGC 6302 as a bipolar outflow pinched by a
 * dense, dusty equatorial torus (Szyszka et al. 2011).
 */
const PN_COMMON = /* glsl */ `
uniform vec3 uAxis;        // symmetry axis (unit)
uniform vec3 uAxis2;       // second axis (Helix outer ring)
uniform vec4 uShape;       // variant-specific radii (pc)
uniform vec4 uShape2;
float torusProfile(vec3 p, vec3 ax, float R, float w, float H, float ell) {
  float h = dot(p, ax);
  vec3 q = p - ax * h;
  // Elliptical ring: stretch one in-plane direction.
  vec3 e1 = normalize(cross(ax, vec3(0.0, 1.0, 0.0)) + vec3(1e-4));
  float x1 = dot(q, e1);
  vec3 q2 = q - e1 * x1;
  float rho = length(e1 * x1 / ell + q2);
  return exp(-sq((rho - R) / w)) * exp(-sq(h / H));
}
`;

const RING = PN_COMMON + /* glsl */ `
vec4 nebDensity(vec3 p) {
  vec3 s = p + uSeedOff;
  float r = length(p);
  float g1 = fbm3(s * 9.0, 5);
  float g2 = fbm3(s * 22.0 + 4.1, 4);
  float h = dot(p, uAxis);
  float rho = length(p - uAxis * h);
  // Knots: cellular clumps concentrated in the ring (JWST counts ~20 000 of them).
  vec2 wv = worley3(s * 34.0);
  float knots = smoothstep(0.42, 0.12, wv.x);
  float ring = torusProfile(p * (1.0 + 0.08 * g1), uAxis, uShape.x, uShape.y, uShape.z, uShape.w);
  float n = 900.0 * ring * exp(0.9 * g2) * (0.55 + 2.2 * knots * knots);
  // Prolate inner cavity + faint lobes along the axis (seen end-on, they fill the ring's hole).
  float e = length(vec2(rho / (uShape.x * 0.95), h / (uShape.x * 2.1)));
  n += 210.0 * exp(-sq((e - 1.0) / 0.35)) * exp(0.5 * g1) * step(0.0, 1.35 - e);
  n += 140.0 * (1.0 - smoothstep(0.6, 1.0, e)) * exp(0.4 * g2);
  // Halo with concentric arcs (spacing ≈ 0.022 pc), broken into petals.
  float halo = smoothstep(uShape.x * 1.3, uShape.x * 1.6, r) * (1.0 - smoothstep(uShape2.x * 0.7, uShape2.x, r * (1.0 + 0.25 * g1)));
  float arcs = pow(0.5 + 0.5 * cos(6.2831853 * r / uShape2.y + 2.0 * g1), 5.0);
  float petals = smoothstep(-0.2, 0.35, fbm3(normalize(p) * 3.0 + uSeedOff, 4));
  n += halo * (7.0 + 32.0 * arcs * petals) * exp(0.6 * g2);
  return vec4(n, 1.0, 0.0, 0.0);
}
`;

const HELIX = PN_COMMON + /* glsl */ `
vec4 nebDensity(vec3 p) {
  vec3 s = p + uSeedOff;
  float r = length(p);
  vec3 dir = p / max(r, 1e-4);
  float g1 = fbm3(s * 3.2, 5);
  float g2 = fbm3(s * 9.0 + 7.3, 4);
  float inner = torusProfile(p * (1.0 + 0.1 * g1), uAxis, uShape.x, uShape.y, uShape.z, uShape.w);
  float outer = torusProfile(p * (1.0 + 0.12 * g1), uAxis2, uShape2.x, uShape2.y, uShape2.z, uShape2.w);
  float n = (260.0 * inner + 150.0 * outer) * exp(0.8 * g2);
  // Cometary knots: radially elongated clumps on the inner edge of the inner ring.
  vec2 wk = worley3(vec3(dir * 26.0) + vec3(r * 3.2) + uSeedOff);
  float band = smoothstep(uShape.x * 0.55, uShape.x * 0.8, r) * (1.0 - smoothstep(uShape.x * 0.95, uShape.x * 1.15, r));
  float knot = smoothstep(0.34, 0.1, wk.x) * band * smoothstep(0.1, 0.6, inner + 0.25);
  n = max(n, 6000.0 * knot * exp(0.5 * g2));
  // Diffuse interior and a faint envelope.
  n += 40.0 * (1.0 - smoothstep(uShape.x * 0.6, uShape.x, r)) * exp(0.4 * g1);
  n += 10.0 * (1.0 - smoothstep(uShape2.x * 0.9, uShape2.x * 1.35, r)) * smoothstep(0.1, 0.6, 0.5 + g1);
  return vec4(n, 1.0, 0.0, 0.0);
}
`;

const BUTTERFLY = PN_COMMON + /* glsl */ `
vec4 nebDensity(vec3 p) {
  vec3 s = p + uSeedOff;
  float h = dot(p, uAxis);
  vec3 q = p - uAxis * h;
  float rho = length(q);
  float ah = abs(h);
  float L = uShape.x;           // lobe length
  float W = uShape.y;           // lobe half-width
  float t = clamp(ah / L, 0.0, 1.0);
  // Hourglass: narrow waist, broad ragged wings that close at the tips.
  float Rl = W * pow(sin(3.14159 * t), 0.75) * (0.25 + 0.75 * sqrt(t)) + 0.012;
  vec3 dir = p / max(length(p), 1e-4);
  float streak = fbm3(dir * 7.0 + uSeedOff, 5);
  float g2 = fbm3(s * 7.0 + 3.3, 4);
  Rl *= 1.0 + 0.35 * streak;
  float shell = exp(-sq((rho - Rl) / (0.06 + 0.25 * Rl)));
  float fill = (1.0 - smoothstep(0.7 * Rl, Rl, rho)) * 0.45;
  float tipFade = 1.0 - smoothstep(0.85, 1.0, t);
  float n = 700.0 * (shell + fill) * tipFade * exp(0.9 * g2 + 0.6 * streak);
  // Dense, dusty equatorial torus that hides the star behind a dark lane.
  float torus = exp(-sq((rho - uShape.z) / uShape.w)) * exp(-sq(h / (0.6 * uShape.w)));
  float dustMod = 1.0 + 5.0 * torus;
  n = max(n, 30000.0 * torus * exp(0.6 * g2));
  return vec4(n, dustMod, 0.0, 0.0);
}
`;

const SOURCES: Partial<Record<NebulaVariant, string>> = {
  pillars: PILLARS,
  ring: RING,
  helix: HELIX,
  butterfly: BUTTERFLY,
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
  vec3 e = 1.0 - smoothstep(vec3(0.72 * uHalf), vec3(0.98 * uHalf), abs(p));
  d.x *= e.x * e.y * e.z;
  outColor = d;
}`;
}
