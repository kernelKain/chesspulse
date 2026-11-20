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
