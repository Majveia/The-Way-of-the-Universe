import * as THREE from 'three';
import day01 from './textures/earth/day-01.webp';
import day04 from './textures/earth/day-04.webp';
import day07 from './textures/earth/day-07.webp';
import day10 from './textures/earth/day-10.webp';
import nightUrl from './textures/earth/night.webp';
import cloudsUrl from './textures/earth/clouds.webp';
import topoUrl from './textures/earth/topo.webp';
import moonUrl from './textures/moon/moon.webp';
import moonHeightUrl from './textures/moon/moon-height.webp';

/**
 * Real imagery (NASA, public domain — see docs/CREDITS.md):
 *  - Blue Marble Next Generation (MODIS, 2004) monthly mosaics for January, April, July, October;
 *    the renderer blends the two months bracketing the current date, so snow cover and vegetation
 *    follow the seasons.
 *  - Black Marble 2016 (VIIRS Day/Night Band) city lights, isolated from the moonlit ground.
 *  - Blue Marble cloud composite.
 *  - GEBCO 2008 elevation + bathymetry, packed with a MODIS-derived water mask into one channel:
 *    water depth d → 118·(1 − √(d/8000 m)), land elevation e → 138 + 117·√(e/6400 m).
 *  - Moon: LRO WAC colour mosaic + LOLA elevation (NASA SVS CGI Moon Kit).
 */
export const EARTH_MONTHS = [
  { month: 0, url: day01 },
  { month: 3, url: day04 },
  { month: 6, url: day07 },
  { month: 9, url: day10 },
] as const;

const loader = new THREE.TextureLoader();

function load(url: string, srgb: boolean, anisotropy: number): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    loader.load(
      url,
      (t) => {
        t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        t.wrapS = THREE.RepeatWrapping;
        t.wrapT = THREE.ClampToEdgeWrapping;
        t.minFilter = THREE.LinearMipmapLinearFilter;
        t.magFilter = THREE.LinearFilter;
        t.anisotropy = anisotropy;
        t.generateMipmaps = true;
        t.needsUpdate = true;
        resolve(t);
      },
      undefined,
      () => reject(new Error(`Could not load texture ${url}`)),
    );
  });
}

export interface EarthImagery {
  night: THREE.Texture;
  clouds: THREE.Texture;
  topo: THREE.Texture;
  /** Day textures by index into EARTH_MONTHS (loaded on demand). */
  day: Array<Promise<THREE.Texture> | null>;
  loadDay(i: number): Promise<THREE.Texture>;
}

let earth: { promise: Promise<EarthImagery>; refs: number; value: EarthImagery | null } | null = null;

/**
 * Two bracketing months for a date: returns indices into EARTH_MONTHS and the blend weight of the
 * second (0 at the first month's mid-point, 1 at the second's). Months are mid-month anchored.
 */
export function seasonalBlend(ms: number): { a: number; b: number; t: number } {
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  const len = Date.UTC(year + 1, 0, 1) - start;
  const x = ((ms - start) / len) * 12; // months since Jan 1 (0..12)
  // Anchors at the middle of Jan, Apr, Jul, Oct: 0.5, 3.5, 6.5, 9.5 (+12 wrap).
  const anchors = [0.5, 3.5, 6.5, 9.5, 12.5];
  let xx = x < 0.5 ? x + 12 : x;
  let i = 0;
  while (i < 3 && xx >= anchors[i + 1]) i++;
  if (xx >= anchors[4]) xx -= 12;
  const t = (xx - anchors[i]) / 3;
  return { a: i % 4, b: (i + 1) % 4, t: Math.min(1, Math.max(0, t)) };
}

export function acquireEarthImagery(anisotropy = 8): Promise<EarthImagery> {
  if (!earth) {
    const day: Array<Promise<THREE.Texture> | null> = [null, null, null, null];
    const promise = Promise.all([load(nightUrl, false, anisotropy), load(cloudsUrl, false, anisotropy), load(topoUrl, false, anisotropy)]).then(
      ([night, clouds, topo]) => {
        const img: EarthImagery = {
          night,
          clouds,
          topo,
          day,
          loadDay(i: number) {
            if (!day[i]) day[i] = load(EARTH_MONTHS[i].url, true, anisotropy);
            return day[i]!;
          },
        };
        return img;
      },
    );
    earth = { promise, refs: 0, value: null };
    promise.then((v) => {
      if (earth) earth.value = v;
    }).catch(() => undefined);
  }
  earth.refs++;
  return earth.promise;
}

export function releaseEarthImagery(): void {
  if (!earth) return;
  earth.refs--;
  if (earth.refs > 0) return;
  const e = earth;
  earth = null;
  e.promise
    .then((v) => {
      v.night.dispose();
      v.clouds.dispose();
      v.topo.dispose();
      for (const d of v.day) d?.then((t) => t.dispose()).catch(() => undefined);
    })
    .catch(() => undefined);
}

export interface MoonImagery {
  color: THREE.Texture;
  height: THREE.Texture;
}
let moon: { promise: Promise<MoonImagery>; refs: number } | null = null;

export function acquireMoonImagery(anisotropy = 8): Promise<MoonImagery> {
  if (!moon) {
    moon = {
      promise: Promise.all([load(moonUrl, true, anisotropy), load(moonHeightUrl, false, anisotropy)]).then(([color, height]) => ({ color, height })),
      refs: 0,
    };
  }
  moon.refs++;
  return moon.promise;
}

export function releaseMoonImagery(): void {
  if (!moon) return;
  moon.refs--;
  if (moon.refs > 0) return;
  const m = moon;
  moon = null;
  m.promise
    .then((v) => {
      v.color.dispose();
      v.height.dispose();
    })
    .catch(() => undefined);
}
