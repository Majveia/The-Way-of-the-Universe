/**
 * GLSL (ES 3.00) for the GPU N-body integrator. Every pass is a full-screen triangle over a
 * float32 state texture; each fragment owns one particle (texel). See cpu.ts for the reference
 * algorithm these shaders reproduce.
 */

/** Copy two textures into an MRT target (used to upload initial conditions / snapshots). */
export const COPY2_FRAG = /* glsl */ `
uniform sampler2D tA;
uniform sampler2D tB;
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  oA = texelFetch(tA, p, 0);
  oB = texelFetch(tB, p, 0);
}`;

/** Skeleton: first half-kick and drift.  v ← v + ½ a dt;  x ← x + v dt. */
export const KD_FRAG = /* glsl */ `
uniform sampler2D tPos;
uniform sampler2D tVel;
uniform sampler2D tAcc;
uniform float uDt;
layout(location = 0) out vec4 oPos;
layout(location = 1) out vec4 oVel;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 x = texelFetch(tPos, p, 0);
  vec4 v = texelFetch(tVel, p, 0);
  vec3 a = texelFetch(tAcc, p, 0).xyz;
  v.xyz += 0.5 * uDt * a;
  x.xyz += uDt * v.xyz;
  oPos = x;
  oVel = v;
}`;

/** Skeleton: second half-kick (copies positions through so the MRT target holds the full state). */
export const K_FRAG = /* glsl */ `
uniform sampler2D tPos;
uniform sampler2D tVel;
uniform sampler2D tAcc;
uniform float uDt;
layout(location = 0) out vec4 oPos;
layout(location = 1) out vec4 oVel;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 v = texelFetch(tVel, p, 0);
  v.xyz += 0.5 * uDt * texelFetch(tAcc, p, 0).xyz;
  oPos = texelFetch(tPos, p, 0);
  oVel = v;
}`;

/**
 * Skeleton: direct-summation gravity. Segments (row ranges) carry their own Plummer softening;
 * the pair softening ε_ij² = ½(ε_i² + ε_j²) keeps forces antisymmetric. Output: (a, Φ) with the
 * self-interaction removed from Φ.
 */
export const FORCE_FRAG = /* glsl */ `
uniform sampler2D tPos;
uniform sampler2D tVel;
uniform ivec2 uSeg[6];
uniform float uSegEps2[6];
uniform float uG;
out vec4 oAcc;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 xi = texelFetch(tPos, p, 0);
  int code = int(texelFetch(tVel, p, 0).w + 0.5);
  float ei2 = uSegEps2[(code & 3) * 2 + (code >> 2)];
  vec3 acc = vec3(0.0);
  float phi = 0.0;
  for (int s = 0; s < 6; s++) {
    float e2 = 0.5 * (ei2 + uSegEps2[s]);
    ivec2 rows = uSeg[s];
    for (int r = rows.x; r < rows.y; r++) {
      for (int c = 0; c < ${64}; c++) {
        vec4 xj = texelFetch(tPos, ivec2(c, r), 0);
        vec3 d = xj.xyz - xi.xyz;
        float inv = inversesqrt(dot(d, d) + e2);
        float mi = xj.w * inv;
        acc += d * (mi * inv * inv);
        phi -= mi;
      }
    }
  }
  phi += xi.w * inversesqrt(ei2);
  oAcc = vec4(uG * acc, uG * phi);
}`;

/**
 * Centre tracking + filter (one fragment per galaxy). Predict with the previous bulk acceleration,
 * measure the Gaussian-windowed centroid / bulk velocity / bulk acceleration of the galaxy's own
 * skeleton, then correct gently (see CENTER_TAU in cpu.ts).
 * Outputs: 0 centre, 1 velocity, 2 bulk acceleration, 3 previous centre.
 */
