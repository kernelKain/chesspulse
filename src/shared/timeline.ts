// What: pure chart geometry, state classification, and accessible readouts for the composite timeline.
// Why: keeps gap handling, elevated-band styling, and capped CPL scaling testable without a browser.
// Removed: gaps could be bridged by mistake and elevated stretches would rely on colour alone.
import type {
  LowCoverageTrace,
  PgnGame,
  PulseSample,
  Refusal,
  Report,
  TimelineGame,
  TimelineMove,
} from './contracts.js';
import { CONFIDENCE_FLOOR, SAMPLE_HOLD_US } from './sensing.js';

/** CPL ticks cap at 300 centipawns so one large blunder does not flatten all other moves. */
export const CPL_CAP = 300;
/** Think-time dots scale smoothly up to 60 seconds and clamp above that. */
export const THINK_CAP_SEC = 60;

export type TimelineState = 'empty' | 'low_coverage' | 'aligned' | 'low_confidence';

export interface PulseRun {
  kind: 'settled' | 'elevated';
  points: PulseSample[];
}

export interface EndingMark {
  glyph: string;
  label: string;
}

export interface TimelineMoveRow {
  gameLabel: string;
  time: string;
  san: string;
  pulseBpm: string;
  band: string;
  cpl: string;
  think: string;
  note: string;
}

export interface TimelineSampleRow {
  time: string;
  bpm: string;
  confidence: number;
  status: string;
  gapBeforeSec: number | null;
}

export interface GameMiniTimelineView {
  game: TimelineGame;
  ending: EndingMark;
  spanLabel: string;
  startUs: number;
  stopUs: number;
  baselineBpm?: number;
  elevatedThresholdBpm?: number;
  yMinBpm: number;
  yMaxBpm: number;
  samples: PulseSample[];
  usableRuns: PulseRun[];
  weakSamples: PulseSample[];
  moves: TimelineMove[];
}

export interface TimelineViewModel {
  state: TimelineState;
  startUs: number;
  stopUs: number;
  baselineBpm?: number;
  elevatedThresholdBpm?: number;
  yMinBpm: number;
  yMaxBpm: number;
  samples: PulseSample[];
  usableRuns: PulseRun[];
  weakSamples: PulseSample[];
  games: TimelineGame[];
  moves: TimelineMove[];
  confidenceLabel?: string;
  banner?: string;
  refusal?: {
    measured?: number;
    threshold?: number;
    remedy: string;
  };
}

export function endingMark(ending: PgnGame['ending']): EndingMark {
  switch (ending) {
    case 'checkmate':
      return { glyph: '♚', label: 'mate' };
    case 'resignation':
      return { glyph: '✕', label: 'resignation' };
    case 'timeout':
      return { glyph: '⏱', label: 'timeout' };
    case 'abandoned':
      return { glyph: '⊘', label: 'abandoned' };
    case 'aborted':
      return { glyph: '⊘', label: 'aborted' };
    case 'unknown':
      return { glyph: '·', label: 'ended' };
  }
}

export function alignmentConfidenceLabel(report: Pick<Report, 'alignmentMode' | 'toleranceSec'>): string {
  const tolerance = formatSeconds(report.toleranceSec);
  if (report.alignmentMode === 'endtime') return `Aligned from EndTime (±${tolerance})`;
  if (report.alignmentMode === 'starttime') return `Aligned from start time (±${tolerance})`;
  return `Inferred from paste order (±${tolerance})`;
}

