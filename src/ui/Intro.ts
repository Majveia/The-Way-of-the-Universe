/**
 * Opening title sequence (first load, no hash): black → the ringed-planet mark draws itself
 * over the prelude sky → "THE WAY OF THE UNIVERSE" → a single line → the menu.
 * Skippable with any click or key, shown once per session, reduced-motion aware.
 * Built on the Web Animations API so any frame can be frozen for screenshots:
 *   window.__universe.app.ui.playIntro({ at: 3500, paused: true })
 */

export interface IntroOptions {
  /** Start at this time (ms) into the sequence. */
  at?: number;
  /** Freeze at `at` (debug / screenshots). */
  paused?: boolean;
  /** Ignore the once-per-session guard. */
  force?: boolean;
  /** Offer "Enter with sound" (called on click). */
  onSound?: () => void;
}

const SESSION_KEY = 'twu.intro.seen';
export const INTRO_LINE = '13.8 billion years ago, the universe began to cool.';
/** Total length of the unskipped sequence (ms). */
export const INTRO_DURATION = 10400;

export function introSeen(): boolean {
  try {
    return window.sessionStorage?.getItem(SESSION_KEY) === '1';
  } catch {
    return false;
  }
}
function markSeen(): void {
  try {
    window.sessionStorage?.setItem(SESSION_KEY, '1');
  } catch {
    /* private mode: it may show again, which is harmless */
  }
}

/** The large mark: a crescent-lit planet whose ring passes behind and in front of it. */
export const INTRO_MARK = `
<svg class="intro-mark" viewBox="0 0 160 160" width="132" height="132" aria-hidden="true">
  <defs>
    <radialGradient id="twu-lit" cx="0.3" cy="0.26" r="0.95">
      <stop offset="0" stop-color="#fff0de"/>
      <stop offset="0.16" stop-color="#ffc690"/>
      <stop offset="0.4" stop-color="#8a5530"/>
      <stop offset="0.6" stop-color="#1c0f06"/>
      <stop offset="0.78" stop-color="#000"/>
    </radialGradient>
    <clipPath id="twu-disc"><circle cx="80" cy="80" r="26"/></clipPath>
    <clipPath id="twu-back"><rect x="0" y="0" width="160" height="80"/></clipPath>
    <clipPath id="twu-front"><rect x="0" y="80" width="160" height="80"/></clipPath>
  </defs>
  <g transform="rotate(-22 80 80)">
    <ellipse class="intro-ring" clip-path="url(#twu-back)" cx="80" cy="80" rx="72" ry="20" pathLength="1" fill="none" stroke="#ffc690" stroke-width="0.9" stroke-opacity="0.55"/>
    <g class="intro-planet">
      <circle cx="80" cy="80" r="26" fill="url(#twu-lit)"/>
      <ellipse cx="81.5" cy="85" rx="72" ry="20" fill="none" stroke="#000" stroke-width="3.2" stroke-opacity="0.7" clip-path="url(#twu-disc)"/>
    </g>
    <ellipse class="intro-ring" clip-path="url(#twu-front)" cx="80" cy="80" rx="72" ry="20" pathLength="1" fill="none" stroke="#000" stroke-width="5"/>
    <ellipse class="intro-ring" clip-path="url(#twu-front)" cx="80" cy="80" rx="72" ry="20" pathLength="1" fill="none" stroke="#ffc690" stroke-width="1.1"/>
  </g>
</svg>`;

export class Intro {
  private el: HTMLElement | null = null;
  private anims: Animation[] = [];
  private resolve: (() => void) | null = null;
  private exiting = false;
  private cleanup: Array<() => void> = [];

  constructor(private parent: HTMLElement) {}

  get active(): boolean {
    return this.el !== null;
  }

