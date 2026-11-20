// What: decides whether a pulse reading is settled or elevated.
// Why: every band is relative to this session's baseline, so the chart does not claim an absolute state.
// Removed: the same pulse would be called elevated for every player.
export const ELEVATED_MARGIN_BPM = 10;

export type PulseBand = 'settled' | 'elevated';

/** At or above baseline + 10 bpm is elevated. A non-number is not a band. */
export function bandFor(bpm: number, baselineBpm: number): PulseBand | null {
  if (!Number.isFinite(bpm) || !Number.isFinite(baselineBpm)) return null;
  return bpm >= baselineBpm + ELEVATED_MARGIN_BPM ? 'elevated' : 'settled';
}
