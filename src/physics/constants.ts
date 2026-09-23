/**
 * Physical and astronomical constants, SI units unless noted.
 * Sources: CODATA 2018, IAU 2012/2015 nominal values, Planck 2018 (Paper VI, Table 2, TT,TE,EE+lowE+lensing+BAO).
 */
export const C = 299_792_458; // speed of light, m/s
export const G = 6.6743e-11; // gravitational constant, m^3 kg^-1 s^-2
export const H_PLANCK = 6.62607015e-34; // J s
export const HBAR = H_PLANCK / (2 * Math.PI);
export const K_B = 1.380649e-23; // J/K
export const SIGMA_SB = 5.670374419e-8; // W m^-2 K^-4
export const WIEN_B = 2.897771955e-3; // m K

// Lengths
export const KM = 1e3;
export const AU = 1.495978707e11; // IAU 2012 exact
export const LY = 9.4607304725808e15; // Julian year × c
export const PC = 3.0856775814913673e16;
export const KPC = 1e3 * PC;
export const MPC = 1e6 * PC;
export const GPC = 1e9 * PC;

// Time
export const MINUTE = 60;
export const HOUR = 3600;
export const DAY = 86_400;
export const YEAR = 365.25 * DAY; // Julian year
export const KYR = 1e3 * YEAR;
export const MYR = 1e6 * YEAR;
export const GYR = 1e9 * YEAR;
export const J2000_JD = 2_451_545.0; // 2000-01-01 12:00 TT
export const UNIX_EPOCH_JD = 2_440_587.5;

// Masses, radii, luminosities
export const M_SUN = 1.98847e30;
export const GM_SUN = 1.32712440018e20; // m^3/s^2 (more precise than G*M)
export const R_SUN = 6.957e8; // IAU 2015 nominal
export const L_SUN = 3.828e26; // IAU 2015 nominal
export const T_SUN = 5772; // K effective temperature
export const M_EARTH = 5.9722e24;
export const GM_EARTH = 3.986004418e14;
export const R_EARTH = 6.371e6; // mean radius
export const M_MOON = 7.342e22;
export const M_JUPITER = 1.89813e27;
export const GM_JUPITER = 1.26686534e17;
export const R_JUPITER = 7.1492e7; // equatorial

// Astronomy
export const OBLIQUITY_J2000 = (23.4392911 * Math.PI) / 180; // ecliptic obliquity
export const T_CMB0 = 2.7255; // K, Fixsen 2009
export const ABS_MAG_SUN_V = 4.83;

/** Planck 2018 cosmology (as astropy.cosmology.Planck18). */
export const PLANCK18 = {
  H0: 67.66, // km/s/Mpc
  Om0: 0.30966, // total matter (incl. massive-neutrino contribution as matter)
  Ob0: 0.04897,
  Tcmb0: 2.7255,
  Neff: 3.046,
  ns: 0.9665,
  sigma8: 0.8102,
  zReion: 7.82,
  zRecombination: 1089.8,
} as const;

/** Solar-mass Schwarzschild radius 2GM/c² in metres. */
export const RS_SUN = (2 * GM_SUN) / (C * C);

export const DEG = Math.PI / 180;
export const ARCSEC = DEG / 3600;
