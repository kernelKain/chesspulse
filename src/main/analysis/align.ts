// What: places each game on the session clock and names how far that placement can be wrong.
// Why: the pulse and the moves were recorded on different clocks, and a missing EndTime must stay visible.
// Removed: games without a timestamp would be drawn as if their times were known.
import {
  alignedGameSchema,
  type AlignedGame,
  type PgnGame,
  type PulseSample,
  type SessionAnchor,
} from '../../shared/contracts.js';
import { CONFIDENCE_FLOOR, SAMPLE_HOLD_US } from '../../shared/sensing.js';
import { thinkTimeSec } from './pgn.js';

/** P5: one anchor stays within 1 s. That is the EndTime tolerance. */
export const ENDTIME_TOLERANCE_SEC = 1;
/** The blueprint's stated drift when a game is placed from its UTC start only. */
export const STARTTIME_TOLERANCE_SEC = 90;
export const STARTTIME_BANNER =
  'No `EndTime` in these PGNs. Games were placed from start times only — expect ±90 s of drift.';

export interface SessionClock {
  startAnchor: SessionAnchor;
  stopAnchor?: SessionAnchor;
}

export interface MoveTime {
  gameIndex: number;
  moveIndex: number;
  tUs: number | null;
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
  | { ok: false; banner: string };

export function monoUsFromEpochMs(clock: SessionClock, epochMs: number): number {
  const start = clock.startAnchor;
  const stop = clock.stopAnchor;
  const deltaMs = epochMs - start.epochMs;
  if (!stop || stop.epochMs === start.epochMs || stop.monoUs === start.monoUs) {
    return Math.round(start.monoUs + deltaMs * 1000);
  }
  const fraction = deltaMs / (stop.epochMs - start.epochMs);
  return Math.round(start.monoUs + fraction * (stop.monoUs - start.monoUs));
}

export function epochMsFromMonoUs(clock: SessionClock, monoUs: number): number {
  const start = clock.startAnchor;
  const stop = clock.stopAnchor;
  const deltaUs = monoUs - start.monoUs;
  if (!stop || stop.epochMs === start.epochMs || stop.monoUs === start.monoUs) {
    return Math.round(start.epochMs + deltaUs / 1000);
  }
  const fraction = deltaUs / (stop.monoUs - start.monoUs);
  return Math.round(start.epochMs + fraction * (stop.epochMs - start.epochMs));
}

export function alignGames(
  games: readonly PgnGame[],
  clock: SessionClock,
  samples: readonly PulseSample[] = [],
): AlignResult {
  if (games.length === 0) return { ok: false, banner: 'No games to align.' };

  const mode = placementMode(games);
  if (mode === 'mixed') {
    return {
      ok: false,
      banner: 'Some games have a timestamp and others do not, so they were not placed on one clock.',
    };
  }
  const durations = games.map(durationUs);
  const missing = durations.findIndex((duration) => duration === null);
  if (missing >= 0) {
    const label = (games[missing]?.index ?? missing) + 1;
    return {
      ok: false,
      banner: `Game ${label} has no move clocks, so its length is unknown and it was not placed.`,
    };
  }
  if (mode === 'inferred' && !clock.stopAnchor) {
    return {
      ok: false,
      banner:
        'No EndTime or UTC start in these PGNs, and the session has no stop time, so the games were not placed on the trace.',
    };
  }
  const known = durations as number[];

  const placed = place(games, known, clock, mode);
  if (!placed.ok) return placed;

  const aligned: AlignedGame[] = [];
  for (const game of placed.games) {
    const checked = alignedGameSchema.safeParse(game);
    if (!checked.success) return { ok: false, banner: 'The aligned game does not match the contract.' };
    aligned.push(checked.data);
  }

  const moveTimes = aligned.flatMap((game) => moveTimesFor(game));
  const gaps = mode === 'inferred' ? [] : betweenGameGaps(aligned);
  const traceGaps = aligned.flatMap((game) => traceGapsFor(game, samples));
  return placed.banner
    ? { ok: true, games: aligned, moveTimes, gaps, traceGaps, banner: placed.banner }
    : { ok: true, games: aligned, moveTimes, gaps, traceGaps };
}

function placementMode(games: readonly PgnGame[]): 'endtime' | 'starttime' | 'inferred' | 'mixed' {
  const allEnd = games.every((game) => game.endTimeEpochMs !== undefined);
  const anyEnd = games.some((game) => game.endTimeEpochMs !== undefined);
  const allStart = games.every((game) => game.startTimeEpochMs !== undefined);
  const anyStart = games.some((game) => game.startTimeEpochMs !== undefined);
  if (allEnd) return 'endtime';
  if (!anyEnd && allStart) return 'starttime';
  if (!anyEnd && !anyStart) return 'inferred';
  return 'mixed';
}

function durationUs(game: PgnGame): number | null {
  if (game.moves.length === 0) return 0;
  const thinks = thinkTimeSec(game);
  let seconds = 0;
  for (const think of thinks) {
    if (think === null) return null;
    seconds += think;
  }
  return Math.round(seconds * 1_000_000);
}

function place(
  games: readonly PgnGame[],
  durations: readonly number[],
  clock: SessionClock,
  mode: 'endtime' | 'starttime' | 'inferred',
): { ok: true; games: AlignedGame[]; banner?: string } | { ok: false; banner: string } {
  if (mode === 'endtime') {
    return stamp(games, durations, (game, duration) => {
      const endUs = monoUsFromEpochMs(clock, game.endTimeEpochMs ?? 0);
      return { startUs: endUs - duration, endUs, toleranceSec: ENDTIME_TOLERANCE_SEC };
    }, 'endtime');
  }
  if (mode === 'starttime') {
    const stamped = stamp(games, durations, (game, duration) => {
      const startUs = monoUsFromEpochMs(clock, game.startTimeEpochMs ?? 0);
      return { startUs, endUs: startUs + duration, toleranceSec: STARTTIME_TOLERANCE_SEC };
    }, 'starttime');
    if (!stamped.ok) return stamped;
    return { ok: true, games: stamped.games, banner: STARTTIME_BANNER };
  }

  const stopUs = clock.stopAnchor?.monoUs ?? clock.startAnchor.monoUs;
  let cursor = clock.startAnchor.monoUs;
  const inferred = games.map((game, index) => {
    const duration = durations[index] ?? 0;
    const startUs = cursor;
    const endUs = cursor + duration;
    cursor = endUs;
    return aligned(game, startUs, endUs, 'inferred', 0);
  });
  const slackSec = Math.max(0, Math.round((stopUs - cursor) / 1_000_000));
  const withTolerance = inferred.map((game) => ({
    ...game,
    alignment: { mode: 'inferred' as const, toleranceSec: slackSec },
  }));
  const checked = rejectOutside(withTolerance);
  if (!checked.ok) return checked;
  return {
    ok: true,
    games: checked.games,
    banner: `No EndTime or UTC start in these PGNs. Games were packed in paste order from the session start. Placement can be off by ${slackSec} s.`,
  };
}

function stamp(
  games: readonly PgnGame[],
  durations: readonly number[],
  at: (game: PgnGame, duration: number) => { startUs: number; endUs: number; toleranceSec: number },
  mode: 'endtime' | 'starttime',
): { ok: true; games: AlignedGame[] } | { ok: false; banner: string } {
  const placed = games.map((game, index) => {
    const span = at(game, durations[index] ?? 0);
    return aligned(game, span.startUs, span.endUs, mode, span.toleranceSec);
  });
  return rejectOutside(placed);
}

function aligned(
  game: PgnGame,
  startUs: number,
  endUs: number,
  mode: AlignedGame['alignment']['mode'],
  toleranceSec: number,
): AlignedGame {
  return { game, startUs, endUs, alignment: { mode, toleranceSec } };
}

function rejectOutside(
  games: readonly AlignedGame[],
): { ok: true; games: AlignedGame[] } | { ok: false; banner: string } {
  const outside = games.some((game) => game.startUs < 0 || game.endUs < game.startUs);
  if (outside) {
    return { ok: false, banner: 'A game time falls outside the session clock, so it was not placed.' };
  }
  return { ok: true, games: [...games] };
}

function moveTimesFor(game: AlignedGame): MoveTime[] {
  const thinks = thinkTimeSec(game.game);
  let cursor = game.startUs;
  return game.game.moves.map((_move, moveIndex) => {
    const think = thinks[moveIndex];
    if (think === null || think === undefined) return { gameIndex: game.game.index, moveIndex, tUs: null };
    cursor += Math.round(think * 1_000_000);
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
    .filter((sample) => sample.tUs >= game.startUs && sample.tUs <= game.endUs && usable(sample))
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
  return sample.stable && sample.confidence >= CONFIDENCE_FLOOR;
}
