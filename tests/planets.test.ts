import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { gmst, moonState, sunState, msToJD, solarElevation, meanObliquity, eclipticToEquatorial, radecToVector } from '../src/physics/planets-ephemeris';
import { astroToThree } from '../src/physics/kepler';
import {
  AURORA_BRIGHT_KR,
  AURORA_LINES_NM,
  CITY_LUMINANCE,
  LIGHTS_SCALE,
  NIGHT_GAIN,
  UNIT_LUMINANCE,
  auroraGreenProfile,
  auroraLineGains,
  auroraRedProfile,
  kiloRayleighLuminance,
  kiloRayleighRadiance,
  planetSteps,
  profileColumnKm,
} from '../src/worlds/planet/glow';
import {
  composeSeg,
  integrateAtmoRef,
  lutDecode,
  lutEncode,
  occluderVisibility,
  raySphere,
  shellIntegral,
  shellPath,
  shellSample,
  type V3,
} from '../src/worlds/planet/reference';
import { LUT_SCALE } from '../src/worlds/planet/luts';
import { seasonalBlend, utcYear } from '../src/worlds/planet/textures';
import {
  EARTH_ATMOSPHERE,
  MARS_ATMOSPHERE,
  coxMunkSlopeVariance,
  fresnelF0,
  opticalDepthToTop,
  phaseHG,
  rayleighCoefficient,
  resolveAtmosphereSpec,
  toRendererUnits,
  transmittanceRenderUnits,
  transmittanceToTop,
} from '../src/physics/planets-atmosphere';
import {
  C2_555,
  SUN_RADIANCE_1AU,
  cloudReflectance,
  diskAverageRadiance,
  eddingtonLimbDarkening,
  lambertPhase,
  limbTemperature,
  lineColor,
  lommelSeeliger,
  planckRatio555,
  ringOpacity,
  ringParticlePhase,
  ringReflected,
  ringTransmitted,
  saturnRingTau,
  starlightTint,
  thermalRadiance,
} from '../src/physics/planets-photometry';

const DEG = Math.PI / 180;
const deg = (r: number) => r / DEG;

describe('ephemeris — Sun (Meeus ch. 25, 28)', () => {
  // Meeus Example 25.a: 1992 October 13.0 TD.
  const s = sunState(2448908.5);
  it('apparent longitude, RA, declination and distance match Example 25.a', () => {
    expect(deg(s.longitude)).toBeCloseTo(199.90895, 3);
    expect(deg(s.ra)).toBeCloseTo(198.38083, 3);
    expect(deg(s.dec)).toBeCloseTo(-7.78507, 3);
    expect(s.distanceAU).toBeCloseTo(0.99766, 4);
  });
  it('equation of time ≈ +13.7 min on 13 October (Example 28.a: 13m42.6s)', () => {
    expect(s.equationOfTime).toBeGreaterThan(13.55);
    expect(s.equationOfTime).toBeLessThan(13.85);
  });
  it('equation of time has its classic extremes (−14.2 min mid-Feb, +16.4 min early Nov)', () => {
    expect(sunState(msToJD(Date.UTC(2025, 1, 11, 12))).equationOfTime).toBeCloseTo(-14.2, 0);
    expect(sunState(msToJD(Date.UTC(2025, 10, 3, 12))).equationOfTime).toBeCloseTo(16.4, 0);
  });
  it('subsolar latitude equals the obliquity at the June solstice and ~0 at the equinox', () => {
    const sol = sunState(msToJD(Date.UTC(2024, 5, 20, 20, 51)));
    expect(deg(sol.subsolarLat)).toBeCloseTo(23.44, 1);
    const eq = sunState(msToJD(Date.UTC(2024, 2, 20, 3, 6)));
    expect(Math.abs(deg(eq.subsolarLat))).toBeLessThan(0.02);
  });
  it('subsolar longitude tracks apparent solar time: noon at Greenwich ≈ lon −EoT/4', () => {
    const jd = msToJD(Date.UTC(2025, 10, 3, 12, 0));
    const s2 = sunState(jd);
    // At 12:00 UTC the Sun is over 0° shifted west by the equation of time (4 min per degree).
    expect(deg(s2.subsolarLon)).toBeCloseTo(-s2.equationOfTime / 4, 1);
  });
  it('solar elevation is +90° at the subsolar point and −90° at its antipode', () => {
    const jd = msToJD(Date.UTC(2026, 8, 23, 9, 30));
    const s3 = sunState(jd);
    expect(deg(solarElevation(s3.subsolarLat, s3.subsolarLon, jd))).toBeCloseTo(90, 2);
    expect(deg(solarElevation(-s3.subsolarLat, s3.subsolarLon + Math.PI, jd))).toBeCloseTo(-90, 2);
  });
});