export const TRACK_FRAG = /* glsl */ `
uniform sampler2D tPos;
uniform sampler2D tVel;
uniform sampler2D tAcc;
uniform sampler2D tM0;
uniform sampler2D tM1;
uniform sampler2D tM2;
uniform ivec2 uRows[6];
uniform float uWin[2];
uniform vec3 uInitCenter[2];
uniform float uDt;
uniform vec3 uTau;
uniform int uInit;
layout(location = 0) out vec4 oC;
layout(location = 1) out vec4 oU;
layout(location = 2) out vec4 oA;
layout(location = 3) out vec4 oP;
void main() {
  int g = int(gl_FragCoord.y);
  vec3 c, u, a0;
  if (uInit == 1) {
    c = g == 0 ? uInitCenter[0] : uInitCenter[1];
    u = vec3(0.0);
    a0 = vec3(0.0);
  } else {
    c = texelFetch(tM0, ivec2(0, g), 0).xyz;
    u = texelFetch(tM1, ivec2(0, g), 0).xyz;
    a0 = texelFetch(tM2, ivec2(0, g), 0).xyz;
  }
  vec3 cPrev = c;
  if (uInit == 0) {
    u += 0.5 * uDt * a0;
    c += uDt * u;
  }
  float win = g == 0 ? uWin[0] : uWin[1];
  vec3 cm = c;
  float s2 = 0.0;
  for (int it = 0; it < 2; it++) {
    float f = it == 0 ? 2.0 : 1.0;
    s2 = 2.0 * (f * win) * (f * win);
    vec4 sum = vec4(0.0);
    for (int comp = 0; comp < 3; comp++) {
      ivec2 rows = uRows[comp * 2 + g];
      for (int r = rows.x; r < rows.y; r++) {
        for (int x = 0; x < ${64}; x++) {
          vec4 q = texelFetch(tPos, ivec2(x, r), 0);
          vec3 d = q.xyz - cm;
          float w = q.w * exp(-dot(d, d) / s2);
          sum += vec4(q.xyz * w, w);
        }
      }
    }
    if (sum.w > 0.0) cm = sum.xyz / sum.w;
  }
  vec4 sv = vec4(0.0);
  vec3 sa = vec3(0.0);
  for (int comp = 0; comp < 3; comp++) {
    ivec2 rows = uRows[comp * 2 + g];
    for (int r = rows.x; r < rows.y; r++) {
      for (int x = 0; x < ${64}; x++) {
        ivec2 t = ivec2(x, r);
        vec4 q = texelFetch(tPos, t, 0);
        vec3 d = q.xyz - cm;
        float w = q.w * exp(-dot(d, d) / s2);
        sv += vec4(texelFetch(tVel, t, 0).xyz * w, w);
        sa += texelFetch(tAcc, t, 0).xyz * w;
      }
    }
  }
  vec3 vm = sv.w > 0.0 ? sv.xyz / sv.w : u;
  vec3 am = sv.w > 0.0 ? sa / sv.w : vec3(0.0);
  if (uInit == 1) {
    c = cm;
    u = vm;
    cPrev = cm;
  } else {
    vec3 d = cm - c;
    u += 0.5 * uDt * am + uDt * d / (uTau.y * uTau.y) + uDt * (vm - u) / uTau.z;
    c += uDt * d / uTau.x;
  }
  oC = vec4(c, 1.0);
  oU = vec4(u, 0.0);
  oA = vec4(am, 0.0);
  oP = vec4(cPrev, 1.0);
}`;

/**
 * Smooth field of both galaxies (what star and gas tracers feel):
 * core-softened Hernquist halo + bulge (+ the spheroid a disrupted disk turns into) and a 3-MN disk
 * around the spin axis n:  a_MN = −Σ G m_k (d + (a_k z/s) n) / D_k³.
 */
export const SMOOTH_GLSL = /* glsl */ `
uniform vec4 uHalo[2];   // G·M, a, ε², -
uniform vec4 uBulge[2];
uniform vec4 uSph[2];    // G·M_sphere, a_sphere, ε², -
uniform vec4 uMnA[2];    // a1, a2, a3, b
uniform vec4 uMnM[2];    // G·m1, G·m2, G·m3, -
uniform vec4 uSpin[2];   // n, -
vec3 hernAcc(vec3 d, vec4 h) {
  float s = sqrt(dot(d, d) + h.z);
  float sa = s + h.y;
  return d * (-h.x / (s * sa * sa));
}
vec3 galaxyAcc(vec3 d, int g) {
  vec3 acc = hernAcc(d, uHalo[g]) + hernAcc(d, uBulge[g]);
  if (uSph[g].x > 0.0) acc += hernAcc(d, uSph[g]);
  vec3 n = uSpin[g].xyz;
  vec4 A = uMnA[g];
  vec4 M = uMnM[g];
  float z = dot(d, n);
  float R2 = max(dot(d, d) - z * z, 0.0);
  float s = sqrt(z * z + A.w * A.w);
  for (int k = 0; k < 3; k++) {
    float ak = A[k];
    float as = ak + s;
    float D2 = R2 + as * as;
    float inv = inversesqrt(D2);
    acc -= (M[k] * inv * inv * inv) * (d + (ak * z / s) * n);
  }
  return acc;
}`;

