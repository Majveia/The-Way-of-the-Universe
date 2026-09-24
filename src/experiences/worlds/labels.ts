import * as THREE from 'three';
import type { SystemData, SystemLayer } from '../../worlds/systems';

/**
 * Hairline labels beside each planet (letter + given name), the star, and the habitable zone /
 * snow line. DOM in the UI overlay; positions updated per frame with transforms only.
 */
export class Labels {
  private root = document.createElement('div');
  private planets: HTMLElement[] = [];
  private star: HTMLElement;
  private hz: HTMLElement;
  private snow: HTMLElement;
  private visible = true;
  private selected = -1;
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private starScreen = new THREE.Vector3();

  constructor(parent: HTMLElement, onPlanet: (i: number) => void, onStar: () => void) {
    this.root.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden';
    parent.appendChild(this.root);
    this.star = this.make('label-star');
    this.star.addEventListener('click', onStar);
    this.hz = this.make('');
    this.hz.style.color = 'rgba(127,227,180,0.55)';
    this.hz.style.pointerEvents = 'none';
    this.hz.textContent = 'habitable zone';
    this.snow = this.make('');
    this.snow.style.color = 'rgba(174,203,255,0.45)';
    this.snow.style.pointerEvents = 'none';
    this.snow.textContent = 'snow line';
    this.onPlanet = onPlanet;
  }
  private onPlanet: (i: number) => void;

  private make(cls: string): HTMLElement {
    const e = document.createElement('div');
    e.className = cls;
    e.style.cssText =
      'position:absolute;left:0;top:0;white-space:nowrap;font:300 11px/1 var(--font-ui);letter-spacing:.06em;color:var(--ink-2);pointer-events:auto;cursor:pointer;will-change:transform;text-shadow:0 0 6px #000;transition:opacity .4s, color .3s;opacity:0';
    this.root.appendChild(e);
    return e;
  }

  build(sys: SystemData): void {
    for (const e of this.planets) e.remove();
    this.planets = sys.planets.map((p, i) => {
      const e = this.make('');
      e.innerHTML = `<span style="font:400 10px var(--font-mono);color:var(--ink-3);margin-right:6px">${p.letter}</span>${p.givenName}`;
      e.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.onPlanet(i);
      });
      return e;
    });
    this.star.textContent = sys.name;
    this.selected = -1;
    this.widths = [];
    this.starW = 0;
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.root.style.opacity = v ? '1' : '0';
  }

  setSelected(i: number): void {
    this.selected = i;
    this.planets.forEach((e, k) => (e.style.color = k === i ? 'var(--accent)' : 'var(--ink-2)'));
  }

  private boxes: number[] = [];
  private widths: number[] = [];
  private starW = 0;

  /** Greedy de-cluttering: labels are placed by priority and hidden when they would overlap. */
  private fits(x: number, y: number, w: number, h: number): boolean {
    const b = this.boxes;
    for (let i = 0; i < b.length; i += 4) if (x < b[i + 2] && x + w > b[i] && y < b[i + 3] && y + h > b[i + 1]) return false;
    b.push(x, y, x + w, y + h);
    return true;
  }

  update(layer: SystemLayer, camera: THREE.PerspectiveCamera, w: number, h: number, show: boolean): void {
    const on = show && this.visible;
    this.root.style.display = on ? '' : 'none';
    if (!on) return;
    if (this.widths.length !== this.planets.length) this.widths = this.planets.map((e) => e.offsetWidth || 80);
    this.boxes.length = 0;
    // Reserve the planets' own disks and the star so labels do not cover them.
    const s = layer.project(layer.starPos, camera, w, h, this.starScreen);
    const srpx = Math.max(4, layer.pixelRadius(layer.starPos, layer.starRadius, camera, h));
    if (s.z <= 1) this.boxes.push(s.x - srpx, s.y - srpx, s.x + srpx, s.y + srpx);
    const order = layer.bodies.map((_, i) => i).sort((a, b) => (a === this.selected ? -1 : b === this.selected ? 1 : layer.bodies[b].data.radius - layer.bodies[a].data.radius));
    for (const i of order) {
      const b = layer.bodies[i];
      const e = this.planets[i];
      if (!e) continue;
      const sp = layer.project(b.pos, camera, w, h, this.tmp);
      const rpx = layer.pixelRadius(b.pos, b.displayRadius, camera, h);
      const x = sp.x + rpx + 7, y = sp.y - 6;
      const off = sp.z > 1 || sp.x < -50 || sp.x > w + 50 || sp.y < -20 || sp.y > h + 20 || !this.fits(x, y, this.widths[i], 12);
      e.style.opacity = off ? '0' : i === this.selected ? '1' : '0.85';
      e.style.pointerEvents = off ? 'none' : 'auto';
      if (!off) e.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    }
    if (!this.starW) this.starW = this.star.offsetWidth;
    const sw = this.starW || 50;
    const sx = s.x - sw / 2, sy = s.y + srpx * 0.75 + 8;
    const starOk = s.z <= 1 && this.fits(sx, sy, sw, 12);
    this.star.style.opacity = starOk ? '0.7' : '0';
    if (starOk) this.star.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px)`;
    // Zone labels where each ring meets the screen's right-hand side (camera right, in-plane).
    const dir = this.tmp2.set(1, 0, 0).applyQuaternion(camera.quaternion);
    dir.y = 0;
    if (dir.lengthSq() < 1e-12) dir.set(1, 0, 0);
    dir.normalize();
    const hzR = layer.mapRadius(layer.sys.hz.maxGreenhouse);
    this.place(this.hz, layer, camera, w, h, dir, hzR, true);
    this.place(this.snow, layer, camera, w, h, dir, layer.mapRadius(layer.sys.snowLine), true);
  }

  private place(el: HTMLElement, layer: SystemLayer, camera: THREE.PerspectiveCamera, w: number, h: number, dir: THREE.Vector3, r: number, ok: boolean): void {
    const p = this.tmp.copy(dir).multiplyScalar(r);
    const sp = layer.project(p, camera, w, h, p);
    const x = sp.x + 6, y = sp.y - 14;
    const off = !ok || sp.z > 1 || sp.x < 0 || x + 96 > w || sp.y < 0 || sp.y > h || !this.fits(x, y, 90, 12);
    el.style.opacity = off ? '0' : '1';
    if (!off) el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  }

  dispose(): void {
    this.root.remove();
  }
}
