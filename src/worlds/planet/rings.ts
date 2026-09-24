import * as THREE from 'three';
import { Rng } from '../../physics/random';
import { saturnRingTau } from '../../physics/planets-photometry';
import type { RingSpec } from './types';

/**
 * Radial ring structure as a 1D texture over [inner, outer]:
 *   r: normal optical depth τ, g: fine-dust fraction (forward scattering), b: brightness variation,
 *   a: colour variation (0 = icy/grey like the C ring, 1 = warm like the A/B rings).
 * Saturn-like rings use the measured profile (C, B, Cassini Division, A, Encke/Keeler gaps) with
 * fine ringlet structure; other rings are generated from the seed with bands and resonance gaps.
 */
export function ringProfile(spec: RingSpec, n = 2048): Float32Array {
  const out = new Float32Array(n * 4);
  const rng = new Rng((spec.seed ?? 7) * 101 + 3);
  const saturn = spec.saturn ?? (Math.abs(spec.inner - 1.24) < 0.08 && Math.abs(spec.outer - 2.27) < 0.12);
  const dust = spec.dust ?? 0.35;
  // 1D multi-octave value noise for ringlets.
  const oct: Array<{ f: number; a: number; ph: number[] }> = [];
  for (let o = 0; o < 6; o++) {
    const f = 40 * Math.pow(2.3, o);
    const ph: number[] = [];
    for (let k = 0; k < 64; k++) ph.push(rng.next());
    oct.push({ f, a: Math.pow(0.62, o), ph });
  }
  const ringlets = (x: number) => {
    let s = 0, norm = 0;
    for (const { f, a, ph } of oct) {
      const t = x * f;
      const i = Math.floor(t);
      const u = t - i;
      const v0 = ph[((i % 64) + 64) % 64], v1 = ph[(((i + 1) % 64) + 64) % 64];
      s += a * (v0 + (v1 - v0) * (u * u * (3 - 2 * u)));
      norm += a;
    }
    return s / norm; // ~[0,1]
  };
  // Generic structure: zones with log-uniform τ and a few narrow gaps.
  const zones: Array<{ x: number; tau: number; warm: number }> = [];
  if (!saturn) {
    const nz = 3 + rng.int(4);
    for (let i = 0; i < nz; i++) zones.push({ x: i === 0 ? 0 : rng.range(0.05, 0.95), tau: rng.logRange(0.04, 2.5), warm: rng.next() });
    zones.sort((a, b) => a.x - b.x);
  }
  const gaps: Array<{ x: number; w: number }> = [];
  const ng = saturn ? 0 : 1 + rng.int(4);
  for (let i = 0; i < ng; i++) gaps.push({ x: rng.range(0.1, 0.95), w: rng.range(0.002, 0.02) });
  for (let i = 0; i < n; i++) {
    const x = (i + 0.5) / n;
    const r = spec.inner + (spec.outer - spec.inner) * x;
    const rl = ringlets(x);
    let tau: number;
    let warm: number;
    if (saturn) {
      tau = saturnRingTau(r);
      tau *= 0.65 + 0.7 * rl;
      warm = r < 1.527 ? 0.2 : r < 1.95 ? 1 : r < 2.028 ? 0.35 : 0.85;
    } else {
      let z = zones[0];
      let zn = zones[0];
      for (let k = 0; k < zones.length; k++) {
        if (zones[k].x <= x) {
          z = zones[k];
          zn = zones[Math.min(k + 1, zones.length - 1)];
        }
      }
      const blend = zn === z ? 0 : Math.min(1, Math.max(0, (x - zn.x) / 0.02 + 1));
      tau = z.tau + (zn.tau - z.tau) * blend;
      warm = z.warm;
      tau *= 0.55 + 0.9 * rl;
      for (const g of gaps) tau *= 1 - 0.97 * Math.exp(-(((x - g.x) / g.w) ** 2));
      // Soft inner/outer edges.
      tau *= Math.min(1, x / 0.015) * Math.min(1, (1 - x) / 0.01);
    }
    const lowTau = Math.exp(-tau * 2);
    out[i * 4] = Math.max(0, tau);
    out[i * 4 + 1] = Math.min(1, dust * (0.35 + 0.9 * lowTau) + (x > 0.97 ? 0.3 : 0));
    out[i * 4 + 2] = 0.8 + 0.4 * ringlets(x * 1.7 + 0.3);
    out[i * 4 + 3] = warm;
  }
  return out;
}

export function ringTexture(spec: RingSpec): THREE.DataTexture {
  const n = 2048;
  const f = ringProfile(spec, n);
  const h = new Uint16Array(f.length);
  for (let i = 0; i < f.length; i++) h[i] = THREE.DataUtils.toHalfFloat(f[i]);
  const t = new THREE.DataTexture(h, n, 1, THREE.RGBAFormat, THREE.HalfFloatType);
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}