describe('ephemeris — sidereal time and frames', () => {
  it('GMST at J2000.0 is 280.46062°', () => {
    expect(deg(gmst(2451545.0))).toBeCloseTo(280.46061837, 6);
  });
  it('GMST on 1987 April 10, 0h UT is 13h10m46.3668s (Meeus Example 12.a)', () => {
    expect(deg(gmst(2446895.5))).toBeCloseTo(197.693195, 5);
  });
  it('mean obliquity at J2000 is 23°26′21.448″', () => {
    expect(deg(meanObliquity(2451545.0))).toBeCloseTo(23.4392911, 6);
  });
  it('ecliptic → equatorial: the June solstice point is at RA 6h, Dec +ε', () => {
    const eps = 23.44 * DEG;
    const q = eclipticToEquatorial(90 * DEG, 0, eps);
    expect(deg(q.ra)).toBeCloseTo(90, 6);
    expect(deg(q.dec)).toBeCloseTo(23.44, 6);
  });
});

describe('ephemeris — Moon (Meeus ch. 47)', () => {
  // Meeus Example 47.a: 1992 April 12, 0h TD.
  const m = moonState(2448724.5);
  it('longitude, latitude and distance match Example 47.a', () => {
    expect(deg(m.longitude)).toBeCloseTo(133.162655, 2);
    expect(deg(m.latitude)).toBeCloseTo(-3.229126, 2);
    expect(Math.abs(m.distanceKm - 368409.7)).toBeLessThan(40);
  });
  it('phases: full Moon ~ fully lit, new Moon ~ dark', () => {
    // Full Moon 2024-01-25 17:54 UTC, new Moon 2024-01-11 11:57 UTC.
    expect(moonState(msToJD(Date.UTC(2024, 0, 25, 17, 54))).illuminated).toBeGreaterThan(0.99);
    expect(moonState(msToJD(Date.UTC(2024, 0, 11, 11, 57))).illuminated).toBeLessThan(0.01);
  });
  it('distance stays between perigee and apogee over a month', () => {
    for (let d = 0; d < 30; d += 0.5) {
      const r = moonState(2460000.5 + d).distanceKm;
      expect(r).toBeGreaterThan(356000);
      expect(r).toBeLessThan(407000);
    }
  });
});

describe('atmosphere (Rayleigh + Mie + ozone)', () => {
  it('Earth zenith optical depth: Rayleigh ≈ β·H, total green transmittance ≈ 0.85', () => {
    const tau = opticalDepthToTop(EARTH_ATMOSPHERE, 0, 1);
    const rayleighG = 13.558e-6 * 8000 * (1 - Math.exp(-100 / 8));
    const mieG = 23.33e-6 * 1200;
    const ozoneG = 1.881e-6 * 15000;
    expect(tau[1]).toBeCloseTo(rayleighG + mieG + ozoneG, 3);
    const T = transmittanceToTop(EARTH_ATMOSPHERE, 0, 1);
    expect(T[1]).toBeGreaterThan(0.83);
    expect(T[1]).toBeLessThan(0.87);
    expect(T[2]).toBeLessThan(T[1]);
    expect(T[1]).toBeLessThan(T[0]);
  });
  it('sunlight is reddened near the horizon (sunsets are orange)', () => {
    const T = transmittanceToTop(EARTH_ATMOSPHERE, 0, 0.02, 1024);
    expect(T[0] / T[2]).toBeGreaterThan(20);
    expect(T[0]).toBeGreaterThan(0.05);
  });
  it('rays below the horizon are blocked by the ground', () => {
    expect(transmittanceToTop(EARTH_ATMOSPHERE, 0, -0.1)).toEqual([0, 0, 0]);
    // From 10 km, the geometric horizon dips ~3.2°: slightly downward rays still escape.
    expect(transmittanceToTop(EARTH_ATMOSPHERE, 10e3, -0.03, 1024)[0]).toBeGreaterThan(0);
  });
  it('Rayleigh coefficient of air from first principles ≈ 1.1–1.4 × 10⁻⁵ /m at 550 nm and ∝ λ⁻⁴', () => {
    const b550 = rayleighCoefficient(550e-9, 1.000278, 2.547e25);
    expect(b550).toBeGreaterThan(1.05e-5);
    expect(b550).toBeLessThan(1.4e-5);
    const b440 = rayleighCoefficient(440e-9, 1.000278, 2.547e25);
    expect(b550 / b440).toBeCloseTo(Math.pow(440 / 550, 4), 6);
  });
  it('renderer units give the same transmittance as SI', () => {
    const a = toRendererUnits(EARTH_ATMOSPHERE);
    const si = transmittanceToTop(EARTH_ATMOSPHERE, 3e3, 0.3, 512);
    const ru = transmittanceRenderUnits(a, 3e3 / 6371e3, 0.3, 512);
    for (let c = 0; c < 3; c++) expect(ru[c]).toBeCloseTo(si[c], 4);
  });
  it('contract spec resolves: empty spec = Earth-like air scaled to the radius; Mars preset keeps dusty blue-forward Mie', () => {
    const e = resolveAtmosphereSpec({});
    expect(e.rayleigh[1]).toBeCloseTo(13.558e-6 * 6371e3, 3);
    expect(e.top).toBeCloseTo(1 + 100 / 6371, 5);
    const small = resolveAtmosphereSpec({}, 3000);
    expect(small.rayleigh[1] / e.rayleigh[1]).toBeCloseTo(3000 / 6371, 5);
    const mars = resolveAtmosphereSpec({ preset: 'mars' });
    expect(mars.mieG[2]).toBeGreaterThan(mars.mieG[0]);
    expect(mars.mieScattering[0]).toBeGreaterThan(mars.mieScattering[2]);
    expect(MARS_ATMOSPHERE.mieAbsorption[2]).toBeGreaterThan(MARS_ATMOSPHERE.mieAbsorption[0]);
    const custom = resolveAtmosphereSpec({ scaleHeight: 0.002, mie: 50, mieG: 0.8 });
    expect(custom.rayleighH).toBe(0.002);
    expect(custom.mieG).toEqual([0.8, 0.8, 0.8]);
    expect(custom.mieExtinction[0]).toBeGreaterThan(50);
  });
  it('Henyey–Greenstein is normalised over the sphere', () => {
    for (const g of [0, 0.5, 0.76, -0.3]) {
      let s = 0;
      const n = 4000;
      for (let i = 0; i < n; i++) {
        const th = ((i + 0.5) / n) * Math.PI;
        s += phaseHG(Math.cos(th), g) * 2 * Math.PI * Math.sin(th) * (Math.PI / n);
      }
      expect(s).toBeCloseTo(1, 3);
    }
  });
  it('ocean optics: water F0 = 2%, Cox–Munk slope variance at 7 m/s ≈ 0.039', () => {
    expect(fresnelF0(1.333)).toBeCloseTo(0.0204, 3);
    expect(coxMunkSlopeVariance(7)).toBeCloseTo(0.03884, 5);
  });
});

