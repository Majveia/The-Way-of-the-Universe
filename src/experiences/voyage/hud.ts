import * as THREE from 'three';

/**
 * Minimal DOM overlay: hairline star labels (decluttered) and a target reticle.
 * Uses the house CSS variables; everything lives in the experience's UIScope overlay.
 */
export interface LabelItem {
  /** World direction (observed). */
  dir: THREE.Vector3;
  text: string;
  sub?: string;
  /** Larger = more important (kept when labels collide). */
  priority: number;
  cool?: boolean;
}

const css = `
.vy-label { position:absolute; left:0; top:0; white-space:nowrap; pointer-events:none; will-change:transform;
  font: 400 10.5px/1.2 var(--font-ui); letter-spacing:.08em; color: var(--ink-2); text-shadow: 0 0 4px #000, 0 0 10px rgba(0,0,0,.8); transition: opacity .4s var(--ease); }
.vy-label b { font-weight:400; color: var(--ink); }
.vy-label i { font-style:normal; font-family: var(--font-mono); font-size:9.5px; color: var(--ink-3); margin-left:.5em; }
.vy-label.cool b { color: var(--cool); }
.vy-reticle { position:absolute; left:0; top:0; pointer-events:none; will-change:transform; transition: opacity .5s var(--ease); }
.vy-reticle svg { display:block; overflow:visible; }
.vy-reticle .vy-rt { position:absolute; left: 22px; top: -9px; white-space:nowrap; font: 400 11px/1.35 var(--font-ui); letter-spacing:.1em; color: var(--accent); text-shadow: 0 0 4px #000, 0 0 12px #000, 0 0 20px rgba(0,0,0,.8); }
.vy-reticle .vy-rt span { display:block; font-family: var(--font-mono); font-size:10px; letter-spacing:.02em; color: var(--ink-2); }
.vy-home { position:absolute; left:0; top:0; pointer-events:none; will-change:transform; transition: opacity .6s var(--ease); }
.vy-home svg { display:block; overflow:visible; }
.vy-home .vy-hm { position:absolute; left: 34px; top: -8px; white-space:nowrap; font: 400 10.5px/1.35 var(--font-ui); letter-spacing:.12em; color: var(--cool); text-shadow: 0 0 4px #000, 0 0 12px #000; }
.vy-home .vy-hm span { display:block; font-family: var(--font-mono); font-size:9.5px; letter-spacing:.02em; color: var(--ink-3); }
.vy-caption { position:absolute; left:50%; bottom: 19%; transform: translate(-50%, 8px); width: min(540px, 62vw); text-align:center; pointer-events:none; opacity:0; transition: opacity 1.2s var(--ease), transform 1.2s var(--ease); text-shadow: 0 0 6px #000, 0 0 18px #000; }
.vy-caption.on { opacity:1; transform: translate(-50%, 0); }
.vy-caption .vy-cap-t { font: 300 22px/1.2 var(--font-ui); letter-spacing: .06em; color: var(--ink); margin-bottom: 8px; }
.vy-caption .vy-cap-x { font: 400 13px/1.55 var(--font-ui); letter-spacing: .02em; color: var(--ink-2); }
@media (max-width: 720px) { .vy-caption { bottom: 40%; width: 86vw; } .vy-caption .vy-cap-t { font-size: 18px; } }
.vy-flight { min-width: 210px; max-width: 300px; text-align: right; font: 400 11px/1.5 var(--font-ui); color: var(--ink-2); letter-spacing: .04em; }
.vy-flight .vy-fl-name { font-size: 11px; letter-spacing: .14em; color: var(--ink-3); }
.vy-flight .vy-fl-phase { color: var(--ink); font-size: 12.5px; letter-spacing: .03em; }
.vy-flight .vy-fl-bar { height:1px; background: var(--line-strong); margin: 7px 0 5px; position: relative; overflow: hidden; }
.vy-flight .vy-fl-bar i { position:absolute; left:0; top:0; bottom:0; background: var(--accent); transform-origin: left center; }
.vy-flight .vy-fl-eta { font-family: var(--font-mono); font-size: 10.5px; color: var(--ink-3); white-space: pre-line; }
.vy-flight .vy-fl-crumb { font-size: 9.5px; letter-spacing: .16em; text-transform: uppercase; color: var(--ink-3); margin-bottom: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: right; }
.vy-flight .vy-fl-scale { margin-top: 8px; display: flex; align-items: center; justify-content: flex-end; gap: 8px; font-family: var(--font-mono); font-size: 10px; color: var(--ink-3); }
.vy-flight .vy-fl-scale i { display: block; height: 5px; border: 1px solid var(--ink-3); border-top: 0; min-width: 4px; }
.vy-flight .vy-fl-tag { display:inline-block; margin-top:6px; font-size:9.5px; letter-spacing:.2em; text-transform:uppercase; color: var(--cool); }
@media (max-width: 720px) { .vy-flight { text-align: left; } .vy-flight .vy-fl-crumb { text-align: left; } .vy-flight .vy-fl-scale { justify-content: flex-start; } }
`;

