// What: the AI Session Explainer's ten suggested questions and which ones this report can support.
// Why: a question about data the report lacks (no clocks, no marked break, no per-game summaries)
//      would send a request the model can only answer by guessing. Those are disabled with a reason.
// Removed: the player could spend a provider call on a question with nothing behind it.
import type { Report } from './contracts.js';
import { needsRebuild } from './quality.js';

export const QUESTION_KEYS = [
  'timeline',
  'quality',
  'pattern',
  'ranges',
  'reviewFirst',
  'mistakes',
  'thinkTime',
  'longestBreak',
  'limits',
  'nextSession',
] as const;

export type QuestionKey = (typeof QUESTION_KEYS)[number];
export type UnavailableReason = 'mistakes' | 'thinkTime' | 'longestBreak';

/** Questions this report cannot support, each with the reason. Absent keys are available. */
export function unavailableQuestions(report: Report): Partial<Record<QuestionKey, UnavailableReason>> {
  const missing: Partial<Record<QuestionKey, UnavailableReason>> = {};
  const hasSummaries = report.games.some((game) => game.summary) && !needsRebuild(report);
  if (!hasSummaries) missing.mistakes = 'mistakes';
  if (!report.timeline.moves.some((move) => move.thinkSec !== null)) missing.thinkTime = 'thinkTime';
  if (!report.longestGap) missing.longestBreak = 'longestBreak';
  return missing;
}
