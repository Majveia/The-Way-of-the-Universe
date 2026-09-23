/**
 * Declarative control panel. Experiences describe their interactive parameters and the
 * panel renders them in the house style. All controls are keyboard accessible.
 */
export interface SliderOptions {
  label: string;
  min: number;
  max: number;
  value: number;
  step?: number;
  /** Logarithmic mapping (min must be > 0). */
  log?: boolean;
  unit?: string;
  format?: (v: number) => string;
  onChange: (v: number) => void;
  help?: string;
}
export interface ToggleOptions {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  help?: string;
}
export interface SelectOptions<T extends string = string> {
  label: string;
  value: T;
  options: ReadonlyArray<T | { value: T; label: string }>;
  onChange: (v: T) => void;
  help?: string;
}
export interface ButtonOptions {
  label: string;
  onClick: () => void;
  primary?: boolean;
  help?: string;
}
export interface Control<T> {
  readonly el: HTMLElement;
  get(): T;
  /** Set without firing onChange. */
  set(v: T): void;
  setDisabled(d: boolean): void;
}

let uid = 0;
const id = (p: string) => `twu-${p}-${++uid}`;

const defaultFormat = (v: number) => {
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e5 || a < 1e-3)) return v.toExponential(2);
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  return v.toFixed(2);
};

export class PanelSection {
  readonly el: HTMLElement;
  private body: HTMLElement;

  constructor(title: string | null, parent: HTMLElement) {
    this.el = document.createElement('section');
    this.el.className = 'pnl-section';
    if (title) {
      const h = document.createElement('h3');
      h.className = 'pnl-title';
      h.textContent = title;
      this.el.appendChild(h);
    }
    this.body = document.createElement('div');
    this.body.className = 'pnl-body';
    this.el.appendChild(this.body);
    parent.appendChild(this.el);
  }

  private row(cls: string, help?: string): HTMLElement {
    const r = document.createElement('div');
    r.className = `pnl-row ${cls}`;
    if (help) r.title = help;
    this.body.appendChild(r);
    return r;
  }

  slider(o: SliderOptions): Control<number> {
    const r = this.row('pnl-slider', o.help);
    const inputId = id('s');
    const lab = document.createElement('label');
    lab.htmlFor = inputId;
    lab.innerHTML = `<span class="pnl-label"></span><output class="pnl-value"></output>`;
    (lab.querySelector('.pnl-label') as HTMLElement).textContent = o.label;
    const out = lab.querySelector('output') as HTMLOutputElement;
    const input = document.createElement('input');
    input.type = 'range';
    input.id = inputId;
    const steps = 1000;
    const toPos = (v: number) =>
      o.log ? (Math.log(v / o.min) / Math.log(o.max / o.min)) * steps : ((v - o.min) / (o.max - o.min)) * steps;
    const fromPos = (p: number) => {
      let v = o.log ? o.min * Math.pow(o.max / o.min, p / steps) : o.min + ((o.max - o.min) * p) / steps;
      if (o.step && !o.log) v = Math.round(v / o.step) * o.step;
      return v;
    };
    input.min = '0';
    input.max = String(steps);
    input.step = '1';
    let value = o.value;
    const fmt = o.format ?? defaultFormat;
    const show = () => {
      out.textContent = fmt(value) + (o.unit ? ` ${o.unit}` : '');
      const p = toPos(value) / steps;
      input.style.setProperty('--p', String(Math.min(1, Math.max(0, p))));
    };
    input.value = String(toPos(value));
    show();
    input.addEventListener('input', () => {
      value = fromPos(Number(input.value));
      show();
      o.onChange(value);
    });
    r.append(lab, input);
    return {
      el: r,
      get: () => value,
      set: (v: number) => {
        value = v;
        input.value = String(toPos(v));
        show();
      },
      setDisabled: (d) => {
        input.disabled = d;
        r.classList.toggle('is-disabled', d);
      },
    };
  }

  toggle(o: ToggleOptions): Control<boolean> {
    const r = this.row('pnl-toggle', o.help);
    const inputId = id('t');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = inputId;
    input.checked = o.value;
    input.setAttribute('role', 'switch');
    const lab = document.createElement('label');
    lab.htmlFor = inputId;
    lab.innerHTML = `<span class="pnl-label"></span><span class="pnl-switch" aria-hidden="true"></span>`;
    (lab.querySelector('.pnl-label') as HTMLElement).textContent = o.label;
    input.addEventListener('change', () => o.onChange(input.checked));
    r.append(input, lab);
    return {
      el: r,
      get: () => input.checked,
      set: (v) => (input.checked = v),
      setDisabled: (d) => {
        input.disabled = d;
        r.classList.toggle('is-disabled', d);
      },
    };
  }

