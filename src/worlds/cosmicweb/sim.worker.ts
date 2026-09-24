/// <reference lib="webworker" />
/**
 * Web Worker entry for the cosmic-web simulation: receives a SimConfig, streams SimInfo,
 * progress and keyframes (transferable buffers) back to the main thread.
 * Cancellation is by terminate() from the owner.
 */
import { Simulation } from './Simulation';
import type { WorkerMessage, WorkerRequest } from './types';

const scope = self as unknown as Worker;
const post = (msg: WorkerMessage, transfer?: ArrayBuffer[]) => scope.postMessage(msg, transfer ?? []);

scope.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  if (req.type !== 'run') return;
  try {
    const sim = new Simulation(req.config, post, req.runId);
    await sim.run();
  } catch (e) {
    post({ type: 'error', runId: req.runId, message: e instanceof Error ? e.message : String(e) });
  }
};
