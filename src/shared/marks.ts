// What: decides when the player must say which mark ended each game, and checks their answer.
// Why: R6-06 lets the player answer a mismatch instead of the app guessing a boundary.
// Removed: a mismatch would only produce an error, and that session could never be reviewed.
import type { SessionMarkView } from './contracts.js';

/**
 * The placement rule accepts N ends, or N-1 when the last game ended at the session stop.
 * Anything else has to be answered by the player.
 */
export function markChoiceNeeded(
  marks: readonly Pick<SessionMarkView, 'kind'>[],
  gameCount: number,
): boolean {
  if (gameCount === 0 || marks.length === 0) return false;
  const ends = marks.filter((mark) => mark.kind === 'end').length;
  return ends > gameCount || ends < gameCount - 1;
}

/** A later game cannot end at or before the game before it. */
export function picksAreOrdered(picks: readonly (number | null)[]): boolean {
  let previous: number | null = null;
  for (const pick of picks) {
    if (pick === null) return false;
    if (previous !== null && pick <= previous) return false;
    previous = pick;
  }
  return true;
}
