// What: queues FEN searches and marks a position failed instead of inventing a score.
// Why: centipawn loss needs an engine number, and a timeout must not become zero.
// Removed: a stalled search would hang the report, and a bad FEN would be scored anyway.
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { validateFen } from 'chess.js';

export const ENGINE_DEPTH = 8;
export const POSITION_TIMEOUT_MS = 5_000;
export const ENGINE_BUDGET_MS = 20 * 60 * 1000;

export interface PositionEval {
  fen: string;
  depth: number;
  evalFailed: boolean;
  scoreCp?: number;
  mate?: number;
  bestmove?: string;
  reason?: 'timeout' | 'fen' | 'engine' | 'budget';
}

export interface EngineOptions {
  depth?: number;
  timeoutMs?: number;
  budgetMs?: number;
  worker?: Worker;
}

interface WorkerEval {
  type?: string;
  id?: number;
  failed?: boolean;
  bestmove?: string;
  scoreCp?: number;
  mate?: number;
}

export function createEngine(options: EngineOptions = {}): {
  evaluate(fen: string): Promise<PositionEval>;
  close(): Promise<void>;
} {
  const depth = options.depth ?? ENGINE_DEPTH;
  const timeoutMs = options.timeoutMs ?? POSITION_TIMEOUT_MS;
  const budgetMs = options.budgetMs ?? ENGINE_BUDGET_MS;
  let worker = options.worker;
  const ownsWorker = options.worker === undefined;
  let startedAt: number | undefined;
  let queue: Promise<void> = Promise.resolve();
  let requestId = 0;

  function spawn(): Worker {
    return new Worker(path.join(__dirname, 'engine-worker.js'));
  }

  async function evaluate(fen: string): Promise<PositionEval> {
    const run = queue.then(() => evaluateOne(fen));
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function evaluateOne(fen: string): Promise<PositionEval> {
    if (startedAt === undefined) startedAt = Date.now();
    if (Date.now() - startedAt >= budgetMs) {
      return { fen, depth, evalFailed: true, reason: 'budget' };
    }
    if (!validateFen(fen).ok) {
      return { fen, depth, evalFailed: true, reason: 'fen' };
    }
    worker ??= spawn();
    const current = worker;
    const id = (requestId += 1);

    return new Promise((resolve) => {
      let settled = false;
      const onError = (): void => {
        if (worker === current) worker = undefined;
        finish({ fen, depth, evalFailed: true, reason: 'engine' });
      };
      const finish = (result: PositionEval): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        current.off('message', onMessage);
        current.off('error', onError);
        resolve(result);
      };
      const timer = setTimeout(() => {
        finish({ fen, depth, evalFailed: true, reason: 'timeout' });
        if (worker === current) worker = undefined;
        void current.terminate();
      }, timeoutMs);
      const onMessage = (message: unknown): void => {
        if (!isWorkerEval(message) || message.id !== id) return;
        if (message.failed === true || (message.scoreCp === undefined && message.mate === undefined)) {
          finish({ fen, depth, evalFailed: true, reason: 'engine', bestmove: message.bestmove });
          return;
        }
        finish({
          fen,
          depth,
          evalFailed: false,
          scoreCp: message.scoreCp,
          mate: message.mate,
          bestmove: message.bestmove,
        });
      };
      current.on('message', onMessage);
      current.on('error', onError);
      current.postMessage({ type: 'eval', id, fen, depth });
    });
  }

  async function close(): Promise<void> {
    await queue;
    if (!ownsWorker || !worker) return;
    const current = worker;
    worker = undefined;
    await current.terminate();
  }

  return { evaluate, close };
}

function isWorkerEval(message: unknown): message is WorkerEval {
  return typeof message === 'object' && message !== null && (message as WorkerEval).type === 'eval';
}
