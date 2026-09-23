/**
 * Galaxies in dark-matter halos (module: cosmos) — simple, published empirical relations.
 *
 * - Stellar mass: Moster, Naab & White (2013), MNRAS 428, 3121, eqs. 2 & 11–14 (abundance matching):
 *     M⋆ / M = 2N [(M/M1)^−β + (M/M1)^γ]^−1 with redshift-dependent N, M1, β, γ.
 *   Star formation is least efficient in dwarfs (feedback) and in groups/clusters (AGN, hot halos),
 *   and peaks at ~3 % near M ≈ 10¹² M☉ — the Milky Way's halo.
 * - Quenching: massive central galaxies stop forming stars above a few × 10¹² M☉ (halo quenching),
 *   later at high redshift; satellites keep forming stars for a few Gyr after falling into a group,
 *   then quench quickly (the "delayed-then-rapid" model of Wetzel et al. 2013, MNRAS 432, 336).
 *   That is the morphology–density relation: red ellipticals crowd cluster cores (Dressler 1980).
 * - Mergers: satellites sink to the centre by dynamical friction on the timescale of
 *   Boylan-Kolchin, Ma & Quataert (2008), MNRAS 383, 93, eq. 6 (with circularity η = 0.5).
 * - Cosmic star-formation history: Madau & Dickinson (2014), ARA&A 52, 415, eq. 15.
 */

/** Stellar mass (M☉) of the central galaxy of a halo of mass M (M☉) at redshift z. */
export function stellarMass(M: number, z: number): number {
  const zz = Math.max(0, z) / (Math.max(0, z) + 1);
  const M1 = Math.pow(10, 11.59 + 1.195 * zz);
  const N = 0.0351 - 0.0247 * zz;
  const beta = 1.376 - 0.826 * zz;
  const gamma = 0.608 + 0.329 * zz;
  const x = M / M1;
  return M * 2 * N / (Math.pow(x, -beta) + Math.pow(x, gamma));
}

/** Probability that a central galaxy in a halo of mass M (M☉) at redshift z has quenched. */
export function centralQuenchedFraction(M: number, z: number): number {
  const Mq = Math.pow(10, 12.2 + 0.35 * Math.min(z, 4));
  const f = 1 / (1 + Math.pow(Mq / Math.max(M, 1), 1.6));
  return f * (z > 3 ? Math.max(0, 1 - (z - 3) / 2) : 1);
}

/** Satellite quenching: star-forming for tDelay after infall, then e-folding with tau (Gyr). */
export function satelliteQuenched(timeSinceInfallGyr: number, tDelay = 2.5, tau = 0.6): number {
  if (timeSinceInfallGyr <= tDelay) return 0;
  return 1 - Math.exp(-(timeSinceInfallGyr - tDelay) / tau);
}

/**
 * Dynamical-friction merging time (Gyr) of a satellite of mass ratio r = M_host/M_sat in a host
 * whose dynamical time is tDyn (Gyr, ≈ 0.1/H(z)).
 */
export function mergingTime(ratio: number, tDynGyr: number, eta = 0.5): number {
  const r = Math.max(ratio, 1.01);
  return (0.216 * Math.pow(r, 1.3) / Math.log(1 + r)) * Math.exp(1.9 * eta) * tDynGyr;
}

/** Cosmic star-formation-rate density, M☉ yr⁻¹ Mpc⁻³ (Madau & Dickinson 2014). */
export function cosmicSFRD(z: number): number {
  return (0.015 * Math.pow(1 + z, 2.7)) / (1 + Math.pow((1 + z) / 2.9, 5.6));
}

/** Halo virial radius R200c in physical kpc for M (M☉) given H(z) in km/s/Mpc. */
export function r200c(M: number, HkmsMpc: number): number {
  // ρc = 3H²/8πG; with G = 4.30091e-6 kpc (km/s)² / M☉ and H in km/s/kpc.
  const G = 4.30091e-6;
  const H = HkmsMpc / 1000;
  const rhoc = (3 * H * H) / (8 * Math.PI * G); // M☉ / kpc³
  return Math.cbrt((3 * M) / (4 * Math.PI * 200 * rhoc));
}

/** Circular velocity at R200c, km/s. */
export function v200(M: number, rKpc: number): number {
  return Math.sqrt((4.30091e-6 * M) / Math.max(rKpc, 1e-9));
}
