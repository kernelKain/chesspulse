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
import {
  createBandLookup,
  buildReport,
  COVERAGE_GATE_PCT,
  elevatedClaim,
  formatResult,
  refusalRemedy,
} from './report.js';
import { positionsFromMoves } from './analysis/positions.js';
import { ENGINE_DEPTH } from './engine.js';
import { requestInsight } from './ai/service.js';
import { ingestSamples, recordFraming, recordMark, startSession, stopSession } from './session.js';
import { VALIDATION } from '../shared/framing.js';
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
  gameEnds: readonly number[] = [stopUs],
  nextStarts: readonly number[] = [],
): Promise<string> {
  const started = await startSession(root, { monoUs: 0, epochMs: startEpoch }, '60');
  await ingestSamples(root, samples);
  // Placement comes only from the player's marks, so every fixture states where its games ended.
  for (const atUs of nextStarts) recordMark(root, 'next', atUs);
  for (const atUs of gameEnds) recordMark(root, 'end', atUs);
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
    const id = await session(root, samples, 45_000_000, EPOCH, [30_000_000, 45_000_000]);
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
        { sessionId: id, text: 'Review this session.' },
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

describe('placement from player marks', () => {
  it('shows the session as one block with a banner when the player made no marks', async () => {
    const root = useRoot();
    const samples = Array.from({ length: 11 }, (_unused, index) => sample(index * 1_000_000));
    const id = await session(root, samples, 10_000_000, EPOCH, []);
    // The PGN carries an EndTime. It must not place the game: only marks may.
    const result = await buildReport(root, id, [pgnAt(EPOCH + 10_000)], evaluator());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.alignmentMode, 'none');
    assert.equal(result.banner, 'No game-end marks: games are not placed on the timeline.');
    assert.equal(result.games[0]?.aligned, false);
    assert.equal(result.games[0]?.includeInStats, true);
    assert.equal(result.games[0]?.summary, undefined, 'an unplaced game is not summarised as a clean game');
    assert.equal(result.timeline.games.length, 0);
    assert.equal(result.verdict, 'Not enough scored moves for a verdict.');
  });

  it('refuses to place games when the marks do not match the pasted count', async () => {
    const root = useRoot();
    const samples = Array.from({ length: 11 }, (_unused, index) => sample(index * 1_000_000));
    const id = await session(root, samples, 10_000_000, EPOCH, [2_000_000, 4_000_000, 6_000_000]);
    await assert.rejects(
      buildReport(root, id, [pgnAt(EPOCH + 4_000), pgnAt(EPOCH + 8_000)], evaluator()),
      /does not match the number of pasted games/,
    );
  });
});

