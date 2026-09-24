import { G_SIM } from './units';

/**
 * Density-triggered star formation for the gas tracers (units: kpc, Myr, 10¹⁰ M☉).
 *
 * The gas tracers are collisionless, but they do know where gas piles up: every step they are
 * deposited (nearest-grid-point) into two 64³ grids of 0.75 kpc cells, one centred on each galaxy.
 * A gas parcel at density ρ then forms stars as a Poisson process with the rate of a Schmidt law
 * written per free-fall time (Krumholz & McKee 2005; Krumholz & Tan 2007):
 *
 *     dρ★/dt = ε_ff ρ / t_ff,       t_ff = √(3π / (32 G ρ)),       for ρ > ρ_th
 *
 * so the rate per parcel is ε_ff / t_ff ∝ ρ^½ and the volumetric law is ρ★ ∝ ρ^1.5 — which,
 * for a disk of fixed thickness, is the Kennicutt (1998) relation Σ_SFR ∝ Σ_gas^1.4–1.5.
 *
 * Calibration: with ε_ff = 0.03 an Sc disk with Σ_gas ≈ 12 M☉ pc⁻² (ρ ≈ 1.7×10⁷ M☉ kpc⁻³ in a
 * 0.75 kpc cell) has t_ff ≈ 60 Myr and a gas depletion time t_ff/ε_ff ≈ 2 Gyr — the observed
 * value for normal spirals (Bigiel et al. 2008; Leroy et al. 2008). The threshold
 * ρ_th ↔ Σ_gas ≈ 7 M☉ pc⁻² mimics the Kennicutt (1989) / Schaye (2004) cut-off in outer disks.
 * Compressing the gas by 10× during a collision shortens the local depletion time ~3×
 * and puts 10× more parcels in each cell: a ~30× jump in the surface density of young clusters,
 * the blue knots and Hα regions of the Antennae's overlap region and tails.
 */

export const SF_GRID_N = 64;
/** Cell size (kpc). The grid spans ±24 kpc around each galaxy centre. */
export const SF_GRID_CELL = 0.75;
/** Deposit scale: grid values are in units of 10⁶ M☉ (keeps half floats well-conditioned). */
export const SF_MASS_SCALE = 1e4;
export const SF_EPS_FF = 0.03;
/**
 * Density threshold (10¹⁰ M☉ kpc⁻³): 9.3×10⁶ M☉ kpc⁻³, i.e. Σ_gas ≈ 7 M☉ pc⁻² spread over a
 * 0.75 kpc cell — the observed break of the Kennicutt–Schmidt law in outer disks. The rate ramps
 * up over the next 25 % in density.
 */
export const SF_RHO_TH = 9.3e-4;
const SF_EDGE = 0.25;
/** A parcel may burst again only this long (Myr) after its previous burst (feedback disperses it). */
export const SF_REFRACTORY = 30;
/** Fraction of a gas parcel's mass turned into its young cluster per burst. */
export const SF_EFFICIENCY = 0.08;

export const freeFallTime = (rho: number): number => Math.sqrt((3 * Math.PI) / (32 * G_SIM * Math.max(rho, 1e-30)));

/** Star-formation rate per unit gas mass (Myr⁻¹) at density ρ; zero below threshold (soft edge). */
export function sfRate(rho: number): number {
  if (rho <= SF_RHO_TH) return 0;
  const edge = Math.min(1, (rho - SF_RHO_TH) / (SF_EDGE * SF_RHO_TH));
  return (edge * SF_EPS_FF) / freeFallTime(rho);
}

/**
 * Probability that a parcel has a burst during a step dt (Myr). A burst turns a fraction
 * SF_EFFICIENCY of the parcel into a cluster (the cloud-scale efficiency of ~5–10 % seen in
 * nearby molecular clouds), so bursts occur at sfRate/SF_EFFICIENCY and the mean mass
 * conversion rate is exactly the Schmidt-law rate.
 */
export const sfProbability = (rho: number, dt: number): number => 1 - Math.exp((-sfRate(rho) * dt) / SF_EFFICIENCY);

/** Gas depletion time M_gas / SFR (Myr) at density ρ (∞ below threshold). */
export const depletionTime = (rho: number): number => 1 / Math.max(sfRate(rho), 1e-300);

/** GLSL twin of sfRate (G in sim units baked in). */
export const SF_GLSL = /* glsl */ `
float sfRate(float rho) {
  if (rho <= ${SF_RHO_TH.toExponential(6)}) return 0.0;
  float edge = min(1.0, (rho - ${SF_RHO_TH.toExponential(6)}) / ${(SF_EDGE * SF_RHO_TH).toExponential(6)});
  float tff = sqrt(${((3 * Math.PI) / (32 * G_SIM)).toExponential(8)} / rho);
  return edge * ${SF_EPS_FF.toFixed(6)} / tff;
}`;
