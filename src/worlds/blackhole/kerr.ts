/**
 * Kerr black-hole physics in geometrised units G = c = M = 1 (lengths in gravitational radii
 * r_g = GM/c², times in t_g = GM/c³). Pure functions, float64, no three.js — shared by the GPU
 * renderer (which mirrors the same equations in GLSL), the experience (readouts, plunge,
 * tap-to-inspect) and the unit tests.
 *
 * Coordinates. Light is traced in Cartesian Kerr–Schild coordinates (t, x, y, z), spin along +z:
 *
 *   g_μν = η_μν + f l_μ l_ν,   η = diag(−1, 1, 1, 1),
 *   f   = 2 r³ / (r⁴ + a² z²),
 *   l_μ = (1, (r x + a y)/(r² + a²), (r y − a x)/(r² + a²), z / r),
 *   r   defined by (x² + y²)/(r² + a²) + z²/r² = 1   (r = Boyer–Lindquist r).
 *
 * The form is horizon-penetrating (the plunge camera can cross r₊) and has no polar coordinate
 * singularity, so there is no seam when looking down the spin axis.
 * References: Kerr (1963) PRL 11, 237; Visser (2007) arXiv:0706.0622 (the Kerr–Schild form);
 * Chan, Psaltis & Özel (2013) ApJ 777, 13 (GRay: GPU geodesics in Kerr–Schild coordinates).
 *
 * Null geodesics follow from the super-Hamiltonian H = ½ g^μν p_μ p_ν (H = 0 for light,
 * −½ for massive particles when λ is proper time), with g^μν = η^μν − f l^μ l^ν, l^μ = (−1, l):
 *
 *   dx^i/dλ = p_i − f L l_i,              L ≡ l^μ p_μ = −p_t + l·p,
 *   dp_i/dλ = ½ ∂_i f L² + f L (∂_i l_j) p_j,     p_t = −E conserved (stationary metric).
 *
 * Because the metric is stationary and axisymmetric, E = −p_t and L_z = x p_y − y p_x are
 * conserved and equal to their Boyer–Lindquist counterparts (the coordinate changes t → t̃,
 * φ → φ̃ only depend on r, so ∂_t and ∂_φ are the same Killing vectors).
 */

export type Vec3 = [number, number, number];
/** Contravariant 4-vector in Kerr–Schild coordinates, order (t, x, y, z). */
export type Vec4 = [number, number, number, number];

// ———————————————————————————————————————————————————————————————— characteristic radii

/** Outer (event) horizon r₊ = 1 + √(1 − a²). */
export const horizonRadius = (a: number): number => 1 + Math.sqrt(Math.max(0, 1 - a * a));
/** Inner (Cauchy) horizon r₋ = 1 − √(1 − a²). */
export const innerHorizonRadius = (a: number): number => 1 - Math.sqrt(Math.max(0, 1 - a * a));

/**
 * Innermost stable circular orbit (Bardeen, Press & Teukolsky 1972, ApJ 178, 347, eq. 2.21).
 * a = 0 → 6; a → 1 → 1 (prograde) / 9 (retrograde).
 */
export function iscoRadius(a: number, prograde = true): number {
  const z1 = 1 + Math.cbrt(1 - a * a) * (Math.cbrt(1 + a) + Math.cbrt(1 - a));
  const z2 = Math.sqrt(3 * a * a + z1 * z1);
  const s = Math.sqrt(Math.max(0, (3 - z1) * (3 + z1 + 2 * z2)));
  return 3 + z2 + (prograde ? -s : s);
}

/** Radius of the circular equatorial photon orbit, r = 2{1 + cos[⅔ arccos(∓a)]} (BPT 1972). */
export function photonOrbitRadius(a: number, prograde = true): number {
  return 2 * (1 + Math.cos((2 / 3) * Math.acos(prograde ? -a : a)));
}

/** Marginally bound circular orbit r_mb = 2 ∓ a + 2√(1 ∓ a). */
export function marginallyBoundRadius(a: number, prograde = true): number {
  const s = prograde ? a : -a;
  return 2 - s + 2 * Math.sqrt(1 - s);
}

/** Outer boundary of the ergosphere (static limit) at polar angle θ: r = 1 + √(1 − a² cos²θ). */
export const ergosphereRadius = (a: number, cosTheta: number): number =>
  1 + Math.sqrt(Math.max(0, 1 - a * a * cosTheta * cosTheta));

// ———————————————————————————————————————————————————————————————— circular orbits

export interface CircularOrbit {
  /** Angular velocity dφ/dt seen from infinity. */
  omega: number;
  /** dt/dτ (Boyer–Lindquist). */
  ut: number;
  /** Specific energy E = −u_t. */
  energy: number;
  /** Specific angular momentum L = u_φ. */
  angularMomentum: number;
}

/**
 * Prograde circular equatorial geodesic at radius r (BPT 1972 eqs. 2.12–2.16):
 *   Ω = 1/(r^{3/2} + a),  u^t = (r^{3/2} + a) / (r^{3/4} √(r^{3/2} − 3r^{1/2} + 2a)).
 * Returns null inside the photon orbit, where no timelike circular orbit exists.
 */
