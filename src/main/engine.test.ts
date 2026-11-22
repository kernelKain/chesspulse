import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Worker } from 'node:worker_threads';
import { Chess } from 'chess.js';
import { createEngine, ENGINE_DEPTH } from './engine.js';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function sixtyPositions(): string[] {
  const chess = new Chess();
  const fens: string[] = [];
  while (fens.length < 60) {
    if (chess.isGameOver()) chess.reset();
    const next = chess.moves()[0];
    if (!next) {
      chess.reset();
      continue;
    }
    chess.move(next);
    fens.push(chess.fen());
  }
  return fens;
}

describe('createEngine', { concurrency: false }, () => {
  it('marks a bad FEN and a spent budget without a score', async () => {
    const invalid = createEngine();
    const bad = await invalid.evaluate('not-a-fen');
    await invalid.close();
    assert.equal(bad.evalFailed, true);
    assert.equal(bad.reason, 'fen');
    assert.equal(bad.scoreCp, undefined);

    const spent = createEngine({ budgetMs: 0 });
    const blocked = await spent.evaluate(START_FEN);
    await spent.close();
    assert.equal(blocked.evalFailed, true);
    assert.equal(blocked.reason, 'budget');
  });

  it('marks a search that does not answer as timed out', async () => {
    const worker = new Worker('setInterval(() => {}, 1000);', { eval: true });
    const engine = createEngine({ worker, timeoutMs: 40 });
    try {
      const result = await engine.evaluate(START_FEN);
      assert.equal(result.evalFailed, true);
      assert.equal(result.reason, 'timeout');
      assert.equal(result.scoreCp, undefined);
    } finally {
      await engine.close();
      await worker.terminate();
    }
  });

  it('restarts a crashed worker once and retries the same position', async () => {
    let spawned = 0;
    const spawnWorker = (): Worker => {
      spawned += 1;
      if (spawned === 1) {
        return new Worker(
          "require('node:worker_threads').parentPort.on('message', () => { throw new Error('worker crashed'); });",
          { eval: true },
        );
      }
      return new Worker(path.join(process.cwd(), 'dist-electron/main/engine-worker.js'));
    };
    const engine = createEngine({ depth: 4, spawnWorker });
    try {
      const result = await engine.evaluate(START_FEN);
      assert.equal(result.evalFailed, false);
      assert.equal(spawned, 2);
    } finally {
      await engine.close();
    }
  });

  it('treats a worker exit before a result as a crash and retries', async () => {
    let spawned = 0;
    const spawnWorker = (): Worker => {
      spawned += 1;
      if (spawned === 1) {
        return new Worker(
          "require('node:worker_threads').parentPort.on('message', () => process.exit(0));",
          { eval: true },
        );
      }
      return new Worker(path.join(process.cwd(), 'dist-electron/main/engine-worker.js'));
    };
    const engine = createEngine({ depth: 4, spawnWorker });
    try {
      const result = await engine.evaluate(START_FEN);
      assert.equal(result.evalFailed, false);
      assert.equal(spawned, 2);
    } finally {
      await engine.close();
    }
  });

  it('cancels an in-flight search and reports it without stopping a borrowed worker', async () => {
    const worker = new Worker('setInterval(() => {}, 1000);', { eval: true });
    let exited = false;
    worker.on('exit', () => {
      exited = true;
    });
    const controller = new AbortController();
    const engine = createEngine({ worker, timeoutMs: 60_000, signal: controller.signal });
    try {
      const pending = engine.evaluate(START_FEN);
      setTimeout(() => controller.abort(), 20);
      const result = await pending;
      assert.equal(result.evalFailed, true);
      assert.equal(result.reason, 'cancelled');
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(exited, false);
    } finally {
      await engine.close();
      await worker.terminate();
    }
  });

  it('rejects an invalid restart budget and accepts zero', async () => {
    assert.throws(() => createEngine({ maxRestarts: -1 }), /non-negative integer/);
    assert.throws(() => createEngine({ maxRestarts: 1.5 }), /non-negative integer/);
    assert.throws(() => createEngine({ maxRestarts: Number.NaN }), /non-negative integer/);
    const engine = createEngine({ maxRestarts: 0 });
    await engine.close();
  });

  it('stops retrying once the budget is exhausted', async () => {
    let spawned = 0;
    const spawnWorker = (): Worker => {
      spawned += 1;
      return new Worker(
        "require('node:worker_threads').parentPort.on('message', () => setTimeout(() => { throw new Error('crash'); }, 30));",
        { eval: true },
      );
    };
    const engine = createEngine({ budgetMs: 5, maxRestarts: 3, spawnWorker });
    try {
      const result = await engine.evaluate(START_FEN);
      assert.equal(result.evalFailed, true);
      assert.equal(result.reason, 'budget');
      assert.equal(spawned, 1);
    } finally {
      await engine.close();
    }
  });

  it('closes a factory-created replacement after a borrowed worker fails', async () => {
    let replacementExited = false;
    const borrowed = new Worker(
      "require('node:worker_threads').parentPort.on('message', () => { throw new Error('borrowed crash'); });",
      { eval: true },
    );
    const spawnWorker = (): Worker => {
      const replacement = new Worker(path.join(process.cwd(), 'dist-electron/main/engine-worker.js'));
      replacement.on('exit', () => {
        replacementExited = true;
      });
      return replacement;
    };
    const engine = createEngine({ worker: borrowed, spawnWorker, depth: 4 });
    try {
      const result = await engine.evaluate(START_FEN);
      assert.equal(result.evalFailed, false);
      await engine.close();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(replacementExited, true);
    } finally {
      await engine.close();
      await borrowed.terminate().catch(() => undefined);
    }
  });

  it('scores the start and repeats that score', async () => {
    const engine = createEngine({ depth: ENGINE_DEPTH });
    try {
      const first = await engine.evaluate(START_FEN);
      const second = await engine.evaluate(START_FEN);
      assert.equal(first.evalFailed, false);
      assert.equal(first.depth, ENGINE_DEPTH);
      assert.equal(typeof first.scoreCp, 'number');
      assert.equal(first.scoreCp, second.scoreCp);
      assert.equal(first.bestmove, second.bestmove);
    } finally {
      await engine.close();
    }
  });

  it('evaluates 60 positions at depth 8 inside the P3 proof bound', async () => {
    const engine = createEngine({ depth: 8 });
    const fens = sixtyPositions();
    try {
      await engine.evaluate(fens[0] ?? START_FEN);
      const samples: number[] = [];
      for (const fen of fens) {
        const started = process.hrtime.bigint();
        const result = await engine.evaluate(fen);
        samples.push(Number(process.hrtime.bigint() - started) / 1e6);
        assert.equal(result.evalFailed, false);
        assert.ok(result.scoreCp !== undefined || result.mate !== undefined);
      }
      if (process.env.CHESSPULSE_ENGINE_BENCH === '1') {
        const mean = samples.reduce((total, value) => total + value, 0) / samples.length;
        assert.ok(mean <= 150, `mean ${mean.toFixed(1)} ms`);
      }
    } finally {
      await engine.close();
    }
  });
});
