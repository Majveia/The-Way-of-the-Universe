/**
 * Small hairline plots for the Cosmic Web panel: the expansion history a(t) and the matter
 * power spectrum P(k). Canvas 2D, device-pixel sharp, house colours (ink, 4200 K accent,
 * 10 000 K cool). Redrawn only when their inputs change.
 */
import type { Expansion } from '../../physics/cosmosExpansion';
import type { PowerSpectrumSample } from '../../worlds/cosmicweb/types';

const INK = 'rgba(236, 232, 225, 0.92)';
const INK2 = 'rgba(236, 232, 225, 0.55)';
const INK3 = 'rgba(236, 232, 225, 0.34)';
const LINE = 'rgba(236, 232, 225, 0.14)';
const ACCENT = '#ffc690';
const COOL = '#aecbff';
const MONO = "9.5px 'IBM Plex Mono', ui-monospace, monospace";

function makeCanvas(w: number, h: number, label: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.style.width = `${w}px`;
  c.style.height = `${h}px`;
  c.style.display = 'block';
  c.setAttribute('role', 'img');
  c.setAttribute('aria-label', label);
  return c;
}

function prep(c: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D | null {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const W = Math.round(w * dpr), H = Math.round(h * dpr);
  if (c.width !== W || c.height !== H) {
    c.width = W;
    c.height = H;
  }
  const g = c.getContext('2d');
  if (!g) return null;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return g;
}

export class ExpansionPlot {
  readonly el: HTMLCanvasElement;
  private w: number;
  private h: number;
  private e: Expansion | null = null;
  private ref: Expansion | null = null;
  private tMax = 1;
  private aMax = 2;
  private lastX = -1;

  constructor(w = 268, h = 128) {
    this.w = w;
    this.h = h;
    this.el = makeCanvas(w, h, 'Expansion history: scale factor a against cosmic time');
  }

  setModel(e: Expansion, ref: Expansion | null, tEnd: number): void {
    this.e = e;
    this.ref = ref;
    this.tMax = Math.max(tEnd, e.tToday * 1.9, ref ? ref.tToday * 1.9 : 0);
    if (e.recollapses && isFinite(e.tCrunch)) this.tMax = Math.max(this.tMax, e.tCrunch * 1.03);
    this.tMax = Math.min(this.tMax, e.tEnd);
    let am = 1.2;
    for (let i = 0; i <= 200; i++) am = Math.max(am, e.aAt((this.tMax * i) / 200));
    this.aMax = Math.min(3.2, am * 1.08);
    this.lastX = -1;
  }

  draw(tNow: number): void {
    const e = this.e;
    if (!e) return;
    const { w, h } = this;
    const L = 26, R = 8, T = 10, B = 20;
    const pw = w - L - R, ph = h - T - B;
    const X = (t: number) => L + (t / this.tMax) * pw;
    const Y = (a: number) => T + ph - (Math.min(a, this.aMax) / this.aMax) * ph;
    const xNow = Math.round(X(tNow) * 2);
    if (xNow === this.lastX) return;
    this.lastX = xNow;
    const g = prep(this.el, w, h);
    if (!g) return;
    g.lineWidth = 1;
    // Axes & grid
    g.strokeStyle = LINE;
    g.beginPath();
    g.moveTo(L, T);
    g.lineTo(L, T + ph);
    g.lineTo(L + pw, T + ph);
    g.stroke();
    g.font = MONO;
    g.fillStyle = INK3;
    g.textBaseline = 'top';
    const gyr = e.hubbleTimeGyr;
    const tMaxGyr = this.tMax * gyr;
    const step = tMaxGyr > 60 ? 20 : tMaxGyr > 30 ? 10 : 5;
    for (let s = 0; s <= tMaxGyr + 1e-6; s += step) {
      const x = X(s / gyr);
      g.fillRect(Math.round(x), T + ph, 1, 3);
      g.fillText(String(s), x - (s >= 10 ? 5 : 2.5), T + ph + 5);
    }
    g.fillText('Gyr', L + pw - 16, T + ph + 5);
    g.textBaseline = 'middle';
    for (const a of [1, 2, 3]) {
      if (a > this.aMax) break;
      const y = Y(a);
      g.fillStyle = INK3;
      g.fillText(String(a), 8, y);
      g.fillStyle = LINE;
      g.fillRect(L, Math.round(y), pw, 1);
    }
    g.fillStyle = INK2;
    g.fillText('a(t)', L + 6, T + 4);
    const curve = (ex: Expansion, color: string, dash: number[], width: number) => {
      g.strokeStyle = color;
      g.lineWidth = width;
      g.setLineDash(dash);
      g.beginPath();
      const n = 220;
      const tEnd = Math.min(this.tMax, ex.tEnd);
      for (let i = 0; i <= n; i++) {
        const t = (tEnd * i) / n;
        const a = ex.aAt(t);
        if (!(a > 0)) break;
        if (i === 0) g.moveTo(X(t), Y(a));
        else g.lineTo(X(t), Y(a));
      }
      g.stroke();
      g.setLineDash([]);
    };
    if (this.ref && this.ref !== e) curve(this.ref, INK3, [2, 3], 1);
    curve(e, ACCENT, [], 1.4);
    // Milestones
    g.font = MONO;
    g.textBaseline = 'bottom';
    const dot = (t: number, a: number, color: string, r = 2) => {
      g.fillStyle = color;
      g.beginPath();
      g.arc(X(t), Y(a), r, 0, Math.PI * 2);
      g.fill();
    };
    if (isFinite(e.tToday)) {
      dot(e.tToday, 1, INK, 1.8);
      g.fillStyle = INK2;
      g.fillText('today', X(e.tToday) - 32, Y(1) - 3);
    }
    if (isFinite(e.tAccel) && e.tAccel < this.tMax) {
      const aa = e.aAt(e.tAccel);
      g.fillStyle = INK3;
      g.fillRect(Math.round(X(e.tAccel)), Y(aa) + 3, 1, 5);
      g.fillText('ä>0', X(e.tAccel) + 3, Y(aa) + 12);
    }
    if (e.recollapses && isFinite(e.tTurn)) {
      dot(e.tTurn, e.aMax, INK2, 1.6);
      g.fillStyle = INK3;
      g.fillText('turnaround', X(e.tTurn) - 26, Y(e.aMax) - 3);
      if (isFinite(e.tCrunch) && e.tCrunch <= this.tMax * 1.001) {
        g.fillText('crunch', X(e.tCrunch) - 34, T + ph - 3);
      }
    }
    // Now
    const aNow = e.aAt(tNow);
    g.fillStyle = 'rgba(174, 203, 255, 0.35)';
    g.fillRect(Math.round(X(tNow)), T, 1, ph);
    dot(tNow, aNow, COOL, 2.4);
  }
}

export class PowerPlot {
  readonly el: HTMLCanvasElement;
  private w: number;
  private h: number;
  private last: PowerSpectrumSample | null = null;
  private range: { k0: number; k1: number; p0: number; p1: number } | null = null;

  constructor(w = 268, h = 118) {
    this.w = w;
    this.h = h;
    this.el = makeCanvas(w, h, 'Matter power spectrum: simulation against linear theory');
  }

  /** Fix the axis range for a run (so the curve visibly grows with time). */
  setRange(k0: number, k1: number, p0: number, p1: number): void {
    this.range = { k0, k1, p0, p1 };
    this.last = null;
  }

  draw(pk: PowerSpectrumSample | null): void {
    if (pk === this.last) return;
    this.last = pk;
    const { w, h } = this;
    const g = prep(this.el, w, h);
    if (!g) return;
    const L = 26, R = 8, T = 10, B = 20;
    const pw = w - L - R, ph = h - T - B;
    const rg = this.range ?? { k0: 0.02, k1: 2, p0: 1, p1: 1e5 };
    const X = (k: number) => L + ((Math.log10(k) - Math.log10(rg.k0)) / (Math.log10(rg.k1) - Math.log10(rg.k0))) * pw;
    const Y = (p: number) => T + ph - ((Math.log10(Math.max(p, rg.p0)) - Math.log10(rg.p0)) / (Math.log10(rg.p1) - Math.log10(rg.p0))) * ph;
    g.strokeStyle = LINE;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(L, T);
    g.lineTo(L, T + ph);
    g.lineTo(L + pw, T + ph);
    g.stroke();
    g.font = MONO;
    g.fillStyle = INK3;
    g.textBaseline = 'top';
    for (let e = Math.ceil(Math.log10(rg.k0)); e <= Math.floor(Math.log10(rg.k1)); e++) {
      const x = X(10 ** e);
      g.fillRect(Math.round(x), T + ph, 1, 3);
      g.fillText(e === 0 ? '1' : `10${e < 0 ? '⁻' : ''}${String(Math.abs(e)).replace(/\d/g, (d) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[+d])}`, x - 7, T + ph + 5);
    }
    g.fillText('k h/Mpc', L + pw - 38, T + ph + 5);
    g.textBaseline = 'middle';
    g.fillStyle = INK2;
    g.fillText('P(k)', L + 6, T + 4);
    if (!pk) return;
    const line = (arr: Float32Array, color: string, dash: number[], width: number) => {
      g.strokeStyle = color;
      g.lineWidth = width;
      g.setLineDash(dash);
      g.beginPath();
      let started = false;
      for (let i = 0; i < pk.k.length; i++) {
        const k = pk.k[i], p = arr[i];
        if (!(p > 0) || k < rg.k0 || k > rg.k1) continue;
        if (!started) g.moveTo(X(k), Y(p));
        else g.lineTo(X(k), Y(p));
        started = true;
      }
      g.stroke();
      g.setLineDash([]);
    };
    line(pk.Plin, INK3, [2, 3], 1);
    line(pk.P, ACCENT, [], 1.4);
    g.textBaseline = 'bottom';
    g.fillStyle = INK3;
    g.fillText('linear', L + pw - 36, T + 12);
    g.fillStyle = ACCENT;
    g.fillText('simulation', L + pw - 58, T + 24);
  }
}
