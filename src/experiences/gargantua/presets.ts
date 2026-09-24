import type { BlackHoleParams, ObserverKind } from '../../worlds/blackhole/BlackHoleRenderer';

/** Camera views. Distances in r_g, angles in degrees (pitch = elevation above the disk plane). */
export interface ViewDef {
  label: string;
  distance: number;
  pitch: number;
  yaw: number;
  /** Turn the camera away from the hole by this much (degrees) — for close-up views. */
  lookYaw?: number;
  observer?: ObserverKind;
}

export type ViewId = 'gargantua' | 'edge-on' | 'face-on' | 'photon-sphere' | 'far';
export const VIEWS: Record<ViewId, ViewDef> = {
  gargantua: { label: 'Gargantua', distance: 40, pitch: 3.6, yaw: 25 },
  'edge-on': { label: 'Edge-on', distance: 44, pitch: 0.4, yaw: 25 },
  'face-on': { label: 'Face-on', distance: 80, pitch: 84, yaw: 25 },
  'photon-sphere': { label: 'Photon sphere', distance: 4.6, pitch: 8, yaw: 70, lookYaw: 30 },
  far: { label: 'From afar', distance: 160, pitch: 12, yaw: 25 },
};

/**
 * Field of view that narrows with distance, like a cinematographer swapping to a longer lens:
 * a telephoto from afar (the disk a thin line across the shadow), a wide lens up close.
 */
export function fovForDistance(d: number): number {
  const t = Math.min(1, Math.max(0, Math.log(d / 5) / Math.log(60 / 5)));
  return 64 + (26 - 64) * t;
}

/** Fallback exposure multiplier (before the first metering) at distance d (r_g) and elevation `pitch` (radians). */
export function exposureFactor(d: number, pitch: number): number {
  const near = Math.min(1, Math.max(0.3, Math.pow(d / 40, 0.45)));
  const s = Math.sin(pitch);
  return near * (1 - 0.35 * s * s);
}

export interface MassPreset {
  label: string;
  subtitle: string;
  /** Solar masses. */
  mass: number;
  /** Distance from Earth (pc), for the apparent shadow size. */
  distancePc?: number;
  body: string;
}

export type MassPresetId = 'sgra' | 'm87' | 'gargantua' | 'cygx1';
export const MASS_PRESETS: Record<MassPresetId, MassPreset> = {
  sgra: {
    label: 'Sagittarius A*',
    subtitle: 'The black hole at the centre of the Milky Way',
    mass: 4.3e6,
    distancePc: 8178,
    body:
      'Imaged by the Event Horizon Telescope in 2022. Its real disk is thick, faint and hot — here it is given a luminous thin disk to show how spacetime shapes light.',
  },
  m87: {
    label: 'M87*',
    subtitle: 'Giant elliptical galaxy Messier 87, 16.8 Mpc away',
    mass: 6.5e9,
    distancePc: 16.8e6,
    body: 'The first black hole ever imaged (EHT, 2019): a ring of light 42 μas across around a shadow larger than our Solar System.',
  },
  gargantua: {
    label: 'Gargantua',
    subtitle: 'The film’s black hole — 100 million Suns, spinning near the limit',
    mass: 1e8,
    body:
      'Kip Thorne’s design for Interstellar (2014). Tides at its horizon are gentle enough to fly through; near it, an hour can be worth years far away.',
  },
  cygx1: {
    label: 'Cygnus X-1',
    subtitle: 'A stellar-mass black hole feeding on a blue supergiant, 2.2 kpc away',
    mass: 21,
    distancePc: 2220,
    body:
      'The first object widely accepted as a black hole (1971–72). Its disk shines in X-rays at ~10⁷ K; tides near its horizon would tear a person apart long before reaching it.',
  },
};

export interface LookDef {
  label: string;
  note: string;
  params: Partial<BlackHoleParams>;
  spin?: number;
  saturation: number;
  exposure: number;
}

export type LookId = 'physical' | 'interstellar' | 'hot';
export const LOOKS: Record<LookId, LookDef> = {
  physical: {
    label: 'Physical',
    note: 'Physical: Doppler beaming and gravitational redshift on.',
    params: { doppler: true, gravitationalRedshift: true, peakTemperature: 8000, thickness: 0.014, turbulence: 0.85, diskOuter: 16, diskBrightness: 4 },
    saturation: 1.1,
    exposure: 2.4,
  },
  interstellar: {
    label: 'Interstellar',
    note: 'Interstellar: like the film, Doppler shifts are switched off — the disk is symmetric and golden.',
    params: { doppler: false, gravitationalRedshift: false, peakTemperature: 4800, thickness: 0.01, turbulence: 0.9, diskOuter: 18, diskBrightness: 4 },
    spin: 0.6,
    saturation: 1.12,
    exposure: 1.5,
  },
  hot: {
    label: 'Hot quasar disk',
    note: 'A disk near the Eddington limit, peaking in the ultraviolet: white-blue, beamed hard.',
    params: { doppler: true, gravitationalRedshift: true, peakTemperature: 30000, thickness: 0.02, turbulence: 0.7, diskOuter: 20, diskBrightness: 4 },
    saturation: 1.1,
    exposure: 1.6,
  },
};
