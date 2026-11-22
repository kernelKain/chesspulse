import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import type { PulseSample } from '../shared/contracts.js';
import { CONFIDENCE_FLOOR, SAMPLE_HOLD_US } from '../shared/sensing.js';
import { bandFor } from './analysis/bands.js';
import { createBandLookup, buildReport, COVERAGE_GATE_PCT, elevatedClaim, formatResult } from './report.js';
import { positionsFromMoves } from './analysis/positions.js';
import { ENGINE_DEPTH } from './engine.js';
import { requestInsight } from './ai/service.js';
import { ingestSamples, startSession, stopSession } from './session.js';
import { digestGames, readGames, readReport } from './store.js';

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function useRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'chesspulse-report-'));
  roots.push(root);
  return root;
}

const EPOCH = 1_700_000_000_000;

function sample(tUs: number, bpm = 70): PulseSample {
  return { tUs, bpm, confidence: 80, stable: true };
}

async function session(
  root: string,
  samples: PulseSample[],
  stopUs: number,
  startEpoch = EPOCH,
): Promise<string> {
  const started = await startSession(root, { monoUs: 0, epochMs: startEpoch }, '60');
  await ingestSamples(root, samples);
  await stopSession(root, { monoUs: stopUs, epochMs: startEpoch + stopUs / 1000 }, 'user');
  return started.id;
}

function pgnAt(endEpochMs: number): string {
  const end = new Date(endEpochMs);
  const pad = (value: number) => String(value).padStart(2, '0');
  const date = `${end.getUTCFullYear()}.${pad(end.getUTCMonth() + 1)}.${pad(end.getUTCDate())}`;
  const time = `${pad(end.getUTCHours())}:${pad(end.getUTCMinutes())}:${pad(end.getUTCSeconds())}`;
  return `[Event "Live Chess"]
[White "Ada"]
[Black "Nim"]
[Result "1-0"]
[TimeControl "60"]
[Termination "Ada won by checkmate"]
[EndDate "${date}"]
[EndTime "${time}"]

1. e4 {[%clk 0:00:50]} 1-0
`;
}

function illegalPgnAt(endEpochMs: number): string {
  const shuffles = Array.from({ length: 11 }, () => 'Nf3 Nf6 Ng1 Ng8').join(' ');
  return pgnAt(endEpochMs).replace('1. e4 {[%clk 0:00:50]} 1-0', `1. ${shuffles} 23. e5 1-0`);
}

