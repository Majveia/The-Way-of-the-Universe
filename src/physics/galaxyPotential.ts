import { GM_SUN, MYR, PC } from './constants';

/**
 * Galactic dynamics: analytic mass models, rotation curves and orbital frequencies.
 *
 * Units (throughout the galaxy module): length = parsec, time = Myr, mass = M☉.
 * Velocities are pc/Myr internally (1 km/s = 1.0227 pc/Myr); use `kmsFromPcMyr` for display.
 * Coordinates here are astronomical: (R, z) cylindrical or (x, y, z) Cartesian with z = height
 * above the mid-plane. (Renderers map height to three.js +y.)
 *
 * Components (all axisymmetric so the circular speed, κ and ν are exact):
 *  - point mass (supermassive black hole), Plummer-softened,
 *  - Hernquist (1990, ApJ 356, 359) sphere for bulges and ellipticals,
 *  - Miyamoto & Nagai (1975, PASJ 27, 533) disks (thin, thick, gas),
 *  - NFW (Navarro, Frenk & White 1996, ApJ 462, 563) dark-matter halo.
 *
 * Frequencies follow Binney & Tremaine (2008, "Galactic Dynamics", 2nd ed.) §3.2.3:
 *   Ω² = v_c²/R²,   κ² = R dΩ²/dR + 4Ω² = (dv_c²/dR)/R + 2v_c²/R²,   ν² = ∂²Φ/∂z²|_{z=0}.
 */

/** Gravitational constant in pc³ M☉⁻¹ Myr⁻² (≈ 4.4985 × 10⁻³). */
export const G_GAL = (GM_SUN * MYR * MYR) / (PC * PC * PC);
/** 1 km/s expressed in pc/Myr (≈ 1.0227). */
export const PCMYR_PER_KMS = (1e3 * MYR) / PC;
export const kmsFromPcMyr = (v: number) => v / PCMYR_PER_KMS;
export const pcMyrFromKms = (v: number) => v * PCMYR_PER_KMS;
/** Angular frequency in rad/Myr → km/s/kpc (the astronomer's unit for Ω, κ, Oort constants). */
export const kmsKpcFromRadMyr = (w: number) => (w * 1000) / PCMYR_PER_KMS;
export const radMyrFromKmsKpc = (w: number) => (w * PCMYR_PER_KMS) / 1000;

export type PotentialComponent =
  | { kind: 'point'; name: string; M: number; soft: number; dark?: boolean }
  | { kind: 'hernquist'; name: string; M: number; a: number; dark?: boolean }
  | { kind: 'mn'; name: string; M: number; a: number; b: number; dark?: boolean }
  | { kind: 'nfw'; name: string; Ms: number; rs: number; dark?: boolean };

/** m(x) = ln(1+x) − x/(1+x): the NFW enclosed-mass shape. */
export function nfwShape(x: number): number {
  if (x < 1e-4) return x * x * (0.5 - (2 / 3) * x); // series, avoids cancellation
  return Math.log1p(x) - x / (1 + x);
}

/**
 * NFW scale mass M_s = 4π ρ_s r_s³ from a virial mass M_Δ and concentration c
 * (M_Δ = M_s · m(c)); r_s = r_Δ / c with r_Δ from the mean density Δ·ρ_crit.
 */
export function nfwFromVirial(Mvir: number, c: number, rhoCrit = 1.27e-7, delta = 200): { Ms: number; rs: number; rvir: number } {
  const rvir = Math.cbrt((3 * Mvir) / (4 * Math.PI * delta * rhoCrit));
  return { Ms: Mvir / nfwShape(c), rs: rvir / c, rvir };
}

function componentPhi(c: PotentialComponent, R: number, z: number): number {
  switch (c.kind) {
    case 'point': {
      return (-G_GAL * c.M) / Math.sqrt(R * R + z * z + c.soft * c.soft);
    }
    case 'hernquist': {
      const r = Math.sqrt(R * R + z * z);
      return (-G_GAL * c.M) / (r + c.a);
    }
    case 'mn': {
      const zeta = Math.sqrt(z * z + c.b * c.b);
      const s = c.a + zeta;
      return (-G_GAL * c.M) / Math.sqrt(R * R + s * s);
    }
    case 'nfw': {
      const r = Math.max(1e-6, Math.sqrt(R * R + z * z));
      return (-G_GAL * c.Ms * Math.log1p(r / c.rs)) / r;
    }
  }
}

