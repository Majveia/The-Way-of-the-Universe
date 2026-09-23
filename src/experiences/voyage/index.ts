import * as THREE from 'three';
import type { Experience, ExperienceContext, FrameInfo } from '../../core/types';
import { OrbitRig } from '../../core/rigs/OrbitRig';
import { Sky } from '../../worlds/sky/Sky';
import { loadStarCatalog, type StarCatalog } from '../../worlds/sky/catalog';

/** Starflight (phase 1, bootstrap): the real sky from the Sun. */
class Voyage implements Experience {
  private ctx!: ExperienceContext;
  private sky!: Sky;
  private cat!: StarCatalog;
  private rig!: OrbitRig;
  private camera = new THREE.PerspectiveCamera(60, 1, 0.1, 10);
  private beta = new THREE.Vector3();

  async mount(ctx: ExperienceContext): Promise<void> {
    this.ctx = ctx;
    ctx.progress(0.2, 'Charting the stars');
    this.cat = await loadStarCatalog();
    this.sky = new Sky({ catalog: this.cat, stars: Math.round(24000 * ctx.quality.detail), milkyWay: 1, constellations: 1 });
    this.rig = new OrbitRig(ctx.input, { distance: 1, enablePan: false, damping: 0.1 });
    this.lookAtStar('Betelgeuse', 0.13);
    ctx.post.bloomStrength = 0.06;
    ctx.post.vignette = 0.2;
    ctx.signalReady();
  }

  private lookAtStar(name: string, offsetDeg = 0): void {
    const i = this.cat.find(name);
    if (i < 0) return;
    const p = new THREE.Vector3(this.cat.position[i * 3], this.cat.position[i * 3 + 1], this.cat.position[i * 3 + 2]).normalize();
    // Orbit rig looks from position toward target; we want to look along p: put the camera at −p.
    const yaw = Math.atan2(-p.x, -p.z);
    const pitch = Math.asin(-p.y) + THREE.MathUtils.degToRad(offsetDeg);
    this.rig.set({ yaw, pitch });
  }

  setView(name: string): void {
    if (name === 'orion') this.lookAtStar('Alnilam', 3);
    else this.lookAtStar(name);
  }
  setBeta(b: number): void {
    // Along the current view direction.
    const d = new THREE.Vector3(0, 0, -1).applyQuaternion(this.rig.quaternion);
    this.beta.copy(d).multiplyScalar(b);
    this.sky.setVelocity(this.beta);
  }

  update(f: FrameInfo): void {
    this.rig.update(f.dt);
  }

  render(target: THREE.WebGLRenderTarget): void {
    this.camera.aspect = target.width / target.height;
    this.camera.updateProjectionMatrix();
    this.rig.applyTo(this.camera, this.rig.target);
    this.ctx.renderer.setRenderTarget(target);
    this.sky.cssHeight = this.ctx.engine.cssHeight;
    this.sky.render(this.ctx.renderer, this.camera, this.ctx.engine.pixelRatio);
  }

  unmount(): void {
    this.sky.dispose();
  }
}

export default () => new Voyage();