export function buildTimelineView(result: Report | Refusal | null): TimelineViewModel {
  if (!result) return emptyView();
  if (!result.ok) {
    if (result.reason === 'low_coverage') {
      return lowCoverageView(result.trace, {
        measured: result.measured,
        threshold: result.threshold,
        remedy: result.remedy,
      });
    }
    return {
      ...emptyView(),
      refusal: {
        measured: result.measured,
        threshold: result.threshold,
        remedy: result.remedy,
      },
    };
  }

  const { timeline } = result;
  const ordered = sortSamples(timeline.samples);
  if (ordered.length === 0 || timeline.stopUs <= timeline.startUs) {
    return emptyView();
  }

  const { usableRuns, weakSamples } = splitPulseRuns(ordered, timeline.elevatedThresholdBpm);
  const { yMinBpm, yMaxBpm } = bpmDomain(ordered, timeline.baselineBpm, timeline.elevatedThresholdBpm);
  const state: TimelineState =
    result.banner || result.alignmentMode !== 'endtime' ? 'low_confidence' : 'aligned';

  return {
    state,
    startUs: timeline.startUs,
    stopUs: timeline.stopUs,
    baselineBpm: timeline.baselineBpm,
    elevatedThresholdBpm: timeline.elevatedThresholdBpm,
    yMinBpm,
    yMaxBpm,
    samples: ordered,
    usableRuns,
    weakSamples,
    games: timeline.games,
    moves: timeline.moves,
    confidenceLabel: alignmentConfidenceLabel(result),
    ...(result.banner ? { banner: result.banner } : {}),
  };
}

/**
 * Splits raw samples into gap-preserving pulse runs.
 * Weak samples stay in `weakSamples` and break usable runs so holes are never bridged.
 */
export function splitPulseRuns(
  samples: readonly PulseSample[],
  elevatedThresholdBpm?: number,
  holdUs = SAMPLE_HOLD_US,
): { usableRuns: PulseRun[]; weakSamples: PulseSample[] } {
  const ordered = sortSamples(samples);
  const usableRuns: PulseRun[] = [];
  const weakSamples: PulseSample[] = [];
  let current: PulseRun | null = null;
  let lastUsable: PulseSample | null = null;

  for (const sample of ordered) {
    const usable = sample.stable && sample.confidence >= CONFIDENCE_FLOOR;
    if (!usable) {
      weakSamples.push(sample);
      current = null;
      lastUsable = null;
      continue;
    }

    const kind: PulseRun['kind'] =
      elevatedThresholdBpm !== undefined && sample.bpm >= elevatedThresholdBpm ? 'elevated' : 'settled';
    const bridged = lastUsable !== null && sample.tUs - lastUsable.tUs <= holdUs;

    if (!bridged || !current || !lastUsable) {
      const started: PulseRun = { kind, points: [sample] };
      current = started;
      usableRuns.push(started);
    } else if (current.kind === kind) {
      current.points.push(sample);
    } else {
      // Share the boundary point so crossing the threshold stays continuous without inventing a sample.
      const crossed: PulseRun = { kind, points: [lastUsable, sample] };
      current = crossed;
      usableRuns.push(crossed);
    }
    lastUsable = sample;
  }

  return { usableRuns, weakSamples };
}

export function cplBarRatio(cpl: number | null): number {
  if (cpl === null || !Number.isFinite(cpl) || cpl <= 0) return 0;
  return Math.min(1, cpl / CPL_CAP);
}

export function thinkTimeRatio(thinkSec: number | null): number {
  if (thinkSec === null || !Number.isFinite(thinkSec) || thinkSec <= 0) return 0;
  return Math.min(1, thinkSec / THINK_CAP_SEC);
}