describe('player scope', () => {
  /** Four plies with clocks. No header time, so order is unverified and placement uses marks only. */
  function gamePgn(white: string, black: string): string {
    return `[Event "Live Chess"]
[White "${white}"]
[Black "${black}"]
[Result "1-0"]
[TimeControl "60"]
[Termination "${white} won by resignation"]

1. e4 {[%clk 0:00:59]} e5 {[%clk 0:00:59]} 2. Nf3 {[%clk 0:00:58]} Nc6 {[%clk 0:00:58]} 1-0
`;
  }

  async function twoGameSession(root: string): Promise<string> {
    const samples = Array.from({ length: 11 }, (_unused, index) => sample(index * 1_000_000));
    return session(root, samples, 10_000_000, EPOCH, [4_000_000, 10_000_000]);
  }

  it('scores only the sensed player when one name is in every game', async () => {
    const root = useRoot();
    const id = await twoGameSession(root);
    const result = await buildReport(root, id, [gamePgn('Ada', 'Nim'), gamePgn('Bo', 'ada')], evaluator());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.playerScope, { kind: 'player', name: 'Ada' });
    assert.deepEqual(result.games.map((game) => game.playerSide), ['white', 'black']);
    // Ada had White in game 1 (plies 0 and 2) and Black in game 2 (plies 1 and 3).
    assert.deepEqual(
      result.timeline.moves.map((move) => [move.gameIndex, move.moveIndex, move.san]),
      [[0, 0, 'e4'], [0, 2, 'Nf3'], [1, 1, 'e5'], [1, 3, 'Nc6']],
    );
    // Game facts still describe the whole game; only scoring is narrowed.
    assert.deepEqual(result.games.map((game) => game.moveCount), [4, 4]);
  });

  it('scores the chosen player in a single game, case-insensitively', async () => {
    const root = useRoot();
    const samples = Array.from({ length: 11 }, (_unused, index) => sample(index * 1_000_000));
    const id = await session(root, samples, 10_000_000);
    const result = await buildReport(root, id, [gamePgn('Ada', 'Nim')], evaluator(), {}, undefined, 'nim');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.playerScope, { kind: 'player', name: 'Nim' });
    assert.equal(result.games[0]?.playerSide, 'black');
    assert.deepEqual(result.timeline.moves.map((move) => move.san), ['e5', 'Nc6']);
  });

  it('counts both sides and says why when no player was chosen in a single game', async () => {
    const root = useRoot();
    const samples = Array.from({ length: 11 }, (_unused, index) => sample(index * 1_000_000));
    const id = await session(root, samples, 10_000_000);
    const result = await buildReport(root, id, [gamePgn('Ada', 'Nim')], evaluator());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.playerScope, { kind: 'all_moves', reason: 'ambiguous' });
    assert.equal(result.games[0]?.playerSide, 'both');
    assert.equal(result.timeline.moves.length, 4);
  });

  it('counts both sides when no name is in every game', async () => {
    const root = useRoot();
    const id = await twoGameSession(root);
    const result = await buildReport(root, id, [gamePgn('Ada', 'Nim'), gamePgn('Bo', 'Cy')], evaluator());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.playerScope, { kind: 'all_moves', reason: 'no_common_name' });
    assert.equal(result.timeline.moves.length, 8);
  });

  it('refuses a chosen player who is missing from a game and writes nothing', async () => {
    const root = useRoot();
    const id = await twoGameSession(root);
    await assert.rejects(
      buildReport(root, id, [gamePgn('Ada', 'Nim'), gamePgn('Ada', 'Bo')], evaluator(), {}, undefined, 'Nim'),
      /not in every pasted game/,
    );
    await assert.rejects(readReport(root, id));
  });

  it('sends the engine only the positions around the player’s moves', async () => {
    const root = useRoot();
    const samples = Array.from({ length: 11 }, (_unused, index) => sample(index * 1_000_000));
    const id = await session(root, samples, 10_000_000);
    const seen: string[] = [];
    const counting = {
      async evaluate(fen: string) {
        seen.push(fen);
        return { fen, depth: 8, evalFailed: false, scoreCp: 12, bestmove: 'e7e5' };
      },
      async close() {},
    };
    const pgn = gamePgn('Ada', 'Nim');
    const white = await buildReport(root, id, [pgn], counting, {}, undefined, 'Ada');
    assert.equal(white.ok, true);
    if (!white.ok) return;
    const sans = ['e4', 'e5', 'Nf3', 'Nc6'];
    const positions = positionsFromMoves(sans);
    const expected = new Set(
      [0, 2].flatMap((ply) => [positions[ply]?.fenBefore, positions[ply]?.fenAfter]).filter(Boolean),
    );
    assert.deepEqual(new Set(seen), expected);
    assert.equal(white.engine.positions, expected.size);
  });
});

