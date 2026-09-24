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
  float r = r0 * (1.0 - 0.42 * t) * (1.0 + 0.14 * sin(9.0 * t + 3.0 * ph) + 0.08 * sin(23.0 * t + ph));
  r += r0 * 0.3 * exp(-sq((t - 0.91) / 0.08));
  // Round the cap.
  float over = max(h - L, 0.0);
  r = sqrt(max(r * r - over * over * 4.0, 0.0));
  return length(p - c) - r;
}

vec4 nebDensity(vec3 p) {
  vec3 s = p + uSeedOff;
  float g1 = fbm3(s * 0.32, 5);
  float g2 = fbm3(s * 0.95 + 11.3, 5);
  float g3 = snoise(s * 2.7 + 3.1);
  // Molecular cloud: a floor the pillars grow out of and a far wall facing the cluster, both
  // corrugated, inside an organic envelope so the simulation cube never shows.
  float floorY = -2.8 + 0.6 * fbm3(vec3(p.x * 0.3, 1.7, p.z * 0.3) + uSeedOff, 4) + 0.1 * g1;
  // The far wall: the ionized face of the parent cloud, gently curved toward the cluster.
  float backZ = -2.7 + 0.5 * fbm3(vec3(p.x * 0.18, p.y * 0.18, 4.2) + uSeedOff.yzx, 4) + 0.085 * dot(p.xy - vec2(-0.3, 0.2), p.xy - vec2(-0.3, 0.2));
  float inFloor = smoothstep(0.25, -0.25, p.y - floorY - 0.25 * g2);
  float inBack = smoothstep(0.3, -0.3, p.z - backZ - 0.25 * g2);
  float inCloud = max(inFloor, inBack);
  // Ragged outer edge: the cloud thins along fractal lanes instead of ending on a surface.
  float edgeN = fbm3(s * 0.5 + 21.0, 5);
  // The envelope closes well inside the cube (the camera sees a wider field than the cube at the
  // wall's depth), with a strongly fractal rim: the cloud frays into black sky on every side.
  vec3 ec = (p - vec3(-0.25, -0.25, -1.6)) / vec3(1.05, 1.0, 0.8);
  float envelope = 1.0 - smoothstep(0.58 * uHalf, 0.95 * uHalf, length(ec) * (1.0 + 0.6 * edgeN + 0.2 * g1));
  inCloud *= envelope;
  // Cavity blown by the cluster's winds and radiation pressure.
  float rs = length(p - uSource);
  float R = uCavityR * (1.0 + 0.22 * g1 + 0.1 * g2);
  float cloud = inCloud * smoothstep(R - 0.35, R + 0.35, rs);
  // Lognormal density on the walls (supersonic turbulence), sharpened ridges.
  float n = 2000.0 * cloud * exp(0.9 * g2 + 0.15 * g3);
  // Tenuous, streaky ionized gas filling the cavity, denser toward its walls.
  vec3 radial = (p - uSource) / max(rs, 1e-3);
  float streak = fbm3(radial * 3.4 + s * 0.15 + 7.7, 4);
  float bubble = 1.0 - smoothstep(0.85 * R, 1.2 * R, rs);
  n += 22.0 * exp(1.2 * g1 + 0.9 * streak) * (0.3 + 0.7 * smoothstep(0.25 * R, R, rs)) * bubble * (0.35 + 0.65 * envelope);
  // Pillars (elephant trunks) pointing at the cluster, with evaporating heads.
  vec3 wob = vec3(snoise(s * 1.6), snoise(s * 1.6 + 5.1), snoise(s * 1.6 + 9.7));
  vec3 pw = p + 0.09 * wob;
  for (int i = 0; i < 6; i++) {
    if (i >= uPillarCount) break;
    float d = pillarDist(pw, uPillarA[i], uPillarB[i], float(i) * 1.7) + 0.05 * g3 + 0.03 * snoise(s * 7.0);
    float m = smoothstep(0.04, -0.04, d);
    // Denser toward the base (the column is still attached to its cloud), clumpy throughout.
    float h = clamp(dot(pw - uPillarA[i].xyz, uPillarB[i].xyz) / uPillarB[i].w, 0.0, 1.0);
    n = max(n, 7000.0 * m * exp(0.7 * g2 + 0.45 * g3 + 0.5 * (1.0 - h)));
  }
  // Bok globules and evaporating gaseous globules (EGGs).
  for (int i = 0; i < 16; i++) {
    if (i >= uGlobCount) break;
    float d = length(pw - uGlob[i].xyz) - uGlob[i].w * (1.0 + 0.35 * g3);
    n = max(n, 9000.0 * smoothstep(0.025, -0.025, d));
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
  n += 110.0 * exp(-sq((e - 1.0) / 0.3)) * exp(0.5 * g1) * step(0.0, 1.35 - e);
  n += 55.0 * (1.0 - smoothstep(0.6, 1.0, e)) * exp(0.4 * g2);
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
  float n = (75.0 * inner + 50.0 * outer) * exp(0.8 * g2);
  // Cometary knots: radially elongated clumps on the inner edge of the inner ring.
  vec2 wk = worley3(vec3(dir * 26.0) + vec3(r * 3.2) + uSeedOff);
  float band = smoothstep(uShape.x * 0.55, uShape.x * 0.8, r) * (1.0 - smoothstep(uShape.x * 0.95, uShape.x * 1.15, r));
  float knot = smoothstep(0.22, 0.06, wk.x) * band * smoothstep(0.1, 0.6, inner + 0.25);
  n = max(n, 6000.0 * knot * exp(0.5 * g2));
  // Diffuse interior and a faint envelope.
  n += 14.0 * (1.0 - smoothstep(uShape.x * 0.6, uShape.x, r)) * exp(0.4 * g1);
  n += 6.0 * (1.0 - smoothstep(uShape2.x * 0.9, uShape2.x * 1.35, r)) * smoothstep(0.1, 0.6, 0.5 + g1);
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
  // The torus is where the AGB wind was densest and grains formed: A_V of several magnitudes
  // across it (Matsuura et al. 2005) — the dark lane that hides the central star.
  float dustMod = 1.0 + 14.0 * torus;
  n = max(n, 12000.0 * torus * exp(0.6 * g2));
  return vec4(n, dustMod, 0.0, 0.0);
}
`;


/**
 * Voronoi cells with a per-cell identity: returns (F1, F2, hash of the nearest cell). Half the
 * cell walls separate cells of opposite "sign", giving a signed distance that the ray marcher
 * integrates as a thin sheet (see sheetSeg): a random cage of sheets seen edge-on as filaments.
 */
const CELLS = /* glsl */ `
vec3 cellWorley(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  float d1 = 8.0, d2 = 8.0;
  vec3 id = vec3(0.0);
  for (int z = -1; z <= 1; z++)
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec3 b = vec3(float(x), float(y), float(z));
    vec3 o = hash33(i + b);
    vec3 r = b + o - f;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; id = i + b; }
    else if (d < d2) { d2 = d; }
  }
  return vec3(sqrt(d1), sqrt(d2), hash13(id + 0.37));
}
`;

/**
 * Crab Nebula (shock layout). A cage of filaments — Rayleigh–Taylor fingers where the pulsar-wind
 * bubble pushes into the denser ejecta (Hester et al. 1996; Porth et al. 2014) — inside an
 * ellipsoidal shell. Cells are stretched radially, as the RT fingers are. Output:
 * (dust-bearing n, signed distance to the filament sheets [pc], brightness, [OIII] share).
 */
const CRAB = CELLS + /* glsl */ `
uniform vec3 uEllAxes;
uniform mat3 uEllRot;
uniform float uCell;
vec4 nebDensity(vec3 p) {
  vec3 s = p + uSeedOff;
  vec3 q = uEllRot * p;
  float g1 = fbm3(s * 1.2, 4);
  float g2 = fbm3(s * 3.1 + 5.0, 4);
  float e = length(q / uEllAxes) * (1.0 + 0.14 * g1);
  float r = length(p) + 1e-4;
  vec3 dir = p / r;
  // Radially stretched cells: compress the radial coordinate.
  vec3 pc = p - dir * r * 0.55;
  vec3 w = cellWorley(pc / uCell + uSeedOff);
  float sgn = w.z > 0.5 ? 1.0 : -1.0;
  float d = sgn * 0.5 * (w.y - w.x) * uCell;
  float shell = smoothstep(0.3, 0.62, e) * (1.0 - smoothstep(0.9, 1.04, e));
  float bright = shell * (0.15 + 1.4 * pow(clamp(0.55 + 0.9 * g2, 0.0, 1.5), 2.0)) * (0.6 + 0.4 * smoothstep(0.5, 0.95, e));
  float o3 = clamp(0.25 + 0.9 * smoothstep(0.82, 1.0, e) + 0.5 * g1, 0.0, 1.0);
  float n = 60.0 * shell * exp(-sq(d / 0.03)) * (0.5 + g2);
  return vec4(max(n, 0.0), d, bright, o3);
}
`;

/**
 * Cygnus Loop (shock layout): a Sedov–Taylor blast wave, a rippled spherical sheet. Radiative
 * (bright) where the shock has run into denser clouds — mostly on the east and west limbs —
 * and faint Balmer-dominated elsewhere. The ripples are what we see as threads (Hester 1987).
 */
const VEIL = /* glsl */ `
uniform float uShellR;
uniform vec3 uArc;
vec4 nebDensity(vec3 p) {
  float r = length(p) + 1e-4;
  vec3 dir = p / r;
  vec3 o = uSeedOff;
  float g1 = fbm3(dir * 1.3 + o, 5);
  float g2 = fbm3(dir * 3.5 + o.yzx, 4);
  // Folds on 1–3 pc scales: the sheet is corrugated, so edge-on views show many parallel threads.
  float fold = 0.9 * snoise(dir * 7.0 + o.zxy) + 0.25 * snoise(dir * 16.0 + o);
  // The south-west "blow-out" where the shock broke into a low-density cavity.
  float blow = smoothstep(0.35, 0.8, dot(dir, normalize(vec3(0.35, -0.9, 0.1))));
  float R = uShellR * (1.0 + 0.08 * g1 + 0.35 * blow * (0.5 + 0.5 * g2)) + fold;
  float d = r - R;
  float limb = pow(abs(dot(dir, uArc)), 2.5);
  float patchy = clamp(0.5 + 1.1 * g2, 0.0, 1.6);
  float bright = (0.004 + 3.0 * pow(limb, 2.5) * patchy * patchy * patchy + 0.03 * pow(max(g1 + 0.1, 0.0), 3.0)) * (1.0 - 0.9 * blow);
  // A bright northern patchy (Pickering's triangle analogue).
  bright += 1.1 * smoothstep(0.82, 0.97, dot(dir, normalize(vec3(-0.1, 0.95, 0.3)))) * patchy;
  float o3 = clamp(0.3 + 0.9 * g2 + 0.4 * limb, 0.0, 1.0);
  return vec4(0.6 * exp(-sq(d / 0.6)), d, bright, o3);
}
`;

/**
 * Horsehead (photo layout): the edge of the Orion B cloud (L1630) with the pillar B33 rising out
 * of it, lit from above by σ Ori. Above the ionization front, photoevaporated gas streams toward
 * the star (IC 434's striations); inside the cloud, NGC 2023's B star has blown a small cavity.
 */
const HORSEHEAD = /* glsl */ `
uniform vec3 uSource;
uniform vec4 uHorse;   // x offset, z depth, scale, lean
uniform vec3 uScat0;
float capsule(vec3 p, vec3 a, vec3 b, float ra, float rb) {
  vec3 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - mix(ra, rb, h);
}
float ellipsoid(vec3 p, vec3 c, vec3 r) {
  vec3 q = (p - c) / r;
  return (length(q) - 1.0) * min(r.x, min(r.y, r.z));
}
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}
float horseDist(vec3 p) {
  // Local frame: origin at the base of the neck, scale in pc.
  vec3 q = (p - vec3(uHorse.x, -0.95, uHorse.y)) / uHorse.z;
  q.xy = rot2(uHorse.w) * q.xy;
  float neck = capsule(q, vec3(0.2, -0.3, 0.0), vec3(0.08, 1.25, 0.0), 0.36, 0.2);
  float head = ellipsoid(q, vec3(-0.12, 1.5, 0.0), vec3(0.3, 0.27, 0.22));
  float snout = capsule(q, vec3(-0.2, 1.45, 0.0), vec3(-0.6, 1.08, 0.02), 0.15, 0.1);
  float jaw = ellipsoid(q, vec3(0.0, 1.3, 0.0), vec3(0.22, 0.18, 0.18));
  float ear = capsule(q, vec3(0.0, 1.66, 0.0), vec3(0.1, 1.9, -0.02), 0.07, 0.03);
  float mane = capsule(q, vec3(0.28, 0.4, 0.0), vec3(0.22, 1.55, 0.0), 0.12, 0.08);
  float d = smin(neck, head, 0.12);
  d = smin(d, snout, 0.1);
  d = smin(d, jaw, 0.08);
  d = smin(d, ear, 0.05);
  d = smin(d, mane, 0.1);
  return d * uHorse.z;
}
vec4 nebDensity(vec3 p) {
  vec3 s = p + uSeedOff;
  float g1 = fbm3(s * 0.45, 5);
  float g2 = fbm3(s * 1.3 + 11.3, 5);
  float g3 = snoise(s * 3.3 + 3.1);
  // Cloud surface: ragged, lower toward the left.
  float yE = -0.95 + 0.12 * p.x + 0.35 * fbm3(vec3(p.x * 0.4, 0.5, p.z * 0.4) + uSeedOff, 5) + 0.2 * g2;
  float cloud = smoothstep(0.12, -0.12, p.y - yE);
  // L1630 ends toward us in a ragged face that σ Ori's light (from above, behind B33) never
  // reaches: seen from Earth the photodissociation front is edge-on and the cloud's near side dark.
  cloud *= smoothstep(1.45, 1.0, p.z + 0.35 * g1 + 0.15 * g3);
  float n = 6000.0 * cloud * exp(0.7 * g2 + 0.3 * g3);
  // NGC 2023's cavity around the embedded B star.
  float cav = length(p - uScat0);
  n *= 0.12 + 0.88 * smoothstep(0.25, 0.75, cav * (1.0 + 0.3 * g3));
  // Photoevaporation flow above the front, streaming toward σ Ori; confined mostly behind the horse.
  vec3 toS = normalize(uSource - p);
  float h = max(p.y - yE, 0.0);
  vec3 rs = p - uSource;
  float striae = fbm3(normalize(rs) * 22.0 + vec3(length(rs) * 0.25) + uSeedOff.zxy, 4);
  float depth = smoothstep(0.1, -0.35, p.z) * smoothstep(-3.4, -2.0, p.z);
  float sides = 1.0 - smoothstep(2.0, 3.6, abs(p.x + 0.2) * (1.0 + 0.35 * g1));
  float flow = 30.0 * exp(-h / 2.2) * exp(1.1 * striae + 0.5 * g1) * depth * sides * (1.0 - cloud);
  n += flow;
  // The horse itself: dense, clumpy dust (B33).
  float d = horseDist(p + 0.05 * vec3(g3, g2, g1)) + 0.03 * g3;
  // n_H ≈ 2 × 10⁴ cm⁻³ (dense-core values, Pound et al. 2003; Hily-Blant et al. 2005): A_V > 10 mag
  // across the head, so it stays black except for the skin that σ Ori's light actually reaches.
  n = max(n, 20000.0 * smoothstep(0.035, -0.035, d) * exp(0.4 * g2));
  return vec4(n, 1.0, 0.0, 0.0);
}
`;

/**
 * Pleiades (photo layout, no ionizing photons): a sheet of diffuse dust drifting through the
 * cluster, striated along the magnetic field (Gibson & Nordsieck 2003), thinned where radiation
 * pressure from the brightest stars pushes grains away (the "bow" around Merope, IC 349).
 */
const PLEIADES = /* glsl */ `
uniform vec3 uBField;
uniform vec4 uStarsA[8];
vec4 nebDensity(vec3 p) {
  vec3 o = uSeedOff;
  vec3 a = normalize(uBField);
  vec3 b = normalize(cross(a, vec3(0.0, 0.0, 1.0)));
  vec3 c = cross(a, b);
  vec3 q = vec3(dot(p, a), dot(p, b), dot(p, c));
  float g1 = fbm3(p * 0.45 + o, 5);
  // Striations: long along the field, fine across it.
  float st = fbm3(vec3(q.x * 0.22, q.y * 2.6, q.z * 1.2) + o.yzx, 5);
  float fil = 1.0 - abs(snoise(vec3(q.x * 0.15, q.y * 3.8, q.z * 1.6) + o.zxy));
  float slab = exp(-sq((dot(p, normalize(vec3(0.15, 0.3, 1.0))) + 0.2 + 0.6 * g1) / 1.1));
  float env = 1.0 - smoothstep(1.2, 3.3, length(p * vec3(0.8, 1.0, 1.0)) * (1.0 + 0.7 * g1));
  // ≈ 20–60 cm⁻³ in the striations: A_V ≈ 0.1–0.5 mag toward the cluster (Gibson & Nordsieck
  // 2003) — a thin veil the stars shine through, bright only because they are so close.
  float n = 22.0 * slab * env * exp(1.4 * st + 1.1 * fil * fil - 0.4);
  for (int i = 0; i < 8; i++) {
    float r = length(p - uStarsA[i].xyz);
    // Radiation pressure on the grains clears a small cavity around each bright star (the
    // "bow" of IC 349 near Merope, ≈ 0.06 pc; White 2003), so the halos stay finite.
    n *= 0.06 + 0.94 * smoothstep(0.05, 0.32, r);
  }
  return vec4(n, 1.0, 0.0, 0.0);
}
`;

const SOURCES: Partial<Record<NebulaVariant, string>> = {
  pillars: PILLARS,
  ring: RING,
  helix: HELIX,
  butterfly: BUTTERFLY,
  crab: CRAB,
  veil: VEIL,
  horsehead: HORSEHEAD,
  pleiades: PLEIADES,
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
  // Soft, ragged fade toward the cube faces so the box is never visible.
  vec3 wob = 0.06 * uHalf * vec3(snoise(p * (2.1 / uHalf) + 3.3), snoise(p * (2.1 / uHalf) + 7.1), snoise(p * (2.1 / uHalf) + 1.7));
  vec3 e = 1.0 - smoothstep(vec3(0.8 * uHalf), vec3(0.985 * uHalf), abs(p) + wob);
  float fade = e.x * e.y * e.z;
  // Half-float storage: keep densities below 65 504.
  d.x = min(d.x * fade, 6.0e4);
  d.z *= fade;
  outColor = d;
}`;
}
