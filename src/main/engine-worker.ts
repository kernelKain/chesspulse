// What: one Stockfish process speaking UCI inside a worker thread.
// Why: a search must not block the Electron main thread, and the lite build needs no cross-origin isolation.
// Removed: a position search would freeze the window, or the multi-thread build would fail to start.
import { parentPort } from 'node:worker_threads';
import stockfish from 'stockfish';

interface EvalRequest {
  type: 'eval';
  id: number;
  fen: string;
  depth: number;
}

interface Score {
  scoreCp?: number;
  mate?: number;
}

const pending: string[] = [];
let waiter: { test: (line: string) => boolean; resolve: (line: string) => void } | null = null;
let latest: Score = {};
let busy = false;
let acceptScores = false;
let targetDepth = 0;

function onLine(line: string): void {
  if (
    acceptScores &&
    line.startsWith('info ') &&
    !line.includes(' upperbound') &&
    !line.includes(' lowerbound')
  ) {
    const depth = /\bdepth (\d+)/.exec(line);
    const score = /\bscore (cp|mate) (-?\d+)/.exec(line);
    if (depth && score && Number(depth[1]) === targetDepth) {
      if (score[1] === 'cp') latest = { scoreCp: Number(score[2]) };
      else latest = { mate: Number(score[2]) };
    }
  }
  if (waiter?.test(line)) {
    const resolve = waiter.resolve;
    waiter = null;
    resolve(line);
    return;
  }
  pending.push(line);
}

function waitFor(pattern: RegExp): Promise<string> {
  const index = pending.findIndex((line) => pattern.test(line));
  if (index >= 0) {
    const line = pending[index] ?? '';
    pending.splice(0, index + 1);
    return Promise.resolve(line);
  }
  return new Promise((resolve) => {
    waiter = { test: (line) => pattern.test(line), resolve };
  });
}

const engine = stockfish('lite-single', onLine);
let ready: Promise<void> | undefined;

function ensureReady(): Promise<void> {
  ready ??= (async () => {
    engine.processCommand('uci');
    await waitFor(/^uciok/);
    engine.processCommand('isready');
    await waitFor(/^readyok/);
  })();
  return ready;
}

parentPort?.on('message', (message: EvalRequest) => {
  if (message?.type !== 'eval') return;
  if (busy) {
    parentPort?.postMessage({ type: 'eval', id: message.id, failed: true, reason: 'busy' });
    return;
  }
  busy = true;
  void (async () => {
    await ensureReady();
    pending.length = 0;
    latest = {};
    acceptScores = false;
    targetDepth = message.depth;
    engine.processCommand('ucinewgame');
    engine.processCommand('isready');
    await waitFor(/^readyok/);
    engine.processCommand(`position fen ${message.fen}`);
    acceptScores = true;
    engine.processCommand(`go depth ${message.depth}`);
    const best = await waitFor(/^bestmove /);
    acceptScores = false;
    parentPort?.postMessage({
      type: 'eval',
      id: message.id,
      bestmove: best.split(/\s+/)[1] ?? '',
      scoreCp: latest.scoreCp,
      mate: latest.mate,
    });
  })()
    .catch((error: unknown) => {
      parentPort?.postMessage({
        type: 'eval',
        id: message.id,
        failed: true,
        reason: error instanceof Error ? error.message : 'engine',
      });
    })
    .finally(() => {
      busy = false;
    });
});
