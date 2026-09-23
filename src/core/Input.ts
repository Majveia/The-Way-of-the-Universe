/**
 * Unified pointer / touch / wheel / keyboard input for the canvas.
 * Experiences receive a scoped handle (InputScope) whose subscriptions are
 * removed automatically on unmount.
 */
export type DragButton = 'primary' | 'secondary' | 'middle';

export interface DragInfo {
  /** Pointer delta in CSS pixels. */
  dx: number;
  dy: number;
  button: DragButton;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  /** Number of active touch pointers (1 for mouse). */
  pointers: number;
}
export interface WheelInfo {
  /** Normalised wheel delta: +1 ≈ one notch away (zoom out), negative = zoom in. */
  delta: number;
  x: number;
  y: number;
  shift: boolean;
  ctrl: boolean;
}
export interface PinchInfo {
  /** Ratio of current to previous finger distance (>1 = fingers apart = zoom in). */
  scale: number;
  /** Midpoint delta in CSS pixels. */
  dx: number;
  dy: number;
}
export interface TapInfo {
  x: number;
  y: number;
  /** Normalised device coords (-1..1, y up). */
  ndcX: number;
  ndcY: number;
  button: DragButton;
}

type Handler<T> = (e: T) => void;

class Emitter<T> {
  private hs = new Set<Handler<T>>();
  on(h: Handler<T>): () => void {
    this.hs.add(h);
    return () => this.hs.delete(h);
  }
  emit(e: T): void {
    for (const h of this.hs) h(e);
  }
}

export class Input {
  /** Currently held keys by KeyboardEvent.code (e.g. 'KeyW', 'ShiftLeft'). */
  readonly keys = new Set<string>();
  readonly pointer = { x: 0, y: 0, ndcX: 0, ndcY: 0, inside: false, down: false };
  /** performance.now() of the most recent user activity (for idle UI fade). */
  lastActivity = performance.now();

  readonly drag = new Emitter<DragInfo>();
  readonly wheel = new Emitter<WheelInfo>();
  readonly pinch = new Emitter<PinchInfo>();
  readonly tap = new Emitter<TapInfo>();
  readonly doubleTap = new Emitter<TapInfo>();
  readonly keydown = new Emitter<KeyboardEvent>();
  readonly keyup = new Emitter<KeyboardEvent>();
  readonly move = new Emitter<{ x: number; y: number; ndcX: number; ndcY: number }>();

  private active = new Map<number, { x: number; y: number; sx: number; sy: number; t: number; button: DragButton }>();
  private lastPinchDist = 0;
  private lastPinchMid = { x: 0, y: 0 };
  private lastTap = { t: 0, x: 0, y: 0 };
  private cleanup: Array<() => void> = [];