  /** Play the sequence. Resolves when it has finished or been skipped (false if not shown). */
  play(o: IntroOptions = {}): Promise<boolean> {
    if (this.el) this.remove();
    if (!o.force && introSeen()) return Promise.resolve(false);
    markSeen();
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const el = document.createElement('div');
    el.className = 'intro';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'The Way of the Universe — title sequence. Press any key to continue.');
    el.innerHTML = `
      <div class="intro-veil"></div>
      <div class="intro-center">
        ${INTRO_MARK}
        <h1 class="intro-title">The Way of the Universe</h1>
        <p class="intro-line"></p>
      </div>
      <div class="intro-foot">
        <span class="intro-skip">Click or press any key</span>
      </div>`;
    (el.querySelector('.intro-line') as HTMLElement).textContent = INTRO_LINE;
    const foot = el.querySelector('.intro-foot') as HTMLElement;
    if (o.onSound) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'intro-sound';
      b.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10v4h3l5 4V6L7 10H4z"/><path d="M16 9.5a3.5 3.5 0 0 1 0 5M18.5 7a7 7 0 0 1 0 10"/></svg><span>Enter with sound</span>`;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        o.onSound?.();
        this.skip();
      });
      foot.prepend(b);
    }
    this.parent.appendChild(el);
    this.el = el;
    this.exiting = false;

    const q = <T extends Element>(s: string) => el.querySelector(s) as T;
    const E = 'cubic-bezier(0.22, 0.61, 0.36, 1)';
    const add = (target: Element, kf: Keyframe[], delay: number, duration: number, easing = E) => {
      const a = target.animate(kf, { delay, duration, easing, fill: 'both' });
      this.anims.push(a);
    };
    if (reduced) {
      add(q('.intro-veil'), [{ opacity: 1 }, { opacity: 0 }], 400, 1600, 'linear');
      add(q('.intro-center'), [{ opacity: 0 }, { opacity: 1 }], 300, 900, 'linear');
      add(q('.intro-line'), [{ opacity: 0 }, { opacity: 1 }], 1400, 800, 'linear');
      add(foot, [{ opacity: 0 }, { opacity: 1 }], 1400, 800, 'linear');
      for (const r of el.querySelectorAll('.intro-ring')) add(r, [{ strokeDashoffset: 0 }, { strokeDashoffset: 0 }], 0, 1);
    } else {
      // Veil: hold black, then let the stars through.
      add(q('.intro-veil'), [{ opacity: 1 }, { opacity: 1, offset: 0.2 }, { opacity: 0 }], 0, 4600);
      add(q('.intro-planet'), [{ opacity: 0, transform: 'scale(0.9)' }, { opacity: 1, transform: 'scale(1)' }], 700, 2200);
      for (const r of el.querySelectorAll('.intro-ring')) add(r, [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], 1100, 2600, 'cubic-bezier(0.45, 0, 0.2, 1)');
      add(q('.intro-mark'), [{ transform: 'translateY(8px)' }, { transform: 'translateY(0)' }], 700, 4200);
      add(q('.intro-title'), [
        { opacity: 0, letterSpacing: '0.72em', filter: 'blur(6px)' },
        { opacity: 1, letterSpacing: '0.42em', filter: 'blur(0px)' },
      ], 2400, 2600);
      add(q('.intro-line'), [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'translateY(0)' }], 5000, 1800);
      add(foot, [{ opacity: 0 }, { opacity: 1 }], 3200, 1600);
    }
    const total = reduced ? 5200 : INTRO_DURATION - 1400;
    const at = Math.max(0, o.at ?? 0);
    for (const a of this.anims) a.currentTime = at;
    if (o.paused) for (const a of this.anims) a.pause();

    return new Promise<boolean>((resolve) => {
      this.resolve = () => resolve(true);
      if (o.paused) return; // frozen for inspection; dismissed only by input
      const timer = window.setTimeout(() => this.skip(reduced ? 500 : 1400), Math.max(0, total - at));
      this.cleanup.push(() => clearTimeout(timer));
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Tab') return; // let focus reach the sound button
        if ((e.key === 'Enter' || e.key === ' ') && document.activeElement?.classList.contains('intro-sound')) return;
        e.preventDefault();
        e.stopPropagation();
        this.skip();
      };
      const onDown = (e: PointerEvent) => {
        if ((e.target as Element | null)?.closest?.('.intro-sound')) return;
        this.skip();
      };
      window.addEventListener('keydown', onKey, true);
      el.addEventListener('pointerdown', onDown);
      this.cleanup.push(() => window.removeEventListener('keydown', onKey, true));
    });
  }

  /** Fade out quickly and resolve. */
  skip(ms = 650): void {
    const el = this.el;
    if (!el || this.exiting) return;
    this.exiting = true;
    for (const f of this.cleanup) f();
    this.cleanup = [];
    el.style.pointerEvents = 'none';
    const a = el.animate([{ opacity: getComputedStyle(el).opacity }, { opacity: 0 }], { duration: ms, easing: 'ease-in-out', fill: 'forwards' });
    const done = () => {
      this.remove();
    };
    a.onfinish = done;
    // guard against throttled timers (background tabs, headless)
    window.setTimeout(done, ms + 200);
  }

  private remove(): void {
    for (const f of this.cleanup) f();
    this.cleanup = [];
    for (const a of this.anims) a.cancel();
    this.anims = [];
    this.el?.remove();
    this.el = null;
    const r = this.resolve;
    this.resolve = null;
    r?.();
  }
}