/** Mid-plane circular speed squared v_c² = R ∂Φ/∂R (pc²/Myr²) and its radial derivative. */
function componentVc2(c: PotentialComponent, R: number): [number, number] {
  switch (c.kind) {
    case 'point': {
      const d2 = R * R + c.soft * c.soft;
      const d = Math.sqrt(d2);
      const v2 = (G_GAL * c.M * R * R) / (d2 * d);
      // d/dR [R² (R²+ε²)^-3/2] = R(2ε² − R²)(R²+ε²)^-5/2
      const dv2 = (G_GAL * c.M * R * (2 * c.soft * c.soft - R * R)) / (d2 * d2 * d);
      return [v2, dv2];
    }
    case 'hernquist': {
      const s = R + c.a;
      return [(G_GAL * c.M * R) / (s * s), (G_GAL * c.M * (c.a - R)) / (s * s * s)];
    }
    case 'mn': {
      const k = c.a + c.b;
      const d2 = R * R + k * k;
      const d = Math.sqrt(d2);
      return [(G_GAL * c.M * R * R) / (d2 * d), (G_GAL * c.M * R * (2 * k * k - R * R)) / (d2 * d2 * d)];
    }
    case 'nfw': {
      const r = Math.max(R, 1e-6);
      const x = r / c.rs;
      const m = c.Ms * nfwShape(x);
      const v2 = (G_GAL * m) / r;
      // dM/dr = 4π r² ρ = Ms x / (rs (1+x)²) ; dv²/dr = G (dM/dr)/r − G M/r²
      const dM = (c.Ms * x) / (c.rs * (1 + x) * (1 + x));
      return [v2, (G_GAL * dM) / r - (G_GAL * m) / (r * r)];
    }
  }
}

/** Vertical frequency squared at the mid-plane, ν² = ∂²Φ/∂z² (z = 0). */
function componentNu2(c: PotentialComponent, R: number): number {
  switch (c.kind) {
    case 'point': {
      const d2 = R * R + c.soft * c.soft;
      return (G_GAL * c.M) / (d2 * Math.sqrt(d2));
    }
    case 'hernquist': {
      const r = Math.max(R, 1e-6);
      const s = r + c.a;
      return (G_GAL * c.M) / (r * s * s); // spherical: ν² = (1/r) dΦ/dr = Ω²
    }
    case 'mn': {
      const k = c.a + c.b;
      const d2 = R * R + k * k;
      return (G_GAL * c.M * k) / (c.b * d2 * Math.sqrt(d2));
    }
    case 'nfw': {
      const r = Math.max(R, 1e-6);
      return (G_GAL * c.Ms * nfwShape(r / c.rs)) / (r * r * r);
    }
  }
}

/** Cartesian acceleration (pc/Myr²) at (x, y, z), z = height. Adds into `out`. */
function componentAccel(c: PotentialComponent, x: number, y: number, z: number, w: number, out: { x: number; y: number; z: number }): void {
  switch (c.kind) {
    case 'point': {
      const r2 = x * x + y * y + z * z + c.soft * c.soft;
      const f = (-G_GAL * c.M * w) / (r2 * Math.sqrt(r2));
      out.x += f * x;
      out.y += f * y;
      out.z += f * z;
      return;
    }
    case 'hernquist': {
      const r = Math.sqrt(x * x + y * y + z * z) + 1e-9;
      const s = r + c.a;
      const f = (-G_GAL * c.M * w) / (r * s * s);
      out.x += f * x;
      out.y += f * y;
      out.z += f * z;
      return;
    }
    case 'mn': {
      const zeta = Math.sqrt(z * z + c.b * c.b);
      const s = c.a + zeta;
      const d2 = x * x + y * y + s * s;
      const d3 = d2 * Math.sqrt(d2);
      const f = (-G_GAL * c.M * w) / d3;
      out.x += f * x;
      out.y += f * y;
      out.z += (f * z * s) / zeta;
      return;
    }
    case 'nfw': {
      const r = Math.sqrt(x * x + y * y + z * z) + 1e-9;
      const m = c.Ms * nfwShape(r / c.rs);
      const f = (-G_GAL * m * w) / (r * r * r);
      out.x += f * x;
      out.y += f * y;
      out.z += f * z;
      return;
    }
  }
}