export class Hud {
  private root: HTMLElement;
  private labels: HTMLElement[] = [];
  private reticle: HTMLElement;
  private reticleText: HTMLElement;
  private reticleSub: HTMLElement;
  private home: HTMLElement;
  private homeText: HTMLElement;
  private homeSub: HTMLElement;
  private style: HTMLStyleElement;
  private v = new THREE.Vector3();
  private boxes: Array<[number, number, number, number]> = [];
  private uiBoxes: Array<[number, number, number, number]> = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  labelsOn = true;

  constructor(overlay: HTMLElement, maxLabels = 28) {
    this.style = document.createElement('style');
    this.style.textContent = css;
    document.head.appendChild(this.style);
    this.root = document.createElement('div');
    this.root.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;';
    overlay.appendChild(this.root);
    for (let i = 0; i < maxLabels; i++) {
      const l = document.createElement('div');
      l.className = 'vy-label';
      l.style.opacity = '0';
      this.root.appendChild(l);
      this.labels.push(l);
    }
    this.reticle = document.createElement('div');
    this.reticle.className = 'vy-reticle';
    this.reticle.innerHTML = `<svg width="0" height="0"><circle cx="0" cy="0" r="13" fill="none" stroke="var(--accent)" stroke-width="1" stroke-opacity="0.85"/>
      <path d="M-19 0h-5M19 0h5M0 -19v-5M0 19v5" stroke="var(--accent)" stroke-width="1" stroke-opacity="0.6"/></svg><div class="vy-rt"><b></b><span></span></div>`;
    this.reticleText = this.reticle.querySelector('.vy-rt b') as HTMLElement;
    this.reticleSub = this.reticle.querySelector('.vy-rt span') as HTMLElement;
    this.reticleText.style.fontWeight = '400';
    this.root.appendChild(this.reticle);
    this.home = document.createElement('div');
    this.home.className = 'vy-home';
    this.home.style.opacity = '0';
    this.home.innerHTML = `<svg width="0" height="0"><circle cx="0" cy="0" r="5" fill="none" stroke="var(--cool)" stroke-width="1"/><path d="M6 0h22" stroke="var(--cool)" stroke-width="1" stroke-opacity="0.6"/></svg><div class="vy-hm"><b></b><span></span></div>`;
    this.homeText = this.home.querySelector('.vy-hm b') as HTMLElement;
    this.homeText.style.fontWeight = '400';
    this.homeSub = this.home.querySelector('.vy-hm span') as HTMLElement;
    this.root.appendChild(this.home);
  }

  /** Project a world direction (camera at the origin) to CSS pixels; null if behind or off-screen. */
  private project(dir: THREE.Vector3, camera: THREE.Camera, w: number, h: number): [number, number] | null {
    const p = this.v.copy(dir).applyMatrix3(_rot.setFromMatrix4(camera.matrixWorldInverse));
    if (p.z >= -1e-6) return null;
    p.applyMatrix4(camera.projectionMatrix);
    // (camera-relative: the projection of a direction equals that of a far point)
    const x = (p.x * 0.5 + 0.5) * w;
    const y = (-p.y * 0.5 + 0.5) * h;
    if (x < -40 || x > w + 40 || y < -40 || y > h + 40) return null;
    return [x, y];
  }

