import { ICONS } from './icons';
import { Panel, PanelSection } from './Panel';
import { Intro, type IntroOptions } from './Intro';
import { Palette, type Command } from './Palette';
import { Help, type Shortcut } from './Help';
import { SoundMenu, type SoundControls } from './SoundMenu';
import './overlays.css';

export type { Command, Shortcut, SoundControls, IntroOptions };

/** Diagnostics for the frame-rate/quality indicator (backtick key). */
export interface StatsInfo {
  fps: number;
  tier: string;
  scale: number;
  width: number;
  height: number;
}

export interface ExperienceMeta {
  id: string;
  title: string;
  kicker: string;
  blurb: string;
}

export interface UIHandlers {
  navigate(id: string): void;
  toggleSound(): boolean;
  soundOn(): boolean;
  /** Optional richer sound controls (volume, music layer…). Enables the sound popover. */
  sound?: SoundControls;
  /** Optional diagnostics source for the FPS/quality indicator. */
  stats?: () => StatsInfo;
}

export interface InfoCard {
  title: string;
  subtitle?: string;
  rows?: Array<[string, string]>;
  body?: string;
}

export interface Readout {
  set(value: string, unit?: string): void;
  remove(): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

/**
 * The minimal, OLED-first interface shell: wordmark + title (top-left), actions (top-right),
 * live readouts (bottom-left), transient hints (bottom-centre), controls panel (right),
 * info card, loader, menu. Chrome fades away after a few idle seconds.
 */
export class UI {
  readonly root: HTMLElement;
  readonly panel: Panel;
  /** Container for experience overlays (labels, custom widgets). Pointer-events: none by default. */
  readonly overlay: HTMLElement;
  private titleEl: HTMLElement;
  private kickerEl: HTMLElement;
  private readoutsEl: HTMLElement;
  private hintEl: HTMLElement;
  private infoEl: HTMLElement;
  private toastEl: HTMLElement;
  private loaderEl: HTMLElement;
  private loaderLabel: HTMLElement;
  private loaderBar: HTMLElement;
  private menuEl: HTMLElement;
  private errorEl: HTMLElement;
  private bottomRight: HTMLElement;
  private soundBtn: HTMLButtonElement;
  private panelBtn: HTMLButtonElement;
  private fsBtn: HTMLButtonElement;
  private hintTimer = 0;
  private toastTimer = 0;
  private hidden = false;
  private idle = false;
  private lastActivity = performance.now();
  private overUI = false;
  menuOpen = false;
  private meta: ExperienceMeta | null = null;
  private hintText = '';
  private shortcutSets = new Set<Shortcut[]>();
  private commandSets = new Set<Command[]>();
  readonly intro: Intro;
  readonly palette: Palette;
  readonly help: Help;
  readonly soundMenu: SoundMenu | null = null;
  private statsEl: HTMLElement;
  private statsOn = false;
  private statsClock = 0;
  private menuReturn: HTMLElement | null = null;

