import type { StarHint } from '../systems/generate';

/**
 * Which real (catalogue) stars get procedurally generated planets in the explorer, and how the
 * system generator must model the host so that it matches the star the traveller actually sees.
 *
 * The generator (src/worlds/systems, "Possible Worlds") draws a random evolutionary stage when none is
 * given — about 3 % giants and 3 % white dwarfs. For a catalogue star that would put, say, a 20 R☉
 * red giant (and the planets it has engulfed) around α Centauri A, so the explorer always fixes the
 * stage. Hosts it cannot model faithfully get no planets:
 *
 *  - giants and supergiants (M_V < 0.5; also excludes the brightest main-sequence B stars, which is
 *    conservative): their planetary systems would need the real star's mass and radius history;
 *  - white dwarfs (hotter than 4 200 K yet fainter than M_V = 9.5 — far below the main sequence,
 *    where a 4 200 K K dwarf has M_V ≈ 7.8; Pecaut & Mamajek 2013): the generator's white dwarf draws
 *    its own cooling age and temperature, which would contradict the catalogue star.
 *
 * Everything else is a main-sequence host whose mass the generator infers from T_eff.
 */
export type HostKind = 'main-sequence' | 'giant' | 'white-dwarf';

export function classifyHost(absMagV: number, teff: number): HostKind {
  if (absMagV < 0.5) return 'giant';
  if (teff > 4200 && absMagV > 9.5) return 'white-dwarf';
  return 'main-sequence';
}

/** Generator hint for a catalogue host, or null if the explorer models no planets for it. */
export function procHostHint(absMagV: number, teff: number): StarHint | null {
  if (!Number.isFinite(absMagV) || !Number.isFinite(teff)) return null;
  return classifyHost(absMagV, teff) === 'main-sequence' ? { teff, stage: 'main-sequence', binary: false } : null;
}
