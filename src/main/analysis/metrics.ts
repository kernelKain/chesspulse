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
  /** A terminal position chess.js identified locally; such a position is never sent to the engine. */
  terminal?: 'checkmate' | 'stalemate';
}

/** Mate in N maps to 10000 - 100N, so every mate outranks any centipawn advantage. */
export const MATE_SCORE_BASE = 10_000;
export const MATE_SCORE_STEP = 100;
/** Distances beyond this stay at the floor; a mate in 100 must still beat any ordinary score. */
export const MATE_SCORE_FLOOR = 5_000;

export interface MoveMetric {
  cpl: number | null;
  accuracy: number | null;
  blunder: boolean;
  /**
   * True when either side of the move carried a mate score or the move ended in checkmate.
   * Such moves count in accuracy and blunders but keep `cpl` null for display.
   */
  mate: boolean;
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
  /** Included moves with no centipawn score. They are not blunders. */
  unscored: number;
  /** Included moves that received a centipawn score. */
  scored: number;
}

export function mateToCp(mate: number): number {
  const magnitude = Math.max(
    MATE_SCORE_FLOOR,
    MATE_SCORE_BASE - MATE_SCORE_STEP * Math.abs(mate),
  );
  if (mate > 0) return magnitude;
  if (mate < 0) return -magnitude;
  // UCI mate 0 means the side to move is already mated.
  return -MATE_SCORE_BASE;
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
  const mate = mateInvolved(before) || mateInvolved(after);
  const beforeCp = normalisedCp(before);
  const afterCp = normalisedCp(after);
  if (beforeCp === null || afterCp === null) {
    return { cpl: null, accuracy: null, blunder: false, mate, band, includeInStats };
  }
  const drop = winPercent(beforeCp) - winPercent(-afterCp);
  return {
    // A mate value near 10,000 would swamp every centipawn bar, so the display keeps null.
    cpl: mate ? null : Math.max(0, beforeCp + afterCp),
    accuracy: moveAccuracy(beforeCp, afterCp),
    blunder: drop >= BLUNDER_WIN_DROP,
    mate,
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
    unscored: counted.filter((move) => move.accuracy === null).length,
    scored: counted.filter((move) => move.accuracy !== null).length,
  };
}

/** Whole-game accuracy uses the same five-move floor as a band, so one game cannot print a guess. */
export type AccuracySummary =
  | { moves: number; status: 'insufficient' }
  | { moves: number; status: 'ok'; accuracy: number };

/** How many of a game's largest move losses the report keeps for review. */
export const LARGEST_LOSSES = 3;

export interface ScoredPly {
  moveIndex: number;
  metric: MoveMetric;
  thinkSec: number | null;
}

export interface GameSummary {
  scored: number;
  unscored: number;
  overall: AccuracySummary;
  settled: BandSummary;
  elevated: BandSummary;
  blunders: number;
  elevatedBlunders: number;
  /** Mean think time over the player's moves with a known clock, to 0.1 s. Null without clocks. */
  avgThinkSec: number | null;
  /** The player's largest centipawn losses, largest first; ties keep the earlier move. */
  largestLosses: { moveIndex: number; cpl: number; blunder: boolean }[];
}

/**
 * What: one game's facts, from the same move metrics that produce the session verdict.
 * Why: per-game review must agree with the session totals; recomputing in the page could drift.
 * Removed: the report could only say how many blunders a game had, not how it went.
 */
export function summariseGame(plies: readonly ScoredPly[]): GameSummary {
  const metrics = plies.map((ply) => ply.metric);
  const totals = analyseMoves(metrics);
  const counted = plies.filter((ply) => ply.metric.includeInStats);
  const scoredAccuracies = counted
    .map((ply) => ply.metric.accuracy)
    .filter((value): value is number => value !== null);
  const overall: AccuracySummary =
    scoredAccuracies.length < MIN_BAND_MOVES
      ? { moves: scoredAccuracies.length, status: 'insufficient' }
      : {
          moves: scoredAccuracies.length,
          status: 'ok',
          accuracy: Math.round(scoredAccuracies.reduce((sum, value) => sum + value, 0) / scoredAccuracies.length),
        };
  const thinks = counted
    .map((ply) => ply.thinkSec)
    .filter((value): value is number => value !== null && Number.isFinite(value) && value >= 0);
  const avgThinkSec =
    thinks.length === 0 ? null : Math.round((thinks.reduce((sum, value) => sum + value, 0) / thinks.length) * 10) / 10;
  const largestLosses = counted
    .filter((ply) => ply.metric.cpl !== null && ply.metric.cpl > 0)
    .map((ply) => ({ moveIndex: ply.moveIndex, cpl: Math.round(ply.metric.cpl ?? 0), blunder: ply.metric.blunder }))
    .sort((left, right) => right.cpl - left.cpl || left.moveIndex - right.moveIndex)
    .slice(0, LARGEST_LOSSES);
  return {
    scored: totals.scored,
    unscored: totals.unscored,
    overall,
    settled: totals.settled,
    elevated: totals.elevated,
    blunders: totals.blunders,
    elevatedBlunders: totals.elevatedBlunders,
    avgThinkSec,
    largestLosses,
  };
}

export function verdictLine(
  summary: AnalysisSummary,
  moment: { elevatedMinutes?: number; deltaBpm?: number; gapClause?: string },
): string {
  const minutes =
    moment.elevatedMinutes === undefined ? undefined : Math.max(0, Math.round(moment.elevatedMinutes));
  if (summary.scored === 0) {
    const word = summary.unscored === 1 ? 'move' : 'moves';
    const leftOut = summary.unscored > 0 ? ` ${summary.unscored} ${word} had no centipawn score and were left out.` : '';
    return `Not enough scored moves for a verdict.${leftOut}`;
  }
  const blunderWord = summary.blunders === 1 ? 'blunder' : 'blunders';
  const minuteWord = minutes === 1 ? 'minute' : 'minutes';
  const where =
    minutes !== undefined && minutes > 0 && moment.deltaBpm !== undefined
      ? `in the ${minutes} ${minuteWord} your pulse was elevated, peaking ${moment.deltaBpm} bpm above baseline`
      : 'while your pulse was elevated';
  const leftOut =
    summary.unscored > 0
      ? ` ${summary.unscored} ${summary.unscored === 1 ? 'move' : 'moves'} had no centipawn score and were left out.`
      : '';
  const sentence = `${summary.blunders} ${blunderWord}, ${summary.elevatedBlunders} of them ${where}. ${accuracyPhrase(summary)}.${leftOut}`;
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

function normalisedCp(score: Score): number | null {
  if (score.evalFailed) return null;
  if (score.terminal === 'checkmate') return -MATE_SCORE_BASE;
  if (score.terminal === 'stalemate') return 0;
  if (score.mate !== undefined) return mateToCp(score.mate);
  return score.scoreCp ?? null;
}

function mateInvolved(score: Score): boolean {
  return score.terminal === 'checkmate' || score.mate !== undefined;
}
