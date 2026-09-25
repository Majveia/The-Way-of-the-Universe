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
 *
 * GPU memory: a 4096 × 2048 RGBA8 texture with mipmaps is 45 MB. The one-channel maps (night lights,
 * clouds, elevation) are uploaded as R8 (11 MB each), the imagery is downscaled to `maxWidth` on
 * mid/low quality tiers (phones: 4× less), and only the two day mosaics being blended stay on the GPU.
 */
export const EARTH_MONTHS = [
  { month: 0, url: day01 },
  { month: 3, url: day04 },
  { month: 6, url: day07 },
  { month: 9, url: day10 },
] as const;

export interface ImageryOptions {
  anisotropy?: number;
  /** Widest texture uploaded (the native imagery is 4096 wide; 2048 suits phones). */
  maxWidth?: number;
}

const loader = new THREE.TextureLoader();

/** Downscale an image to `maxWidth` through a 2D canvas (browser-quality resampling); no-op otherwise. */
function fit(img: TexImageSource & { width: number; height: number }, maxWidth: number): TexImageSource {
  if (!(maxWidth > 0) || img.width <= maxWidth || typeof document === 'undefined') return img;
  const w = maxWidth;
  const h = Math.max(1, Math.round((img.height * maxWidth) / img.width));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (!g) return img;
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(img as CanvasImageSource, 0, 0, w, h);
  return c;
}

/** 'color': sRGB imagery; 'data': a single-channel map (only .r is read), uploaded as R8. */
function load(url: string, kind: 'color' | 'data', o: Required<ImageryOptions>): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    loader.load(
      url,
      (loaded) => {
        const t: THREE.Texture = loaded;
        t.image = fit(loaded.image, o.maxWidth);
        t.colorSpace = kind === 'color' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        if (kind === 'data') t.format = THREE.RedFormat;
        t.wrapS = THREE.RepeatWrapping;
        t.wrapT = THREE.ClampToEdgeWrapping;
        t.minFilter = THREE.LinearMipmapLinearFilter;
        t.magFilter = THREE.LinearFilter;
        t.anisotropy = o.anisotropy;
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
  /**
   * Declare which two months `owner` (a planet) is blending. GPU copies of months no owner uses are
   * released (the decoded image stays, so a month re-uploads if it is needed again).
   */
  useMonths(owner: object, a: number, b: number): void;
  release(owner: object): void;
}

let earth: { promise: Promise<EarthImagery>; refs: number } | null = null;

/**
 * Two bracketing months for a date: returns indices into EARTH_MONTHS and the blend weight of the
 * second (0 at the first month's mid-point, 1 at the second's). Months are mid-month anchored.
 * Writes into `out` (no allocation on the per-frame path).
 */
const ANCHORS = [0.5, 3.5, 6.5, 9.5, 12.5];
export function seasonalBlend(ms: number, out: { a: number; b: number; t: number } = { a: 0, b: 0, t: 0 }): { a: number; b: number; t: number } {
  // Fractional month since 1 January of the UTC year (years from the civil calendar, leap-aware).
  const year = utcYear(ms);
  const start = Date.UTC(year, 0, 1);
  const len = Date.UTC(year + 1, 0, 1) - start;
  const x = ((ms - start) / len) * 12;
  // Anchors at the middle of Jan, Apr, Jul, Oct: 0.5, 3.5, 6.5, 9.5 (+12 wrap).
  let xx = x < 0.5 ? x + 12 : x;
  let i = 0;
  while (i < 3 && xx >= ANCHORS[i + 1]) i++;
  if (xx >= ANCHORS[4]) xx -= 12;
  const t = (xx - ANCHORS[i]) / 3;
  out.a = i % 4;
  out.b = (i + 1) % 4;
  out.t = Math.min(1, Math.max(0, t));
  return out;
}

/** UTC calendar year of a timestamp without allocating a Date (Gregorian proleptic arithmetic). */
export function utcYear(ms: number): number {
  // Days since 1970-01-01 → civil year (H. Hinnant's days_from_civil inverse).
  const z = Math.floor(ms / 86_400_000) + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const m = mp < 10 ? mp + 3 : mp - 9;
  return yoe + era * 400 + (m <= 2 ? 1 : 0);
}

export function acquireEarthImagery(opts: ImageryOptions = {}): Promise<EarthImagery> {
  if (!earth) {
    const o: Required<ImageryOptions> = { anisotropy: opts.anisotropy ?? 8, maxWidth: opts.maxWidth ?? 4096 };
    const day: Array<Promise<THREE.Texture> | null> = [null, null, null, null];
    const loaded: Array<THREE.Texture | null> = [null, null, null, null];
    const owners = new Map<object, [number, number]>();
    const evict = () => {
      const keep = new Set<number>();
      for (const [a, b] of owners.values()) keep.add(a).add(b);
      for (let i = 0; i < 4; i++) {
        const t = loaded[i];
        if (t && !keep.has(i)) {
          t.dispose(); // frees the GPU copy; three re-uploads from the kept image if it is used again
          t.needsUpdate = true;
        }
      }
    };
    const promise = Promise.all([load(nightUrl, 'data', o), load(cloudsUrl, 'data', o), load(topoUrl, 'data', o)]).then(
      ([night, clouds, topo]) => {
        const img: EarthImagery = {
          night,
          clouds,
          topo,
          day,
          loadDay(i: number) {
            if (!day[i]) {
              day[i] = load(EARTH_MONTHS[i].url, 'color', o).then((t) => (loaded[i] = t));
            }
            return day[i]!;
          },
          useMonths(owner, a, b) {
            const cur = owners.get(owner);
            if (cur && cur[0] === a && cur[1] === b) return;
            owners.set(owner, [a, b]);
            evict();
          },
          release(owner) {
            owners.delete(owner);
            evict();
          },
        };
        return img;
      },
    );
    earth = { promise, refs: 0 };
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

export function acquireMoonImagery(opts: ImageryOptions = {}): Promise<MoonImagery> {
  if (!moon) {
    const o: Required<ImageryOptions> = { anisotropy: opts.anisotropy ?? 8, maxWidth: opts.maxWidth ?? 4096 };
    moon = {
      promise: Promise.all([load(moonUrl, 'color', o), load(moonHeightUrl, 'data', o)]).then(([color, height]) => ({ color, height })),
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
