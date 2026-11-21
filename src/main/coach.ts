// What: emits at most one numbered recovery prompt in each player-marked between-games gap.
// Why: the fair-play boundary forbids advice during a game; a rolling median ignores weak samples.
// Removed: a pulse spike could produce advice during a rated game or repeat on every batch.
import { BASELINE_WINDOW_US } from '../shared/sensing.js';
import type { CoachMessage, PulseSample } from '../shared/contracts.js';
import { ELEVATED_MARGIN_BPM } from './analysis/bands.js';
import { baselineFromSamples, isUsableSample } from './session.js';

export class BetweenGamesCoach {
  private readonly samples: PulseSample[] = [];
  private betweenGames = false;
  private fired = false;

  constructor(private readonly startUs: number) {}

  ingest(samples: readonly PulseSample[]): CoachMessage | null {
    this.samples.push(...samples);
    return this.evaluate();
  }

  setBetweenGames(active: boolean): CoachMessage | null {
    if (active === this.betweenGames) return null;
    this.betweenGames = active;
    if (!active) {
      this.fired = false;
      return null;
    }
    return this.evaluate();
  }

  private evaluate(): CoachMessage | null {
    if (!this.betweenGames || this.fired || this.samples.length === 0) return null;
    const latestUs = this.samples.reduce((latest, sample) => Math.max(latest, sample.tUs), this.startUs);
    if (latestUs < this.startUs + BASELINE_WINDOW_US) return null;
    const baseline = baselineFromSamples(this.samples, this.startUs)?.baselineBpm;
    if (baseline === undefined) return null;

    const recent = this.samples
      .filter(
        (sample) =>
          sample.tUs >= latestUs - BASELINE_WINDOW_US &&
          sample.tUs <= latestUs &&
          isUsableSample(sample),
      )
      .map((sample) => sample.bpm);
    if (recent.length === 0) return null;
    const recentBpm = median(recent);
    if (recentBpm < baseline + ELEVATED_MARGIN_BPM) return null;

    const deltaBpm = Math.round((recentBpm - baseline) * 10) / 10;
    this.fired = true;
    return {
      baselineBpm: baseline,
      recentBpm,
      deltaBpm,
      text: `Pulse still +${formatNumber(deltaBpm)} over baseline. Take a real break before the next game.`,
    };
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
