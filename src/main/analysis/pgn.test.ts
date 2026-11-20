import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pgnGameSchema } from '../../shared/contracts.js';
import { parsePgn, parsePgnBatch, thinkTimeSec } from './pgn.js';

const fixtureDir = path.join(process.cwd(), 'tests/fixtures/pgn');

async function fixture(name: string): Promise<string> {
  return readFile(path.join(fixtureDir, name), 'utf8');
}

/** Drops clock-anchor headers so a batch is not rejected for mixed times. */
function undated(pgn: string): string {
  return pgn.replace(/\[(EndDate|EndTime|UTCDate|UTCTime)\s+"[^"]*"\]\r?\n/g, '');
}

function tenths(seconds: number | null): number {
  if (seconds === null) throw new Error('think time was null');
  return Math.round(seconds * 10);
}

describe('parsePgn fixtures', () => {
  it('reads a checkmate, its end time, and think time from clock deltas', async () => {
    const parsed = parsePgn(await fixture('checkmate.pgn'), 0);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(pgnGameSchema.safeParse(parsed.game).success, true);
    assert.equal(parsed.game.ending, 'checkmate');
    assert.equal(parsed.game.includeInStats, true);
    assert.equal(parsed.game.result, '1-0');
    assert.equal(parsed.game.timeControl, '180+2');
    assert.equal(parsed.game.moves.length, 7);
    assert.equal(parsed.game.moves[6].san, 'Qxf7#');
    assert.equal(tenths(parsed.game.moves[0].clockSec ?? -1), 1790);
    assert.equal(parsed.game.endTimeEpochMs, Date.UTC(2026, 10, 20, 12, 10, 0));
    assert.deepEqual(thinkTimeSec(parsed.game).map(tenths), [30, 40, 30, 40, 30, 40, 30]);
  });

  it('reads resignation and the UTC start', async () => {
    const parsed = parsePgn(await fixture('resignation.pgn'), 1);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.game.index, 1);
    assert.equal(parsed.game.ending, 'resignation');
    assert.equal(parsed.game.includeInStats, true);
    assert.equal(parsed.game.startTimeEpochMs, Date.UTC(2026, 10, 20, 12, 0, 0));
    assert.equal(parsed.game.endTimeEpochMs, Date.UTC(2026, 10, 20, 12, 6, 0));
  });

  it('reads a timeout without treating the increment as zero by mistake', async () => {
    const parsed = parsePgn(await fixture('timeout.pgn'), 0);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.game.ending, 'timeout');
    assert.equal(parsed.game.timeControl, '180+0');
    assert.deepEqual(thinkTimeSec(parsed.game).map(tenths), [30, 50, 30]);
  });

  it('excludes an abandoned game from the stats', async () => {
    const parsed = parsePgn(await fixture('abandoned.pgn'), 0);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.game.ending, 'abandoned');
    assert.equal(parsed.game.includeInStats, false);
    assert.deepEqual(thinkTimeSec(parsed.game).map(tenths), [20, 30]);
  });

  it('parses a 1+0 game that has clocks and no EndTime', async () => {
    const parsed = parsePgn(await fixture('bullet-no-end.pgn'), 4);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.game.ending, 'checkmate');
    assert.equal(parsed.game.timeControl, '60');
    assert.equal(parsed.game.endTimeEpochMs, undefined);
    assert.equal(parsed.game.startTimeEpochMs, undefined);
    assert.equal(tenths(parsed.game.moves[0].clockSec ?? -1), 599);
    assert.deepEqual(thinkTimeSec(parsed.game).map(tenths), [1, 16]);
  });

  it('keeps an aborted game in the batch summary and out of the stats', async () => {
    const parsed = parsePgn(await fixture('aborted.pgn'), 2);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.game.ending, 'aborted');
    assert.equal(parsed.game.includeInStats, false);
    assert.deepEqual(parsed.game.moves, []);
    const batch = parsePgnBatch([
      undated(await fixture('checkmate.pgn')),
      await fixture('aborted.pgn'),
      undated(await fixture('abandoned.pgn')),
    ]);
    assert.equal(batch.ok, true);
    if (!batch.ok) return;
    assert.deepEqual(batch.summary, {
      total: 3,
      includedInStats: 1,
      aborted: 1,
      abandoned: 1,
    });
  });
});