  constructor(root: HTMLElement, private experiences: ExperienceMeta[], private handlers: UIHandlers) {
    this.root = root;
    root.className = 'ui';

    // Top-left: brand + title.
    const top = el('header', 'ui-top chrome');
    const brand = el('button', 'brand');
    brand.type = 'button';
    brand.setAttribute('aria-label', 'Open the menu');
    brand.innerHTML = `<span class="brand-mark">${ICONS.mark}</span><span class="brand-name">The Way of the Universe</span>`;
    brand.addEventListener('click', () => this.toggleMenu());
    const title = el('div', 'exp-title');
    this.kickerEl = el('div', 'exp-kicker');
    this.titleEl = el('h1', 'exp-name');
    title.append(this.kickerEl, this.titleEl);
    const left = el('div', 'ui-top-left');
    left.append(brand, title);

    // Top-right: actions.
    const actions = el('nav', 'ui-actions');
    actions.setAttribute('aria-label', 'View controls');
    this.panelBtn = this.iconButton(ICONS.sliders, 'Controls (P)', () => this.panel.toggle());
    this.soundBtn = this.iconButton(ICONS.soundOff, 'Sound', () => {
      if (this.soundMenu) this.soundMenu.toggle();
      else this.syncSound(this.handlers.toggleSound());
    });
    this.fsBtn = this.iconButton(ICONS.expand, 'Full screen', () => this.toggleFullscreen());
    const hideBtn = this.iconButton(ICONS.eye, 'Hide interface (H)', () => this.setHidden(true));
    const menuBtn = this.iconButton(ICONS.menu, 'Menu (M)', () => this.toggleMenu());
    actions.append(this.panelBtn, this.soundBtn, hideBtn, this.fsBtn, menuBtn);
    top.append(left, actions);

    // Bottom.
    const bottom = el('footer', 'ui-bottom');
    this.readoutsEl = el('dl', 'readouts chrome-soft');
    this.hintEl = el('div', 'hint chrome');
    this.hintEl.setAttribute('role', 'status');
    this.bottomRight = el('div', 'ui-bottom-right chrome');
    bottom.append(this.readoutsEl, this.hintEl, this.bottomRight);

    this.overlay = el('div', 'ui-overlay');
    this.infoEl = el('div', 'info-card chrome');
    this.infoEl.hidden = true;
    this.toastEl = el('div', 'toast');
    this.toastEl.setAttribute('role', 'status');
    this.errorEl = el('div', 'error-card');
    this.errorEl.hidden = true;

    this.loaderEl = el('div', 'loader');
    this.loaderLabel = el('div', 'loader-label');
    const track = el('div', 'loader-track');
    this.loaderBar = el('div', 'loader-bar');
    track.appendChild(this.loaderBar);
    this.loaderEl.append(this.loaderLabel, track);
    this.loaderEl.hidden = true;

    this.menuEl = this.buildMenu();

    this.statsEl = el('div', 'stats');
    this.statsEl.hidden = true;
    this.statsEl.setAttribute('aria-live', 'off');

    root.append(this.overlay, top, bottom, this.infoEl, this.toastEl, this.errorEl, this.loaderEl, this.menuEl, this.statsEl);
    this.panel = new Panel(root);
    if (handlers.sound) {
      const snd = handlers.sound;
      this.soundBtn.setAttribute('aria-haspopup', 'dialog');
      this.soundMenu = new SoundMenu(root, snd);
      this.soundMenu.onToggle = (open) => {
        this.soundBtn.setAttribute('aria-expanded', String(open));
        this.soundBtn.classList.toggle('is-open', open);
      };
      snd.onChange(() => this.syncSound(snd.enabled));
      window.addEventListener('pointerdown', (e) => {
        const t = e.target as Node;
        if (this.soundMenu?.isOpen && !this.soundMenu.el.contains(t) && !this.soundBtn.contains(t)) this.soundMenu.close();
      });
      this.soundMenu.el.addEventListener('pointerenter', () => (this.overUI = true));
      this.soundMenu.el.addEventListener('pointerleave', () => (this.overUI = false));
    }
    this.palette = new Palette(root, () => this.commands());
    this.palette.onToggle = (open) => {
      this.root.classList.toggle('palette-open', open);
      this.uiSound(open ? 'ui-open' : 'ui-close');
    };
    this.palette.onMove = () => this.uiSound('ui-move');
    this.help = new Help(root);
    this.help.onToggle = (open) => this.root.classList.toggle('help-open', open);
    this.intro = new Intro(root);
    this.panel.onVisibilityChange = (open) => {
      this.panelBtn.classList.toggle('is-active', open);
      this.panelBtn.hidden = this.panel.isEmpty;
    };
    this.panelBtn.hidden = true;

    for (const e of [top, this.panel.el, this.infoEl, this.bottomRight]) {
      e.addEventListener('pointerenter', () => (this.overUI = true));
      e.addEventListener('pointerleave', () => (this.overUI = false));
    }
    window.addEventListener('pointermove', () => this.activity(), { passive: true });
    window.addEventListener('pointerdown', () => this.activity(), { passive: true });
    // Capture phase: runs before experience key handlers, so open dialogs can swallow keys.
    window.addEventListener('keydown', (e) => this.onKey(e), true);
    document.addEventListener('fullscreenchange', () => {
      this.fsBtn.innerHTML = document.fullscreenElement ? ICONS.collapse : ICONS.expand;
    });
    this.syncSound(handlers.soundOn());
  }

