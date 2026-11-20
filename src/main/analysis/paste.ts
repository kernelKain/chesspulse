// What: validates pasted PGN slots for the Paste screen using the authoritative PGN parser.
// Why: the UI and the report builder must agree on order, clocks, endings, and paste limits.
// Removed: out-of-order or malformed PGNs would reach the report builder without per-game feedback.
import {
  pasteValidationSchema,
  type PasteGameSummary,
  type PasteSlot,
  type PasteValidation,
  type PgnGame,
} from '../../shared/contracts.js';
import { parsePgn, parsePgnBatch } from './pgn.js';

const MAX_GAMES = 20;
const PASTE_BYTE_LIMIT = 2_000_000;
export const CLOCKLESS_MESSAGE =
  'These games have no clock data. Think time is unavailable; accuracy by band still works.';

interface FilledSlot {
  slotIndex: number;
  text: string;
}

export function validatePasteBatch(slots: readonly string[]): PasteValidation {
  const filled: FilledSlot[] = [];
  for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
    const text = slots[slotIndex] ?? '';
    if (text.trim().length > 0) filled.push({ slotIndex, text });
  }

  if (filled.length === 0) {
    return pasteValidationSchema.parse({
      state: 'empty',
      order: 'none',
      clockless: false,
      canBuild: false,
      message: 'Paste chess.com PGNs oldest first.',
      summary: { total: 0, includedInStats: 0, aborted: 0, abandoned: 0 },
      slots: slots.map((_text, slotIndex) => ({ slotIndex, status: 'empty' })),
    });
  }

  if (filled.length > MAX_GAMES) {
    return pasteValidationSchema.parse({
      state: 'invalid',
      order: 'none',
      clockless: false,
      canBuild: false,
      message: 'A paste can contain at most 20 games.',
      summary: { total: 0, includedInStats: 0, aborted: 0, abandoned: 0 },
      slots: slots.map((text, slotIndex) => {
        if (text.trim().length === 0) return { slotIndex, status: 'empty' };
        return { slotIndex, status: 'invalid', message: 'A paste can contain at most 20 games.' };
      }),
    });
  }

  if (new TextEncoder().encode(filled.map((entry) => entry.text).join('\n')).length > PASTE_BYTE_LIMIT) {
    return pasteValidationSchema.parse({
      state: 'invalid',
      order: 'none',
      clockless: false,
      canBuild: false,
      message: 'PGN paste exceeds 2 MB.',
      summary: { total: 0, includedInStats: 0, aborted: 0, abandoned: 0 },
      slots: slots.map((text, slotIndex) => {
        if (text.trim().length === 0) return { slotIndex, status: 'empty' };
        return { slotIndex, status: 'invalid', message: 'PGN paste exceeds 2 MB.' };
      }),
    });
  }

  const parsedBySlot = new Map<number, PgnGame>();
  const invalidBySlot = new Map<number, string>();
  for (let compactIndex = 0; compactIndex < filled.length; compactIndex += 1) {
    const entry = filled[compactIndex];
    if (!entry) continue;
    const parsed = parsePgn(entry.text, compactIndex);
    if (parsed.ok) parsedBySlot.set(entry.slotIndex, parsed.game);
    else invalidBySlot.set(entry.slotIndex, parsed.message);
  }

  const validGames = [...parsedBySlot.values()];
  const validSummary = summarizeBatch(validGames);

  if (invalidBySlot.size > 0) {
    const invalidLabels = [...invalidBySlot.keys()]
      .sort((left, right) => left - right)
      .map((slotIndex) => slotIndex + 1);
    const target =
      invalidLabels.length === 1 ? `Game ${invalidLabels[0]}` : `Games ${invalidLabels.join(', ')}`;
    return pasteValidationSchema.parse({
      state: 'invalid',
      order: 'none',
      clockless: false,
      canBuild: false,
      message: `Fix ${target} before continuing.`,
      summary: validSummary,
      slots: slots.map((_text, slotIndex): PasteSlot => {
        const error = invalidBySlot.get(slotIndex);
        if (error !== undefined) return { slotIndex, status: 'invalid', message: error };
        const game = parsedBySlot.get(slotIndex);
        if (game) return { slotIndex, status: 'valid', game: summarizeGame(game) };
        return { slotIndex, status: 'empty' };
      }),
    });
  }

  const batch = parsePgnBatch(filled.map((entry) => entry.text));
  if (!batch.ok) {
    if (batch.reason === 'order') {
      const orderDetails = describeOrderFailure(filled, parsedBySlot, batch.indices, batch.remedy);
      return pasteValidationSchema.parse({
        state: 'out_of_order',
        order: 'invalid',
        clockless: false,
        canBuild: false,
        message: orderDetails.batchMessage,
        summary: validSummary,
        slots: slots.map((_text, slotIndex): PasteSlot => {
          const game = parsedBySlot.get(slotIndex);
          if (!game) return { slotIndex, status: 'empty' };
          const slotMessage = orderDetails.perSlot.get(slotIndex);
          if (slotMessage !== undefined) {
            return { slotIndex, status: 'order_error', game: summarizeGame(game), message: slotMessage };
          }
          return { slotIndex, status: 'valid', game: summarizeGame(game) };
        }),
      });
    }
    const fallbackMessage = batch.reason === 'invalid' ? batch.message : batch.remedy;
    return pasteValidationSchema.parse({
      state: 'invalid',
      order: 'none',
      clockless: false,
      canBuild: false,
      message: fallbackMessage,
      summary: validSummary,
      slots: slots.map((_text, slotIndex): PasteSlot => {
        const game = parsedBySlot.get(slotIndex);
        if (game) return { slotIndex, status: 'valid', game: summarizeGame(game) };
        return { slotIndex, status: 'empty' };
      }),
    });
  }

  const clockless = batch.games.some(
    (game) =>
      game.includeInStats &&
      game.moves.length > 0 &&
      game.moves.every((move) => move.clockSec === undefined),
  );
  const hasEmptySlot = filled.length < slots.length;
  const hasIncludedGame = batch.summary.includedInStats > 0;
  const state = clockless ? 'clockless' : hasEmptySlot ? 'partial' : 'valid';
  const countLabel = `${batch.games.length} ${batch.games.length === 1 ? 'game' : 'games'}`;

  let message: string;
  if (clockless) {
    message = CLOCKLESS_MESSAGE;
  } else if (!hasIncludedGame) {
    message = 'Only aborted or abandoned games were pasted. Add a finished game to build a report.';
  } else if (hasEmptySlot) {
    message = `${countLabel} validated. Paste another game or continue.`;
  } else {
    message = `${countLabel} validated and ready.`;
  }

  return pasteValidationSchema.parse({
    state,
    order: batch.order,
    clockless,
    canBuild: hasIncludedGame,
    message,
    summary: batch.summary,
    slots: slots.map((_text, slotIndex): PasteSlot => {
      const game = parsedBySlot.get(slotIndex);
      if (game) return { slotIndex, status: 'valid', game: summarizeGame(game) };
      return { slotIndex, status: 'empty' };
    }),
  });
}

