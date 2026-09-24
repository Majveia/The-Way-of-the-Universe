import * as THREE from 'three';
import type { ExperienceContext } from '../../core/types';
import { BlackHoleRenderer, type BlackHoleQuality } from '../../worlds/blackhole/BlackHoleRenderer';
import { FullscreenQuad, FULLSCREEN_VERT } from '../../core/post/FullscreenQuad';
import { Frame, UNIT } from '../../worlds/explorer/frames';
import { LayerFader } from '../../worlds/explorer/LayerFader';

/**
 * Sagittarius A*, the Milky Way's central black hole, as a stop of the explorer.
 *
 * Mass 4.30 × 10⁶ M☉ (GRAVITY Collaboration 2022; EHT 2022: 4.0 ± 0.6 × 10⁶), so the
 * gravitational radius r_g = GM/c² = 6.35 × 10⁹ m ≈ 0.042 AU and one light-crossing time
 * t_g = GM/c³ = 21 s. The frame is measured in r_g, spin along the Galactic pole (Sgr A*'s real spin
 * axis is uncertain; EHT favours a low inclination to our line of sight), a/M = 0.9.
 *
 * Near the hole the Kerr ray tracer (worlds/blackhole) draws the whole view: the galactic-centre sky
 * — captured once from the explorer's own Galaxy into a cube map — lensed around the shadow, plus a
 * Novikov–Thorne disk. Sgr A* really accretes very little (its flow is faint and hot, ~10⁻⁸ M☉/yr);
 * the bright thin disk is drawn so the lensing can be seen, and the UI says so. The ray-traced view is
 * mixed in over 2 500 → 1 500 r_g, where lensing is still negligible, so nothing pops.
 */
export const SGRA = { massSun: 4.3e6, rgMetres: 6.35e9, tgSeconds: 21.2 };
const RG_PC = SGRA.rgMetres / UNIT.PC;
/** Typical (log-mean) radiance of the lensed galactic-centre sky, post-exposure units. */
const ENV_LEVEL = 0.012;

