import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { bandFor } from './bands.js';
import { analyseMoves, scoreMove, verdictLine, type MoveMetric } from './metrics.js';

const ok = (scoreCp: number) => ({ evalFailed: false, scoreCp });
const failed = { evalFailed: true };

function counted(partial: Partial<MoveMetric> & Pick<MoveMetric, 'band'>): MoveMetric {
  return {
    cpl: partial.cpl ?? 0,
    accuracy: partial.accuracy ?? 80,
    blunder: partial.blunder ?? false,
    band: partial.band,
    includeInStats: partial.includeInStats ?? true,
  };
}

describe('bandFor', () => {
  it('shifts the same pulses when the baseline changes', () => {
    const pulses = [75, 85];
    assert.deepEqual(
      pulses.map((bpm) => bandFor(bpm, 70)),
      ['settled', 'elevated'],
    );
    assert.deepEqual(
      pulses.map((bpm) => bandFor(bpm, 80)),
      ['settled', 'settled'],
    );
    assert.equal(bandFor(80, 70), 'elevated');
    assert.equal(bandFor(Number.NaN, 70), null);
  });
});

describe('scoreMove', () => {
  it('keeps a preserved evaluation at zero loss and full accuracy', () => {
    const move = scoreMove(ok(40), ok(-40), 'settled', true);
    assert.equal(move.cpl, 0);
    assert.equal(move.accuracy, 100);
    assert.equal(move.blunder, false);
  });

  it('marks a large win-chance drop as a blunder and does not invent a mate loss', () => {
    const blunder = scoreMove(ok(0), ok(500), 'elevated', true);
    assert.equal(blunder.cpl, 500);
    assert.ok(blunder.accuracy !== null && Math.abs(blunder.accuracy - 19.062376700446695) < 1e-9);
    assert.equal(blunder.blunder, true);
    const mate = scoreMove({ evalFailed: false, mate: 1 }, ok(-100), 'settled', true);
    const missing = scoreMove(failed, ok(-20), 'settled', true);
    assert.equal(mate.cpl, null);
    assert.equal(mate.blunder, false);
    assert.equal(missing.cpl, null);
    assert.equal(missing.accuracy, null);
  });
});

describe('analyseMoves', () => {
  it('withholds a percentage when a band has two moves', () => {
    const summary = analyseMoves([
      counted({ band: 'elevated', accuracy: 40 }),
      counted({ band: 'elevated', accuracy: 50 }),
    ]);
    assert.deepEqual(summary.elevated, { band: 'elevated', moves: 2, status: 'insufficient' });
    assert.equal('accuracy' in summary.elevated, false);
  });

  it('rounds five settled moves and ignores an excluded blunder', () => {
    const summary = analyseMoves([
      counted({ band: 'settled', accuracy: 70 }),
      counted({ band: 'settled', accuracy: 70 }),
      counted({ band: 'settled', accuracy: 70 }),
      counted({ band: 'settled', accuracy: 70 }),
      counted({ band: 'settled', accuracy: 73, blunder: true }),
      counted({ band: 'elevated', accuracy: 10, blunder: true, includeInStats: false }),
    ]);
    assert.deepEqual(summary.settled, { band: 'settled', moves: 5, status: 'ok', accuracy: 71 });
    assert.equal(summary.blunders, 1);
    assert.equal(summary.elevatedBlunders, 0);
    assert.deepEqual(analyseMoves([
      counted({ band: 'settled', accuracy: 70 }),
      counted({ band: 'settled', accuracy: 70 }),
      counted({ band: 'settled', accuracy: 70 }),
      counted({ band: 'settled', accuracy: 70 }),
      counted({ band: 'settled', accuracy: 73, blunder: true }),
      counted({ band: 'elevated', accuracy: 10, blunder: true, includeInStats: false }),
    ]), summary);
  });
});

describe('verdictLine', () => {
  it('prints the template sentence and omits a percentage for a thin band', () => {
    const summary = analyseMoves([
      ...Array.from({ length: 5 }, () => counted({ band: 'settled', accuracy: 71 })),
      ...Array.from({ length: 3 }, () => counted({ band: 'settled', accuracy: 71, blunder: true })),
      ...Array.from({ length: 5 }, () => counted({ band: 'elevated', accuracy: 54, blunder: true })),
    ]);
    assert.equal(summary.blunders, 8);
    assert.equal(summary.elevatedBlunders, 5);
    assert.equal(
      verdictLine(summary, { elevatedMinutes: 11, deltaBpm: 18 }),
      '8 blunders, 5 of them in the 11 minutes your pulse stayed 18 bpm above baseline. Accuracy 71% settled, 54% elevated.',
    );
    const thin = analyseMoves([
      counted({ band: 'elevated', accuracy: 10, blunder: true }),
      counted({ band: 'elevated', accuracy: 20 }),
    ]);
    assert.equal(
      verdictLine(thin, {
        elevatedMinutes: 0,
        deltaBpm: 0,
        gapClause: 'Between games 2 and 3 you waited four minutes and never came down.',
      }),
      '1 blunder, 1 of them while your pulse was elevated. Accuracy settled insufficient, elevated insufficient. Between games 2 and 3 you waited four minutes and never came down.',
    );
  });

  it('uses the singular minute and does not call an unscored mate a blunder', () => {
    const scored = analyseMoves(Array.from({ length: 5 }, () => counted({ band: 'settled', accuracy: 80 })));
    assert.match(
      verdictLine(scored, { elevatedMinutes: 1.4, deltaBpm: 12 }),
      /in the 1 minute your pulse stayed 12 bpm above baseline/,
    );
    const mate = analyseMoves([
      { cpl: null, accuracy: null, blunder: false, band: 'settled', includeInStats: true },
    ]);
    assert.equal(mate.unscored, 1);
    assert.equal(mate.blunders, 0);
    const line = verdictLine(mate, { elevatedMinutes: 0, deltaBpm: 0 });
    assert.match(line, /no centipawn score/);
    assert.equal(line.includes('blunder'), false);
  });

  it('does not import a model', () => {
    const source = readFileSync('src/main/analysis/metrics.ts', 'utf8');
    assert.equal(/from ['"][^'"]*ai/i.test(source), false);
    assert.equal(source.includes('openai'), false);
    assert.equal(source.includes('fetch('), false);
  });
});