export function circularOrbit(a: number, r: number): CircularOrbit | null {
  const sr = Math.sqrt(r);
  const r32 = r * sr;
  const d = r32 - 3 * sr + 2 * a;
  if (d <= 0) return null;
  const den = Math.pow(r, 0.75) * Math.sqrt(d);
  return {
    omega: 1 / (r32 + a),
    ut: (r32 + a) / den,
    energy: (r32 - 2 * sr + a) / den,
    angularMomentum: (r * r - 2 * a * sr + a * a) / den,
  };
}

/** Radiative efficiency of a thin disk η = 1 − E(r_isco): 5.7 % (a = 0) … 32 % (a = 0.998). */
export const radiativeEfficiency = (a: number): number => 1 - (circularOrbit(a, iscoRadius(a))?.energy ?? 1);

// ———————————————————————————————————————————————————————————————— metric functions (BL)

/** Frame-dragging angular velocity ω = −g_tφ/g_φφ = 2 a r / A (Boyer–Lindquist). */
export function frameDragging(a: number, r: number, cosTheta = 0): number {
  const s2 = 1 - cosTheta * cosTheta;
  const sigma = r * r + a * a * cosTheta * cosTheta;
  const delta = r * r - 2 * r + a * a;
  const A = (r * r + a * a) ** 2 - a * a * delta * s2;
  return (2 * a * r) / A;
}

/** Lapse α = √(ΣΔ/A) — proper-time rate of a zero-angular-momentum observer (ZAMO). */
export function zamoLapse(a: number, r: number, cosTheta = 0): number {
  const s2 = 1 - cosTheta * cosTheta;
  const sigma = r * r + a * a * cosTheta * cosTheta;
  const delta = r * r - 2 * r + a * a;
  if (delta <= 0) return 0;
  const A = (r * r + a * a) ** 2 - a * a * delta * s2;
  return Math.sqrt((sigma * delta) / A);
}

/**
 * dτ/dt of a static observer (at rest relative to the distant stars): √(1 − 2r/Σ).
 * Schwarzschild: √(1 − 2/r). NaN inside the ergosphere, where nothing can stay static.
 */
export function staticTimeDilation(a: number, r: number, cosTheta = 0): number {
  const sigma = r * r + a * a * cosTheta * cosTheta;
  const v = 1 - (2 * r) / sigma;
  return v > 0 ? Math.sqrt(v) : NaN;
}

/**
 * Speed of a prograde circular orbit at r measured by the local ZAMO (fraction of c):
 * v = (Ω − ω) √g_φφ / α. Schwarzschild: √(1/(r − 2)); 0.5 c at the ISCO (r = 6).
 */
export function circularOrbitSpeed(a: number, r: number): number {
  const o = circularOrbit(a, r);
  if (!o) return NaN;
  const delta = r * r - 2 * r + a * a;
  const A = (r * r + a * a) ** 2 - a * a * delta;
  const gpp = A / (r * r);
  const w = (2 * a * r) / A;
  const alpha = Math.sqrt((r * r * delta) / A);
  return ((o.omega - w) * Math.sqrt(gpp)) / alpha;
}

/**
 * Redshift factor g = ν_obs/ν_emit for gas on a prograde circular orbit, received by a distant
 * static observer: g = 1 / (u^t (1 − Ω λ)), λ = L_z/E of the photon (Cunningham 1975).
 * Split into a gravitational (+ frame-dragging) part α/(1 − ωλ) and a special-relativistic
 * Doppler part 1/(γ(1 − v cos ψ)) measured by the local ZAMO — their product is exact.
 */
export function circularRedshift(a: number, r: number, lambda: number): { g: number; grav: number; doppler: number } {
  const o = circularOrbit(a, r);
  if (!o) return { g: NaN, grav: NaN, doppler: NaN };
  const delta = r * r - 2 * r + a * a;
  const A = (r * r + a * a) ** 2 - a * a * delta;
  const w = (2 * a * r) / A;
  const alpha = Math.sqrt((r * r * delta) / A);
  const g = 1 / (o.ut * (1 - o.omega * lambda));
  const grav = alpha / (1 - w * lambda);
  return { g, grav, doppler: g / grav };
}

/** Gravitational redshift of light from a static emitter at r seen at infinity: → 0 at the horizon. */
export const staticRedshift = (a: number, r: number, cosTheta = 0): number => {
  const v = staticTimeDilation(a, r, cosTheta);
  return Number.isNaN(v) ? 0 : v;
};

// ———————————————————————————————————————————————————————————————— thin disk (Page–Thorne)

