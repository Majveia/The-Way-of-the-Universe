import { ICONS } from './icons';
import { Panel, PanelSection } from './Panel';

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
    this.soundBtn = this.iconButton(ICONS.soundOff, 'Sound', () => this.syncSound(this.handlers.toggleSound()));
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

    root.append(this.overlay, top, bottom, this.infoEl, this.toastEl, this.errorEl, this.loaderEl, this.menuEl);
    this.panel = new Panel(root);
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
    window.addEventListener('keydown', (e) => this.onKey(e));
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

  private toggleFullscreen(): void {
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
    const keys = el('p', 'menu-keys', 'Drag to look · Scroll to zoom · <kbd>P</kbd> controls · <kbd>H</kbd> hide interface · <kbd>M</kbd> menu');
    inner.append(intro, list);
    m.append(close, inner, keys);
    return m;
  }

  setExperience(meta: ExperienceMeta | null): void {
    this.kickerEl.textContent = meta?.kicker ?? '';
    this.titleEl.textContent = meta?.title ?? '';
    for (const b of this.menuEl.querySelectorAll<HTMLButtonElement>('.menu-item')) {
      b.classList.toggle('is-current', b.dataset.id === meta?.id);
    }
    document.title = meta ? `${meta.title} · The Way of the Universe` : 'The Way of the Universe';
  }

  openMenu(): void {
    this.menuOpen = true;
    this.menuEl.hidden = false;
    this.root.classList.add('menu-open');
    const first = this.menuEl.querySelector<HTMLButtonElement>('.menu-item.is-current') ?? this.menuEl.querySelector<HTMLButtonElement>('.menu-item');
    first?.focus({ preventScroll: true });
  }
  closeMenu(): void {
    this.menuOpen = false;
    this.menuEl.hidden = true;
    this.root.classList.remove('menu-open');
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
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'Escape') {
      if (this.menuOpen) this.closeMenu();
      else if (this.panel.open) this.panel.setOpen(false);
      else if (this.hidden) this.setHidden(false);
    } else if (e.code === 'KeyM') this.toggleMenu();
    else if (e.code === 'KeyH') this.setHidden(!this.hidden);
    else if (e.code === 'KeyP') this.panel.toggle();
    else if (this.menuOpen && /^Digit[1-9]$/.test(e.code)) {
      const i = Number(e.code.slice(5)) - 1;
      const x = this.experiences[i];
      if (x) {
        this.closeMenu();
        this.handlers.navigate(x.id);
      }
    }
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
    const quiet = !this.neverIdle && now - this.lastActivity > 4200 && !this.overUI && !this.panel.open && !this.menuOpen;
    if (quiet !== this.idle) {
      this.idle = quiet;
      this.root.classList.toggle('is-idle', quiet);
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
    this.hintEl.textContent = text;
    this.hintEl.classList.add('is-visible');
    clearTimeout(this.hintTimer);
    if (ms > 0) this.hintTimer = window.setTimeout(() => this.hintEl.classList.remove('is-visible'), ms);
  }
  clearHint(): void {
    this.hintEl.classList.remove('is-visible');
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
  dispose(): void {
    for (const r of this.readouts) r.remove();
    for (const s of this.sections) this.ui.panel.remove(s);
    for (const n of this.nodes) n.remove();
    this.readouts = [];
    this.sections = [];
    this.nodes = [];
    this.ui.info(null);
    this.ui.clearHint();
  }
}