describe('per-game summaries', () => {
  function threeMovePgn(white: string, black: string, ending = 'won by resignation'): string {
    return `[Event "Live Chess"]
[White "${white}"]
[Black "${black}"]
[Result "1-0"]
[TimeControl "60"]
[Termination "${white} ${ending}"]

1. e4 {[%clk 0:00:59]} e5 {[%clk 0:00:59]} 2. Nf3 {[%clk 0:00:57]} Nc6 {[%clk 0:00:58]} 3. Bb5 {[%clk 0:00:54]} a6 {[%clk 0:00:57]} 1-0
`;
  }

  /** Deterministic, varied scores so losses and accuracy are not all equal. */
  function varied() {
    return {
      async evaluate(fen: string) {
        let hash = 0;
        for (const char of fen) hash = (hash * 31 + char.charCodeAt(0)) % 997;
        return { fen, depth: 8, evalFailed: false, scoreCp: (hash % 9) * 40 - 160, bestmove: 'e7e5' };
      },
      async close() {},
    };
  }

  it('stores per-game facts that agree with the session totals', async () => {
    const root = useRoot();
    const samples = Array.from({ length: 21 }, (_unused, index) => sample(index * 1_000_000));
    const id = await session(root, samples, 20_000_000, EPOCH, [8_000_000, 20_000_000], [12_000_000]);
    const result = await buildReport(
      root,
      id,
      [threeMovePgn('Ada', 'Nim'), threeMovePgn('Bo', 'Ada')],
      varied(),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const summaries = result.games.map((game) => game.summary);
    assert.ok(summaries.every((summary) => summary !== undefined));
    const sum = (pick: (summary: NonNullable<(typeof summaries)[number]>) => number) =>
      summaries.reduce((total, summary) => total + (summary ? pick(summary) : 0), 0);
    assert.deepEqual(result.totals, {
      gamesIncluded: 2,
      scored: sum((summary) => summary.scored),
      unscored: sum((summary) => summary.unscored),
      blunders: sum((summary) => summary.blunders),
      elevatedBlunders: sum((summary) => summary.elevatedBlunders),
    });
    // Ada made three moves in each game; the per-game blunder field and the summary agree.
    for (const game of result.games) {
      assert.equal(game.summary?.scored, 3);
      assert.equal(game.summary?.blunders, game.blunders);
      assert.equal(game.summary?.overall.status, 'insufficient');
      const cpls: [number, number][] = result.timeline.moves
        .filter((move) => move.gameIndex === game.index)
        .map((move): [number, number] => [move.moveIndex, Math.round(move.cpl ?? 0)]);
      for (const loss of game.summary?.largestLosses ?? []) {
        assert.ok(cpls.some(([moveIndex, cpl]) => moveIndex === loss.moveIndex && cpl === loss.cpl));
      }
      const losses: number[] = (game.summary?.largestLosses ?? []).map((loss) => loss.cpl);
      assert.deepEqual(losses, [...losses].sort((left, right) => right - left));
    }
    assert.ok(result.timeline.moves.every((move) => !move.scored || Number.isInteger(move.accuracy)));
    assert.deepEqual(result.longestGap, { afterIndex: 0, beforeIndex: 1, durationSec: 4 });
    assert.match(result.verdict, /Between games 1 and 2 you waited 4 seconds\./);
  });

  it('gives an excluded game no summary and leaves it out of the totals', async () => {
    const root = useRoot();
    const samples = Array.from({ length: 21 }, (_unused, index) => sample(index * 1_000_000));
    const id = await session(root, samples, 20_000_000, EPOCH, [8_000_000, 20_000_000]);
    const aborted = threeMovePgn('Ada', 'Nim').replace('[Termination "Ada won by resignation"]', '[Termination "Game aborted"]');
    const result = await buildReport(root, id, [aborted, threeMovePgn('Bo', 'Ada')], varied(), {}, undefined, 'Ada');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.games[0]?.includeInStats, false);
    assert.equal(result.games[0]?.summary, undefined);
    assert.equal(result.totals?.gamesIncluded, 1);
    assert.equal(result.totals?.scored, result.games[1]?.summary?.scored);
  });

  it('names the engine only when the evaluator names itself', async () => {
    const root = useRoot();
    const samples = Array.from({ length: 11 }, (_unused, index) => sample(index * 1_000_000));
    const id = await session(root, samples, 10_000_000);
    const stub = await buildReport(root, id, [pgnAt(EPOCH + 10_000)], evaluator());
    assert.equal(stub.ok && stub.engine.name, undefined);
    const named = await buildReport(root, id, [pgnAt(EPOCH + 10_000)], {
      ...evaluator(),
      depth: 12,
      identity: { name: 'Stockfish', version: '19.0.1', build: 'lite-single' },
    });
    assert.equal(named.ok, true);
    if (!named.ok) return;
    assert.deepEqual(
      [named.engine.name, named.engine.version, named.engine.build, named.engine.depth],
      ['Stockfish', '19.0.1', 'lite-single', 12],
    );
  });
});

