// What: places each game on the session clock from the player's own marks, and reports the gaps.
// Why: R6-06 makes the marks the only game boundary; chess.com exports carry no EndTime, and a
//      pasted order is not a time.
// Removed: games would be placed from header times or packed in paste order, which the player
//      never confirmed and the PGNs cannot support.
import {
  alignedGameSchema,
  type AlignedGame,
  type PgnGame,
  type PulseSample,
  type SessionAnchor,
  type SessionMark,
} from '../../shared/contracts.js';
import { CONFIDENCE_FLOOR, SAMPLE_HOLD_US } from '../../shared/sensing.js';
import { thinkTimeSec } from './pgn.js';

/** A mark is a button press, so the placement is exact to the mark rather than to a header time. */
export const MARKS_TOLERANCE_SEC = 0;

export const NO_MARKS_BANNER = 'No game-end marks: games are not placed on the timeline.';

export interface SessionClock {
  startAnchor: SessionAnchor;
  stopAnchor?: SessionAnchor;
}

export interface MoveTime {
  gameIndex: number;
  moveIndex: number;
  tUs: number | null;
}

export function moveTimeKey(gameIndex: number, moveIndex: number): string {
  return `${gameIndex}:${moveIndex}`;
}

/** One lookup per report replaces a linear find inside the move loop. */
export function buildMoveTimeIndex(moveTimes: readonly MoveTime[]): Map<string, MoveTime> {
  return new Map(
    moveTimes.map((entry) => [moveTimeKey(entry.gameIndex, entry.moveIndex), entry]),
  );
}

export interface BetweenGameGap {
  afterIndex: number;
  beforeIndex: number;
  fromUs: number;
  toUs: number;
  durationUs: number;
}

export interface TraceGap {
  gameIndex: number;
  fromUs: number;
  toUs: number;
  durationUs: number;
}

export type AlignResult =
  | {
      ok: true;
      games: AlignedGame[];
      moveTimes: MoveTime[];
      gaps: BetweenGameGap[];
      traceGaps: TraceGap[];
      banner?: string;
    }
  | {
      ok: false;
      reason: 'no_games' | 'no_stop' | 'mismatch' | 'outside';
      banner: string;
      /** The marks the Review may offer when the player has to say which one ended a game. */
      marks: readonly SessionMark[];
    };

/**
 * What: turns the player's marks into one span per game.
 * Why: the marks are the only timestamp the player actually produced, so they are the only placement.
 * Removed: the report would guess boundaries from header times the export does not carry.
 *
 * Rule (phase-06 plan §3.4): game 1 starts at the session start; each later game starts at the
 * first "Next game started" mark after the previous game's end; game i ends at the i-th
 * "Game ended" mark. If the player stopped instead of marking the final game, the last game ends
 * at the session stop. Any other count is a mismatch and the player is asked, never guessed.
 */
export function alignGames(
  games: readonly PgnGame[],
  clock: SessionClock,
  samples: readonly PulseSample[] = [],
  marks: readonly SessionMark[] = [],
): AlignResult {
  if (games.length === 0) {
    return { ok: false, reason: 'no_games', banner: 'No games to align.', marks: [] };
  }
  const ends = marks
    .filter((mark) => mark.kind === 'end')
    .map((mark) => mark.atUs)
    .sort((left, right) => left - right);
  if (ends.length === 0) {
    return { ok: true, games: [], moveTimes: [], gaps: [], traceGaps: [], banner: NO_MARKS_BANNER };
  }
  const stopUs = clock.stopAnchor?.monoUs;
  const finalEnd = ends.length === games.length - 1 ? stopUs : ends[games.length - 1];
  if (finalEnd === undefined || ends.length > games.length || ends.length < games.length - 1) {
    return {
      ok: false,
      reason: 'mismatch',
      banner:
        'The number of game marks does not match the number of pasted games, so the games were not placed.',
      marks,
    };
  }

  const placed: AlignedGame[] = [];
  let previousEnd: number | null = null;
  for (let index = 0; index < games.length; index += 1) {
    const game = games[index];
    if (!game) continue;
    const endUs = index === games.length - 1 ? finalEnd : (ends[index] ?? finalEnd);
    const boundary = index === 0 ? clock.startAnchor.monoUs : (previousEnd ?? clock.startAnchor.monoUs);
    // A subset of games can be pasted, so game 1 may not be the session's first game: its start is
    // the last "Next game started" mark before its end, and only then the session start.
    const startUs = lastNextBefore(marks, boundary, endUs) ?? boundary;
    if (endUs <= startUs) {
      return {
        ok: false,
        reason: 'mismatch',
        banner: `The marks for game ${index + 1} are out of order, so the games were not placed.`,
        marks,
      };
    }
    placed.push({ game, startUs, endUs, alignment: { mode: 'marks', toleranceSec: MARKS_TOLERANCE_SEC } });
    previousEnd = endUs;
  }

  const aligned: AlignedGame[] = [];
  for (const game of placed) {
    const checked = alignedGameSchema.safeParse(game);
    if (!checked.success) {
      return {
        ok: false,
        reason: 'outside',
        banner: 'The aligned game does not match the contract.',
        marks,
      };
    }
    aligned.push(checked.data);
  }

  const outside = rejectOutside(aligned, clock);
  if (outside !== null) return { ok: false, reason: 'outside', banner: outside, marks: [] };

  const moveTimes = aligned.flatMap((game) => moveTimesFor(game));
  const gaps = betweenGameGaps(aligned);
  const traceGaps = aligned.flatMap((game) => traceGapsFor(game, samples));
  return { ok: true, games: aligned, moveTimes, gaps, traceGaps };
}