function componentMassWithin(c: PotentialComponent, r: number): number {
  switch (c.kind) {
    case 'point':
      return c.M;
    case 'hernquist':
      return (c.M * r * r) / ((r + c.a) * (r + c.a));
    case 'mn':
      // Dynamical estimate (v_c² R / G) — MN disks have no closed-form spherical enclosed mass.
      return Math.min(c.M, (componentVc2(c, r)[0] * r) / G_GAL);
    case 'nfw':
      return c.Ms * nfwShape(r / c.rs);
  }
}

/** Total mass of a component (NFW: within `rMax`). */
function componentMass(c: PotentialComponent, rMax: number): number {
  return c.kind === 'nfw' ? c.Ms * nfwShape(rMax / c.rs) : c.M;
}

/**
 * A galaxy's gravitational potential: a sum of components; dark components can be switched off
 * (the dark-matter demonstration). All methods are float64 and allocation-free.
 */
export class GalaxyPotential {
  readonly components: PotentialComponent[];
  /** Weight of dark components (1 = present, 0 = removed). */
  darkWeight = 1;

  constructor(components: PotentialComponent[]) {
    this.components = components.map((c) => ({ ...c }));
  }

  get darkMatter(): boolean {
    return this.darkWeight > 0;
  }
  set darkMatter(on: boolean) {
    this.darkWeight = on ? 1 : 0;
  }

  private w(c: PotentialComponent, withDark: boolean | undefined): number {
    if (!c.dark) return 1;
    return withDark === undefined ? this.darkWeight : withDark ? 1 : 0;
  }

  /** Φ(R, z) in pc²/Myr². */
  phi(R: number, z = 0, withDark?: boolean): number {
    let s = 0;
    for (const c of this.components) s += this.w(c, withDark) * componentPhi(c, R, z);
    return s;
  }

  /** v_c²(R) at the mid-plane (pc²/Myr²). `withDark` overrides the current dark-matter switch. */
  vc2(R: number, withDark?: boolean): number {
    let s = 0;
    for (const c of this.components) s += this.w(c, withDark) * componentVc2(c, R)[0];
    return Math.max(0, s);
  }

  /** dv_c²/dR (pc/Myr²). */
  dvc2(R: number, withDark?: boolean): number {
    let s = 0;
    for (const c of this.components) s += this.w(c, withDark) * componentVc2(c, R)[1];
    return s;
  }

  /** Circular speed in pc/Myr. */
  vc(R: number, withDark?: boolean): number {
    return Math.sqrt(this.vc2(R, withDark));
  }
  /** Circular speed in km/s. */
  vcKms(R: number, withDark?: boolean): number {
    return kmsFromPcMyr(this.vc(R, withDark));
  }
  /** Circular speed contributed by a single named component, km/s. */
  componentVcKms(name: string, R: number): number {
    let s = 0;
    for (const c of this.components) if (c.name === name) s += componentVc2(c, R)[0];
    return kmsFromPcMyr(Math.sqrt(Math.max(0, s)));
  }

  /** Angular frequency Ω = v_c/R (rad/Myr). */
  omega(R: number, withDark?: boolean): number {
    const r = Math.max(R, 1e-3);
    return this.vc(r, withDark) / r;
  }

  /** Epicyclic frequency κ (rad/Myr). */
  kappa(R: number, withDark?: boolean): number {
    const r = Math.max(R, 1e-3);
    const k2 = this.dvc2(r, withDark) / r + (2 * this.vc2(r, withDark)) / (r * r);
    return Math.sqrt(Math.max(k2, 0));
  }

  /** Vertical oscillation frequency ν at the mid-plane (rad/Myr). */
  nu(R: number, withDark?: boolean): number {
    let s = 0;
    for (const c of this.components) s += this.w(c, withDark) * componentNu2(c, Math.max(R, 1e-3));
    return Math.sqrt(Math.max(s, 0));
  }

