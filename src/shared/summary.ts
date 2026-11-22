// What: the report header's headline, labelled metrics, and verdict lines, from stored numbers only.
// Why: the old header was a raw metadata line over one long sentence; a reader could not tell what
//      it said or why. Every value here is read from the report, never recomputed by the page.
// Removed: the Review would open on "Baseline 81.4 bpm · Elevated ≥ 91.4 bpm · Coverage 88%" and a paragraph.
import type { Report, ReportTotals } from './contracts.js';

export type MetricKey =
  | 'baseline'
  | 'threshold'
  | 'coverage'
  | 'blunders'
  | 'games'
  | 'scored'
  | 'settledAccuracy'
  | 'elevatedAccuracy'
  | 'longestBreak';

export interface SummaryMetric {
  readonly key: MetricKey;
  readonly value: string;
  /** Primary metrics stay visible in a narrow window; the rest sit behind "More session facts". */
  readonly primary: boolean;
}

export type HeadlineKind =
  | 'no_scored'
  | 'thin_bands'
  | 'no_blunders'
  | 'most_elevated'
  | 'some_elevated'
  | 'none_elevated';

export interface ReportSummaryView {
  readonly games: number;
  readonly durationLabel: string;
  readonly headline: HeadlineKind;
  /** True when the report scored one named player, so the headline may say "your". */
  readonly personal: boolean;
  readonly metrics: readonly SummaryMetric[];
  /** The stored verdict, one sentence per line. The wording is the report's, unchanged. */
  readonly verdictLines: readonly string[];
}

/**
 * What: session totals, stored or, for a report saved before totals existed, counted from its moves.
 * Why: the header and the AI context must use one count. Stored timeline moves are exactly the
 *      scored, included moves the verdict was computed from.
 */
export function reportTotals(report: Report): ReportTotals {
  if (report.totals) return report.totals;
  const moves = report.timeline.moves;
  return {
    gamesIncluded: report.games.filter((game) => game.includeInStats).length,
    scored: moves.filter((move) => move.scored).length,
    unscored: moves.filter((move) => !move.scored).length,
    blunders: moves.filter((move) => move.blunder).length,
    elevatedBlunders: moves.filter((move) => move.blunder && move.band === 'elevated').length,
  };
}

/**
 * First matching rule wins. The headline states a distribution, never a cause or a mental state.
 */
export function headlineKind(report: Report, totals: ReportTotals): HeadlineKind {
  if (totals.scored === 0) return 'no_scored';
  if (report.settled.status !== 'ok' || report.elevated.status !== 'ok') return 'thin_bands';
  if (totals.blunders === 0) return 'no_blunders';
  if (totals.elevatedBlunders * 2 > totals.blunders) return 'most_elevated';
  if (totals.elevatedBlunders > 0) return 'some_elevated';
  return 'none_elevated';
}

export function buildReportSummary(report: Report): ReportSummaryView {
  const totals = reportTotals(report);
  const metrics: SummaryMetric[] = [
    { key: 'baseline', value: `${formatNumber(report.baselineBpm)} bpm`, primary: true },
    { key: 'threshold', value: `${formatNumber(report.timeline.elevatedThresholdBpm)} bpm`, primary: true },
    { key: 'coverage', value: `${Math.round(report.coveragePct)}%`, primary: true },
    { key: 'blunders', value: String(totals.blunders), primary: true },
    { key: 'games', value: String(totals.gamesIncluded), primary: false },
    { key: 'scored', value: String(totals.scored), primary: false },
    { key: 'settledAccuracy', value: accuracyValue(report.settled), primary: false },
    { key: 'elevatedAccuracy', value: accuracyValue(report.elevated), primary: false },
  ];
  if (report.longestGap) {
    metrics.push({ key: 'longestBreak', value: durationLabel(report.longestGap.durationSec), primary: false });
  }
  return {
    games: report.games.length,
    durationLabel: durationLabel(Math.max(0, (report.timeline.stopUs - report.timeline.startUs) / 1_000_000)),
    headline: headlineKind(report, totals),
    personal: report.playerScope?.kind === 'player',
    metrics,
    verdictLines: splitSentences(report.verdict),
  };
}

/** "Insufficient" is a word, never a number, so a thin band cannot look like a measurement. */
function accuracyValue(summary: Report['settled']): string {
  return summary.status === 'ok' ? `${summary.accuracy}%` : 'Insufficient';
}

/** Whole minutes from one minute up, otherwise whole seconds. */
export function durationLabel(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  if (whole >= 60) return `${Math.round(whole / 60)} min`;
  return `${whole} s`;
}

/**
 * Splits at a full stop followed by a space and a capital or digit. A decimal such as 81.4 has no
 * space after its point, so it is never split.
 */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
