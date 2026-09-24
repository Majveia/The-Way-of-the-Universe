import * as THREE from 'three';
import type { Experience, ExperienceContext, FrameInfo } from '../../core/types';
import { OrbitRig } from '../../core/rigs/OrbitRig';
import { Sky } from '../../worlds/sky/Sky';
import { BlackHoleRenderer, type BlackHoleQuality } from '../../worlds/blackhole/BlackHoleRenderer';

const DEG = Math.PI / 180;

/** Gargantua — a Kerr black hole ray-traced along exact light paths. */
class Gargantua implements Experience {
  private ctx!: ExperienceContext;
  private bh!: BlackHoleRenderer;
  private sky!: Sky;
  private cubeRT!: THREE.WebGLCubeRenderTarget;
  private cubeCam!: THREE.CubeCamera;
  private rig!: OrbitRig;
  private camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  private camPos = new THREE.Vector3();
  private time = 0;
  private timeScale = 3; // M per second
  private readyFrames = 0;

  mount(ctx: ExperienceContext): void {
    this.ctx = ctx;
    const tier = ctx.quality.tier as BlackHoleQuality;
    this.bh = new BlackHoleRenderer(ctx.renderer, { quality: tier });
    ctx.progress(0.3, 'Bending light');

    // Background: the project's sky (Milky Way band; point stars are lensed analytically).
    this.sky = new Sky({ stars: 100, brightness: 0, milkyWay: 1.1 });
    const size = tier === 'low' ? 256 : tier === 'medium' ? 512 : 1024;
    this.cubeRT = new THREE.WebGLCubeRenderTarget(size, {
      type: THREE.HalfFloatType,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.cubeCam = new THREE.CubeCamera(0.1, 10, this.cubeRT);
    this.orientSky(28 * DEG, 9 * DEG);
    this.bh.setEnvironment(this.cubeRT.texture);

    this.rig = new OrbitRig(null, {
      distance: 34,
      yaw: 28 * DEG,
      pitch: 9 * DEG,
      minDistance: 3.5,
      maxDistance: 2000,
      autoRotate: 0.01,
      idleDelay: 8,
      enablePan: false,
    });
    ctx.input.onDrag((e) => {
      this.rig.rotate(e.dx, e.dy);
    });
    ctx.input.onWheel((e) => this.rig.zoom(e.delta * 0.18));
    ctx.input.onPinch((e) => this.rig.zoom(-Math.log(Math.max(0.2, Math.min(5, e.scale)))));

    ctx.post.exposure = 1.0;
    ctx.post.bloomStrength = 0.08;
    ctx.post.bloomRadius = 0.85;
    ctx.post.tonemap = 'agx-punchy';
    ctx.post.saturation = 1.15;
    ctx.post.vignette = 0.22;
    ctx.audio.setMood('blackhole', { intensity: 0.6, mass: 4.3e6 });
    ctx.ui.hint('Drag to orbit · Scroll to zoom');
    ctx.progress(1);
  }

  /** Put the galactic centre behind the hole as seen from the default view, band tilted 50°. */
  private orientSky(yaw: number, pitch: number): void {
    const P = new THREE.Vector3(Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw));
    const g = P.clone().negate();
    const side = new THREE.Vector3(0, 1, 0).cross(g).normalize();
    const beta = 50 * DEG;
    const w = side.multiplyScalar(Math.cos(beta)).add(new THREE.Vector3(0, Math.sin(beta), 0));
    const n = g.clone().cross(w).normalize();
    const z = g.clone().cross(n).normalize();
    const m = new THREE.Matrix4().makeBasis(g, n, z);
    this.sky.setRotation(m, 'galactic');
    const r = this.ctx.renderer;
    const prev = r.autoClear;
    r.autoClear = true;
    this.cubeCam.update(r, this.sky.scene);
    r.autoClear = prev;
  }

  update(f: FrameInfo): void {
    this.rig.update(f.dt);
    this.time += f.dt * this.timeScale;
    this.bh.setParams({ time: this.time });
    if (++this.readyFrames === 2) this.ctx.signalReady();
  }

  render(target: THREE.WebGLRenderTarget): void {
    const cam = this.camera;
    const aspect = target.width / target.height;
    // Keep at least ~56° horizontally (portrait phones), 40° vertically.
    const minH = 56 * DEG;
    const fovY = Math.max(40 * DEG, 2 * Math.atan(Math.tan(minH / 2) / aspect));
    cam.fov = fovY / DEG;
    cam.aspect = aspect;
    cam.updateProjectionMatrix();
    this.rig.applyTo(cam);
    this.camPos.copy(this.rig.position);
    this.bh.render(target, cam, this.camPos);
    // Headless screenshots run WebGL on the CPU: keep frames from piling up in the GPU queue.
    if (this.ctx.engine.shotMode) this.bh.syncGPU();
  }

  /** Debug hook: merge renderer parameters, e.g. set({ doppler: false }). */
  set(p: Parameters<BlackHoleRenderer['setParams']>[0]): void {
    this.bh.setParams(p);
  }
  /** Debug hook: jump the camera. */
  view(distance: number, pitchDeg: number, yawDeg?: number): void {
    this.rig.set({ distance, pitch: pitchDeg * DEG, yaw: yawDeg !== undefined ? yawDeg * DEG : undefined });
  }

  unmount(): void {
    this.bh.dispose();
    this.sky.dispose();
    this.cubeRT.dispose();
  }
}

export default () => new Gargantua();