/**
 * What: the last "Next game started" mark between the previous boundary and this game's end.
 * Why: the latest start before the end is this game's start, even when the pasted games are a
 *      subset of the session and the first pasted game is not the first game played.
 * Removed: a subset would start at the session start, and a stray mark after the game would make
 *      the span backwards instead of falling back to the previous boundary.
 */
function lastNextBefore(
  marks: readonly SessionMark[],
  afterUs: number,
  beforeUs: number,
): number | null {
  let best: number | null = null;
  for (const mark of marks) {
    if (mark.kind !== 'next' || mark.atUs <= afterUs || mark.atUs >= beforeUs) continue;
    if (best === null || mark.atUs > best) best = mark.atUs;
  }
  return best;
}

function rejectOutside(games: readonly AlignedGame[], clock: SessionClock): string | null {
  const recordedStart = clock.startAnchor.monoUs;
  const recordedStop = clock.stopAnchor?.monoUs;
  const outside = games.some((game) => {
    if (game.endUs < game.startUs) return true;
    if (game.startUs < recordedStart || game.endUs < recordedStart) return true;
    if (recordedStop !== undefined && (game.startUs > recordedStop || game.endUs > recordedStop)) return true;
    return false;
  });
  return outside ? 'A game mark falls outside the session clock, so it was not placed.' : null;
}

/**
 * What: lays each move after the previous one by its think time, inside the marked span.
 * Why: a move cannot happen after the game ended, so a clock that adds up past the mark must not
 *      attribute the move to a pulse sample taken after the game.
 * Removed: an inconsistent clock could place moves beyond the game and even beyond the session.
 */
function moveTimesFor(game: AlignedGame): MoveTime[] {
  const thinks = thinkTimeSec(game.game);
  let cursor = game.startUs;
  // A missing clock makes every later cumulative offset unknown: thinking time is a running sum,
  // so resuming it after a gap would date the move earlier than it happened.
  let timed = true;
  return game.game.moves.map((_move, moveIndex) => {
    const think = thinks[moveIndex];
    // A clock that moves forwards would put this move before the last one; that is not a time.
    if (think === null || think === undefined || think < 0 || !timed) {
      timed = false;
      return { gameIndex: game.game.index, moveIndex, tUs: null };
    }
    cursor = Math.min(game.endUs, cursor + Math.round(think * 1_000_000));
    return { gameIndex: game.game.index, moveIndex, tUs: cursor };
  });
}

function betweenGameGaps(games: readonly AlignedGame[]): BetweenGameGap[] {
  const gaps: BetweenGameGap[] = [];
  for (let index = 1; index < games.length; index += 1) {
    const previous = games[index - 1];
    const current = games[index];
    if (!previous || !current || current.startUs <= previous.endUs) continue;
    gaps.push({
      afterIndex: previous.game.index,
      beforeIndex: current.game.index,
      fromUs: previous.endUs,
      toUs: current.startUs,
      durationUs: current.startUs - previous.endUs,
    });
  }
  return gaps;
}

function traceGapsFor(game: AlignedGame, samples: readonly PulseSample[]): TraceGap[] {
  if (game.endUs <= game.startUs) return [];
  const ordered = samples
    .filter((sample) => {
      if (!usable(sample) || sample.tUs > game.endUs) return false;
      if (sample.tUs >= game.startUs) return true;
      return sample.tUs + SAMPLE_HOLD_US > game.startUs;
    })
    .sort((left, right) => left.tUs - right.tUs);
  const gaps: TraceGap[] = [];
  let cursor = game.startUs;
  for (const sample of ordered) {
    if (sample.tUs > cursor) {
      gaps.push({
        gameIndex: game.game.index,
        fromUs: cursor,
        toUs: sample.tUs,
        durationUs: sample.tUs - cursor,
      });
    }
    cursor = Math.max(cursor, Math.min(game.endUs, sample.tUs + SAMPLE_HOLD_US));
  }
  if (game.endUs > cursor) {
    gaps.push({
      gameIndex: game.game.index,
      fromUs: cursor,
      toUs: game.endUs,
      durationUs: game.endUs - cursor,
    });
  }
  return gaps;
}

function usable(sample: PulseSample): boolean {
  // An occluded sample is a hole in the trace, not measured time inside the game.
  return sample.occluded !== true && sample.stable && sample.confidence >= CONFIDENCE_FLOOR;
}