/**
 * Relativistic thin-disk flux (Novikov & Thorne 1973; Page & Thorne 1974, ApJ 191, 499, eq. 15n),
 * zero torque at the ISCO. Returns F̂(r) with the physical flux from each face
 *   F = (Ṁ c⁶ / G² M²) · F̂(r)      [W m⁻²],
 * F̂ = (3 / 8π) · [x − x₀ − (3/2) a ln(x/x₀) − Σᵢ 3(xᵢ − a)² / (xᵢ Πⱼ≠ᵢ(xᵢ − xⱼ)) · ln((x − xᵢ)/(x₀ − xᵢ))]
 *               / (x⁴ (x³ − 3x + 2a)),      x = √r, x₀ = √r_isco, xᵢ roots of x³ − 3x + 2a = 0.
 * Newtonian limit: F̂ → 3/(8π r³) · (1 − √(r_isco/r)). Verified against direct quadrature of
 * Page & Thorne eq. 11b in tests/gargantua.test.ts.
 */
export function pageThorneFlux(a: number, r: number, rIsco = iscoRadius(a)): number {
  if (r <= rIsco) return 0;
  const s = Math.max(a, 1e-7); // the a → 0 limit is regular; avoid the 0/0 in the x₂ term
  const x = Math.sqrt(r);
  const x0 = Math.sqrt(rIsco);
  const ac = Math.acos(s) / 3;
  const x1 = 2 * Math.cos(ac - Math.PI / 3);
  const x2 = 2 * Math.cos(ac + Math.PI / 3);
  const x3 = -2 * Math.cos(ac);
  const term = (xi: number, xj: number, xk: number) =>
    ((3 * (xi - s) ** 2) / (xi * (xi - xj) * (xi - xk))) * Math.log((x - xi) / (x0 - xi));
  const bracket =
    x - x0 - 1.5 * s * Math.log(x / x0) - term(x1, x2, x3) - term(x2, x1, x3) - term(x3, x1, x2);
  const den = x ** 4 * (x ** 3 - 3 * x + 2 * s);
  return (3 / (8 * Math.PI)) * (bracket / den);
}

/**
 * Same flux from the defining integral (Page & Thorne 1974 eq. 11b), by Simpson quadrature:
 *   F̂ = f / (4π r),  f = −Ω,r (E − ΩL)⁻² ∫_{r_isco}^{r} (E − ΩL) L,r dr.
 * Slow; used to verify the closed form.
 */
export function pageThorneFluxQuadrature(a: number, r: number, n = 4000): number {
  const rIsco = iscoRadius(a);
  if (r <= rIsco) return 0;
  const EL = (rr: number) => {
    const o = circularOrbit(a, rr)!;
    return o;
  };
  const dLdr = (rr: number) => {
    const h = 1e-5 * rr;
    return (EL(rr + h).angularMomentum - EL(rr - h).angularMomentum) / (2 * h);
  };
  const integrand = (rr: number) => {
    const o = EL(rr);
    return (o.energy - o.omega * o.angularMomentum) * dLdr(rr);
  };
  const m = n + (n % 2);
  const h = (r - rIsco) / m;
  let sum = integrand(rIsco + 1e-9) + integrand(r);
  for (let i = 1; i < m; i++) sum += (i % 2 ? 4 : 2) * integrand(rIsco + i * h);
  const I = (sum * h) / 3;
  const o = EL(r);
  const sr = Math.sqrt(r);
  const dOmega = (-1.5 * sr) / (r * sr + a) ** 2;
  const f = (-dOmega / (o.energy - o.omega * o.angularMomentum) ** 2) * I;
  return f / (4 * Math.PI * r);
}

export interface DiskProfile {
  /** Radii sampled log-uniformly from rIn to rOut. */
  radii: Float64Array;
  /** Effective temperature relative to the disk's peak, (F/F_max)^{1/4}. */
  temperature: Float64Array;
  /** Radius of peak temperature. */
  rPeak: number;
  /** Maximum of F̂ (for converting a peak temperature into an accretion rate). */
  fluxMax: number;
}

/** Tabulate T(r)/T_peak with σT⁴ = F (local blackbody) on a log-radius grid. */
export function diskProfile(a: number, rIn: number, rOut: number, n = 256): DiskProfile {
  const rIsco = iscoRadius(a);
  const radii = new Float64Array(n);
  const flux = new Float64Array(n);
  let fmax = 0;
  let rPeak = rIn;
  // Peak search over the whole physical disk so the normalisation does not depend on rIn/rOut.
  for (let i = 0; i < 400; i++) {
    const r = rIsco * Math.pow(60, i / 399);
    const f = pageThorneFlux(a, r, rIsco);
    if (f > fmax) {
      fmax = f;
      rPeak = r;
    }
  }
  for (let i = 0; i < n; i++) {
    const r = rIn * Math.pow(rOut / rIn, i / (n - 1));
    radii[i] = r;
    flux[i] = pageThorneFlux(a, r, rIsco);
  }
  const temperature = new Float64Array(n);
  for (let i = 0; i < n; i++) temperature[i] = Math.pow(Math.max(flux[i], 0) / fmax, 0.25);
  return { radii, temperature, rPeak, fluxMax: fmax };
}

// ———————————————————————————————————————————————————————————————— Kerr–Schild geometry

export interface KSPoint {
  r: number;
  f: number;
  /** Covariant l_i (spatial part; l_t = 1). */
  lx: number;
  ly: number;
  lz: number;
}

