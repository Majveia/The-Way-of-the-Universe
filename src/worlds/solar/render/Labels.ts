/**
 * Body labels in a DOM overlay: thin type beside a hairline tick, decluttered by priority
 * (Sun → planets → dwarf planets → moons → small bodies) and by on-screen proximity, fading in
 * and out smoothly. Positions are written as transforms only (no layout per frame).
 */

export interface LabelCandidate {
  id: string;
  text: string;
  /** CSS pixels. */
  x: number;
  y: number;
  /** Lower = more important. */
  priority: number;
  /** 0..1 desired visibility. */
  strength: number;
  /** Radius of the body on screen (CSS px), so the label clears the disc. */
  radius: number;
  selected: boolean;
  /** CSS colour of the tick. */
  tint: string;
}

interface El {
  root: HTMLDivElement;
  opacity: number;
  shown: boolean;
  width: number;
  lastX: number;
  lastY: number;
  lastO: number;
  selected: boolean;
}

const STYLE = `
.solar-labels { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
.solar-label { position: absolute; left: 0; top: 0; display: flex; align-items: center; gap: 6px; white-space: nowrap;
  font: 400 11px/1 var(--font-ui); letter-spacing: 0.1em; color: var(--ink-2); will-change: transform, opacity;
  pointer-events: auto; cursor: pointer; padding: 3px 4px; margin: -3px -4px; }
.solar-label .tick { width: 10px; height: 1px; background: currentColor; opacity: 0.55; flex: none; }
.solar-label.p0 { color: var(--ink); font-size: 12px; letter-spacing: 0.16em; text-transform: uppercase; }
.solar-label.p1 { color: var(--ink); font-size: 11.5px; letter-spacing: 0.14em; text-transform: uppercase; }
.solar-label.p2 { color: var(--ink-2); font-size: 11px; letter-spacing: 0.12em; }
.solar-label.p3, .solar-label.p4, .solar-label.p5 { color: var(--ink-3); font-size: 10.5px; letter-spacing: 0.08em; }
.solar-label.sel { color: var(--accent); }
.solar-label:hover { color: var(--ink); }
.solar-ann { position: absolute; left: 0; top: 0; font: 400 10px/1 var(--font-mono); letter-spacing: 0.06em; color: var(--ink-3);
  white-space: nowrap; will-change: transform, opacity; transform-origin: 0 50%; }
@media (max-width: 720px) { .solar-label.p3, .solar-label.p4, .solar-label.p5 { font-size: 10px; } }
`;

export class Labels {
  readonly root: HTMLDivElement;
  private style: HTMLStyleElement;
  private els = new Map<string, El>();
  private order: number[] = [];
  private placed: Array<{ x: number; y: number; w: number }> = [];
  private placedPool: Array<{ x: number; y: number; w: number }> = [];
  private seen = new Set<string>();
  visible = true;

  constructor(parent: HTMLElement, private onPick: (id: string) => void) {
    this.style = document.createElement('style');
    this.style.textContent = STYLE;
    parent.appendChild(this.style);
    this.root = document.createElement('div');
    this.root.className = 'solar-labels';
    parent.appendChild(this.root);
  }

  private el(c: LabelCandidate): El {
    let e = this.els.get(c.id);
    if (e) return e;
    const root = document.createElement('div');
    root.className = `solar-label p${Math.min(5, Math.max(0, c.priority))}`;
    const tick = document.createElement('span');
    tick.className = 'tick';
    tick.style.color = c.tint;
    const name = document.createElement('span');
    name.textContent = c.text;
    root.append(tick, name);
    root.style.opacity = '0';
    root.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.onPick(c.id);
    });
    root.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    this.root.appendChild(root);
    e = { root, opacity: 0, shown: false, width: 12 + c.text.length * 7.2, lastX: NaN, lastY: NaN, lastO: -1, selected: false };
    this.els.set(c.id, e);
    return e;
  }

  /** Place labels for this frame. `dt` in seconds for the fades. */
  update(cands: LabelCandidate[], count: number, dt: number, width: number, height: number): void {
    const order = this.order;
    order.length = 0;
    for (let i = 0; i < count; i++) order.push(i);
    order.sort((a, b) => {
      const A = cands[a], B = cands[b];
      if (A.selected !== B.selected) return A.selected ? -1 : 1;
      if (A.priority !== B.priority) return A.priority - B.priority;
      return B.strength - A.strength;
    });
    this.placed.length = 0;
    const k = 1 - Math.exp(-dt / 0.18);
    const seen = this.seen;
    seen.clear();
    for (const i of order) {
      const c = cands[i];
      const e = this.el(c);
      seen.add(c.id);
      const lx = c.x + Math.max(4, c.radius + 3);
      const ly = c.y;
      let ok = this.visible && c.strength > 0.02 && c.x > -40 && c.x < width + 10 && c.y > -10 && c.y < height + 10;
      if (ok) {
        for (const p of this.placed) {
          if (Math.abs(p.y - ly) < 14 && lx < p.x + p.w + 6 && lx + e.width + 6 > p.x) {
            ok = false;
            break;
          }
          // Keep a little air around every placed anchor too.
          if (Math.abs(p.y - ly) < 10 && Math.abs(p.x - lx) < 18) {
            ok = false;
            break;
          }
        }
      }
      if (ok) {
        const i2 = this.placed.length;
        const slot = this.placedPool[i2] ?? (this.placedPool[i2] = { x: 0, y: 0, w: 0 });
        slot.x = lx;
        slot.y = ly;
        slot.w = e.width;
        this.placed.push(slot);
      }
      const target = ok ? Math.min(1, c.strength) : 0;
      e.opacity += (target - e.opacity) * k;
      if (e.opacity < 0.004 && target === 0) e.opacity = 0;
      if (e.selected !== c.selected) {
        e.selected = c.selected;
        e.root.classList.toggle('sel', c.selected);
      }
      this.write(e, lx, ly, e.opacity);
    }
    // Fade out labels not offered this frame.
    for (const [id, e] of this.els) {
      if (seen.has(id)) continue;
      e.opacity += (0 - e.opacity) * k;
      if (e.opacity < 0.004) e.opacity = 0;
      this.write(e, e.lastX, e.lastY, e.opacity);
    }
  }

  private write(e: El, x: number, y: number, o: number): void {
    const vis = o > 0.003;
    if (vis !== e.shown) {
      e.shown = vis;
      e.root.style.visibility = vis ? 'visible' : 'hidden';
    }
    if (!vis) {
      if (e.lastO !== 0) {
        e.root.style.opacity = '0';
        e.lastO = 0;
      }
      return;
    }
    if (Math.abs(x - e.lastX) > 0.05 || Math.abs(y - e.lastY) > 0.05) {
      e.root.style.transform = `translate3d(${x.toFixed(1)}px, ${(y - 5.5).toFixed(1)}px, 0)`;
      e.lastX = x;
      e.lastY = y;
    }
    if (Math.abs(o - e.lastO) > 0.01) {
      e.root.style.opacity = o.toFixed(3);
      e.lastO = o;
    }
  }

  dispose(): void {
    this.root.remove();
    this.style.remove();
    this.els.clear();
  }
}