describe('photometry', () => {
  it('Eddington limb darkening: the limb is 40% of the centre; limb temperature 0.84 T_eff', () => {
    expect(eddingtonLimbDarkening(1)).toBe(1);
    expect(eddingtonLimbDarkening(0)).toBeCloseTo(0.4, 6);
    expect(limbTemperature(5772, 0) / 5772).toBeCloseTo(Math.pow(0.5, 0.25), 6);
    expect(limbTemperature(5772, 1) / 5772).toBeCloseTo(Math.pow(1.25, 0.25), 6);
  });
  it('visible (555 nm) Planck ratios: 1300 K lava ~10⁻⁷ of the Sun, the Sun at 1 AU → 46 000', () => {
    expect(planckRatio555(5772)).toBeCloseTo(1, 10);
    const r = planckRatio555(1300);
    expect(r).toBeGreaterThan(1e-7);
    expect(r).toBeLessThan(4e-7);
    expect(SUN_RADIANCE_1AU).toBeGreaterThan(45000);
    expect(SUN_RADIANCE_1AU).toBeLessThan(47500);
    const lava = thermalRadiance(1500);
    expect(lava[0]).toBeGreaterThan(lava[2]);
  });
  it('starlight tint is white for the Sun, red for M dwarfs, blue for A stars', () => {
    const sun = starlightTint(5772);
    for (const c of sun) expect(c).toBeCloseTo(1, 3);
    const m = starlightTint(3200);
    expect(m[0]).toBeGreaterThan(m[2] * 2);
    const a = starlightTint(9500);
    expect(a[2]).toBeGreaterThan(a[0]);
  });
  it('Lambert phase: full at 0°, half-ish at quadrature, zero at 180°', () => {
    expect(lambertPhase(0)).toBeCloseTo(1, 10);
    expect(lambertPhase(Math.PI / 2)).toBeCloseTo(1 / Math.PI, 10);
    expect(lambertPhase(Math.PI)).toBeCloseTo(0, 10);
    expect(diskAverageRadiance(0.3, 1, 0)).toBeCloseTo(0.2, 10);
  });
  it('Lommel–Seeliger: no limb darkening at full phase (the full Moon looks flat)', () => {
    for (const mu of [1, 0.5, 0.1]) expect(lommelSeeliger(mu, mu)).toBeCloseTo(1, 10);
  });
  it('two-stream cloud reflectance: τ=0 → 0, τ≈20 → 0.6, τ→∞ → 1', () => {
    expect(cloudReflectance(0)).toBe(0);
    expect(cloudReflectance(20)).toBeCloseTo(0.6, 2);
    expect(cloudReflectance(1e6)).toBeGreaterThan(0.999);
  });
  it('ring particle phase function is normalised over 4π and backscatters', () => {
    let s = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) {
      const a = ((i + 0.5) / n) * Math.PI;
      s += 0.5 * ringParticlePhase(a) * Math.sin(a) * (Math.PI / n);
    }
    expect(s).toBeCloseTo(1, 3);
    expect(ringParticlePhase(0)).toBeGreaterThan(ringParticlePhase(Math.PI / 2));
  });
  it('ring photometry: lit face brightens with τ; unlit face peaks at τ ~ μ₀ (Cassini Division glows, B ring dark)', () => {
    const P = ringParticlePhase(0.5);
    expect(ringReflected(0.1, 0.3, 0.5, 0.5, P)).toBeLessThan(ringReflected(2, 0.3, 0.5, 0.5, P));
    const thin = ringTransmitted(0.01, 0.1, 0.4, 0.5, P);
    const mid = ringTransmitted(0.15, 0.1, 0.4, 0.5, P);
    const thick = ringTransmitted(4, 0.1, 0.4, 0.5, P);
    expect(mid).toBeGreaterThan(thin);
    expect(mid).toBeGreaterThan(thick * 50);
    // Continuity at μ = μ₀
    expect(ringTransmitted(0.3, 0.2, 0.2 + 1e-6, 0.5, P)).toBeCloseTo(ringTransmitted(0.3, 0.2, 0.2, 0.5, P), 5);
    expect(ringOpacity(0, 0.5)).toBe(0);
  });
  it('Saturn ring profile: B ring opaque, Cassini Division and Encke gap nearly empty', () => {
    expect(saturnRingTau(1.75)).toBeGreaterThan(2);
    expect(saturnRingTau(1.98)).toBeLessThan(0.15);
    expect(saturnRingTau(2.214)).toBeLessThan(0.05);
    expect(saturnRingTau(2.1)).toBeGreaterThan(0.4);
    expect(saturnRingTau(1.3)).toBeLessThan(0.2);
    expect(saturnRingTau(2.5)).toBe(0);
  });
  it('aurora lines: 557.7 nm is green, 630 nm red, 427.8 nm blue', () => {
    const g = lineColor(557.7), r = lineColor(630), b = lineColor(427.8);
    expect(g[1]).toBeGreaterThan(g[0]);
    expect(g[1]).toBeGreaterThan(g[2]);
    expect(r[0]).toBeGreaterThan(r[1]);
    expect(b[2]).toBeGreaterThan(b[1]);
  });
});

