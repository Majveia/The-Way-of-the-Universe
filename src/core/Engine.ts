import * as THREE from 'three';
import { Post } from './post/Post';

export type QualityTier = 'low' | 'medium' | 'high' | 'ultra';

export interface QualityProfile {
  tier: QualityTier;
  /** Cap on devicePixelRatio. */
  maxPixelRatio: number;
  /** MSAA samples on the HDR target (0 = off). */
  msaa: number;
  /** Scale for particle counts, ray-march steps, texture sizes: ~0.35 (low) … 1.6 (ultra). */
  detail: number;
  /** Lowest dynamic render scale the engine may choose. */
  minRenderScale: number;
}

export const QUALITY: Record<QualityTier, QualityProfile> = {
  low: { tier: 'low', maxPixelRatio: 1, msaa: 0, detail: 0.35, minRenderScale: 0.5 },
  medium: { tier: 'medium', maxPixelRatio: 1.5, msaa: 0, detail: 0.7, minRenderScale: 0.5 },
  high: { tier: 'high', maxPixelRatio: 2, msaa: 4, detail: 1, minRenderScale: 0.55 },
  ultra: { tier: 'ultra', maxPixelRatio: 3, msaa: 4, detail: 1.6, minRenderScale: 0.6 },
};

export interface FrameInfo {
  /** Real seconds since the previous frame (clamped to 0.1; fixed 1/60 in shot mode). */
  dt: number;
  /** Seconds since the engine started. */
  time: number;
  /** Frame counter since the engine started. */
  frame: number;
}

export function detectQuality(params: URLSearchParams): QualityTier {
  const q = params.get('quality');
  if (q === 'low' || q === 'medium' || q === 'high' || q === 'ultra') return q;
  const touch = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
  const small = Math.min(screen.width, screen.height) < 820;
  return touch && small ? 'medium' : 'high';
}

/**
 * Owns the WebGL2 renderer, the linear-HDR scene target and the post chain.
 * Each frame: clear HDR target → onFrame (experience update + render into `hdr`) → post → canvas.
 *
 * Conventions: renderer.autoClear is FALSE. Experiences render into `engine.hdr`
 * (already cleared to black at frame start) and clear depth themselves between layers.
 */
