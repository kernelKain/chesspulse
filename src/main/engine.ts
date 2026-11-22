// What: queues FEN searches and marks a position failed instead of inventing a score.
// Why: centipawn loss needs an engine number, and a timeout must not become zero.
// Removed: a stalled search would hang the report, and a bad FEN would be scored anyway.
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { validateFen } from 'chess.js';

/**
 * S36 raised this from 8 to 12 after the fixture bench: mean 41.1 ms and 0/18 blunder-flag
 * changes at depth 12. Fixtures measure speed and stability, not real-game accuracy.
 */
export const ENGINE_DEPTH = 12;
export const POSITION_TIMEOUT_MS = 5_000;
export const ENGINE_BUDGET_MS = 20 * 60 * 1000;
/** A position whose worker crashes is retried, but only this many times per engine/report. */
export const MAX_WORKER_RESTARTS = 2;
/** A worker that will not terminate must not hold the process open indefinitely. */
const CLOSE_TIMEOUT_MS = 2_000;

export type EngineFailureReason = 'timeout' | 'fen' | 'engine' | 'budget' | 'crash' | 'cancelled';

export interface PositionEval {
  fen: string;
  depth: number;
  evalFailed: boolean;
  scoreCp?: number;
  mate?: number;
  bestmove?: string;
  reason?: EngineFailureReason;
}

export interface EngineOptions {
  depth?: number;
  timeoutMs?: number;
  budgetMs?: number;
  /** Clock seam for the budget check; production uses Date.now. */
  now?: () => number;
  /** A specific worker, used by tests. The engine does not own it. */
  worker?: Worker;
  /** A factory for the first and every replacement worker, used by tests and production. */
  spawnWorker?: () => Worker;
  /** Cancels the in-flight search and marks every later evaluation cancelled. */
  signal?: AbortSignal;
  maxRestarts?: number;
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
  depth: number;
} {
  const depth = options.depth ?? ENGINE_DEPTH;
  const timeoutMs = options.timeoutMs ?? POSITION_TIMEOUT_MS;
  const budgetMs = options.budgetMs ?? ENGINE_BUDGET_MS;
  const now = options.now ?? Date.now;
  if (
    options.maxRestarts !== undefined &&
    (!Number.isInteger(options.maxRestarts) || options.maxRestarts < 0)
  ) {
    throw new Error('maxRestarts must be a non-negative integer.');
  }
  const maxRestarts = options.maxRestarts ?? MAX_WORKER_RESTARTS;
  const signal = options.signal;
  let worker = options.worker;
  // Ownership follows the current worker, not merely how the engine was constructed.
  let ownsWorker = options.worker === undefined;
  if (worker) watchWorker(worker);
  const spawnWorker = options.spawnWorker ?? ((): Worker => new Worker(path.join(__dirname, 'engine-worker.js')));
  let startedAt: number | undefined;
  let queue: Promise<void> = Promise.resolve();
  let requestId = 0;
  let restarts = 0;
  // A borrowed worker already exists; a spawn after it fails is a replacement, not an initial spawn.
  let everSpawned = options.worker !== undefined;

  const cancelled = (fen: string): PositionEval => ({ fen, depth, evalFailed: true, reason: 'cancelled' });

  /** Invalidates an idle worker before its next use; per-attempt listeners handle live searches. */
  function watchWorker(candidate: Worker): void {
    const invalidate = (): void => {
      if (worker === candidate) {
        worker = undefined;
        ownsWorker = false;
      }
    };
    candidate.on('error', invalidate);
    candidate.on('exit', invalidate);
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
    if (signal?.aborted) return cancelled(fen);
    if (startedAt === undefined) startedAt = now();
    if (!validateFen(fen).ok) {
      return { fen, depth, evalFailed: true, reason: 'fen' };
    }
    for (;;) {
      if (now() - startedAt >= budgetMs) {
        return { fen, depth, evalFailed: true, reason: 'budget' };
      }
      const result = await evaluateAttempt(fen);
      if (result.reason !== 'crash') return result;
      if (restarts >= maxRestarts) return result;
      // The replacement spawn is counted in evaluateAttempt, immediately before it is created.
    }
  }

  async function evaluateAttempt(fen: string): Promise<PositionEval> {
    if (signal?.aborted) return cancelled(fen);
    if (!worker) {
      if (everSpawned) {
        // A later evaluation must not get a fresh worker after the allowance was spent.
        if (restarts >= maxRestarts) {
          return { fen, depth, evalFailed: true, reason: 'crash' };
        }
        restarts += 1;
      }
      everSpawned = true;
      try {
        worker = spawnWorker();
        ownsWorker = true;
        watchWorker(worker);
      } catch {
        return { fen, depth, evalFailed: true, reason: 'crash' };
      }
    }
    const current = worker;
    const owned = ownsWorker;
    const id = (requestId += 1);

    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        current.off('message', onMessage);
        current.off('error', onError);
        current.off('exit', onExit);
        signal?.removeEventListener('abort', onAbort);
      };
      const finish = (result: PositionEval): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const dropWorker = (): void => {
        if (worker === current) {
          worker = undefined;
          ownsWorker = false;
        }
      };
      const stopOwnedWorker = (): void => {
        if (owned) void current.terminate().catch(() => undefined);
      };
      const onError = (): void => {
        dropWorker();
        finish({ fen, depth, evalFailed: true, reason: 'crash' });
        stopOwnedWorker();
      };
      const onExit = (): void => {
        dropWorker();
        finish({ fen, depth, evalFailed: true, reason: 'crash' });
      };
      const onAbort = (): void => {
        dropWorker();
        finish(cancelled(fen));
        // A borrowed worker is the caller's to stop; only terminate what the engine created.
        stopOwnedWorker();
      };
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
      timer = setTimeout(() => {
        dropWorker();
        finish({ fen, depth, evalFailed: true, reason: 'timeout' });
        stopOwnedWorker();
      }, timeoutMs);
      current.on('message', onMessage);
      current.on('error', onError);
      current.on('exit', onExit);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      try {
        current.postMessage({ type: 'eval', id, fen, depth });
      } catch {
        // A postMessage throw means this attempt failed; dispose an owned worker before retrying.
        onError();
      }
    });
  }

  async function close(): Promise<void> {
    await queue;
    if (!ownsWorker || !worker) return;
    const current = worker;
    worker = undefined;
    ownsWorker = false;
    const terminated = current.terminate().catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
      timer.unref?.();
    });
    await Promise.race([terminated, deadline]);
    if (timer !== undefined) clearTimeout(timer);
  }

  return { evaluate, close, depth };
}

function isWorkerEval(message: unknown): message is WorkerEval {
  return typeof message === 'object' && message !== null && (message as WorkerEval).type === 'eval';
}
