import assert from 'node:assert/strict';
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

  it('evaluates 60 positions at depth 8 inside the proof bound', async () => {
    const engine = createEngine({ depth: ENGINE_DEPTH });
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
      const mean = samples.reduce((total, value) => total + value, 0) / samples.length;
      assert.ok(mean <= 150, `mean ${mean.toFixed(1)} ms`);
    } finally {
      await engine.close();
    }
  });
});
