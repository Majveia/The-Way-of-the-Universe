import * as THREE from 'three';
import { bvToTemperature } from '../../physics/blackbody';
import { CONSTELLATIONS, bayerDesignation, parseBayerQuery } from './constellationNames';

/**
 * The real sky: ~11 600 stars from the HYG database v4.4 (CC BY-SA 4.0) — every star to V = 6.5 plus
 * every star within 25 pc — decoded from the packed binary in ./data/stars.ts (layout documented in
 * ./data/build/build-catalog.mjs).
 *
 * Frames. Positions are heliocentric, in parsecs, in the GALACTIC frame expressed in three.js axes:
 * +x → Galactic centre (l = 0, b = 0), +y → north galactic pole, +z = −(l = 90°). This is the frame
 * the `Sky` class uses internally before its own frame rotation (skyFrameMatrix).
 */
export interface StarInfo {
  index: number;
  /** IAU proper name (or the catalogue name used as one, e.g. "Wolf 359"); '' if none. */
  proper: string;
  /** HYG Bayer code, e.g. "Alp", "Kap-1". */
  bayer: string;
  /** Constellation abbreviation, e.g. "Ori". */
  con: string;
  spect: string;
  /** Best display name: proper name, else Bayer designation, else "HR/HYG #index". */
  name: string;
  /** Bayer designation with Greek letter and genitive ("α Orionis"), '' if none. */
  designation: string;
}

export interface StarCatalog {
  readonly count: number;
  /** Heliocentric position, pc, galactic three.js frame (float64 for CPU precision). */
  readonly position: Float64Array;
  /** Space velocity, pc/yr, same frame. */
  readonly velocity: Float32Array;
  /** Absolute visual magnitude M_V. */
  readonly absMag: Float32Array;
  /** Apparent V from the Sun (−26.74 for the Sun itself). */
  readonly mag: Float32Array;
  readonly bv: Float32Array;
  /** Effective temperature (K) from B−V (Ballesteros 2012); curated overrides applied by callers. */
  readonly temperature: Float32Array;
  /** Distance from the Sun, pc. */
  readonly distance: Float32Array;
  /** Equatorial J2000 RA/Dec, radians. */
  readonly ra: Float32Array;
  readonly dec: Float32Array;
  /** 1 distance estimated · 2 B−V estimated · 4 variable · 8 multiple-system member. */
  readonly flags: Uint8Array;
  info(index: number): StarInfo;
  /** Index of a star by proper name ("Sirius"), Bayer designation ("α Cen", "alpha Centauri", "Alp1 Cen"), or −1. */
  find(query: string): number;
  /** Indices of all stars with a proper name. */
  readonly namedIndices: readonly number[];
}

/** Equatorial J2000 (astro axes) → galactic (astro axes): the Hipparcos A_G′ matrix (ESA 1997, eq. 1.5.11). */
export const EQ_TO_GAL = [
  -0.0548755604, -0.8734370902, -0.4838350155,
  0.4941094279, -0.44482963, 0.7469822445,
  -0.867666149, -0.1980763734, 0.4559837762,
] as const;

/** Equatorial J2000 unit vector/position (astro axes) → galactic three.js axes. */
export function equatorialToGalacticThree(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
  const M = EQ_TO_GAL;
  const gx = M[0] * x + M[1] * y + M[2] * z;
  const gy = M[3] * x + M[4] * y + M[5] * z;
  const gz = M[6] * x + M[7] * y + M[8] * z;
  return out.set(gx, gz, -gy);
}

/** RA/Dec (radians) → unit vector in the galactic three.js frame. */
export function raDecToGalacticThree(ra: number, dec: number, out = new THREE.Vector3()): THREE.Vector3 {
  const c = Math.cos(dec);
  return equatorialToGalacticThree(c * Math.cos(ra), c * Math.sin(ra), Math.sin(dec), out);
}

