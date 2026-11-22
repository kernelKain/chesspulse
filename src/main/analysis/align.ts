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
  const ready: { game: PgnGame; duration: number }[] = [];
  for (const game of games) {
    const duration = durationUs(game);
    if (typeof duration === 'number') {
      ready.push({ game, duration });
      continue;
    }
    if (!game.includeInStats) continue;
    const label = game.index + 1;
    const banner =
      duration === 'negative'
        ? `Game ${label} has an inconsistent clock, so it was not placed.`
        : `Game ${label} has no move clocks, so its length is unknown and it was not placed.`;
    return { ok: false, banner };
  }
  if (ready.length === 0) {
    return { ok: false, banner: 'No game had clocks that could be placed.' };
  }
  if (mode === 'inferred' && !clock.stopAnchor) {
    return {
      ok: false,
      banner:
        'No EndTime or UTC start in these PGNs, and the session has no stop time, so the games were not placed on the trace.',
    };
  }

  const placed = place(
    ready.map((entry) => entry.game),
    ready.map((entry) => entry.duration),
    clock,
    mode,
  );
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

function unplayedTimeoutUs(game: PgnGame): number | null {
  if (game.ending !== 'timeout') return 0;
  if (game.moves.length === 0) return null;
  const flaggerStarts = game.moves.length % 2 === 1 ? 1 : 0;
  let clockSec: number | undefined;
  for (let index = flaggerStarts; index < game.moves.length; index += 2) {
    const clock = game.moves[index]?.clockSec;
    if (clock !== undefined) clockSec = clock;
  }
  if (clockSec === undefined) clockSec = baseSec(game.timeControl) ?? undefined;
  if (clockSec === undefined) return null;
  return Math.round(clockSec * 1_000_000);
}

function baseSec(timeControl: string | undefined): number | null {
  if (timeControl === undefined) return null;
  const increment = /^(\d+)\+(\d+)$/.exec(timeControl);
  if (increment?.[1]) return Number(increment[1]);
  const sudden = /^(\d+)$/.exec(timeControl);
  if (sudden?.[1]) return Number(sudden[1]);
  return null;
}

function durationUs(game: PgnGame): number | 'missing' | 'negative' {
  if (game.moves.length === 0) return 0;
  const thinks = thinkTimeSec(game);
  let seconds = 0;
  for (const think of thinks) {
    if (think === null) return 'missing';
    if (think < 0) return 'negative';
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
      const flagUs = monoUsFromEpochMs(clock, game.endTimeEpochMs ?? 0);
      const unplayed = unplayedTimeoutUs(game);
      if (unplayed === null) {
        return { startUs: flagUs - duration, endUs: flagUs, toleranceSec: STARTTIME_TOLERANCE_SEC };
      }
      return { startUs: flagUs - duration - unplayed, endUs: flagUs, toleranceSec: ENDTIME_TOLERANCE_SEC };
    }, 'endtime', clock);
  }
  if (mode === 'starttime') {
    const stamped = stamp(games, durations, (game, duration) => {
      const startUs = monoUsFromEpochMs(clock, game.startTimeEpochMs ?? 0);
      return { startUs, endUs: startUs + duration, toleranceSec: STARTTIME_TOLERANCE_SEC };
    }, 'starttime', clock);
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
  if (cursor > stopUs) {
    return { ok: false, banner: 'The games are longer than the session, so they were not placed.' };
  }
  const slackUs = stopUs - cursor;
  const slackSec = slackUs === 0 ? 0 : Math.ceil(slackUs / 1_000_000);
  const withTolerance = inferred.map((game) => ({
    ...game,
    alignment: { mode: 'inferred' as const, toleranceSec: slackSec },
  }));
  const checked = rejectOutside(withTolerance, clock);
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
  clock: SessionClock,
): { ok: true; games: AlignedGame[] } | { ok: false; banner: string } {
  const placed = games.map((game, index) => {
    const span = at(game, durations[index] ?? 0);
    return aligned(game, span.startUs, span.endUs, mode, span.toleranceSec);
  });
  return rejectOutside(placed, clock);
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
  clock: SessionClock,
): { ok: true; games: AlignedGame[] } | { ok: false; banner: string } {
  const recordedStart = clock.startAnchor.monoUs;
  const recordedStop = clock.stopAnchor?.monoUs;
  const outside = games.some((game) => {
    if (game.endUs < game.startUs) return true;
    if (game.startUs < recordedStart || game.endUs < recordedStart) return true;
    if (recordedStop !== undefined && (game.startUs > recordedStop || game.endUs > recordedStop)) return true;
    return false;
  });
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
  return sample.stable && sample.confidence >= CONFIDENCE_FLOOR;
}
