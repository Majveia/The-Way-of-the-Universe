import * as THREE from 'three';
import type { Experience, ExperienceContext, FrameInfo } from '../../core/types';
import { OrbitRig } from '../../core/rigs/OrbitRig';
import { Sky } from '../../worlds/sky/Sky';

/** The opening: the night sky drifting, before a world is chosen. */
class Prelude implements Experience {
  private ctx!: ExperienceContext;
  private sky!: Sky;
  private rig!: OrbitRig;
  private camera = new THREE.PerspectiveCamera(55, 1, 0.1, 10);

  mount(ctx: ExperienceContext): void {
    this.ctx = ctx;
    this.sky = new Sky({ stars: Math.round(26000 * ctx.quality.detail), milkyWay: 1.2 });
    this.rig = new OrbitRig(ctx.input, { distance: 1, yaw: 2.2, pitch: -0.05, autoRotate: 0.012, idleDelay: 0, enablePan: false });
    ctx.post.bloomStrength = 0.06;
    ctx.post.vignette = 0.25;
    ctx.audio.setMood('prelude', { intensity: 0.2 });
    ctx.signalReady();
  }

  update(f: FrameInfo): void {
    this.rig.update(f.dt);
  }

  render(target: THREE.WebGLRenderTarget): void {
    this.camera.aspect = target.width / target.height;
    this.camera.updateProjectionMatrix();
    this.rig.applyTo(this.camera, this.rig.target);
    this.ctx.renderer.setRenderTarget(target);
    this.sky.render(this.ctx.renderer, this.camera, this.ctx.engine.pixelRatio);
  }

  unmount(): void {
    this.sky.dispose();
  }
}

export default () => new Prelude();
