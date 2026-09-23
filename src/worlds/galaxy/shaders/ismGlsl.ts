/**
 * The interstellar medium, shared by the volume ray-march and per-star extinction.
 *
 * Face-on structure lives in a log-polar map in the pattern frame (u = ln(R/Rmin)/ln(Rmax/Rmin),
 * v = φ'/2π; logarithmic spirals are straight lines there, so arms stay crisp at every radius):
 *   R: old-star density-wave modulation (mean 1)      G: diffuse young-star light (∫dA = 1)
 *   B: dust, face-on V-band optical depth τ⊥           A: Hα/[OIII] emission (∫dA = 1)
 * Vertical structure is analytic: dust ρ_d = τ⊥ · e^{−|h|/h_d} / 2h_d (per pc), h measured from the
 * warped mid-plane. The bar's straight leading-edge dust lanes and the nuclear ring are analytic
 * in the bar frame (they rotate with Ω_b, not with the spiral).
 */
export const ISM_UNIFORMS_GLSL = /* glsl */ `
#ifndef TWU_ISM_UNIFORMS
#define TWU_ISM_UNIFORMS
uniform sampler2D uMap;
uniform vec3 uMapGeom;       // ln Rmin, 1/ln(Rmax/Rmin), Rmin
uniform float uDustAmount;   // live multiplier on τ
uniform float uDustH;        // dust scale height (pc)
uniform vec3 uExtRGB;        // τ_c / τ_V per channel (Cardelli et al. 1989)
uniform vec4 uBarLane;       // half-length, lane offset, lane width, lane τ (face-on)
uniform vec3 uRing;          // nuclear ring radius, width, τ
uniform vec4 uBubble;        // Local Bubble centre (model frame) + radius (w); w = 0 → none
uniform int uCloudCount;
uniform vec4 uClouds[8];     // local dust clouds: model-frame centre (xyz) + radius (w)
uniform float uCloudTau[8];  // peak optical depth through the centre
#endif
`;

