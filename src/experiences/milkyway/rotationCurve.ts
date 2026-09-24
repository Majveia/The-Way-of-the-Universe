import type { GalaxyPotential } from '../../physics/galaxyPotential';

const NS = 'http://www.w3.org/2000/svg';
const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] => {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  return e;
};

/**
 * Rotation-curve plot v_c(R): total (with dark matter), baryons only, the dark halo alone, and —
 * for the Milky Way — the measured curve of Eilers et al. (2019, ApJ 871, 120: v_c = 229 −
 * 1.7 (R − 8.12 kpc) km/s from 5 to 25 kpc, APOGEE/Gaia red giants). A marker follows the
 * radius under the cursor.
 */
export class RotationCurvePlot {
  readonly el: HTMLElement;
  private root: SVGSVGElement;
  private curves: SVGGElement;
  private cursor: SVGLineElement;
  private sunLine: SVGLineElement;
  private dotTotal: SVGCircleElement;
  private dotBary: SVGCircleElement;
  private note: HTMLElement;
  private rMax = 25000;
  private vMax = 300;
  private readonly W = 272;
  private readonly H = 150;
  private readonly pad = { l: 30, r: 10, t: 10, b: 22 };
  private pot: GalaxyPotential | null = null;
  private darkOn = true;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'mw-curve';
    const title = document.createElement('div');
    title.className = 'mw-curve-title';
    title.textContent = 'Rotation curve';
    this.note = document.createElement('div');
    this.note.className = 'mw-curve-note';
    this.root = svg('svg', { viewBox: `0 0 ${this.W} ${this.H}`, width: this.W, height: this.H });
    this.curves = svg('g');
    this.cursor = svg('line', { class: 'mw-c-cursor' });
    this.sunLine = svg('line', { class: 'mw-c-sun' });
    this.dotTotal = svg('circle', { r: 2.6, class: 'mw-c-dot-total' });
    this.dotBary = svg('circle', { r: 2.6, class: 'mw-c-dot-bary' });
    this.root.append(this.curves, this.sunLine, this.cursor, this.dotTotal, this.dotBary);
    const legend = document.createElement('div');
    legend.className = 'mw-curve-legend';
    legend.innerHTML =
      '<span><i class="k-total"></i>with dark matter</span><span><i class="k-bary"></i>stars + gas only</span><span><i class="k-obs"></i>measured</span>';
    this.el.append(title, this.root, legend, this.note);
  }

  private x(R: number): number {
    return this.pad.l + (R / this.rMax) * (this.W - this.pad.l - this.pad.r);
  }
  private y(v: number): number {
    return this.H - this.pad.b - (v / this.vMax) * (this.H - this.pad.t - this.pad.b);
  }

  /** Rebuild the curves for a potential (call on preset change). */
  setPotential(pot: GalaxyPotential, rMax: number, showObserved: boolean, sunR?: number): void {
    this.pot = pot;
    this.rMax = Math.max(8000, Math.ceil(rMax / 5000) * 5000);
    let vpk = 0;
    for (let i = 1; i <= 100; i++) vpk = Math.max(vpk, pot.vcKms((i / 100) * this.rMax, true));
    this.vMax = Math.max(100, Math.ceil((vpk * 1.18) / 50) * 50);
    const g = this.curves;
    while (g.firstChild) g.removeChild(g.firstChild);
    // Axes and grid.
    const x0 = this.pad.l;
    const x1 = this.W - this.pad.r;
    const y0 = this.H - this.pad.b;
    g.append(svg('line', { x1: x0, y1: y0, x2: x1, y2: y0, class: 'mw-c-axis' }));
    const stepV = this.vMax > 200 ? 100 : 50;
    for (let v = stepV; v < this.vMax; v += stepV) {
      g.append(svg('line', { x1: x0, y1: this.y(v), x2: x1, y2: this.y(v), class: 'mw-c-grid' }));
      const t = svg('text', { x: x0 - 5, y: this.y(v) + 3, class: 'mw-c-tick', 'text-anchor': 'end' });
      t.textContent = String(v);
      g.append(t);
    }
    const stepR = this.rMax > 30000 ? 10000 : 5000;
    for (let R = 0; R <= this.rMax; R += stepR) {
      const t = svg('text', { x: this.x(R), y: y0 + 13, class: 'mw-c-tick', 'text-anchor': 'middle' });
      t.textContent = String(R / 1000);
      g.append(t);
    }
    const ax = svg('text', { x: x1, y: y0 - 4, class: 'mw-c-label', 'text-anchor': 'end' });
    ax.textContent = 'R  kpc';
    const ay = svg('text', { x: x0 + 3, y: this.pad.t + 6, class: 'mw-c-label' });
    ay.textContent = 'km/s';
    g.append(ax, ay);

    if (showObserved) {
      // Eilers et al. 2019 linear fit with its ±(systematic) envelope, drawn only where measured.
      const a = 5000;
      const b = Math.min(25000, this.rMax);
      const top: string[] = [];
      const bot: string[] = [];
      for (let i = 0; i <= 20; i++) {
        const R = a + ((b - a) * i) / 20;
        const v = 229 - 1.7 * (R / 1000 - 8.122);
        const e = 6 + 0.25 * Math.max(0, R / 1000 - 15);
        top.push(`${this.x(R).toFixed(1)},${this.y(v + e).toFixed(1)}`);
        bot.unshift(`${this.x(R).toFixed(1)},${this.y(v - e).toFixed(1)}`);
      }
      g.append(svg('polygon', { points: top.concat(bot).join(' '), class: 'mw-c-obs' }));
    }
    const path = (f: (R: number) => number) => {
      let d = '';
      for (let i = 0; i <= 160; i++) {
        const R = Math.max(20, (i / 160) * this.rMax);
        d += `${i ? 'L' : 'M'}${this.x(R).toFixed(1)},${this.y(Math.min(f(R), this.vMax * 1.05)).toFixed(1)}`;
      }
      return d;
    };
    const hasDark = pot.components.some((c) => c.dark);
    if (hasDark) {
      g.append(svg('path', { d: path((R) => Math.sqrt(Math.max(0, pot.vcKms(R, true) ** 2 - pot.vcKms(R, false) ** 2))), class: 'mw-c-halo' }));
    }
    g.append(svg('path', { d: path((R) => pot.vcKms(R, false)), class: 'mw-c-bary' }));
    g.append(svg('path', { d: path((R) => pot.vcKms(R, true)), class: 'mw-c-total' }));
    if (sunR) {
      this.sunLine.setAttribute('x1', String(this.x(sunR)));
      this.sunLine.setAttribute('x2', String(this.x(sunR)));
      this.sunLine.setAttribute('y1', String(this.pad.t));
      this.sunLine.setAttribute('y2', String(y0));
      this.sunLine.style.display = '';
    } else this.sunLine.style.display = 'none';
    this.setDark(this.darkOn);
  }

  setDark(on: boolean): void {
    this.darkOn = on;
    this.el.classList.toggle('is-dark-off', !on);
    this.note.textContent = on
      ? 'Flat far out: the orbits need ~5× more mass than we can see.'
      : 'Halo removed: the curve falls like Kepler’s. Outer stars now move too fast to stay bound.';
  }

  /** Marker at radius R (pc), or hide with NaN. */
  setCursor(R: number): void {
    if (!this.pot || !(R > 0) || R > this.rMax) {
      this.cursor.style.display = this.dotTotal.style.display = this.dotBary.style.display = 'none';
      return;
    }
    const x = this.x(R);
    this.cursor.style.display = this.dotTotal.style.display = this.dotBary.style.display = '';
    this.cursor.setAttribute('x1', String(x));
    this.cursor.setAttribute('x2', String(x));
    this.cursor.setAttribute('y1', String(this.pad.t));
    this.cursor.setAttribute('y2', String(this.H - this.pad.b));
    this.dotTotal.setAttribute('cx', String(x));
    this.dotTotal.setAttribute('cy', String(this.y(this.pot.vcKms(R, true))));
    this.dotBary.setAttribute('cx', String(x));
    this.dotBary.setAttribute('cy', String(this.y(this.pot.vcKms(R, false))));
  }
}

