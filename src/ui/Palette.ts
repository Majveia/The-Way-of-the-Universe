import { rankCommands } from './fuzzy';

/** Something the palette can run: a world, a destination inside one, an action. */
export interface Command {
  label: string;
  /** Section heading, e.g. 'Worlds', 'Destinations', 'Sound'. */
  group?: string;
  /** Small secondary text on the right (kicker, shortcut). */
  hint?: string;
  /** Extra search terms. */
  keywords?: string;
  run: () => void;
}

let uid = 0;

/**
 * Command palette (Ctrl/Cmd + K): one input, one list, keyboard first.
 * Accessible combobox pattern: input[role=combobox] → ul[role=listbox] → li[role=option],
 * the active option tracked with aria-activedescendant.
 */
export class Palette {
  readonly el: HTMLElement;
  private input: HTMLInputElement;
  private list: HTMLElement;
  private empty: HTMLElement;
  private items: Command[] = [];
  private shown: Command[] = [];
  private activeIndex = 0;
  private returnFocus: HTMLElement | null = null;
  onToggle?: (open: boolean) => void;
  onMove?: () => void;

  constructor(parent: HTMLElement, private source: () => Command[]) {
    const id = `twu-pal-${++uid}`;
    this.el = document.createElement('div');
    this.el.className = 'palette-scrim';
    this.el.hidden = true;
    this.el.innerHTML = `
      <div class="palette" role="dialog" aria-modal="true" aria-label="Go anywhere">
        <div class="palette-field">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/></svg>
          <input class="palette-input" type="text" spellcheck="false" autocomplete="off" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls="${id}" placeholder="Go anywhere — a world, a place, an action" />
          <kbd class="palette-esc">Esc</kbd>
        </div>
        <ul class="palette-list" id="${id}" role="listbox" aria-label="Results"></ul>
        <div class="palette-empty" hidden>Nothing here by that name — yet.</div>
        <div class="palette-foot"><span><kbd>↑</kbd><kbd>↓</kbd> choose</span><span><kbd>↵</kbd> go</span><span><kbd>Esc</kbd> close</span></div>
      </div>`;
    this.input = this.el.querySelector('.palette-input') as HTMLInputElement;
    this.list = this.el.querySelector('.palette-list') as HTMLElement;
    this.empty = this.el.querySelector('.palette-empty') as HTMLElement;
    this.input.addEventListener('input', () => this.filter());
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.el.addEventListener('pointerdown', (e) => {
      if (e.target === this.el) this.close();
    });
    parent.appendChild(this.el);
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  open(query = ''): void {
    if (!this.isOpen) this.returnFocus = document.activeElement as HTMLElement | null;
    this.items = this.source();
    this.el.hidden = false;
    this.input.value = query;
    this.filter();
    this.input.focus({ preventScroll: true });
    this.onToggle?.(true);
  }

  close(): void {
    if (!this.isOpen) return;
    this.el.hidden = true;
    this.onToggle?.(false);
    const r = this.returnFocus;
    this.returnFocus = null;
    if (r && document.contains(r)) r.focus({ preventScroll: true });
    else this.input.blur();
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  private filter(): void {
    this.shown = rankCommands(this.input.value, this.items);
    this.activeIndex = 0;
    this.render();
  }

  private render(): void {
    this.list.innerHTML = '';
    let group = '';
    const grouped = !this.input.value.trim();
    this.shown.forEach((c, i) => {
      if (grouped && c.group && c.group !== group) {
        group = c.group;
        const h = document.createElement('li');
        h.className = 'palette-group';
        h.setAttribute('role', 'presentation');
        h.textContent = group;
        this.list.appendChild(h);
      }
      const li = document.createElement('li');
      li.className = 'palette-item';
      li.id = `${this.list.id}-o${i}`;
      li.setAttribute('role', 'option');
      const l = document.createElement('span');
      l.className = 'palette-label';
      l.textContent = c.label;
      li.appendChild(l);
      const meta = grouped ? c.hint : [c.group, c.hint].filter(Boolean).join(' · ');
      if (meta) {
        const h = document.createElement('span');
        h.className = 'palette-hint';
        h.textContent = meta;
        li.appendChild(h);
      }
      li.addEventListener('pointermove', () => {
        if (this.activeIndex !== i) this.setActive(i, false);
      });
      li.addEventListener('click', () => this.run(i));
      this.list.appendChild(li);
    });
    this.empty.hidden = this.shown.length > 0;
    this.setActive(0, true);
  }

  private setActive(i: number, scroll: boolean): void {
    if (!this.shown.length) {
      this.input.removeAttribute('aria-activedescendant');
      return;
    }
    this.activeIndex = (i + this.shown.length) % this.shown.length;
    const opts = this.list.querySelectorAll<HTMLElement>('.palette-item');
    opts.forEach((o, k) => {
      const on = k === this.activeIndex;
      o.classList.toggle('is-active', on);
      o.setAttribute('aria-selected', String(on));
      if (on) {
        this.input.setAttribute('aria-activedescendant', o.id);
        if (scroll) o.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  private run(i: number): void {
    const c = this.shown[i];
    if (!c) return;
    this.close();
    c.run();
  }

  /** Keys while the input has focus. */
  onKey(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey) || (e.ctrlKey && e.key === 'n')) {
      e.preventDefault();
      this.setActive(this.activeIndex + 1, true);
      this.onMove?.();
    } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey) || (e.ctrlKey && e.key === 'p')) {
      e.preventDefault();
      this.setActive(this.activeIndex - 1, true);
      this.onMove?.();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.run(this.activeIndex);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }
  }
}
