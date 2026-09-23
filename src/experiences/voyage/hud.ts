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
  font: 400 10.5px/1.2 var(--font-ui); letter-spacing:.08em; color: var(--ink-2); transition: opacity .4s var(--ease); }
.vy-label b { font-weight:400; color: var(--ink); }
.vy-label i { font-style:normal; font-family: var(--font-mono); font-size:9.5px; color: var(--ink-3); margin-left:.5em; }
.vy-label.cool b { color: var(--cool); }
.vy-reticle { position:absolute; left:0; top:0; pointer-events:none; will-change:transform; transition: opacity .5s var(--ease); }
.vy-reticle svg { display:block; overflow:visible; }
.vy-reticle .vy-rt { position:absolute; left: 22px; top: -9px; white-space:nowrap; font: 400 11px/1.35 var(--font-ui); letter-spacing:.1em; color: var(--accent); }
.vy-reticle .vy-rt span { display:block; font-family: var(--font-mono); font-size:10px; letter-spacing:.02em; color: var(--ink-2); }
.vy-flight { min-width: 210px; max-width: 280px; text-align: right; font: 400 11px/1.5 var(--font-ui); color: var(--ink-2); letter-spacing: .04em; }
.vy-flight .vy-fl-name { font-size: 10px; letter-spacing: .26em; text-transform: uppercase; color: var(--ink-3); }
.vy-flight .vy-fl-phase { color: var(--ink); font-size: 12.5px; letter-spacing: .03em; }
.vy-flight .vy-fl-bar { height:1px; background: var(--line-strong); margin: 7px 0 5px; position: relative; overflow: hidden; }
.vy-flight .vy-fl-bar i { position:absolute; left:0; top:0; bottom:0; background: var(--accent); transform-origin: left center; }
.vy-flight .vy-fl-eta { font-family: var(--font-mono); font-size: 10.5px; color: var(--ink-3); }
.vy-flight .vy-fl-tag { display:inline-block; margin-top:6px; font-size:9.5px; letter-spacing:.2em; text-transform:uppercase; color: var(--cool); }
@media (max-width: 720px) { .vy-flight { text-align: left; } }
`;

export class Hud {
  private root: HTMLElement;
  private labels: HTMLElement[] = [];
  private reticle: HTMLElement;
  private reticleText: HTMLElement;
  private reticleSub: HTMLElement;
  private style: HTMLStyleElement;
  private v = new THREE.Vector3();
  private boxes: Array<[number, number, number, number]> = [];
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

  update(items: readonly LabelItem[], target: LabelItem | null, camera: THREE.Camera, w: number, h: number): void {
    // Reticle first (it reserves its space).
    this.boxes.length = 0;
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

    let k = 0;
    if (this.labelsOn) {
      const sorted = [...items].sort((a, b) => b.priority - a.priority);
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
