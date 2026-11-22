// What: emits at most one numbered recovery prompt in each player-marked between-games gap.
// Why: the fair-play boundary forbids advice during a game; a rolling median ignores weak samples.
// Removed: every session sample was retained and the baseline was recomputed on every batch.
import { BASELINE_WINDOW_US } from '../shared/sensing.js';
import type { CoachMessage, PulseSample } from '../shared/contracts.js';
import { ELEVATED_MARGIN_BPM } from './analysis/bands.js';
import { baselineFromSamples, isUsableSample } from './session.js';

/** The coach only needs the trailing ten minutes to judge the current gap. */
export const COACH_RECENT_WINDOW_US = 10 * 60 * 1_000_000;

type BaselineReader = (
  samples: readonly PulseSample[],
  startUs: number,
) => { baselineBpm?: number } | undefined;

export class BetweenGamesCoach {
  private samples: PulseSample[] = [];
  private latestUs: number;
  private baselineResolved = false;
  private baselineBpm: number | undefined;
  private betweenGames = false;
  private fired = false;

  constructor(
    private readonly startUs: number,
    private readonly readBaseline: BaselineReader = baselineFromSamples,
  ) {
    this.latestUs = startUs;
  }

  /** Test and diagnostic visibility into the bounded window. */
  get retainedSampleCount(): number {
    return this.samples.length;
  }

  ingest(batch: readonly PulseSample[]): CoachMessage | null {
    for (const sample of batch) {
      this.samples.push(sample);
      if (sample.tUs > this.latestUs) this.latestUs = sample.tUs;
    }
    this.resolveBaseline();
    this.prune();
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

  private resolveBaseline(): void {
    if (this.baselineResolved) return;
    if (this.latestUs < this.startUs + BASELINE_WINDOW_US) return;
    // One calculation when the first minute is complete; later batches never recompute it.
    this.baselineBpm = this.readBaseline(this.samples, this.startUs)?.baselineBpm;
    this.baselineResolved = true;
  }

  private prune(): void {
    if (!this.baselineResolved) return;
    const cutoff = this.latestUs - COACH_RECENT_WINDOW_US;
    this.samples = this.samples.filter((sample) => sample.tUs >= cutoff);
  }

  private evaluate(): CoachMessage | null {
    if (!this.betweenGames || this.fired) return null;
    if (!this.baselineResolved || this.baselineBpm === undefined) return null;
    if (this.samples.length === 0) return null;

    const recent = this.samples
      .filter(
        (sample) =>
          sample.tUs >= this.latestUs - BASELINE_WINDOW_US &&
          sample.tUs <= this.latestUs &&
          isUsableSample(sample),
      )
      .map((sample) => sample.bpm);
    if (recent.length === 0) return null;
    const recentBpm = median(recent);
    if (recentBpm < this.baselineBpm + ELEVATED_MARGIN_BPM) return null;

    const deltaBpm = Math.round((recentBpm - this.baselineBpm) * 10) / 10;
    this.fired = true;
    return {
      baselineBpm: this.baselineBpm,
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
