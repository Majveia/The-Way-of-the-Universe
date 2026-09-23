import * as THREE from 'three';
import type { Experience, ExperienceContext, FrameInfo } from '../../core/types';
import { OrbitRig } from '../../core/rigs/OrbitRig';
import { Sky } from '../../worlds/sky/Sky';
import { NebulaVolume } from '../../worlds/nebula/NebulaVolume';
import type { NebulaVariant } from '../../worlds/nebula/types';
import type { Palette } from '../../physics/nebulae';

class Nebulae implements Experience {
  private ctx!: ExperienceContext;
  private sky!: Sky;
  private rig!: OrbitRig;
  private camera = new THREE.PerspectiveCamera(50, 1, 0.005, 5000);
  private volume: NebulaVolume | null = null;
  private variant: NebulaVariant = 'pillars';
  private seed = 0;

  async mount(ctx: ExperienceContext): Promise<void> {
    this.ctx = ctx;
    ctx.post.tonemap = 'agx';
    ctx.post.bloomStrength = 0.06;
    ctx.post.bloomRadius = 0.75;
    ctx.post.vignette = 0.22;
    ctx.post.exposure = 1;
    this.sky = new Sky({ stars: Math.round(9000 * ctx.quality.detail), milkyWay: 0.3, brightness: 0.55 });
    const v = ctx.params.get('nebula') as NebulaVariant | null;
    if (v) this.variant = v;
    this.volume = new NebulaVolume({ variant: this.variant, seed: this.seed, detail: ctx.quality.detail });
    const view = this.volume.preset.views.default;
    this.rig = new OrbitRig(ctx.input, {
      distance: view.distance,
      yaw: view.yaw,
      pitch: view.pitch,
      target: new THREE.Vector3(...(view.target ?? [0, 0, 0])),
      minDistance: 0.2,
      maxDistance: 150,
      autoRotate: 0.012,
      idleDelay: 10,
    });
    ctx.audio.setMood('nebulae', { intensity: 0.4 });
    await this.volume.bake(ctx.renderer, (f) => ctx.progress(f, 'Ionizing the gas'));
    ctx.signalReady();
  }

  update(f: FrameInfo): void {
    this.rig.update(f.dt);
  }

  render(target: THREE.WebGLRenderTarget): void {
    const r = this.ctx.renderer;
    this.camera.aspect = target.width / target.height;
    this.camera.updateProjectionMatrix();
    this.rig.applyTo(this.camera);
    r.setRenderTarget(target);
    this.sky.render(r, this.camera, this.ctx.engine.pixelRatio);
    r.clearDepth();
    this.volume?.render(r, this.camera, target);
  }

  // ——— debug hooks (scripts/shot.mjs --eval) ———
  setView(name: string): void {
    const v = this.volume?.preset.views[name];
    if (!v) return;
    this.rig.set({ distance: v.distance, yaw: v.yaw, pitch: v.pitch, target: new THREE.Vector3(...(v.target ?? [0, 0, 0])) });
  }
  setPalette(p: Palette): void {
    if (!this.volume) return;
    this.volume.palette = p;
    this.volume.applyParams();
  }

  unmount(): void {
    this.volume?.dispose();
    this.volume = null;
    this.sky.dispose();
  }
}

export default () => new Nebulae();