const COPY_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D tSrc;
void main() { outColor = vec4(texture(tSrc, vUv).rgb, 1.0); }`;

export class SgrARegime {
  readonly frame: Frame;
  bh: BlackHoleRenderer | null = null;
  weight = 0;
  exposure = 1;
  private cube: THREE.WebGLCubeRenderTarget | null = null;
  private faceRT: THREE.WebGLRenderTarget | null = null;
  private copy: FullscreenQuad;
  private copyMat: THREE.ShaderMaterial;
  private fader: LayerFader;
  private captured = false;
  private cam = new THREE.PerspectiveCamera(55, 1, 0.01, 1e9);
  private faceCams: THREE.PerspectiveCamera[] = [];
  private time = 0;
  /** Normalisation of the captured sky (see capture). */
  private envNorm = 1;

  constructor(
    private ctx: ExperienceContext,
    mw: Frame,
    addChild: (p: Frame, c: Frame) => void,
  ) {
    this.frame = new Frame({ id: 'sgra', kind: 'system', label: 'Sgr A*', parent: mw, unit: RG_PC, entry: 3000, exit: 4000 });
    addChild(mw, this.frame);
    this.fader = new LayerFader(ctx.renderer, 'mix');
    this.copyMat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: FULLSCREEN_VERT, fragmentShader: COPY_FRAG, uniforms: { tSrc: { value: null } }, depthTest: false, depthWrite: false });
    this.copy = new FullscreenQuad(this.copyMat);
    // Cube-face cameras (three.js CubeCamera conventions, WebGL coordinate system).
    const dirs: Array<[number[], number[]]> = [
      [[1, 0, 0], [0, -1, 0]],
      [[-1, 0, 0], [0, -1, 0]],
      [[0, 1, 0], [0, 0, 1]],
      [[0, -1, 0], [0, 0, -1]],
      [[0, 0, 1], [0, -1, 0]],
      [[0, 0, -1], [0, -1, 0]],
    ];
    for (const [d, u] of dirs) {
      const c = new THREE.PerspectiveCamera(90, 1, 1e-4, 1e8);
      c.up.set(u[0], u[1], u[2]);
      c.lookAt(d[0], d[1], d[2]);
      c.updateMatrixWorld();
      this.faceCams.push(c);
    }
  }

  /** Build / drop the ray tracer by distance (r_g). */
  manage(dRg: number): void {
    this.weight = 1 - THREE.MathUtils.smoothstep(dRg, 1500, 2500);
    if (!this.bh && dRg < 20000) {
      this.bh = new BlackHoleRenderer(this.ctx.renderer, { quality: this.ctx.quality.tier as BlackHoleQuality });
      this.bh.setParams({ spin: 0.9, peakTemperature: 7500, diskOuter: 24, envGain: 1, starGain: 0.35, observer: 'static' });
      this.captured = false;
    } else if (this.bh && dRg > 40000) {
      this.bh.dispose();
      this.bh = null;
      this.cube?.dispose();
      this.cube = null;
      this.faceRT?.dispose();
      this.faceRT = null;
      this.captured = false;
    }
  }

  get needsCapture(): boolean {
    return !!this.bh && !this.captured;
  }

  /**
   * Capture the galactic-centre sky into the environment cube: `draw(camera, target)` renders the
   * explorer's background (Galaxy, web) for a 90° camera at the hole into a cleared 2D target.
   */
  capture(draw: (camera: THREE.PerspectiveCamera, target: THREE.WebGLRenderTarget) => void): void {
    if (!this.bh) return;
    const r = this.ctx.renderer;
    const size = this.ctx.quality.detail >= 1 ? 512 : 256;
    if (!this.cube) {
      this.cube = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
      this.faceRT = new THREE.WebGLRenderTarget(size, size, { type: THREE.HalfFloatType, depthBuffer: true });
    }
    const prev = r.getRenderTarget();
    // Meter the captured sky (log-mean luminance over all faces, sparse samples) so the lensed
    // environment keeps the dark-adapted look of the sky it replaces (a bulge-lit sky is bright).
    const buf = new Uint16Array(size * size * 4);
    let sumLog = 0;
    let n = 0;
    for (let i = 0; i < 6; i++) {
      r.setRenderTarget(this.faceRT);
      r.setClearColor(0x000000, 1);
      r.clear(true, true, false);
      draw(this.faceCams[i], this.faceRT!);
      try {
        r.readRenderTargetPixels(this.faceRT!, 0, 0, size, size, buf);
        for (let k = 0; k < size * size; k += 97) {
          const R = THREE.DataUtils.fromHalfFloat(buf[k * 4]), G = THREE.DataUtils.fromHalfFloat(buf[k * 4 + 1]), B = THREE.DataUtils.fromHalfFloat(buf[k * 4 + 2]);
          const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
          if (Number.isFinite(Y)) {
            sumLog += Math.log(Math.max(Y, 1e-5));
            n++;
          }
        }
      } catch {
        /* metering is optional */
      }
      this.copyMat.uniforms.tSrc.value = this.faceRT!.texture;
      r.setRenderTarget(this.cube, i);
      r.render(this.copy.scene, this.copy.camera);
    }
    r.setRenderTarget(prev);
    const logMean = n > 0 ? Math.exp(sumLog / n) : 0.05;
    this.envNorm = THREE.MathUtils.clamp(ENV_LEVEL / Math.max(logMean, 1e-6), 1e-3, 10);
    this.bh.setEnvironment(this.cube.texture);
    this.captured = true;
  }

  /** Advance the disk's clock by `seconds` of simulated time. */
  advance(seconds: number): void {
    this.time += seconds / SGRA.tgSeconds;
  }

  /**
   * Draw the ray-traced view mixed over the scene. `camPosRg` in the hole's frame (r_g), camera
   * attitude already in the hole's axes; `postE` the post exposure (the lensed sky is divided by it
   * so it matches the scene it replaces).
   */
  render(target: THREE.WebGLRenderTarget, quat: THREE.Quaternion, fov: number, camPosRg: THREE.Vector3, postE: number, frame: number): void {
    const bh = this.bh;
    if (!bh || !this.captured || this.weight <= 0.001) return;
    const c = this.cam;
    c.fov = fov;
    c.aspect = target.width / target.height;
    c.position.set(0, 0, 0);
    c.quaternion.copy(quat);
    c.updateProjectionMatrix();
    c.updateMatrixWorld();
    bh.setParams({ time: this.time, envGain: this.envNorm / Math.max(postE, 1e-6) });
    if (frame % 6 === 0) bh.meter();
    const t = this.fader.begin(target, this.weight);
    bh.render(t, c, camPosRg);
    this.fader.end();
  }

  /** Post exposure wanted near the hole (as Gargantua: meter the highlights of the disk). */
  meterExposure(dRg: number): number {
    const hl = this.bh?.highlightLuminance ?? 0;
    const auto = hl > 0 ? THREE.MathUtils.clamp(Math.pow(0.68 / hl, 0.75), 0.02, 1) : THREE.MathUtils.clamp(Math.pow(dRg / 30, 0.6), 0.05, 1);
    this.exposure = 2.4 * auto;
    return this.exposure;
  }

  dispose(): void {
    this.bh?.dispose();
    this.cube?.dispose();
    this.faceRT?.dispose();
    this.copyMat.dispose();
    this.fader.dispose();
  }
}
