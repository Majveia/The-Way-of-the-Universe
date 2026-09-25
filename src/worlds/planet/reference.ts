/**
 * CPU reference versions of the planet shaders' numerical kernels (planets module), for the unit tests.
 * Each mirrors a GLSL function in glsl.ts line for line; keep them in step.
 */
import type { AtmosphereRenderParams } from '../../physics/planets-atmosphere';
import { phaseHG, phaseRayleigh, transmittanceRenderUnits } from '../../physics/planets-atmosphere';

export type V3 = [number, number, number];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.sqrt(dot(a, a));
const at = (ro: V3, rd: V3, t: number): V3 => [ro[0] + rd[0] * t, ro[1] + rd[1] * t, ro[2] + rd[2] * t];
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** raySphere (COMMON_GLSL): (tNear, tFar), or null on a miss. */
export function raySphere(ro: V3, rd: V3, r: number): [number, number] | null {
  const b = dot(ro, rd);
  const h = b * b - (dot(ro, ro) - r * r);
  if (h < 0) return null;
  const s = Math.sqrt(h);
  return [-b - s, -b + s];
}

// ——— AURORA_GLSL: shellPath / shellSample ———
export interface ShellPath {
  a: number;
  lo1: number;
  lo2: number;
  b: number;
  /** The ray stays above the inner radius (one path around its lowest point). */
  tangent: boolean;
}
export function shellPath(ro: V3, rd: V3, ts: number, te: number, rIn: number, rOut: number): ShellPath | null {
  const o = raySphere(ro, rd, rOut);
  if (!o) return null;
  const a = Math.max(ts, o[0]);
  const b = Math.min(te, o[1]);
  if (b <= a) return null;
  const tm = Math.min(Math.max(-dot(ro, rd), a), b);
  let lo1 = tm;
  let lo2 = tm;
  let tangent = true;
  const i = raySphere(ro, rd, rIn);
  if (i && i[0] < i[1]) {
    lo1 = Math.min(Math.max(i[0], a), b);
    lo2 = Math.min(Math.max(i[1], a), b);
    tangent = false;
  }
  return lo1 - a + (b - lo2) > 0 ? { a, lo1, lo2, b, tangent } : null;
}
export function shellSample(sp: ShellPath, u: number, n: number): [number, number] {
  const L1 = sp.lo1 - sp.a;
  const L2 = sp.b - sp.lo2;
  const L = L1 + L2;
  const f1 = L1 / L;
  if (!sp.tangent) return u < f1 ? [sp.a + L * u, L / n] : [sp.lo2 + L * (u - f1), L / n];
  if (u < f1) {
    const v = 1 - u / f1;
    return [sp.lo1 - L1 * v * v, (2 * v * L) / n];
  }
  const v = (u - f1) / Math.max(1 - f1, 1e-6);
  return [sp.lo2 + L2 * v * v, (2 * v * L) / n];
}
/** ∫ f(|p|) dt along the ray inside the shell, with n shell samples (jitter 0.5). */
export function shellIntegral(ro: V3, rd: V3, ts: number, te: number, rIn: number, rOut: number, n: number, f: (r: number) => number): number {
  const sp = shellPath(ro, rd, ts, te, rIn, rOut);
  if (!sp) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const [t, w] = shellSample(sp, (i + 0.5) / n, n);
    s += f(len(at(ro, rd, t))) * w;
  }
  return s;
}

// ——— SURFACE_UTIL_GLSL: occluderVisibility ———
/**
 * Fraction of the stellar disk visible from p past a spherical occluder (centre c, radius R), star
 * direction sunDir (unit), angular radius sunAng. Returns the visible fraction and the umbra weight.
 */
export function occluderVisibility(p: V3, c: V3, R: number, sunDir: V3, sunAng: number): { visible: number; umbra: number } {
  if (R <= 0) return { visible: 1, umbra: 0 };
  const v: V3 = [c[0] - p[0], c[1] - p[1], c[2] - p[2]];
  const dist = len(v);
  const along = dot(v, sunDir);
  if (along <= 0) return { visible: 1, umbra: 0 };
  const angSep = Math.acos(Math.min(1, Math.max(-1, along / dist)));
  const angOcc = Math.asin(Math.min(1, Math.max(0, R / dist)));
  const full = angOcc - sunAng;
  const edge = angOcc + sunAng;
  const cover = 1 - smoothstep(Math.abs(full), edge, angSep);
  const maxCover = Math.min(1, (angOcc * angOcc) / (sunAng * sunAng));
  const umbra = full > 0 ? 1 - smoothstep(full * 0.85, full, angSep) : 0;
  return { visible: 1 - cover * maxCover, umbra };
}