  /** Orbital (circular) period 2πR/v_c in Myr. */
  period(R: number, withDark?: boolean): number {
    return (2 * Math.PI) / this.omega(R, withDark);
  }

  /** Oort's constants (km/s/kpc): A = ½(v/R − dv/dR), B = −½(v/R + dv/dR). */
  oort(R: number, withDark?: boolean): { A: number; B: number } {
    const v = this.vc(R, withDark);
    const dv = this.dvc2(R, withDark) / (2 * Math.max(v, 1e-9));
    return { A: kmsKpcFromRadMyr(0.5 * (v / R - dv)), B: kmsKpcFromRadMyr(-0.5 * (v / R + dv)) };
  }

  /** Escape speed √(−2Φ) (pc/Myr). */
  escapeSpeed(R: number, z = 0, withDark?: boolean): number {
    return Math.sqrt(Math.max(0, -2 * this.phi(R, z, withDark)));
  }

  /** Acceleration at (x, y, z) (z = height), pc/Myr². */
  accel(x: number, y: number, z: number, out: { x: number; y: number; z: number }, withDark?: boolean): { x: number; y: number; z: number } {
    out.x = 0;
    out.y = 0;
    out.z = 0;
    for (const c of this.components) {
      const w = this.w(c, withDark);
      if (w !== 0) componentAccel(c, x, y, z, w, out);
    }
    return out;
  }

  /** Mass inside a sphere of radius r (disks: dynamical estimate), M☉. */
  massWithin(r: number, withDark?: boolean): number {
    let s = 0;
    for (const c of this.components) s += this.w(c, withDark) * componentMassWithin(c, r);
    return s;
  }

  /** Total baryonic (non-dark) mass, M☉. */
  baryonicMass(): number {
    let s = 0;
    for (const c of this.components) if (!c.dark) s += componentMass(c, 0);
    return s;
  }

  /** Total dark mass within rMax, M☉. */
  darkMass(rMax: number): number {
    let s = 0;
    for (const c of this.components) if (c.dark) s += componentMass(c, rMax);
    return s;
  }

  /**
   * Radius where f(R) = Ωp for f = Ω (corotation), Ω − κ/2 (inner Lindblad) or Ω + κ/2 (outer
   * Lindblad); bisection in log R. Returns NaN when there is no crossing in [rMin, rMax].
   */
  resonance(omegaP: number, kind: 'CR' | 'ILR' | 'OLR', rMin = 50, rMax = 60000, withDark?: boolean): number {
    const f = (R: number) => {
      const o = this.omega(R, withDark);
      const k = this.kappa(R, withDark);
      return (kind === 'CR' ? o : kind === 'ILR' ? o - k / 2 : o + k / 2) - omegaP;
    };
    let lo = Math.log(rMin);
    let hi = Math.log(rMax);
    let flo = f(rMin);
    const fhi = f(rMax);
    if (flo * fhi > 0) {
      // ILR curves can be non-monotonic: scan for the outermost sign change.
      const n = 200;
      let found = -1;
      let prev = flo;
      for (let i = 1; i <= n; i++) {
        const v = f(Math.exp(lo + ((hi - lo) * i) / n));
        if (prev * v <= 0) found = i;
        prev = v;
      }
      if (found < 0) return NaN;
      const l0 = lo + ((hi - lo) * (found - 1)) / n;
      hi = lo + ((hi - lo) * found) / n;
      lo = l0;
      flo = f(Math.exp(lo));
    }
    for (let i = 0; i < 60; i++) {
      const mid = 0.5 * (lo + hi);
      const fm = f(Math.exp(mid));
      if (flo * fm <= 0) hi = mid;
      else {
        lo = mid;
        flo = fm;
      }
    }
    return Math.exp(0.5 * (lo + hi));
  }

