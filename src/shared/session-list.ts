// What: the small display rules for a stored session row.
// Why: Home and Sessions must describe date, duration, coverage, and report presence the same way.
// Removed: each list would format the same fields differently, and a null would print as a number.
import { formatElapsedMs } from './sensing.js';

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
