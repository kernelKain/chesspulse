// What: turns a review into its three stages, each with its own state and the reason for it.
// Why: R6-04 wants pulse, engine, then reading on one screen; one failed stage must not hide the
//      others, and a refused Stage 1 must say that it blocked the rest.
// Removed: the Review would be one undifferentiated page where a refusal looks like an empty report.
import type { ReportResult } from './contracts.js';

export type StageId = 'pulse' | 'engine' | 'reading';

export type StageState = 'ready' | 'refused' | 'unavailable' | 'disabled' | 'empty';

export type StageReason =
  | 'low_coverage'
  | 'refused'
  | 'blocked'
  | 'building'
  | 'report_failed'
  | 'no_report'
  | 'no_key'
  | 'ai_error'
  | 'not_written'
  | 'writing';

export interface StageView {
  readonly id: StageId;
  readonly index: 1 | 2 | 3;
  readonly state: StageState;
  /** Why the stage is not ready. Null when it is. */
  readonly reason: StageReason | null;
}

/** The reading panel's own state, passed in as a plain status so this module stays renderer-free. */
export type ReadingStatus = 'idle' | 'loading' | 'ready' | 'disabled' | 'error';

export interface StageInput {
  readonly result: ReportResult | null;
  readonly building: boolean;
  readonly failed: boolean;
  readonly reading: ReadingStatus;
}

/**
 * What: the three stages in the order the player reads them.
 * Why: the order is the product's argument — the trace, then the moves, then what a model inferred.
 */
export function reviewStages(input: StageInput): readonly [StageView, StageView, StageView] {
  const stage = (
    index: 1 | 2 | 3,
    id: StageId,
    state: StageState,
    reason: StageReason | null,
  ): StageView => ({
    id,
    index,
    state,
    reason,
  });

  if (input.result === null) {
    // Nothing was built yet. The same reason applies to every stage, and it is never "refused".
    const state: StageState = input.building ? 'empty' : 'unavailable';
    const reason: StageReason = input.building ? 'building' : input.failed ? 'report_failed' : 'no_report';
    return [
      stage(1, 'pulse', state, reason),
      stage(2, 'engine', state, reason),
      stage(3, 'reading', state, reason),
    ];
  }

  if (!input.result.ok) {
    // Stage 1 owns the trace. Without it there is nothing for the engine or the reading to compare.
    const reason: StageReason = input.result.reason === 'low_coverage' ? 'low_coverage' : 'refused';
    return [
      stage(1, 'pulse', 'refused', reason),
      stage(2, 'engine', 'disabled', 'blocked'),
      stage(3, 'reading', 'disabled', 'blocked'),
    ];
  }

  const reading =
    input.reading === 'disabled'
      ? stage(3, 'reading', 'disabled', 'no_key')
      : input.reading === 'error'
        ? stage(3, 'reading', 'unavailable', 'ai_error')
        : input.reading === 'loading'
          ? stage(3, 'reading', 'empty', 'writing')
          : input.reading === 'idle'
            ? stage(3, 'reading', 'empty', 'not_written')
            : stage(3, 'reading', 'ready', null);

  return [stage(1, 'pulse', 'ready', null), stage(2, 'engine', 'ready', null), reading];
}