describe('parsePgnBatch order', () => {
  it('rejects a batch whose end times run backwards and names the games', async () => {
    const later = (await fixture('checkmate.pgn')).replace('12:10:00', '12:40:00');
    const earlier = (await fixture('resignation.pgn')).replace('12:06:00', '12:05:00');
    const batch = parsePgnBatch([later, earlier]);
    assert.equal(batch.ok, false);
    if (batch.ok) return;
    assert.equal(batch.reason, 'order');
    if (batch.reason !== 'order') return;
    assert.deepEqual(batch.indices, [0, 1]);
    assert.match(batch.remedy, /oldest first/);
  });

  it('accepts games with no timestamps and does not pretend the order was checked', async () => {
    const batch = parsePgnBatch([
      await fixture('bullet-no-end.pgn'),
      await fixture('aborted.pgn'),
    ]);
    assert.equal(batch.ok, true);
    if (!batch.ok) return;
    assert.equal(batch.order, 'unverified');
  });

  it('rejects a mix of timed and untimed games instead of inventing an order', async () => {
    const batch = parsePgnBatch([
      await fixture('checkmate.pgn'),
      await fixture('bullet-no-end.pgn'),
    ]);
    assert.equal(batch.ok, false);
    if (batch.ok) return;
    assert.equal(batch.reason, 'order');
    if (batch.reason !== 'order') return;
    assert.deepEqual(batch.indices, [1]);
  });
});

