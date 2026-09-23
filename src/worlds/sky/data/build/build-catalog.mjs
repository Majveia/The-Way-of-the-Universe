#!/usr/bin/env node
/**
 * Builds src/worlds/sky/data/stars.ts — the compact real-sky catalogue used by `Sky` and Voyage.
 *
 * Source: HYG database v4.4 (Hipparcos–Yale–Gliese), David Nash / astronexus,
 *   https://codeberg.org/astronexus/hyg  (data/hyg/CURRENT/hyg_v44.csv.gz)
 *   Licence: CC BY-SA 4.0. The generated catalogue is a derivative and is distributed under
 *   the same licence (see docs/CREDITS.md). This script is not bundled into the app.
 *
 * Usage:
 *   curl -L -o hyg_v44.csv.gz https://codeberg.org/astronexus/hyg/media/branch/main/data/hyg/CURRENT/hyg_v44.csv.gz
 *   gunzip hyg_v44.csv.gz
 *   node src/worlds/sky/data/build/build-catalog.mjs hyg_v44.csv
 *
 * Selection: every star with V ≤ 6.5 (the naked-eye sky) plus every star within 25 pc
 * (≈ 82 ly, the solar neighbourhood you can fly through), plus the Sun and a few famous
 * systems missing from HYG (Luhman 16, TRAPPIST-1).
 *
 * Binary layout (little-endian, struct of arrays, sorted by apparent V from Earth, brightest first):
 *   header   16 B : 'TWUS' | u16 version (2) | u16 reserved | u32 count | u32 reserved
 *   ra       u24×n: right ascension J2000, 2^24 steps per 360° (0.077″)
 *   dec      u24×n: declination J2000 + 90°, 2^24 steps per 180° (0.039″)
 *   dist     u16×n: log10(d / pc) mapped from [−1, 4] to [1, 65535]; 0 = the Sun (d = 0)
 *   vx,vy,vz i16×n: heliocentric space velocity, equatorial, units of 1e-7 pc/yr (≈ 0.0978 km/s)
 *   absMag   i16×n: absolute visual magnitude M_V × 1000
 *   bv       u8 ×n: B−V = −0.40 + 0.01 × value (clamped to [−0.40, 2.15])
 *   flags    u8 ×n: 1 distance estimated · 2 B−V estimated · 4 variable · 8 multiple-system member
 * Names: a '\n'-separated table "index|proper|bayer|con|spect" for stars with a proper name or a
 * Bayer letter.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = process.argv[2];
if (!src) {
  console.error('usage: node build-catalog.mjs <hyg_v44.csv>');
  process.exit(1);
}
const lines = readFileSync(src, 'utf8').split('\n');
const hdr = lines[0].split(',').map((s) => s.replace(/"/g, ''));
function parseLine(l) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < l.length; i++) {
    const c = l[i];
    if (c === '"') q = !q;
    else if (c === ',' && !q) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}
const num = (s) => (s === '' || s === undefined ? NaN : Number(s));
const rows = [];
for (let i = 1; i < lines.length; i++) {
  if (!lines[i]) continue;
  const f = parseLine(lines[i]);
  const o = {};
  hdr.forEach((h, k) => (o[h] = f[k]));
  rows.push(o);
}

// ——— Spectral-type helpers (for the few stars without parallax or colour) ———
// Main-sequence M_V and B−V by spectral class (Schmidt-Kaler 1982 / Pecaut & Mamajek 2013, rounded).
const MS = {
  O: [[5, -5.7, -0.33], [9, -4.5, -0.31]],
  B: [[0, -4.0, -0.3], [3, -1.6, -0.2], [5, -1.2, -0.17], [8, -0.25, -0.11]],
  A: [[0, 0.65, 0.0], [5, 1.95, 0.15]],
  F: [[0, 2.7, 0.3], [5, 3.5, 0.44]],
  G: [[0, 4.4, 0.58], [5, 5.1, 0.68]],
  K: [[0, 5.9, 0.81], [5, 7.35, 1.15]],
  M: [[0, 8.8, 1.4], [3, 10.5, 1.5], [5, 12.3, 1.64], [8, 16.5, 2.0]],
};
function interpClass(cls, sub, col) {
  const t = MS[cls];
  if (!t) return NaN;
  if (sub <= t[0][0]) return t[0][col];
  for (let i = 1; i < t.length; i++) {
    if (sub <= t[i][0]) {
      const a = t[i - 1], b = t[i];
      return a[col] + ((b[col] - a[col]) * (sub - a[0])) / (b[0] - a[0]);
    }
  }
  return t[t.length - 1][col];
}
function parseSpect(s) {
  const m = /([OBAFGKM])\s*([0-9](?:\.[0-9])?)?\s*(Ia|Iab|Ib|III|II|IV|V|I)?/.exec(s || '');
  if (!m) return null;
  return { cls: m[1], sub: m[2] ? Number(m[2]) : 5, lum: m[3] || 'V' };
}
function absMagFromSpect(s) {
  const p = parseSpect(s);
  if (!p) return NaN;
  const ms = interpClass(p.cls, p.sub, 1);
  switch (p.lum) {
    case 'Ia': return -7.5;
    case 'Iab': return -6.5;
    case 'Ib': case 'I': return -5.5;
    case 'II': return -3;
    case 'III': return p.cls === 'O' || p.cls === 'B' ? -3.5 : p.cls === 'A' ? 0.2 : p.cls === 'F' ? 1.2 : 0.4;
    case 'IV': return Math.min(ms, 3) - 1;
    default: return ms;
  }
}
function bvFromSpect(s) {
  const p = parseSpect(s);
  if (!p) return NaN;
  return interpClass(p.cls, p.sub, 2) + (p.lum.startsWith('I') && p.lum !== 'IV' && (p.cls === 'K' || p.cls === 'G') ? 0.2 : 0);
}

// Modern parallax distances for key neighbours (Gaia DR3 / Akeson+2021 / van Leeuwen 2007), pc.
const DIST_OVERRIDE = {
  'Proxima Centauri': 1000 / 768.0665,
  'Rigil Kentaurus': 1000 / 750.81,
  Toliman: 1000 / 750.81,
  "Barnard's Star": 1000 / 546.9759,
  'Wolf 359': 1000 / 415.1794,
  'Lalande 21185': 1000 / 392.7529,
  Sirius: 1000 / 379.21,
  Ran: 1000 / 310.577,
  'Ross 128': 1000 / 296.3,
  "Luyten's Star": 1000 / 264.13,
};

// Stars missing from HYG that matter for a voyage through the neighbourhood.
const EXTRA = [
  // Luhman 16 AB: nearest brown-dwarf binary (Luhman 2013; Gaia DR3 ϖ = 501.557 mas). Teff ≈ 1300 K.
  { proper: 'Luhman 16', ra: 10.82099, dec: -53.31889, dist: 1000 / 501.557, absmag: 26.0, ci: 6.5, spect: 'L7.5+T0.5', gl: 'Luhman 16', bvEst: true },
  // TRAPPIST-1: ultracool M8V dwarf with seven Earth-sized planets (Gillon+2017; ϖ = 80.21 mas).
  { proper: 'TRAPPIST-1', ra: 23.10816, dec: -5.04147, dist: 1000 / 80.2123, absmag: 18.35, ci: 2.3, spect: 'M8V', gl: 'TRAPPIST-1', bvEst: true },
];

const selected = [];
for (const r of rows) {
  const mag = num(r.mag);
  let dist = num(r.dist);
  if (!isFinite(mag)) continue;
  const isSun = r.proper === 'Sol';
  const near = dist > 0 && dist <= 25;
  if (!(isSun || mag <= 6.5 || near)) continue;
  let flags = 0;
  if (DIST_OVERRIDE[r.proper]) dist = DIST_OVERRIDE[r.proper];
  let absmag = num(r.absmag);
  if (!isSun && (!(dist > 0) || dist >= 1e5)) {
    let M = absMagFromSpect(r.spect);
    if (!isFinite(M)) M = -1;
    dist = Math.min(4000, Math.max(20, Math.pow(10, (mag - M + 5) / 5)));
    absmag = M;
    flags |= 1;
  } else if (!isSun) {
    absmag = mag - 5 * Math.log10(dist / 10);
  }
  let bv = num(r.ci);
  if (!isFinite(bv)) {
    bv = bvFromSpect(r.spect);
    if (!isFinite(bv)) bv = absmag > 9 ? 1.55 : 0.65;
    flags |= 2;
  }
  if (r.var) flags |= 4;
  if (r.base || (r.comp && r.comp !== '1')) flags |= 8;
  // Direction from RA/Dec (HYG x,y,z carry the same information, but we re-derive with our distance).
  const ra = (num(r.ra) * 15 * Math.PI) / 180;
  const de = (num(r.dec) * Math.PI) / 180;
  const d = isSun ? 0 : dist;
  selected.push({
    x: d * Math.cos(de) * Math.cos(ra),
    y: d * Math.cos(de) * Math.sin(ra),
    z: d * Math.sin(de),
    vx: num(r.vx) || 0,
    vy: num(r.vy) || 0,
    vz: num(r.vz) || 0,
    absmag: isSun ? 4.83 : absmag,
    mag: isSun ? -26.74 : mag,
    bv,
    hip: num(r.hip) || 0,
    flags,
    proper: r.proper === 'Sol' ? 'Sun' : r.proper,
    bayer: r.bayer,
    flam: r.flam,
    con: r.con,
    spect: r.spect,
    gl: r.gl,
  });
}
for (const e of EXTRA) {
  const ra = (e.ra * 15 * Math.PI) / 180;
  const de = (e.dec * Math.PI) / 180;
  selected.push({
    x: e.dist * Math.cos(de) * Math.cos(ra),
    y: e.dist * Math.cos(de) * Math.sin(ra),
    z: e.dist * Math.sin(de),
    vx: 0, vy: 0, vz: 0,
    absmag: e.absmag,
    mag: e.absmag + 5 * Math.log10(e.dist / 10),
    bv: e.ci,
    hip: 0,
    flags: e.bvEst ? 2 : 0,
    proper: e.proper,
    bayer: '', flam: '', con: '', spect: e.spect, gl: e.gl,
  });
}
selected.sort((a, b) => a.mag - b.mag);
const n = selected.length;

// ——— Pack ———
const HEADER = 16;
const PER_STAR = 3 + 3 + 2 + 3 * 2 + 2 + 1 + 1;
const bytes = HEADER + n * PER_STAR;
const buf = new ArrayBuffer(bytes);
const dv = new DataView(buf);
dv.setUint8(0, 0x54); dv.setUint8(1, 0x57); dv.setUint8(2, 0x55); dv.setUint8(3, 0x53); // 'TWUS'
dv.setUint16(4, 2, true);
dv.setUint32(8, n, true);
let off = HEADER;
const u24 = (get) => { for (const s of selected) { const v = Math.max(0, Math.min(0xffffff, Math.round(get(s)))); dv.setUint16(off, v & 0xffff, true); dv.setUint8(off + 2, v >>> 16); off += 3; } };
const i16 = (get) => { for (const s of selected) { dv.setInt16(off, Math.max(-32768, Math.min(32767, Math.round(get(s)))), true); off += 2; } };
const u16 = (get) => { for (const s of selected) { dv.setUint16(off, Math.max(0, Math.min(65535, Math.round(get(s)))), true); off += 2; } };
const u8 = (get) => { for (const s of selected) { dv.setUint8(off, Math.max(0, Math.min(255, Math.round(get(s))))); off += 1; } };
const TWO24 = 16777216;
u24((s) => { const ra = ((Math.atan2(s.y, s.x) * 180) / Math.PI + 360) % 360; return ((ra / 360) * TWO24) % TWO24; });
u24((s) => { const r = Math.hypot(s.x, s.y, s.z); const dec = r > 0 ? (Math.asin(s.z / r) * 180) / Math.PI : 0; return ((dec + 90) / 180) * (TWO24 - 1); });
u16((s) => { const r = Math.hypot(s.x, s.y, s.z); if (r === 0) return 0; const t = (Math.log10(r) + 1) / 5; return 1 + t * 65534; });
const VU = 1e-7; // pc/yr per unit
i16((s) => s.vx / VU);
i16((s) => s.vy / VU);
i16((s) => s.vz / VU);
i16((s) => s.absmag * 1000);
u8((s) => (Math.max(-0.4, Math.min(2.15, s.bv)) + 0.4) / 0.01);
u8((s) => s.flags);
if (off !== bytes) throw new Error('size mismatch');
const b64 = Buffer.from(buf).toString('base64');

// Names table.
const clean = (t) => (t || '').replace(/\|/g, '/').trim();
const nameRows = [];
selected.forEach((s, i) => {
  if (s.proper || s.bayer) nameRows.push([i, clean(s.proper), clean(s.bayer), clean(s.con), clean(s.spect)].join('|'));
});
const names = nameRows.join('\n');

const out = `/* eslint-disable */
// GENERATED by src/worlds/sky/data/build/build-catalog.mjs — do not edit by hand.
// Derived from the HYG database v4.4 (astronexus, https://codeberg.org/astronexus/hyg),
// licensed CC BY-SA 4.0; this derivative is shared under the same licence (docs/CREDITS.md).
// ${n} stars: V ≤ 6.5 from Earth, every star within 25 pc, the Sun, Luhman 16, TRAPPIST-1.

/** Packed struct-of-arrays star data (see build-catalog.mjs for the layout). */
export const STAR_COUNT = ${n};
export const STAR_DATA_B64 =
  '${b64}';

/** index|proper|bayer|con|spect, one star per line. */
export const STAR_NAMES = ${JSON.stringify(names)};
`;
const dest = join(here, '..', 'stars.ts');
writeFileSync(dest, out);
console.log(`wrote ${dest}: ${n} stars, binary ${bytes} B, base64 ${b64.length} B, names ${names.length} B (${nameRows.length} rows)`);
const bright = selected.slice(0, 12).map((s) => `${s.proper || s.bayer + ' ' + s.con} ${s.mag}`);
console.log('brightest:', bright.join(', '));
