import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PgnGame, PulseSample } from '../../shared/contracts.js';
import { SAMPLE_HOLD_US } from '../../shared/sensing.js';
import {
  alignGames,
  buildMoveTimeIndex,
  ENDTIME_TOLERANCE_SEC,
  epochMsFromMonoUs,
  monoUsFromEpochMs,
  moveTimeKey,
  STARTTIME_BANNER,
  STARTTIME_TOLERANCE_SEC,
  type MoveTime,
  type SessionClock,
} from './align.js';

const EPOCH = 1_700_000_000_000;
const clock: SessionClock = { startAnchor: { monoUs: 0, epochMs: EPOCH } };

function game(partial: Partial<PgnGame> & Pick<PgnGame, 'index'>): PgnGame {
  return {
    index: partial.index,
    white: 'Ada',
    black: 'Nim',
    result: '1-0',
    timeControl: '60',
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

describe('session clock', () => {
  it('converts one anchor both ways', () => {
    assert.equal(epochMsFromMonoUs(clock, 2_500_000), EPOCH + 2_500);
    assert.equal(monoUsFromEpochMs(clock, EPOCH + 2_500), 2_500_000);
  });

  it('uses both anchors when the clocks disagree', () => {
    const both: SessionClock = {
      startAnchor: { monoUs: 0, epochMs: 1_000_000 },
      stopAnchor: { monoUs: 10_000_000, epochMs: 1_010_500 },
    };
    assert.equal(epochMsFromMonoUs(both, 5_000_000), 1_005_250);
    assert.equal(monoUsFromEpochMs(both, 1_005_250), 5_000_000);
  });
});

describe('alignGames', () => {
  it('places a game from EndTime within the anchor tolerance', () => {
    const aligned = alignGames([game({ index: 0, endTimeEpochMs: EPOCH + 120_000 })], clock);
    assert.equal(aligned.ok, true);
    if (!aligned.ok) return;
    assert.equal(aligned.banner, undefined);
    assert.equal(aligned.games[0]?.alignment.mode, 'endtime');
    assert.equal(aligned.games[0]?.alignment.toleranceSec, ENDTIME_TOLERANCE_SEC);
    assert.equal(aligned.games[0]?.endUs, 120_000_000);
    assert.equal(aligned.games[0]?.startUs, 90_000_000);
    assert.ok(Math.abs(aligned.games[0].startUs - 90_000_000) <= ENDTIME_TOLERANCE_SEC * 1_000_000);
    assert.deepEqual(
      aligned.moveTimes.map((move) => move.tUs),
      [100_000_000, 120_000_000],
    );
  });

  it('names the missing EndTime and the 90 second bound', () => {
    const aligned = alignGames([game({ index: 0, startTimeEpochMs: EPOCH + 60_000 })], clock);
    assert.equal(aligned.ok, true);
    if (!aligned.ok) return;
    assert.equal(aligned.games[0]?.alignment.mode, 'starttime');
    assert.equal(aligned.games[0]?.alignment.toleranceSec, STARTTIME_TOLERANCE_SEC);
    assert.equal(aligned.games[0]?.startUs, 60_000_000);
    assert.equal(aligned.games[0]?.endUs, 90_000_000);
    assert.equal(aligned.banner, STARTTIME_BANNER);
    assert.match(aligned.banner, /EndTime/);
    assert.match(aligned.banner, /90/);
  });

  it('packs a 1+0 game with no timestamps and does not invent a wait', () => {
    const session: SessionClock = {
      startAnchor: clock.startAnchor,
      stopAnchor: { monoUs: 60_000_000, epochMs: EPOCH + 60_000 },
    };
    const short = game({
      index: 0,
      moves: [{ san: 'e4', clockSec: 50 }],
    });
    const next = game({
      index: 1,
      moves: [{ san: 'd4', clockSec: 50 }],
    });
    const aligned = alignGames([short, next], session);
    assert.equal(aligned.ok, true);
    if (!aligned.ok) return;
    assert.equal(aligned.games[0]?.alignment.mode, 'inferred');
    assert.equal(aligned.games[0]?.startUs, 0);
    assert.equal(aligned.games[0]?.endUs, 10_000_000);
    assert.equal(aligned.games[1]?.startUs, 10_000_000);
    assert.equal(aligned.games[0]?.alignment.toleranceSec, 40);
    assert.deepEqual(aligned.gaps, []);
    assert.match(aligned.banner ?? '', /EndTime/);
    assert.match(aligned.banner ?? '', /UTC/);
    assert.match(aligned.banner ?? '', /40 s/);
    assert.deepEqual(alignGames([short, next], session), aligned);
  });

  it('measures a four-minute gap between two EndTime games', () => {
    const first = game({ index: 0, endTimeEpochMs: EPOCH + 100_000, moves: [{ san: 'e4', clockSec: 50 }] });
    const second = game({ index: 1, endTimeEpochMs: EPOCH + 350_000, moves: [{ san: 'd4', clockSec: 50 }] });
    const aligned = alignGames([first, second], clock);
    assert.equal(aligned.ok, true);
    if (!aligned.ok) return;
    assert.equal(aligned.gaps.length, 1);
    assert.equal(aligned.gaps[0]?.durationUs, 240_000_000);
    assert.equal(aligned.gaps[0]?.afterIndex, 0);
    assert.equal(aligned.gaps[0]?.beforeIndex, 1);
  });

  it('leaves a pulse hole as a hole and ignores a weak sample', () => {
    const played = game({ index: 0, endTimeEpochMs: EPOCH + 10_000, moves: [{ san: 'e4', clockSec: 50 }] });
    const samples: PulseSample[] = [
      { tUs: 0, bpm: 70, confidence: 80, stable: true },
      { tUs: 5_000_000, bpm: 70, confidence: 10, stable: true },
      { tUs: 10_000_000, bpm: 72, confidence: 80, stable: true },
    ];
    const aligned = alignGames([played], clock, samples);
    assert.equal(aligned.ok, true);
    if (!aligned.ok) return;
    assert.equal(aligned.traceGaps.length, 1);
    assert.equal(aligned.traceGaps[0]?.fromUs, SAMPLE_HOLD_US);
    assert.equal(aligned.traceGaps[0]?.durationUs, 10_000_000 - SAMPLE_HOLD_US);
  });

  it('lets a usable sample from before the game cover the opening', () => {
    const played = game({ index: 0, endTimeEpochMs: EPOCH + 12_000, moves: [{ san: 'e4', clockSec: 50 }] });
    const samples: PulseSample[] = [
      { tUs: 1_500_000, bpm: 70, confidence: 80, stable: true },
      { tUs: 0, bpm: 70, confidence: 80, stable: true },
      { tUs: 12_000_000, bpm: 72, confidence: 80, stable: true },
    ];
    const aligned = alignGames([played], clock, samples);
    assert.equal(aligned.ok, true);
    if (!aligned.ok) return;
    assert.equal(aligned.traceGaps.length, 1);
    assert.equal(aligned.traceGaps[0]?.fromUs, 1_500_000 + SAMPLE_HOLD_US);
    assert.equal(aligned.traceGaps[0]?.toUs, 12_000_000);
  });

  it('does not place a clockless game or a session with no stop', () => {
    const clockless = game({ index: 3, moves: [{ san: 'e4' }] });
    const missingClocks = alignGames([clockless], clock);
    assert.equal(missingClocks.ok, false);
    if (missingClocks.ok) return;
    assert.match(missingClocks.banner, /Game 4/);
    const noStop = alignGames([game({ index: 0, moves: [{ san: 'e4', clockSec: 50 }] })], clock);
    assert.equal(noStop.ok, false);
    if (noStop.ok) return;
    assert.match(noStop.banner, /stop time/);
  });

  it('places a finished game when an abandoned game has no clocks', () => {
    const abandoned = game({
      index: 0,
      includeInStats: false,
      ending: 'abandoned',
      moves: [{ san: 'e4' }],
      endTimeEpochMs: EPOCH + 30_000,
    });
    const played = game({ index: 1, endTimeEpochMs: EPOCH + 120_000 });
    const aligned = alignGames([abandoned, played], clock);
    assert.equal(aligned.ok, true);
    if (!aligned.ok) return;
    assert.deepEqual(aligned.games.map((entry) => entry.game.index), [1]);
  });

  it('rejects a negative clock delta and a packed span past the session', () => {
    const backwards = alignGames(
      [game({ index: 0, moves: [{ san: 'e4', clockSec: 70 }], endTimeEpochMs: EPOCH + 10_000 })],
      clock,
    );
    assert.equal(backwards.ok, false);
    if (backwards.ok) return;
    assert.match(backwards.banner, /inconsistent clock/);

    const session: SessionClock = {
      startAnchor: clock.startAnchor,
      stopAnchor: { monoUs: 15_000_000, epochMs: EPOCH + 15_000 },
    };
    const overflow = alignGames(
      [
        game({ index: 0, moves: [{ san: 'e4', clockSec: 50 }] }),
        game({ index: 1, moves: [{ san: 'd4', clockSec: 50 }] }),
      ],
      session,
    );
    assert.equal(overflow.ok, false);
    if (overflow.ok) return;
    assert.match(overflow.banner, /longer than the session/);
  });

  it('rounds leftover session time up to the next second and keeps an exact fit at zero', () => {
    const loose: SessionClock = {
      startAnchor: clock.startAnchor,
      stopAnchor: { monoUs: 10_400_000, epochMs: EPOCH + 10_400 },
    };
    const padded = alignGames([game({ index: 0, moves: [{ san: 'e4', clockSec: 50 }] })], loose);
    assert.equal(padded.ok, true);
    if (!padded.ok) return;
    assert.equal(padded.games[0]?.alignment.toleranceSec, 1);

    const exact: SessionClock = {
      startAnchor: clock.startAnchor,
      stopAnchor: { monoUs: 10_000_000, epochMs: EPOCH + 10_000 },
    };
    const fitted = alignGames([game({ index: 0, moves: [{ san: 'e4', clockSec: 50 }] })], exact);
    assert.equal(fitted.ok, true);
    if (!fitted.ok) return;
    assert.equal(fitted.games[0]?.alignment.toleranceSec, 0);
  });

  it('rejects a span outside the recording and keeps one inside it', () => {
    const late: SessionClock = {
      startAnchor: { monoUs: 5_000_000, epochMs: EPOCH + 5_000 },
      stopAnchor: { monoUs: 20_000_000, epochMs: EPOCH + 20_000 },
    };
    const before = alignGames(
      [game({ index: 0, endTimeEpochMs: EPOCH + 10_000, moves: [{ san: 'e4', clockSec: 50 }] })],
      late,
    );
    assert.equal(before.ok, false);
    if (before.ok) return;
    assert.match(before.banner, /outside the session clock/);

    const open: SessionClock = { startAnchor: { monoUs: 0, epochMs: EPOCH } };
    const contained = alignGames(
      [game({ index: 0, endTimeEpochMs: EPOCH + 10_000, moves: [{ san: 'e4', clockSec: 50 }] })],
      open,
    );
    assert.equal(contained.ok, true);
  });

  it('places a timeout flag after the last move by the unused clock', () => {
    const flagged = alignGames(
      [
        game({
          index: 0,
          ending: 'timeout',
          endTimeEpochMs: EPOCH + 70_000,
          moves: [{ san: 'e4', clockSec: 50 }],
        }),
      ],
      clock,
    );
    assert.equal(flagged.ok, true);
    if (!flagged.ok) return;
    assert.equal(flagged.games[0]?.endUs, 70_000_000);
    assert.equal(flagged.games[0]?.startUs, 0);
    assert.equal(flagged.moveTimes[0]?.tUs, 10_000_000);
    assert.equal(flagged.games[0]?.alignment.toleranceSec, ENDTIME_TOLERANCE_SEC);

    const unknown = alignGames(
      [game({ index: 0, ending: 'timeout', moves: [], endTimeEpochMs: EPOCH + 10_000, timeControl: undefined })],
      clock,
    );
    assert.equal(unknown.ok, true);
    if (!unknown.ok) return;
    assert.equal(unknown.games[0]?.alignment.toleranceSec, STARTTIME_TOLERANCE_SEC);
    assert.equal(unknown.moveTimes.length, 0);
  });
});

describe('move time index', () => {
  it('matches a linear find for every aligned move and misses unknown keys', () => {
    const aligned = alignGames([game({ index: 0, endTimeEpochMs: EPOCH + 120_000 })], clock);
    assert.equal(aligned.ok, true);
    if (!aligned.ok) return;
    const index = buildMoveTimeIndex(aligned.moveTimes);
    for (const move of aligned.moveTimes) {
      const linear: MoveTime | undefined = aligned.moveTimes.find(
        (entry) => entry.gameIndex === move.gameIndex && entry.moveIndex === move.moveIndex,
      );
      const keyed = index.get(moveTimeKey(move.gameIndex, move.moveIndex));
      assert.deepEqual(keyed, linear);
      assert.deepEqual(keyed, move);
    }
    assert.equal(index.get(moveTimeKey(99, 99)), undefined);
  });
});