/** Boyer–Lindquist r of a Kerr–Schild Cartesian point. */
export function ksRadius(a: number, x: number, y: number, z: number): number {
  const a2 = a * a;
  const A = x * x + y * y + z * z - a2;
  return Math.sqrt(0.5 * (A + Math.sqrt(A * A + 4 * a2 * z * z)));
}

export function ksPoint(a: number, x: number, y: number, z: number): KSPoint {
  const a2 = a * a;
  const r = ksRadius(a, x, y, z);
  const r2 = r * r;
  const S = r2 + a2;
  return {
    r,
    f: (2 * r2 * r) / (r2 * r2 + a2 * z * z),
    lx: (r * x + a * y) / S,
    ly: (r * y - a * x) / S,
    lz: z / r,
  };
}

/** Covariant metric g_μν (row-major 4×4, order t,x,y,z) at a Kerr–Schild point. */
export function ksMetric(a: number, x: number, y: number, z: number, out = new Float64Array(16)): Float64Array {
  const p = ksPoint(a, x, y, z);
  const l = [1, p.lx, p.ly, p.lz];
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) out[i * 4 + j] = (i === j ? (i === 0 ? -1 : 1) : 0) + p.f * l[i] * l[j];
  return out;
}

/** Contravariant metric g^μν = η^μν − f l^μ l^ν with l^μ = (−1, l). */
export function ksInverseMetric(a: number, x: number, y: number, z: number, out = new Float64Array(16)): Float64Array {
  const p = ksPoint(a, x, y, z);
  const l = [-1, p.lx, p.ly, p.lz];
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) out[i * 4 + j] = (i === j ? (i === 0 ? -1 : 1) : 0) - p.f * l[i] * l[j];
  return out;
}

/** g(u, v) for contravariant vectors with a precomputed covariant metric. */
export function dot4(g: Float64Array, u: ArrayLike<number>, v: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) s += g[i * 4 + j] * u[i] * v[j];
  return s;
}

/** Lower an index: p_μ = g_μν v^ν. */
export function lower(g: Float64Array, v: ArrayLike<number>, out: Vec4 = [0, 0, 0, 0]): Vec4 {
  for (let i = 0; i < 4; i++) {
    let s = 0;
    for (let j = 0; j < 4; j++) s += g[i * 4 + j] * v[j];
    out[i] = s;
  }
  return out;
}

/** Super-Hamiltonian H = ½ g^μν p_μ p_ν for covariant momentum (p_t, p_x, p_y, p_z). */
export function hamiltonian(a: number, x: number, y: number, z: number, p: ArrayLike<number>): number {
  const q = ksPoint(a, x, y, z);
  const L = -p[0] + q.lx * p[1] + q.ly * p[2] + q.lz * p[3];
  return 0.5 * (-p[0] * p[0] + p[1] * p[1] + p[2] * p[2] + p[3] * p[3] - q.f * L * L);
}

/**
 * Hamilton's equations in Kerr–Schild coordinates. State s = (x, y, z, p_x, p_y, p_z);
 * pt = p_t (conserved). Writes ds/dλ into out; returns dt/dλ. Mirrored exactly by the GLSL
 * `ksRhs` in shaders.ts. With a = 0 this is Schwarzschild in ingoing Eddington–Finkelstein form.
 */
export function ksRhs(a: number, s: ArrayLike<number>, pt: number, out: Float64Array | number[]): number {
  const x = s[0], y = s[1], z = s[2], px = s[3], py = s[4], pz = s[5];
  const a2 = a * a;
  const A = x * x + y * y + z * z - a2;
  const D = Math.sqrt(A * A + 4 * a2 * z * z); // = 2r² − A > 0 off the ring singularity
  const r2 = 0.5 * (A + D);
  const r = Math.sqrt(r2);
  const S = r2 + a2;
  const iS = 1 / S;
  const lx = (r * x + a * y) * iS;
  const ly = (r * y - a * x) * iS;
  const lz = z / r;
  const Q = r2 * r2 + a2 * z * z;
  const f = (2 * r2 * r) / Q;
  const L = -pt + lx * px + ly * py + lz * pz;
  const fL = f * L;
  out[0] = px - fL * lx;
  out[1] = py - fL * ly;
  out[2] = pz - fL * lz;
  // ∂_i r from r⁴ − A r² − a² z² = 0.
  const rx = (r * x) / D;
  const ry = (r * y) / D;
  const rz = (z * S) / (r * D);
  // ∂_i f.
  const cf = (2 * r2) / (Q * Q);
  const tf = 3 * a2 * z * z - r2 * r2;
  const fx = cf * rx * tf;
  const fy = cf * ry * tf;
  const fz = cf * (rz * tf - 2 * a2 * r * z);
  // ∂_i (l_j p_j) with p held fixed.
  const Wxy = (r * x + a * y) * px + (r * y - a * x) * py;
  const xp = x * px + y * py;
  const k12 = 2 * r * Wxy * iS * iS + (z * pz) / r2;
  const Wx = (rx * xp + r * px - a * py) * iS - k12 * rx;
  const Wy = (ry * xp + a * px + r * py) * iS - k12 * ry;
  const Wz = rz * xp * iS - k12 * rz + pz / r;
  const hL2 = 0.5 * L * L;
  out[3] = fx * hL2 + fL * Wx;
  out[4] = fy * hL2 + fL * Wy;
  out[5] = fz * hL2 + fL * Wz;
  return -pt + fL; // dt/dλ
}