  /**
   * Radial lookup table for shaders: n samples at R = (i/(n−1))² · rMax (dense near the centre),
   * 4 floats each: Ω (rad/Myr), κ (rad/Myr), ν (rad/Myr), v_c (pc/Myr).
   * Rows: 0 = with dark matter, 1 = baryons only.
   */
  buildLUT(n: number, rMax: number): Float32Array {
    const out = new Float32Array(n * 2 * 4);
    for (let row = 0; row < 2; row++) {
      const dark = row === 0;
      for (let i = 0; i < n; i++) {
        const u = i / (n - 1);
        const R = Math.max(u * u * rMax, 0.5);
        const o = (row * n + i) * 4;
        out[o] = this.omega(R, dark);
        out[o + 1] = this.kappa(R, dark);
        out[o + 2] = this.nu(R, dark);
        out[o + 3] = this.vc(R, dark);
      }
    }
    return out;
  }
}

/** LUT index helper matching `buildLUT` (for shaders: u = sqrt(R/rMax)). */
export const lutCoord = (R: number, rMax: number) => Math.sqrt(Math.min(Math.max(R / rMax, 0), 1));

/**
 * Leapfrog (kick–drift–kick) step in the potential, float64 — the CPU reference for the GPU
 * integrator (symplectic, second order; Binney & Tremaine §3.4.1).
 */
export function leapfrogStep(
  pot: GalaxyPotential,
  p: { x: number; y: number; z: number },
  v: { x: number; y: number; z: number },
  dt: number,
  scratch: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 },
  withDark?: boolean,
): void {
  pot.accel(p.x, p.y, p.z, scratch, withDark);
  v.x += 0.5 * dt * scratch.x;
  v.y += 0.5 * dt * scratch.y;
  v.z += 0.5 * dt * scratch.z;
  p.x += dt * v.x;
  p.y += dt * v.y;
  p.z += dt * v.z;
  pot.accel(p.x, p.y, p.z, scratch, withDark);
  v.x += 0.5 * dt * scratch.x;
  v.y += 0.5 * dt * scratch.y;
  v.z += 0.5 * dt * scratch.z;
}

/**
 * The Milky Way mass model used by the `milkyway` preset.
 *  - Sgr A*: 4.3 × 10⁶ M☉ (GRAVITY Collaboration 2022).
 *  - Bulge + bar (Hernquist): 1.5 × 10¹⁰ M☉, a = 0.6 kpc (Bland-Hawthorn & Gerhard 2016: 1.4–1.7 × 10¹⁰).
 *  - Thin disk 3.6 × 10¹⁰, thick disk 0.6 × 10¹⁰, gas disk 1.1 × 10¹⁰ M☉ (Miyamoto–Nagai; BH&G 2016,
 *    McMillan 2017).
 *  - NFW halo r_s = 16 kpc, M_s = 6.36 × 10¹¹ M☉ → M₂₀₀ ≈ 1.1 × 10¹² M☉, c ≈ 14, normalised so that
 *    v_c(8.2 kpc) = 230 km/s (Eilers et al. 2019: 229 ± 7 km/s at R⊙ = 8.12 kpc).
 * Resulting Oort constants A ≈ 14.5, B ≈ −13.6 km/s/kpc (observed 15.3, −11.9; Bovy 2017).
 */
export function milkyWayComponents(): PotentialComponent[] {
  return [
    { kind: 'point', name: 'Sgr A*', M: 4.3e6, soft: 0.5 },
    { kind: 'hernquist', name: 'bulge', M: 1.5e10, a: 600 },
    { kind: 'mn', name: 'thin disk', M: 3.6e10, a: 2900, b: 300 },
    { kind: 'mn', name: 'thick disk', M: 0.6e10, a: 2300, b: 900 },
    { kind: 'mn', name: 'gas disk', M: 1.1e10, a: 5500, b: 100 },
    { kind: 'nfw', name: 'dark halo', Ms: 6.364e11, rs: 16000, dark: true },
  ];
}

/** Solar parameters (galactocentric). */
export const SUN_GALACTIC = {
  /** Galactocentric distance, pc (GRAVITY 2019: 8178 ± 13 ± 22; BH&G 2016: 8200 ± 100). */
  R: 8200,
  /** Height above the mid-plane, pc (Bennett & Bovy 2019). */
  z: 20.8,
  /** Peculiar velocity (U, V, W) relative to the local standard of rest, km/s (Schönrich et al. 2010). */
  U: 11.1,
  V: 12.24,
  W: 7.25,
} as const;
