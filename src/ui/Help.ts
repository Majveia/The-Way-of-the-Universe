import { hintToShortcuts } from './hint';

export { hintToShortcuts };

/** A keyboard/touch shortcut an experience can list in the help overlay (`?`). */
export interface Shortcut {
  /** Key caps, e.g. ['W', 'A', 'S', 'D'] or 'Space'. Use 'Drag', 'Scroll', 'Pinch' for gestures. */
  keys: string | string[];
  /** What it does, in plain language. */
  label: string;
}

export const GLOBAL_SHORTCUTS: Shortcut[] = [
  { keys: 'M', label: 'Worlds menu' },
  { keys: ['Ctrl', 'K'], label: 'Go anywhere' },
  { keys: 'P', label: 'Controls panel' },
  { keys: 'H', label: 'Hide the interface' },
  { keys: '?', label: 'This help' },
  { keys: '`', label: 'Frame rate and quality' },
  { keys: 'Esc', label: 'Close / back' },
];

const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

function caps(keys: string | string[]): HTMLElement {
  const span = document.createElement('span');
  span.className = 'help-keys';
  const list = Array.isArray(keys) ? keys : [keys];
  list.forEach((k) => {
    const kbd = document.createElement('kbd');
    kbd.textContent = k === 'Ctrl' && isMac() ? '⌘' : k;
    span.appendChild(kbd);
  });
  return span;
}

/**
 * Help overlay: the current world's controls (registered with `ctx.ui.shortcuts()`, or
 * derived from its hint line) and the global keys. Opened with `?`.
 */
export class Help {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private returnFocus: HTMLElement | null = null;
  onToggle?: (open: boolean) => void;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'help-scrim';
    this.el.hidden = true;
    this.el.innerHTML = `<div class="help" role="dialog" aria-modal="true" aria-labelledby="twu-help-title" tabindex="-1">
      <button class="icon-btn help-close" type="button" aria-label="Close help"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.25"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      <div class="help-body"></div></div>`;
    this.body = this.el.querySelector('.help-body') as HTMLElement;
    (this.el.querySelector('.help-close') as HTMLElement).addEventListener('click', () => this.close());
    this.el.addEventListener('pointerdown', (e) => {
      if (e.target === this.el) this.close();
    });
    parent.appendChild(this.el);
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  open(title: string, kicker: string, local: Shortcut[], hintText: string): void {
    this.returnFocus = document.activeElement as HTMLElement | null;
    this.body.innerHTML = '';
    const head = document.createElement('header');
    head.className = 'help-head';
    const k = document.createElement('div');
    k.className = 'help-kicker';
    k.textContent = kicker || 'The Way of the Universe';
    const h = document.createElement('h2');
    h.id = 'twu-help-title';
    h.className = 'help-title';
    h.textContent = title || 'Controls';
    head.append(k, h);
    this.body.appendChild(head);

    const cols = document.createElement('div');
    cols.className = 'help-cols';
    const touch = window.matchMedia?.('(pointer: coarse)').matches ?? false;
    let here = local;
    if (!here.length) here = hintToShortcuts(hintText);
    if (!here.length)
      here = touch
        ? [
            { keys: 'Drag', label: 'Look around' },
            { keys: 'Pinch', label: 'Zoom' },
          ]
        : [
            { keys: 'Drag', label: 'Look around' },
            { keys: 'Scroll', label: 'Zoom' },
          ];
    cols.append(this.column('In this world', here), this.column('Everywhere', touch ? GLOBAL_SHORTCUTS.filter((s) => s.keys !== '`') : GLOBAL_SHORTCUTS));
    this.body.appendChild(cols);
    this.el.hidden = false;
    (this.el.querySelector('.help') as HTMLElement).focus({ preventScroll: true });
    this.onToggle?.(true);
  }

  private column(title: string, items: Shortcut[]): HTMLElement {
    const sec = document.createElement('section');
    sec.className = 'help-col';
    const h = document.createElement('h3');
    h.textContent = title;
    const dl = document.createElement('dl');
    for (const s of items) {
      const row = document.createElement('div');
      const dt = document.createElement('dt');
      dt.appendChild(caps(s.keys));
      const dd = document.createElement('dd');
      dd.textContent = s.label;
      row.append(dt, dd);
      dl.appendChild(row);
    }
    sec.append(h, dl);
    return sec;
  }

  close(): void {
    if (!this.isOpen) return;
    this.el.hidden = true;
    this.onToggle?.(false);
    const r = this.returnFocus;
    this.returnFocus = null;
    if (r && document.contains(r)) r.focus({ preventScroll: true });
  }
}

