// What: the Move Quality view model — the Overall tab and one tab per game, from stored report facts.
// Why: the section shows per-game numbers and comparison sentences. Every value is read from the
//      report main computed; this module only selects, pairs, and compares them, so the page cannot
//      disagree with the verdict or with what the AI is allowed to cite.
// Removed: the renderer would recompute accuracy from timeline moves and could drift from the report.
import type { GameSummaryData, Report, ReportGame, ReportTotals } from './contracts.js';
import { reportTotals } from './summary.js';
import { formatElapsed, moveLabel } from './timeline.js';

type BandSummary = Report['settled'];

/** How two pulse ranges compare. It states which was higher, never why. */
export type BandComparison =
  | { kind: 'insufficient' }
  | { kind: 'same' }
  | { kind: 'settled_higher' | 'elevated_higher'; difference: number };

/**
 * Compares the rounded percentages, so the sentence agrees with the two numbers printed beside it.
 * A range under the five-move floor has no number, so there is no comparison.
 */
export function compareBands(settled: BandSummary, elevated: BandSummary): BandComparison {
  if (settled.status !== 'ok' || elevated.status !== 'ok') return { kind: 'insufficient' };
  const difference = Math.round(settled.accuracy) - Math.round(elevated.accuracy);
  if (difference === 0) return { kind: 'same' };
  return difference > 0
    ? { kind: 'settled_higher', difference }
    : { kind: 'elevated_higher', difference: -difference };
}

/** One game in the Overall tab's comparison list. */
export interface GameComparisonRow {
  readonly index: number;
  readonly number: number;
  readonly white: string;
  readonly black: string;
  readonly result: string;
  readonly included: boolean;
  /** `null` when the game is excluded or the report predates per-game summaries. */
  readonly accuracy: number | 'insufficient' | null;
  /** `null` for an excluded game, which has no scored moves. */
  readonly blunders: number | null;
}

export interface OverallQualityView {
  readonly settled: BandSummary;
  readonly elevated: BandSummary;
  readonly comparison: BandComparison;
  readonly totals: ReportTotals;
  readonly gamesExcluded: number;
  readonly rows: readonly GameComparisonRow[];
  /** True when a counted game has no stored summary: the report was built before A3. */
  readonly needsRebuild: boolean;
}

export function overallQuality(report: Report): OverallQualityView {
  const totals = reportTotals(report);
  return {
    settled: report.settled,
    elevated: report.elevated,
    comparison: compareBands(report.settled, report.elevated),
    totals,
    gamesExcluded: report.games.filter((game) => !game.includeInStats).length,
    rows: report.games.map((game) => ({
      index: game.index,
      number: game.index + 1,
      white: game.white,
      black: game.black,
      result: game.result,
      included: game.includeInStats,
      accuracy: !game.summary
        ? null
        : game.summary.overall.status === 'ok'
          ? game.summary.overall.accuracy
          : 'insufficient',
      blunders: game.includeInStats ? (game.summary?.blunders ?? game.blunders) : null,
    })),
    needsRebuild: needsRebuild(report),
  };
}

export function needsRebuild(report: Report): boolean {
  return report.games.some((game) => game.includeInStats && !game.summary);
}

/** One of the game's largest losses, with what the timeline needs to open it. */
export interface LossRow {
  readonly moveIndex: number;
  /** As a chess player writes it: `12… Nc6`. */
  readonly label: string;
  readonly cpl: number;
  readonly blunder: boolean;
  /** Session time of the move, or `null` when the game was not placed on the timeline. */
  readonly tUs: number | null;
}

export type GameQualityView =
  | { readonly kind: 'excluded'; readonly game: ReportGame }
  | { readonly kind: 'needs_rebuild'; readonly game: ReportGame }
  | {
      readonly kind: 'ok';
      readonly game: ReportGame;
      readonly summary: GameSummaryData;
      /** Elapsed session time, `m:ss`, or `null` when the game is not on the timeline. */
      readonly span: { readonly start: string; readonly end: string } | null;
      readonly comparison: BandComparison;
      readonly losses: readonly LossRow[];
    };

export function gameQuality(report: Report, gameIndex: number): GameQualityView | null {
  const game = report.games.find((candidate) => candidate.index === gameIndex);
  if (!game) return null;
  if (!game.includeInStats) return { kind: 'excluded', game };
  const summary = game.summary;
  if (!summary) return { kind: 'needs_rebuild', game };
  const timeline = report.timeline;
  const placed = game.aligned ? timeline.games.find((candidate) => candidate.index === game.index) : undefined;
  const moves = timeline.moves.filter((move) => move.gameIndex === game.index);
  return {
    kind: 'ok',
    game,
    summary,
    span: placed
      ? { start: formatElapsed(placed.startUs, timeline.startUs), end: formatElapsed(placed.endUs, timeline.startUs) }
      : null,
    comparison: compareBands(summary.settled, summary.elevated),
    losses: summary.largestLosses.map((loss) => {
      const move = moves.find((candidate) => candidate.moveIndex === loss.moveIndex);
      return {
        moveIndex: loss.moveIndex,
        label: move ? moveLabel(loss.moveIndex, move.san) : moveNumber(loss.moveIndex),
        cpl: loss.cpl,
        blunder: loss.blunder,
        tUs: placed && move ? move.tUs : null,
      };
    }),
  };
}

/** The move number alone, for a loss whose move is missing from the stored timeline. */
function moveNumber(moveIndex: number): string {
  const number = Math.floor(moveIndex / 2) + 1;
  return moveIndex % 2 === 0 ? `${number}.` : `${number}…`;
}
