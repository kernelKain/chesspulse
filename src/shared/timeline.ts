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
  if (report.alignmentMode === 'marks') return 'Placed from your game-end marks';
  if (report.alignmentMode === 'none') return 'Not placed: no game-end marks';
  if (report.alignmentMode === 'endtime') return `Aligned from EndTime (±${tolerance})`;
  if (report.alignmentMode === 'starttime') return `Aligned from start time (±${tolerance})`;
  return `Inferred from paste order (±${tolerance})`;
}

export function engineCalibrationNote(engine: Report['engine']): string {
  return `Engine depth ${engine.depth}. Speed is checked on fixtures; move accuracy is not calibrated against your games.`;
}

export function refusalHeading(reason: Refusal['reason']): string {
  switch (reason) {
    case 'low_coverage':
      return 'Coverage was too low for a review.';
    case 'order':
      return 'The games are out of order.';
    case 'no_games':
      return 'No games were included in the report.';
    case 'illegal_move':
      return 'A move in the pasted games is illegal.';
    case 'cancelled':
      return 'The report build was cancelled.';
    case 'no_trace':
      return 'The session has no pulse trace.';
  }
}

export function engineFailureNote(engine: Report['engine']): string | null {
  if (engine.failed === 0) return null;
  const positions = (count: number): string => `${count} ${count === 1 ? 'position' : 'positions'}`;
  const parts: string[] = [];
  if (engine.reasons.timeout > 0) parts.push(`${positions(engine.reasons.timeout)} timed out`);
  if (engine.reasons.crash > 0) parts.push(`${positions(engine.reasons.crash)} hit a worker failure`);
  if (engine.reasons.engine > 0) parts.push(`${positions(engine.reasons.engine)} hit an engine error`);
  if (engine.reasons.budget > 0) parts.push(`${positions(engine.reasons.budget)} ran out of the time budget`);
  if (parts.length === 0) return `${positions(engine.failed)} could not be scored.`;
  if (parts.length === 1) {
    return `${parts[0]} and ${engine.failed === 1 ? 'was' : 'were'} left out.`;
  }
  return `${parts.join(', ')}; ${positions(engine.failed)} ${engine.failed === 1 ? 'was' : 'were'} left out.`;
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
    result.banner || (result.alignmentMode !== 'endtime' && result.alignmentMode !== 'marks')
      ? 'low_confidence'
      : 'aligned';

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
    const usable = sample.occluded !== true && sample.stable && sample.confidence >= CONFIDENCE_FLOOR;
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

export function sampleStatusText(sample: PulseSample, elevatedThresholdBpm: number | undefined): string {
  const usable = sample.stable && sample.confidence >= CONFIDENCE_FLOOR;
  if (!usable) return `low confidence (${sample.confidence})`;
  if (elevatedThresholdBpm === undefined) return 'raw trace, bands withheld';
  if (sample.bpm >= elevatedThresholdBpm) return 'elevated';
  return 'settled';
}

export function sampleReadout(view: TimelineViewModel, sampleIndex: number): string {
  const sample = view.samples[sampleIndex];
  if (!sample) return 'Nothing recorded yet.';

  const time = formatElapsed(sample.tUs, view.startUs);
  const bpm = formatNumber(sample.bpm);
  const bandText = sampleStatusText(
    sample,
    view.state === 'low_coverage' ? undefined : view.elevatedThresholdBpm,
  );

  const game = view.games.find((entry) => sample.tUs >= entry.startUs && sample.tUs <= entry.endUs);
  const gameText = game ? ` · Game ${game.index + 1}` : '';
  const gameMoves = game ? view.moves.filter((move) => move.gameIndex === game.index) : [];
  const nearestMove = nearestMoveTo(gameMoves, sample.tUs);
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
      cpl: !move.scored ? 'Unscored' : move.mate ? 'Mate' : `${Math.round(move.cpl ?? 0)} cp`,
      think: move.thinkSec === null ? '—' : `${formatNumber(move.thinkSec)} s`,
      note: !move.scored ? 'Unscored' : move.blunder ? 'Blunder' : move.mate ? 'Mate' : '',
    };
  });
}

