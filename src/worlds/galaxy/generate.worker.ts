import { generateParticles } from './model';
import type { GalaxyParams } from './params';

/** Off-main-thread particle generation (pure and deterministic; see model.generateParticles). */
interface Request {
  id: number;
  params: GalaxyParams;
  count: number;
}

self.onmessage = (e: MessageEvent<Request>) => {
  const { id, params, count } = e.data;
  try {
    const g = generateParticles(params, count);
    (self as unknown as Worker).postMessage({ id, ok: true, particles: g }, [g.data.buffer, g.globulars.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: String((err as Error)?.message ?? err) });
  }
};