function clockText(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

function longPgnAt(endEpochMs: number): string {
  const end = new Date(endEpochMs);
  const pad = (value: number) => String(value).padStart(2, '0');
  const date = `${end.getUTCFullYear()}.${pad(end.getUTCMonth() + 1)}.${pad(end.getUTCDate())}`;
  const time = `${pad(end.getUTCHours())}:${pad(end.getUTCMinutes())}:${pad(end.getUTCSeconds())}`;
  const moves: string[] = [];
  for (let full = 0; full < 80; full += 1) {
    const pair = full % 2 === 0 ? ['Nf3', 'Nf6'] : ['Ng1', 'Ng8'];
    const seconds = 5399 - full;
    moves.push(`${full + 1}. ${pair[0]} {[%clk ${clockText(seconds)}]} ${pair[1]} {[%clk ${clockText(seconds)}]}`);
  }
  return `[Event "Live Chess"]
[White "Ada"]
[Black "Nim"]
[Result "1-0"]
[TimeControl "5400"]
[Termination "Ada won by resignation"]
[EndDate "${date}"]
[EndTime "${time}"]

${moves.join(' ')} 1-0
`;
}

function evaluator() {
  return {
    async evaluate(fen: string) {
      return { fen, depth: 8, evalFailed: false, scoreCp: 12, bestmove: 'e7e5' };
    },
    async close() {},
  };
}

function linearBandAt(
  samples: readonly PulseSample[],
  tUs: number,
  baseline: number,
): ReturnType<typeof bandFor> {
  let latest: PulseSample | undefined;
  for (const entry of samples) {
    if (entry.tUs <= tUs && (!latest || entry.tUs >= latest.tUs)) latest = entry;
  }
  if (!latest || !latest.stable || latest.confidence < CONFIDENCE_FLOOR) return null;
  if (tUs > latest.tUs + SAMPLE_HOLD_US) return null;
  return bandFor(latest.bpm, baseline);
}

describe('band lookup', () => {
  it('uses the latest sample before the move and does not skip a weak one', () => {
    const earlier = sample(0, 90);
    const weak = { tUs: 500_000, bpm: 60, confidence: 10, stable: true };
    const withWeak = createBandLookup([earlier, weak], 70);
    const alone = createBandLookup([earlier], 70);
    assert.equal(withWeak(500_000), null);
    assert.equal(alone(500_000), 'elevated');
    assert.equal(alone(earlier.tUs + SAMPLE_HOLD_US), 'elevated');
    assert.equal(alone(earlier.tUs + SAMPLE_HOLD_US + 1), null);
  });

  it('matches the old linear lookup on unsorted, gapped, and weak samples', () => {
    const samples: PulseSample[] = [
      sample(9_000_000, 95),
      sample(1_000_000, 72),
      { tUs: 4_000_000, bpm: 60, confidence: 10, stable: true },
      sample(4_000_000, 90),
      sample(0, 70),
      sample(2_000_000, 84),
    ];
    const lookup = createBandLookup(samples, 70);
    for (const tUs of [0, 500_000, 1_000_000, 2_500_000, 4_000_000, 5_000_000, 6_000_000, 9_000_000, 12_000_000]) {
      assert.equal(lookup(tUs), linearBandAt(samples, tUs, 70), `lookup differs at ${tUs}`);
    }
  });

  it('omits a pooled duration when elevated blunders fall in separate stretches', () => {
    const calm = sample(0, 90);
    const later = sample(5_000_000, 100);
    assert.equal(elevatedClaim([calm, later], 0, 10_000_000, 70, [0, 5_000_000]), undefined);
    assert.deepEqual(elevatedClaim([calm, later], 0, 10_000_000, 70, [0]), {
      elevatedMinutes: SAMPLE_HOLD_US / 60_000_000,
      deltaBpm: 20,
    });
  });
});

describe('buildReport', () => {
  it('refuses a 40 percent trace and writes no report', async () => {
    const root = useRoot();
    const id = await session(
      root,
      [sample(0), sample(1_000_000), sample(2_000_000), sample(3_000_000)],
      10_000_000,
    );
    const result = await buildReport(root, id, [pgnAt(EPOCH + 10_000)]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'low_coverage');
    assert.equal(result.measured, 40);
    assert.equal(result.threshold, COVERAGE_GATE_PCT);
    assert.match(result.remedy, /lamp in front of you/);
    assert.equal('verdict' in result, false);
    assert.equal('settled' in result, false);
    assert.equal(result.trace?.samples.length, 4);
    assert.equal(result.trace?.stopUs, 10_000_000);
    await assert.rejects(readFile(path.join(root, 'sessions', id, 'report.json'), 'utf8'));
    assert.match(formatResult(result), /No report for this session/);
    assert.match(formatResult(result), /40%/);
  });

  it('keeps the previous report and PGNs byte-identical after a PGN failure', async () => {
    const root = useRoot();
    const samples = Array.from({ length: 10 }, (_unused, index) => sample(index * 1_000_000));
    const id = await session(root, samples, 10_000_000);
    const pgn = pgnAt(EPOCH + 10_000);
    assert.equal((await buildReport(root, id, [pgn], evaluator())).ok, true);
    const reportFile = path.join(root, 'sessions', id, 'report.json');
    const gamesFile = path.join(root, 'sessions', id, 'games.json');
    const reportBefore = await readFile(reportFile, 'utf8');
    const gamesBefore = await readFile(gamesFile, 'utf8');

    await assert.rejects(
      buildReport(root, id, ['[Event "Broken"]\n\n1. e4 {[%clk bad]} 1-0\n'], evaluator()),
      /clock time/,
    );

    assert.equal(await readFile(reportFile, 'utf8'), reportBefore);
    assert.equal(await readFile(gamesFile, 'utf8'), gamesBefore);
  });

  it('keeps the previous report and PGNs byte-identical after a coverage refusal', async () => {
    const root = useRoot();
    const samples = Array.from({ length: 10 }, (_unused, index) => sample(index * 1_000_000));
    const id = await session(root, samples, 10_000_000);
    const pgn = pgnAt(EPOCH + 10_000);
    assert.equal((await buildReport(root, id, [pgn], evaluator())).ok, true);
    const reportFile = path.join(root, 'sessions', id, 'report.json');
    const gamesFile = path.join(root, 'sessions', id, 'games.json');
    const reportBefore = await readFile(reportFile, 'utf8');
    const gamesBefore = await readFile(gamesFile, 'utf8');
    await writeFile(
      path.join(root, 'sessions', id, 'samples.ndjson'),
      samples.slice(0, 4).map((entry) => JSON.stringify(entry)).join('\n') + '\n',
    );

    const result = await buildReport(root, id, [pgn], evaluator());

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'low_coverage');
    assert.equal(await readFile(reportFile, 'utf8'), reportBefore);
    assert.equal(await readFile(gamesFile, 'utf8'), gamesBefore);
  });

  it('prints the same verdict twice when coverage is enough', async () => {
    const root = useRoot();
    const samples = Array.from({ length: 10 }, (_unused, index) => sample(index * 1_000_000));
    const id = await session(root, samples, 10_000_000);
    const pgn = pgnAt(EPOCH + 10_000);
    const evaluator = {
      async evaluate(fen: string) {
        return { fen, depth: 8, evalFailed: false, scoreCp: 12, bestmove: 'e7e5' };
      },
      async close() {},
    };
    const first = await buildReport(root, id, [pgn], evaluator);
    const second = await buildReport(root, id, [pgn], evaluator);
    assert.equal(first.ok, true);
    assert.deepEqual(second, first);
    if (!first.ok) return;
    assert.match(first.verdict, /blunder/);
    assert.equal(first.games.length, 1);
    assert.equal(first.games[0]?.ending, 'checkmate');
    assert.equal(first.games[0]?.includeInStats, true);
    assert.equal(first.games[0]?.aligned, true);
    assert.equal(first.timeline.samples.length, 10);
    assert.equal(first.timeline.games.length, 1);
    assert.equal(first.timeline.moves.length, 1);
    assert.equal(first.timeline.elevatedThresholdBpm, 80);
    assert.equal('gamesDigest' in first, true);
    if (!('gamesDigest' in first)) return;
    assert.equal(
      first.gamesDigest,
      createHash('sha256').update(JSON.stringify([pgn]), 'utf8').digest('hex'),
    );
    const saved = JSON.parse(await readFile(path.join(root, 'sessions', id, 'report.json'), 'utf8')) as unknown;
    assert.deepEqual(saved, first);
    assert.equal(formatResult(first), `${first.verdict}\n`);
    assert.equal(first.banner, undefined);
    const withBanner = formatResult({ ...first, banner: 'No EndTime in this paste.' });
    assert.equal(withBanner, `${first.verdict}\nNo EndTime in this paste.\n`);
  });

  it('skips the engine at checkmate and marks the mating move', async () => {
    const root = useRoot();
    const endEpoch = Date.UTC(2026, 10, 20, 12, 10, 0);
    const startEpoch = endEpoch - 30_000;
    const samples = Array.from({ length: 46 }, (_unused, index) => sample(index * 1_000_000));
    const id = await session(root, samples, 45_000_000, startEpoch);
    const pgn = await readFile('tests/fixtures/pgn/checkmate.pgn', 'utf8');
    const calls: string[] = [];
    const result = await buildReport(root, id, [pgn], {
      async evaluate(fen: string) {
        calls.push(fen);
        return { fen, depth: 8, evalFailed: false, scoreCp: 30, bestmove: 'e7e5' };
      },
      async close() {},
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    const last = result.timeline.moves.at(-1);
    assert.equal(last?.san, 'Qxf7#');
    assert.equal(last?.mate, true);
    assert.equal(last?.cpl, null);
    assert.equal(last?.blunder, false);
    const terminal = positionsFromMoves(['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6', 'Qxf7#']).at(-1)?.fenAfter;
    assert.ok(terminal);
    assert.equal(calls.includes(terminal), false);
  });

  it('refuses a batch with an illegal move before the engine runs', async () => {
    const root = useRoot();
    const samples = Array.from({ length: 46 }, (_unused, index) => sample(index * 1_000_000));
    const id = await session(root, samples, 45_000_000);
    let calls = 0;
    const result = await buildReport(root, id, [pgnAt(EPOCH + 10_000), illegalPgnAt(EPOCH + 20_000)], {
      async evaluate(fen: string) {
        calls += 1;
        return { fen, depth: 8, evalFailed: false, scoreCp: 12, bestmove: 'e7e5' };
      },
      async close() {},
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'illegal_move');
    assert.match(result.remedy, /Game 2, move 23 \(e5\) is not legal from this position/);
    assert.equal(calls, 0);
  });

  it('counts positions that time out and states how many were left out', async () => {
    const root = useRoot();
    const samples = Array.from({ length: 21 }, (_unused, index) => sample(index * 1_000_000));
    const id = await session(root, samples, 20_000_000);
    const result = await buildReport(root, id, [pgnAt(EPOCH + 10_000)], {
      async evaluate(fen: string) {
        return { fen, depth: 8, evalFailed: true, reason: 'timeout' as const };
      },
      async close() {},
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.engine.depth, ENGINE_DEPTH);
    assert.equal(result.engine.positions, 2);
    assert.equal(result.engine.scored, 0);
    assert.equal(result.engine.failed, 2);
    assert.equal(result.engine.reasons.timeout, 2);
    assert.equal(result.engine.reasons.crash, 0);
  });

  it('uses the evaluator depth in the report metadata', async () => {
    const root = useRoot();
    const samples = Array.from({ length: 21 }, (_unused, index) => sample(index * 1_000_000));
    const id = await session(root, samples, 20_000_000);
    const result = await buildReport(root, id, [pgnAt(EPOCH + 10_000)], {
      ...evaluator(),
      depth: 6,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.engine.depth, 6);
  });

  it('counts distinct engine failure reasons instead of collapsing them', async () => {
    const root = useRoot();
    const samples = Array.from({ length: 21 }, (_unused, index) => sample(index * 1_000_000));
    const id = await session(root, samples, 20_000_000);
    let call = 0;
    const result = await buildReport(root, id, [pgnAt(EPOCH + 10_000)], {
      async evaluate(fen: string) {
        call += 1;
        const reason = call === 1 ? ('timeout' as const) : ('crash' as const);
        return { fen, depth: 8, evalFailed: true, reason };
      },
      async close() {},
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.engine.positions, 2);
    assert.equal(result.engine.failed, 2);
    assert.deepEqual(result.engine.reasons, { timeout: 1, crash: 1, engine: 0, budget: 0 });
  });

  it('reports scored progress from zero to the position total', async () => {
    const root = useRoot();
    const samples = Array.from({ length: 21 }, (_unused, index) => sample(index * 1_000_000));
    const id = await session(root, samples, 20_000_000);
    const progress: { scored: number; total: number }[] = [];
    const result = await buildReport(root, id, [pgnAt(EPOCH + 10_000)], evaluator(), {
      onProgress: (entry) => progress.push(entry),
    });

    assert.equal(result.ok, true);
    assert.deepEqual(progress[0], { scored: 0, total: 2 });
    assert.deepEqual(progress.at(-1), { scored: 2, total: 2 });
    assert.ok(progress.every((entry) => entry.total === 2));
  });

  it('cancels a rebuild without touching the previous artifacts', async () => {
    const root = useRoot();
    const samples = Array.from({ length: 21 }, (_unused, index) => sample(index * 1_000_000));
    const id = await session(root, samples, 20_000_000);
    const pgn = pgnAt(EPOCH + 10_000);
    assert.equal((await buildReport(root, id, [pgn], evaluator())).ok, true);
    const reportFile = path.join(root, 'sessions', id, 'report.json');
    const gamesFile = path.join(root, 'sessions', id, 'games.json');
    const reportBefore = await readFile(reportFile, 'utf8');
    const gamesBefore = await readFile(gamesFile, 'utf8');
    const controller = new AbortController();
    let calls = 0;

    const result = await buildReport(
      root,
      id,
      [pgn],
      {
        async evaluate(fen: string) {
          calls += 1;
          controller.abort();
          return { fen, depth: 8, evalFailed: false, scoreCp: 12, bestmove: 'e7e5' };
        },
        async close() {},
      },
      { signal: controller.signal },
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'cancelled');
    assert.ok(calls > 0);
    assert.equal(await readFile(reportFile, 'utf8'), reportBefore);
    assert.equal(await readFile(gamesFile, 'utf8'), gamesBefore);
  });

  it('does not save when cancellation arrives at the commit boundary', async () => {
    const root = useRoot();
    const samples = Array.from({ length: 21 }, (_unused, index) => sample(index * 1_000_000));
    const id = await session(root, samples, 20_000_000);
    const controller = new AbortController();
    const result = await buildReport(root, id, [pgnAt(EPOCH + 10_000)], evaluator(), {
      signal: controller.signal,
      onCommitStart: () => controller.abort(),
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'cancelled');
    for (const name of ['games.json', 'report.json']) {
      await assert.rejects(
        readFile(path.join(root, 'sessions', id, name), 'utf8'),
        (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
      );
    }
  });

  it('builds a 90-minute synthetic session without losing plies', async () => {
    const root = useRoot();
    const samples = Array.from({ length: 5401 }, (_unused, index) =>
      sample(index * 1_000_000, 70 + (index % 10)),
    );
    const id = await session(root, samples, 5_400_000_000);
    const result = await buildReport(root, id, [longPgnAt(EPOCH + 5_400_000)], evaluator());

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.timeline.moves.length, 160);
  });

  it('replaces both artifacts with matching digests after a different PGN rebuild', async () => {
    const root = useRoot();
    const samples = Array.from({ length: 10 }, (_unused, index) => sample(index * 1_000_000));
    const id = await session(root, samples, 10_000_000);
    const firstPgn = pgnAt(EPOCH + 10_000);
    const secondPgn = firstPgn.replace('[White "Ada"]', '[White "Grace"]');
    assert.equal((await buildReport(root, id, [firstPgn], evaluator())).ok, true);

    const rebuilt = await buildReport(root, id, [secondPgn], evaluator());

    assert.equal(rebuilt.ok, true);
    if (!rebuilt.ok) return;
    assert.deepEqual(await readGames(root, id), [secondPgn]);
    const storedReport = await readReport(root, id);
    assert.equal(storedReport.gamesDigest, digestGames(await readGames(root, id)));
    assert.equal(storedReport.games[0]?.white, 'Grace');
  });

  it('uses one PGN snapshot for parsing, digest, and the saved batch', async () => {
    const root = useRoot();
    const samples = Array.from({ length: 10 }, (_unused, index) => sample(index * 1_000_000));
    const id = await session(root, samples, 10_000_000);
    const pgn = pgnAt(EPOCH + 10_000);
    const submitted = [pgn];
    let releaseEvaluation: () => void = () => undefined;
    let markEvaluation: () => void = () => undefined;
    const evaluationGate = new Promise<void>((resolve) => {
      releaseEvaluation = resolve;
    });
    const evaluationStarted = new Promise<void>((resolve) => {
      markEvaluation = resolve;
    });
    const evaluator = {
      async evaluate(fen: string) {
        markEvaluation();
        await evaluationGate;
        return { fen, depth: 8, evalFailed: false, scoreCp: 12, bestmove: 'e7e5' };
      },
      async close() {},
    };

    const building = buildReport(root, id, submitted, evaluator);
    const first = await Promise.race([
      evaluationStarted.then(() => null),
      building.then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      ),
    ]);
    try {
      if (first !== null) {
        if ('error' in first) throw first.error;
        assert.fail('the build settled before evaluation started');
      }
      submitted.push(pgn.replace('[White "Ada"]', '[White "Late"]'));
      releaseEvaluation();
      const result = await building;

      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.deepEqual(await readGames(root, id), [pgn]);
      assert.equal(result.gamesDigest, digestGames([pgn]));
      assert.equal(result.games[0]?.white, 'Ada');
    } finally {
      releaseEvaluation();
    }
  });

  it('rejects a hand-edited stored PGN batch before any provider call', async () => {
    const root = useRoot();
    const samples = Array.from({ length: 10 }, (_unused, index) => sample(index * 1_000_000));
    const id = await session(root, samples, 10_000_000);
    const pgn = pgnAt(EPOCH + 10_000);
    assert.equal((await buildReport(root, id, [pgn], evaluator())).ok, true);
    const editedPgn = pgn.replace('[White "Ada"]', '[White "Edited"]');
    await writeFile(path.join(root, 'sessions', id, 'games.json'), JSON.stringify([editedPgn]));
    const storedReport = await readReport(root, id);
    const storedGames = await readGames(root, id);
    let calls = 0;

    await assert.rejects(
      requestInsight(
        { sessionId: id, provider: 'openai', text: 'Review this session.' },
        storedReport,
        storedGames,
        { CP_AI_KEY: 'test-secret', CP_AI_MODEL: 'test-model' },
        {
          fetch: async () => {
            calls += 1;
            return new Response('{}', { status: 500 });
          },
        },
      ),
      /Build the report again/,
    );
    assert.equal(calls, 0);
  });
});