describe('occluded samples', () => {
  it('reports the covered time and keeps it out of coverage', async () => {
    const root = useRoot();
    const samples = Array.from({ length: 11 }, (_unused, index) => ({
      ...sample(index * 1_000_000),
      ...(index >= 2 && index <= 4 ? { occluded: true } : {}),
    }));
    const id = await session(root, samples, 10_000_000, EPOCH, []);
    const result = await buildReport(root, id, [pgnAt(EPOCH + 10_000)], evaluator());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.occludedSec, 3);
    // Seven measured seconds of ten: the three covered ones are not counted, and neither is the
    // last sample's hold beyond the stop.
    assert.equal(Math.round(result.coveragePct), 70);
  });
});

describe('chosen marks after a mismatch', () => {
  it('places the games at the marks the player picked', async () => {
    const root = useRoot();
    const samples = Array.from({ length: 11 }, (_unused, index) => sample(index * 1_000_000));
    const id = await session(root, samples, 10_000_000, EPOCH, [2_000_000, 4_000_000, 6_000_000]);
    await assert.rejects(
      buildReport(root, id, [pgnAt(EPOCH + 4_000), pgnAt(EPOCH + 8_000)], evaluator()),
      /does not match the number of pasted games/,
    );
    const result = await buildReport(
      root,
      id,
      [pgnAt(EPOCH + 4_000), pgnAt(EPOCH + 8_000)],
      evaluator(),
      {},
      [2_000_000, 6_000_000],
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.alignmentMode, 'marks');
    assert.deepEqual(
      result.timeline.games.map((entry) => [entry.startUs, entry.endUs]),
      [
        [0, 2_000_000],
        [2_000_000, 6_000_000],
      ],
    );
  });

  it('keeps the recorded start between games and honors a chosen next mark', async () => {
    const root = useRoot();
    const samples = Array.from({ length: 16 }, (_unused, index) => sample(index * 1_000_000));
    const id = await session(
      root,
      samples,
      20_000_000,
      EPOCH,
      [6_000_000, 12_000_000, 15_000_000],
      [9_000_000],
    );
    const pgns = [pgnAt(EPOCH + 4_000), pgnAt(EPOCH + 8_000)];

    // Three ends for two games, so the player has to answer.
    await assert.rejects(
      buildReport(root, id, pgns, evaluator()),
      /does not match the number of pasted games/,
    );
    const result = await buildReport(root, id, pgns, evaluator(), {}, [6_000_000, 15_000_000]);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(
      result.timeline.games.map((entry) => [entry.startUs, entry.endUs]),
      [
        [0, 6_000_000],
        [9_000_000, 15_000_000],
      ],
    );
  });

  it('accepts a chosen next mark as a game ending', async () => {
    const root = useRoot();
    const samples = Array.from({ length: 16 }, (_unused, index) => sample(index * 1_000_000));
    const id = await session(
      root,
      samples,
      20_000_000,
      EPOCH,
      [6_000_000, 12_000_000, 15_000_000],
      [9_000_000],
    );
    const result = await buildReport(
      root,
      id,
      [pgnAt(EPOCH + 4_000), pgnAt(EPOCH + 8_000)],
      evaluator(),
      {},
      [9_000_000, 15_000_000],
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.timeline.games[0]?.endUs, 9_000_000);
  });

  it('rejects a mark the session never recorded', async () => {
    const root = useRoot();
    const samples = Array.from({ length: 11 }, (_unused, index) => sample(index * 1_000_000));
    const id = await session(root, samples, 10_000_000, EPOCH, [2_000_000, 4_000_000]);
    await assert.rejects(
      buildReport(root, id, [pgnAt(EPOCH + 4_000), pgnAt(EPOCH + 8_000)], evaluator(), {}, [1, 2]),
      /was not recorded in this session/,
    );
  });
});

