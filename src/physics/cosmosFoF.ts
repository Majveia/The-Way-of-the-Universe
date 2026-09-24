/**
 * Friends-of-friends group finder (Davis, Efstathiou, Frenk & White 1985) — module: cosmos.
 *
 * Particles closer than the linking length ℓ = b · (mean interparticle separation), b = 0.2,
 * are "friends"; groups are the connected components. Such groups enclose an overdensity of
 * roughly 100–200 × the mean, close to the virial overdensity of dark-matter halos.
 *
 * Implementation: candidates are binned in a periodic grid of cells of side ≥ ℓ and sorted by
 * cell (LSD radix sort on the 32-bit cell key); cells are found through an open-addressing hash
 * table; each occupied cell is compared with itself and its 13 "forward" neighbours; connectivity
 * is tracked with union–find (path halving). The caller may pre-select candidates (e.g. particles
 * in overdense regions) — a particle in a b = 0.2 group sits at δ ≳ 60.
 */

export interface FoFResult {
  /** Number of groups with at least `minMembers` members. */
  groups: number;
  /** groupStart[g] … groupStart[g+1] index into `members` (length groups + 1). */
  groupStart: Int32Array;
  /** Particle indices, grouped, largest group first. */
  members: Uint32Array;
}

function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Sort `idx` by `key` (both length M, keys < 2^32) with a stable 4-pass LSD radix sort. */
function radixSort(key: Uint32Array, idx: Uint32Array, M: number): void {
  let kA: Uint32Array = key, iA: Uint32Array = idx;
  let kB: Uint32Array = new Uint32Array(M), iB: Uint32Array = new Uint32Array(M);
  const count = new Uint32Array(256);
  for (let shift = 0; shift < 32; shift += 8) {
    count.fill(0);
    for (let i = 0; i < M; i++) count[(kA[i] >>> shift) & 255]++;
    let sum = 0;
    for (let b = 0; b < 256; b++) {
      const c = count[b];
      count[b] = sum;
      sum += c;
    }
    for (let i = 0; i < M; i++) {
      const b = (kA[i] >>> shift) & 255;
      const d = count[b]++;
      kB[d] = kA[i];
      iB[d] = iA[i];
    }
    const tk = kA; kA = kB; kB = tk;
    const ti = iA; iA = iB; iB = ti;
  }
  // After 4 passes the sorted data is back in the original arrays.
}

