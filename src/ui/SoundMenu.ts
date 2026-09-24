import type { SoundOptions } from '../audio/AudioBus';

/** What the interface needs from the audio bus (AudioBus satisfies this structurally). */
export interface SoundControls {
  readonly enabled: boolean;
  readonly volume: number;
  readonly options: SoundOptions;
  enable(): Promise<void>;
  disable(): void;
  setVolume(v: number): void;
  setOption<K extends keyof SoundOptions>(key: K, value: SoundOptions[K]): void;
  onChange(f: () => void): () => void;
  describe(): { mood: string; key: string; origin: string };
  event(name: string): void;
}

let uid = 0;

/**
 * The small popover under the sound button: master on/off, volume, the space-jazz layer,
 * ambience, interface ticks, and a line naming the current key and where it comes from.
 */
export class SoundMenu {
  readonly el: HTMLElement;
  private master: HTMLInputElement;
  private vol: HTMLInputElement;
  private volOut: HTMLOutputElement;
  private music: HTMLInputElement;
  private amb: HTMLInputElement;
  private ui: HTMLInputElement;
  private keyEl: HTMLElement;
  private originEl: HTMLElement;
  onToggle?: (open: boolean) => void;

  constructor(parent: HTMLElement, private sound: SoundControls) {
    const n = ++uid;
    this.el = document.createElement('div');
    this.el.className = 'sound-menu';
    this.el.hidden = true;
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-label', 'Sound');
    const sw = (id: string, label: string, sub: string) => `
      <div class="snd-row snd-toggle">
        <input type="checkbox" role="switch" id="${id}-${n}" />
        <label for="${id}-${n}"><span class="snd-text"><span class="snd-label">${label}</span>${sub ? `<span class="snd-sub">${sub}</span>` : ''}</span><span class="pnl-switch" aria-hidden="true"></span></label>
      </div>`;
    this.el.innerHTML = `
      <div class="snd-head">
        ${sw('snd-master', 'Sound', '')}
      </div>
      <div class="snd-row snd-volume">
        <label for="snd-vol-${n}"><span class="snd-label">Volume</span><output class="pnl-value"></output></label>
        <input type="range" id="snd-vol-${n}" min="0" max="100" step="1" />
      </div>
      ${sw('snd-music', 'Space jazz', 'Modal piano, walking bass, brushes')}
      ${sw('snd-amb', 'Ambience', 'Pads, drones and bells of each world')}
      ${sw('snd-ui', 'Interface sounds', 'Very quiet ticks')}
      <div class="snd-now"><span class="snd-key"></span><span class="snd-origin"></span></div>`;
    const $ = (s: string) => this.el.querySelector(s) as HTMLInputElement;
    this.master = $(`#snd-master-${n}`);
    this.vol = $(`#snd-vol-${n}`);
    this.volOut = this.el.querySelector('.snd-volume output') as HTMLOutputElement;
    this.music = $(`#snd-music-${n}`);
    this.amb = $(`#snd-amb-${n}`);
    this.ui = $(`#snd-ui-${n}`);
    this.keyEl = this.el.querySelector('.snd-key') as HTMLElement;
    this.originEl = this.el.querySelector('.snd-origin') as HTMLElement;

    this.master.addEventListener('change', () => {
      if (this.master.checked) void sound.enable();
      else sound.disable();
    });
    this.vol.addEventListener('input', () => {
      const v = Number(this.vol.value) / 100;
      sound.setVolume(v);
      if (!sound.enabled && v > 0) void sound.enable();
    });
    this.music.addEventListener('change', () => {
      sound.setOption('music', this.music.checked);
      if (this.music.checked && !sound.enabled) void sound.enable();
    });
    this.amb.addEventListener('change', () => sound.setOption('ambience', this.amb.checked));
    this.ui.addEventListener('change', () => {
      sound.setOption('ui', this.ui.checked);
      if (this.ui.checked) sound.event('ui-select');
    });
    sound.onChange(() => this.sync());
    parent.appendChild(this.el);
    this.sync();
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  sync(): void {
    const s = this.sound;
    this.master.checked = s.enabled;
    this.vol.value = String(Math.round(s.volume * 100));
    this.vol.style.setProperty('--p', String(s.volume));
    this.volOut.textContent = `${Math.round(s.volume * 100)}%`;
    this.music.checked = s.options.music;
    this.amb.checked = s.options.ambience;
    this.ui.checked = s.options.ui;
    this.el.classList.toggle('is-off', !s.enabled);
    const d = s.describe();
    this.keyEl.textContent = d.mood === 'silence' ? '' : `In ${d.key}`;
    this.originEl.textContent = d.mood === 'silence' ? '' : d.origin;
  }

  open(): void {
    this.sync();
    this.el.hidden = false;
    this.master.focus({ preventScroll: true });
    this.onToggle?.(true);
  }

  close(): void {
    if (this.el.hidden) return;
    this.el.hidden = true;
    this.onToggle?.(false);
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }
}