  private iconButton(icon: string, label: string, onClick: () => void): HTMLButtonElement {
    const b = el('button', 'icon-btn', icon);
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.title = label;
    b.addEventListener('click', onClick);
    return b;
  }

  private syncSound(on: boolean): void {
    this.soundBtn.innerHTML = on ? ICONS.soundOn : ICONS.soundOff;
    this.soundBtn.classList.toggle('is-active', on);
    this.soundBtn.setAttribute('aria-label', on ? 'Mute sound' : 'Play sound');
  }

  toggleFullscreen(): void {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => undefined);
    else document.documentElement.requestFullscreen?.().catch(() => this.toast('Full screen is not available here'));
  }

  private buildMenu(): HTMLElement {
    const m = el('div', 'menu');
    m.hidden = true;
    m.setAttribute('role', 'dialog');
    m.setAttribute('aria-label', 'Experiences');
    const inner = el('div', 'menu-inner');
    const intro = el('div', 'menu-intro');
    intro.innerHTML = `
      <div class="menu-mark">${ICONS.mark}</div>
      <h2 class="menu-title">The Way<br/>of the Universe</h2>
      <p class="menu-lede">A real-time universe built from physics: gravity, expansion, light bending around black holes, the glow of ionised gas. Choose where to begin.</p>
      <p class="menu-quote">“The cosmos is within us. We are made of star-stuff.”<span>Carl Sagan</span></p>`;
    const list = el('ol', 'menu-list');
    list.setAttribute('aria-label', 'Worlds');
    this.experiences.forEach((x, i) => {
      const li = el('li');
      const b = el('button', 'menu-item');
      b.type = 'button';
      b.dataset.id = x.id;
      b.innerHTML = `<span class="menu-key">${i + 1 <= 9 ? i + 1 : ''}</span><span class="menu-text"><span class="menu-kicker"></span><span class="menu-name"></span><span class="menu-blurb"></span></span>`;
      (b.querySelector('.menu-kicker') as HTMLElement).textContent = x.kicker;
      (b.querySelector('.menu-name') as HTMLElement).textContent = x.title;
      (b.querySelector('.menu-blurb') as HTMLElement).textContent = x.blurb;
      b.addEventListener('click', () => {
        this.closeMenu();
        this.handlers.navigate(x.id);
      });
      li.appendChild(b);
      list.appendChild(li);
    });
    const close = this.iconButton(ICONS.close, 'Close menu (Esc)', () => this.closeMenu());
    close.classList.add('menu-close');
    const mod = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl';
    const keys = el(
      'p',
      'menu-keys',
      `<span><kbd>↑</kbd><kbd>↓</kbd> choose · <kbd>↵</kbd> enter</span><span><kbd>${mod}</kbd><kbd>K</kbd> go anywhere</span><span><kbd>P</kbd> controls</span><span><kbd>H</kbd> hide interface</span><span><kbd>?</kbd> help</span>`,
    );
    inner.append(intro, list);
    m.append(close, inner, keys);
    return m;
  }

  setExperience(meta: ExperienceMeta | null): void {
    this.meta = meta;
    this.kickerEl.textContent = meta?.kicker ?? '';
    this.titleEl.textContent = meta?.title ?? '';
    for (const b of this.menuEl.querySelectorAll<HTMLButtonElement>('.menu-item')) {
      b.classList.toggle('is-current', b.dataset.id === meta?.id);
      if (b.dataset.id === meta?.id) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    }
    document.title = meta ? `${meta.title} · The Way of the Universe` : 'The Way of the Universe';
  }