/** One classical RK4 step of the Kerr–Schild Hamiltonian flow (in place). Returns Δt. */
export function rk4Step(a: number, s: Float64Array, pt: number, h: number, work: Float64Array): number {
  // work: 5 × 6 scratch
  const k1 = work.subarray(0, 6), k2 = work.subarray(6, 12), k3 = work.subarray(12, 18), k4 = work.subarray(18, 24), tmp = work.subarray(24, 30);
  const t1 = ksRhs(a, s, pt, k1);
  for (let i = 0; i < 6; i++) tmp[i] = s[i] + 0.5 * h * k1[i];
  const t2 = ksRhs(a, tmp, pt, k2);
  for (let i = 0; i < 6; i++) tmp[i] = s[i] + 0.5 * h * k2[i];
  const t3 = ksRhs(a, tmp, pt, k3);
  for (let i = 0; i < 6; i++) tmp[i] = s[i] + h * k3[i];
  const t4 = ksRhs(a, tmp, pt, k4);
  for (let i = 0; i < 6; i++) s[i] += (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
  return (h / 6) * (t1 + 2 * t2 + 2 * t3 + t4);
}

// ———————————————————————————————————————————————————————————————— observers & tetrads

/** Killing vector ∂_φ in Kerr–Schild Cartesian components: (0, −y, x, 0). */
const axial = (x: number, y: number): Vec4 => [0, -y, x, 0];

function normalizeTimelike(g: Float64Array, v: Vec4): Vec4 | null {
  const n = dot4(g, v, v);
  if (!(n < 0)) return null;
  const s = 1 / Math.sqrt(-n);
  return [v[0] * s, v[1] * s, v[2] * s, v[3] * s];
}

/** Static observer u ∝ ∂_t (exists outside the ergosphere only). */
export function staticObserver(a: number, x: number, y: number, z: number): Vec4 | null {
  return normalizeTimelike(ksMetric(a, x, y, z), [1, 0, 0, 0]);
}

/** Zero-angular-momentum observer u ∝ ∂_t + ω ∂_φ (exists everywhere outside r₊). */
export function zamoObserver(a: number, x: number, y: number, z: number): Vec4 | null {
  const g = ksMetric(a, x, y, z);
  const t: Vec4 = [1, 0, 0, 0];
  const ph = axial(x, y);
  const gtp = dot4(g, t, ph);
  const gpp = dot4(g, ph, ph);
  const w = gpp > 1e-12 ? -gtp / gpp : 0;
  return normalizeTimelike(g, [1, w * ph[1], w * ph[2], 0]);
}

/**
 * Observer co-moving with a prograde circular orbit of the local radius (exact on the equator;
 * off the plane it rotates rigidly at the equatorial Keplerian Ω — an approximation).
 * Falls back to the ZAMO inside the photon orbit.
 */
export function orbitingObserver(a: number, x: number, y: number, z: number): Vec4 | null {
  const r = ksRadius(a, x, y, z);
  const o = circularOrbit(a, r);
  if (!o) return zamoObserver(a, x, y, z);
  const g = ksMetric(a, x, y, z);
  const ph = axial(x, y);
  return normalizeTimelike(g, [1, o.omega * ph[1], o.omega * ph[2], 0]) ?? zamoObserver(a, x, y, z);
}

/**
 * Free fall from rest at infinity with zero angular momentum ("rain", Doran 2000 observers):
 * E = 1, L = 0, Carter Q = 0 — falls at constant θ, dragged in φ. Regular across the horizon.
 * BL: u_t = −1, u_r = −√(2r(r² + a²))/Δ; in Kerr–Schild u_r → u_r + 2r/Δ (regular at Δ = 0).
 */
export function rainObserver(a: number, x: number, y: number, z: number): Vec4 {
  const a2 = a * a;
  const A = x * x + y * y + z * z - a2;
  const D = Math.sqrt(A * A + 4 * a2 * z * z);
  const r = Math.sqrt(0.5 * (A + D));
  const S = r * r + a2;
  // u_r(KS) = (2r − √(2r(r²+a²)))/Δ. Multiplying through by (2r + √(2rS)) removes the 0/0 at
  // the horizon (4r² − 2rS = −2rΔ):  u_r(KS) = −2r / (2r + √(2rS)).
  const urKS = (-2 * r) / (2 * r + Math.sqrt(2 * r * S));
  const rx = (r * x) / D, ry = (r * y) / D, rz = (z * S) / (r * D);
  const uCov: Vec4 = [-1, urKS * rx, urKS * ry, urKS * rz];
  const gi = ksInverseMetric(a, x, y, z);
  const u: Vec4 = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    let s = 0;
    for (let j = 0; j < 4; j++) s += gi[i * 4 + j] * uCov[j];
    u[i] = s;
  }
  return u;
}

