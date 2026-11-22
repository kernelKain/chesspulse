// What: the small display rules for a stored session row.
// Why: Home and Sessions must describe date, duration, coverage, and report presence the same way.
// Removed: each list would format the same fields differently, and a null would print as a number.
import { formatElapsedMs } from './sensing.js';

export function formatSessionDate(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return 'Unknown date';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(epochMs));
}

export function formatSessionDuration(ms: number | null): string {
  return ms === null ? 'No duration' : `${formatElapsedMs(ms)} elapsed`;
}

export function coverageLabel(pct: number | null): string {
  return pct === null ? 'No coverage' : `${Math.round(pct)}% coverage`;
}

export function reportPresenceLabel(hasReport: boolean): string {
  return hasReport ? 'Report saved' : 'No report yet';
}
