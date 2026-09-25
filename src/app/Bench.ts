import type * as THREE from 'three';
import type { Engine } from '../core/Engine';
import type { ExperienceDef } from '../core/types';

/**
 * On-device performance benchmark.
 *
 * Visits every world, locks the render scale to 1 (so dynamic resolution cannot hide cost),
 * warms up, then samples whole frames:
 *   - frame interval (rAF → rAF; capped by the display's refresh rate),
 *   - CPU time inside the frame (JS + WebGL command submission),
 *   - GPU time per frame via EXT_disjoint_timer_query_webgl2 when the browser exposes it,
 *   - draw calls / triangles / points for the whole frame (renderer.info with autoReset off).
 * The report is shown in-page, can be copied, and — when the page runs as a Claude artifact with
 * the `db` capability — is saved to the artifact's database so it can be read back and acted on.
 */

export interface Stat {
  median: number;
  p95: number;
  mean: number;
}

export interface BenchWorldResult {
  id: string;
  title: string;
  ok: boolean;
  error?: string;
  frames: number;
  fps: number;
  frameMs: Stat;
  cpuMs: Stat;
  gpuMs: Stat | null;
  longFrames: number;
  drawCalls: number;
  triangles: number;
  points: number;
  lines: number;
  programs: number;
  textures: number;
  geometries: number;
  width: number;
  height: number;
  pixelRatio: number;
  loadMs: number;
}

export interface BenchReport {
  version: 1;
  startedAt: string;
  durationMs: number;
  quality: string;
  refreshHz: number;
  device: {
    gpu: string;
    vendor: string;
    userAgent: string;
    platform: string;
    devicePixelRatio: number;
    screen: [number, number];
    viewport: [number, number];
    cores: number;
    memoryGB: number | null;
    maxTextureSize: number;
    extensions: Record<string, boolean>;
  };
  results: BenchWorldResult[];
}

export interface BenchHost {
  engine: Engine;
  worlds: ExperienceDef[];
  go(id: string): Promise<void>;
  isReady(): boolean;
  currentId(): string | null;
  errors(): string[];
}

export interface BenchOptions {
  warmupMs?: number;
  measureMs?: number;
  /** Keep measuring until at least this many frames (slow devices), up to maxMeasureMs. */
  minFrames?: number;
  maxMeasureMs?: number;
  readyTimeoutMs?: number;
  onProgress?(i: number, n: number, title: string): void;
}

const EXT_NAMES = [
  'EXT_color_buffer_float',
  'EXT_color_buffer_half_float',
  'OES_texture_float_linear',
  'EXT_float_blend',
  'EXT_disjoint_timer_query_webgl2',
  'EXT_texture_filter_anisotropic',
  'OVR_multiview2',
  'WEBGL_multi_draw',
  'KHR_parallel_shader_compile',
];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

function stat(xs: number[]): Stat {
  if (!xs.length) return { median: 0, p95: 0, mean: 0 };
  const s = xs.slice().sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
  return { median: round(q(0.5)), p95: round(q(0.95)), mean: round(s.reduce((a, b) => a + b, 0) / s.length) };
}

interface TimerExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

/** Whole-frame sampler plugged into Engine.probe. */
class FrameSampler {
  intervals: number[] = [];
  cpu: number[] = [];
  gpu: number[] = [];
  drawCalls = 0;
  triangles = 0;
  points = 0;
  lines = 0;
  private lastBegin = 0;
  private beginT = 0;
  private recording = false;
  private gl: WebGL2RenderingContext;
  private ext: TimerExt | null;
  private pending: WebGLQuery[] = [];
  private free: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;
  private infoFrames = 0;

  constructor(private renderer: THREE.WebGLRenderer) {
    this.gl = renderer.getContext() as WebGL2RenderingContext;
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null;
  }

  get hasGpuTimer(): boolean {
    return this.ext !== null;
  }

  start(record: boolean): void {
    this.recording = record;
    this.intervals = [];
    this.cpu = [];
    this.gpu = [];
    this.drawCalls = this.triangles = this.points = this.lines = 0;
    this.infoFrames = 0;
    this.lastBegin = 0;
  }

  begin(): void {
    const now = performance.now();
    if (this.recording && this.lastBegin) this.intervals.push(now - this.lastBegin);
    this.lastBegin = now;
    this.beginT = now;
    this.renderer.info.reset();
    this.pollQueries();
    if (this.ext && this.recording && this.pending.length < 8) {
      const q = this.free.pop() ?? this.gl.createQuery();
      if (q) {
        this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
        this.active = q;
      }
    }
  }