export const MILKYWAY_CSS = /* css */ `
.mw-curve { width: 272px; padding: 10px 12px 10px; background: var(--glass); border: 1px solid var(--line); border-radius: var(--radius);
  pointer-events: auto; transition: opacity .6s var(--ease); }
.mw-curve[hidden] { display: none; }
.mw-curve-title { font-size: 9.5px; letter-spacing: .22em; text-transform: uppercase; color: var(--ink-3); margin-bottom: 4px; }
.mw-curve svg { display: block; width: 100%; height: auto; overflow: visible; }
.mw-c-axis { stroke: var(--line-strong); stroke-width: 1; }
.mw-c-grid { stroke: var(--line); stroke-width: 1; }
.mw-c-tick, .mw-c-label { fill: var(--ink-3); font: 9px var(--font-mono); }
.mw-c-total { fill: none; stroke: var(--accent); stroke-width: 1.6; transition: opacity .6s; }
.mw-c-bary { fill: none; stroke: var(--cool); stroke-width: 1.3; stroke-dasharray: 4 3; transition: opacity .6s; }
.mw-c-halo { fill: none; stroke: var(--ink-4); stroke-width: 1; stroke-dasharray: 1 3; }
.mw-c-obs { fill: rgba(236,232,225,.13); stroke: rgba(236,232,225,.22); stroke-width: .6; }
.mw-c-sun { stroke: var(--accent); stroke-opacity: .35; stroke-width: 1; stroke-dasharray: 2 3; }
.mw-c-cursor { stroke: var(--ink-3); stroke-width: 1; }
.mw-c-dot-total { fill: var(--accent); }
.mw-c-dot-bary { fill: var(--cool); }
.mw-curve.is-dark-off .mw-c-total { opacity: .28; }
.mw-curve.is-dark-off .mw-c-bary { stroke-dasharray: none; stroke-width: 1.8; }
.mw-curve-legend { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 6px; font-size: 10px; color: var(--ink-2); letter-spacing: .04em; }
.mw-curve-legend i { display: inline-block; width: 14px; height: 0; margin-right: 6px; vertical-align: middle; border-top: 1.6px solid var(--accent); }
.mw-curve-legend i.k-bary { border-top: 1.4px dashed var(--cool); }
.mw-curve-legend i.k-obs { height: 7px; border: none; background: rgba(236,232,225,.16); }
.mw-curve-note { margin-top: 6px; font-size: 10.5px; line-height: 1.4; color: var(--ink-2); max-width: 34ch; }
.mw-mark { position: absolute; left: 0; top: 0; pointer-events: none; will-change: transform; transition: opacity .5s var(--ease); }
.mw-mark .ring { position: absolute; left: -7px; top: -7px; width: 14px; height: 14px; border: 1px solid var(--accent); border-radius: 50%; opacity: .9; }
.mw-mark .tick { position: absolute; left: 9px; top: -1px; width: 16px; height: 0; border-top: 1px solid rgba(255,198,144,.55); }
.mw-mark .txt { position: absolute; left: 30px; top: -9px; white-space: nowrap; font-size: 11px; letter-spacing: .08em; color: var(--ink); }
.mw-mark .txt small { display: block; font-family: var(--font-mono); font-size: 9.5px; letter-spacing: 0; color: var(--ink-3); margin-top: 1px; }
.mw-mark.is-left .tick { left: -25px; }
.mw-mark.is-left .txt { left: auto; right: 30px; text-align: right; }
.mw-mark.is-bh .ring { border-color: var(--ink-2); width: 8px; height: 8px; left: -4px; top: -4px; }
.mw-mark.is-bh .tick { border-top-color: var(--ink-4); left: 6px; }
.mw-arm { position: absolute; left: 0; top: 0; font-size: 10px; letter-spacing: .22em; text-transform: uppercase; color: var(--ink-3);
  white-space: nowrap; pointer-events: none; will-change: transform; transition: opacity .6s var(--ease); }
@media (max-width: 720px) {
  .mw-curve { width: min(232px, calc(100vw - 32px)); padding: 8px 10px; }
  .mw-curve-note { display: none; }
  .mw-curve-legend { font-size: 9px; gap: 2px 8px; }
}
@media (max-height: 520px) { .mw-curve-note { display: none; } .mw-curve svg { max-height: 110px; } }
`;