/** Galactic (l, b) radians → unit vector in the galactic three.js frame. */
export function galacticLBToThree(l: number, b: number, out = new THREE.Vector3()): THREE.Vector3 {
  const cb = Math.cos(b);
  return out.set(cb * Math.cos(l), Math.sin(b), -cb * Math.sin(l));
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Decode the packed catalogue (pure; used by tests and by loadStarCatalog). */
export function decodeStarCatalog(b64: string, namesTable: string): StarCatalog {
  const bytes = b64ToBytes(b64);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'TWUS') throw new Error('star catalogue: bad magic');
  const version = dv.getUint16(4, true);
  if (version !== 2) throw new Error(`star catalogue: unsupported version ${version}`);
  const n = dv.getUint32(8, true);
  let off = 16;
  const ra = new Float32Array(n), dec = new Float32Array(n), distance = new Float32Array(n);
  const TWO24 = 16777216;
  for (let i = 0; i < n; i++, off += 3) ra[i] = ((dv.getUint16(off, true) + dv.getUint8(off + 2) * 65536) / TWO24) * Math.PI * 2;
  for (let i = 0; i < n; i++, off += 3) dec[i] = ((dv.getUint16(off, true) + dv.getUint8(off + 2) * 65536) / (TWO24 - 1)) * Math.PI - Math.PI / 2;
  for (let i = 0; i < n; i++, off += 2) {
    const u = dv.getUint16(off, true);
    distance[i] = u === 0 ? 0 : Math.pow(10, ((u - 1) / 65534) * 5 - 1);
  }
  const vel = new Float32Array(n * 3);
  const vEq = new Float32Array(n * 3);
  for (let k = 0; k < 3; k++) for (let i = 0; i < n; i++, off += 2) vEq[i * 3 + k] = dv.getInt16(off, true) * 1e-7;
  const absMag = new Float32Array(n);
  for (let i = 0; i < n; i++, off += 2) absMag[i] = dv.getInt16(off, true) / 1000;
  const bv = new Float32Array(n);
  for (let i = 0; i < n; i++, off += 1) bv[i] = -0.4 + 0.01 * dv.getUint8(off);
  const flags = new Uint8Array(n);
  for (let i = 0; i < n; i++, off += 1) flags[i] = dv.getUint8(off);

  const position = new Float64Array(n * 3);
  const mag = new Float32Array(n);
  const temperature = new Float32Array(n);
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const d = distance[i];
    const c = Math.cos(dec[i]);
    equatorialToGalacticThree(d * c * Math.cos(ra[i]), d * c * Math.sin(ra[i]), d * Math.sin(dec[i]), v);
    position[i * 3] = v.x;
    position[i * 3 + 1] = v.y;
    position[i * 3 + 2] = v.z;
    equatorialToGalacticThree(vEq[i * 3], vEq[i * 3 + 1], vEq[i * 3 + 2], v);
    vel[i * 3] = v.x;
    vel[i * 3 + 1] = v.y;
    vel[i * 3 + 2] = v.z;
    mag[i] = d > 0 ? absMag[i] + 5 * Math.log10(d / 10) : -26.74;
    temperature[i] = bvToTemperature(bv[i]);
  }

  // Names.
  const infos = new Map<number, { proper: string; bayer: string; con: string; spect: string }>();
  const byName = new Map<string, number>();
  const byBayer = new Map<string, number>();
  const namedIndices: number[] = [];
  for (const line of namesTable.split('\n')) {
    if (!line) continue;
    const [si, proper, bayer, con, spect] = line.split('|');
    const i = Number(si);
    infos.set(i, { proper, bayer, con, spect });
    if (proper) {
      namedIndices.push(i);
      const k = proper.toLowerCase();
      if (!byName.has(k)) byName.set(k, i);
    }
    if (bayer && con) {
      const k = `${bayer}|${con}`;
      if (!byBayer.has(k)) byBayer.set(k, i);
      // "Alp-1|Cen" is also reachable as "Alp|Cen" if no plain entry exists.
      const base = bayer.split('-')[0];
      const kb = `${base}|${con}`;
      if (!byBayer.has(kb)) byBayer.set(kb, i);
    }
  }

  const info = (index: number): StarInfo => {
    const r = infos.get(index);
    const designation = r?.bayer ? bayerDesignation(r.bayer, r.con) : '';
    const name = r?.proper || designation || `HYG star ${index}`;
    return { index, proper: r?.proper ?? '', bayer: r?.bayer ?? '', con: r?.con ?? '', spect: r?.spect ?? '', name, designation };
  };
  const find = (query: string): number => {
    const q = query.trim().toLowerCase();
    const hit = byName.get(q);
    if (hit !== undefined) return hit;
    const b = parseBayerQuery(query);
    if (b) {
      const k = byBayer.get(`${b.bayer}|${b.con}`);
      if (k !== undefined) return k;
    }
    return -1;
  };

  return {
    count: n,
    position,
    velocity: vel,
    absMag,
    mag,
    bv,
    temperature,
    distance,
    ra,
    dec,
    flags,
    info,
    find,
    namedIndices,
  };
}

let pending: Promise<StarCatalog> | null = null;
let loaded: StarCatalog | null = null;

/** Lazily load (and cache) the catalogue. The data module (~310 kB) is split into its own chunk. */
export function loadStarCatalog(): Promise<StarCatalog> {
  if (loaded) return Promise.resolve(loaded);
  if (!pending) {
    pending = import('./data/stars').then((m) => {
      loaded = decodeStarCatalog(m.STAR_DATA_B64, m.STAR_NAMES);
      return loaded;
    });
  }
  return pending;
}

/** The catalogue if it has already been loaded, else null. */
export function starCatalogIfLoaded(): StarCatalog | null {
  return loaded;
}

export { CONSTELLATIONS };
