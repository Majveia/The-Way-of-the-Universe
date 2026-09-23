import type { Palette } from '../../physics/nebulae';

/** The four classes of the spec plus pure reflection nebulae. */
export type NebulaType = 'emission' | 'planetary' | 'remnant' | 'dark' | 'reflection';

/** Concrete, procedurally generated analogues of well-known objects. */
export type NebulaVariant = 'pillars' | 'ring' | 'helix' | 'butterfly' | 'crab' | 'veil' | 'horsehead' | 'pleiades';

export type Vec3 = [number, number, number];

/** The star whose ultraviolet light sets the ionization structure (and is baked into the volume). */
export interface NebulaSource {
  /** Position in nebula-local parsecs. */
  pos: Vec3;
  /** H-ionizing photons per second (0 = no photoionization). */
  Q: number;
  /** Effective temperature (K): spectral hardness → [OIII]/He II zones, scattered-light colour. */
  teff: number;
  /** Bolometric luminosity (L☉) for dust-scattered light. */
  lum: number;
}

/** Additional illuminating stars for dust scattering (unshadowed, ≤ 8). */
export interface ScatterStar {
  pos: Vec3;
  teff: number;
  lum: number;
}

/** Line strengths relative to Hβ inside the zone where each ion dominates. */
export interface LineRatios {
  O3: number;
  N2: number;
  S2: number;
  He1: number;
  He2: number;
}

/** A star rendered as a point (embedded cluster members, central stars, pulsar…). */
export interface NebulaStar {
  /** Nebula-local position (pc). */
  pos: Vec3;
  /** Effective temperature (K). */
  teff: number;
  /** Absolute visual magnitude. */
  mv: number;
  /** Optional flag for special behaviour (e.g. the Crab pulsar's light curve). */
  kind?: 'pulsar' | 'ionizing' | 'yso';
}

export interface CameraView {
  distance: number;
  yaw: number;
  pitch: number;
  target?: Vec3;
}

/** Everything the renderer and the UI need to know about one nebula. */
export interface NebulaPreset {
  variant: NebulaVariant;
  type: NebulaType;
  /** Short chip label. */
  label: string;
  /** Info-card title and subtitle. */
  title: string;
  subtitle: string;
  /** Half-size of the simulated cube in parsecs. */
  half: number;
  /** 'photo': photoionized gas (bake ionization); 'shock': thin radiative shock sheets. */
  layout: 'photo' | 'shock';
  source: NebulaSource;
  scatter: ScatterStar[];
  lines: LineRatios;
  /** Dust-to-gas ratio relative to the Milky Way average. */
  dustToGas: number;
  /** Dust-to-gas inside ionized gas relative to neutral gas (grain destruction). */
  ionDust: number;
  /** Lognormal σ of sub-voxel turbulent density fluctuations. */
  turbulence: number;
  /** Parsecs spanned by one tile of the detail noise (large / small octave). */
  detailScale: [number, number];
  /** Amplitude of sub-voxel ionization-front perturbation (in ln C). */
  frontNoise: number;
  /** Exposure normalisation: 1 / typical emission measure (pc cm⁻⁶) of the object. */
  gain: number;
  /** Default palette. */
  palette: Palette;
  /** Camera presets; `default` is the first view. */
  views: Record<string, CameraView>;
  /** Present-day age (years) and time-lapse rate (years per second of real time). */
  ageYears: number;
  timeRate: number;
  /** Homologous expansion velocity at the outer edge (km/s), 0 for static objects. */
  expansionKmS: number;
  /** Radius (pc) at which `expansionKmS` applies (outer shell). */
  shellRadius: number;
  /** Turbulent drift speed of the detail field (km/s). */
  flowKmS: number;
  info: { rows: Array<[string, string]>; body: string };
}