  end(): void {
    if (this.active && this.ext) {
      this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
      this.pending.push(this.active);
      this.active = null;
    }
    if (!this.recording) return;
    this.cpu.push(performance.now() - this.beginT);
    const r = this.renderer.info.render;
    this.drawCalls += r.calls;
    this.triangles += r.triangles;
    this.points += r.points;
    this.lines += r.lines;
    this.infoFrames++;
  }

  perFrame(x: number): number {
    return this.infoFrames ? Math.round(x / this.infoFrames) : 0;
  }

  private pollQueries(): void {
    if (!this.ext) return;
    const gl = this.gl;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT) as boolean;
    while (this.pending.length) {
      const q = this.pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
      this.pending.shift();
      this.free.push(q);
      if (!disjoint && this.recording) this.gpu.push(ns / 1e6);
    }
  }

  dispose(): void {
    for (const q of [...this.pending, ...this.free]) this.gl.deleteQuery(q);
    this.pending = [];
    this.free = [];
  }
}

export async function runBenchmark(host: BenchHost, o: BenchOptions = {}): Promise<BenchReport> {
  const warmupMs = o.warmupMs ?? 1500;
  const measureMs = o.measureMs ?? 4000;
  const readyTimeoutMs = o.readyTimeoutMs ?? 30000;
  const minFrames = o.minFrames ?? 12;
  const maxMeasureMs = o.maxMeasureMs ?? 20000;
  const engine = host.engine;
  const renderer = engine.renderer;
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const sampler = new FrameSampler(renderer);
  const t0 = performance.now();
  const prevAutoReset = renderer.info.autoReset;
  const prevDyn = engine.dynamicResolution;
  const startId = host.currentId();
  renderer.info.autoReset = false;
  engine.probe = sampler;

  // Display refresh estimate from the current (light) scene.
  sampler.start(true);
  await sleep(1000);
  const refreshHz = sampler.intervals.length ? round(1000 / stat(sampler.intervals).median, 0) : 60;

  const results: BenchWorldResult[] = [];
  const n = host.worlds.length;
  for (let i = 0; i < n; i++) {
    const w = host.worlds[i];
    o.onProgress?.(i, n, w.title);
    const errBefore = host.errors().length;
    const tl = performance.now();
    let ok = true;
    let error: string | undefined;
    sampler.start(false);
    try {
      await host.go(w.id);
      const deadline = performance.now() + readyTimeoutMs;
      while (!host.isReady() && performance.now() < deadline && host.currentId() === w.id) await sleep(100);
      if (!host.isReady()) {
        ok = false;
        error = 'not ready within ' + Math.round(readyTimeoutMs / 1000) + ' s';
      }
    } catch (e) {
      ok = false;
      error = e instanceof Error ? e.message : String(e);
    }
    const loadMs = performance.now() - tl;
    engine.dynamicResolution = false;
    engine.setRenderScale(1);
    // Warm up for warmupMs and at least a few frames (shader compiles, first uploads).
    sampler.start(true);
    const w0 = performance.now();
    while ((performance.now() - w0 < warmupMs || sampler.intervals.length < 3) && performance.now() - w0 < maxMeasureMs) await sleep(50);
    sampler.start(true);
    const m0 = performance.now();
    while ((performance.now() - m0 < measureMs || sampler.intervals.length < minFrames) && performance.now() - m0 < maxMeasureMs) await sleep(50);
    sampler.start(false);
    // One more frame lets outstanding GPU timer queries resolve.
    await sleep(120);
    const errs = host.errors().slice(errBefore);
    if (errs.length && ok) {
      ok = false;
      error = errs[0];
    }
    if (!sampler.intervals.length && ok) {
      ok = false;
      error = 'no frames measured';
    }
    const med = stat(sampler.intervals).median;
    const mem = renderer.info.memory;
    results.push({
      id: w.id,
      title: w.title,
      ok,
      error,
      frames: sampler.intervals.length,
      fps: med > 0 ? round(1000 / med, 1) : 0,
      frameMs: stat(sampler.intervals),
      cpuMs: stat(sampler.cpu),
      gpuMs: sampler.gpu.length ? stat(sampler.gpu) : null,
      longFrames: sampler.intervals.filter((x) => x > 50).length,
      drawCalls: sampler.perFrame(sampler.drawCalls),
      triangles: sampler.perFrame(sampler.triangles),
      points: sampler.perFrame(sampler.points),
      lines: sampler.perFrame(sampler.lines),
      programs: renderer.info.programs?.length ?? 0,
      textures: mem.textures,
      geometries: mem.geometries,
      width: engine.width,
      height: engine.height,
      pixelRatio: round(engine.pixelRatio, 2),
      loadMs: Math.round(loadMs),
    });
  }

  engine.probe = null;
  sampler.dispose();
  renderer.info.autoReset = prevAutoReset;
  engine.dynamicResolution = prevDyn;

  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const nav = navigator as Navigator & { deviceMemory?: number };
  const report: BenchReport = {
    version: 1,
    startedAt: new Date(Date.now() - (performance.now() - t0)).toISOString(),
    durationMs: Math.round(performance.now() - t0),
    quality: engine.quality.tier,
    refreshHz,
    device: {
      gpu: dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER)),
      vendor: dbg ? String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)) : String(gl.getParameter(gl.VENDOR)),
      userAgent: navigator.userAgent,
      platform: navigator.platform ?? '',
      devicePixelRatio: window.devicePixelRatio || 1,
      screen: [screen.width, screen.height],
      viewport: [window.innerWidth, window.innerHeight],
      cores: navigator.hardwareConcurrency ?? 0,
      memoryGB: nav.deviceMemory ?? null,
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
      extensions: Object.fromEntries(EXT_NAMES.map((e) => [e, !!gl.getExtension(e)])),
    },
    results,
  };
  if (startId && startId !== host.currentId()) void host.go(startId);
  return report;
}

