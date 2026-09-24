import * as THREE from 'three';
import type { Experience, ExperienceContext, FrameInfo } from '../../core/types';
import { OrbitRig } from '../../core/rigs/OrbitRig';
import { GalaxyLayer } from '../../worlds/galaxy/GalaxyLayer';
import { milkyWay, preset, type MorphologyId } from '../../worlds/galaxy/params';

const VIEWS: Record<string, { distance: number; yaw: number; pitch: number; target?: [number, number, number] }> = {
  default: { distance: 33000, yaw: 2.35, pitch: 0.6 },
  'face-on': { distance: 42000, yaw: 0, pitch: 1.5 },
  'edge-on': { distance: 40000, yaw: 1.2, pitch: 0.02 },
};

class MilkyWay implements Experience {
  private ctx!: ExperienceContext;
  private layer!: GalaxyLayer;
  private rig!: OrbitRig;
  private camera = new THREE.PerspectiveCamera(50, 1, 0.01, 1e7);
  private warp = 1; // Myr per second
  private frame = 0;

  async mount(ctx: ExperienceContext): Promise<void> {
    this.ctx = ctx;
    const id = (ctx.params.get('preset') as MorphologyId | null) ?? 'milkyway';
    const p = id === 'milkyway' ? milkyWay(1) : preset(id, 1);
    this.layer = new GalaxyLayer(ctx.renderer, { params: p, detail: ctx.quality.detail });
    const v = VIEWS.default;
    this.rig = new OrbitRig(ctx.input, { distance: v.distance, yaw: v.yaw, pitch: v.pitch, minDistance: 5, maxDistance: 250000, autoRotate: 0.01, idleDelay: 8 });
    ctx.post.exposure = 0.1;
    ctx.post.tonemap = (ctx.params.get('tonemap') as 'aces' | 'agx' | null) ?? 'aces';
    ctx.post.saturation = 1.12;
    ctx.post.bloomStrength = 0.06;
    ctx.post.vignette = 0.12;
    ctx.progress(0.3, 'Generating stars');
    await this.layer.ready;
    ctx.progress(1);
    ctx.signalReady();
  }

  setView(name: string): void {
    const v = VIEWS[name];
    if (!v) return;
    this.rig.set({ distance: v.distance, yaw: v.yaw, pitch: v.pitch, target: new THREE.Vector3(...(v.target ?? [0, 0, 0])) });
  }
  setTime(t: number): void {
    this.layer.time = t;
  }
  setWarp(w: number): void {
    this.warp = w;
  }
  /** Debug toggles: { stars, volume, map (0–5), exposure }. */
  debug(o: { stars?: boolean; volume?: boolean; map?: number; exposure?: number; vol?: number; mask?: number; tonemap?: 'aces' | 'agx' | 'agx-punchy' }): void {
    if (o.vol !== undefined) this.layer.debugVolume = o.vol;
    if (o.mask !== undefined) this.layer.debugMask = o.mask;
    if (o.tonemap !== undefined) this.ctx.post.tonemap = o.tonemap;
    if (o.stars !== undefined) this.layer.starsVisible = o.stars;
    if (o.volume !== undefined) this.layer.volumeVisible = o.volume;
    if (o.map !== undefined) this.layer.debugMap = o.map;
    if (o.exposure !== undefined) this.ctx.post.exposure = o.exposure;
  }
  get galaxy(): GalaxyLayer {
    return this.layer;
  }

  update(f: FrameInfo): void {
    this.rig.update(f.dt);
    this.layer.time += this.warp * f.dt;
    this.frame = f.frame;
  }

  render(target: THREE.WebGLRenderTarget): void {
    const r = this.ctx.renderer;
    this.camera.aspect = target.width / target.height;
    this.camera.updateProjectionMatrix();
    this.rig.applyTo(this.camera);
    r.setRenderTarget(target);
    this.layer.render(r, this.camera, target, { exposure: this.ctx.post.exposure, frame: this.frame });
  }

  resize(w: number, h: number): void {
    this.layer?.resize(w, h);
  }

  unmount(): void {
    this.layer.dispose();
  }
}

export default () => new MilkyWay();