describe('Earth experience — view geometry', async () => {
  const { fovForDistance, pbdProgress, voyagerGeocentricAU, voyagerSunEarthAngle, apparentPixels, AU_RE } = await import('../src/experiences/earth/math');
  const { meanMotion } = await import('../src/experiences/earth/camera');
  const { SunGlare } = await import('../src/experiences/earth/glare');
  const THREE = await import('three');

  it('ISS orbit at 420 km has a period of ≈ 92.8 minutes', () => {
    const T = (2 * Math.PI) / meanMotion(1 + 420 / 6371) / 60;
    expect(T).toBeGreaterThan(92.4);
    expect(T).toBeLessThan(93.2);
  });
  it('geostationary radius gives one sidereal day', () => {
    const T = (2 * Math.PI) / meanMotion(42164 / 6371);
    expect(T / 86164.1).toBeCloseTo(1, 3);
  });
  it('field of view: 34° near Earth → Voyager NAC pixel scale at 40 AU', () => {
    expect(fovForDistance(4)).toBeCloseTo(34, 5);
    expect(fovForDistance(40.5 * AU_RE)).toBeCloseTo(0.38, 2);
    expect(pbdProgress(2)).toBe(0);
    expect(pbdProgress(40 * AU_RE)).toBe(1);
  });
  it('Pale Blue Dot: Voyager ≈ 40.4 AU from Earth, Earth within ~2° of the Sun, ~0.1 NAC pixel', () => {
    const v = voyagerGeocentricAU();
    const d = Math.hypot(v.x, v.y, v.z);
    expect(d).toBeGreaterThan(39.5);
    expect(d).toBeLessThan(41.5);
    const ang = voyagerSunEarthAngle() / DEG;
    expect(ang).toBeGreaterThan(0.3);
    expect(ang).toBeLessThan(2);
    const px = apparentPixels(6371, d * 1.495978707e8, (0.424 * DEG) / 800);
    expect(px).toBeGreaterThan(0.08);
    expect(px).toBeLessThan(0.3);
  });
  it('Sun glare visibility: 1 unobstructed, 0 behind the Earth, partial at the limb', () => {
    const sun = new THREE.Vector3(23500, 0, 0);
    const earth = [{ c: new THREE.Vector3(0, 0, 0), r: 1 }];
    expect(SunGlare.visibility(new THREE.Vector3(0, 5, 0), sun, 109, earth)).toBeCloseTo(1, 6);
    expect(SunGlare.visibility(new THREE.Vector3(-3, 0, 0), sun, 109, earth)).toBe(0);
    // Camera placed so the Earth's limb crosses the solar disk centre.
    // The line of sight to the Sun grazes the Earth's limb (impact parameter = 1 radius).
    const eye = new THREE.Vector3(-3, 1, 0);
    const v = SunGlare.visibility(eye, sun, 109, earth);
    expect(v).toBeGreaterThan(0.05);
    expect(v).toBeLessThan(0.95);
  });
});

// ——— Review (hardening pass): end-to-end frames, eclipses, integrator accuracy, glows, tiers ———

const AU_KM = 149597870.7;
const R_E = 6371;
const toThree = (ra: number, dec: number) => astroToThree(new THREE.Vector3().copy(radecToVector(ra, dec, new THREE.Vector3())));

