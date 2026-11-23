import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Report } from './contracts.js';
import { buildReportSummary, durationLabel, headlineKind, reportTotals, splitSentences } from './summary.js';

const base: Report = {
  ok: true,
  schemaVersion: 1,
  sessionId: 's1',
  gamesDigest: 'a'.repeat(64),
  coveragePct: 88.4,
  baselineBpm: 81.4,
  verdict: '14 blunders, 0 of them while your pulse was elevated. Accuracy 89% settled, 89% elevated. Between games 9 and 10 you waited 1 minute.',
  settled: { band: 'settled', moves: 300, status: 'ok', accuracy: 89 },
  elevated: { band: 'elevated', moves: 126, status: 'ok', accuracy: 89 },
  engine: { depth: 12, positions: 0, scored: 0, failed: 0, reasons: { timeout: 0, crash: 0, engine: 0, budget: 0 } },
  alignmentMode: 'marks',
  toleranceSec: 0,
  games: [],
  timeline: { startUs: 0, stopUs: 2_040_000_000, baselineBpm: 81.4, elevatedThresholdBpm: 91.4, samples: [], games: [], moves: [] },
};
const totals = (blunders: number, elevatedBlunders: number, scored = 426) => ({
  gamesIncluded: 10, scored, unscored: 0, blunders, elevatedBlunders,
});

describe('headlineKind', () => {
  it('follows the precedence: no scores, thin bands, no blunders, then where blunders fell', () => {
    assert.equal(headlineKind(base, totals(0, 0, 0)), 'no_scored');
    assert.equal(headlineKind({ ...base, elevated: { band: 'elevated', moves: 3, status: 'insufficient' } }, totals(5, 1)), 'thin_bands');
    assert.equal(headlineKind(base, totals(0, 0)), 'no_blunders');
    assert.equal(headlineKind(base, totals(14, 8)), 'most_elevated');
    assert.equal(headlineKind(base, totals(14, 7)), 'some_elevated', 'exactly half is not "most"');
    assert.equal(headlineKind(base, totals(14, 0)), 'none_elevated');
  });
});

describe('reportTotals', () => {
  it('prefers stored totals', () => {
    assert.deepEqual(reportTotals({ ...base, totals: totals(14, 0) }), totals(14, 0));
  });

  it('counts an older report from its stored moves', () => {
    const move = (blunder: boolean, band: 'settled' | 'elevated' | null, scored = true) => ({
      gameIndex: 0, moveIndex: 0, san: 'e4', tUs: 1, cpl: 0, thinkSec: 1, blunder, mate: false, scored, band,
    });
    const legacy: Report = {
      ...base,
      games: [{ index: 0, white: 'Ada', black: 'Nim', result: '1-0', ending: 'resignation', includeInStats: true, moveCount: 4, blunders: 2, aligned: true }],
      timeline: { ...base.timeline, moves: [move(true, 'elevated'), move(true, 'settled'), move(false, 'settled'), move(false, null, false)] },
    };
    assert.deepEqual(reportTotals(legacy), { gamesIncluded: 1, scored: 3, unscored: 1, blunders: 2, elevatedBlunders: 1 });
  });
});

describe('buildReportSummary', () => {
  it('labels every value from the report and marks four as primary', () => {
    const view = buildReportSummary({ ...base, totals: totals(14, 0), longestGap: { afterIndex: 8, beforeIndex: 9, durationSec: 60 } });
    assert.deepEqual(
      view.metrics.map((metric) => [metric.key, metric.value]),
      [
        ['baseline', '81.4 bpm'],
        ['threshold', '91.4 bpm'],
        ['coverage', '88%'],
        ['blunders', '14'],
        ['games', '10'],
        ['scored', '426'],
        ['settledAccuracy', '89%'],
        ['elevatedAccuracy', '89%'],
        ['longestBreak', '1 min'],
      ],
    );
    assert.deepEqual(view.metrics.filter((metric) => metric.primary).map((metric) => metric.key), ['baseline', 'threshold', 'coverage', 'blunders']);
    assert.equal(view.durationLabel, '34 min');
    assert.equal(view.headline, 'none_elevated');
    assert.equal(view.personal, false);
  });

  it('shows a thin band as a word, omits a break that was never marked, and is personal only for one player', () => {
    const view = buildReportSummary({
      ...base,
      elevated: { band: 'elevated', moves: 2, status: 'insufficient' },
      playerScope: { kind: 'player', name: 'Ada' },
    });
    assert.equal(view.metrics.find((metric) => metric.key === 'elevatedAccuracy')?.value, 'Insufficient');
    assert.equal(view.metrics.some((metric) => metric.key === 'longestBreak'), false);
    assert.equal(view.personal, true);
  });

  it('splits the verdict into its sentences without changing them', () => {
    const view = buildReportSummary(base);
    assert.deepEqual(view.verdictLines, [
      '14 blunders, 0 of them while your pulse was elevated.',
      'Accuracy 89% settled, 89% elevated.',
      'Between games 9 and 10 you waited 1 minute.',
    ]);
    assert.equal(view.verdictLines.join(' '), base.verdict);
  });
});

describe('formatting helpers', () => {
  it('never splits a decimal and uses minutes from one minute up', () => {
    assert.deepEqual(splitSentences('Baseline 81.4 bpm held. Done.'), ['Baseline 81.4 bpm held.', 'Done.']);
    assert.equal(durationLabel(59.4), '59 s');
    assert.equal(durationLabel(60), '1 min');
    assert.equal(durationLabel(2040), '34 min');
  });
});
