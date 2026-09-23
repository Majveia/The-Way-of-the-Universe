/**
 * Integer hashing shared bit-for-bit by the CPU (here) and the GPU (HASH_GLSL), so procedural
 * content generated in shaders (young-cluster birth sites, the local star field) can be
 * reproduced exactly on the CPU for picking and `nearestStars`.
 *
 * PCG-RXS-M-XS 32-bit output permutation (O'Neill 2014; as used by Jarzynski & Olano 2020,
 * "Hash Functions for GPU Rendering", JCGT 9(3)).
 */
export function pcg(v: number): number {
  const state = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const word = Math.imul((state >>> ((state >>> 28) + 4)) ^ state, 277803737) >>> 0;
  return ((word >>> 22) ^ word) >>> 0;
}

/** Hash of two 32-bit integers (negative ints wrap like GLSL uint(int)). */
export function hash2u(a: number, b: number): number {
  return pcg((pcg(a) + (b >>> 0)) >>> 0);
}

/** Hash of three 32-bit integers. */
export function hash3u(a: number, b: number, c: number): number {
  return pcg((hash2u(a, b) + (c >>> 0)) >>> 0);
}

/** Hash of four 32-bit integers. */
export function hash4u(a: number, b: number, c: number, d: number): number {
  return pcg((hash3u(a, b, c) + (d >>> 0)) >>> 0);
}

/** uint32 → float in [0, 1) using the top 24 bits (exact in float32). */
export const u01 = (h: number) => (h >>> 8) / 16777216;

/** Next hash in a stream (for drawing several numbers from one seed). */
export const next = (h: number) => pcg((h + 0x9e3779b9) >>> 0);

export const HASH_GLSL = /* glsl */ `
#ifndef TWU_GALAXY_HASH
#define TWU_GALAXY_HASH
uint pcg(uint v) {
  uint state = v * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
uint hash2u(uint a, uint b) { return pcg(pcg(a) + b); }
uint hash3u(uint a, uint b, uint c) { return pcg(hash2u(a, b) + c); }
uint hash4u(uint a, uint b, uint c, uint d) { return pcg(hash3u(a, b, c) + d); }
float u01(uint h) { return float(h >> 8u) * (1.0 / 16777216.0); }
uint hnext(uint h) { return pcg(h + 0x9e3779b9u); }
#endif
`;
