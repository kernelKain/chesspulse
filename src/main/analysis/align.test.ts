import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PgnGame, PulseSample, SessionMark } from '../../shared/contracts.js';
import { SAMPLE_HOLD_US } from '../../shared/sensing.js';
import {
  alignGames,
  buildMoveTimeIndex,
  MARKS_TOLERANCE_SEC,
  moveTimeKey,
  NO_MARKS_BANNER,
  type MoveTime,
  type SessionClock,
} from './align.js';

const EPOCH = 1_700_000_000_000;
const SEC = 1_000_000;
const clock: SessionClock = { startAnchor: { monoUs: 0, epochMs: EPOCH } };

function game(partial: Partial<PgnGame> & Pick<PgnGame, 'index'>): PgnGame {
  return {
    index: partial.index,
    white: 'Ada',
    black: 'Nim',
    result: '1-0',
    timeControl: partial.timeControl ?? '60',
    moves: partial.moves ?? [
      { san: 'e4', clockSec: 50 },
      { san: 'e5', clockSec: 40 },
    ],
    ending: partial.ending ?? 'checkmate',
    includeInStats: partial.includeInStats ?? true,
    endTimeEpochMs: partial.endTimeEpochMs,
    startTimeEpochMs: partial.startTimeEpochMs,
  };
}

/** Marks in the order a player makes them: end of each game, next game after all but the last. */
function marksFor(ends: readonly number[], starts: readonly number[]): SessionMark[] {
  const marks: SessionMark[] = [];
  ends.forEach((atUs, index) => {
    marks.push({ atUs, kind: 'end' });
    const start = starts[index];
    if (start !== undefined) marks.push({ atUs: start, kind: 'next' });
  });
  return marks;
}

function withStop(stopUs: number): SessionClock {
  return { startAnchor: { monoUs: 0, epochMs: EPOCH }, stopAnchor: { monoUs: stopUs, epochMs: EPOCH + stopUs / 1000 } };
}

