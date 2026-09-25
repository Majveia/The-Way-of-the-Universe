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