function summarizeGame(game: PgnGame): PasteGameSummary {
  const clocked = game.moves.filter((move) => move.clockSec !== undefined).length;
  return {
    white: game.white,
    black: game.black,
    result: game.result,
    ending: game.ending,
    moveCount: game.moves.length,
    hasClocks: clocked > 0,
    partialClocks: clocked > 0 && clocked < game.moves.length,
    includeInStats: game.includeInStats,
    ...(game.timeControl !== undefined ? { timeControl: game.timeControl } : {}),
  };
}

function summarizeBatch(games: readonly PgnGame[]) {
  return {
    total: games.length,
    includedInStats: games.filter((game) => game.includeInStats).length,
    aborted: games.filter((game) => game.ending === 'aborted').length,
    abandoned: games.filter((game) => game.ending === 'abandoned').length,
  };
}

function describeOrderFailure(
  filled: readonly FilledSlot[],
  parsedBySlot: ReadonlyMap<number, PgnGame>,
  compactIndices: readonly number[],
  fallbackRemedy: string,
): { batchMessage: string; perSlot: Map<number, string> } {
  const perSlot = new Map<number, string>();
  const games = filled
    .map((entry) => ({ slotIndex: entry.slotIndex, game: parsedBySlot.get(entry.slotIndex) }))
    .filter((entry): entry is { slotIndex: number; game: PgnGame } => entry.game !== undefined);

  const anyEnd = games.some((entry) => entry.game.endTimeEpochMs !== undefined);
  const anyStart = games.some((entry) => entry.game.startTimeEpochMs !== undefined);

  if (anyEnd && games.some((entry) => entry.game.endTimeEpochMs === undefined)) {
    const missingSlots = compactIndices
      .map((index) => filled[index]?.slotIndex)
      .filter((slotIndex): slotIndex is number => slotIndex !== undefined);
    for (const slotIndex of missingSlots) {
      perSlot.set(slotIndex, 'Missing EndTime while other games include one.');
    }
    const names = formatGameList(missingSlots);
    const verb = missingSlots.length === 1 ? 'is' : 'are';
    return {
      batchMessage: `${names} ${verb} missing EndTime. ${fallbackRemedy}`,
      perSlot,
    };
  }

  if (!anyEnd && anyStart && games.some((entry) => entry.game.startTimeEpochMs === undefined)) {
    const missingSlots = compactIndices
      .map((index) => filled[index]?.slotIndex)
      .filter((slotIndex): slotIndex is number => slotIndex !== undefined);
    for (const slotIndex of missingSlots) {
      perSlot.set(slotIndex, 'Missing UTC start while other games include one.');
    }
    const names = formatGameList(missingSlots);
    const verb = missingSlots.length === 1 ? 'is' : 'are';
    return {
      batchMessage: `${names} ${verb} missing a UTC start. ${fallbackRemedy}`,
      perSlot,
    };
  }

  const useEnd = anyEnd;
  const verb = useEnd ? 'ends' : 'starts';
  const reversedPairs: { earlierSlot: number; laterSlot: number }[] = [];
  for (let index = 1; index < games.length; index += 1) {
    const previous = games[index - 1];
    const current = games[index];
    if (!previous || !current) continue;
    const prevKey = useEnd ? (previous.game.endTimeEpochMs ?? 0) : (previous.game.startTimeEpochMs ?? 0);
    const currKey = useEnd ? (current.game.endTimeEpochMs ?? 0) : (current.game.startTimeEpochMs ?? 0);
    if (currKey < prevKey) {
      reversedPairs.push({ earlierSlot: previous.slotIndex, laterSlot: current.slotIndex });
      perSlot.set(
        current.slotIndex,
        `Game ${current.slotIndex + 1} ${verb} before Game ${previous.slotIndex + 1}. Paste games oldest first.`,
      );
      if (!perSlot.has(previous.slotIndex)) {
        perSlot.set(
          previous.slotIndex,
          `Out of order with Game ${current.slotIndex + 1}. Paste games oldest first.`,
        );
      }
    }
  }

  if (reversedPairs.length === 1 && reversedPairs[0]) {
    const pair = reversedPairs[0];
    return {
      batchMessage: `Game ${pair.laterSlot + 1} ${verb} before Game ${pair.earlierSlot + 1}. Paste games oldest first.`,
      perSlot,
    };
  }

  const slotIndices = compactIndices
    .map((index) => filled[index]?.slotIndex)
    .filter((slotIndex): slotIndex is number => slotIndex !== undefined);
  for (const slotIndex of slotIndices) {
    if (!perSlot.has(slotIndex)) {
      perSlot.set(slotIndex, 'Out of chronological order. Paste games oldest first.');
    }
  }
  const names = formatGameList(slotIndices);
  return {
    batchMessage: `${names} are out of chronological order. Paste games oldest first.`,
    perSlot,
  };
}

function formatGameList(slotIndices: readonly number[]): string {
  const labels = [...slotIndices].sort((left, right) => left - right).map((slotIndex) => slotIndex + 1);
  if (labels.length === 1) return `Game ${labels[0]}`;
  if (labels.length === 2) return `Game ${labels[0]} and Game ${labels[1]}`;
  return `Games ${labels.join(', ')}`;
}