  constructor(private el: HTMLElement) {
    const on = <K extends keyof HTMLElementEventMap>(
      target: HTMLElement | Window,
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type, fn as EventListener, opts);
      this.cleanup.push(() => target.removeEventListener(type, fn as EventListener, opts));
    };
    el.style.touchAction = 'none';
    on(el, 'pointerdown', (e) => this.onDown(e));
    on(el, 'pointermove', (e) => this.onMove(e));
    on(el, 'pointerup', (e) => this.onUp(e));
    on(el, 'pointercancel', (e) => this.onUp(e, true));
    on(el, 'pointerleave', () => (this.pointer.inside = false));
    on(el, 'pointerenter', () => (this.pointer.inside = true));
    on(el, 'contextmenu', (e) => e.preventDefault());
    on(el, 'wheel', (e) => this.onWheel(e), { passive: false });
    on(window, 'keydown', (e) => this.onKey(e, true));
    on(window, 'keyup', (e) => this.onKey(e, false));
    on(window, 'blur', () => this.keys.clear());
    on(window, 'pointermove', () => (this.lastActivity = performance.now()));
  }

  private btn(e: PointerEvent): DragButton {
    return e.button === 2 ? 'secondary' : e.button === 1 ? 'middle' : 'primary';
  }

  private setPointer(e: PointerEvent): void {
    const r = this.el.getBoundingClientRect();
    this.pointer.x = e.clientX - r.left;
    this.pointer.y = e.clientY - r.top;
    this.pointer.ndcX = (this.pointer.x / Math.max(1, r.width)) * 2 - 1;
    this.pointer.ndcY = -((this.pointer.y / Math.max(1, r.height)) * 2 - 1);
  }

  private onDown(e: PointerEvent): void {
    this.lastActivity = performance.now();
    this.el.setPointerCapture?.(e.pointerId);
    this.setPointer(e);
    this.pointer.down = true;
    this.active.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now(), button: this.btn(e) });
    if (this.active.size === 2) {
      const [a, b] = [...this.active.values()];
      this.lastPinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      this.lastPinchMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
  }

  private onMove(e: PointerEvent): void {
    this.lastActivity = performance.now();
    this.setPointer(e);
    this.move.emit({ x: this.pointer.x, y: this.pointer.y, ndcX: this.pointer.ndcX, ndcY: this.pointer.ndcY });
    const p = this.active.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (this.active.size >= 2) {
      const [a, b] = [...this.active.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (this.lastPinchDist > 0) {
        this.pinch.emit({ scale: dist / this.lastPinchDist, dx: mid.x - this.lastPinchMid.x, dy: mid.y - this.lastPinchMid.y });
      }
      this.lastPinchDist = dist;
      this.lastPinchMid = mid;
      return;
    }
    this.drag.emit({ dx, dy, button: p.button, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey, pointers: 1 });
  }

  private onUp(e: PointerEvent, cancelled = false): void {
    const p = this.active.get(e.pointerId);
    this.active.delete(e.pointerId);
    this.pointer.down = this.active.size > 0;
    if (this.active.size < 2) this.lastPinchDist = 0;
    if (!p || cancelled) return;
    const moved = Math.hypot(e.clientX - p.sx, e.clientY - p.sy);
    const dur = performance.now() - p.t;
    if (moved < 6 && dur < 350) {
      this.setPointer(e);
      const info: TapInfo = { x: this.pointer.x, y: this.pointer.y, ndcX: this.pointer.ndcX, ndcY: this.pointer.ndcY, button: p.button };
      const now = performance.now();
      if (now - this.lastTap.t < 320 && Math.hypot(info.x - this.lastTap.x, info.y - this.lastTap.y) < 24) {
        this.doubleTap.emit(info);
        this.lastTap.t = 0;
      } else {
        this.tap.emit(info);
        this.lastTap = { t: now, x: info.x, y: info.y };
      }
    }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    this.lastActivity = performance.now();
    // Normalise across pixel / line / page modes and trackpads.
    let d = e.deltaY;
    if (e.deltaMode === 1) d *= 33;
    else if (e.deltaMode === 2) d *= 400;
    // Trackpad pinch arrives as ctrl+wheel.
    const delta = Math.max(-4, Math.min(4, d / 100));
    this.wheel.emit({ delta, x: e.offsetX, y: e.offsetY, shift: e.shiftKey, ctrl: e.ctrlKey });
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    this.lastActivity = performance.now();
    if (down) {
      this.keys.add(e.code);
      this.keydown.emit(e);
    } else {
      this.keys.delete(e.code);
      this.keyup.emit(e);
    }
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  /** A handle whose subscriptions are all removed by dispose(). */
  scope(): InputScope {
    return new InputScope(this);
  }

  dispose(): void {
    for (const c of this.cleanup) c();
    this.cleanup = [];
  }
}

export class InputScope {
  private offs: Array<() => void> = [];
  constructor(readonly input: Input) {}
  get keys(): ReadonlySet<string> {
    return this.input.keys;
  }
  get pointer() {
    return this.input.pointer;
  }
  isDown(code: string): boolean {
    return this.input.isDown(code);
  }
  onDrag(h: Handler<DragInfo>) {
    return this.track(this.input.drag.on(h));
  }
  onWheel(h: Handler<WheelInfo>) {
    return this.track(this.input.wheel.on(h));
  }
  onPinch(h: Handler<PinchInfo>) {
    return this.track(this.input.pinch.on(h));
  }
  onTap(h: Handler<TapInfo>) {
    return this.track(this.input.tap.on(h));
  }
  onDoubleTap(h: Handler<TapInfo>) {
    return this.track(this.input.doubleTap.on(h));
  }
  onKeyDown(h: Handler<KeyboardEvent>) {
    return this.track(this.input.keydown.on(h));
  }
  onKeyUp(h: Handler<KeyboardEvent>) {
    return this.track(this.input.keyup.on(h));
  }
  onMove(h: Handler<{ x: number; y: number; ndcX: number; ndcY: number }>) {
    return this.track(this.input.move.on(h));
  }
  private track(off: () => void): () => void {
    this.offs.push(off);
    return off;
  }
  dispose(): void {
    for (const o of this.offs) o();
    this.offs = [];
  }
}
