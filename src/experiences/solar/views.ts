/**
 * Curated views and dated events. Angles are computed from the live geometry so every view is
 * composed around where the bodies really are at that moment.
 */
import * as THREE from 'three';
import type { SolarSystemModel, SolarBody } from '../../worlds/solar/SolarSystemModel';
import type { SolarLayerSettings } from '../../worlds/solar/render/SolarSystemLayer';
import { calendarToJD } from '../../worlds/solar/time';

export interface ViewTarget {
  focus: string;
  distance: number;
  yaw: number;
  pitch: number;
  fov?: number;
}

export interface ViewPreset {
  id: string;
  label: string;
  /** Short caption shown as a toast. */
  caption?: string;
  settings?: Partial<SolarLayerSettings>;
  /** Jump to this UTC Julian date first (events). */
  jdUTC?: number;
  /** Warp step index to switch to (see WARP_STEPS), and whether to pause. */
  warp?: number;
  paused?: boolean;
  view(model: SolarSystemModel): ViewTarget;
}

/** Yaw (about +Y) of a direction, as used by OrbitRig: position = (cos p sin y, sin p, cos p cos y). */
export const yawOf = (v: THREE.Vector3) => Math.atan2(v.x, v.z);
export const pitchOf = (v: THREE.Vector3) => Math.asin(THREE.MathUtils.clamp(v.y / Math.max(v.length(), 1e-300), -1, 1));
const _d = new THREE.Vector3();
const get = (m: SolarSystemModel, id: string): SolarBody => m.get(id)!;
/** Direction from body to the Sun. */
const sunward = (b: SolarBody) => _d.copy(b.position).negate();

export const VIEWS: ViewPreset[] = [
  {
    id: 'inner',
    label: 'Inner planets',
    settings: { beltEccentricity: 1 },
    view: (m) => ({ focus: 'sun', distance: 3.9, yaw: yawOf(get(m, 'earth').position) + 0.42, pitch: 0.58 }),
  },
  {
    id: 'outer',
    label: 'Outer planets',
    settings: { beltEccentricity: 1 },
    view: (m) => ({ focus: 'sun', distance: 52, yaw: yawOf(get(m, 'jupiter').position) + 0.35, pitch: 0.52 }),
  },
  {
    id: 'trojans',
    label: 'Jupiter & Trojans',
    caption: 'Each asteroid drawn at its mean distance — the Kirkwood gaps are gaps in orbital period, in resonance with Jupiter',
    settings: { beltEccentricity: 0, asteroids: true },
    view: (m) => ({ focus: 'sun', distance: 13.5, yaw: yawOf(get(m, 'jupiter').position) + Math.PI, pitch: 1.5 }),
  },
  {
    id: 'saturn',
    label: 'Saturn',
    view: (m) => {
      const s = get(m, 'saturn');
      return { focus: 'saturn', distance: s.radius * 9.5, yaw: yawOf(sunward(s)) + 0.95, pitch: 0.24 };
    },
  },
  {
    id: 'jupiter',
    label: 'Jupiter’s moons',
    view: (m) => {
      const j = get(m, 'jupiter');
      return { focus: 'jupiter', distance: 0.03, yaw: yawOf(sunward(j)) + 0.6, pitch: 0.22 };
    },
  },
  {
    id: 'earth',
    label: 'Earth & Moon',
    view: (m) => {
      const e = get(m, 'earth');
      return { focus: 'earth', distance: 0.0072, yaw: yawOf(sunward(e)) + 1.1, pitch: 0.3 };
    },
  },
  {
    id: 'kuiper',
    label: 'Kuiper belt',
    settings: { kuiper: true, beltEccentricity: 1 },
    view: (m) => ({ focus: 'sun', distance: 150, yaw: yawOf(get(m, 'neptune').position) + 0.5, pitch: 0.55 }),
  },
  {
    id: 'pluto',
    label: 'Pluto & Charon',
    view: (m) => {
      const p = get(m, 'pluto');
      return { focus: 'pluto', distance: 0.00055, yaw: yawOf(sunward(p)) + 0.8, pitch: 0.35 };
    },
  },
  {
    id: 'sun',
    label: 'The Sun',
    view: () => ({ focus: 'sun', distance: 0.03, yaw: 0.4, pitch: 0.18 }),
  },
  {
    id: 'voyager',
    label: 'From Voyager 1',
    caption: 'Looking home from 170 AU: the whole planetary system within a few arc-minutes of the Sun',
    view: (m) => {
      const v = get(m, 'voyager-1');
      _d.copy(v.position);
      return { focus: 'sun', distance: v.position.length() * 0.999, yaw: yawOf(_d), pitch: pitchOf(_d), fov: 12 };
    },
  },
];