// ——— Saving to the artifact's database (only inside a Claude artifact viewer) ———

interface DbLike {
  collection(path: string): { add(data: Record<string, unknown>): Promise<unknown> };
}

export async function saveReport(report: BenchReport): Promise<'saved' | 'unavailable' | 'failed'> {
  const claude = (window as unknown as { claude?: { use?: (name: string) => Promise<unknown> } }).claude;
  if (!claude?.use) return 'unavailable';
  try {
    const db = (await claude.use('db')) as DbLike | null;
    if (!db) return 'unavailable';
    await db.collection('bench').add(JSON.parse(JSON.stringify(report)) as Record<string, unknown>);
    return 'saved';
  } catch {
    return 'failed';
  }
}

// ——— Results overlay ———

const CSS = `
.bench{position:absolute;inset:0;z-index:40;display:grid;place-items:center;padding:var(--gutter-top) var(--gutter) var(--gutter-bottom);background:rgba(0,0,0,.86);pointer-events:auto;overflow:auto}
.bench-card{width:min(860px,100%);display:flex;flex-direction:column;gap:14px}
.bench-kicker{font-size:10px;letter-spacing:.26em;text-transform:uppercase;color:var(--ink-3)}
.bench h2{margin:0;font-weight:300;font-size:clamp(24px,3vw,34px);letter-spacing:.01em}
.bench-device{font-family:var(--font-mono);font-size:11.5px;color:var(--ink-2);overflow-wrap:anywhere}
.bench-note{font-size:12px;color:var(--ink-3);line-height:1.55;max-width:70ch;margin:0}
.bench-scroll{overflow-x:auto}
.bench table{width:100%;border-collapse:collapse;font-size:12.5px}
.bench th{font-weight:400;font-size:9.5px;letter-spacing:.2em;text-transform:uppercase;color:var(--ink-3);text-align:right;padding:8px 10px;border-bottom:1px solid var(--line)}
.bench th:first-child,.bench td:first-child{text-align:left}
.bench td{padding:8px 10px;border-bottom:1px solid var(--line);font-family:var(--font-mono);font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.bench td:first-child{font-family:var(--font-ui);font-size:13px}
.bench-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:9px;vertical-align:1px;background:var(--ink-3)}
.bench-dot.good{background:#7fd6a4}.bench-dot.ok{background:var(--accent)}.bench-dot.bad{background:var(--danger)}
.bench-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.bench-status{font-size:11.5px;color:var(--ink-3)}
.bench-progress{font-family:var(--font-mono);font-size:12px;color:var(--ink-2)}
.bench textarea{width:100%;height:120px;background:transparent;color:var(--ink-2);border:1px solid var(--line);border-radius:4px;font-family:var(--font-mono);font-size:11px}
`;

let styled = false;
function ensureStyle(): void {
  if (styled) return;
  styled = true;
  const s = document.createElement('style');
  s.textContent = CSS;
  document.head.appendChild(s);
}

function verdict(r: BenchWorldResult, refreshHz: number): 'good' | 'ok' | 'bad' {
  if (!r.ok) return 'bad';
  const gpu = r.gpuMs?.median;
  const ms = gpu !== undefined ? Math.max(gpu, r.cpuMs.median) : r.frameMs.median;
  const budget = 1000 / Math.min(60, refreshHz);
  if (ms <= budget * 1.05 && r.frameMs.p95 < 40) return 'good';
  if (ms <= 33.4) return 'ok';
  return 'bad';
}