describe('alignGames from player marks', () => {
  it('places one game between the session start and its game-end mark', () => {
    const aligned = alignGames([game({ index: 0 })], withStop(120 * SEC), [], marksFor([60 * SEC], []));
    assert.equal(aligned.ok, true);
    if (!aligned.ok) return;
    assert.equal(aligned.games.length, 1);
    assert.equal(aligned.games[0]?.startUs, 0);
    assert.equal(aligned.games[0]?.endUs, 60 * SEC);
    assert.equal(aligned.games[0]?.alignment.mode, 'marks');
    assert.equal(aligned.games[0]?.alignment.toleranceSec, MARKS_TOLERANCE_SEC);
    assert.equal(aligned.banner, undefined);
  });

  it('ignores PGN header times even when the export carries them', () => {
    const aligned = alignGames(
      [game({ index: 0, endTimeEpochMs: EPOCH + 900_000, startTimeEpochMs: EPOCH + 100_000 })],
      withStop(120 * SEC),
      [],
      marksFor([45 * SEC], []),
    );
    assert.equal(aligned.ok, true);
    if (!aligned.ok) return;
    assert.equal(aligned.games[0]?.startUs, 0);
    assert.equal(aligned.games[0]?.endUs, 45 * SEC);
  });

  it('places two games and measures the gap the player took between them', () => {
    const marks = marksFor([60 * SEC, 200 * SEC], [120 * SEC]);
    const aligned = alignGames([game({ index: 0 }), game({ index: 1 })], withStop(260 * SEC), [], marks);
    assert.equal(aligned.ok, true);
    if (!aligned.ok) return;
    assert.deepEqual(
      aligned.games.map((entry) => [entry.startUs, entry.endUs]),
      [
        [0, 60 * SEC],
        [120 * SEC, 200 * SEC],
      ],
    );
    assert.equal(aligned.gaps.length, 1);
    assert.equal(aligned.gaps[0]?.durationUs, 60 * SEC);
    assert.equal(aligned.gaps[0]?.afterIndex, 0);
  });

  it('starts the next game at the end mark when the player never pressed "Next game started"', () => {
    const aligned = alignGames(
      [game({ index: 0 }), game({ index: 1 })],
      withStop(200 * SEC),
      [],
      marksFor([60 * SEC, 150 * SEC], []),
    );
    assert.equal(aligned.ok, true);
    if (!aligned.ok) return;
    assert.equal(aligned.games[1]?.startUs, 60 * SEC);
    assert.equal(aligned.games[1]?.endUs, 150 * SEC);
    assert.equal(aligned.gaps.length, 0);
  });

  it('ends the last game at the session stop when the player stopped without a final mark', () => {
    const aligned = alignGames(
      [game({ index: 0 }), game({ index: 1 })],
      withStop(300 * SEC),
      [],
      marksFor([60 * SEC], [120 * SEC]),
    );
    assert.equal(aligned.ok, true);
    if (!aligned.ok) return;
    assert.equal(aligned.games[1]?.startUs, 120 * SEC);
    assert.equal(aligned.games[1]?.endUs, 300 * SEC);
  });

  it('places three games from three marks and two starts', () => {
    const marks = marksFor([100 * SEC, 220 * SEC, 340 * SEC], [130 * SEC, 250 * SEC]);
    const games = [0, 1, 2].map((index) => game({ index }));
    const aligned = alignGames(games, withStop(400 * SEC), [], marks);
    assert.equal(aligned.ok, true);
    if (!aligned.ok) return;
    assert.deepEqual(
      aligned.games.map((entry) => [entry.startUs, entry.endUs]),
      [
        [0, 100 * SEC],
        [130 * SEC, 220 * SEC],
        [250 * SEC, 340 * SEC],
      ],
    );
    assert.equal(aligned.gaps.length, 2);
  });

  it('places a ten-game blitz session from ten marks', () => {
    const ends = Array.from({ length: 10 }, (_item, index) => (index + 1) * 60 * SEC);
    const starts = Array.from({ length: 9 }, (_item, index) => (index + 1) * 60 * SEC + 10 * SEC);
    const games = Array.from({ length: 10 }, (_item, index) => game({ index }));
    const aligned = alignGames(games, withStop(620 * SEC), [], marksFor(ends, starts));
    assert.equal(aligned.ok, true);
    if (!aligned.ok) return;
    assert.equal(aligned.games.length, 10);
    assert.equal(aligned.games[9]?.startUs, 550 * SEC);
    assert.equal(aligned.games[9]?.endUs, 600 * SEC);
    assert.equal(aligned.gaps.length, 9);
  });

  it('falls back to the previous end when the only next mark came after the game ended', () => {
    // end, end, next, end: the next mark belongs after game 2 started, not before it.
    const marks: SessionMark[] = [
      { atUs: 60 * SEC, kind: 'end' },
      { atUs: 120 * SEC, kind: 'end' },
      { atUs: 130 * SEC, kind: 'next' },
      { atUs: 180 * SEC, kind: 'end' },
    ];
    const aligned = alignGames(
      [game({ index: 0 }), game({ index: 1 }), game({ index: 2 })],
      withStop(240 * SEC),
      [],
      marks,
    );
    assert.equal(aligned.ok, true);
    if (!aligned.ok) return;
    assert.deepEqual(
      aligned.games.map((entry) => [entry.startUs, entry.endUs]),
      [
        [0, 60 * SEC],
        [60 * SEC, 120 * SEC],
        [130 * SEC, 180 * SEC],
      ],
    );
  });

  it('keeps every move time inside the marked span', () => {
    const aligned = alignGames(
      [
        game({
          index: 0,
          moves: [
            { san: 'e4', clockSec: 50 },
            { san: 'e5', clockSec: 40 },
            { san: 'Nf3', clockSec: 30 },
          ],
        }),
      ],
      withStop(60 * SEC),
      [],
      marksFor([10 * SEC], []),
    );
    assert.equal(aligned.ok, true);
    if (!aligned.ok) return;
    for (const move of aligned.moveTimes) {
      assert.ok((move.tUs ?? 0) <= 10 * SEC, `move ${move.moveIndex} landed at ${move.tUs}`);
    }
    assert.equal(aligned.moveTimes[2]?.tUs, 10 * SEC);
  });

  it('starts a pasted subset at its own mark instead of the session start', () => {
    // Four games were played; the player pasted the last two and answered 150 s and 240 s.
    const marks: SessionMark[] = [
      { atUs: 90 * SEC, kind: 'next' },
      { atUs: 150 * SEC, kind: 'end' },
      { atUs: 180 * SEC, kind: 'next' },
      { atUs: 240 * SEC, kind: 'end' },
    ];
    const aligned = alignGames(
      [game({ index: 2 }), game({ index: 3 })],
      withStop(300 * SEC),
      [],
      marks,
    );
    assert.equal(aligned.ok, true);
    if (!aligned.ok) return;
    assert.deepEqual(
      aligned.games.map((entry) => [entry.startUs, entry.endUs]),
      [
        [90 * SEC, 150 * SEC],
        [180 * SEC, 240 * SEC],
      ],
    );
  });

  it('asks for the marks when there are more game ends than games', () => {
    const marks = marksFor([60 * SEC, 120 * SEC, 180 * SEC], []);
    const aligned = alignGames([game({ index: 0 }), game({ index: 1 })], withStop(300 * SEC), [], marks);
    assert.equal(aligned.ok, false);
    if (aligned.ok) return;
    assert.equal(aligned.reason, 'mismatch');
    assert.equal(aligned.marks.length, 3);
  });

  it('asks for the marks when a game has no end and the session has no stop', () => {
    const aligned = alignGames([game({ index: 0 }), game({ index: 1 })], clock, [], marksFor([60 * SEC], []));
    assert.equal(aligned.ok, false);
    if (aligned.ok) return;
    assert.equal(aligned.reason, 'mismatch');
  });

  it('shows one block and no games when the player made no marks', () => {
    const aligned = alignGames([game({ index: 0 })], withStop(120 * SEC), [], []);
    assert.equal(aligned.ok, true);
    if (!aligned.ok) return;
    assert.deepEqual(aligned.games, []);
    assert.deepEqual(aligned.moveTimes, []);
    assert.equal(aligned.banner, NO_MARKS_BANNER);
  });

  it('refuses a mark outside the session clock instead of clamping it', () => {
    const aligned = alignGames([game({ index: 0 })], withStop(60 * SEC), [], marksFor([90 * SEC], []));
    assert.equal(aligned.ok, false);
    if (aligned.ok) return;
    assert.equal(aligned.reason, 'outside');
  });

  it('lays move times out from the marked start, and leaves clockless moves without a time', () => {
    const aligned = alignGames(
      [
        game({
          index: 0,
          moves: [
            { san: 'e4', clockSec: 50 },
            { san: 'e5', clockSec: 40 },
            { san: 'Nf3' },
          ],
        }),
      ],
      withStop(120 * SEC),
      [],
      marksFor([60 * SEC], []),
    );
    assert.equal(aligned.ok, true);
    if (!aligned.ok) return;
    assert.equal(aligned.moveTimes[0]?.tUs, 10 * SEC);
    assert.equal(aligned.moveTimes[1]?.tUs, 30 * SEC);
    assert.equal(aligned.moveTimes[2]?.tUs, null);
  });

  it('leaves every move after a missing clock without a time', () => {
    const aligned = alignGames(
      [
        game({
          index: 0,
          moves: [
            { san: 'e4', clockSec: 50 },
            { san: 'e5', clockSec: 40 },
            { san: 'Nf3' },
            { san: 'Nc6', clockSec: 20 },
          ],
        }),
      ],
      withStop(120 * SEC),
      [],
      marksFor([60 * SEC], []),
    );
    assert.equal(aligned.ok, true);
    if (!aligned.ok) return;
    assert.equal(aligned.moveTimes[1]?.tUs, 30 * SEC);
    assert.equal(aligned.moveTimes[2]?.tUs, null);
    // Black still had clocks, but the running total stopped being known at move 3.
    assert.equal(aligned.moveTimes[3]?.tUs, null);
  });

  it('reports a trace gap when no usable sample covers part of a game', () => {
    const samples: PulseSample[] = [
      { tUs: 1 * SEC, bpm: 80, confidence: 95, stable: true },
      { tUs: 50 * SEC, bpm: 82, confidence: 95, stable: true },
    ];
    const aligned = alignGames([game({ index: 0 })], withStop(120 * SEC), samples, marksFor([60 * SEC], []));
    assert.equal(aligned.ok, true);
    if (!aligned.ok) return;
    const gap = aligned.traceGaps.find((entry) => entry.fromUs === 1 * SEC + SAMPLE_HOLD_US);
    assert.ok(gap, 'the uncovered stretch was not reported');
    assert.equal(gap?.toUs, 50 * SEC);
  });
});

describe('move time index', () => {
  it('builds one lookup keyed by game and move', () => {
    const moveTimes: MoveTime[] = [
      { gameIndex: 0, moveIndex: 0, tUs: 1 },
      { gameIndex: 1, moveIndex: 0, tUs: 2 },
    ];
    const index = buildMoveTimeIndex(moveTimes);
    assert.equal(index.get(moveTimeKey(1, 0))?.tUs, 2);
    assert.equal(index.get(moveTimeKey(2, 0)), undefined);
  });
});