/** Where the Sun→Moon axis meets the (spherical) Earth: geocentric lat/lon (deg), or null. */
function shadowAxisPoint(ms: number): { lat: number; lon: number; moonKm: number; sunAng: number } | null {
  const jd = msToJD(ms);
  const s = sunState(jd);
  const m = moonState(jd);
  const S = radecToVector(s.ra, s.dec, { x: 0, y: 0, z: 0 });
  const M = radecToVector(m.ra, m.dec, { x: 0, y: 0, z: 0 });
  const sun: V3 = [S.x * s.distanceAU * AU_KM, S.y * s.distanceAU * AU_KM, S.z * s.distanceAU * AU_KM];
  const moon: V3 = [M.x * m.distanceKm, M.y * m.distanceKm, M.z * m.distanceKm];
  const d: V3 = [moon[0] - sun[0], moon[1] - sun[1], moon[2] - sun[2]];
  const l = Math.hypot(...d);
  const hit = raySphere(moon, [d[0] / l, d[1] / l, d[2] / l], R_E);
  if (!hit) return null;
  const p = moon.map((x, i) => x + (d[i] / l) * hit[0]);
  let lon = (Math.atan2(p[1], p[0]) - gmst(jd)) / DEG;
  lon = ((lon + 540) % 360) - 180;
  return { lat: Math.asin(p[2] / R_E) / DEG, lon, moonKm: m.distanceKm, sunAng: Math.asin(695700 / (s.distanceAU * AU_KM)) };
}

describe('review — frames: ephemeris, sidereal rotation and the three.js scene agree', () => {
  it('the subsolar point of the rotated Earth faces the Sun (texture longitude convention × GMST × astroToThree)', () => {
    for (const ms of [Date.UTC(2026, 8, 25, 19, 42), Date.UTC(2024, 5, 20, 20, 51), Date.UTC(1990, 1, 14, 4, 48), Date.UTC(2027, 7, 2, 10, 7)]) {
      const jd = msToJD(ms);
      const s = sunState(jd);
      // Body-fixed direction of (lat, lon) as the surface shader's equirectUV reads it: lon = atan(−z, x).
      const lat = s.subsolarLat, lon = s.subsolarLon;
      const body = new THREE.Vector3(Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon));
      const earth = new THREE.Object3D();
      earth.rotation.y = gmst(jd); // PlanetRenderer.setRotation(gmst)
      earth.updateMatrixWorld();
      const world = body.applyMatrix4(earth.matrixWorld);
      const sun = toThree(s.ra, s.dec);
      expect(world.angleTo(sun)).toBeLessThan(1e-9);
    }
  });
  it('the Moon is tidally locked: longitude 0 faces the Earth, north pole on the ecliptic pole, right-handed', async () => {
    const { moonOrientation } = await import('../src/experiences/earth/math');
    const jd = msToJD(Date.UTC(2026, 8, 25, 20));
    const m = moonState(jd);
    const pos = toThree(m.ra, m.dec).multiplyScalar(m.distanceKm / R_E);
    const eps = meanObliquity(jd);
    const q = moonOrientation(pos, eps, new THREE.Quaternion());
    const x = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const y = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const z = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    // |β| ≤ 5.3°: the sub-Earth point stays within the Moon's latitude range from its equator.
    expect(x.angleTo(pos.clone().negate())).toBeLessThan(5.4 * DEG);
    expect(y.angleTo(new THREE.Vector3(0, Math.cos(eps), Math.sin(eps)))).toBeLessThan(1e-9);
    expect(new THREE.Vector3().crossVectors(x, y).dot(z)).toBeCloseTo(1, 9);
    // Seen from Earth with north up, lunar east (Mare Crisium, +58°E) is on the right (IAU convention).
    const crisium = new THREE.Vector3(Math.cos(58 * DEG), 0, -Math.sin(58 * DEG)).applyQuaternion(q);
    const view = pos.clone().normalize();
    const right = new THREE.Vector3().crossVectors(view, y).normalize();
    expect(crisium.dot(right)).toBeGreaterThan(0.5);
  });
});

describe('review — eclipses reproduce NASA geometry (Espenak & Meeus, Five Millennium Canon)', () => {
  // Greatest eclipse (TD; the module takes UT ≈ TT, so ΔT ≈ 69 s shifts longitudes ≈ 0.3° west).
  const cases: Array<[string, number, number, number]> = [
    ['2027-08-02 total, Luxor', Date.UTC(2027, 7, 2, 10, 7, 50), 25.52, 33.13],
    ['2024-04-08 total, Mexico', Date.UTC(2024, 3, 8, 18, 17, 16), 25.29, -104.14],
    ['2017-08-21 total, Kentucky', Date.UTC(2017, 7, 21, 18, 25, 32), 36.97, -87.67],
  ];
  for (const [label, ms, lat, lon] of cases) {
    it(`solar ${label}: the Moon's shadow axis meets the Earth within ~100 km, and the eclipse is total`, () => {
      const p = shadowAxisPoint(ms)!;
      expect(p).not.toBeNull();
      // Geodetic → geocentric latitude differs by ≤ 0.19°; the series and ΔT add ≲ 0.7°.
      expect(Math.abs(p.lat - lat)).toBeLessThan(0.9);
      expect(Math.abs(p.lon - lon)).toBeLessThan(1.0);
      // Seen from the point, the Moon (≥ 1 R⊕ closer than its centre distance) covers the Sun.
      expect(Math.asin(1737.4 / (p.moonKm - R_E))).toBeGreaterThan(p.sunAng);
    });
  }
  it('lunar 2025-09-07 and 2025-03-14: the renderer occlusion model puts the Moon in full umbra at greatest eclipse', () => {
    const at = (ms: number) => {
      const jd = msToJD(ms);
      const s = sunState(jd);
      const m = moonState(jd);
      const S = radecToVector(s.ra, s.dec, { x: 0, y: 0, z: 0 });
      const M = radecToVector(m.ra, m.dec, { x: 0, y: 0, z: 0 });
      const p: V3 = [(M.x * m.distanceKm) / R_E, (M.y * m.distanceKm) / R_E, (M.z * m.distanceKm) / R_E];
      // The Earth's shadow, enlarged ~2 % by its atmosphere (Danjon), as the experience passes it.
      return occluderVisibility(p, [0, 0, 0], 1.012, [S.x, S.y, S.z], Math.asin(695700 / (s.distanceAU * AU_KM)));
    };
    for (const ms of [Date.UTC(2025, 8, 7, 18, 11, 48), Date.UTC(2025, 2, 14, 6, 58, 43)]) {
      const o = at(ms);
      expect(o.visible).toBe(0);
      expect(o.umbra).toBeCloseTo(1, 6);
    }
    // Umbral first contact 16:27 UT: the Moon's centre is one lunar radius outside the umbra (partial).
    const c1 = at(Date.UTC(2025, 8, 7, 16, 27));
    expect(c1.umbra).toBe(0);
    expect(c1.visible).toBeGreaterThan(0.2);
    expect(c1.visible).toBeLessThan(0.9);
    // Penumbral first contact 15:28 UT: the centre is still fully sunlit.
    expect(at(Date.UTC(2025, 8, 7, 15, 28)).visible).toBe(1);
  });
});