export function sampleTableRows(view: TimelineViewModel): TimelineSampleRow[] {
  if (view.samples.length === 0) return [];
  return view.samples.map((sample, index) => {
    const prev = index > 0 ? view.samples[index - 1] : undefined;
    const deltaUs = prev ? sample.tUs - prev.tUs : 0;
    const gapBeforeSec = deltaUs > SAMPLE_HOLD_US ? Math.round((deltaUs / 1_000_000) * 10) / 10 : null;
    const usable = sample.occluded !== true && sample.stable && sample.confidence >= CONFIDENCE_FLOOR;
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
  const minEndGapUs = (stopUs - startUs) * 0.08;
  const ticks: number[] = [startUs];
  for (let t = startUs + stepUs; t < stopUs; t += stepUs) {
    ticks.push(t);
  }
  if (ticks[ticks.length - 1] !== stopUs) {
    if (ticks.length > 1 && stopUs - ticks[ticks.length - 1] < minEndGapUs) {
      ticks.pop();
    }
    ticks.push(stopUs);
  }
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

const BPM_AXIS_FLOOR = 35;
const BPM_AXIS_CEILING = 200;
const MIN_BPM_SPAN = 20;

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
  // The chart only draws 35–200. Padding first, then clamping, can put the floor above the ceiling
  // when every reading sits outside that window.
  let yMinBpm = Math.max(BPM_AXIS_FLOOR, Math.floor((min - 8) / 5) * 5);
  let yMaxBpm = Math.min(BPM_AXIS_CEILING, Math.ceil((max + 8) / 5) * 5);
  if (yMaxBpm - yMinBpm < MIN_BPM_SPAN) {
    yMinBpm = Math.max(BPM_AXIS_FLOOR, yMinBpm - 10);
    yMaxBpm = Math.min(BPM_AXIS_CEILING, yMaxBpm + 10);
  }
  if (yMaxBpm - yMinBpm < MIN_BPM_SPAN) {
    if (max <= BPM_AXIS_FLOOR) return { yMinBpm: BPM_AXIS_FLOOR, yMaxBpm: BPM_AXIS_FLOOR + MIN_BPM_SPAN };
    if (min >= BPM_AXIS_CEILING) return { yMinBpm: BPM_AXIS_CEILING - MIN_BPM_SPAN, yMaxBpm: BPM_AXIS_CEILING };
    yMinBpm = Math.max(BPM_AXIS_FLOOR, Math.min(yMinBpm, BPM_AXIS_CEILING - MIN_BPM_SPAN));
    yMaxBpm = yMinBpm + MIN_BPM_SPAN;
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
  const cpl = !move.scored ? 'unscored' : move.mate ? 'mate' : `${Math.round(move.cpl ?? 0)} cpl`;
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

/**
 * Spaces game-ending labels so two can never sit on top of each other. A forward pass pushes each
 * label past its predecessor; if that overflows the plot, a backward pass pulls the run indoors.
 * When the plot cannot fit the labels at the requested spacing, they are distributed evenly.
 */
export function spaceEndingLabels(
  rawPositions: readonly number[],
  min: number,
  max: number,
  minSpacing = 52,
): number[] {
  if (rawPositions.length === 0) return [];
  if (max < min) throw new Error('The label range is inverted.');
  const positions = [...rawPositions]
    .sort((left, right) => left - right)
    .map((value) => Math.min(max, Math.max(min, value)));
  const count = positions.length;
  if (count === 1) return positions;
  if (max - min < minSpacing * (count - 1)) {
    return positions.map((_value, index) => min + ((max - min) * index) / (count - 1));
  }
  const spaced = [...positions];
  for (let index = 1; index < count; index += 1) {
    spaced[index] = Math.max(spaced[index], spaced[index - 1] + minSpacing);
  }
  if (spaced[count - 1] > max) {
    spaced[count - 1] = max;
    for (let index = count - 2; index >= 0; index -= 1) {
      spaced[index] = Math.min(spaced[index], spaced[index + 1] - minSpacing);
    }
  }
  return spaced;
}

/**
 * What: round pulse ticks inside the drawn range, every 10 bpm (every 20 above an 80 bpm span).
 * Why: three ticks at the raw min/mid/max read as noise (for example 77, 96, 115); round values
 *      let the eye place a reading without the inspector.
 */
export function bpmTicks(minBpm: number, maxBpm: number): number[] {
  if (!(maxBpm > minBpm)) return [minBpm];
  const step = maxBpm - minBpm > 80 ? 20 : 10;
  const ticks: number[] = [];
  for (let value = Math.ceil(minBpm / step) * step; value <= maxBpm; value += step) ticks.push(value);
  return ticks;
}

/**
 * What: two label positions on one axis, pushed apart to at least `minGap`, kept inside [min, max].
 * Why: the baseline and elevated-threshold labels sit 10 bpm apart and overlapped on a wide range.
 */
export function separatePair(first: number, second: number, minGap: number, min: number, max: number): [number, number] {
  let a = first;
  let b = second;
  const upper = a <= b;
  let low = upper ? a : b;
  let high = upper ? b : a;
  if (high - low < minGap) {
    const middle = (low + high) / 2;
    low = middle - minGap / 2;
    high = middle + minGap / 2;
  }
  if (low < min) {
    high += min - low;
    low = min;
  }
  if (high > max) {
    low -= high - max;
    high = max;
  }
  [a, b] = upper ? [low, high] : [high, low];
  return [a, b];
}

export type MomentRange = 'settled' | 'elevated' | 'withheld' | 'not_counted';

export interface MomentMove {
  /** "14. Nf3" for White, "14… Nf6" for Black. */
  readonly label: string;
  readonly loss: 'scored' | 'mate' | 'unscored';
  readonly cpl: number | null;
  readonly thinkSec: number | null;
  readonly blunder: boolean;
}

export interface MomentDetails {
  readonly position: number;
  readonly total: number;
  readonly time: string;
  readonly bpm: string;
  readonly range: MomentRange;
  readonly confidence: number;
  readonly counted: boolean;
  readonly game: { readonly number: number; readonly players: string } | null;
  readonly move: MomentMove | null;
}

/**
 * What: the labelled facts for one selected reading, for the inspector beside the chart.
 * Why: the old readout ran them into one line ("Sample 15/1791 · 0:27 · 92.2 bpm · …") that a
 *      reader could not parse. Each value is read from the view; nothing new is computed.
 */
export function momentDetails(view: TimelineViewModel, sampleIndex: number): MomentDetails | null {
  const sample = view.samples[sampleIndex];
  if (!sample) return null;
  const counted = sample.occluded !== true && sample.stable && sample.confidence >= CONFIDENCE_FLOOR;
  const withheld = view.state === 'low_coverage' || view.elevatedThresholdBpm === undefined;
  const range: MomentRange = !counted
    ? 'not_counted'
    : withheld
      ? 'withheld'
      : sample.bpm >= (view.elevatedThresholdBpm ?? Infinity)
        ? 'elevated'
        : 'settled';
  const game = view.games.find((entry) => sample.tUs >= entry.startUs && sample.tUs <= entry.endUs);
  const nearest = game ? nearestMoveTo(view.moves.filter((move) => move.gameIndex === game.index), sample.tUs) : null;
  return {
    position: sampleIndex + 1,
    total: view.samples.length,
    time: formatElapsed(sample.tUs, view.startUs),
    bpm: `${formatNumber(sample.bpm)} bpm`,
    range,
    // The SDK reports confidence with float noise (99.8483…); a whole number is what a reader can use.
    confidence: Math.round(sample.confidence),
    counted,
    game: game
      ? {
          number: game.index + 1,
          players: game.white || game.black ? `${game.white || 'Unknown'} vs ${game.black || 'Unknown'}` : 'Players unnamed',
        }
      : null,
    move: nearest
      ? {
          label: moveLabel(nearest.moveIndex, nearest.san),
          loss: !nearest.scored ? 'unscored' : nearest.mate ? 'mate' : 'scored',
          cpl: nearest.scored && !nearest.mate && nearest.cpl !== null ? Math.round(nearest.cpl) : null,
          thinkSec: nearest.thinkSec,
          blunder: nearest.blunder,
        }
      : null,
  };
}

/** Ply index to the move number a chess player reads: 0 → "1. e4", 1 → "1… e5". */
export function moveLabel(moveIndex: number, san: string): string {
  const number = Math.floor(moveIndex / 2) + 1;
  return moveIndex % 2 === 0 ? `${number}. ${san}` : `${number}… ${san}`;
}