export const ISM_GLSL = /* glsl */ `
#ifndef TWU_ISM
#define TWU_ISM
vec4 mapAt(vec2 XY) {
  float R = max(length(XY), uMapGeom.z);
  float phi = atan(XY.y, XY.x) - uOmegaP * uTime;
  float u = (log(R) - uMapGeom.x) * uMapGeom.y;
  return texture(uMap, vec2(u, phi * (1.0 / TAU_G)));
}

// Bar-frame coordinates of a model-frame point.
vec2 barFrame(vec2 XY) {
  float ang = uBarAngle0 + uOmegaB * uTime;
  float c = cos(ang), s = sin(ang);
  return vec2(XY.x * c + XY.y * s, -XY.x * s + XY.y * c);
}

// Face-on optical depth of the analytic bar lanes and nuclear ring.
float barDust(vec2 XY) {
  float tau = 0.0;
  if (uBarLane.w > 0.0 && uBarStrength > 0.01) {
    vec2 b = barFrame(XY);
    float L = uBarLane.x;
    float ax = abs(b.x);
    if (ax < L * 1.15) {
      // Leading edges: the lane at +x sits at +y (rotation is +φ in the model frame), the one at −x at −y.
      float yc = sign(b.x) * (uBarLane.y + 0.06 * L * ax / L);
      float w = uBarLane.z * (0.7 + 0.6 * ax / L);
      float along = gsmooth(uRing.x * 0.6, uRing.x * 1.4, ax) * (1.0 - gsmooth(L * 0.8, L * 1.15, ax));
      tau += uBarLane.w * uBarStrength * along * exp(-0.5 * pow((b.y - yc) / w, 2.0));
    }
  }
  if (uRing.z > 0.0) {
    float R = length(XY);
    tau += uRing.z * exp(-0.5 * pow((R - uRing.x) / uRing.y, 2.0));
  }
  return tau;
}

// Local dust clouds (Milky Way: the Great Rift, Ophiuchus, Taurus, Orion…) and the Local Bubble.
float localDustRho(vec3 m) {
  float rho = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= uCloudCount) break;
    vec4 c = uClouds[i];
    vec3 d = m - c.xyz;
    float r2 = dot(d, d) / (c.w * c.w);
    if (r2 < 9.0) rho += uCloudTau[i] / (1.772 * c.w) * exp(-r2);
  }
  return rho;
}
float bubbleFactor(vec3 m) {
  if (uBubble.w <= 0.0) return 1.0;
  float d = length(m - uBubble.xyz);
  return gsmooth(uBubble.w * 0.55, uBubble.w * 1.25, d);
}

// Face-on τ⊥ at (X, Y): map + bar lanes, scaled by the live dust control.
float dustSurface(vec2 XY) {
  return (mapAt(XY).b + barDust(XY)) * uDustAmount;
}

// Laplace (exponential) vertical profile: CDF and inverse.
float lapCDF(float h, float s) { return h < 0.0 ? 0.5 * exp(h / s) : 1.0 - 0.5 * exp(-h / s); }
float lapInv(float P, float s) { return P < 0.5 ? s * log(max(2.0 * P, 1e-30)) : -s * log(max(2.0 * (1.0 - P), 1e-30)); }

/**
 * V-band optical depth from model-frame point C to point P through the dust layer.
 * Importance-samples the segment by the vertical profile (its CDF along a straight ray is linear
 * in s), so N ≈ 4–8 lookups resolve even a 100 pc layer seen from 30 kpc.
 */
float dustColumn(vec3 C, vec3 P, int N) {
  vec3 d = P - C;
  float len = length(d);
  if (len < 1e-3) return 0.0;
  float hd = uDustH;
  float wC = warpH(length(C.xy), atan(C.y, C.x));
  float wP = warpH(length(P.xy), atan(P.y, P.x));
  float h0 = C.z - wC;
  float h1 = P.z - wP;
  float dh = h1 - h0;
  float tau = 0.0;
  if (abs(dh) < 0.02 * hd) {
    float W = len * exp(-abs(0.5 * (h0 + h1)) / hd) / (2.0 * hd);
    if (W < 1e-6) return localDustColumn(C, P);
    for (int i = 0; i < 8; i++) {
      if (i >= N) break;
      float s = (float(i) + 0.5) / float(N);
      tau += dustSurface(C.xy + d.xy * s) * bubbleFactor(C + d * s);
    }
    tau *= W / float(N);
  } else {
    float P0 = lapCDF(h0, hd);
    float P1 = lapCDF(h1, hd);
    float W = len * (P1 - P0) / dh;
    if (W < 1e-6) return localDustColumn(C, P);
    for (int i = 0; i < 8; i++) {
      if (i >= N) break;
      float Pi = mix(P0, P1, (float(i) + 0.5) / float(N));
      float s = clamp((lapInv(Pi, hd) - h0) / dh, 0.0, 1.0);
      tau += dustSurface(C.xy + d.xy * s) * bubbleFactor(C + d * s);
    }
    tau *= W / float(N);
  }
  return tau + localDustColumn(C, P);
}
#endif
`;

/** Must be included after ERF_GLSL and before ISM_GLSL (GLSL needs declaration before use). */
export const ISM_LOCAL_COLUMN_GLSL = /* glsl */ `
#ifndef TWU_ISM_LOCALCOL
#define TWU_ISM_LOCALCOL
// Column through the local Gaussian clouds: exact line integral of each Gaussian,
// τ_peak · e^{−b²/w²} · ½[erf((L − s_c)/w) − erf(−s_c/w)].
float localDustColumn(vec3 C, vec3 P) {
  float tau = 0.0;
  vec3 d = P - C;
  float len = length(d);
  if (len < 1e-3) return 0.0;
  vec3 u = d / len;
  for (int i = 0; i < 8; i++) {
    if (i >= uCloudCount) break;
    vec4 c = uClouds[i];
    vec3 oc = c.xyz - C;
    float sc = dot(oc, u);
    vec3 perp = oc - u * sc;
    float b2 = dot(perp, perp) / (c.w * c.w);
    if (b2 > 9.0) continue;
    float along = 0.5 * (erfApprox((len - sc) / c.w) - erfApprox(-sc / c.w));
    tau += uCloudTau[i] * exp(-b2) * along;
  }
  return tau;
}
#endif
`;

export const ERF_GLSL = /* glsl */ `
#ifndef TWU_ERF
#define TWU_ERF
// Abramowitz & Stegun 7.1.26 (|error| < 1.5e-7).
float erfApprox(float x) {
  float s = sign(x);
  x = abs(x);
  float t = 1.0 / (1.0 + 0.3275911 * x);
  float y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-x * x);
  return s * y;
}
#endif
`;