describe('parsePgn failures', () => {
  it('does not turn a missing clock into a zero think time', () => {
    const parsed = parsePgn(
      `[White "Ada"]
[Black "Nim"]
[Result "1-0"]
[TimeControl "60"]
[Termination "Ada won by checkmate"]

1. e4 e5 {[%clk 0:00:58]} 2. Nf3 {[%clk 0:00:55]} 1-0
`,
      0,
    );
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.game.moves[0].clockSec, undefined);
    assert.deepEqual(thinkTimeSec(parsed.game), [null, 2, null]);
  });

  it('rejects two games pasted into one entry', () => {
    const parsed = parsePgn(
      `[Event "A"]
[Result "*"]

*

[Event "B"]
[Result "*"]

*
`,
      0,
    );
    assert.equal(parsed.ok, false);
  });

  it('rejects a variation and an unreadable clock', () => {
    const variation = parsePgn('[Result "*"]\n\n1. e4 (1. d4) *\n', 0);
    const clock = parsePgn('[Result "*"]\n\n1. e4 {[%clk noon]} *\n', 0);
    assert.equal(variation.ok, false);
    assert.equal(clock.ok, false);
  });

  it('rejects more than 20 games', () => {
    const one = '[Result "*"]\n\n*\n';
    const batch = parsePgnBatch(Array.from({ length: 21 }, () => one));
    assert.equal(batch.ok, false);
    if (batch.ok) return;
    assert.equal(batch.reason, 'invalid');
  });

  it('rejects an empty batch', () => {
    const batch = parsePgnBatch([]);
    assert.equal(batch.ok, false);
    if (batch.ok) return;
    assert.equal(batch.reason, 'no_games');
  });

  it('keeps a header when a comment contains a tag, and rejects a bad date or a joined move', () => {
    const comment = parsePgn(
      `[White "Ada"]
[Black "Nim"]
[Result "1-0"]
[TimeControl "60"]

1. e4 {[White "Eve"][%clk 0:00:50]} 1-0
`,
      0,
    );
    assert.equal(comment.ok, true);
    if (!comment.ok) return;
    assert.equal(comment.game.white, 'Ada');

    const hijack = parsePgn(
      `[White "Ada"]
[Black "Nim"]
[Result "1-0"]

1. e4
[White "Eve"]
1-0
`,
      0,
    );
    assert.equal(hijack.ok, false);

    const mismatch = parsePgn('[White "Ada"]\n[Black "Nim"]\n[Result "1-0"]\n\n1. e4 0-1\n', 0);
    const missing = parsePgn('[White "Ada"]\n[Black "Nim"]\n[Result "*"]\n\n1. e4\n', 0);
    const aborted = parsePgn('[White "Ada"]\n[Black "Nim"]\n[Result "*"]\n[Termination "Game aborted"]\n\n*\n', 0);
    const leap = parsePgn(
      '[White "Ada"]\n[Black "Nim"]\n[Result "1-0"]\n[EndDate "2024.02.28"]\n[EndTime "12:00:00"]\n\n1. e4 1-0\n',
      0,
    );
    const impossible = parsePgn(
      '[White "Ada"]\n[Black "Nim"]\n[Result "1-0"]\n[EndDate "2024.02.31"]\n[EndTime "12:00:00"]\n\n1. e4 1-0\n',
      0,
    );
    const joined = parsePgn('[White "Ada"]\n[Black "Nim"]\n[Result "1-0"]\n\n1. e4e5 1-0\n', 0);
    const setup = parsePgn(
      '[White "Ada"]\n[Black "Nim"]\n[Result "*"]\n[SetUp "1"]\n[FEN "8/8/8/8/8/8/8/K6k w - - 0 1"]\n\n*\n',
      0,
    );
    assert.equal(mismatch.ok, false);
    assert.equal(missing.ok, false);
    assert.equal(aborted.ok, true);
    assert.equal(leap.ok, true);
    assert.equal(impossible.ok, false);
    assert.equal(joined.ok, false);
    assert.equal(setup.ok, false);
    const unknown = parsePgn(
      '[White "Ada"]\n[Black "Nim"]\n[Result "1-0"]\n[EndDate "????.??.??"]\n[EndTime "??:??:??"]\n\n1. e4 1-0\n',
      0,
    );
    const partial = parsePgn(
      '[White "Ada"]\n[Black "Nim"]\n[Result "1-0"]\n[EndDate "2024.??.01"]\n[EndTime "12:00:00"]\n\n1. e4 1-0\n',
      0,
    );
    assert.equal(unknown.ok, true);
    if (!unknown.ok) return;
    assert.equal(unknown.game.endTimeEpochMs, undefined);
    assert.equal(partial.ok, false);
    const dateOnly = parsePgn(
      '[White "Ada"]\n[Black "Nim"]\n[Result "1-0"]\n[EndDate "2024.02.28"]\n\n1. e4 1-0\n',
      0,
    );
    const timeOnly = parsePgn(
      '[White "Ada"]\n[Black "Nim"]\n[Result "1-0"]\n[EndTime "12:00:00"]\n\n1. e4 1-0\n',
      0,
    );
    assert.equal(dateOnly.ok, true);
    if (!dateOnly.ok) return;
    assert.equal(dateOnly.game.endTimeEpochMs, undefined);
    assert.equal(timeOnly.ok, false);
  });

  it('classifies a resignation even when the winner name contains abort', () => {
    const resigned = parsePgn(
      '[White "AbortMission"]\n[Black "Nim"]\n[Result "1-0"]\n[Termination "AbortMission won by resignation"]\n\n1. e4 1-0\n',
      0,
    );
    const aborted = parsePgn(
      '[White "Ada"]\n[Black "Nim"]\n[Result "*"]\n[Termination "Game aborted"]\n\n*\n',
      0,
    );
    assert.equal(resigned.ok, true);
    if (!resigned.ok) return;
    assert.equal(resigned.game.ending, 'resignation');
    assert.equal(aborted.ok, true);
    if (!aborted.ok) return;
    assert.equal(aborted.game.ending, 'aborted');
  });
});
