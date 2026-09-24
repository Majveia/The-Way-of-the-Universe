/**
 * Cosmic-time scrubber for the bottom-right corner: play/pause, a hairline track showing how
 * much of history has been simulated so far (like a video buffer), epoch ticks, the playhead,
 * the current redshift and a speed chip. Keyboard: ←/→ on the focused track.
 */
import { ICONS } from '../../ui/icons';

export interface TimelineHandlers {
  scrub(u: number, done: boolean): void;
  toggle(): void;
  speed(): void;
}

export class TimelineWidget {
  readonly el: HTMLElement;
  private play: HTMLButtonElement;
  private track: HTMLElement;
  private buffer: HTMLElement;
  private fill: HTMLElement;
  private head: HTMLElement;
  private ticksEl: HTMLElement;
  private zEl: HTMLElement;
  private speedEl: HTMLButtonElement;
  private busyEl: HTMLElement;
  private dragging = false;
  private last = { u: -1, b: -1, playing: false, z: '', s: '', busy: '' };

  constructor(private h: TimelineHandlers) {
    const el = document.createElement('div');
    el.className = 'cw-timeline';
    this.el = el;
    this.play = document.createElement('button');
    this.play.type = 'button';
    this.play.className = 'icon-btn cw-play';
    this.play.innerHTML = ICONS.play;
    this.play.setAttribute('aria-label', 'Play (Space)');
    this.play.addEventListener('click', () => this.h.toggle());
    const track = document.createElement('div');
    track.className = 'cw-track';
    track.tabIndex = 0;
    track.setAttribute('role', 'slider');
    track.setAttribute('aria-label', 'Cosmic time');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    track.innerHTML = '<div class="cw-rail"></div><div class="cw-buffer"></div><div class="cw-fill"></div><div class="cw-ticks"></div><div class="cw-head"></div>';
    this.track = track;
    this.buffer = track.querySelector('.cw-buffer') as HTMLElement;
    this.fill = track.querySelector('.cw-fill') as HTMLElement;
    this.head = track.querySelector('.cw-head') as HTMLElement;
    this.ticksEl = track.querySelector('.cw-ticks') as HTMLElement;
    const meta = document.createElement('div');
    meta.className = 'cw-meta';
    this.zEl = document.createElement('span');
    this.zEl.className = 'cw-z';
    this.busyEl = document.createElement('span');
    this.busyEl.className = 'cw-busy';
    this.speedEl = document.createElement('button');
    this.speedEl.type = 'button';
    this.speedEl.className = 'chip cw-speed';
    this.speedEl.setAttribute('aria-label', 'Playback speed ([ and ])');
    this.speedEl.addEventListener('click', () => this.h.speed());
    meta.append(this.busyEl, this.zEl, this.speedEl);
    el.append(this.play, track, meta);

    const toU = (clientX: number) => {
      const r = track.getBoundingClientRect();
      return Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width)));
    };
    track.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.dragging = true;
      track.setPointerCapture(e.pointerId);
      this.h.scrub(toU(e.clientX), false);
    });
    track.addEventListener('pointermove', (e) => {
      if (this.dragging) this.h.scrub(toU(e.clientX), false);
    });
    const end = (e: PointerEvent) => {
      if (!this.dragging) return;
      this.dragging = false;
      this.h.scrub(toU(e.clientX), true);
    };
    track.addEventListener('pointerup', end);
    track.addEventListener('pointercancel', end);
    track.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        const du = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 0.05 : 0.01);
        this.h.scrub(Math.min(1, Math.max(0, this.last.u + du)), true);
      }
    });
  }

  get isDragging(): boolean {
    return this.dragging;
  }

  setTicks(ticks: Array<{ u: number; label: string; major: boolean }>): void {
    this.ticksEl.innerHTML = '';
    for (const t of ticks) {
      const d = document.createElement('div');
      d.className = t.major ? 'cw-tick is-major' : 'cw-tick';
      d.style.left = `${(t.u * 100).toFixed(3)}%`;
      const s = document.createElement('span');
      s.textContent = t.label;
      d.appendChild(s);
      this.ticksEl.appendChild(d);
    }
  }

  update(u: number, buffered: number, playing: boolean, zText: string, speedText: string, busy: string): void {
    const L = this.last;
    if (Math.abs(u - L.u) > 1e-4) {
      const p = `${(u * 100).toFixed(3)}%`;
      this.fill.style.width = p;
      this.head.style.left = p;
      this.track.setAttribute('aria-valuenow', (u * 100).toFixed(1));
      L.u = u;
    }
    if (Math.abs(buffered - L.b) > 1e-4) {
      this.buffer.style.width = `${(buffered * 100).toFixed(3)}%`;
      L.b = buffered;
    }
    if (playing !== L.playing) {
      this.play.innerHTML = playing ? ICONS.pause : ICONS.play;
      this.play.setAttribute('aria-label', playing ? 'Pause (Space)' : 'Play (Space)');
      L.playing = playing;
    }
    if (zText !== L.z) {
      this.zEl.textContent = zText;
      this.track.setAttribute('aria-valuetext', zText);
      L.z = zText;
    }
    if (speedText !== L.s) {
      this.speedEl.textContent = speedText;
      L.s = speedText;
    }
    if (busy !== L.busy) {
      this.busyEl.textContent = busy;
      this.busyEl.classList.toggle('is-on', !!busy);
      L.busy = busy;
    }
  }
}
