/** IAU constellation abbreviations → [name, genitive]. (IAU 1922/1930, the 88 modern constellations.) */
export const CONSTELLATIONS: Record<string, readonly [string, string]> = {
  And: ['Andromeda', 'Andromedae'], Ant: ['Antlia', 'Antliae'], Aps: ['Apus', 'Apodis'],
  Aqr: ['Aquarius', 'Aquarii'], Aql: ['Aquila', 'Aquilae'], Ara: ['Ara', 'Arae'],
  Ari: ['Aries', 'Arietis'], Aur: ['Auriga', 'Aurigae'], Boo: ['Boötes', 'Boötis'],
  Cae: ['Caelum', 'Caeli'], Cam: ['Camelopardalis', 'Camelopardalis'], Cnc: ['Cancer', 'Cancri'],
  CVn: ['Canes Venatici', 'Canum Venaticorum'], CMa: ['Canis Major', 'Canis Majoris'], CMi: ['Canis Minor', 'Canis Minoris'],
  Cap: ['Capricornus', 'Capricorni'], Car: ['Carina', 'Carinae'], Cas: ['Cassiopeia', 'Cassiopeiae'],
  Cen: ['Centaurus', 'Centauri'], Cep: ['Cepheus', 'Cephei'], Cet: ['Cetus', 'Ceti'],
  Cha: ['Chamaeleon', 'Chamaeleontis'], Cir: ['Circinus', 'Circini'], Col: ['Columba', 'Columbae'],
  Com: ['Coma Berenices', 'Comae Berenices'], CrA: ['Corona Australis', 'Coronae Australis'], CrB: ['Corona Borealis', 'Coronae Borealis'],
  Crv: ['Corvus', 'Corvi'], Crt: ['Crater', 'Crateris'], Cru: ['Crux', 'Crucis'],
  Cyg: ['Cygnus', 'Cygni'], Del: ['Delphinus', 'Delphini'], Dor: ['Dorado', 'Doradus'],
  Dra: ['Draco', 'Draconis'], Equ: ['Equuleus', 'Equulei'], Eri: ['Eridanus', 'Eridani'],
  For: ['Fornax', 'Fornacis'], Gem: ['Gemini', 'Geminorum'], Gru: ['Grus', 'Gruis'],
  Her: ['Hercules', 'Herculis'], Hor: ['Horologium', 'Horologii'], Hya: ['Hydra', 'Hydrae'],
  Hyi: ['Hydrus', 'Hydri'], Ind: ['Indus', 'Indi'], Lac: ['Lacerta', 'Lacertae'],
  Leo: ['Leo', 'Leonis'], LMi: ['Leo Minor', 'Leonis Minoris'], Lep: ['Lepus', 'Leporis'],
  Lib: ['Libra', 'Librae'], Lup: ['Lupus', 'Lupi'], Lyn: ['Lynx', 'Lyncis'],
  Lyr: ['Lyra', 'Lyrae'], Men: ['Mensa', 'Mensae'], Mic: ['Microscopium', 'Microscopii'],
  Mon: ['Monoceros', 'Monocerotis'], Mus: ['Musca', 'Muscae'], Nor: ['Norma', 'Normae'],
  Oct: ['Octans', 'Octantis'], Oph: ['Ophiuchus', 'Ophiuchi'], Ori: ['Orion', 'Orionis'],
  Pav: ['Pavo', 'Pavonis'], Peg: ['Pegasus', 'Pegasi'], Per: ['Perseus', 'Persei'],
  Phe: ['Phoenix', 'Phoenicis'], Pic: ['Pictor', 'Pictoris'], Psc: ['Pisces', 'Piscium'],
  PsA: ['Piscis Austrinus', 'Piscis Austrini'], Pup: ['Puppis', 'Puppis'], Pyx: ['Pyxis', 'Pyxidis'],
  Ret: ['Reticulum', 'Reticuli'], Sge: ['Sagitta', 'Sagittae'], Sgr: ['Sagittarius', 'Sagittarii'],
  Sco: ['Scorpius', 'Scorpii'], Scl: ['Sculptor', 'Sculptoris'], Sct: ['Scutum', 'Scuti'],
  Ser: ['Serpens', 'Serpentis'], Sex: ['Sextans', 'Sextantis'], Tau: ['Taurus', 'Tauri'],
  Tel: ['Telescopium', 'Telescopii'], Tri: ['Triangulum', 'Trianguli'], TrA: ['Triangulum Australe', 'Trianguli Australis'],
  Tuc: ['Tucana', 'Tucanae'], UMa: ['Ursa Major', 'Ursae Majoris'], UMi: ['Ursa Minor', 'Ursae Minoris'],
  Vel: ['Vela', 'Velorum'], Vir: ['Virgo', 'Virginis'], Vol: ['Volans', 'Volantis'],
  Vul: ['Vulpecula', 'Vulpeculae'],
};