export interface Tetrad {
  /** Contravariant basis e_(a)^μ: [e0 = u, e1 = right, e2 = up, e3 = back]. */
  e: [Vec4, Vec4, Vec4, Vec4];
  /** Covariant components E_(a)μ = g_μν e_(a)^ν — what the shader needs to build p_μ. */
  E: [Vec4, Vec4, Vec4, Vec4];
}

/**
 * Orthonormal frame of an observer with 4-velocity u, oriented by three spatial coordinate
 * directions (the camera's right/up/back axes in Kerr–Schild Cartesian components). Gram–Schmidt
 * in the order back → up → right keeps the optical axis exactly on the requested direction.
 */
export function buildTetrad(a: number, pos: Vec3, u: Vec4, right: Vec3, up: Vec3, back: Vec3): Tetrad {
  const g = ksMetric(a, pos[0], pos[1], pos[2]);
  const proj = (v: Vec4, basis: Vec4[], signs: number[]): Vec4 => {
    const w: Vec4 = [v[0], v[1], v[2], v[3]];
    basis.forEach((b, k) => {
      const c = dot4(g, w, b) * signs[k];
      for (let i = 0; i < 4; i++) w[i] -= c * b[i];
    });
    return w;
  };
  const norm = (v: Vec4): Vec4 => {
    const n = Math.sqrt(Math.max(dot4(g, v, v), 1e-300));
    return [v[0] / n, v[1] / n, v[2] / n, v[3] / n];
  };
  // Projection: w − (w·b)/(b·b) b, with b·b = −1 for u and +1 for spatial vectors.
  const e3 = norm(proj([0, back[0], back[1], back[2]], [u], [-1]));
  const e2 = norm(proj([0, up[0], up[1], up[2]], [u, e3], [-1, 1]));
  let e1 = norm(proj([0, right[0], right[1], right[2]], [u, e3, e2], [-1, 1, 1]));
  // Keep the frame right-handed even if `right` was degenerate.
  if (!e1.every(Number.isFinite)) e1 = [0, 0, 0, 0];
  const E = [u, e1, e2, e3].map((v) => lower(g, v)) as [Vec4, Vec4, Vec4, Vec4];
  return { e: [u, e1, e2, e3], E };
}

/** Lorentz factor between two observers: γ = −u·v. */
export function relativeGamma(a: number, pos: Vec3, u: Vec4, v: Vec4): number {
  return -dot4(ksMetric(a, pos[0], pos[1], pos[2]), u, v);
}

// ———————————————————————————————————————————————————————————————— CPU ray tracing

export interface DiskCrossing {
  /** Boyer–Lindquist radius where the ray crossed the equatorial plane. */
  r: number;
  /** Cartesian Kerr–Schild position. */
  pos: Vec3;
  /** 0 = direct image, 1 = first higher-order image, … (counts plane crossings). */
  order: number;
}

export interface RayResult {
  fate: 'escaped' | 'captured' | 'lost';
  /** Asymptotic propagation direction of the backward ray (i.e. where on the sky the light came from). */
  direction: Vec3;
  /** Equatorial-plane crossings in order. */
  crossings: DiskCrossing[];
  /** Conserved E = −p_t of the (future-directed) photon, in units of the camera-measured frequency. */
  energy: number;
  /** Conserved L_z of the photon (same units). */
  lz: number;
  /** Smallest Boyer–Lindquist radius reached. */
  rMin: number;
  /** Total azimuth swept around the spin axis (radians, unwrapped). */
  sweep: number;
  steps: number;
  /** |H| drift (should stay ≈ 0). */
  hError: number;
}

export interface TraceOptions {
  /** Relative step size (fraction of r). */
  eps?: number;
  maxSteps?: number;
  /** Escape radius; the remaining weak-field bending is added analytically. */
  rEscape?: number;
  /** Stop after this many plane crossings (0 = never). */
  maxCrossings?: number;
}

/**
 * Trace a light ray backwards from an observer. `pCov` is the covariant momentum (p_t, p_x, p_y,
 * p_z) of the *time-reversed* photon (k = −p), built as k_μ = −E0_μ + dⁱ E_iμ from a tetrad.
 * Same algorithm as the GPU shader (adaptive RK4, h ∝ r), with float64 precision.
 */
/** dr/dλ (Boyer–Lindquist r) from a state and its derivative: ∇r · dx/dλ. */
export function radialVelocity(a: number, s: ArrayLike<number>, d: ArrayLike<number>, r = ksRadius(a, s[0], s[1], s[2])): number {
  const a2 = a * a;
  const A = s[0] * s[0] + s[1] * s[1] + s[2] * s[2] - a2;
  const D = Math.sqrt(A * A + 4 * a2 * s[2] * s[2]) || 1e-12;
  return (r * (s[0] * d[0] + s[1] * d[1]) + (s[2] * (r * r + a2) * d[2]) / r) / D;
}

