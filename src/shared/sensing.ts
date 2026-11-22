// What: the shared sensing rules and the gaps in the drawn trace.
// Why: the screen and the coverage math must agree on what a hole is, or the strip would invent a pulse.
// Removed: a two-second dropout would be drawn as a smooth line.
import type { PulseSample } from './contracts.js';

/** Samples at or above this score can support a baseline or coverage. The raw file keeps the rest. */
export const CONFIDENCE_FLOOR = 50;
/** The resting pulse is the median of usable samples in this window. */
export const BASELINE_WINDOW_US = 60_000_000;
/** A usable sample covers the wait until the next one, and never more than this. */
export const SAMPLE_HOLD_US = 1_000_000;
/** The live quality reading looks back this far from the newest sample. */
export const SIGNAL_WINDOW_US = 60_000_000;
/** No sample for this long means the stream, not the lighting, is the problem. */
export const SIGNAL_STALE_MS = 5_000;
/** The session limit is enforced in main; this is the warning point for the screen. */
export const SESSION_WARNING_MS = 80 * 60 * 1_000;
export const SESSION_LIMIT_MS = 90 * 60 * 1_000;

export function isUsableSample(sample: PulseSample, floor = CONFIDENCE_FLOOR): boolean {
  // An occluded sample was taken where no face could be measured, so it cannot support a number.
  if (sample.occluded === true) return false;
  return sample.stable && sample.confidence >= floor;
}

/**
 * What: the time covered by samples taken while the face was covered.
 * Why: R6-07 reports that time as its own line, and it must match what coverage actually drops by,
 *      so each marked sample covers only the wait until the next sample, as coverage does.
 * Removed: the report could claim a covered minute that coverage never counted.
 */
export function occludedUs(
  samples: readonly PulseSample[],
  stopUs: number,
  holdUs = SAMPLE_HOLD_US,
): number {
  const ordered = [...samples].sort((left, right) => left.tUs - right.tUs);
  let total = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    const sample = ordered[index];
    if (!sample || sample.occluded !== true) continue;
    const nextUs = index + 1 < ordered.length ? (ordered[index + 1]?.tUs ?? stopUs) : stopUs;
    const gap = nextUs - sample.tUs;
    if (gap <= 0) continue;
    total += Math.min(gap, holdUs);
  }
  return total;
}

export type SignalQuality = 'waiting' | 'good' | 'weak' | 'poor';

export interface SignalReading {
  quality: SignalQuality;
  label: string;
  usable: number;
  total: number;
}

/**
 * The usable-sample share of the trailing minute. It looks back from the newest sample, because
 * the page has no separate monotonic clock shared with main. `signalStale` covers a stream that
 * has stopped; the ratio itself describes the samples that did arrive.
 */
export function signalQuality(samples: readonly PulseSample[], windowUs = SIGNAL_WINDOW_US): SignalReading {
  let latest = -Infinity;
  for (const sample of samples) {
    if (sample.tUs > latest) latest = sample.tUs;
  }
  if (!Number.isFinite(latest)) {
    return { quality: 'waiting', label: 'Waiting for samples', usable: 0, total: 0 };
  }
  const recent = samples.filter((sample) => latest - sample.tUs <= windowUs);
  if (recent.length === 0) {
    return { quality: 'waiting', label: 'Waiting for samples', usable: 0, total: 0 };
  }
  const usable = recent.filter((sample) => isUsableSample(sample)).length;
  const ratio = usable / recent.length;
  if (ratio >= 0.8) {
    return { quality: 'good', label: 'Good signal', usable, total: recent.length };
  }
  if (ratio >= 0.5) {
    return { quality: 'weak', label: 'Weak signal — check lighting', usable, total: recent.length };
  }
  return { quality: 'poor', label: 'Poor signal — check lighting and framing', usable, total: recent.length };
}

/** True when the stream has gone quiet, even if the last minute of stored samples looked good. */
export function signalStale(lastSampleAtMs: number | null, nowMs: number): boolean {
  return lastSampleAtMs !== null && nowMs - lastSampleAtMs > SIGNAL_STALE_MS;
}

/** Elapsed session time for the page. The stored header remains the authority for the report. */
export function formatElapsedMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const two = (value: number): string => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${two(minutes)}:${two(seconds)}` : `${minutes}:${two(seconds)}`;
}

/** Null before the warning point; a player-facing line at and after 80 minutes. */
export function limitWarning(elapsedMs: number): string | null {
  if (elapsedMs < SESSION_WARNING_MS) return null;
  const remaining = Math.max(0, SESSION_LIMIT_MS - elapsedMs);
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes <= 0) return 'The 90-minute limit is reached. ChessPulse is stopping the session.';
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} left before the 90-minute limit.`;
}


export function traceSegments(
  samples: readonly PulseSample[],
  holdUs = SAMPLE_HOLD_US,
): PulseSample[][] {
  const ordered = [...samples].sort((left, right) => left.tUs - right.tUs);
  const segments: PulseSample[][] = [];
  let current: PulseSample[] = [];
  for (const sample of ordered) {
    const previous = current[current.length - 1];
    if (previous && sample.tUs - previous.tUs > holdUs) {
      segments.push(current);
      current = [];
    }
    current.push(sample);
  }
  if (current.length > 0) segments.push(current);
  return segments;
}