  openMenu(): void {
    if (!this.menuOpen) {
      this.menuReturn = document.activeElement as HTMLElement | null;
      this.uiSound('ui-open');
    }
    this.soundMenu?.close();
    this.menuOpen = true;
    this.menuEl.hidden = false;
    this.root.classList.add('menu-open');
    const first = this.menuEl.querySelector<HTMLButtonElement>('.menu-item.is-current') ?? this.menuEl.querySelector<HTMLButtonElement>('.menu-item');
    first?.focus({ preventScroll: true });
  }
  closeMenu(): void {
    if (!this.menuOpen) return;
    this.menuOpen = false;
    this.menuEl.hidden = true;
    this.root.classList.remove('menu-open');
    this.uiSound('ui-close');
    const r = this.menuReturn;
    this.menuReturn = null;
    if (r && document.contains(r) && r !== document.body) r.focus({ preventScroll: true });
    else (document.activeElement as HTMLElement | null)?.blur?.();
  }
  toggleMenu(): void {
    if (this.menuOpen) this.closeMenu();
    else this.openMenu();
  }

  setHidden(h: boolean): void {
    this.hidden = h;
    this.root.classList.toggle('is-hidden', h);
    if (h) this.toast('Interface hidden — press H to show');
  }

  private onKey(e: KeyboardEvent): void {
    if (this.intro.active) return; // the title sequence handles its own keys
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.altKey && e.code === 'KeyK') {
      e.preventDefault();
      e.stopPropagation();
      this.togglePalette();
      return;
    }
    if (this.palette.isOpen) return; // its input handles navigation (experiences ignore input targets)
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) {
      if (e.code === 'Escape' && this.soundMenu?.isOpen) this.soundMenu.close();
      return;
    }
    if (mod || e.altKey) return;
    if (this.help.isOpen) {
      if (e.code === 'Escape' || e.key === '?' || e.code === 'KeyH') {
        e.preventDefault();
        this.help.close();
      }
      if (e.key !== 'Tab') e.stopPropagation();
      return;
    }
    if (e.code === 'Escape') {
      if (this.soundMenu?.isOpen) this.soundMenu.close();
      else if (this.menuOpen) this.closeMenu();
      else if (this.panel.open) this.panel.setOpen(false);
      else if (this.hidden) this.setHidden(false);
    } else if (e.key === '?') {
      e.preventDefault();
      this.openHelp();
    } else if (e.code === 'Backquote') this.toggleStats();
    else if (e.code === 'KeyM') this.toggleMenu();
    else if (e.code === 'KeyH') this.setHidden(!this.hidden);
    else if (e.code === 'KeyP') this.panel.toggle();
    else if (this.menuOpen) {
      if (/^Digit[1-9]$/.test(e.code)) {
        const i = Number(e.code.slice(5)) - 1;
        const x = this.experiences[i];
        if (x) {
          this.closeMenu();
          this.handlers.navigate(x.id);
        }
      } else if (e.code === 'ArrowDown' || e.code === 'ArrowRight') this.moveMenuFocus(1, e);
      else if (e.code === 'ArrowUp' || e.code === 'ArrowLeft') this.moveMenuFocus(-1, e);
      else if (e.code === 'Home') this.moveMenuFocus(-999, e);
      else if (e.code === 'End') this.moveMenuFocus(999, e);
    }
    // While the menu is up, the world behind it should not react to keys.
    if (this.menuOpen && e.key !== 'Tab') e.stopPropagation();
  }

  private moveMenuFocus(delta: number, e: KeyboardEvent): void {
    e.preventDefault();
    const items = [...this.menuEl.querySelectorAll<HTMLButtonElement>('.menu-item')];
    if (!items.length) return;
    const cur = items.indexOf(document.activeElement as HTMLButtonElement);
    let i = cur < 0 ? (delta > 0 ? 0 : items.length - 1) : cur + delta;
    i = Math.max(0, Math.min(items.length - 1, i));
    items[i].focus();
    this.uiSound('ui-move');
  }

  /** Command palette (Ctrl/Cmd + K). */
  togglePalette(open?: boolean): void {
    const o = open ?? !this.palette.isOpen;
    if (o) {
      this.help.close();
      this.soundMenu?.close();
      this.palette.open();
    } else this.palette.close();
  }

  /** Help overlay (`?`). */
  openHelp(): void {
    this.soundMenu?.close();
    const local: Shortcut[] = [];
    for (const set of this.shortcutSets) local.push(...set);
    this.help.open(this.meta?.title ?? '', this.meta?.kicker ?? '', local, this.hintText);
  }

  /** FPS / quality indicator (backtick). */
  toggleStats(on = !this.statsOn): void {
    this.statsOn = on && !!this.handlers.stats;
    this.statsEl.hidden = !this.statsOn;
    this.statsClock = 0;
  }

  /**
   * Opening title sequence over whatever is rendering (the prelude sky). Resolves true when it
   * played to the end or was skipped, false if it was already seen this session.
   */
  playIntro(o: IntroOptions = {}): Promise<boolean> {
    this.root.classList.add('intro-on');
    const snd = this.handlers.sound;
    const p = this.intro.play({ onSound: snd && !snd.enabled ? () => void snd.enable() : undefined, ...o });
    return p.then((played) => {
      this.root.classList.remove('intro-on');
      return played;
    });
  }

  /** Register shortcuts for the help overlay; returns an unregister function. */
  registerShortcuts(list: Shortcut[]): () => void {
    const copy = list.slice();
    this.shortcutSets.add(copy);
    return () => this.shortcutSets.delete(copy);
  }

  /** Register palette commands (destinations, actions); returns an unregister function. */
  registerCommands(list: Command[]): () => void {
    const copy = list.slice();
    this.commandSets.add(copy);
    return () => this.commandSets.delete(copy);
  }

  private uiSound(name: string): void {
    const s = this.handlers.sound;
    if (s?.enabled && s.options.ui) s.event(name);
  }

  /** Everything the palette can do right now. */
  private commands(): Command[] {
    const out: Command[] = [];
    for (const set of this.commandSets) for (const c of set) out.push({ group: 'Destinations', ...c });
    // Controls already on the panel (preset chips, buttons, short selects) — free destinations.
    for (const sec of this.panel.el.querySelectorAll<HTMLElement>('.pnl-section')) {
      const title = sec.querySelector('.pnl-title')?.textContent ?? '';
      for (const b of sec.querySelectorAll<HTMLButtonElement>('.pnl-buttons .chip, .pnl-button .btn')) {
        const text = b.textContent?.trim();
        if (!text || b.disabled) continue;
        const m = /^(\d)\s+(.+)$/.exec(text); // chips often carry their key: "2 Edge-on"
        const label = m ? m[2] : text;
        out.push({ label, group: 'In this world', hint: [title, m?.[1]].filter(Boolean).join(' · '), keywords: title, run: () => b.click() });
      }
      for (const row of sec.querySelectorAll<HTMLElement>('.pnl-select')) {
        const sel = row.querySelector('select');
        const lab = row.querySelector('label')?.textContent ?? '';
        if (!sel || sel.disabled || sel.options.length > 16) continue;
        for (const opt of sel.options) {
          out.push({
            label: opt.text,
            group: 'In this world',
            hint: lab,
            keywords: `${lab} ${title}`,
            run: () => {
              sel.value = opt.value;
              sel.dispatchEvent(new Event('change', { bubbles: true }));
            },
          });
        }
      }
    }
    this.experiences.forEach((x, i) =>
      out.push({
        label: x.title,
        group: 'Worlds',
        hint: x.id === this.meta?.id ? 'You are here' : i < 9 ? `${x.kicker} · ${i + 1}` : x.kicker,
        keywords: `${x.kicker} ${x.blurb}`,
        run: () => this.handlers.navigate(x.id),
      }),
    );
    const snd = this.handlers.sound;
    if (snd) {
      out.push({ label: snd.enabled ? 'Turn sound off' : 'Turn sound on', group: 'Sound', keywords: 'audio mute music volume', run: () => (snd.enabled ? snd.disable() : void snd.enable()) });
      out.push({
        label: snd.options.music ? 'Stop the space jazz' : 'Play some space jazz',
        group: 'Sound',
        keywords: 'music lounge piano bass jazz',
        run: () => {
          snd.setOption('music', !snd.options.music);
          if (!snd.enabled) void snd.enable();
        },
      });
    } else out.push({ label: 'Toggle sound', group: 'Sound', run: () => this.syncSound(this.handlers.toggleSound()) });
    if (!this.panel.isEmpty) out.push({ label: this.panel.open ? 'Hide controls' : 'Show controls', group: 'View', hint: 'P', run: () => this.panel.toggle() });
    out.push({ label: 'Hide the interface', group: 'View', hint: 'H', keywords: 'clean screenshot', run: () => this.setHidden(true) });
    out.push({ label: 'Full screen', group: 'View', keywords: 'fullscreen', run: () => this.toggleFullscreen() });
    out.push({ label: 'Keyboard shortcuts', group: 'View', hint: '?', keywords: 'help keys controls', run: () => this.openHelp() });
    if (this.handlers.stats) out.push({ label: 'Frame rate and quality', group: 'View', hint: '`', keywords: 'fps diagnostics performance', run: () => this.toggleStats() });
    out.push({ label: 'Worlds menu', group: 'View', hint: 'M', run: () => this.openMenu() });
    out.push({ label: 'Replay the title sequence', group: 'View', keywords: 'intro opening', run: () => void this.playIntro({ force: true }) });
    return out;
  }

  private activity(): void {
    this.lastActivity = performance.now();
    if (this.idle) {
      this.idle = false;
      this.root.classList.remove('is-idle');
    }
  }

  /** Disable idle fading (screenshots). */
  neverIdle = false;

  /** Call once per frame. */
  update(now = performance.now()): void {
    const quiet =
      !this.neverIdle &&
      now - this.lastActivity > 4200 &&
      !this.overUI &&
      !this.panel.open &&
      !this.menuOpen &&
      !this.palette.isOpen &&
      !this.help.isOpen &&
      !this.soundMenu?.isOpen;
    if (quiet !== this.idle) {
      this.idle = quiet;
      this.root.classList.toggle('is-idle', quiet);
    }
    if (this.statsOn && this.handlers.stats && now - this.statsClock > 250) {
      this.statsClock = now;
      const st = this.handlers.stats();
      this.statsEl.textContent = `${st.fps.toFixed(0).padStart(3, '\u2007')} fps · ${st.tier} · ×${st.scale.toFixed(2)} · ${st.width}×${st.height}`;
      this.statsEl.classList.toggle('is-slow', st.fps < 45);
    }
  }

  showLoader(label = 'Loading'): void {
    this.loaderLabel.textContent = label;
    this.loaderBar.style.transform = 'scaleX(0)';
    this.loaderEl.hidden = false;
  }
  progress(fraction: number, label?: string): void {
    if (label) this.loaderLabel.textContent = label;
    this.loaderBar.style.transform = `scaleX(${Math.min(1, Math.max(0, fraction))})`;
  }
  hideLoader(): void {
    this.loaderEl.hidden = true;
  }

  error(title: string, detail: string): void {
    this.errorEl.hidden = false;
    this.errorEl.innerHTML = '';
    const h = el('h2');
    h.textContent = title;
    const p = el('p');
    p.textContent = detail;
    const b = el('button', 'btn', 'Open the menu');
    b.type = 'button';
    b.addEventListener('click', () => {
      this.errorEl.hidden = true;
      this.openMenu();
    });
    this.errorEl.append(h, p, b);
  }
  clearError(): void {
    this.errorEl.hidden = true;
  }

  toast(text: string, ms = 2600): void {
    this.toastEl.textContent = text;
    this.toastEl.classList.add('is-visible');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('is-visible'), ms);
  }

  hint(text: string, ms = 7000): void {
    this.hintText = text;
    this.hintEl.textContent = text;
    this.hintEl.classList.add('is-visible');
    clearTimeout(this.hintTimer);
    if (ms > 0) this.hintTimer = window.setTimeout(() => this.hintEl.classList.remove('is-visible'), ms);
  }
  clearHint(): void {
    this.hintEl.classList.remove('is-visible');
  }
  /** Forget the last hint (help falls back to generic controls). */
  clearHintText(): void {
    this.hintText = '';
  }

  info(card: InfoCard | null): void {
    if (!card) {
      this.infoEl.hidden = true;
      return;
    }
    this.infoEl.hidden = false;
    this.infoEl.innerHTML = '';
    const close = this.iconButton(ICONS.close, 'Close', () => (this.infoEl.hidden = true));
    close.classList.add('info-close');
    const h = el('h2', 'info-title');
    h.textContent = card.title;
    this.infoEl.append(close, h);
    if (card.subtitle) {
      const s = el('div', 'info-sub');
      s.textContent = card.subtitle;
      this.infoEl.appendChild(s);
    }
    if (card.rows?.length) {
      const dl = el('dl', 'info-rows');
      for (const [k, v] of card.rows) {
        const row = el('div');
        const dt = el('dt');
        dt.textContent = k;
        const dd = el('dd');
        dd.textContent = v;
        row.append(dt, dd);
        dl.appendChild(row);
      }
      this.infoEl.appendChild(dl);
    }
    if (card.body) {
      const p = el('p', 'info-body');
      p.textContent = card.body;
      this.infoEl.appendChild(p);
    }
  }

  readout(label: string, unit = ''): Readout {
    const row = el('div', 'readout');
    const dt = el('dt');
    dt.textContent = label;
    const dd = el('dd');
    const v = el('span', 'readout-value');
    const u = el('span', 'readout-unit');
    u.textContent = unit;
    dd.append(v, u);
    row.append(dt, dd);
    this.readoutsEl.appendChild(row);
    let lv = '';
    let lu = unit;
    return {
      set: (value: string, unit2?: string) => {
        if (value !== lv) v.textContent = lv = value;
        if (unit2 !== undefined && unit2 !== lu) u.textContent = lu = unit2;
      },
      remove: () => row.remove(),
    };
  }

  /** Slot at the bottom-right for experience widgets (timeline, scale bar…). */
  get corner(): HTMLElement {
    return this.bottomRight;
  }

  scope(): UIScope {
    return new UIScope(this);
  }
}

