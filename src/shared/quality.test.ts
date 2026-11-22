import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GameSummaryData, Report, ReportGame, TimelineMove } from './contracts.js';
import { compareBands, gameQuality, needsRebuild, overallQuality } from './quality.js';
import { nearestSampleIndex } from './timeline.js';

const ok = (band: 'settled' | 'elevated', accuracy: number, moves = 20) =>
  ({ band, moves, status: 'ok', accuracy }) as const;
const thin = (band: 'settled' | 'elevated', moves = 3) => ({ band, moves, status: 'insufficient' }) as const;

const summary = (overrides: Partial<GameSummaryData> = {}): GameSummaryData => ({
  scored: 30,
  unscored: 2,
  overall: { moves: 30, status: 'ok', accuracy: 84 },
  settled: ok('settled', 88, 20),
  elevated: ok('elevated', 79, 10),
  blunders: 2,
  elevatedBlunders: 1,
  avgThinkSec: 6.4,
  largestLosses: [
    { moveIndex: 23, cpl: 412, blunder: true },
    { moveIndex: 9, cpl: 180, blunder: false },
  ],
  ...overrides,
});

const game = (index: number, overrides: Partial<ReportGame> = {}): ReportGame => ({
  index,
  white: 'Ada',
  black: `Opp${index}`,
  result: '1-0',
  ending: 'resignation',
  includeInStats: true,
  moveCount: 40,
  blunders: 2,
  aligned: true,
  playerSide: 'black',
  summary: summary(),
  ...overrides,
});

const move = (gameIndex: number, moveIndex: number, san: string, tUs: number | null): TimelineMove => ({
  gameIndex, moveIndex, san, tUs, cpl: 0, thinkSec: 1, blunder: false, mate: false, scored: true, band: 'settled',
});

const report = (games: ReportGame[], extra: Partial<Report> = {}): Report => ({
  ok: true,
  schemaVersion: 1,
  sessionId: 's1',
  gamesDigest: 'a'.repeat(64),
  coveragePct: 90,
  baselineBpm: 80,
  verdict: 'v.',
  settled: ok('settled', 89, 300),
  elevated: ok('elevated', 81, 120),
  engine: { depth: 12, positions: 0, scored: 0, failed: 0, reasons: { timeout: 0, crash: 0, engine: 0, budget: 0 } },
  alignmentMode: 'marks',
  toleranceSec: 0,
  totals: { gamesIncluded: 2, scored: 60, unscored: 4, blunders: 4, elevatedBlunders: 2 },
  games,
  timeline: {
    startUs: 1_000_000,
    stopUs: 2_000_000_000,
    baselineBpm: 80,
    elevatedThresholdBpm: 90,
    samples: [],
    games: games.map((candidate) => ({
      index: candidate.index,
      white: candidate.white,
      black: candidate.black,
      result: candidate.result,
      ending: candidate.ending,
      includeInStats: candidate.includeInStats,
      startUs: 61_000_000 + candidate.index * 600_000_000,
      endUs: 541_000_000 + candidate.index * 600_000_000,
    })),
    moves: [move(0, 9, 'Bb4', 200_000_000), move(0, 23, 'Qxd5', 400_000_000), move(1, 23, 'Nc6', 1_000_000_000)],
  },
  ...extra,
});

describe('compareBands', () => {
  it('compares the rounded percentages a reader sees', () => {
    assert.deepEqual(compareBands(ok('settled', 89), ok('elevated', 81)), { kind: 'settled_higher', difference: 8 });
    assert.deepEqual(compareBands(ok('settled', 70), ok('elevated', 75)), { kind: 'elevated_higher', difference: 5 });
    assert.deepEqual(compareBands(ok('settled', 89.4), ok('elevated', 88.6)), { kind: 'same' }, '89 and 89 print as equal');
  });
  it('makes no comparison when either range is under the floor', () => {
    assert.deepEqual(compareBands(ok('settled', 89), thin('elevated')), { kind: 'insufficient' });
    assert.deepEqual(compareBands(thin('settled'), ok('elevated', 70)), { kind: 'insufficient' });
  });
});