  update(items: readonly LabelItem[], target: LabelItem | null, camera: THREE.Camera, w: number, h: number, reserved?: readonly [number, number, number, number][], home: LabelItem | null = null): void {
    // Reserved areas (e.g. the ship), then the reticle.
    this.boxes.length = 0;
    if (reserved) for (const b of reserved) this.boxes.push(b);
    // Keep star names off the interface chrome: title (top-left), readouts (bottom-left), flight status
    // (bottom-right) and the top-right toolbar.
    const ui = this.uiBoxes;
    const narrow = w < 720;
    ui[0][2] = narrow ? w : 290; ui[0][3] = 124;
    ui[1][1] = h - (narrow ? 300 : 150); ui[1][2] = narrow ? w : 300; ui[1][3] = h;
    ui[2][0] = w - 330; ui[2][1] = h - 175; ui[2][2] = w; ui[2][3] = h;
    ui[3][0] = w - 240; ui[3][2] = w; ui[3][3] = 60;
    for (const b of ui) this.boxes.push(b);
    let rp: [number, number] | null = null;
    if (target) rp = this.project(target.dir, camera, w, h);
    if (rp) {
      this.reticle.style.opacity = '1';
      this.reticle.style.transform = `translate3d(${rp[0].toFixed(1)}px, ${rp[1].toFixed(1)}px, 0)`;
      if (this.reticleText.textContent !== target!.text) this.reticleText.textContent = target!.text;
      const sub = target!.sub ?? '';
      if (this.reticleSub.textContent !== sub) this.reticleSub.textContent = sub;
      this.boxes.push([rp[0] - 26, rp[1] - 26, rp[0] + 190, rp[1] + 30]);
    } else this.reticle.style.opacity = '0';
    // "You are here" marker.
    const hp = home ? this.project(home.dir, camera, w, h) : null;
    if (hp && home) {
      this.home.style.opacity = '1';
      this.home.style.transform = `translate3d(${hp[0].toFixed(1)}px, ${hp[1].toFixed(1)}px, 0)`;
      if (this.homeText.textContent !== home.text) this.homeText.textContent = home.text;
      const sub = home.sub ?? '';
      if (this.homeSub.textContent !== sub) this.homeSub.textContent = sub;
      this.boxes.push([hp[0] - 8, hp[1] - 12, hp[0] + 200, hp[1] + 22]);
    } else this.home.style.opacity = '0';

    let k = 0;
    if (this.labelsOn) {
      const sorted = (items as LabelItem[]).sort(byPriority);
      for (const it of sorted) {
        if (k >= this.labels.length) break;
        const p = this.project(it.dir, camera, w, h);
        if (!p) continue;
        const bw = 7 * (it.text.length + (it.sub?.length ?? 0)) + 24;
        const box: [number, number, number, number] = [p[0] + 6, p[1] - 8, p[0] + 6 + bw, p[1] + 8];
        if (this.boxes.some((b) => !(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3]))) continue;
        this.boxes.push(box);
        const el = this.labels[k++];
        const html = `<b>${it.text}</b>${it.sub ? `<i>${it.sub}</i>` : ''}`;
        if (el.dataset.h !== html) {
          el.innerHTML = html;
          el.dataset.h = html;
        }
        el.classList.toggle('cool', !!it.cool);
        el.style.opacity = '1';
        el.style.transform = `translate3d(${(p[0] + 8).toFixed(1)}px, ${(p[1] - 7).toFixed(1)}px, 0)`;
      }
    }
    for (; k < this.labels.length; k++) this.labels[k].style.opacity = '0';
  }

  dispose(): void {
    this.root.remove();
    this.style.remove();
  }
}

const _rot = new THREE.Matrix3();
const byPriority = (a: LabelItem, b: LabelItem): number => b.priority - a.priority;