export class BenchOverlay {
  readonly el: HTMLElement;
  private progressEl: HTMLElement;
  onClose?: () => void;
  onRerun?: () => void;

  constructor(parent: HTMLElement) {
    ensureStyle();
    this.el = document.createElement('div');
    this.el.className = 'bench';
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-label', 'Performance benchmark');
    this.progressEl = document.createElement('div');
    this.progressEl.className = 'bench-progress';
    parent.appendChild(this.el);
  }

  progress(i: number, n: number, title: string): void {
    this.el.style.background = 'transparent';
    this.el.style.alignItems = 'end';
    this.el.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'bench-card';
    card.innerHTML = `<div class="bench-kicker">Benchmarking this device</div>`;
    this.progressEl.textContent = `${i + 1} / ${n} · ${title} — measuring for a few seconds…`;
    card.appendChild(this.progressEl);
    this.el.appendChild(card);
  }

  show(report: BenchReport, saved: string): void {
    this.el.style.background = '';
    this.el.style.alignItems = '';
    this.el.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'bench-card';
    const d = report.device;
    const timer = report.results.some((r) => r.gpuMs);
    card.innerHTML = `
      <div class="bench-kicker">Performance on this device</div>
      <h2>Benchmark</h2>
      <div class="bench-device"></div>
      <p class="bench-note"></p>`;
    (card.querySelector('.bench-device') as HTMLElement).textContent =
      `${d.gpu} · ${report.results[0]?.width ?? 0}×${report.results[0]?.height ?? 0} px (DPR ${d.devicePixelRatio}) · quality ${report.quality} · display ≈ ${report.refreshHz} Hz`;
    (card.querySelector('.bench-note') as HTMLElement).textContent = timer
      ? 'Frame time is capped by the display refresh rate; GPU time is the true rendering cost per frame (lower is better, 16.7 ms = 60 fps). Render scale was locked to 100 % while measuring.'
      : 'This browser does not expose GPU timers, so frame time (capped by the display refresh rate) is the measure. Render scale was locked to 100 % while measuring.';
    const scroll = document.createElement('div');
    scroll.className = 'bench-scroll';
    const table = document.createElement('table');
    table.innerHTML = `<thead><tr><th>World</th><th>FPS</th><th>Frame ms</th><th>p95</th><th>GPU ms</th><th>CPU ms</th><th>Draws</th><th>Load s</th></tr></thead>`;
    const tb = document.createElement('tbody');
    for (const r of report.results) {
      const tr = document.createElement('tr');
      const v = verdict(r, report.refreshHz);
      const cells = r.ok
        ? [r.fps.toFixed(0), r.frameMs.median.toFixed(1), r.frameMs.p95.toFixed(1), r.gpuMs ? r.gpuMs.median.toFixed(1) : '—', r.cpuMs.median.toFixed(1), String(r.drawCalls), (r.loadMs / 1000).toFixed(1)]
        : ['—', '—', '—', '—', '—', '—', (r.loadMs / 1000).toFixed(1)];
      const name = document.createElement('td');
      const dot = document.createElement('span');
      dot.className = `bench-dot ${v}`;
      name.append(dot, document.createTextNode(r.title + (r.ok ? '' : ` (${r.error ?? 'failed'})`)));
      tr.appendChild(name);
      for (const c of cells) {
        const td = document.createElement('td');
        td.textContent = c;
        tr.appendChild(td);
      }
      tb.appendChild(tr);
    }
    table.appendChild(tb);
    scroll.appendChild(table);
    card.appendChild(scroll);

    const actions = document.createElement('div');
    actions.className = 'bench-actions';
    const status = document.createElement('span');
    status.className = 'bench-status';
    status.textContent =
      saved === 'saved' ? 'Saved to this page for Claude to read.' : saved === 'failed' ? 'Could not save to this page — copy the report instead.' : 'Copy the report to share it.';
    const json = JSON.stringify(report, null, 1);
    const copy = this.button('Copy report', true, async () => {
      try {
        await navigator.clipboard.writeText(json);
        status.textContent = 'Report copied.';
      } catch {
        const ta = document.createElement('textarea');
        ta.value = json;
        ta.readOnly = true;
        card.appendChild(ta);
        ta.focus();
        ta.select();
        status.textContent = 'Select all and copy the text below.';
      }
    });
    const again = this.button('Run again', false, () => this.onRerun?.());
    const close = this.button('Close', false, () => this.close());
    actions.append(copy, again, close, status);
    card.appendChild(actions);
    this.el.appendChild(card);
    copy.focus();
  }

  private button(label: string, primary: boolean, fn: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = primary ? 'btn btn-primary' : 'btn';
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  }

  close(): void {
    this.el.remove();
    this.onClose?.();
  }
}
