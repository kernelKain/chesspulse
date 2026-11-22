// What: the first-run explainer copy and its one local preference.
// Why: the player must learn the limits before the camera opens, and must not meet the explainer twice.
// Removed: the first screen would be a wall of controls, and the fair-play line would live only in the README.

export const EXPLAINER_TITLE = 'ChessPulse reviews your chess session after you play.';

export const EXPLAINER_INTRO =
  'It watches your pulse through the camera while you play on chess.com, then shows your pulse next to your moves, so you can see whether a bad stretch lined up with a stressful stretch.';

export interface ExplainerStep {
  readonly title: string;
  readonly body: string;
}

/** Five steps, in the order Setup repeats. Step one is the current position on the first screen. */
export const EXPLAINER_STEPS: readonly ExplainerStep[] = [
  {
    title: 'Allow the camera.',
    body: 'Nothing is recorded. No video or image is saved. Only pulse numbers are stored, on this computer.',
  },
  {
    title: 'Check your framing.',
    body: 'Sit so your upper chest is in view and you are the only face on screen.',
  },
  {
    title: 'Play on chess.com.',
    body: 'ChessPulse does not show anything during a game. Mark each game end with one button.',
  },
  {
    title: 'Stop and paste your games.',
    body: 'Copy the PGNs from chess.com, oldest first.',
  },
  {
    title: 'Read your review.',
    body: 'One verdict line, one timeline, and the accuracy in calm and elevated pulse periods.',
  },
];

/** The limits are stated as plainly as the features, including the fair-play line. */
export const EXPLAINER_NEVERS: readonly string[] = [
  'It does not give advice during a rated game.',
  'It does not diagnose anything or give medical advice.',
  'It does not upload your data. Everything stays local.',
];

export const EXPLAINER_PREFERENCE_KEY = 'chesspulse.explainer.seen.v1';

/** The two methods the page needs. A real `localStorage` satisfies this without a DOM type here. */
export interface PreferenceStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * A missing, unreadable, or throwing store means "not seen": the safe failure is to explain the
 * product again, never to hide the consent and fair-play lines behind a broken preference.
 */
export function readExplainerSeen(store: PreferenceStore | null | undefined): boolean {
  if (!store) return false;
  try {
    return store.getItem(EXPLAINER_PREFERENCE_KEY) === 'true';
  } catch {
    return false;
  }
}

/** Returns false when the preference could not be saved; the screen still closes for this run. */
export function rememberExplainerSeen(store: PreferenceStore | null | undefined): boolean {
  if (!store) return false;
  try {
    store.setItem(EXPLAINER_PREFERENCE_KEY, 'true');
    return true;
  } catch {
    return false;
  }
}
