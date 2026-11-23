// What: the small display rules for a stored session row.
// Why: Home and Sessions must describe date, duration, coverage, and report presence the same way.
// Removed: each list would format the same fields differently, and a null would print as a number.
import { formatElapsedMs } from './sensing.js';

/** Below this share of usable pulse signal, a report is refused rather than built weak. */
export const COVERAGE_GATE_PCT = 70;

/**
 * Where a shipped example session stands. "built": its report is saved. "withheld": its coverage is
 * below the gate, so any report build is refused. "pending": neither, which a shipped example should
 * never be, but the card must still say something true.
 */
export type ExampleOutcome = 'built' | 'withheld' | 'pending';

export function exampleOutcome(session: { hasReport: boolean; coveragePct: number | null }): ExampleOutcome {
  if (session.hasReport) return 'built';
  if (session.coveragePct !== null && session.coveragePct < COVERAGE_GATE_PCT) return 'withheld';
  return 'pending';
}

export function formatSessionDate(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return 'Unknown date';
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return 'Unknown date';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function formatSessionDuration(ms: number | null): string {
  return ms === null ? 'No duration' : `${formatElapsedMs(ms)} elapsed`;
}

export function coverageLabel(pct: number | null): string {
  // Floor, so the list and the refusal's measured percentage cannot say 18% and 17%.
  return pct === null ? 'No coverage' : `${Math.floor(pct)}% coverage`;
}

export function reportPresenceLabel(hasReport: boolean): string {
  return hasReport ? 'Report saved' : 'No report yet';
}
