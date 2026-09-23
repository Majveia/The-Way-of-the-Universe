import * as THREE from 'three';
import type { Experience, ExperienceContext, FrameInfo } from '../core/types';
import { OrbitRig } from '../core/rigs/OrbitRig';
import { Sky } from '../worlds/sky/Sky';

/** Temporary stand-in used until a world is built: the sky, and a note. */
export function placeholder(note: string): Experience {
  let ctx!: ExperienceContext;
  let sky!: Sky;
  let rig!: OrbitRig;
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  return {
    mount(c) {
      ctx = c;
      sky = new Sky({ stars: 20000 * c.quality.detail });
      rig = new OrbitRig(c.input, { distance: 1, pitch: 0.2, autoRotate: 0.02, idleDelay: 0 });
      c.ui.hint(note, 0);
      c.signalReady();
    },
    update(f: FrameInfo) {
      rig.update(f.dt);
    },
    render(target) {
      camera.aspect = target.width / target.height;
      camera.updateProjectionMatrix();
      rig.applyTo(camera, rig.target);
      ctx.renderer.setRenderTarget(target);
      sky.render(ctx.renderer, camera, ctx.engine.pixelRatio);
    },
    unmount() {
      sky.dispose();
    },
  };
}