/**
 * Tracers: K leapfrog sub-steps per skeleton step in the smooth field, galaxy centres
 * interpolated linearly between the previous and new filtered centres.
 */
export const TRACER_FRAG = /* glsl */ `
uniform sampler2D tPos;
uniform sampler2D tVel;
uniform sampler2D tM0;
uniform sampler2D tM3;
uniform float uDt;
uniform int uK;
${SMOOTH_GLSL}
layout(location = 0) out vec4 oPos;
layout(location = 1) out vec4 oVel;
vec3 c0a, c0b, c1a, c1b;
vec3 fieldAt(vec3 x, float f) {
  return galaxyAcc(x - mix(c0a, c0b, f), 0) + galaxyAcc(x - mix(c1a, c1b, f), 1);
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 x = texelFetch(tPos, p, 0);
  vec4 v = texelFetch(tVel, p, 0);
  c0a = texelFetch(tM3, ivec2(0, 0), 0).xyz;
  c0b = texelFetch(tM0, ivec2(0, 0), 0).xyz;
  c1a = texelFetch(tM3, ivec2(0, 1), 0).xyz;
  c1b = texelFetch(tM0, ivec2(0, 1), 0).xyz;
  float h = uDt / float(uK);
  vec3 a = fieldAt(x.xyz, 0.0);
  for (int k = 0; k < 16; k++) {
    if (k >= uK) break;
    v.xyz += 0.5 * h * a;
    x.xyz += h * v.xyz;
    a = fieldAt(x.xyz, float(k + 1) / float(uK));
    v.xyz += 0.5 * h * a;
  }
  oPos = x;
  oVel = v;
}`;

/** Per-row sums for the skeleton's energy, momentum and angular momentum. */
export const DIAG_FRAG = /* glsl */ `
uniform sampler2D tPos;
uniform sampler2D tVel;
uniform sampler2D tAcc;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
void main() {
  int r = int(gl_FragCoord.y);
  float K = 0.0, W = 0.0;
  vec3 P = vec3(0.0), L = vec3(0.0);
  for (int x = 0; x < ${64}; x++) {
    ivec2 t = ivec2(x, r);
    vec4 q = texelFetch(tPos, t, 0);
    vec3 v = texelFetch(tVel, t, 0).xyz;
    float phi = texelFetch(tAcc, t, 0).w;
    K += 0.5 * q.w * dot(v, v);
    W += 0.5 * q.w * phi;
    P += q.w * v;
    L += q.w * cross(q.xyz, v);
  }
  o0 = vec4(K, W, P.xy);
  o1 = vec4(P.z, L);
}`;

/**
 * Per-row moments of disk tracers (kind ≠ bulge) about their galaxy's filtered centre:
 * hard-radius weight, Gaussian-weighted Σw, angular momentum and second moments.
 */
export const MOMENTS_FRAG = /* glsl */ `
uniform sampler2D tPos;
uniform sampler2D tVel;
uniform sampler2D tAttr;
uniform sampler2D tM0;
uniform sampler2D tM1;
uniform int uSplitRow;
uniform float uHard2[2];
uniform float uSig2[2];
uniform int uWidth;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
void main() {
  int r = int(gl_FragCoord.y);
  int g = r < uSplitRow ? 0 : 1;
  vec3 c = texelFetch(tM0, ivec2(0, g), 0).xyz;
  vec3 u = texelFetch(tM1, ivec2(0, g), 0).xyz;
  float hard2 = g == 0 ? uHard2[0] : uHard2[1];
  float sig2 = g == 0 ? uSig2[0] : uSig2[1];
  float wIn = 0.0, wG = 0.0;
  vec3 L = vec3(0.0), Sd = vec3(0.0), So = vec3(0.0);
  for (int x = 0; x < 1024; x++) {
    if (x >= uWidth) break;
    ivec2 t = ivec2(x, r);
    vec4 at = texelFetch(tAttr, t, 0);
    if (at.x < 0.5) continue;
    vec3 d = texelFetch(tPos, t, 0).xyz - c;
    vec3 w3 = texelFetch(tVel, t, 0).xyz - u;
    float d2 = dot(d, d);
    if (d2 < hard2) wIn += at.w;
    float w = at.w * exp(-d2 / sig2);
    wG += w;
    L += w * cross(d, w3);
    Sd += w * d * d;
    So += w * vec3(d.x * d.y, d.x * d.z, d.y * d.z);
  }
  o0 = vec4(wIn, wG, L.xy);
  o1 = vec4(L.z, Sd);
  o2 = vec4(So, 0.0);
}`;
