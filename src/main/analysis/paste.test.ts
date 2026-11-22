import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { CLOCKLESS_MESSAGE, validatePasteBatch } from './paste.js';

const fixtureDir = path.join(process.cwd(), 'tests/fixtures/pgn');

async function fixture(name: string): Promise<string> {
  return readFile(path.join(fixtureDir, name), 'utf8');
}

function stripClocks(pgn: string): string {
  return pgn.replace(/\s*\{\[%clk [^\]]+\]\}/g, '');
}

function undated(pgn: string): string {
  return pgn.replace(/\[(EndDate|EndTime|UTCDate|UTCTime)\s+"[^"]*"\]\r?\n/g, '');
}

function illegalGame(): string {
  const shuffles = Array.from({ length: 11 }, () => 'Nf3 Nf6 Ng1 Ng8').join(' ');
  return `[Event "Live Chess"]
[White "Ada"]
[Black "Nim"]
[Result "1-0"]

1. ${shuffles} 23. e5 1-0
`;
}

describe('validatePasteBatch', () => {
  it('returns the empty state when all slots are blank', () => {
    const result = validatePasteBatch(['', '   ', '\n']);
    assert.equal(result.state, 'empty');
    assert.equal(result.canBuild, false);
    assert.equal(result.order, 'none');
    assert.equal(result.summary.total, 0);
    assert.deepEqual(
      result.slots.map((slot) => slot.status),
      ['empty', 'empty', 'empty'],
    );
  });

  it('returns partial when 1–2 slots are valid and another slot is still empty', async () => {
    const game1 = await fixture('resignation.pgn');
    const game2 = await fixture('checkmate.pgn');
    const result = validatePasteBatch([game1, game2, '']);
    assert.equal(result.state, 'partial');
    assert.equal(result.order, 'checked');
    assert.equal(result.clockless, false);
    assert.equal(result.canBuild, true);
    assert.equal(result.summary.total, 2);
    assert.equal(result.summary.includedInStats, 2);
    assert.equal(result.slots[0]?.status, 'valid');
    assert.equal(result.slots[1]?.status, 'valid');
    assert.equal(result.slots[2]?.status, 'empty');
  });

  it('flags out-of-order games per slot using screen slot numbers and blocks building', async () => {
    const later = (await fixture('checkmate.pgn')).replace('12:10:00', '12:40:00');
    const earlier = (await fixture('resignation.pgn')).replace('12:06:00', '12:05:00');
    const result = validatePasteBatch([later, '', earlier]);
    assert.equal(result.state, 'out_of_order');
    assert.equal(result.order, 'invalid');
    assert.equal(result.canBuild, false);
    assert.match(result.message, /Game 3 ends before Game 1/);
    assert.match(result.message, /oldest first/);
    assert.equal(result.slots[0]?.status, 'order_error');
    assert.equal(result.slots[1]?.status, 'empty');
    assert.equal(result.slots[2]?.status, 'order_error');
    if (result.slots[2]?.status === 'order_error') {
      assert.match(result.slots[2].message, /Game 3 ends before Game 1/);
    }
  });

  it('rejects mixed timed and untimed games and marks the untimed slot', async () => {
    const timed = await fixture('checkmate.pgn');
    const untimed = await fixture('bullet-no-end.pgn');
    const result = validatePasteBatch([timed, untimed]);
    assert.equal(result.state, 'out_of_order');
    assert.equal(result.canBuild, false);
    assert.equal(result.slots[0]?.status, 'valid');
    assert.equal(result.slots[1]?.status, 'order_error');
    assert.match(result.message, /Game 2 is missing EndTime/);
  });

  it('marks clockless games honestly and blocks building without move clocks', async () => {
    const clocklessGame = stripClocks(await fixture('checkmate.pgn'));
    const result = validatePasteBatch([clocklessGame]);
    assert.equal(result.state, 'clockless');
    assert.equal(result.clockless, true);
    assert.equal(result.message, CLOCKLESS_MESSAGE);
    assert.match(result.message, /accuracy by band are unavailable/);
    assert.equal(result.canBuild, false);
    assert.equal(result.slots[0]?.status, 'valid');
    if (result.slots[0]?.status === 'valid') {
      assert.equal(result.slots[0].game.hasClocks, false);
    }
  });

  it('returns all valid when every slot parses cleanly and excludes aborted games from stats', async () => {
    const game1 = undated(await fixture('resignation.pgn'));
    const game2 = await fixture('aborted.pgn');
    const game3 = undated(await fixture('checkmate.pgn'));
    const result = validatePasteBatch([game1, game2, game3]);
    assert.equal(result.state, 'valid');
    assert.equal(result.order, 'unverified');
    assert.equal(result.clockless, false);
    assert.equal(result.canBuild, true);
    assert.deepEqual(result.summary, {
      total: 3,
      includedInStats: 2,
      aborted: 1,
      abandoned: 0,
    });
    assert.equal(result.slots[1]?.status, 'valid');
    if (result.slots[1]?.status === 'valid') {
      assert.equal(result.slots[1].game.includeInStats, false);
      assert.equal(result.slots[1].game.ending, 'aborted');
    }
  });

  it('blocks building when only aborted or abandoned games are pasted', async () => {
    const result = validatePasteBatch([await fixture('aborted.pgn')]);
    assert.equal(result.state, 'valid');
    assert.equal(result.canBuild, false);
    assert.match(result.message, /Add a finished game/);
  });

  it('finds an illegal move at paste time and names the game and move', async () => {
    const result = validatePasteBatch([await fixture('checkmate.pgn'), illegalGame()]);
    assert.equal(result.state, 'invalid');
    assert.equal(result.canBuild, false);
    assert.equal(result.summary.total, 1);
    assert.equal(result.slots[0]?.status, 'valid');
    assert.equal(result.slots[1]?.status, 'invalid');
    if (result.slots[1]?.status === 'invalid') {
      assert.equal(
        result.slots[1].message,
        'Game 2, move 23 (e5) is not legal from this position. Check that the PGN came from chess.com.',
      );
    }
  });

  it('keeps valid ticks on good slots while naming the broken slot', async () => {
    const good = await fixture('checkmate.pgn');
    const broken = '[White "Ada"]\n[Black "Nim"]\n[Result "1-0"]\n\n1. e4 (1. d4) 1-0\n';
    const result = validatePasteBatch([good, broken, '']);
    assert.equal(result.state, 'invalid');
    assert.equal(result.canBuild, false);
    assert.equal(result.message, 'Fix Game 2 before continuing.');
    assert.equal(result.slots[0]?.status, 'valid');
    assert.equal(result.slots[1]?.status, 'invalid');
    if (result.slots[1]?.status === 'invalid') {
      assert.match(result.slots[1].message, /Variations/);
    }
    assert.equal(result.slots[2]?.status, 'empty');
  });

  it('rejects more than 20 filled games cleanly', () => {
    const one = '[Result "*"]\n\n*\n';
    const result = validatePasteBatch(Array.from({ length: 21 }, () => one));
    assert.equal(result.state, 'invalid');
    assert.equal(result.canBuild, false);
    assert.match(result.message, /at most 20 games/);
  });
});