/** Bayer three-letter abbreviations (as in the Yale BSC / HYG) → Greek letters. */
export const GREEK: Record<string, string> = {
  Alp: 'α', Bet: 'β', Gam: 'γ', Del: 'δ', Eps: 'ε', Zet: 'ζ', Eta: 'η', The: 'θ', Iot: 'ι', Kap: 'κ',
  Lam: 'λ', Mu: 'μ', Nu: 'ν', Xi: 'ξ', Omi: 'ο', Pi: 'π', Rho: 'ρ', Sig: 'σ', Tau: 'τ', Ups: 'υ',
  Phi: 'φ', Chi: 'χ', Psi: 'ψ', Ome: 'ω',
};
const GREEK_NAMES: Record<string, string> = {
  alpha: 'Alp', beta: 'Bet', gamma: 'Gam', delta: 'Del', epsilon: 'Eps', zeta: 'Zet', eta: 'Eta', theta: 'The',
  iota: 'Iot', kappa: 'Kap', lambda: 'Lam', mu: 'Mu', nu: 'Nu', xi: 'Xi', omicron: 'Omi', pi: 'Pi', rho: 'Rho',
  sigma: 'Sig', tau: 'Tau', upsilon: 'Ups', phi: 'Phi', chi: 'Chi', psi: 'Psi', omega: 'Ome',
};
const SUPERSCRIPT = ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];

/** "Kap-1" → "κ¹"; "Alp" → "α"; returns '' for unknown. */
export function bayerToGreek(bayer: string): string {
  if (!bayer) return '';
  const [base, sup] = bayer.split('-');
  const g = GREEK[base];
  if (!g) return bayer;
  return g + (sup ? sup.split('').map((c) => SUPERSCRIPT[Number(c)] ?? c).join('') : '');
}

/** "α¹ Centauri"-style designation from a Bayer code and constellation abbreviation. */
export function bayerDesignation(bayer: string, con: string, genitive = true): string {
  if (!bayer) return '';
  const c = CONSTELLATIONS[con];
  return `${bayerToGreek(bayer)} ${c ? (genitive ? c[1] : con) : con}`;
}

/**
 * Normalise a user query like "alpha Cen", "α Centauri", "Alp1 Cen" to the HYG form "Alp-1|Cen"
 * (returns null if it does not look like a Bayer designation).
 */
export function parseBayerQuery(q: string): { bayer: string; con: string } | null {
  const s = q.trim();
  const m = /^([A-Za-zα-ω]+)\s*([0-9])?\s+([A-Za-z]+)$/.exec(s);
  if (!m) return null;
  let letter = m[1];
  const lower = letter.toLowerCase();
  const byGreekChar = Object.entries(GREEK).find(([, g]) => g === letter)?.[0];
  if (byGreekChar) letter = byGreekChar;
  else if (GREEK_NAMES[lower]) letter = GREEK_NAMES[lower];
  else letter = letter.charAt(0).toUpperCase() + letter.slice(1, 3).toLowerCase();
  if (!GREEK[letter]) return null;
  const conQ = m[3].toLowerCase();
  const con = Object.keys(CONSTELLATIONS).find(
    (k) => k.toLowerCase() === conQ || CONSTELLATIONS[k][0].toLowerCase() === conQ || CONSTELLATIONS[k][1].toLowerCase() === conQ,
  );
  if (!con) return null;
  return { bayer: m[2] ? `${letter}-${m[2]}` : letter, con };
}