const J = (y: number, mo: number, d: number, h = 0, mi = 0) => calendarToJD(y, mo, d + (h + mi / 60) / 24);

export const EVENTS: ViewPreset[] = [
  {
    id: 'hale-bopp-1997',
    label: 'Hale–Bopp 1997',
    caption: 'The Great Comet of 1997 near perihelion: a curved white dust tail and a straight blue ion tail',
    jdUTC: J(1997, 3, 29, 12),
    warp: 3,
    view: (m) => {
      const c = get(m, 'hale-bopp');
      return { focus: 'hale-bopp', distance: 0.42, yaw: yawOf(sunward(c)) + 1.75, pitch: 0.28 };
    },
  },
  {
    id: 'halley-1986',
    label: 'Halley 1986',
    caption: '1P/Halley one week after perihelion, February 1986',
    jdUTC: J(1986, 2, 16),
    warp: 3,
    view: (m) => {
      const c = get(m, 'halley');
      return { focus: 'halley', distance: 0.3, yaw: yawOf(sunward(c)) + 1.9, pitch: 0.35 };
    },
  },
  {
    id: 'neowise-2020',
    label: 'NEOWISE 2020',
    jdUTC: J(2020, 7, 6),
    warp: 3,
    view: (m) => {
      const c = get(m, 'neowise');
      return { focus: 'neowise', distance: 0.25, yaw: yawOf(sunward(c)) + 1.6, pitch: 0.3 };
    },
  },
  {
    id: 'mcnaught-2007',
    label: 'McNaught 2007',
    jdUTC: J(2007, 1, 15),
    warp: 3,
    view: (m) => {
      const c = get(m, 'mcnaught');
      return { focus: 'mcnaught', distance: 0.35, yaw: yawOf(sunward(c)) + 1.7, pitch: 0.35 };
    },
  },
  {
    id: 'conjunction-2020',
    label: 'Great Conjunction 2020',
    caption: 'Jupiter and Saturn 0.1° apart as seen from Earth — closest since 1623',
    jdUTC: J(2020, 12, 21, 18),
    paused: true,
    view: (m) => {
      const e = get(m, 'earth');
      const j = get(m, 'jupiter');
      _d.subVectors(e.position, j.position).normalize();
      return { focus: 'earth', distance: 0.0045, yaw: yawOf(_d), pitch: pitchOf(_d), fov: 3.2 };
    },
  },
  {
    id: 'eclipse-2027',
    label: 'Eclipse 2027 Aug 2',
    caption: 'Total solar eclipse: the Moon’s shadow crosses Spain, North Africa and Luxor (6 min 23 s of totality)',
    jdUTC: J(2027, 8, 2, 10, 7),
    warp: 1,
    view: (m) => {
      const e = get(m, 'earth');
      _d.copy(e.position).negate().normalize();
      return { focus: 'earth', distance: e.radius * 5.2, yaw: yawOf(_d) + 0.12, pitch: pitchOf(_d) + 0.1 };
    },
  },
  {
    id: 'pale-blue-dot',
    label: 'Family Portrait 1990',
    caption: '14 February 1990: Voyager 1 turns its camera home from 40 AU',
    jdUTC: J(1990, 2, 14, 4, 48),
    paused: true,
    view: (m) => {
      const v = get(m, 'voyager-1');
      _d.copy(v.position);
      return { focus: 'sun', distance: v.position.length() * 0.999, yaw: yawOf(_d), pitch: pitchOf(_d), fov: 40 };
    },
  },
  {
    id: 'interstellar-2025',
    label: '3I/ATLAS 2025',
    caption: 'An interstellar comet at perihelion, 29 October 2025, on a hyperbolic path (e = 6.1)',
    jdUTC: J(2025, 10, 29),
    warp: 5,
    view: () => ({ focus: 'sun', distance: 4.5, yaw: 1.2, pitch: 0.75 }),
  },
];