// ——— ATMO_INTEGRATE_GLSL: integrateAtmo (single scattering; exact transmittance instead of the LUT) ———
export interface AtmoSeg {
  L: V3;
  T: V3;
}
/** Sunlight transmittance × visible fraction of the solar disk at radius r, cos zenith muS. */
export function sunTransmittanceRef(a: AtmosphereRenderParams, r: number, muS: number, sunAng = 0.00465): V3 {
  const muH = -Math.sqrt(Math.max(0, 1 - 1 / (r * r)));
  const vis = smoothstep(-sunAng, sunAng, muS - muH);
  if (vis <= 0) return [0, 0, 0];
  const T = transmittanceRenderUnits(a, r - 1, Math.max(muS, muH + 1e-6), 64);
  return [T[0] * vis, T[1] * vis, T[2] * vis];
}
/** Midpoint-per-step quadrature of in-scattered light on [t0, t1], n samples spread quadratically toward the lowest point. */
export function integrateAtmoRef(a: AtmosphereRenderParams, ro: V3, rd: V3, sun: V3, t0: number, t1: number, n: number, jitter = 0.5): AtmoSeg {
  const L: V3 = [0, 0, 0];
  const T: V3 = [1, 1, 1];
  if (t1 <= t0 || n <= 0) return { L, T };
  const c = dot(rd, sun);
  const pR = phaseRayleigh(c);
  const pM = [phaseHG(c, a.mieG[0]), phaseHG(c, a.mieG[1]), phaseHG(c, a.mieG[2])];
  const step = (t: number, dt: number) => {
    const p = at(ro, rd, t);
    const r = len(p);
    const h = r - 1;
    const dR = Math.exp(-h / a.rayleighH);
    const dM = Math.exp(-h / a.mieH);
    const dA = Math.max(0, 1 - Math.abs(h - a.absorptionCenter) / a.absorptionWidth);
    const ts = sunTransmittanceRef(a, r, dot(p, sun) / r);
    for (let k = 0; k < 3; k++) {
      const sR = a.rayleigh[k] * dR;
      const sM = a.mieScattering[k] * dM;
      const sigT = sR + a.mieExtinction[k] * dM + a.absorption[k] * dA;
      const S = (sR * pR + sM * pM[k]) * ts[k];
      const Ts = Math.exp(-sigT * dt);
      L[k] += (T[k] * (S - S * Ts)) / Math.max(sigT, 1e-9);
      T[k] *= Ts;
    }
  };
  const tm = Math.min(Math.max(-dot(ro, rd), t0), t1);
  const la = tm - t0;
  const lb = t1 - tm;
  const na = la > 0 ? Math.max(1, Math.floor((n * la) / (la + lb) + 0.5)) : 0;
  const nb = lb > 0 ? Math.max(1, n - na) : 0;
  let prev = 0;
  for (let i = 0; i < na; i++) {
    const s = (i + 1) / na;
    const x0 = t0 + la * (1 - (1 - prev) * (1 - prev));
    const x1 = t0 + la * (1 - (1 - s) * (1 - s));
    step(x0 + (x1 - x0) * jitter, x1 - x0);
    prev = s;
  }
  prev = 0;
  for (let i = 0; i < nb; i++) {
    const s = (i + 1) / nb;
    const x0 = tm + lb * prev * prev;
    const x1 = tm + lb * s * s;
    step(x0 + (x1 - x0) * jitter, x1 - x0);
    prev = s;
  }
  return { L, T };
}
/** Seg a then seg b behind it. */
export const composeSeg = (a: AtmoSeg, b: AtmoSeg): AtmoSeg => ({
  L: [a.L[0] + a.T[0] * b.L[0], a.L[1] + a.T[1] * b.L[1], a.L[2] + a.T[2] * b.L[2]],
  T: [a.T[0] * b.T[0], a.T[1] * b.T[1], a.T[2] * b.T[2]],
});

// ——— ATMO_GLSL: LUT storage (RGBA8 fallback) ———
export const lutEncode = (v: number, scale: number, encoded: boolean) => (encoded ? Math.sqrt(Math.min(1, Math.max(0, v / scale))) : v);
export const lutDecode = (raw: number, scale: number, encoded: boolean) => (encoded ? raw * raw * scale : raw);