/**
 * Radius inside which an ingoing ray can never turn around (between r₊ and the prograde photon
 * orbit, the smallest radius any escaping photon can reach). Backward-traced rays that would
 * otherwise creep towards the past horizon — where the ingoing Kerr–Schild momentum diverges
 * like 1/Δ — are declared captured here.
 */
export const captureRadius = (a: number): number => {
  const rh = horizonRadius(a);
  return rh + 0.5 * (photonOrbitRadius(a, true) - rh);
};

export function traceRay(a: number, pos: Vec3, kCov: Vec4, o: TraceOptions = {}): RayResult {
  const eps = o.eps ?? 0.04;
  const maxSteps = o.maxSteps ?? 20000;
  const rH = horizonRadius(a);
  const rCap = captureRadius(a);
  const r0 = ksRadius(a, pos[0], pos[1], pos[2]);
  const rEsc = o.rEscape ?? Math.max(r0 * 1.05, 60);
  const s = new Float64Array([pos[0], pos[1], pos[2], kCov[1], kCov[2], kCov[3]]);
  const pt = kCov[0];
  const work = new Float64Array(30);
  const d = new Float64Array(6);
  const crossings: DiskCrossing[] = [];
  const H0 = hamiltonian(a, s[0], s[1], s[2], [pt, s[3], s[4], s[5]]);
  let rMin = r0;
  let prevPhi = Math.atan2(s[1], s[0]);
  let sweep = 0;
  let fate: RayResult['fate'] = 'lost';
  let steps = 0;
  // Energy/angular momentum of the future-directed photon p = −k.
  const energy = pt;
  const lz = -(s[0] * s[4] - s[1] * s[3]);
  const insideStart = r0 < rH;
  for (; steps < maxSteps; steps++) {
    const r = ksRadius(a, s[0], s[1], s[2]);
    rMin = Math.min(rMin, r);
    ksRhs(a, s, pt, d);
    const vr = radialVelocity(a, s, d, r);
    if (vr < 0 && r < (insideStart ? rH * 1.0005 : rCap)) {
      fate = 'captured';
      break;
    }
    if (r > rEsc && vr > 0) {
      fate = 'escaped';
      break;
    }
    // Step control: a fixed fraction of r in coordinate length, and never more than a fraction of
    // the momentum's e-folding "time" (keeps RK4 stable where p grows near the horizon).
    const speed = Math.hypot(d[0], d[1], d[2]) + 1e-12;
    const pn = Math.hypot(s[3], s[4], s[5]) + 1e-12;
    const dpn = Math.hypot(d[3], d[4], d[5]) + 1e-12;
    const h = Math.min((eps * Math.max(r, 0.2) * (r > 40 ? 3 : 1)) / speed, (8 * eps * pn) / dpn);
    const z0 = s[2];
    const x0 = s[0], y0 = s[1];
    rk4Step(a, s, pt, h, work);
    if (z0 !== 0 && Math.sign(z0) !== Math.sign(s[2])) {
      const t = z0 / (z0 - s[2]);
      const cx = x0 + (s[0] - x0) * t, cy = y0 + (s[1] - y0) * t;
      crossings.push({ r: ksRadius(a, cx, cy, 0), pos: [cx, cy, 0], order: crossings.length });
      if (o.maxCrossings && crossings.length >= o.maxCrossings) {
        fate = 'lost';
        break;
      }
    }
    const phi = Math.atan2(s[1], s[0]);
    let dphi = phi - prevPhi;
    if (dphi > Math.PI) dphi -= 2 * Math.PI;
    if (dphi < -Math.PI) dphi += 2 * Math.PI;
    sweep += dphi;
    prevPhi = phi;
    if (!s.every(Number.isFinite)) {
      // Only happens for rays diving at the horizon faster than the step control can follow.
      fate = 'captured';
      break;
    }
  }
  ksRhs(a, s, pt, d);
  let dir: Vec3 = [d[0], d[1], d[2]];
  const n = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  dir = [dir[0] / n, dir[1] / n, dir[2] / n];
  if (fate === 'escaped') dir = weakFieldTail([s[0], s[1], s[2]], dir);
  const H1 = hamiltonian(a, s[0], s[1], s[2], [pt, s[3], s[4], s[5]]);
  return { fate, direction: dir, crossings, energy, lz, rMin, sweep, steps, hError: Math.abs(H1 - H0) };
}

/**
 * Remaining light bending of a ray leaving radius r along direction v, in the weak-field limit:
 * deflection (2/b)(1 − s/√(b² + s²)) toward the hole, b = impact parameter, s = distance past
 * closest approach (Einstein's 4M/b split along the path). Lets the integration stop early.
 */
export function weakFieldTail(x: Vec3, v: Vec3): Vec3 {
  const s = x[0] * v[0] + x[1] * v[1] + x[2] * v[2];
  const c: Vec3 = [x[0] - s * v[0], x[1] - s * v[1], x[2] - s * v[2]];
  const b = Math.hypot(c[0], c[1], c[2]);
  if (b < 1e-9) return v;
  const defl = (2 / b) * (1 - s / Math.sqrt(b * b + s * s));
  const w: Vec3 = [v[0] - (defl * c[0]) / b, v[1] - (defl * c[1]) / b, v[2] - (defl * c[2]) / b];
  const n = Math.hypot(w[0], w[1], w[2]);
  return [w[0] / n, w[1] / n, w[2] / n];
}

