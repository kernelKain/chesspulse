// What: centipawn loss, per-move accuracy, band aggregates, and the verdict sentence.
// Why: those numbers are computed here, so a model cannot invent them.
// Removed: a failed search would count as a perfect move, and a thin band would print a percentage.
import { type PulseBand } from './bands.js';

/** Published Lichess curve: https://lichess.org/page/accuracy */
const WIN_PERCENT_K = 0.00368208;
const ACCURACY_A = 103.1668100711649;
const ACCURACY_K = 0.04354415386753951;
const ACCURACY_B = -3.166924740191411;
/** A blunder is a drop of at least 30 win-percent points. Lichess judgement 0.3. */
export const BLUNDER_WIN_DROP = 30;
/** Fewer scored moves than this are not given a percentage. Two is the checked thin case. */
export const MIN_BAND_MOVES = 5;

export interface Score {
  evalFailed: boolean;
  scoreCp?: number;
  mate?: number;
}

export interface MoveMetric {
  cpl: number | null;
  accuracy: number | null;
  blunder: boolean;
  band: PulseBand | null;
  includeInStats: boolean;
}

export type BandSummary =
  | { band: PulseBand; moves: number; status: 'insufficient' }
  | { band: PulseBand; moves: number; status: 'ok'; accuracy: number };

export interface AnalysisSummary {
  settled: BandSummary;
  elevated: BandSummary;
  blunders: number;
  elevatedBlunders: number;
}

export function centipawnLoss(before: Score, after: Score): number | null {
  if (!scored(before) || !scored(after)) return null;
  return Math.max(0, before.scoreCp + after.scoreCp);
}

export function winPercent(centipawns: number): number {
  return 100 / (1 + Math.exp(-WIN_PERCENT_K * centipawns));
}

/** `afterScoreCp` is the engine score after the move, from the opponent's point of view. */
export function moveAccuracy(beforeScoreCp: number, afterScoreCp: number): number {
  const before = winPercent(beforeScoreCp);
  const after = winPercent(-afterScoreCp);
  if (after >= before) return 100;
  const raw = ACCURACY_A * Math.exp(-ACCURACY_K * (before - after)) + ACCURACY_B + 1;
  return Math.min(100, Math.max(0, raw));
}

export function scoreMove(
  before: Score,
  after: Score,
  band: PulseBand | null,
  includeInStats: boolean,
): MoveMetric {
  const cpl = centipawnLoss(before, after);
  if (cpl === null || !scored(before) || !scored(after)) {
    return { cpl: null, accuracy: null, blunder: false, band, includeInStats };
  }
  const drop = winPercent(before.scoreCp) - winPercent(-after.scoreCp);
  return {
    cpl,
    accuracy: moveAccuracy(before.scoreCp, after.scoreCp),
    blunder: drop >= BLUNDER_WIN_DROP,
    band,
    includeInStats,
  };
}

export function analyseMoves(moves: readonly MoveMetric[]): AnalysisSummary {
  const counted = moves.filter((move) => move.includeInStats);
  return {
    settled: bandSummary('settled', counted),
    elevated: bandSummary('elevated', counted),
    blunders: counted.filter((move) => move.blunder).length,
    elevatedBlunders: counted.filter((move) => move.blunder && move.band === 'elevated').length,
  };
}

export function verdictLine(
  summary: AnalysisSummary,
  moment: { elevatedMinutes: number; deltaBpm: number; gapClause?: string },
): string {
  const blunderWord = summary.blunders === 1 ? 'blunder' : 'blunders';
  const where =
    moment.elevatedMinutes > 0
      ? `in the ${moment.elevatedMinutes} minutes your pulse stayed ${moment.deltaBpm} bpm above baseline`
      : 'while your pulse was elevated';
  const sentence = `${summary.blunders} ${blunderWord}, ${summary.elevatedBlunders} of them ${where}. ${accuracyPhrase(summary)}.`;
  const gap = moment.gapClause?.trim();
  return gap ? `${sentence} ${gap}` : sentence;
}

function bandSummary(band: PulseBand, moves: readonly MoveMetric[]): BandSummary {
  const scored = moves.filter((move) => move.band === band && move.accuracy !== null);
  if (scored.length < MIN_BAND_MOVES) {
    return { band, moves: scored.length, status: 'insufficient' };
  }
  const total = scored.reduce((sum, move) => sum + (move.accuracy ?? 0), 0);
  return { band, moves: scored.length, status: 'ok', accuracy: Math.round(total / scored.length) };
}

function accuracyPhrase(summary: AnalysisSummary): string {
  return `Accuracy ${bandPhrase('settled', summary.settled)}, ${bandPhrase('elevated', summary.elevated)}`;
}

function bandPhrase(label: string, summary: BandSummary): string {
  return summary.status === 'ok' ? `${summary.accuracy}% ${label}` : `${label} insufficient`;
}

function scored(score: Score): score is Score & { scoreCp: number } {
  return !score.evalFailed && score.mate === undefined && score.scoreCp !== undefined;
}
