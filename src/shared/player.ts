// What: decides whose moves a report scores, from the player names in the pasted games.
// Why: the pulse trace belongs to one person. Scoring the opponent's moves against it would put
//      someone else's play under the player's heartbeat and call it "accuracy".
// Removed: every ply in every game would be scored and banded, whichever side made it.
import type { PreferenceStore } from './onboarding.js';

export interface NamedGame {
  readonly white: string;
  readonly black: string;
  readonly includeInStats: boolean;
}

export type PlayerSide = 'white' | 'black' | 'both';

/** Why a report counts both sides. `ambiguous`: more than one name is in every game. */
export type AllMovesReason = 'ambiguous' | 'no_common_name';

export type PlayerScope =
  | { readonly kind: 'player'; readonly name: string }
  | { readonly kind: 'all_moves'; readonly reason: AllMovesReason };

export type PlayerResolution =
  | { readonly ok: true; readonly scope: PlayerScope }
  | { readonly ok: false; readonly message: string };

/** chess.com usernames are case-insensitive; surrounding space in a header is not part of a name. */
export function sameName(left: string, right: string): boolean {
  const a = left.trim().toLowerCase();
  return a.length > 0 && a === right.trim().toLowerCase();
}

/**
 * What: the names present in every game that counts toward accuracy, in first-seen order.
 * Why: only a name present in every game can be the one person whose pulse was measured.
 *      Aborted and abandoned games do not count, so they do not narrow the choice.
 */
export function playerCandidates(games: readonly NamedGame[]): string[] {
  const counted = games.filter((game) => game.includeInStats);
  if (counted.length === 0) return [];
  const first = counted[0];
  if (!first) return [];
  const seeds: string[] = [];
  for (const name of [first.white, first.black]) {
    const trimmed = name.trim();
    if (trimmed.length > 0 && !seeds.some((seed) => sameName(seed, trimmed))) seeds.push(trimmed);
  }
  return seeds.filter((name) =>
    counted.every((game) => sameName(game.white, name) || sameName(game.black, name)),
  );
}

/**
 * What: the scope a report uses, optionally with the player the page asked about.
 * Why: a single game or a rematch series has two names in every game, so only the player can say
 *      which one they are. A requested name outside any counted game is refused, never trusted.
 */
export function resolvePlayer(games: readonly NamedGame[], requested?: string): PlayerResolution {
  const candidates = playerCandidates(games);
  if (requested !== undefined) {
    const chosen = candidates.find((name) => sameName(name, requested));
    if (!chosen) {
      return {
        ok: false,
        message: 'The chosen player is not in every pasted game. Choose the player again on the paste screen.',
      };
    }
    return { ok: true, scope: { kind: 'player', name: chosen } };
  }
  if (candidates.length === 1 && candidates[0]) {
    return { ok: true, scope: { kind: 'player', name: candidates[0] } };
  }
  return {
    ok: true,
    scope: { kind: 'all_moves', reason: candidates.length > 1 ? 'ambiguous' : 'no_common_name' },
  };
}

/** The side the scoped player had in one game. `both` covers all-moves scope and a self-paired game. */
export function sideInGame(game: Pick<NamedGame, 'white' | 'black'>, scope: PlayerScope): PlayerSide {
  if (scope.kind === 'all_moves') return 'both';
  const white = sameName(game.white, scope.name);
  const black = sameName(game.black, scope.name);
  if (white && !black) return 'white';
  if (black && !white) return 'black';
  return 'both';
}

/** Ply 0 is White's first move, so even plies are White's and odd plies are Black's. */
export function plyBelongsTo(side: PlayerSide, plyIndex: number): boolean {
  if (side === 'both') return true;
  return side === 'white' ? plyIndex % 2 === 0 : plyIndex % 2 === 1;
}

export const PLAYER_PREFERENCE_KEY = 'chesspulse.player.name.v1';

/** Usernames are short; a longer stored value is treated as corrupt rather than shown. */
export const PLAYER_NAME_MAX = 64;

/** A missing, unreadable, or throwing store means "no remembered player": the page asks again. */
export function readRememberedPlayer(store: PreferenceStore | null | undefined): string | null {
  if (!store) return null;
  try {
    const value = store.getItem(PLAYER_PREFERENCE_KEY)?.trim() ?? '';
    return value.length > 0 && value.length <= PLAYER_NAME_MAX ? value : null;
  } catch {
    return null;
  }
}

/** Returns false when the name could not be saved; the current paste still uses the choice. */
export function rememberPlayer(store: PreferenceStore | null | undefined, name: string): boolean {
  const trimmed = name.trim();
  if (!store || trimmed.length === 0 || trimmed.length > PLAYER_NAME_MAX) return false;
  try {
    store.setItem(PLAYER_PREFERENCE_KEY, trimmed);
    return true;
  } catch {
    return false;
  }
}