describe('refusal cause from the session', () => {
  it('names the cause in a low-coverage refusal', async () => {
    const root = useRoot();
    const started = await startSession(root, { monoUs: 0, epochMs: EPOCH }, '60');
    await ingestSamples(root, [sample(0), sample(1_000_000)]);
    for (let index = 0; index < 3; index += 1) recordFraming(root, VALIDATION.noFaceFound);
    recordFraming(root, VALIDATION.tooDark);
    await stopSession(root, { monoUs: 10_000_000, epochMs: EPOCH + 10_000 }, 'user');

    const result = await buildReport(root, started.id, [pgnAt(EPOCH + 10_000)]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'low_coverage');
    assert.match(result.remedy, /out of frame in 75% of the framing checks/);
  });
});

describe('chosen partial ends', () => {
  it('keeps the next mark that belongs to a chosen end', async () => {
    const root = useRoot();
    const samples = Array.from({ length: 31 }, (_unused, index) => sample(index * 1_000_000));
    const id = await session(root, samples, 30_000_000, EPOCH, [10_000_000, 30_000_000], [22_000_000]);
    // One game, ended at 30 s: its start is the 22 s mark, not the session start.
    const result = await buildReport(root, id, [pgnAt(EPOCH + 10_000)], evaluator(), {}, [30_000_000]);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(
      result.timeline.games.map((entry) => [entry.startUs, entry.endUs]),
      [[22_000_000, 30_000_000]],
    );
  });
});

describe('refusal remedy', () => {
  it('names the most frequent cause and its share', () => {
    const remedy = refusalRemedy({ total: 10, counts: { no_face: 4, too_dark: 2 } });
    assert.equal(
      remedy,
      'The face was out of frame in 40% of the framing checks. Sit centred, with your upper chest in view.',
    );
  });

  it('breaks a tie in the fixed cause order', () => {
    const remedy = refusalRemedy({ total: 4, counts: { too_dark: 2, no_face: 2 } });
    assert.match(remedy, /out of frame/);
  });

  it('keeps the generic remedy for a session that recorded no counts', () => {
    assert.match(refusalRemedy(undefined), /Most often this is lighting or moving out of frame/);
    assert.match(refusalRemedy({ total: 3, counts: {} }), /Most often this is lighting/);
  });

  it('rounds the share to a whole percent', () => {
    const remedy = refusalRemedy({ total: 3, counts: { motion: 1 } });
    assert.match(remedy, /33%/);
    assert.match(remedy, /too much movement/);
  });
});

describe('read-only example sessions', () => {
  it('still returns the real coverage refusal for a refused example', async () => {
    const root = useRoot();
    const id = await session(
      root,
      [sample(0), sample(1_000_000), sample(2_000_000), sample(3_000_000)],
      10_000_000,
    );
    const result = await buildReport(root, id, [pgnAt(EPOCH + 10_000)], evaluator(), { readOnly: true });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'low_coverage');
    await assert.rejects(readFile(path.join(root, 'sessions', id, 'report.json'), 'utf8'));
  });

  it('rejects a build that passes the gate before scoring, and writes nothing', async () => {
    const root = useRoot();
    const samples = Array.from({ length: 10 }, (_unused, index) => sample(index * 1_000_000));
    const id = await session(root, samples, 10_000_000);
    let evaluated = 0;
    const counting = {
      async evaluate(fen: string) {
        evaluated += 1;
        return { fen, depth: 8, evalFailed: false, scoreCp: 12, bestmove: 'e7e5' };
      },
      async close() {},
    };
    await assert.rejects(
      buildReport(root, id, [pgnAt(EPOCH + 10_000)], counting, { readOnly: true }),
      (error: unknown) => (error as { code?: string }).code === 'example_read_only',
    );
    assert.equal(evaluated, 0);
    await assert.rejects(readFile(path.join(root, 'sessions', id, 'report.json'), 'utf8'));
    await assert.rejects(readFile(path.join(root, 'sessions', id, 'games.json'), 'utf8'));
  });
});