describe('review — atmosphere quadrature (surface pass) against a converged reference', () => {
  const A = resolveAtmosphereSpec({ preset: 'earth' });
  const H = A.rayleighH;
  const cloudTop = 1 + 1.1 * H;
  const cloudBase = 1 + 0.25 * H;
  /** A ray from 3 R⊕ looking down at a ground point with view zenith angle vz; sun at zenith angle sz. */
  const geometry = (vz: number, sz: number) => {
    const vdir: V3 = [Math.sin(vz * DEG), Math.cos(vz * DEG), 0];
    const ro: V3 = [vdir[0] * 3, 1 + vdir[1] * 3, 0];
    const rd: V3 = [-vdir[0], -vdir[1], 0];
    const sun: V3 = [Math.sin(sz * DEG) * Math.cos(0.7), Math.cos(sz * DEG), Math.sin(sz * DEG) * Math.sin(0.7)];
    const top = raySphere(ro, rd, A.top)!;
    const ground = raySphere(ro, rd, 1)!;
    return { ro, rd, sun, t0: top[0], t1: ground[0] };
  };
  const relErr = (x: V3, ref: V3) => Math.max(...[0, 1, 2].map((k) => Math.abs(x[k] - ref[k]) / ref[k]));
  const views: Array<[number, number]> = [[0, 0], [0, 60], [45, 30], [70, 60], [80, 85], [85, 0]];

  it('the clear-sky path through the cloud deck keeps its air: the old split lost ~40 % of the in-scattered light', () => {
    for (const [vz, sz] of views) {
      const g = geometry(vz, sz);
      const ref = integrateAtmoRef(A, g.ro, g.rd, g.sun, g.t0, g.t1, 800);
      const ca = raySphere(g.ro, g.rd, cloudTop)![0];
      const cb = raySphere(g.ro, g.rd, cloudBase)![0];
      // Before: top → cloud top (14 steps), cloud base → ground (3 steps); the slab's air skipped.
      const old = composeSeg(integrateAtmoRef(A, g.ro, g.rd, g.sun, g.t0, ca, 14), integrateAtmoRef(A, g.ro, g.rd, g.sun, cb, g.t1, 3));
      expect(old.L[2] / ref.L[2]).toBeLessThan(0.85);
      // Now: top → middle of the deck, deck → ground, with the 'high' tier's sample counts.
      const st = planetSteps(1);
      const cm = 0.5 * (ca + cb);
      const now = composeSeg(integrateAtmoRef(A, g.ro, g.rd, g.sun, g.t0, cm, st.above), integrateAtmoRef(A, g.ro, g.rd, g.sun, cm, g.t1, st.below));
      expect(relErr(now.L, ref.L)).toBeLessThan(0.03);
      // Grazing views (85°) see the ground through T ≈ 0.05 in blue; 4 % of that is 0.002.
      expect(relErr(now.T, ref.T)).toBeLessThan(vz >= 80 ? 0.045 : 0.012);
    }
  });
  it('every quality tier stays within a few percent (low ≤ 7 %, medium ≤ 4 %)', () => {
    for (const [detail, tol] of [[0.35, 0.07], [0.7, 0.04], [1.6, 0.02]] as const) {
      const st = planetSteps(detail);
      for (const [vz, sz] of views) {
        const g = geometry(vz, sz);
        const ref = integrateAtmoRef(A, g.ro, g.rd, g.sun, g.t0, g.t1, 800);
        const cm = 0.5 * (raySphere(g.ro, g.rd, cloudTop)![0] + raySphere(g.ro, g.rd, cloudBase)![0]);
        const r = composeSeg(integrateAtmoRef(A, g.ro, g.rd, g.sun, g.t0, cm, st.above), integrateAtmoRef(A, g.ro, g.rd, g.sun, cm, g.t1, st.below));
        expect(relErr(r.L, ref.L)).toBeLessThan(tol);
      }
    }
  });
});

