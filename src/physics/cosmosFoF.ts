/**
 * Friends-of-friends group finder (Davis, Efstathiou, Frenk & White 1985) — module: cosmos.
 *
 * Particles closer than the linking length ℓ = b · (mean interparticle separation), b = 0.2,
 * are "friends"; groups are the connected components. Such groups enclose an overdensity of
 * roughly 100–200 × the mean, close to the virial overdensity of dark-matter halos.
 *
 * Implementation: candidates are binned in a periodic cell grid of side ≥ ℓ, cells are found
 * through an open-addressing hash table, each occupied cell is compared with itself and its 13
 * "forward" neighbours, and connectivity is tracked with union–find (path halving).
 * The caller may pre-select candidates (e.g. particles in overdense regions): a particle in a
 * b = 0.2 group sits at δ ≳ 60, so a generous density cut loses nothing but saves time.
 */

export interface FoFResult {
  /** Number of groups with at least `minMembers` members. */
  groups: number;
  /** groupStart[g] … groupStart[g+1] index into `members` (length groups + 1). */
  groupStart: Int32Array;
  /** Particle indices, grouped, largest group first. */
  members: Uint32Array;
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
  const nc = Math.max(3, Math.floor(box / link));
  const cs = box / nc;
  const inv = 1 / cs;
  // Cell key per candidate; sort candidates by key (packed into one exact float64).
  const idxBits = Math.ceil(Math.log2(M + 1));
  const mul = 2 ** idxBits;
  if (nc * nc * nc * mul > 2 ** 53) throw new Error('FoF: grid too fine for packed sort');
  const packed = new Float64Array(M);
  for (let j = 0; j < M; j++) {
    const p = candidates[j];
    let cx = Math.floor(pos[3 * p] * inv), cy = Math.floor(pos[3 * p + 1] * inv), cz = Math.floor(pos[3 * p + 2] * inv);
    if (cx >= nc) cx = nc - 1;
    if (cy >= nc) cy = nc - 1;
    if (cz >= nc) cz = nc - 1;
    packed[j] = ((cx * nc + cy) * nc + cz) * mul + j;
  }
  packed.sort();
  const sortedP = new Uint32Array(M); // sorted particle index
  const keys = new Float64Array(M);
  for (let s = 0; s < M; s++) {
    const v = packed[s];
    const key = Math.floor(v / mul);
    const j = v - key * mul;
    keys[s] = key;
    sortedP[s] = candidates[j];
  }
  // Cell table: unique keys → [start, end).
  let cells = 0;
  const cellStart: number[] = [];
  for (let s = 0; s < M; s++) if (s === 0 || keys[s] !== keys[s - 1]) (cellStart.push(s), cells++);
  cellStart.push(M);
  let cap = 1;
  while (cap < cells * 2) cap <<= 1;
  const hk = new Float64Array(cap).fill(-1);
  const hv = new Int32Array(cap);
  const hmask = cap - 1;
  const hash = (k: number) => (Math.imul((k % 4294967296) | 0, 0x9e3779b1) ^ Math.imul(Math.floor(k / 4294967296), 0x85ebca6b)) >>> 0;
  for (let c = 0; c < cells; c++) {
    const k = keys[cellStart[c]];
    let h = hash(k) & hmask;
    while (hk[h] !== -1) h = (h + 1) & hmask;
    hk[h] = k;
    hv[h] = c;
  }
  const lookup = (k: number): number => {
    let h = hash(k) & hmask;
    while (true) {
      const v = hk[h];
      if (v === -1) return -1;
      if (v === k) return hv[h];
      h = (h + 1) & hmask;
    }
  };
  // Union–find over sorted slots.
  const parent = new Int32Array(M);
  for (let i = 0; i < M; i++) parent[i] = i;
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number) => {
    let ra = find(a), rb = find(b);
    if (ra === rb) return;
    if (ra < rb) {
      const t = ra;
      ra = rb;
      rb = t;
    }
    parent[ra] = rb;
  };
  const l2 = link * link;
  const half = box / 2;
  const linkPair = (sa: number, sb: number) => {
    const pa = sortedP[sa], pb = sortedP[sb];
    let dx = pos[3 * pa] - pos[3 * pb];
    if (dx > half) dx -= box;
    else if (dx < -half) dx += box;
    if (dx * dx > l2) return;
    let dy = pos[3 * pa + 1] - pos[3 * pb + 1];
    if (dy > half) dy -= box;
    else if (dy < -half) dy += box;
    const d2 = dx * dx + dy * dy;
    if (d2 > l2) return;
    let dz = pos[3 * pa + 2] - pos[3 * pb + 2];
    if (dz > half) dz -= box;
    else if (dz < -half) dz += box;
    if (d2 + dz * dz <= l2) union(sa, sb);
  };
  // 13 forward neighbour offsets.
  const offs: Array<[number, number, number]> = [];
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dz = -1; dz <= 1; dz++) {
        if (dx > 0 || (dx === 0 && dy > 0) || (dx === 0 && dy === 0 && dz > 0)) offs.push([dx, dy, dz]);
      }
  for (let c = 0; c < cells; c++) {
    const s0 = cellStart[c], s1 = cellStart[c + 1];
    const key = keys[s0];
    const cz = key % nc, cy = Math.floor(key / nc) % nc, cx = Math.floor(key / (nc * nc));
    for (let a = s0; a < s1; a++) for (let b = a + 1; b < s1; b++) linkPair(a, b);
    for (const [ox, oy, oz] of offs) {
      const nx = (cx + ox + nc) % nc, ny = (cy + oy + nc) % nc, nz = (cz + oz + nc) % nc;
      const nb = lookup((nx * nc + ny) * nc + nz);
      if (nb < 0) continue;
      const t0 = cellStart[nb], t1 = cellStart[nb + 1];
      for (let a = s0; a < s1; a++) for (let b = t0; b < t1; b++) linkPair(a, b);
    }
  }
  // Collect groups.
  const size = new Int32Array(M);
  for (let s = 0; s < M; s++) size[find(s)]++;
  const roots: number[] = [];
  for (let s = 0; s < M; s++) if (parent[s] === s && size[s] >= minMembers) roots.push(s);
  roots.sort((a, b) => size[b] - size[a]);
  const gid = new Int32Array(M).fill(-1);
  const groupStart = new Int32Array(roots.length + 1);
  let total = 0;
  roots.forEach((r, g) => {
    gid[r] = g;
    groupStart[g] = total;
    total += size[r];
  });
  groupStart[roots.length] = total;
  const fill = groupStart.slice(0, roots.length);
  const members = new Uint32Array(total);
  for (let s = 0; s < M; s++) {
    const g = gid[find(s)];
    if (g >= 0) members[fill[g]++] = sortedP[s];
  }
  return { groups: roots.length, groupStart, members };
}