/** Everything an experience adds through this scope is removed on dispose(). */
export class UIScope {
  private readouts: Readout[] = [];
  private sections: PanelSection[] = [];
  private nodes: HTMLElement[] = [];
  private offs: Array<() => void> = [];
  readonly overlay: HTMLElement;

  constructor(readonly ui: UI) {
    this.overlay = el('div', 'scope-overlay');
    ui.overlay.appendChild(this.overlay);
    this.nodes.push(this.overlay);
  }
  readout(label: string, unit = ''): Readout {
    const r = this.ui.readout(label, unit);
    this.readouts.push(r);
    return r;
  }
  section(title: string | null = null): PanelSection {
    const s = this.ui.panel.section(title);
    this.sections.push(s);
    return s;
  }
  /** Mount an element in the bottom-right corner slot. */
  corner(node: HTMLElement): HTMLElement {
    this.ui.corner.appendChild(node);
    this.nodes.push(node);
    return node;
  }
  hint(text: string, ms?: number): void {
    this.ui.hint(text, ms);
  }
  toast(text: string, ms?: number): void {
    this.ui.toast(text, ms);
  }
  info(card: InfoCard | null): void {
    this.ui.info(card);
  }
  openPanel(open = true): void {
    this.ui.panel.setOpen(open);
  }
  /** List this world's controls in the help overlay (`?`). Removed on unmount. */
  shortcuts(list: Shortcut[]): () => void {
    const off = this.ui.registerShortcuts(list);
    this.offs.push(off);
    return off;
  }
  /**
   * Add places to the command palette (Ctrl/Cmd + K), e.g. { label: 'Saturn', run: () => flyTo('saturn') }.
   * Grouped under "Destinations" unless `group` is given. Removed on unmount.
   */
  destinations(list: Command[]): () => void {
    const off = this.ui.registerCommands(list);
    this.offs.push(off);
    return off;
  }
  /** Alias of destinations() for actions ("Replay the merger", "Random seed"…). */
  commands(list: Command[]): () => void {
    return this.destinations(list.map((c) => ({ group: 'Actions', ...c })));
  }
  dispose(): void {
    for (const off of this.offs) off();
    this.offs = [];
    for (const r of this.readouts) r.remove();
    for (const s of this.sections) this.ui.panel.remove(s);
    for (const n of this.nodes) n.remove();
    this.readouts = [];
    this.sections = [];
    this.nodes = [];
    this.ui.info(null);
    this.ui.clearHint();
    this.ui.clearHintText();
  }
}