describe('overallQuality', () => {
  it('reads the session bands, stored totals, and one row per game', () => {
    const excluded = game(2, { includeInStats: false, ending: 'aborted', summary: undefined, blunders: 0 });
    const short = game(1, { summary: summary({ overall: { moves: 3, status: 'insufficient' } }) });
    const view = overallQuality(report([game(0), short, excluded]));
    assert.deepEqual(view.comparison, { kind: 'settled_higher', difference: 8 });
    assert.equal(view.totals.blunders, 4);
    assert.equal(view.gamesExcluded, 1);
    assert.deepEqual(
      view.rows.map((row) => [row.number, row.accuracy, row.blunders, row.included]),
      [
        [1, 84, 2, true],
        [2, 'insufficient', 2, true],
        [3, null, null, false],
      ],
    );
    assert.equal(view.needsRebuild, false, 'an excluded game never has a summary, so it does not ask for a rebuild');
  });
  it('asks for a rebuild when a counted game has no stored summary, and invents no accuracy', () => {
    const legacy = report([game(0, { summary: undefined })], { totals: undefined });
    assert.equal(needsRebuild(legacy), true);
    const view = overallQuality(legacy);
    assert.equal(view.rows[0]?.accuracy, null);
    assert.equal(view.rows[0]?.blunders, 2, 'falls back to the stored per-game blunder count');
  });
});

describe('gameQuality', () => {
  it('pairs each largest loss with its move and session time', () => {
    const view = gameQuality(report([game(0), game(1)]), 0);
    assert.ok(view && view.kind === 'ok');
    assert.deepEqual(view.span, { start: '1:00', end: '9:00' });
    assert.deepEqual(view.comparison, { kind: 'settled_higher', difference: 9 });
    assert.deepEqual(
      view.losses.map((loss) => [loss.label, loss.cpl, loss.blunder, loss.tUs]),
      [
        ['12… Qxd5', 412, true, 400_000_000],
        ['5… Bb4', 180, false, 200_000_000],
      ],
      'the moves come from this game, not the other game with the same move index',
    );
  });
  it('gives no timeline link or span for a game that was not placed', () => {
    const view = gameQuality(report([game(0, { aligned: false })]), 0);
    assert.ok(view && view.kind === 'ok');
    assert.equal(view.span, null);
    assert.deepEqual(view.losses.map((loss) => loss.tUs), [null, null]);
  });
  it('labels a loss whose move is missing by its number alone', () => {
    const view = gameQuality(report([game(1)]), 1);
    assert.ok(view && view.kind === 'ok');
    assert.deepEqual(view.losses.map((loss) => loss.label), ['12… Nc6', '5…']);
  });
  it('separates excluded games, games needing a rebuild, and unknown indexes', () => {
    const games = [game(0, { includeInStats: false, ending: 'aborted', summary: undefined }), game(1, { summary: undefined })];
    assert.equal(gameQuality(report(games), 0)?.kind, 'excluded');
    assert.equal(gameQuality(report(games), 1)?.kind, 'needs_rebuild');
    assert.equal(gameQuality(report(games), 7), null);
  });
});

describe('nearestSampleIndex', () => {
  const samples = [10, 20, 30, 40].map((tUs) => ({ tUs, bpm: 80, confidence: 90, stable: true }));
  it('picks the closest reading, the earlier one on a tie, and clamps at both ends', () => {
    assert.equal(nearestSampleIndex(samples, 22), 1);
    assert.equal(nearestSampleIndex(samples, 28), 2);
    assert.equal(nearestSampleIndex(samples, 25), 1);
    assert.equal(nearestSampleIndex(samples, 0), 0);
    assert.equal(nearestSampleIndex(samples, 99), 3);
    assert.equal(nearestSampleIndex([], 5), null);
  });
});
