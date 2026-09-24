import { Engine, detectQuality, type FrameInfo } from '../core/Engine';
import { Input, type InputScope } from '../core/Input';
import { defaultPostSettings } from '../core/post/Post';
import type { Experience, ExperienceContext, ExperienceDef } from '../core/types';
import { AudioBus } from '../audio/AudioBus';
import { UI, type UIScope } from '../ui/UI';
import { DEFAULT_EXPERIENCE, EXPERIENCES } from '../experiences';

interface Mounted {
  def: ExperienceDef;
  exp: Experience;
  input: InputScope;
  ui: UIScope;
  offResize: () => void;
}

interface DebugHandle {
  frames: number;
  framesSinceReady: number;
  ready: boolean;
  fps: number;
  experienceId: string | null;
  experience: Experience | null;
  errors: string[];
  app: App;
}

declare global {
  interface Window {
    __universe?: DebugHandle;
  }
}

/** Boots the engine, routes between experiences (location.hash) and runs the frame loop. */
export class App {
  readonly engine: Engine;
  readonly input: Input;
  readonly ui: UI;
  readonly audio = new AudioBus();
  readonly params = new URLSearchParams(location.search);
  private current: Mounted | null = null;
  private nav = 0;
  private fade: { from: number; to: number; t: number; dur: number; done: () => void } | null = null;
  private debug: DebugHandle;

  constructor(canvas: HTMLCanvasElement, uiRoot: HTMLElement) {
    const shot = this.params.has('shot');
    this.engine = new Engine(canvas, { quality: detectQuality(this.params), shot });
    this.input = new Input(canvas);
    this.audio.setEngineFactory(() => import('../audio/engine').then((m) => m.createSoundEngine()));
    const visible = EXPERIENCES.filter((e) => !e.hidden);
    this.ui = new UI(uiRoot, visible, {
      navigate: (id) => this.navigate(id),
      toggleSound: () => this.audio.toggle(),
      soundOn: () => this.audio.enabled,
      sound: this.audio,
      stats: () => ({ fps: this.engine.fps, tier: this.engine.quality.tier, scale: this.engine.renderScale, width: this.engine.width, height: this.engine.height }),
    });
    if (this.params.has('noui')) uiRoot.style.display = 'none';
    if (shot) this.ui.neverIdle = true;
    this.debug = { frames: 0, framesSinceReady: 0, ready: false, fps: 0, experienceId: null, experience: null, errors: [], app: this };
    window.__universe = this.debug;
    window.addEventListener('error', (e) => this.debug.errors.push(String(e.message)));
    window.addEventListener('unhandledrejection', (e) => this.debug.errors.push(String(e.reason?.message ?? e.reason)));
    window.addEventListener('hashchange', () => void this.go(this.hashId()));
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.ui.error('The graphics context was lost', 'Your GPU reset the page’s WebGL context. Reload to continue exploring.');
    });
  }

  private hashId(): string {
    const h = location.hash.replace(/^#/, '');
    return EXPERIENCES.some((e) => e.id === h) ? h : DEFAULT_EXPERIENCE;
  }

  navigate(id: string): void {
    if (location.hash.replace(/^#/, '') === id) void this.go(id);
    else location.hash = id;
  }

  start(): void {
    this.engine.start((f) => this.frame(f));
    const first = this.hashId();
    // First load with no hash: the title sequence plays over the prelude sky, then the menu.
    const intro = !location.hash.replace(/^#/, '') && !this.engine.shotMode ? this.ui.playIntro() : Promise.resolve(false);
    void Promise.all([this.go(first), intro]).then(([, played]) => {
      if (first === DEFAULT_EXPERIENCE && !this.engine.shotMode && this.debug.experienceId === DEFAULT_EXPERIENCE) setTimeout(() => this.ui.openMenu(), played ? 200 : 1600);
    });
  }

  private fadeTo(to: number, dur: number): Promise<void> {
    return new Promise((resolve) => {
      const from = this.engine.post.settings.fade;
      if (dur <= 0 || Math.abs(from - to) < 1e-3) {
        this.engine.post.settings.fade = to;
        resolve();
        return;
      }
      this.fade?.done();
      this.fade = { from, to, t: 0, dur, done: resolve };
    });
  }

  async go(id: string): Promise<void> {
    const def = EXPERIENCES.find((e) => e.id === id) ?? EXPERIENCES.find((e) => e.id === DEFAULT_EXPERIENCE)!;
    const token = ++this.nav;
    if (this.current) await this.fadeTo(0, this.engine.shotMode ? 0 : 0.5);
    if (token !== this.nav) return;
    this.unmount();
    this.ui.clearError();
    this.ui.setExperience(def.hidden ? null : def);
    this.ui.showLoader(def.title);
    this.debug.ready = false;
    this.debug.framesSinceReady = 0;
    this.debug.experienceId = def.id;
    const post = defaultPostSettings();
    post.fade = 0;
    this.engine.post.settings = post;
    this.engine.dynamicResolution = !this.engine.shotMode;
    this.engine.setRenderScale(1);
    try {
      const mod = await def.load();
      if (token !== this.nav) return;
      const exp = mod.default();
      const input = this.input.scope();
      const ui = this.ui.scope();
      const ctx: ExperienceContext = {
        engine: this.engine,
        renderer: this.engine.renderer,
        canvas: this.engine.canvas,
        input,
        ui,
        audio: this.audio,
        quality: this.engine.quality,
        params: this.params,
        post,
        progress: (f, label) => this.ui.progress(f, label),
        signalReady: () => {
          if (token === this.nav) this.debug.ready = true;
        },
      };
      await exp.mount(ctx);
      if (token !== this.nav) {
        exp.unmount();
        input.dispose();
        ui.dispose();
        return;
      }
      const offResize = this.engine.onResize((w, h) => exp.resize?.(w, h));
      this.current = { def, exp, input, ui, offResize };
      this.debug.experience = exp;
      exp.resize?.(this.engine.width, this.engine.height);
      this.ui.hideLoader();
      void this.fadeTo(1, this.engine.shotMode ? 0 : 1.1);
    } catch (err) {
      const msg = err instanceof Error ? `${err.message}` : String(err);
      console.error(err);
      this.debug.errors.push(msg);
      this.ui.hideLoader();
      this.ui.error(`${def.title} could not start`, msg);
      this.engine.post.settings.fade = 1;
    }
  }

  private unmount(): void {
    const c = this.current;
    if (!c) return;
    this.current = null;
    this.debug.experience = null;
    try {
      c.exp.unmount();
    } catch (e) {
      console.error(e);
    }
    c.offResize();
    c.input.dispose();
    c.ui.dispose();
  }

  private frame(f: FrameInfo): void {
    if (this.fade) {
      const a = this.fade;
      a.t += f.dt;
      const k = Math.min(1, a.t / a.dur);
      const e = k * k * (3 - 2 * k);
      this.engine.post.settings.fade = a.from + (a.to - a.from) * e;
      if (k >= 1) {
        this.fade = null;
        a.done();
      }
    }
    const c = this.current;
    if (c) {
      try {
        c.exp.update(f);
        c.exp.render(this.engine.hdr);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(err);
        this.debug.errors.push(msg);
        this.unmount();
        this.ui.error(`${c.def.title} stopped`, msg);
      }
    }
    this.ui.update();
    this.audio.update(f.dt);
    this.debug.frames++;
    if (this.debug.ready) this.debug.framesSinceReady++;
    this.debug.fps = this.engine.fps;
  }
}