describe('review — emission shells (aurora, airglow) are sampled over their own altitudes', () => {
  const km = 1 / 6371;
  const rc = 1 + 95 * km;
  const s = 6 * km;
  const layer = (r: number) => Math.exp(-(((r - rc) / s) ** 2));
  const column = s * Math.sqrt(Math.PI); // ∫ exp(−(h/s)²) dh
  it('shell samples are a partition: weights sum to the path length inside the shell', () => {
    for (const [ro, rd] of [
      [[0, 3, 0], [0, -1, 0]], // straight down
      [[3, 1 + 30 * km, 0], [-1, 0, 0]], // limb, tangent at 30 km: crosses the shell twice
      [[3, 1 + 105 * km, 0], [-1, 0, 0]], // limb, tangent inside the layer
    ] as Array<[V3, V3]>) {
      const sp = shellPath(ro, rd, -1e9, 1e9, rc - 3 * s, rc + 3 * s)!;
      let w = 0;
      for (let i = 0; i < 16; i++) w += shellSample(sp, (i + 0.5) / 16, 16)[1];
      expect(w).toBeCloseTo(sp.lo1 - sp.a + (sp.b - sp.lo2), 9);
    }
  });
  it('a thin layer is integrated accurately seen from above and at the limb with the tier sample counts', () => {
    // Straight down through the layer: the column.
    const down = shellIntegral([0, 3, 0], [0, -1, 0], -1e9, raySphere([0, 3, 0], [0, -1, 0], 1)![0], rc - 3 * s, rc + 3 * s, planetSteps(0.35).airglow, layer);
    expect(Math.abs(down / column - 1)).toBeLessThan(0.02);
    // Limb ray tangent at the layer's peak: reference by brute force.
    const ro: V3 = [3, rc, 0];
    const rd: V3 = [-1, 0, 0];
    let ref = 0;
    for (let i = 0; i < 400000; i++) {
      const t = 1 + (i + 0.5) * 1e-5; // x from 2 to −2: the whole chord
      ref += layer(Math.hypot(ro[0] + rd[0] * t, ro[1])) * 1e-5;
    }
    for (const detail of [0.7, 1]) {
      const limb = shellIntegral(ro, rd, -1e9, 1e9, rc - 3 * s, rc + 3 * s, planetSteps(detail).airglow, layer);
      expect(Math.abs(limb / ref - 1)).toBeLessThan(0.1);
    }
  });
});

describe('review — night-glow photometry (one night-vision gain for cities, aurora and airglow)', () => {
  it('1 kR of O I 557.7 nm is 1.9 × 10⁻⁴ cd m⁻²; the gain maps a bright city to LIGHTS_SCALE', () => {
    // 1 kR = 10¹³/4π photons s⁻¹ m⁻² sr⁻¹ × hc/λ (3.56 × 10⁻¹⁹ J) = 2.84 × 10⁻⁷ W m⁻² sr⁻¹; × 683 lm/W × V.
    expect(kiloRayleighLuminance(557.73)).toBeGreaterThan(1.85e-4);
    expect(kiloRayleighLuminance(557.73)).toBeLessThan(1.97e-4);
    expect((CITY_LUMINANCE / UNIT_LUMINANCE) * NIGHT_GAIN).toBeCloseTo(LIGHTS_SCALE, 9);
    expect(NIGHT_GAIN).toBeGreaterThan(5e4);
    expect(NIGHT_GAIN).toBeLessThan(3e5);
  });
  it('a bright auroral arc seen straight down is ~1/15 of a saturated city; the red line tops the green', () => {
    const g = auroraLineGains(6371);
    const vertical = (gain: number, f: (h: number) => number) => (gain * profileColumnKm(f)) / 6371;
    const green = vertical(g.green, auroraGreenProfile);
    expect(green).toBeCloseTo(AURORA_BRIGHT_KR.green * kiloRayleighRadiance(AURORA_LINES_NM.green), 9);
    expect(green / LIGHTS_SCALE).toBeGreaterThan(1 / 30);
    expect(green / LIGHTS_SCALE).toBeLessThan(1 / 8);
    // The emission the old renderer drew (only below the 100 km top of the scattering atmosphere) was
    // ~2 % of the green column and none of the red.
    expect(profileColumnKm(auroraGreenProfile, 88, 100) / profileColumnKm(auroraGreenProfile)).toBeLessThan(0.03);
    expect(profileColumnKm(auroraRedProfile, 88, 100)).toBe(0);
    // Red (O I 630.0 nm) emission lives above 200 km; green peaks near 110 km.
    expect(profileColumnKm(auroraRedProfile, 200, 420) / profileColumnKm(auroraRedProfile)).toBeGreaterThan(0.8);
    expect(profileColumnKm(auroraGreenProfile, 95, 200) / profileColumnKm(auroraGreenProfile)).toBeGreaterThan(0.8);
  });
});

