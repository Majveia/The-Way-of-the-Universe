/** Info cards: real numbers for every body, formatted the way astronomers quote them. */
import * as THREE from 'three';
import type { InfoCard } from '../../ui/UI';
import type { SolarBody, SolarSystemModel } from '../../worlds/solar/SolarSystemModel';
import { AU_KM, makeOrbitGeometry } from '../../worlds/solar/SolarSystemModel';
import { formatDistance, formatMass, formatNumber, joinFormatted } from '../../physics/units';
import { AU, C } from '../../physics/constants';

const geom = makeOrbitGeometry();
const DAY = 86400;

export function formatPeriod(days: number): string {
  const d = Math.abs(days);
  if (!isFinite(d)) return 'unbound (hyperbolic)';
  if (d < 2) return `${formatNumber(d * 24, 3)} h`;
  if (d < 1000) return `${formatNumber(d, 4)} d`;
  return `${formatNumber(d / 365.25, 4)} yr`;
}

export function formatLightTime(au: number): string {
  const s = (au * AU) / C;
  if (s < 60) return `${s.toFixed(1)} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
  const h = Math.floor(s / 3600);
  return `${h} h ${Math.round((s % 3600) / 60)} min`;
}

export function formatAU(au: number): string {
  return joinFormatted(formatDistance(au * AU, 4));
}

function tilt(b: SolarBody): string | null {
  if (!b.def.rotation || !b.parent) return null;
  const n = new THREE.Vector3().crossVectors(b.local, b.localVelocity);
  if (n.lengthSq() === 0) return null;
  let a = (b.pole.angleTo(n) * 180) / Math.PI;
  // Retrograde rotators: quote the obliquity of the right-hand spin axis (Venus 177°, Uranus 98°).
  if (b.def.rotation.Wd < 0) a = 180 - a;
  return `${a.toFixed(a < 10 ? 2 : 1)}°`;
}

function rotation(b: SolarBody): string | null {
  const r = b.def.rotation;
  if (r && r.Wd !== 0) {
    const days = 360 / r.Wd;
    return `${formatPeriod(days)}${days < 0 ? ' (retrograde)' : ''}`.replace('−', '−');
  }
  if (b.def.locked) return 'synchronous';
  if (b.def.spinHours) return formatPeriod(b.def.spinHours / 24) + (b.def.spinHours < 0 ? ' (retrograde)' : '');
  return null;
}

export function infoCard(model: SolarSystemModel, b: SolarBody): InfoCard {
  const def = b.def;
  const rows: Array<[string, string]> = [];
  if (def.kind !== 'star') {
    rows.push(['From the Sun', `${formatAU(b.sunDistance)} · ${formatLightTime(b.sunDistance)}`]);
    if (b.parent && b.parent.def.kind !== 'star') rows.push([`From ${b.parent.def.name}`, joinFormatted(formatDistance(b.local.length() * AU, 4))]);
  }
  if (def.kind !== 'spacecraft') {
    const R = def.radiusKm;
    const rTxt = R >= 1 ? `${formatNumber(R, 4)} km` : `${formatNumber(R * 1000, 3)} m`;
    rows.push(['Radius', def.kind === 'planet' ? `${rTxt} · ${formatNumber(R / 6371, 3)} R⊕` : rTxt]);
  }
  if (def.massKg) rows.push(['Mass', joinFormatted(formatMass(def.massKg, 4))]);
  if (b.parent && model.orbitGeometry(b, geom)) {
    rows.push(['Orbital period', formatPeriod(geom.period)]);
    if (def.kind !== 'moon') {
      const q = geom.hyperbolic ? geom.a * (geom.e - 1) : geom.a * (1 - geom.e);
      rows.push(['Perihelion', formatAU(q)]);
      if (!geom.hyperbolic && geom.e > 0.02) rows.push(['Aphelion', formatAU(geom.a * (1 + geom.e))]);
    }
    rows.push(['Eccentricity', geom.e.toFixed(geom.e < 0.1 ? 4 : 3)]);
    const v = b.localVelocity.length() * (AU_KM / DAY);
    rows.push([def.kind === 'moon' ? 'Orbital speed' : 'Heliocentric speed', `${v.toFixed(v < 10 ? 2 : 1)} km/s`]);
  }
  const rot = rotation(b);
  if (rot) rows.push(['Rotation', rot]);
  const t = tilt(b);
  if (t) rows.push(['Axial tilt', t]);
  if (def.kind !== 'star' && def.kind !== 'spacecraft') rows.push(['Geometric albedo', def.albedo.toFixed(2)]);
  if (def.facts) for (const [k, v] of Object.entries(def.facts)) if (!rows.some((r) => r[0] === k)) rows.push([k, v]);
  return { title: def.name, subtitle: def.subtitle, rows: rows.slice(0, 11), body: def.blurb };
}
