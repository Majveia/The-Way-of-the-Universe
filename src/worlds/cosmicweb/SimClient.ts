/**
 * Main-thread handle on a cosmic-web simulation run. Spawns the Web Worker (module worker);
 * if workers are unavailable it runs the same Simulation on the main thread in small slices.
 * Keyframes are stored in a SnapshotStore as they stream in.
 */
import { Simulation } from './Simulation';
import { SnapshotStore } from './SnapshotStore';
import type { Keyframe, SimConfig, SimInfo, WorkerMessage } from './types';

export interface SimClientEvents {
  info?: (info: SimInfo) => void;
  keyframe?: (k: Keyframe, index: number) => void;
  progress?: (fraction: number, label: string) => void;
  done?: (ms: number) => void;
  error?: (message: string) => void;
}

export class SimClient {
  store: SnapshotStore | null = null;
  info: SimInfo | null = null;
  config: SimConfig | null = null;
  running = false;
  finished = false;
  /** True when the simulation fell back to the main thread. */
  mainThread = false;
  events: SimClientEvents = {};
  private worker: Worker | null = null;
  private local: Simulation | null = null;
  private runId = 0;
  private startT = 0;

  /** Start (or restart) a run. Any previous run is cancelled. */
  start(config: SimConfig, events: SimClientEvents = this.events): void {
    this.stop();
    this.events = events;
    this.config = config;
    this.info = null;
    this.store = null;
    this.finished = false;
    this.running = true;
    const runId = ++this.runId;
    this.startT = performance.now();
    let worker: Worker | null = null;
    try {
      worker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module', name: 'cosmic-web' });
    } catch {
      worker = null;
    }
    if (!worker) {
      this.runLocal(config, runId);
      return;
    }
    this.worker = worker;
    this.mainThread = false;
    let alive = false;
    worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
      alive = true;
      this.handle(e.data);
    };
    worker.onerror = (e) => {
      e.preventDefault?.();
      if (runId !== this.runId) return;
      // A worker that never spoke failed to load (CSP, file://, old browser): fall back.
      if (!alive) {
        worker?.terminate();
        this.worker = null;
        this.runLocal(config, runId);
      } else this.events.error?.(e.message || 'Simulation worker failed');
    };
    worker.postMessage({ type: 'run', runId, config });
  }

  private runLocal(config: SimConfig, runId: number): void {
    this.mainThread = true;
    // The main thread cannot afford the big run; keep the same universe (seed) at 64³.
    const cfg: SimConfig = { ...config, np: Math.min(config.np, 64), nm: Math.min(config.nm, 64) };
    this.config = cfg;
    try {
      const sim = new Simulation(cfg, (msg) => this.handle(msg), runId);
      this.local = sim;
      void sim.run(() => new Promise((r) => setTimeout(r, 0))).catch((e) => {
        if (runId === this.runId) this.events.error?.(e instanceof Error ? e.message : String(e));
      });
    } catch (e) {
      this.running = false;
      this.events.error?.(e instanceof Error ? e.message : String(e));
    }
  }

  private handle(msg: WorkerMessage): void {
    if (msg.runId !== this.runId) return;
    switch (msg.type) {
      case 'info':
        this.info = msg.info;
        this.store = new SnapshotStore(msg.info.count);
        this.events.info?.(msg.info);
        break;
      case 'progress':
        this.events.progress?.(msg.fraction, msg.label);
        break;
      case 'keyframe': {
        if (!this.store) return;
        this.store.add(msg.keyframe);
        this.events.keyframe?.(msg.keyframe, this.store.length - 1);
        break;
      }
      case 'done':
        this.running = false;
        this.finished = true;
        this.events.done?.(performance.now() - this.startT);
        break;
      case 'error':
        this.running = false;
        this.events.error?.(msg.message);
        break;
    }
  }

  stop(): void {
    this.runId++;
    this.worker?.terminate();
    this.worker = null;
    this.local?.cancel();
    this.local = null;
    this.running = false;
  }

  dispose(): void {
    this.stop();
    this.store?.clear();
    this.store = null;
    this.info = null;
  }
}
