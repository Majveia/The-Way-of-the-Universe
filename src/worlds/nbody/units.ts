import { GM_SUN, KPC, MYR } from '../../physics/constants';

/**
 * Simulation unit system for galaxy dynamics.
 *
 *   [L] = 1 kpc,   [T] = 1 Myr,   [M] = 10¹⁰ M☉
 *
 * Derived:
 *   G = GM☉ · 10¹⁰ · Myr² / kpc³ ≈ 0.044985 kpc³ Myr⁻² (10¹⁰ M☉)⁻¹
 *     (≡ 4.4985 × 10⁻¹² kpc³ Myr⁻² M☉⁻¹, or 4.3009 × 10⁻⁶ kpc (km/s)² M☉⁻¹ — the value
 *      often quoted as "G ≈ 4.3 × 10⁻⁶" is in the km/s form, not kpc³/Myr².)
 *   velocity unit 1 kpc/Myr ≈ 977.79 km/s  (1 km/s ≈ 1.0227 pc/Myr)
 *
 * GM☉ (IAU 2015 nominal, 1.32712440018 × 10²⁰ m³ s⁻²) is used instead of G·M☉ because it
 * is known to ten digits.
 */
export const MASS_UNIT_MSUN = 1e10;
export const G_SIM = (GM_SUN * MASS_UNIT_MSUN * MYR * MYR) / (KPC * KPC * KPC);
/** 1 kpc/Myr expressed in km/s. */
export const KMS_PER_SIM_VELOCITY = KPC / MYR / 1e3;
/** Same G in astronomer's units kpc (km/s)² / M☉ (≈ 4.3009e-6). */
export const G_KPC_KMS2_MSUN = GM_SUN / KPC / 1e6;

export const kmsToSim = (kms: number): number => kms / KMS_PER_SIM_VELOCITY;
export const simToKms = (v: number): number => v * KMS_PER_SIM_VELOCITY;
export const msunToSim = (m: number): number => m / MASS_UNIT_MSUN;
export const simToMsun = (m: number): number => m * MASS_UNIT_MSUN;

/** Circular speed (sim units) at radius r around enclosed mass m (sim units). */
export const circularSpeed = (m: number, r: number): number => Math.sqrt((G_SIM * m) / r);

/** Dynamical (free-fall-ish) time sqrt(r³ / GM) in Myr. */
export const dynamicalTime = (m: number, r: number): number => Math.sqrt((r * r * r) / (G_SIM * m));