describe('review — quality tiers and portability', () => {
  it('sample counts scale with the tier: low costs well under half of high per pixel', () => {
    const cost = (d: number) => {
      const s = planetSteps(d);
      return s.above + s.below + 0.5 * (s.auroraLow + s.auroraHigh + s.airglow);
    };
    expect(cost(0.35) / cost(1)).toBeLessThan(0.5);
    expect(cost(0.7)).toBeLessThan(cost(1));
    expect(planetSteps(0.35).detailLevel).toBe(0);
    expect(planetSteps(0.7).detailLevel).toBe(1);
    expect(planetSteps(1).detailLevel).toBe(2);
  });
  it('RGBA8 LUT fallback (no renderable half floats) keeps sunset transmittance within a few percent', () => {
    for (const [v, k] of [[0.9, 0], [0.2, 0], [0.02, 0], [0.05, 1], [0.3, 2]] as Array<[number, number]>) {
      const q = Math.round(lutEncode(v, LUT_SCALE[k], true) * 255) / 255;
      expect(Math.abs(lutDecode(q, LUT_SCALE[k], true) / v - 1)).toBeLessThan(0.06);
      expect(lutDecode(lutEncode(v, LUT_SCALE[k], false), LUT_SCALE[k], false)).toBe(v);
    }
  });
});

describe('review — Pale Blue Dot, seasons, stars, sprites', () => {
  it('the final field gives Voyager\'s pixel scale on any viewport: the Earth is the same sub-pixel dot everywhere', async () => {
    const { fovForDistance, voyagerGeocentricAU, AU_RE, NAC_PIXEL_DEG } = await import('../src/experiences/earth/math');
    const v = voyagerGeocentricAU();
    const d = Math.hypot(v.x, v.y, v.z) * AU_RE;
    for (const px of [390, 720, 1080, 1600]) {
      const fov = fovForDistance(d, px);
      expect(fov / px).toBeCloseTo(NAC_PIXEL_DEG, 6);
      // Angular diameter 2.1 µrad over a 9.25 µrad NAC pixel: 0.23 px across (NASA's "0.12 pixel" is
      // about its radius), however many CSS pixels the screen has.
      const earthPx = (2 * Math.asin(1 / d)) / DEG / (fov / px);
      expect(earthPx).toBeGreaterThan(0.2);
      expect(earthPx).toBeLessThan(0.26);
    }
    expect(fovForDistance(4, 1080)).toBeCloseTo(34, 6);
  });
  it('seasonal imagery weights are continuous through the year and the year boundary', () => {
    let prev: number[] | null = null;
    const w = [0, 0, 0, 0];
    const out = { a: 0, b: 0, t: 0 };
    for (let ms = Date.UTC(2023, 11, 1); ms < Date.UTC(2025, 1, 1); ms += 3_600_000) {
      const { a, b, t } = seasonalBlend(ms, out);
      w.fill(0);
      w[a] += 1 - t;
      w[b] += t;
      if (prev) for (let k = 0; k < 4; k++) expect(Math.abs(w[k] - prev[k])).toBeLessThan(0.002);
      prev = w.slice();
    }
    // Mid-January is pure January.
    const jan = seasonalBlend(Date.UTC(2025, 0, 16, 12));
    expect(jan.a).toBe(0);
    expect(jan.t).toBeLessThan(0.01);
  });
  it('utcYear matches Date for 20 000 timestamps across 1900–2100 (leap years, year boundaries)', () => {
    for (let i = 0; i < 20000; i++) {
      const ms = Date.UTC(1900, 0, 1) + ((i * 7919.123) % 1) * 0 + i * 315_576_000 + ((i * 2654435761) % 86_400_000);
      expect(utcYear(ms)).toBe(new Date(ms).getUTCFullYear());
    }
    for (const y of [1999, 2000, 2024, 2100]) {
      expect(utcYear(Date.UTC(y, 0, 1))).toBe(y);
      expect(utcYear(Date.UTC(y, 0, 1) - 1)).toBe(y - 1);
    }
  });
  it('star shader constants: hc/(λk) at 555 nm = 25 925 K; limb/centre at 555 nm ≈ 0.3 (Allen: 0.30 at 550 nm)', () => {
    expect(C2_555).toBeCloseTo(25925, -1);
    const T0 = limbTemperature(5772, 0), T1 = limbTemperature(5772, 1);
    const ratio = Math.expm1(C2_555 / T1) / Math.expm1(C2_555 / T0);
    expect(ratio).toBeGreaterThan(0.25);
    expect(ratio).toBeLessThan(0.4);
  });
  it('the sub-pixel sprite (σ = 0.75 px Gaussian in a 5 px point) conserves flux: 2πσ² = 3.53', () => {
    // POINT_VERT/STAR_POINT_VERT divide by 3.53; sum the truncated Gaussian over the 5 × 5 pixel grid.
    for (const [ox, oy] of [[0, 0], [0.3, -0.2], [0.49, 0.49]]) {
      let sum = 0;
      for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) sum += Math.exp(-((x - ox) ** 2 + (y - oy) ** 2) / (2 * 0.75 * 0.75));
      if (ox === 0 && oy === 0) expect(sum / 3.53).toBeCloseTo(1, 1);
      expect(Math.abs(sum / 3.53 - 1)).toBeLessThan(0.06);
    }
  });
});
