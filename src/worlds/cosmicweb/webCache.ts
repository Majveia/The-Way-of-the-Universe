/**
 * A cached z = 0 cosmic web for other experiences (Voyage): runs the same simulation as the
 * Cosmic Web experience once per (seed, box, resolution) and keeps the final keyframe in memory,
 * so re-entering the cosmic scale costs nothing. Pure logic (plus the SimClient worker handle).
 */
import * as THREE from 'three';
import { hash01 } from '../../physics/random';
import { SimClient } from './SimClient';
import { PLANCK_COSMO, type CosmoParams, type Keyframe, type SimConfig, type SimInfo } from './types';

export interface CosmicHalo {
  /** Position in Mpc (not h⁻¹), relative to the box centre, in the renderer's world axes. */
  position: THREE.Vector3;
  /** Friends-of-friends mass, M☉. */
  mass: number;
  /** Stable per-halo seed for procedural galaxies. */
  seed: number;
}

/**
 * Halo catalogue (box-fraction centres) → world positions in Mpc about the box centre.
 * The box axes map straight onto world axes, exactly as WebRenderer's placeWorld() does.
 */
export function projectHalos(
  h: { count: number; center: Float32Array; mass: Float32Array },
  boxMpc: number,
  seed: number,
): CosmicHalo[] {
  const out: CosmicHalo[] = [];
  for (let i = 0; i < h.count; i++) {
    out.push({
      position: new THREE.Vector3((h.center[3 * i] - 0.5) * boxMpc, (h.center[3 * i + 1] - 0.5) * boxMpc, (h.center[3 * i + 2] - 0.5) * boxMpc),
      mass: h.mass[i],
      seed: Math.floor(hash01(seed, i, 0x5eed) * 0x7fffffff),
    });
  }
  return out;
}

export interface CachedWeb {
  config: SimConfig;
  info: SimInfo;
  today: Keyframe;
  /** Box side in Mpc. */
  boxMpc: number;
  halos: CosmicHalo[];
}

export interface WebRequest {
  seed?: number;
  /** Box side in h⁻¹ Mpc (default 200). */
  box?: number;
  /** Particles per side (default 64; 96/128 for high tiers). */
  np?: number;
  cosmo?: CosmoParams;
}

const cache = new Map<string, Promise<CachedWeb>>();

/** A simulation configuration that stops at today (no future or collapse steps). */
export function todayConfig(r: WebRequest = {}): SimConfig {
  const np = r.np ?? 64;
  const nm = np <= 64 ? 64 : 128;
  return {
    cosmo: r.cosmo ?? { ...PLANCK_COSMO },
    box: r.box ?? 200,
    np,
    nm,
    seed: r.seed ?? 42,
    aInit: 0.02,
    aFuture: 1,
    stepsEarly: 6,
    stepsMain: np <= 64 ? 24 : 30,
    stepsFuture: 0,
    stepsCollapse: 0,
    keyEvery: 1000,
    zHalos: 0.01,
    fofMin: 20,
    fofB: 0.2,
    deconvolve: 2,
  };
}

/** Run (or reuse) the z = 0 web for this request. Resolves when today's keyframe is in. */
export function loadWebToday(r: WebRequest = {}): Promise<CachedWeb> {
  const cfg = todayConfig(r);
  const key = JSON.stringify(cfg);
  const hit = cache.get(key);
  if (hit) return hit;
  const p = new Promise<CachedWeb>((resolve, reject) => {
    const client = new SimClient();
    let info: SimInfo | null = null;
    let last: Keyframe | null = null;
    client.start(cfg, {
      info: (i) => (info = i),
      keyframe: (k) => {
        // Keep a private copy of the final positions: the store owns (and may delta-encode) the rest.
        last = { ...k, positions: client.store!.positions(client.store!.length - 1).slice() };
      },
      done: () => {
        client.stop();
        if (!info || !last) {
          reject(new Error('Cosmic web simulation produced no keyframes'));
          return;
        }
        const boxMpc = client.config!.box / client.config!.cosmo.h;
        resolve({ config: client.config!, info, today: last, boxMpc, halos: projectHalos(last.halos, boxMpc, cfg.seed) });
        client.dispose();
      },
      error: (m) => {
        client.dispose();
        cache.delete(key);
        reject(new Error(m));
      },
    });
  });
  cache.set(key, p);
  return p;
}
