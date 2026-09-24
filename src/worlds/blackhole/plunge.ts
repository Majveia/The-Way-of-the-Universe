/**
 * A free-fall plunge into a Kerr black hole, in Kerr–Schild coordinates (G = c = M = 1).
 *
 * The camera rides a "rain" observer (Doran 2000; Hamilton & Lisle 2008 "river model"): dropped
 * from rest at infinity with zero angular momentum (E = 1, L_z = 0, Carter Q = 0). These
 * observers move on timelike geodesics, so integrating the velocity field dx/dτ = u(x) IS the
 * geodesic equation for them — no Christoffel symbols needed. Kerr–Schild coordinates are regular
 * at the future horizon, so the fall continues smoothly through r₊.
 *
 * Schwarzschild check: dr/dτ = −√(2/r), so r(τ) = (r₀^{3/2} − (3/√2)·τ)^{2/3}; the proper time
 * from r₀ to the singularity is (√2/3) r₀^{3/2} M — about 20 minutes from 20 r_g for Sgr A*,
 * 6 ms for a 10 M☉ hole.
 */
import { horizonRadius, innerHorizonRadius, ksRadius, radialVelocity, rainObserver, type Vec3, type Vec4 } from './kerr';

export class PlungeTrajectory {
  readonly a: number;
  /** Kerr–Schild position (M). */
  readonly pos: Vec3;
  /** Proper time elapsed (M). */
  tau = 0;
  /** Coordinate (Kerr–Schild) time elapsed (M). */
  t = 0;

  constructor(a: number, start: Vec3) {
    this.a = a;
    this.pos = [start[0], start[1], start[2]];
  }

  get r(): number {
    return ksRadius(this.a, this.pos[0], this.pos[1], this.pos[2]);
  }

  /** 4-velocity (contravariant, Kerr–Schild) of the observer now. */
  velocity(): Vec4 {
    return rainObserver(this.a, this.pos[0], this.pos[1], this.pos[2]);
  }

  /** dr/dτ (Boyer–Lindquist r) now — always negative. */
  radialSpeed(): number {
    const u = this.velocity();
    return radialVelocity(this.a, this.pos, [u[1], u[2], u[3]]);
  }

  /** Radius where the ride ends: just outside the inner (Cauchy) horizon, or 0.3 r₊ for a ≈ 0. */
  get endRadius(): number {
    const rp = horizonRadius(this.a);
    const rm = innerHorizonRadius(this.a);
    return Math.max(0.3 * rp, rm + 0.35 * (rp - rm));
  }

  get inside(): boolean {
    return this.r < horizonRadius(this.a);
  }

  /** Advance by proper time dτ with classical RK4 on dx/dτ = u(x), sub-stepped to ≤ 1 % of r. */
  step(dTau: number): void {
    let left = dTau;
    const p = this.pos;
    const a = this.a;
    while (left > 1e-12) {
      const r = this.r;
      const h = Math.min(left, 0.01 * Math.max(r, 0.05) / Math.max(Math.abs(this.radialSpeed()), 1e-6));
      const u1 = rainObserver(a, p[0], p[1], p[2]);
      const u2 = rainObserver(a, p[0] + 0.5 * h * u1[1], p[1] + 0.5 * h * u1[2], p[2] + 0.5 * h * u1[3]);
      const u3 = rainObserver(a, p[0] + 0.5 * h * u2[1], p[1] + 0.5 * h * u2[2], p[2] + 0.5 * h * u2[3]);
      const u4 = rainObserver(a, p[0] + h * u3[1], p[1] + h * u3[2], p[2] + h * u3[3]);
      for (let i = 0; i < 3; i++) p[i] += (h / 6) * (u1[i + 1] + 2 * u2[i + 1] + 2 * u3[i + 1] + u4[i + 1]);
      this.t += (h / 6) * (u1[0] + 2 * u2[0] + 2 * u3[0] + u4[0]);
      this.tau += h;
      left -= h;
    }
  }
}

/** Analytic Schwarzschild rain radius after proper time τ from r₀ (for tests and readouts). */
export const schwarzschildRainRadius = (r0: number, tau: number): number =>
  Math.pow(Math.max(0, Math.pow(r0, 1.5) - (3 / Math.SQRT2) * tau), 2 / 3);

/** Proper time for a Schwarzschild rain observer to fall from r₀ to r₁ (M). */
export const schwarzschildRainTime = (r0: number, r1 = 0): number =>
  (Math.SQRT2 / 3) * (Math.pow(r0, 1.5) - Math.pow(r1, 1.5));
