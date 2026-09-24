/**
 * Minimal encounter timeline for the bottom-right corner: a hairline from the start to the last
 * moment of the story, a dot per moment (click to jump), an accent playhead, and one line of text
 * (current moment · time, or integration progress). Pure DOM; styles scoped under .cw-tl.
 */
export interface TimelineMoment {
  label: string;
  t: number;
}

const STYLE = `
.cw-tl { width: min(300px, calc(100vw - 2 * var(--gutter, 16px))); font-family: var(--font-ui); color: var(--ink); user-select: none; }
.cw-tl-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 9px; }
.cw-tl-name { font-size: 10px; letter-spacing: 0.22em; text-transform: uppercase; color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cw-tl-time { font-family: var(--font-mono); font-size: 11.5px; font-variant-numeric: tabular-nums; color: var(--ink); white-space: nowrap; }
.cw-tl-track { position: relative; height: 18px; cursor: pointer; touch-action: none; }
.cw-tl-line { position: absolute; left: 0; right: 0; top: 8.5px; height: 1px; background: var(--line-strong); }
.cw-tl-fill { position: absolute; left: 0; top: 8.5px; height: 1px; background: var(--ink-2); width: 0; }
.cw-tl-dot { position: absolute; top: 5px; width: 8px; height: 8px; margin-left: -4px; border-radius: 50%; border: 1px solid var(--ink-3); background: #000; padding: 0; cursor: pointer; }
.cw-tl-dot.is-past { border-color: var(--ink-2); background: var(--ink-3); }
.cw-tl-dot:hover, .cw-tl-dot:focus-visible { border-color: var(--accent); outline: none; }
.cw-tl-head-dot { position: absolute; top: 3.5px; width: 12px; height: 12px; margin-left: -6px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 10px rgba(255, 198, 144, 0.55); pointer-events: none; }
.cw-tl.is-busy .cw-tl-head-dot { background: var(--cool); box-shadow: 0 0 10px rgba(174, 203, 255, 0.55); }
`;

export class Timeline {
  readonly el: HTMLElement;
  private name: HTMLElement;
  private timeEl: HTMLElement;
  private track: HTMLElement;
  private fill: HTMLElement;
  private head: HTMLElement;
  private dots: HTMLButtonElement[] = [];
  private moments: TimelineMoment[] = [];
  private span = 1;
  private hover: TimelineMoment | null = null;
  private last = { name: '', time: '', x: -1, busy: false };

  constructor(private onJump: (t: number) => void) {
    this.el = document.createElement('div');
    this.el.className = 'cw-tl';
    const style = document.createElement('style');
    style.textContent = STYLE;
    const headRow = document.createElement('div');
    headRow.className = 'cw-tl-head';
    this.name = document.createElement('span');
    this.name.className = 'cw-tl-name';
    this.timeEl = document.createElement('span');
    this.timeEl.className = 'cw-tl-time';
    headRow.append(this.name, this.timeEl);
    this.track = document.createElement('div');
    this.track.className = 'cw-tl-track';
    this.track.setAttribute('role', 'slider');
    this.track.setAttribute('aria-label', 'Encounter timeline');
    const line = document.createElement('div');
    line.className = 'cw-tl-line';
    this.fill = document.createElement('div');
    this.fill.className = 'cw-tl-fill';
    this.head = document.createElement('div');
    this.head.className = 'cw-tl-head-dot';
    this.track.append(line, this.fill, this.head);
    this.track.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).classList.contains('cw-tl-dot')) return;
      const r = this.track.getBoundingClientRect();
      const u = Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width)));
      this.onJump(u * this.span);
    });
    this.el.append(style, headRow, this.track);
  }

  setMoments(moments: TimelineMoment[], span: number): void {
    this.moments = moments;
    this.span = Math.max(1, span);
    for (const d of this.dots) d.remove();
    this.dots = moments.map((m) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cw-tl-dot';
      b.title = m.label;
      b.setAttribute('aria-label', `Jump to ${m.label}`);
      b.style.left = `${(100 * m.t) / this.span}%`;
      b.addEventListener('click', () => this.onJump(m.t));
      b.addEventListener('pointerenter', () => (this.hover = m));
      b.addEventListener('pointerleave', () => (this.hover = null));
      this.track.insertBefore(b, this.head);
      return b;
    });
    this.last.x = -1;
  }

  /** Label of the latest moment reached at time t ('' before the first). */
  momentAt(t: number): string {
    let s = '';
    for (const m of this.moments) if (t >= m.t - 2) s = m.label;
    return s;
  }

  update(t: number, fallbackName: string, timeText: string, busy: number | null): void {
    // Grow the span if the story runs past its last moment.
    if (t > this.span) this.setMoments(this.moments, t * 1.15);
    const isBusy = busy !== null;
    const name = isBusy ? 'Integrating' : this.hover ? this.hover.label : this.momentAt(t) || fallbackName;
    const time = isBusy ? `${Math.round(busy * 100)} %` : timeText;
    if (name !== this.last.name) this.name.textContent = this.last.name = name;
    if (time !== this.last.time) this.timeEl.textContent = this.last.time = time;
    if (isBusy !== this.last.busy) this.el.classList.toggle('is-busy', (this.last.busy = isBusy));
    const x = Math.round((1000 * Math.min(t, this.span)) / this.span) / 10;
    if (x !== this.last.x) {
      this.last.x = x;
      this.head.style.left = `${x}%`;
      this.fill.style.width = `${x}%`;
      this.dots.forEach((d, i) => d.classList.toggle('is-past', this.moments[i].t <= t + 1));
    }
  }
}
