import { formatNumber } from '../../physics/units';
import type { InfoCard } from '../../ui/UI';
import type { PlanetData, SystemData } from '../../worlds/systems';
import { angularRadius } from '../../worlds/systems';

/** Info cards and short strings for Possible Worlds (all numbers via units.ts). */

const n = (x: number, d = 3) => formatNumber(x, d);

export function formatPeriod(days: number): string {
  if (!isFinite(days)) return '∞';
  if (days < 2) return `${n(days * 24)} h`;
  if (days < 800) return `${n(days)} d`;
  return `${n(days / 365.25)} yr`;
}

export function formatHours(h: number): string {
  if (!isFinite(h)) return 'permanent (locked)';
  const a = Math.abs(h);
  const s = a < 48 ? `${n(a)} h` : a < 24 * 800 ? `${n(a / 24)} d` : `${n(a / 8766)} yr`;
  return h < 0 ? `${s} retrograde` : s;
}

function massText(m: number): string {
  return m >= 30 ? `${n(m / 317.83)} M♃ · ${n(m, 4)} M⊕` : `${n(m)} M⊕`;
}
function radiusText(r: number): string {
  return r >= 4 ? `${n(r / 11.209)} R♃ · ${n(r)} R⊕` : `${n(r)} R⊕ · ${formatNumber(r * 6371, 3)} km`;
}

const CLASS_NAME: Record<PlanetData['class'], string> = {
  rocky: 'Rocky planet',
  icy: 'Icy rocky planet',
  'super-earth': 'Super-Earth',
  'water-world': 'Water world',
  'sub-neptune': 'Sub-Neptune',
  'ice-giant': 'Ice giant',
  'gas-giant': 'Gas giant',
};

export function planetCard(sys: SystemData, p: PlanetData): InfoCard {
  const surface = p.atmosphere && p.kind !== 'gas-giant' && p.kind !== 'ice-giant';
  // The description already covers locked worlds; add the tidal clock for those still spinning.
  const lockNote = !p.tidallyLocked && p.lockTimeYears < 1e11 ? ` Tides will lock its spin in ~${formatNumber(p.lockTimeYears / 1e9, 2)} Gyr.` : '';
  const rows: Array<[string, string]> = [
    ['Mass', massText(p.mass)],
    ['Radius', radiusText(p.radius)],
    ['Density · gravity', `${n(p.density)} g/cm³ · ${n(p.gravity)} g`],
    ['Orbit', `${n(p.orbit.a)} AU · ${formatPeriod(p.periodDays)} · e ${p.orbit.e.toFixed(2)}`],
    ['Starlight', `${n(p.insolation)} × Earth`],
    ['Temperature', surface ? `${n(p.teq, 3)} K eq · ≈ ${n(p.surfaceTemp, 3)} K surface` : `${n(p.teq, 3)} K equilibrium`],
    ['Habitable zone', p.hz],
    ['Day', p.spinOrbit === '1:1' ? 'none — tidally locked' : p.spinOrbit ? `${formatHours(p.dayHours)} · ${p.spinOrbit} locked` : formatHours(p.dayHours)],
  ];
  if (p.moons.length) rows.push(['Moons', p.moons.map((m) => m.name.split(' ')[1]).join(' · ')]);
  if (p.resonance) rows.push(['Resonance', `${p.resonance} with inner neighbour`]);
  return {
    title: p.givenName,
    subtitle: `${p.designation} · ${CLASS_NAME[p.class]}`,
    rows,
    body: `${p.description}${lockNote} Likely make-up, from density and birthplace: ${p.composition}.`,
  };
}

export function starCard(sys: SystemData): InfoCard {
  const s = sys.star;
  const rows: Array<[string, string]> = [
    ['Type', s.spectralType],
    ['Mass', `${n(s.mass)} M☉`],
    ['Radius', `${n(s.radius)} R☉`],
    ['Luminosity', `${n(s.luminosity)} L☉`],
    ['Temperature', `${formatNumber(Math.round(s.teff), 4)} K`],
    ['Age', `${n(s.ageGyr, 2)} Gyr`],
    ['Metallicity', `[Fe/H] ${sys.metallicity >= 0 ? '+' : '−'}${Math.abs(sys.metallicity).toFixed(2)}`],
    ['Habitable zone', `${n(sys.hz.runaway)} – ${n(sys.hz.maxGreenhouse)} AU`],
    ['Snow line', `${n(sys.snowLine)} AU`],
    ['Distance', `${n(sys.distancePc)} pc`],
  ];
  const c = sys.companion;
  if (c) {
    rows.push(['Companion', `${c.star.spectralType} · ${n(c.star.mass)} M☉`]);
    rows.push(['Binary orbit', `${n(c.orbit.a)} AU · ${formatPeriod(c.periodDays)} · e ${c.orbit.e.toFixed(2)}`]);
    rows.push([c.config === 'P' ? 'Stable beyond' : 'Stable within', `${n(c.critical)} AU (Holman–Wiegert)`]);
  }
  return {
    title: `${sys.name}`,
    subtitle: `${sys.catalogue} · ${s.spectralType}`,
    rows,
    body: sys.summary,
  };
}

/** Apparent size of the star from the planet, compared with the Sun from Earth (0.533°). */
export function skySizeText(sys: SystemData, p: PlanetData): string {
  const ang = 2 * angularRadius(sys.star, p.orbit.a) * (180 / Math.PI);
  return `${n(ang)}° · ${n(ang / 0.533)}× the Sun`;
}