export function friendsOfFriends(
  pos: Float32Array,
  candidates: Uint32Array,
  candidateCount: number,
  box: number,
  link: number,
  minMembers: number,
): FoFResult {
  const M = candidateCount;
  if (M === 0) return { groups: 0, groupStart: new Int32Array(1), members: new Uint32Array(0) };
  const nc = Math.max(3, Math.min(1290, Math.floor(box / link)));
  const inv = nc / box;
  const key = new Uint32Array(M);
  const sp = new Uint32Array(M); // sorted particle indices
  for (let j = 0; j < M; j++) {
    const p = candidates[j];
    let cx = Math.floor(pos[3 * p] * inv), cy = Math.floor(pos[3 * p + 1] * inv), cz = Math.floor(pos[3 * p + 2] * inv);
    if (cx >= nc) cx = nc - 1;
    if (cy >= nc) cy = nc - 1;
    if (cz >= nc) cz = nc - 1;
    key[j] = (cx * nc + cy) * nc + cz;
    sp[j] = p;
  }
  radixSort(key, sp, M);
  // Local copy of positions in sorted order (cache-friendly pair tests).
  const px = new Float32Array(M), py = new Float32Array(M), pz = new Float32Array(M);
  for (let s = 0; s < M; s++) {
    const p = sp[s];
    px[s] = pos[3 * p];
    py[s] = pos[3 * p + 1];
    pz[s] = pos[3 * p + 2];
  }
  // Unique cells.
  const cellStart = new Int32Array(M + 1);
  let cells = 0;
  for (let s = 0; s < M; s++) if (s === 0 || key[s] !== key[s - 1]) cellStart[cells++] = s;
  cellStart[cells] = M;
  let cap = 1;
  while (cap < cells * 2) cap <<= 1;
  const hmask = cap - 1;
  const hk = new Uint32Array(cap);
  const hv = new Int32Array(cap).fill(-1);
  for (let c = 0; c < cells; c++) {
    const k = key[cellStart[c]];
    let h = fmix32(k) & hmask;
    while (hv[h] !== -1) h = (h + 1) & hmask;
    hk[h] = k;
    hv[h] = c;
  }
  const parent = new Int32Array(M);
  for (let i = 0; i < M; i++) parent[i] = i;
  const l2 = link * link;
  const half = box / 2;
  const nc2 = nc * nc;
  // 13 forward neighbour offsets.
  const OX = [0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1];
  const OY = [0, 1, 1, 1, -1, -1, -1, 0, 0, 0, 1, 1, 1];
  const OZ = [1, -1, 0, 1, -1, 0, 1, -1, 0, 1, -1, 0, 1];
  for (let c = 0; c < cells; c++) {
    const s0 = cellStart[c], s1 = cellStart[c + 1];
    const k = key[s0];
    const cx = (k / nc2) | 0, cy = ((k / nc) | 0) % nc, cz = k % nc;
    for (let o = -1; o < 13; o++) {
      let t0: number, t1: number;
      if (o < 0) {
        t0 = s0;
        t1 = s1;
      } else {
        let nx = cx + OX[o], ny = cy + OY[o], nz = cz + OZ[o];
        if (nx >= nc) nx -= nc; else if (nx < 0) nx += nc;
        if (ny >= nc) ny -= nc; else if (ny < 0) ny += nc;
        if (nz >= nc) nz -= nc; else if (nz < 0) nz += nc;
        const nk = (nx * nc + ny) * nc + nz;
        let h = fmix32(nk) & hmask;
        let nb = -1;
        while (hv[h] !== -1) {
          if (hk[h] === nk) {
            nb = hv[h];
            break;
          }
          h = (h + 1) & hmask;
        }
        if (nb < 0) continue;
        t0 = cellStart[nb];
        t1 = cellStart[nb + 1];
      }
      for (let a = s0; a < s1; a++) {
        const ax = px[a], ay = py[a], az = pz[a];
        for (let b = o < 0 ? a + 1 : t0; b < t1; b++) {
          let dx = ax - px[b];
          if (dx > half) dx -= box; else if (dx < -half) dx += box;
          const dx2 = dx * dx;
          if (dx2 > l2) continue;
          let dy = ay - py[b];
          if (dy > half) dy -= box; else if (dy < -half) dy += box;
          const d2 = dx2 + dy * dy;
          if (d2 > l2) continue;
          let dz = az - pz[b];
          if (dz > half) dz -= box; else if (dz < -half) dz += box;
          if (d2 + dz * dz > l2) continue;
          // union(a, b) with path halving
          let ra = a;
          while (parent[ra] !== ra) {
            parent[ra] = parent[parent[ra]];
            ra = parent[ra];
          }
          let rb = b;
          while (parent[rb] !== rb) {
            parent[rb] = parent[parent[rb]];
            rb = parent[rb];
          }
          if (ra !== rb) {
            if (ra < rb) parent[rb] = ra;
            else parent[ra] = rb;
          }
        }
      }
    }
  }
  // Collect groups.
  const root = new Int32Array(M);
  const size = new Int32Array(M);
  for (let s = 0; s < M; s++) {
    let r = s;
    while (parent[r] !== r) r = parent[r];
    root[s] = r;
    size[r]++;
  }
  const roots: number[] = [];
  for (let s = 0; s < M; s++) if (root[s] === s && size[s] >= minMembers) roots.push(s);
  roots.sort((a, b) => size[b] - size[a] || a - b);
  const gid = new Int32Array(M).fill(-1);
  const groupStart = new Int32Array(roots.length + 1);
  let total = 0;
  for (let g = 0; g < roots.length; g++) {
    gid[roots[g]] = g;
    groupStart[g] = total;
    total += size[roots[g]];
  }
  groupStart[roots.length] = total;
  const fill = groupStart.slice(0, Math.max(1, roots.length));
  const members = new Uint32Array(total);
  for (let s = 0; s < M; s++) {
    const g = gid[root[s]];
    if (g >= 0) members[fill[g]++] = sp[s];
  }
  return { groups: roots.length, groupStart, members };
}