  select<T extends string>(o: SelectOptions<T>): Control<T> {
    const r = this.row('pnl-select', o.help);
    const inputId = id('c');
    const lab = document.createElement('label');
    lab.htmlFor = inputId;
    lab.className = 'pnl-label';
    lab.textContent = o.label;
    const sel = document.createElement('select');
    sel.id = inputId;
    for (const opt of o.options) {
      const v = typeof opt === 'string' ? opt : opt.value;
      const l = typeof opt === 'string' ? opt : opt.label;
      const e = document.createElement('option');
      e.value = v;
      e.textContent = l;
      sel.appendChild(e);
    }
    sel.value = o.value;
    sel.addEventListener('change', () => o.onChange(sel.value as T));
    r.append(lab, sel);
    return {
      el: r,
      get: () => sel.value as T,
      set: (v) => (sel.value = v),
      setDisabled: (d) => {
        sel.disabled = d;
        r.classList.toggle('is-disabled', d);
      },
    };
  }

  button(o: ButtonOptions): Control<void> {
    const r = this.row('pnl-button', o.help);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = o.primary ? 'btn btn-primary' : 'btn';
    b.textContent = o.label;
    b.addEventListener('click', () => o.onClick());
    r.appendChild(b);
    return { el: r, get: () => undefined, set: () => undefined, setDisabled: (d) => (b.disabled = d) };
  }

  /** A row of buttons, e.g. presets. Returns a setter to mark the active one. */
  buttons(items: ReadonlyArray<{ label: string; onClick: () => void }>, active?: number): { el: HTMLElement; setActive(i: number): void } {
    const r = this.row('pnl-buttons');
    const bs = items.map((it, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = it.label;
      b.addEventListener('click', () => {
        setActive(i);
        it.onClick();
      });
      r.appendChild(b);
      return b;
    });
    const setActive = (i: number) => bs.forEach((b, k) => b.classList.toggle('is-active', k === i));
    if (active !== undefined) setActive(active);
    return { el: r, setActive };
  }

  /** Short explanatory text (plain text; use \n for line breaks). */
  text(t: string): HTMLElement {
    const r = this.row('pnl-text');
    r.textContent = t;
    return r;
  }

  /** Live label/value line inside the panel. */
  readout(label: string): (value: string) => void {
    const r = this.row('pnl-readout');
    r.innerHTML = `<span class="pnl-label"></span><span class="pnl-value"></span>`;
    (r.querySelector('.pnl-label') as HTMLElement).textContent = label;
    const v = r.querySelector('.pnl-value') as HTMLElement;
    let last = '';
    return (value: string) => {
      if (value !== last) v.textContent = last = value;
    };
  }

  /** Arbitrary element (e.g. a small canvas plot). */
  custom(el: HTMLElement): HTMLElement {
    const r = this.row('pnl-custom');
    r.appendChild(el);
    return r;
  }
}

export class Panel {
  readonly el: HTMLElement;
  private content: HTMLElement;
  private sections: PanelSection[] = [];
  onVisibilityChange?: (open: boolean) => void;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('aside');
    this.el.className = 'panel chrome';
    this.el.setAttribute('aria-label', 'Controls');
    this.el.hidden = true;
    const head = document.createElement('div');
    head.className = 'panel-head';
    head.innerHTML = `<span class="panel-heading">Controls</span>`;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'icon-btn';
    close.setAttribute('aria-label', 'Close controls');
    close.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.25"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
    close.addEventListener('click', () => this.setOpen(false));
    head.appendChild(close);
    this.content = document.createElement('div');
    this.content.className = 'panel-content';
    this.el.append(head, this.content);
    parent.appendChild(this.el);
  }

  get isEmpty(): boolean {
    return this.sections.length === 0;
  }
  get open(): boolean {
    return !this.el.hidden;
  }
  setOpen(open: boolean): void {
    const o = open && !this.isEmpty;
    if (this.el.hidden === !o) return;
    this.el.hidden = !o;
    this.onVisibilityChange?.(o);
  }
  toggle(): void {
    this.setOpen(!this.open);
  }

  section(title: string | null = null): PanelSection {
    const s = new PanelSection(title, this.content);
    this.sections.push(s);
    this.onVisibilityChange?.(this.open);
    return s;
  }

  remove(s: PanelSection): void {
    s.el.remove();
    this.sections = this.sections.filter((x) => x !== s);
    if (this.isEmpty) this.setOpen(false);
  }

  clear(): void {
    for (const s of this.sections) s.el.remove();
    this.sections = [];
    this.setOpen(false);
  }
}
