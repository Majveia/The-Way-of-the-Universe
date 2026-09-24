import type { Rng } from '../../physics/random';

/**
 * Procedural names. Catalogue designations follow the exoplanet convention (host designation,
 * then b, c, d… in order of discovery — here, of distance), plus an evocative given name built
 * from soft syllables, the way the IAU NameExoWorlds campaigns attach names to catalogue entries.
 */

const ONSET = ['', '', 'b', 'c', 'd', 'k', 'l', 'm', 'n', 'r', 's', 't', 'v', 'z', 'th', 'sh', 'kh', 'ph', 'dr', 'tr', 'al', 'el', 'or', 'y'];
const VOWEL = ['a', 'a', 'e', 'e', 'i', 'o', 'u', 'ae', 'ai', 'io', 'ea', 'ia', 'ou', 'y'];
const CODA = ['', '', '', 'n', 'r', 's', 'l', 'th', 'x', 'm', 'nd', 'sk', 'rn', 'ss'];
const ENDINGS = ['a', 'is', 'on', 'ara', 'ium', 'os', 'e', 'ia', 'en', 'ar', 'ys', 'une', 'eth', 'ai'];

function syllable(rng: Rng): string {
  return rng.pick(ONSET) + rng.pick(VOWEL) + rng.pick(CODA);
}

/** A pronounceable name of 2–3 syllables, capitalised ("Vaelith", "Oranthe"). */
export function givenName(rng: Rng): string {
  for (let tries = 0; tries < 12; tries++) {
    const n = rng.chance(0.55) ? 1 : 2;
    let s = '';
    for (let i = 0; i < n; i++) s += syllable(rng);
    s += rng.pick(ENDINGS);
    s = s.replace(/(.)\1\1+/g, '$1$1').replace(/^[^a-z]*/, '');
    // Reject awkward clusters and very short or long results.
    if (s.length < 4 || s.length > 10) continue;
    if (/[^aeiouy]{4}/.test(s) || /[aeiouy]{4}/.test(s)) continue;
    return s[0].toUpperCase() + s.slice(1);
  }
  return 'Nova';
}

/** "TWU 48213" — The Way of the Universe catalogue number derived from the seed. */
export function catalogueName(seed: number): string {
  const n = ((seed >>> 0) % 90000) + 10000;
  return `TWU ${n}`;
}

export const PLANET_LETTERS = 'bcdefghijklmnop';
