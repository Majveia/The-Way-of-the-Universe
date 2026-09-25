import { it } from 'vitest';
import { gmst, moonState, sunState, msToJD, radecToVector } from '../src/physics/planets-ephemeris';
const DEG = Math.PI / 180;
const AUKM = 149597870.7;
function shadowPoint(ms: number) {
  const jd = msToJD(ms);
  const s = sunState(jd), m = moonState(jd);
  const S = radecToVector(s.ra, s.dec, { x: 0, y: 0, z: 0 });
  const M = radecToVector(m.ra, m.dec, { x: 0, y: 0, z: 0 });
  const Sx = S.x * s.distanceAU * AUKM, Sy = S.y * s.distanceAU * AUKM, Sz = S.z * s.distanceAU * AUKM;
  const Mx = M.x * m.distanceKm, My = M.y * m.distanceKm, Mz = M.z * m.distanceKm;
  let ux = Mx - Sx, uy = My - Sy, uz = Mz - Sz; const L = Math.hypot(ux, uy, uz); ux /= L; uy /= L; uz /= L;
  const b = Mx * ux + My * uy + Mz * uz; const c = Mx * Mx + My * My + Mz * Mz - 6371 ** 2;
  const disc = b * b - c;
  const miss = Math.sqrt(Math.max(0, c + 6371 ** 2 - b * b));
  if (disc < 0) return { hit: false, miss };
  const t = -b - Math.sqrt(disc);
  const Px = Mx + ux * t, Py = My + uy * t, Pz = Mz + uz * t;
  const lat = Math.asin(Pz / 6371) / DEG;
  let lon = (Math.atan2(Py, Px) - gmst(jd)) / DEG; lon = ((lon + 540) % 360) - 180;
  return { hit: true, lat, lon, miss, moonKm: m.distanceKm, sunAng: Math.asin(695700 / (s.distanceAU * AUKM)) / DEG };
}
it('explore eclipse', () => {
  console.log('2027-08-02 10:07:50', shadowPoint(Date.UTC(2027, 7, 2, 10, 7, 50)));
  console.log('2024-04-08 18:17:16', shadowPoint(Date.UTC(2024, 3, 8, 18, 17, 16)));
  console.log('2017-08-21 18:25:32', shadowPoint(Date.UTC(2017, 7, 21, 18, 25, 32)));
});
function occluderVisibility(p: number[], occ: number[], sunDir: number[], angSun: number) {
  // mirror of glsl.ts occluderVisibility
  const v = [occ[0] - p[0], occ[1] - p[1], occ[2] - p[2]];
  const dist = Math.hypot(v[0], v[1], v[2]);
  const along = v[0] * sunDir[0] + v[1] * sunDir[1] + v[2] * sunDir[2];
  if (along <= 0) return { vis: 1, umbra: 0 };
  const angSep = Math.acos(Math.max(-1, Math.min(1, along / dist)));
  const angOcc = Math.asin(Math.max(0, Math.min(1, occ[3] / dist)));
  const full = angOcc - angSun, edge = angOcc + angSun;
  const ss = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const cover = 1 - ss(Math.abs(full), edge, angSep);
  const maxCover = Math.min(1, (angOcc * angOcc) / (angSun * angSun));
  const umbra = full > 0 ? 1 - ss(full * 0.85, full, angSep) : 0;
  return { vis: 1 - cover * maxCover, umbra, angSep: angSep / DEG, angOcc: angOcc / DEG };
}
it('explore lunar eclipse', () => {
  for (const [label, ms] of [
    ['2025-09-07 greatest 18:11:48', Date.UTC(2025, 8, 7, 18, 11, 48)],
    ['2025-09-07 umbral first contact 16:27', Date.UTC(2025, 8, 7, 16, 27, 0)],
    ['2025-09-07 penumbral 15:28', Date.UTC(2025, 8, 7, 15, 28, 0)],
    ['2025-03-14 greatest 06:58:43', Date.UTC(2025, 2, 14, 6, 58, 43)],
  ] as Array<[string, number]>) {
    const jd = msToJD(ms);
    const s = sunState(jd), m = moonState(jd);
    const S = radecToVector(s.ra, s.dec, { x: 0, y: 0, z: 0 });
    const M = radecToVector(m.ra, m.dec, { x: 0, y: 0, z: 0 });
    const R = 6371;
    const p = [M.x * m.distanceKm / R, M.y * m.distanceKm / R, M.z * m.distanceKm / R];
    const sunAng = Math.asin(695700 / (s.distanceAU * AUKM));
    const o = occluderVisibility(p, [0, 0, 0, 1.012], [S.x, S.y, S.z], sunAng);
    const sep = Math.acos(-(S.x * M.x + S.y * M.y + S.z * M.z)) / DEG;
    console.log(label, { sepFromAntisun: sep, moonAngR: Math.asin(1737.4 / m.distanceKm) / DEG, ...o });
  }
});
import { resolveAtmosphereSpec, transmittanceRenderUnits, phaseHG as hg, phaseRayleigh as pr } from '../src/physics/planets-atmosphere';
const A = resolveAtmosphereSpec({ preset: 'earth' });
function tsun(r: number, muS: number) {
  const muH = -Math.sqrt(Math.max(0, 1 - 1 / (r * r)));
  const ss = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const vis = ss(-0.00465, 0.00465, muS - muH);
  if (vis <= 0) return [0, 0, 0];
  const T = transmittanceRenderUnits(A, r - 1, Math.max(muS, muH + 1e-6), 48);
  return [T[0] * vis, T[1] * vis, T[2] * vis];
}
function integrate(ro: number[], rd: number[], sun: number[], t0: number, t1: number, n: number, jitter = 0.5, mode = 'quad') {
  const L = [0, 0, 0], T = [1, 1, 1];
  const c = rd[0] * sun[0] + rd[1] * sun[1] + rd[2] * sun[2];
  const pR = pr(c), pM = hg(c, A.mieG[1]);
  const step = (t: number, dt: number) => {
    const p = [ro[0] + rd[0] * t, ro[1] + rd[1] * t, ro[2] + rd[2] * t];
    const r = Math.hypot(p[0], p[1], p[2]); const h = r - 1;
    const dR = Math.exp(-h / A.rayleighH), dM = Math.exp(-h / A.mieH), dA = Math.max(0, 1 - Math.abs(h - A.absorptionCenter) / A.absorptionWidth);
    const muS = (p[0] * sun[0] + p[1] * sun[1] + p[2] * sun[2]) / r;
    const ts = tsun(r, muS);
    for (let k = 0; k < 3; k++) {
      const sR = A.rayleigh[k] * dR, sM = A.mieScattering[k] * dM;
      const sigT = sR + A.mieExtinction[k] * dM + A.absorption[k] * dA;
      const S = (sR * pR + sM * pM) * ts[k];
      const Ts = Math.exp(-sigT * dt);
      L[k] += T[k] * (S - S * Ts) / Math.max(sigT, 1e-9);
      T[k] *= Ts;
    }
  };
  const tm = Math.min(Math.max(-(ro[0] * rd[0] + ro[1] * rd[1] + ro[2] * rd[2]), t0), t1);
  const la = tm - t0, lb = t1 - tm;
  const na = la > 0 ? Math.max(1, Math.floor(n * la / (la + lb) + 0.5)) : 0;
  const nb = lb > 0 ? Math.max(1, n - na) : 0;
  let prev = 0;
  for (let i = 0; i < na; i++) { const s = (i + 1) / na; const u0 = 1 - (1 - prev) ** 2, u1 = 1 - (1 - s) ** 2; const a = t0 + la * u0, b = t0 + la * u1; step(a + (b - a) * jitter, b - a); prev = s; }
  prev = 0;
  for (let i = 0; i < nb; i++) { const s = (i + 1) / nb; const a = tm + lb * prev * prev, b = tm + lb * s * s; step(a + (b - a) * jitter, b - a); prev = s; }
  return { L, T };
}
function raySphere(ro: number[], rd: number[], R: number) {
  const b = ro[0] * rd[0] + ro[1] * rd[1] + ro[2] * rd[2];
  const h = b * b - (ro[0] ** 2 + ro[1] ** 2 + ro[2] ** 2 - R * R);
  if (h < 0) return null; const s = Math.sqrt(h); return [-b - s, -b + s];
}
it('explore integrator convergence', () => {
  const rows: string[] = [];
  for (const vz of [0, 45, 70, 80, 85, 88]) {
    // ground point at the north pole of a local frame, camera along the view zenith direction, far away
    const g = [0, 1, 0];
    const vdir = [Math.sin(vz * DEG), Math.cos(vz * DEG), 0]; // from ground to camera
    const cam = [g[0] + vdir[0] * 3, g[1] + vdir[1] * 3, g[2] + vdir[2] * 3];
    const rd = [-vdir[0], -vdir[1], -vdir[2]];
    const top = raySphere(cam, rd, A.top)!; const gr = raySphere(cam, rd, 1)!;
    for (const sz of [0, 60, 85, 90, 93]) {
      const sun = [Math.sin(sz * DEG) * Math.cos(0.7), Math.cos(sz * DEG), Math.sin(sz * DEG) * Math.sin(0.7)];
      const ref = integrate(cam, rd, sun, top[0], gr[0], 600);
      const errs: string[] = [];
      for (const n of [3, 4, 6, 8, 10, 14]) {
        const r = integrate(cam, rd, sun, top[0], gr[0], n);
        const e = Math.max(...[0, 1, 2].map((k) => Math.abs(r.L[k] - ref.L[k]) / Math.max(ref.L[k], 1e-6)));
        errs.push(`${n}:${(e * 100).toFixed(2)}%`);
      }
      rows.push(`vz ${vz} sz ${sz} path ${((gr[0] - top[0]) * 6371).toFixed(0)}km Lg ${ref.L[1].toExponential(2)} ${errs.join(' ')}`);
    }
  }
  console.log(rows.join('\n'));
});
function compose(a: { L: number[]; T: number[] }, b: { L: number[]; T: number[] }) {
  return { L: a.L.map((x, k) => x + a.T[k] * b.L[k]), T: a.T.map((x, k) => x * b.T[k]) };
}
it('explore split integrator', () => {
  const rows: string[] = [];
  const H = A.rayleighH;
  const cmidR = 1 + 0.5 * (0.25 * H + 1.1 * H);
  for (const vz of [0, 45, 70, 80, 85, 88]) {
    const g = [0, 1, 0];
    const vdir = [Math.sin(vz * DEG), Math.cos(vz * DEG), 0];
    const cam = [g[0] + vdir[0] * 3, g[1] + vdir[1] * 3, g[2] + vdir[2] * 3];
    const rd = [-vdir[0], -vdir[1], -vdir[2]];
    const top = raySphere(cam, rd, A.top)!; const gr = raySphere(cam, rd, 1)!; const cm = raySphere(cam, rd, cmidR)!;
    for (const sz of [0, 60, 85, 90, 93]) {
      const sun = [Math.sin(sz * DEG) * Math.cos(0.7), Math.cos(sz * DEG), Math.sin(sz * DEG) * Math.sin(0.7)];
      const ref = integrate(cam, rd, sun, top[0], gr[0], 800);
      const old = integrate(cam, rd, sun, top[0], raySphere(cam, rd, 1 + 1.1 * H)![0], 14);
      const errs: string[] = [`old14(missing slab air):${(100 * (old.L[2] - ref.L[2]) / ref.L[2]).toFixed(1)}%`];
      for (const [n, m] of [[4, 3], [5, 3], [6, 3], [6, 4], [8, 4], [10, 4], [12, 4]]) {
        const r = compose(integrate(cam, rd, sun, top[0], cm[0], n), integrate(cam, rd, sun, cm[0], gr[0], m));
        const e = Math.max(...[0, 1, 2].map((k) => Math.abs(r.L[k] - ref.L[k]) / Math.max(ref.L[k], 1e-6)));
        errs.push(`${n}+${m}:${(e * 100).toFixed(2)}%`);
      }
      rows.push(`vz ${vz} sz ${sz} ${errs.join(' ')}`);
    }
  }
  console.log(rows.join('\n'));
});
