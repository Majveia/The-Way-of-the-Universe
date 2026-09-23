import type * as THREE from 'three';
import type { Engine, FrameInfo, QualityProfile } from './Engine';
import type { InputScope } from './Input';
import type { UIScope } from '../ui/UI';
import type { PostSettings } from './post/Post';
import type { AudioBus } from '../audio/AudioBus';

export type { FrameInfo };

/** Everything an experience may touch. Scoped handles are cleaned up on unmount. */
export interface ExperienceContext {
  engine: Engine;
  renderer: THREE.WebGLRenderer;
  canvas: HTMLCanvasElement;
  /** Input subscriptions made here are removed automatically on unmount. */
  input: InputScope;
  /** Readouts, panel sections, hints, overlays made here are removed on unmount. */
  ui: UIScope;
  audio: AudioBus;
  quality: QualityProfile;
  /** URL query parameters (dev/testing only; not available inside the hosted artifact). */
  params: URLSearchParams;
  /** Mutable per-experience look; reset to defaults before each mount. */
  post: PostSettings;
  /** Report loading progress (0..1) while mount() is running. */
  progress(fraction: number, label?: string): void;
  /** Call once the first representative frame is ready (screenshots wait for it). */
  signalReady(): void;
}

/**
 * An experience is a self-contained interactive scene (a "world").
 * Lifecycle: mount → (update → render)* → unmount.
 */
export interface Experience {
  mount(ctx: ExperienceContext): void | Promise<void>;
  /** Advance simulation; called once per frame before render. */
  update(f: FrameInfo): void;
  /** Draw linear HDR radiance into `target` (already bound-able, cleared to black). */
  render(target: THREE.WebGLRenderTarget): void;
  /** HDR target resized (pixels). */
  resize?(width: number, height: number): void;
  /** Free every GPU/DOM resource. */
  unmount(): void;
}

export interface ExperienceModule {
  default: () => Experience;
}

export interface ExperienceDef {
  id: string;
  title: string;
  kicker: string;
  blurb: string;
  load: () => Promise<ExperienceModule>;
  /** Hide from the menu (e.g. the prelude). */
  hidden?: boolean;
}