/** Build k_μ = −E0 + dⁱ E_i for a camera-frame direction d = (right, up, back) components. */
export function rayMomentum(t: Tetrad, d: Vec3): Vec4 {
  const k: Vec4 = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) k[i] = -t.E[0][i] + d[0] * t.E[1][i] + d[1] * t.E[2][i] + d[2] * t.E[3][i];
  return k;
}

/**
 * Bardeen (1973) critical curve — the shadow outline seen by a distant observer at inclination i
 * (angle from the spin axis). Spherical photon orbits of radius r give ξ = L/E and η = Q/E²:
 *   ξ = −(r³ − 3r² + a²r + a²) / (a(r − 1)),  η = −r³(r³ − 6r² + 9r − 4a²) / (a²(r − 1)²),
 * and screen coordinates α = −ξ / sin i, β = ±√(η + a² cos² i − ξ² cot² i).
 * Returns points (α, β) in units of M going around the curve.
 */
export function shadowCurve(a: number, inclination: number, n = 256): Array<[number, number]> {
  const s = Math.max(a, 1e-4);
  const r1 = photonOrbitRadius(s, true);
  const r2 = photonOrbitRadius(s, false);
  const si = Math.sin(inclination), ci = Math.cos(inclination);
  const upper: Array<[number, number]> = [];
  const lower: Array<[number, number]> = [];
  for (let k = 0; k <= n; k++) {
    // Cosine spacing concentrates samples at the ends where the curve turns.
    const r = r1 + (r2 - r1) * 0.5 * (1 - Math.cos((Math.PI * k) / n));
    const xi = -(r ** 3 - 3 * r * r + s * s * r + s * s) / (s * (r - 1));
    const eta = -(r ** 3 * (r ** 3 - 6 * r * r + 9 * r - 4 * s * s)) / (s * s * (r - 1) ** 2);
    const b2 = eta + s * s * ci * ci - (xi * xi * ci * ci) / Math.max(si * si, 1e-12);
    if (b2 < 0) continue;
    const alpha = -xi / Math.max(si, 1e-6);
    const beta = Math.sqrt(b2);
    upper.push([alpha, beta]);
    lower.push([alpha, -beta]);
  }
  return upper.concat(lower.reverse());
}

// ———————————————————————————————————————————————————————————————— physical units

const G_SI = 6.6743e-11;
const C_SI = 299_792_458;
const GM_SUN_SI = 1.32712440018e20;
const SIGMA_SB = 5.670374419e-8;
const M_SUN_KG = 1.98847e30;
const YEAR_S = 365.25 * 86400;
/** Eddington luminosity per solar mass for ionised hydrogen (4πGMm_pc/σ_T), W. */
const L_EDD_PER_MSUN = 1.2572e31;

/** Gravitational radius GM/c² in metres. */
export const gravitationalRadius = (massSun: number): number => (GM_SUN_SI * massSun) / (C_SI * C_SI);
/** Gravitational time GM/c³ in seconds. */
export const gravitationalTime = (massSun: number): number => (GM_SUN_SI * massSun) / (C_SI * C_SI * C_SI);

export interface AccretionState {
  /** Accretion rate, kg/s. */
  mdot: number;
  /** Accretion rate, solar masses per year. */
  mdotSunPerYear: number;
  /** Radiated power L = η Ṁ c², W. */
  luminosity: number;
  /** L / L_Edd. */
  eddingtonRatio: number;
  efficiency: number;
}

/**
 * Invert the Page–Thorne profile: which accretion rate gives the requested peak effective
 * temperature for this mass and spin?  σT_max⁴ = Ṁ c⁶ F̂_max / (G² M²).
 */
export function accretionForPeakTemperature(a: number, massSun: number, tPeak: number): AccretionState {
  const prof = diskProfile(a, iscoRadius(a), iscoRadius(a) * 30, 8);
  const M = massSun * M_SUN_KG;
  const mdot = (SIGMA_SB * tPeak ** 4 * G_SI * G_SI * M * M) / (C_SI ** 6 * prof.fluxMax);
  const eff = radiativeEfficiency(a);
  const L = eff * mdot * C_SI * C_SI;
  return {
    mdot,
    mdotSunPerYear: (mdot * YEAR_S) / M_SUN_KG,
    luminosity: L,
    eddingtonRatio: L / (L_EDD_PER_MSUN * massSun),
    efficiency: eff,
  };
}

/**
 * Tidal (radial stretching) acceleration across a body of length ℓ at radius r (in r_g), in m/s²:
 * Δa ≈ 2GMℓ/r³ — the leading term of the geodesic deviation in the radial direction.
 */
export function tidalAcceleration(massSun: number, rInRg: number, lengthM = 2): number {
  const rm = rInRg * gravitationalRadius(massSun);
  return (2 * GM_SUN_SI * massSun * lengthM) / (rm * rm * rm);
}