export function formatElapsed(tUs: number, startUs: number): string {
  const sec = Math.max(0, Math.round((tUs - startUs) / 1_000_000));
  const mins = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${mins}:${String(rem).padStart(2, '0')}`;
}

export function sampleReadout(view: TimelineViewModel, sampleIndex: number): string {
  const sample = view.samples[sampleIndex];
  if (!sample) return 'Nothing recorded yet.';

  const time = formatElapsed(sample.tUs, view.startUs);
  const bpm = formatNumber(sample.bpm);
  const usable = sample.stable && sample.confidence >= CONFIDENCE_FLOOR;
  let bandText: string;
  if (!usable) {
    bandText = `low confidence (${sample.confidence})`;
  } else if (view.state === 'low_coverage' || view.elevatedThresholdBpm === undefined) {
    bandText = 'raw trace, bands withheld';
  } else if (sample.bpm >= view.elevatedThresholdBpm) {
    bandText = 'elevated';
  } else {
    bandText = 'settled';
  }

  const game = view.games.find((entry) => sample.tUs >= entry.startUs && sample.tUs <= entry.endUs);
  const gameText = game ? ` · Game ${game.index + 1}` : '';
  const nearestMove = nearestMoveTo(view.moves, sample.tUs);
  const moveText = nearestMove ? formatMoveReadout(nearestMove) : '';

  return `Sample ${sampleIndex + 1}/${view.samples.length} · ${time} · ${bpm} bpm · ${bandText}${gameText}${moveText}`;
}

export function moveTableRows(view: TimelineViewModel): TimelineMoveRow[] {
  if (view.state === 'low_coverage' || view.state === 'empty') return [];
  return view.moves.map((move) => {
    const pulse = move.tUs === null ? null : usableSampleAt(view.samples, move.tUs);
    return {
      gameLabel: `G${move.gameIndex + 1}`,
      time: move.tUs === null ? '—' : formatElapsed(move.tUs, view.startUs),
      san: move.san,
      pulseBpm: pulse ? `${formatNumber(pulse.bpm)} bpm` : '—',
      band: move.band === 'elevated' ? 'Elevated' : move.band === 'settled' ? 'Settled' : 'No reading',
      cpl: move.cpl === null ? 'Unscored' : `${Math.round(move.cpl)} cp`,
      think: move.thinkSec === null ? '—' : `${formatNumber(move.thinkSec)} s`,
      note: move.blunder ? 'Blunder' : move.cpl === null ? 'Mate or unscored' : '',
    };
  });
}

export function sampleTableRows(view: TimelineViewModel): TimelineSampleRow[] {
  if (view.samples.length === 0) return [];
  return view.samples.map((sample, index) => {
    const prev = index > 0 ? view.samples[index - 1] : undefined;
    const deltaUs = prev ? sample.tUs - prev.tUs : 0;
    const gapBeforeSec = deltaUs > SAMPLE_HOLD_US ? Math.round((deltaUs / 1_000_000) * 10) / 10 : null;
    const usable = sample.stable && sample.confidence >= CONFIDENCE_FLOOR;
    let status: string;
    if (!usable) {
      status = 'Low confidence';
    } else if (view.state === 'low_coverage' || view.elevatedThresholdBpm === undefined) {
      status = 'Raw (bands withheld)';
    } else if (sample.bpm >= view.elevatedThresholdBpm) {
      status = 'Elevated';
    } else {
      status = 'Settled';
    }
    return {
      time: formatElapsed(sample.tUs, view.startUs),
      bpm: `${formatNumber(sample.bpm)} bpm`,
      confidence: sample.confidence,
      status,
      gapBeforeSec,
    };
  });
}

export function buildGameMiniViews(view: TimelineViewModel): GameMiniTimelineView[] {
  if (view.state === 'low_coverage' || view.state === 'empty') return [];
  return view.games.map((game) => {
    const startUs = game.startUs;
    const stopUs = Math.max(game.endUs, game.startUs + 1_000_000);
    const samples = view.samples.filter(
      (sample) => sample.tUs >= game.startUs && sample.tUs <= game.endUs,
    );
    const { usableRuns, weakSamples } = splitPulseRuns(samples, view.elevatedThresholdBpm);
    const moves = view.moves.filter((move) => move.gameIndex === game.index);
    return {
      game,
      ending: endingMark(game.ending),
      spanLabel: `${formatElapsed(game.startUs, view.startUs)} – ${formatElapsed(game.endUs, view.startUs)}`,
      startUs,
      stopUs,
      ...(view.baselineBpm !== undefined ? { baselineBpm: view.baselineBpm } : {}),
      ...(view.elevatedThresholdBpm !== undefined
        ? { elevatedThresholdBpm: view.elevatedThresholdBpm }
        : {}),
      yMinBpm: view.yMinBpm,
      yMaxBpm: view.yMaxBpm,
      samples,
      usableRuns,
      weakSamples,
      moves,
    };
  });
}

function usableSampleAt(samples: readonly PulseSample[], tUs: number): PulseSample | null {
  let latest: PulseSample | undefined;
  for (const sample of samples) {
    if (sample.tUs <= tUs && (!latest || sample.tUs >= latest.tUs)) latest = sample;
  }
  if (!latest || !latest.stable || latest.confidence < CONFIDENCE_FLOOR) return null;
  if (tUs > latest.tUs + SAMPLE_HOLD_US) return null;
  return latest;
}

export function timeTicks(startUs: number, stopUs: number): number[] {
  if (stopUs <= startUs) return [startUs];
  const durationSec = (stopUs - startUs) / 1_000_000;
  const stepSec =
    durationSec <= 120
      ? 30
      : durationSec <= 600
        ? 60
        : durationSec <= 1800
          ? 300
          : 600;
  const stepUs = stepSec * 1_000_000;
  const ticks: number[] = [startUs];
  for (let t = startUs + stepUs; t < stopUs; t += stepUs) {
    ticks.push(t);
  }
  if (ticks[ticks.length - 1] !== stopUs) ticks.push(stopUs);
  return ticks;
}

function emptyView(): TimelineViewModel {
  return {
    state: 'empty',
    startUs: 0,
    stopUs: 0,
    yMinBpm: 50,
    yMaxBpm: 120,
    samples: [],
    usableRuns: [],
    weakSamples: [],
    games: [],
    moves: [],
  };
}

function lowCoverageView(
  trace: LowCoverageTrace | undefined,
  refusal: { measured?: number; threshold?: number; remedy: string },
): TimelineViewModel {
  if (!trace || trace.samples.length === 0 || trace.stopUs <= trace.startUs) {
    return {
      ...emptyView(),
      state: 'low_coverage',
      refusal,
    };
  }
  const ordered = sortSamples(trace.samples);
  // Low-coverage refusal withholds bands, so no elevatedThresholdBpm is passed.
  const { usableRuns, weakSamples } = splitPulseRuns(ordered, undefined);
  const { yMinBpm, yMaxBpm } = bpmDomain(ordered, trace.baselineBpm, undefined);
  return {
    state: 'low_coverage',
    startUs: trace.startUs,
    stopUs: trace.stopUs,
    ...(trace.baselineBpm !== undefined ? { baselineBpm: trace.baselineBpm } : {}),
    yMinBpm,
    yMaxBpm,
    samples: ordered,
    usableRuns,
    weakSamples,
    games: [],
    moves: [],
    refusal,
  };
}

function sortSamples(samples: readonly PulseSample[]): PulseSample[] {
  return [...samples].sort((left, right) => left.tUs - right.tUs);
}

function bpmDomain(
  samples: readonly PulseSample[],
  baselineBpm: number | undefined,
  thresholdBpm: number | undefined,
): { yMinBpm: number; yMaxBpm: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const sample of samples) {
    if (sample.bpm < min) min = sample.bpm;
    if (sample.bpm > max) max = sample.bpm;
  }
  if (baselineBpm !== undefined) {
    min = Math.min(min, baselineBpm);
    max = Math.max(max, baselineBpm);
  }
  if (thresholdBpm !== undefined) {
    min = Math.min(min, thresholdBpm);
    max = Math.max(max, thresholdBpm);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { yMinBpm: 50, yMaxBpm: 120 };
  const yMinBpm = Math.max(35, Math.floor((min - 8) / 5) * 5);
  const yMaxBpm = Math.min(200, Math.ceil((max + 8) / 5) * 5);
  if (yMaxBpm - yMinBpm < 20) {
    return { yMinBpm: Math.max(35, yMinBpm - 10), yMaxBpm: Math.min(200, yMaxBpm + 10) };
  }
  return { yMinBpm, yMaxBpm };
}

function nearestMoveTo(moves: readonly TimelineMove[], tUs: number): TimelineMove | null {
  let best: TimelineMove | null = null;
  let bestDist = Infinity;
  for (const move of moves) {
    if (move.tUs === null) continue;
    const dist = Math.abs(move.tUs - tUs);
    if (dist <= 2_000_000 && dist < bestDist) {
      best = move;
      bestDist = dist;
    }
  }
  return best;
}

function formatMoveReadout(move: TimelineMove): string {
  const cpl = move.cpl === null ? 'unscored' : `${Math.round(move.cpl)} cpl`;
  const think = move.thinkSec === null ? '' : `, ${formatNumber(move.thinkSec)} s think`;
  const blunder = move.blunder ? ', blunder' : '';
  return ` · ${move.san} (${cpl}${think}${blunder})`;
}

function formatSeconds(sec: number): string {
  return Number.isInteger(sec) ? `${sec} s` : `${sec.toFixed(1)} s`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
