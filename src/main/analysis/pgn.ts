// What: turns pasted chess.com PGNs into games, clocks, endings, and think times.
// Why: the report's order, timeline, and accuracy stats all start from this parse.
// Removed: a missing clock would become a zero, and an aborted game would enter the stats.
// Legality is not replayed here. Move legality is checked when positions are built for the engine.
import { pgnGameSchema, type PgnGame } from '../../shared/contracts.js';

const MAX_GAMES = 20;
const PASTE_BYTE_LIMIT = 2_000_000;
const SAN =
  /^(O-O-O|O-O|[NBRQK][a-h]?[1-8]?x?[a-h][1-8]|[a-h]x[a-h][1-8](?:=[NBRQ])?|[a-h][1-8](?:=[NBRQ])?)[+#]?/;

export interface PgnBatchSummary {
  total: number;
  includedInStats: number;
  aborted: number;
  abandoned: number;
}

export type PgnFailure =
  | { ok: false; reason: 'invalid'; index: number; message: string }
  | { ok: false; reason: 'order'; indices: number[]; remedy: string }
  | { ok: false; reason: 'no_games'; remedy: string };

export type PgnParseResult = { ok: true; game: PgnGame } | Extract<PgnFailure, { reason: 'invalid' }>;

export type PgnBatchResult =
  | { ok: true; games: PgnGame[]; order: 'checked' | 'unverified'; summary: PgnBatchSummary }
  | PgnFailure;

interface ClockParts {
  baseSec: number;
  incrementSec: number;
}

export function parsePgn(pgn: string, index: number): PgnParseResult {
  if (!Number.isInteger(index) || index < 0) {
    return invalid(index, 'The game index is not a position in the paste.');
  }
  const eventCount = pgn.match(/^\[Event\s+"/gm)?.length ?? 0;
  if (eventCount > 1) {
    return invalid(index, 'Paste one game per entry.');
  }

  const parts = splitPgn(pgn);
  if (parts.headers.get('FEN') !== undefined || parts.headers.get('SetUp') === '1') {
    return invalid(index, 'Setup positions are not accepted.');
  }
  const listed = readMoves(parts.movetext);
  if (!listed.ok) return invalid(index, listed.message);
  const headerResult = parts.headers.get('Result');
  if (!headerResult) return invalid(index, 'The Result tag is missing.');
  if (listed.result !== headerResult) {
    return invalid(index, 'The movetext result does not match the Result tag.');
  }

  const endDate = parts.headers.get('EndDate');
  const endClock = parts.headers.get('EndTime');
  const endTime = endClock === undefined ? undefined : epochPair(endDate, endClock);
  if (endTime === 'bad') return invalid(index, 'EndDate and EndTime are not a complete UTC time.');
  const startTime = epochPair(parts.headers.get('UTCDate'), parts.headers.get('UTCTime'));
  if (startTime === 'bad') return invalid(index, 'UTCDate and UTCTime are not a complete UTC time.');

  const ending = classifyEnding(parts.headers.get('Termination'), listed.moves);
  const game = {
    index,
    white: parts.headers.get('White') ?? '',
    black: parts.headers.get('Black') ?? '',
    result: headerResult,
    endTimeEpochMs: endTime,
    startTimeEpochMs: startTime,
    timeControl: parts.headers.get('TimeControl'),
    moves: listed.moves,
    ending,
    includeInStats: ending !== 'aborted' && ending !== 'abandoned',
  };
  const checked = pgnGameSchema.safeParse(game);
  if (!checked.success) return invalid(index, 'The parsed game does not match the game contract.');
  return { ok: true, game: checked.data };
}

export function parsePgnBatch(pgns: readonly string[]): PgnBatchResult {
  if (pgns.length === 0) {
    return {
      ok: false,
      reason: 'no_games',
      remedy: 'Paste at least one game.',
    };
  }
  if (pgns.length > MAX_GAMES) {
    return invalid(MAX_GAMES, 'A paste can contain at most 20 games.');
  }
  if (new TextEncoder().encode(pgns.join('\n')).length > PASTE_BYTE_LIMIT) {
    return invalid(0, 'PGN paste exceeds 2 MB.');
  }

  const games: PgnGame[] = [];
  for (let index = 0; index < pgns.length; index += 1) {
    const parsed = parsePgn(pgns[index] ?? '', index);
    if (!parsed.ok) return parsed;
    games.push(parsed.game);
  }

  const order = chronologicalOrder(games);
  if (order.kind === 'reject') {
    return { ok: false, reason: 'order', indices: order.indices, remedy: order.remedy };
  }

  return {
    ok: true,
    games,
    order: order.kind,
    summary: {
      total: games.length,
      includedInStats: games.filter((game) => game.includeInStats).length,
      aborted: games.filter((game) => game.ending === 'aborted').length,
      abandoned: games.filter((game) => game.ending === 'abandoned').length,
    },
  };
}

/** Think time in seconds, from each side's previous clock. A missing clock stays null. */
export function thinkTimeSec(game: Pick<PgnGame, 'moves' | 'timeControl'>): (number | null)[] {
  const control = game.timeControl === undefined ? null : parseTimeControl(game.timeControl);
  if (!control) return game.moves.map(() => null);

  let whiteTenths = control.baseSec * 10;
  let blackTenths = control.baseSec * 10;
  let whiteKnown = true;
  let blackKnown = true;

  return game.moves.map((move, index) => {
    const white = index % 2 === 0;
    const known = white ? whiteKnown : blackKnown;
    if (move.clockSec === undefined || !known) {
      if (white) whiteKnown = false;
      else blackKnown = false;
      return null;
    }
    const clockTenths = Math.round(move.clockSec * 10);
    const previous = white ? whiteTenths : blackTenths;
    const thinkTenths = previous - clockTenths + control.incrementSec * 10;
    if (white) whiteTenths = clockTenths;
    else blackTenths = clockTenths;
    return thinkTenths / 10;
  });
}

function invalid(index: number, message: string): Extract<PgnFailure, { reason: 'invalid' }> {
  return { ok: false, reason: 'invalid', index, message };
}

function splitPgn(pgn: string): { headers: Map<string, string>; movetext: string } {
  const lines = pgn.replace(/^\uFEFF/, '').split(/\r?\n/);
  const headerLines: string[] = [];
  let index = 0;
  while (index < lines.length && /^\s*\[[A-Za-z0-9]+\s+"/.test(lines[index] ?? '')) {
    headerLines.push(lines[index] ?? '');
    index += 1;
  }
  while (index < lines.length && (lines[index] ?? '').trim() === '') index += 1;
  return { headers: readHeaders(headerLines.join('\n')), movetext: lines.slice(index).join('\n') };
}

function readHeaders(headerText: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of headerText.split(/\r?\n/)) {
    const match = /^\s*\[([A-Za-z0-9]+)\s+"((?:\\.|[^"\\])*)"\]\s*$/.exec(line);
    if (!match) continue;
    const value = match[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    headers.set(match[1], value);
  }
  return headers;
}

function readMoves(
  movetext: string,
): { ok: true; moves: { san: string; clockSec?: number }[]; result: string } | { ok: false; message: string } {
  const moves: { san: string; clockSec?: number }[] = [];
  let cursor = 0;
  let result: string | undefined;

  while (cursor < movetext.length) {
    while (cursor < movetext.length && /\s/.test(movetext[cursor] ?? '')) cursor += 1;
    if (cursor >= movetext.length) break;

    const mark = movetext[cursor];
    if (mark === '{') {
      const end = movetext.indexOf('}', cursor + 1);
      if (end < 0) return { ok: false, message: 'A move comment is missing its closing brace.' };
      const comment = movetext.slice(cursor + 1, end);
      cursor = end + 1;
      const last = moves.at(-1);
      if (!last) return { ok: false, message: 'A comment appears before any move.' };
      const clock = clockFromComment(comment);
      if (clock === 'bad') return { ok: false, message: 'A [%clk] comment is not a clock time.' };
      if (clock !== undefined) {
        if (last.clockSec !== undefined) return { ok: false, message: 'A move has two clock comments.' };
        last.clockSec = clock;
      }
      continue;
    }
    if (mark === '(' || mark === ')') {
      return { ok: false, message: 'Variations are not accepted. Paste the played line only.' };
    }

    const rest = movetext.slice(cursor);
    const resultMatch = /^(?:1-0|0-1|1\/2-1\/2|\*)(?=\s|$)/.exec(rest);
    if (resultMatch) {
      result = resultMatch[0];
      cursor += resultMatch[0].length;
      while (cursor < movetext.length && /\s/.test(movetext[cursor] ?? '')) cursor += 1;
      if (cursor < movetext.length) return { ok: false, message: 'Text continues after the game result.' };
      break;
    }

    const number = /^\d+\.+(?=\s|[NBRQKa-hO])/.exec(rest);
    if (number) {
      cursor += number[0].length;
      continue;
    }

    const san = SAN.exec(rest);
    if (!san) return { ok: false, message: 'A move is not in standard notation.' };
    const next = rest[san[0].length];
    if (next !== undefined && !/[\s{!?]/.test(next) && next !== '$') {
      return { ok: false, message: 'A move is not in standard notation.' };
    }
    moves.push({ san: san[0] });
    cursor += san[0].length;
    const suffix = /^[!?]+|^\$\d+/.exec(movetext.slice(cursor));
    if (suffix) cursor += suffix[0].length;
  }

  if (!result) return { ok: false, message: 'The movetext has no result.' };
  return { ok: true, moves, result };
}

function clockFromComment(comment: string): number | undefined | 'bad' {
  const markers = comment.match(/\[%clk/g);
  if (!markers) return undefined;
  if (markers.length > 1) return 'bad';
  const match = /\[%clk\s+(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)\]/.exec(comment);
  if (!match) return 'bad';
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (minutes > 59 || seconds >= 60) return 'bad';
  const whole = Math.trunc(seconds);
  const tenths = hours * 36000 + minutes * 600 + whole * 10 + Math.round((seconds - whole) * 10);
  return tenths / 10;
}

const UNKNOWN_DATE = '????.??.??';
const UNKNOWN_TIME = '??:??:??';

function epochPair(date: string | undefined, time: string | undefined): number | undefined | 'bad' {
  if (date === undefined && time === undefined) return undefined;
  if (date === undefined || time === undefined) return 'bad';
  if (date === UNKNOWN_DATE && time === UNKNOWN_TIME) return undefined;
  if (date.includes('?') || time.includes('?')) return 'bad';
  const day = /^(\d{4})\.(\d{2})\.(\d{2})$/.exec(date);
  const clock = /^(\d{2}):(\d{2}):(\d{2})$/.exec(time);
  if (!day || !clock) return 'bad';
  const month = Number(day[2]);
  const dayOfMonth = Number(day[3]);
  const hour = Number(clock[1]);
  const minute = Number(clock[2]);
  const second = Number(clock[3]);
  if (month < 1 || month > 12 || dayOfMonth < 1 || dayOfMonth > 31) return 'bad';
  if (hour > 23 || minute > 59 || second > 59) return 'bad';
  const year = Number(day[1]);
  const utc = Date.UTC(year, month - 1, dayOfMonth, hour, minute, second);
  const back = new Date(utc);
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== dayOfMonth
  ) {
    return 'bad';
  }
  return utc;
}

function classifyEnding(
  termination: string | undefined,
  moves: readonly { san: string }[],
): PgnGame['ending'] {
  const text = termination?.toLowerCase() ?? '';
  const reason = text.match(/\bwon by ([a-z]+)\b/)?.[1] ?? text.match(/\bwon on ([a-z]+)\b/)?.[1] ?? text;
  if (reason.includes('abort')) return 'aborted';
  if (reason.includes('abandon')) return 'abandoned';
  if (reason.includes('checkmate')) return 'checkmate';
  if (reason.includes('resign')) return 'resignation';
  if (reason.includes('time')) return 'timeout';
  if (moves.at(-1)?.san.endsWith('#')) return 'checkmate';
  return 'unknown';
}

function parseTimeControl(value: string): ClockParts | null {
  const increment = /^(\d+)\+(\d+)$/.exec(value);
  if (increment) return { baseSec: Number(increment[1]), incrementSec: Number(increment[2]) };
  const sudden = /^(\d+)$/.exec(value);
  if (sudden) return { baseSec: Number(sudden[1]), incrementSec: 0 };
  return null;
}

function chronologicalOrder(
  games: readonly PgnGame[],
):
  | { kind: 'checked' }
  | { kind: 'unverified' }
  | { kind: 'reject'; indices: number[]; remedy: string } {
  const anyEnd = games.some((game) => game.endTimeEpochMs !== undefined);
  const anyStart = games.some((game) => game.startTimeEpochMs !== undefined);
  if (!anyEnd && !anyStart) return { kind: 'unverified' };

  if (anyEnd) {
    const missing = games.filter((game) => game.endTimeEpochMs === undefined).map((game) => game.index);
    if (missing.length > 0) {
      return {
        kind: 'reject',
        indices: missing,
        remedy: 'Every game needs an EndTime, or none of them can, so the order is not guessed.',
      };
    }
    return compareKeys(
      games.map((game) => game.endTimeEpochMs ?? 0),
      games,
    );
  }

  const missingStarts = games
    .filter((game) => game.startTimeEpochMs === undefined)
    .map((game) => game.index);
  if (missingStarts.length > 0) {
    return {
      kind: 'reject',
      indices: missingStarts,
      remedy: 'Every game needs a UTC start, or none of them can, so the order is not guessed.',
    };
  }
  return compareKeys(
    games.map((game) => game.startTimeEpochMs ?? 0),
    games,
  );
}

function compareKeys(
  keys: readonly number[],
  games: readonly PgnGame[],
): { kind: 'checked' } | { kind: 'reject'; indices: number[]; remedy: string } {
  const indices = new Set<number>();
  for (let index = 1; index < keys.length; index += 1) {
    if ((keys[index] ?? 0) < (keys[index - 1] ?? 0)) {
      indices.add(games[index - 1]?.index ?? index - 1);
      indices.add(games[index]?.index ?? index);
    }
  }
  if (indices.size === 0) return { kind: 'checked' };
  const ordered = [...indices].sort((left, right) => left - right);
  const labels = ordered.map((index) => index + 1);
  const names =
    labels.length === 2
      ? `Game ${labels[0]} and Game ${labels[1]}`
      : `Games ${labels.join(', ')}`;
  return {
    kind: 'reject',
    indices: ordered,
    remedy: `${names} are out of chronological order. Paste games oldest first.`,
  };
}
