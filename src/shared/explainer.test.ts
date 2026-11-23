import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Report } from './contracts.js';
import { QUESTION_KEYS, unavailableQuestions } from './explainer.js';

const base: Report = {
  ok: true, schemaVersion: 1, sessionId: 's1', gamesDigest: 'a'.repeat(64), coveragePct: 90, baselineBpm: 80, verdict: 'v.',
  settled: { band: 'settled', moves: 3, status: 'insufficient' }, elevated: { band: 'elevated', moves: 0, status: 'insufficient' },
  engine: { depth: 12, positions: 0, scored: 0, failed: 0, reasons: { timeout: 0, crash: 0, engine: 0, budget: 0 } },
  alignmentMode: 'marks', toleranceSec: 0,
  games: [{ index: 0, white: 'Ada', black: 'Nim', result: '1-0', ending: 'resignation', includeInStats: true, moveCount: 2, blunders: 0, aligned: true }],
  timeline: {
    startUs: 0, stopUs: 1, baselineBpm: 80, elevatedThresholdBpm: 90, samples: [], games: [],
    moves: [{ gameIndex: 0, moveIndex: 0, san: 'e4', tUs: 1, cpl: 0, thinkSec: null, blunder: false, mate: false, scored: true, band: 'settled' }],
  },
};

describe('unavailableQuestions', () => {
  it('offers ten questions and disables the three whose data an older report lacks', () => {
    assert.equal(QUESTION_KEYS.length, 10);
    assert.deepEqual(unavailableQuestions(base), { mistakes: 'mistakes', thinkTime: 'thinkTime', longestBreak: 'longestBreak' });
  });
  it('enables them when summaries, clock times, and a marked break exist', () => {
    const full: Report = {
      ...base,
      longestGap: { afterIndex: 0, beforeIndex: 1, durationSec: 60 },
      games: [{
        ...base.games[0]!,
        summary: {
          scored: 1, unscored: 0, overall: { moves: 1, status: 'insufficient' },
          settled: { band: 'settled', moves: 1, status: 'insufficient' }, elevated: { band: 'elevated', moves: 0, status: 'insufficient' },
          blunders: 0, elevatedBlunders: 0, avgThinkSec: 2, largestLosses: [],
        },
      }],
      timeline: { ...base.timeline, moves: [{ ...base.timeline.moves[0]!, thinkSec: 2 }] },
    };
    assert.deepEqual(unavailableQuestions(full), {});
  });
});