export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  readonly post: Post;
  readonly quality: QualityProfile;
  readonly shotMode: boolean;
  readonly halfFloat: boolean;
  hdr: THREE.WebGLRenderTarget;
  /** Dynamic resolution factor applied on top of the device pixel ratio. */
  renderScale = 1;
  dynamicResolution = true;
  cssWidth = 1;
  cssHeight = 1;
  /** Effective device pixels per CSS pixel of the HDR target (dpr × renderScale). */
  pixelRatio = 1;
  /** HDR target size in pixels. */
  width = 1;
  height = 1;
  frame = 0;
  time = 0;
  fps = 60;
  paused = false;
  private dtEMA = 1 / 60;
  private lastT = 0;
  private slowTime = 0;
  private fastTime = 0;
  private dpr = 1;
  private onFrame: ((f: FrameInfo) => void) | null = null;
  /** Optional instrumentation around each whole frame (benchmark harness). */
  probe: { begin(): void; end(): void } | null = null;
  private resizeListeners = new Set<(w: number, h: number) => void>();
  private resizeObserver: ResizeObserver;

  constructor(canvas: HTMLCanvasElement, opts: { quality: QualityTier; shot: boolean }) {
    this.canvas = canvas;
    this.quality = QUALITY[opts.quality];
    this.shotMode = opts.shot;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      depth: true,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: opts.shot,
    });
    const r = this.renderer;
    r.autoClear = false;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.NoToneMapping;
    r.setClearColor(0x000000, 1);
    this.halfFloat = r.extensions.has('EXT_color_buffer_float') || r.extensions.has('EXT_color_buffer_half_float');
    this.post = new Post(r);
    this.hdr = this.makeHDR(1, 1);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
    if (this.shotMode) this.dynamicResolution = false;
  }

  private makeHDR(w: number, h: number): THREE.WebGLRenderTarget {
    const t = new THREE.WebGLRenderTarget(w, h, {
      type: this.halfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
      samples: this.quality.msaa,
    });
    t.texture.name = 'hdr';
    return t;
  }

  /** Subscribe to HDR-size changes; returns an unsubscribe function. */
  onResize(cb: (w: number, h: number) => void): () => void {
    this.resizeListeners.add(cb);
    return () => this.resizeListeners.delete(cb);
  }

  resize(): void {
    const w = Math.max(1, this.canvas.clientWidth || window.innerWidth);
    const h = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    this.cssWidth = w;
    this.cssHeight = h;
    this.dpr = Math.min(window.devicePixelRatio || 1, this.quality.maxPixelRatio);
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(w, h, false);
    this.applyRenderScale();
  }

  private applyRenderScale(): void {
    this.pixelRatio = this.dpr * this.renderScale;
    const bw = Math.max(1, Math.round(this.cssWidth * this.pixelRatio));
    const bh = Math.max(1, Math.round(this.cssHeight * this.pixelRatio));
    if (bw === this.width && bh === this.height) return;
    this.width = bw;
    this.height = bh;
    this.hdr.setSize(bw, bh);
    this.post.setSize(bw, bh);
    for (const cb of this.resizeListeners) cb(bw, bh);
  }

  /** Force a render scale (disables dynamic resolution when `lock` is true). */
  setRenderScale(scale: number, lock = false): void {
    this.renderScale = THREE.MathUtils.clamp(scale, 0.25, 1);
    if (lock) this.dynamicResolution = false;
    this.applyRenderScale();
  }

  start(onFrame: (f: FrameInfo) => void): void {
    this.onFrame = onFrame;
    this.renderer.setAnimationLoop((t) => this.tick(t));
  }

  stop(): void {
    this.renderer.setAnimationLoop(null);
  }

  private tick(tMs: number): void {
    const t = tMs / 1000;
    let dt = this.lastT ? t - this.lastT : 1 / 60;
    this.lastT = t;
    if (this.shotMode) dt = 1 / 60;
    dt = Math.min(Math.max(dt, 0), 0.1);
    if (this.paused) return;
    this.time += dt;
    this.frame++;
    this.dtEMA += (dt - this.dtEMA) * 0.05;
    this.fps = 1 / this.dtEMA;
    if (this.dynamicResolution) this.adapt(dt);

    const r = this.renderer;
    this.probe?.begin();
    r.setRenderTarget(this.hdr);
    r.setClearColor(0x000000, 1);
    r.clear(true, true, false);
    this.onFrame?.({ dt, time: this.time, frame: this.frame });
    this.post.render(this.hdr, this.time);
    this.probe?.end();
  }

  /** Dynamic resolution with hysteresis: drop quickly under 45 fps, recover slowly above 57. */
  private adapt(dt: number): void {
    if (this.frame < 30) return;
    const ema = this.dtEMA;
    if (ema > 1 / 45) {
      this.slowTime += dt;
      this.fastTime = 0;
    } else if (ema < 1 / 57) {
      this.fastTime += dt;
      this.slowTime = 0;
    } else {
      this.slowTime = 0;
      this.fastTime = 0;
    }
    if (this.slowTime > 1.2 && this.renderScale > this.quality.minRenderScale) {
      this.renderScale = Math.max(this.quality.minRenderScale, Math.round(this.renderScale * 0.86 * 20) / 20);
      this.slowTime = 0;
      this.applyRenderScale();
    } else if (this.fastTime > 4 && this.renderScale < 1) {
      this.renderScale = Math.min(1, Math.round(this.renderScale * 1.08 * 20) / 20 + 0.0001);
      this.fastTime = 0;
      this.applyRenderScale();
    }
  }

  dispose(): void {
    this.stop();
    this.resizeObserver.disconnect();
    this.post.dispose();
    this.hdr.dispose();
    this.renderer.dispose();
  }
}
