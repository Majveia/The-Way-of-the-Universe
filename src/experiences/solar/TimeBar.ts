/**
 * Time controls (bottom-right corner): UTC date and time, Julian date, reverse / pause / slower /
 * faster, the warp rate in words, and "Now". Keyboard: Space pause, [ ] slower/faster, R reverse, N now.
 */
import { ICONS } from '../../ui/icons';
import { WARP_STEPS, formatUTC } from '../../worlds/solar/time';

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON_SLOWER = svg('<path d="M11 6l-6 6 6 6M19 6l-6 6 6 6"/>');
const ICON_FASTER = svg('<path d="M13 6l6 6-6 6M5 6l6 6-6 6"/>');
const ICON_REVERSE = svg('<path d="M9 7H18a3 3 0 0 1 0 6H7"/><path d="M10 10l-3 3 3 3"/>');

const STYLE = `
.solar-time { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; pointer-events: auto; user-select: none; }
.solar-time .st-date { font-family: var(--font-mono); font-size: 13px; font-variant-numeric: tabular-nums; color: var(--ink); letter-spacing: 0.02em; white-space: nowrap; }
.solar-time .st-date .st-z { color: var(--ink-3); margin-left: 0.4em; font-size: 10.5px; letter-spacing: 0.12em; }
.solar-time .st-jd { font-family: var(--font-mono); font-size: 10.5px; color: var(--ink-3); font-variant-numeric: tabular-nums; letter-spacing: 0.02em; }
.solar-time .st-row { display: flex; align-items: center; gap: 2px; }
.solar-time .st-rate { min-width: 92px; text-align: center; font-size: 11px; letter-spacing: 0.06em; color: var(--ink-2); white-space: nowrap; }
.solar-time .st-rate.rev { color: var(--cool); }
.solar-time .icon-btn { width: 32px; height: 32px; }
.solar-time .icon-btn.on { color: var(--accent); }
.solar-time .st-now { margin-left: 6px; padding: 3px 10px; font-size: 11px; }
.solar-time .st-now.is-live { color: var(--accent); border-color: rgba(255,198,144,0.45); }
@media (max-width: 720px) { .solar-time { align-items: flex-start; } .solar-time .st-rate { min-width: 78px; } }
`;

export interface TimeState {
  /** Index into WARP_STEPS. */
  step: number;
  paused: boolean;
  reverse: boolean;
}

export class TimeBar {
  readonly el: HTMLElement;
  readonly style: HTMLStyleElement;
  private dateEl: HTMLElement;
  private dateText: Text;
  private jdEl: HTMLElement;
  private rateEl: HTMLElement;
  private playBtn: HTMLButtonElement;
  private revBtn: HTMLButtonElement;
  private nowBtn: HTMLButtonElement;
  private lastDate = '';
  private lastJd = '';
  private lastRate = '';

  constructor(
    readonly state: TimeState,
    private handlers: { changed(): void; now(): void },
  ) {
    this.style = document.createElement('style');
    this.style.textContent = STYLE;
    const el = document.createElement('div');
    el.className = 'solar-time';
    this.dateEl = document.createElement('div');
    this.dateEl.className = 'st-date';
    this.dateEl.setAttribute('aria-live', 'off');
    this.dateText = document.createTextNode('');
    const zone = document.createElement('span');
    zone.className = 'st-z';
    zone.textContent = 'UTC';
    this.dateEl.append(this.dateText, zone);
    const row = document.createElement('div');
    row.className = 'st-row';
    const btn = (icon: string, label: string, fn: () => void) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'icon-btn';
      b.innerHTML = icon;
      b.title = label;
      b.setAttribute('aria-label', label);
      b.addEventListener('click', fn);
      return b;
    };
    this.revBtn = btn(ICON_REVERSE, 'Reverse time (R)', () => this.toggleReverse());
    const slower = btn(ICON_SLOWER, 'Slower ([)', () => this.slower());
    this.playBtn = btn(ICONS.pause, 'Pause (Space)', () => this.togglePause());
    const faster = btn(ICON_FASTER, 'Faster (])', () => this.faster());
    this.rateEl = document.createElement('span');
    this.rateEl.className = 'st-rate';
    this.nowBtn = document.createElement('button');
    this.nowBtn.type = 'button';
    this.nowBtn.className = 'chip st-now';
    this.nowBtn.textContent = 'Now';
    this.nowBtn.title = 'Return to the present (N)';
    this.nowBtn.addEventListener('click', () => this.handlers.now());
    row.append(this.revBtn, slower, this.playBtn, faster, this.rateEl, this.nowBtn);
    this.jdEl = document.createElement('div');
    this.jdEl.className = 'st-jd';
    el.append(this.dateEl, row, this.jdEl);
    this.el = el;
    this.sync();
  }

  togglePause(): void {
    this.state.paused = !this.state.paused;
    this.sync();
    this.handlers.changed();
  }
  toggleReverse(): void {
    this.state.reverse = !this.state.reverse;
    this.sync();
    this.handlers.changed();
  }
  faster(): void {
    if (this.state.paused) this.state.paused = false;
    else this.state.step = Math.min(WARP_STEPS.length - 1, this.state.step + 1);
    this.sync();
    this.handlers.changed();
  }
  slower(): void {
    this.state.step = Math.max(0, this.state.step - 1);
    this.sync();
    this.handlers.changed();
  }

  /** Signed simulated seconds per real second. */
  get rate(): number {
    if (this.state.paused) return 0;
    return WARP_STEPS[this.state.step].rate * (this.state.reverse ? -1 : 1);
  }

  sync(): void {
    const s = this.state;
    this.playBtn.innerHTML = s.paused ? ICONS.play : ICONS.pause;
    this.playBtn.title = s.paused ? 'Play (Space)' : 'Pause (Space)';
    this.playBtn.setAttribute('aria-label', this.playBtn.title);
    this.revBtn.classList.toggle('on', s.reverse);
    const label = s.paused ? 'paused' : (s.reverse ? '−' : '') + WARP_STEPS[s.step].label;
    if (label !== this.lastRate) {
      this.rateEl.textContent = label;
      this.lastRate = label;
    }
    this.rateEl.classList.toggle('rev', s.reverse && !s.paused);
  }

  /** Update the clock (UTC Julian date). `live` marks the view as tracking the present. */
  show(jdUTC: number, live: boolean): void {
    const f = formatUTC(jdUTC);
    const date = `${f.date}  ${f.time}`;
    if (date !== this.lastDate) {
      this.dateText.data = date;
      this.lastDate = date;
    }
    const jd = `JD ${jdUTC.toFixed(5)}`;
    if (jd !== this.lastJd) {
      this.jdEl.textContent = jd;
      this.lastJd = jd;
    }
    this.nowBtn.classList.toggle('is-live', live);
  }
}
