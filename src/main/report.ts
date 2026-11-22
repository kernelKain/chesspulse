// What: builds one report from a stored session and pasted PGNs, or refuses.
// Why: below the coverage gate the product must not print bands or a verdict.
// Removed: a thin trace would still produce a confident sentence.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { bandFor, ELEVATED_MARGIN_BPM } from './analysis/bands.js';
import { alignGames, buildMoveTimeIndex, moveTimeKey } from './analysis/align.js';
import { analyseMoves, scoreMove, verdictLine, type MoveMetric, type Score } from './analysis/metrics.js';
import { parsePgnBatch, thinkTimeSec } from './analysis/pgn.js';
import { firstIllegalMove, illegalMoveMessage, positionsFromMoves, type MovePosition } from './analysis/positions.js';
import { createEngine, ENGINE_DEPTH, type PositionEval } from './engine.js';
import { baselineFromSamples, coverageFromSamples, isUsableSample } from './session.js';
import { defaultDataRoot, digestGames, readMeta, readSamples, saveReportArtifacts } from './store.js';
import {
  reportSchema,
  type PulseSample,
  type Refusal,
  type Report,
  type SessionMeta,
  type TimelineMove,
} from '../shared/contracts.js';
import { CONFIDENCE_FLOOR, SAMPLE_HOLD_US } from '../shared/sensing.js';

export const COVERAGE_GATE_PCT = 70;
const LOW_COVERAGE_REMEDY =
  'Most often this is lighting or moving out of frame. Sit facing the screen with a lamp in front of you, and keep the session shorter next time.';

interface Evaluator {
  evaluate(fen: string): Promise<PositionEval>;
  close(): Promise<void>;
  /** Optional for injected test evaluators; production createEngine always supplies it. */
  depth?: number;
}

export interface ReportBuildControl {
  /** Aborts the in-flight engine search; no artifact is written after cancellation. */
  signal?: AbortSignal;
  onProgress?: (progress: { scored: number; total: number }) => void;
  /** Marks the point where cancellation is no longer accepted because the commit has begun. */
  onCommitStart?: () => void;
}

interface EngineStats {
  depth: number;
  positions: number;
  scored: number;
  failed: number;
  reasons: {
    timeout: number;
    crash: number;
    engine: number;
    budget: number;
  };
}

type ScoreOutcome =
  | { cancelled: true }
  | {
      cancelled: false;
      metrics: MoveMetric[];
      elevatedBlunderTimes: (number | null)[];
      timelineMoves: TimelineMove[];
      engine: EngineStats;
    };

const CANCELLED_REFUSAL: Refusal = {
  ok: false,
  reason: 'cancelled',
  remedy: 'Report build cancelled. No report was saved.',
};

export async function buildReport(
  root: string,
  sessionId: string,
  pgns: readonly string[],
  engine?: Evaluator,
  control: ReportBuildControl = {},
): Promise<Report | Refusal> {
  if (control.signal?.aborted) return CANCELLED_REFUSAL;
  // The caller owns this array; scoring awaits the engine, so every later read uses one snapshot.
  const pgnBatch = [...pgns];
  const meta = await readMeta(root, sessionId);
  const samples = await readSamples(root, sessionId);
  const refusal = gate(meta, samples, pgnBatch);
  if (refusal) return refusal;

  const parsed = parsePgnBatch(pgnBatch);
  if (!parsed.ok) {
    if (parsed.reason === 'order') {
      return { ok: false, reason: 'order', remedy: parsed.remedy };
    }
    if (parsed.reason === 'no_games') {
      return { ok: false, reason: 'no_games', remedy: parsed.remedy };
    }
    throw new Error(parsed.message);
  }

  for (const game of parsed.games) {
    const illegal = firstIllegalMove(game.moves.map((move) => move.san));
    if (illegal) {
      return { ok: false, reason: 'illegal_move', remedy: illegalMoveMessage(game.index + 1, illegal) };
    }
  }

  const stop = meta.stopAnchor;
  if (!stop) {
    return { ok: false, reason: 'no_trace', remedy: 'Stop the session before building a report.' };
  }
  const aligned = alignGames(parsed.games, { startAnchor: meta.startAnchor, stopAnchor: stop }, samples);
  if (!aligned.ok) throw new Error(aligned.banner);

  const baseline = meta.baselineBpm ?? baselineFromSamples(samples, meta.startAnchor.monoUs)?.baselineBpm;
  if (baseline === undefined) throw new Error('No baseline was recorded, so bands were not computed.');

  const owned = engine === undefined;
  const scorer = engine ?? createEngine({ signal: control.signal });
  try {
    const scoredMoves = await scoreAlignedMoves(
      aligned.games,
      aligned.moveTimes,
      samples,
      baseline,
      scorer,
      control,
    );
    if (scoredMoves.cancelled) return CANCELLED_REFUSAL;
    const summary = analyseMoves(scoredMoves.metrics);
    const claim = elevatedClaim(
      samples,
      meta.startAnchor.monoUs,
      stop.monoUs,
      baseline,
      scoredMoves.elevatedBlunderTimes,
    );
    const verdict = verdictLine(summary, {
      elevatedMinutes: claim?.elevatedMinutes,
      deltaBpm: claim?.deltaBpm,
      gapClause: gapClause(aligned.gaps),
    });
    const coverage = coverageFromSamples(samples, meta.startAnchor.monoUs, stop.monoUs);
    const first = aligned.games[0];
    const alignedIndices = new Set(aligned.games.map((entry) => entry.game.index));
    const blundersByGame = new Map<number, number>();
    for (const move of scoredMoves.timelineMoves) {
      if (move.blunder) blundersByGame.set(move.gameIndex, (blundersByGame.get(move.gameIndex) ?? 0) + 1);
    }
    const report = reportSchema.parse({
      ok: true,
      sessionId,
      gamesDigest: digestGames(pgnBatch),
      coveragePct: coverage.pct,
      baselineBpm: baseline,
      verdict,
      settled: summary.settled,
      elevated: summary.elevated,
      engine: scoredMoves.engine,
      alignmentMode: first?.alignment.mode ?? 'inferred',
      toleranceSec: first?.alignment.toleranceSec ?? 0,
      ...(aligned.banner ? { banner: aligned.banner } : {}),
      games: parsed.games.map((game) => ({
        index: game.index,
        white: game.white,
        black: game.black,
        result: game.result,
        ending: game.ending,
        includeInStats: game.includeInStats,
        moveCount: game.moves.length,
        blunders: blundersByGame.get(game.index) ?? 0,
        aligned: alignedIndices.has(game.index),
        ...(game.timeControl !== undefined ? { timeControl: game.timeControl } : {}),
      })),
      timeline: {
        startUs: meta.startAnchor.monoUs,
        stopUs: stop.monoUs,
        baselineBpm: baseline,
        elevatedThresholdBpm: baseline + ELEVATED_MARGIN_BPM,
        samples: samples.filter(
          (sample) => sample.tUs >= meta.startAnchor.monoUs && sample.tUs <= stop.monoUs,
        ),
        games: aligned.games.map((entry) => ({
          index: entry.game.index,
          white: entry.game.white,
          black: entry.game.black,
          result: entry.game.result,
          ending: entry.game.ending,
          includeInStats: entry.game.includeInStats,
          startUs: entry.startUs,
          endUs: entry.endUs,
        })),
        moves: scoredMoves.timelineMoves,
      },
    });
    if (control.signal?.aborted) return CANCELLED_REFUSAL;
    control.onCommitStart?.();
    if (control.signal?.aborted) return CANCELLED_REFUSAL;
    await saveReportArtifacts(root, sessionId, JSON.stringify(report, null, 2) + '\n', pgnBatch);
    return report;
  } finally {
    if (owned) await scorer.close();
  }
}

export function formatResult(result: Report | Refusal): string {
  if (result.ok) {
    return result.banner ? `${result.verdict}\n${result.banner}\n` : `${result.verdict}\n`;
  }
  if (result.reason === 'low_coverage') {
    return `No report for this session.\nCoverage was ${result.measured}%; a review needs ${result.threshold}%.\n${result.remedy}\n`;
  }
  return `${result.remedy}\n`;
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = argv.slice(2);
  let root = defaultRoot();
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--root') {
      const value = args[index + 1];
      if (!value) throw new Error('Pass a directory after --root.');
      root = value;
      index += 1;
      continue;
    }
    positionals.push(arg ?? '');
  }
  const sessionId = positionals[0];
  const files = positionals.slice(1);
  if (!sessionId || files.length === 0) {
    throw new Error('Usage: node dist-electron/main/report.js --root <dir> <sessionId> <pgn> [pgn...]');
  }
  const pgns = await Promise.all(files.map((file) => readFile(file, 'utf8')));
  const result = await buildReport(root, sessionId, pgns);
  process.stdout.write(formatResult(result));
  return 0;
}

function defaultRoot(): string {
  return defaultDataRoot();
}

function gate(meta: SessionMeta, samples: readonly PulseSample[], pgns: readonly string[]): Refusal | null {
  const stopAnchor = meta.stopAnchor;
  if (samples.length === 0 || !stopAnchor) {
    return { ok: false, reason: 'no_trace', remedy: 'Stop the session before building a report.' };
  }
  if (pgns.length === 0) {
    return { ok: false, reason: 'no_games', remedy: 'Paste at least one game.' };
  }
  const coverage = coverageFromSamples(samples, meta.startAnchor.monoUs, stopAnchor.monoUs);
  if (coverage.totalUs === 0) {
    return { ok: false, reason: 'no_trace', remedy: 'Stop the session before building a report.' };
  }
  if (coverage.pct < COVERAGE_GATE_PCT) {
    const baseline = meta.baselineBpm ?? baselineFromSamples(samples, meta.startAnchor.monoUs)?.baselineBpm;
    return {
      ok: false,
      reason: 'low_coverage',
      measured: Math.floor(coverage.pct),
      threshold: COVERAGE_GATE_PCT,
      remedy: LOW_COVERAGE_REMEDY,
      trace: {
        startUs: meta.startAnchor.monoUs,
        stopUs: stopAnchor.monoUs,
        ...(baseline !== undefined ? { baselineBpm: baseline } : {}),
        samples: samples.filter(
          (sample) => sample.tUs >= meta.startAnchor.monoUs && sample.tUs <= stopAnchor.monoUs,
        ),
      },
    };
  }
  return null;
}

async function scoreAlignedMoves(
  games: readonly {
    game: {
      index: number;
      moves: { san: string; clockSec?: number }[];
      timeControl?: string;
      includeInStats: boolean;
    };
  }[],
  moveTimes: readonly { gameIndex: number; moveIndex: number; tUs: number | null }[],
  samples: readonly PulseSample[],
  baseline: number,
  engine: Evaluator,
  control: ReportBuildControl,
): Promise<ScoreOutcome> {
  const planned = games
    .filter((entry) => entry.game.includeInStats)
    .map((entry) => {
      const sans = entry.game.moves.map((move) => move.san);
      return {
        aligned: entry,
        sans,
        thinks: thinkTimeSec(entry.game),
        positions: positionsFromMoves(sans),
      };
    });

  const total = countPositions(planned);
  const cache = new Map<string, Promise<PositionEval>>();
  const moveTimeIndex = buildMoveTimeIndex(moveTimes);
  const bandLookup = createBandLookup(samples, baseline);
  const counted = new Set<string>();
  const reasons = { timeout: 0, crash: 0, engine: 0, budget: 0 };
  let scoredPositions = 0;

  const evaluate = (fen: string): Promise<PositionEval> => {
    const cached = cache.get(fen);
    if (cached) return cached;
    const pending = engine.evaluate(fen).then((result) => {
      if (!counted.has(fen)) {
        counted.add(fen);
        if (result.evalFailed) {
          if (result.reason === 'timeout') reasons.timeout += 1;
          else if (result.reason === 'crash') reasons.crash += 1;
          else if (result.reason === 'budget') reasons.budget += 1;
          else reasons.engine += 1;
        } else {
          scoredPositions += 1;
        }
        control.onProgress?.({ scored: scoredPositions, total });
      }
      return result;
    });
    cache.set(fen, pending);
    return pending;
  };

  control.onProgress?.({ scored: 0, total });

  const metrics: MoveMetric[] = [];
  const elevatedBlunderTimes: (number | null)[] = [];
  const timelineMoves: TimelineMove[] = [];

  for (const { aligned, sans, thinks, positions } of planned) {
    for (let moveIndex = 0; moveIndex < sans.length; moveIndex += 1) {
      const position = positions[moveIndex];
      if (!position || position.illegal || !position.fenAfter) {
        // buildReport rejects an illegal batch before scoring; reaching here is an internal invariant break.
        const illegal = firstIllegalMove(sans);
        throw new Error(
          illegal
            ? illegalMoveMessage(aligned.game.index + 1, illegal)
            : `Game ${aligned.game.index + 1} could not be replayed, so it was not scored.`,
        );
      }
      if (control.signal?.aborted) return { cancelled: true };
      const when = moveTimeIndex.get(moveTimeKey(aligned.game.index, moveIndex));
      const before = await evaluate(position.fenBefore);
      if (before.reason === 'cancelled' || control.signal?.aborted) return { cancelled: true };

      let after: Score;
      if (position.terminalAfter) {
        // A terminal after-position is scored locally; sending checkmate or stalemate to Stockfish is wasted work.
        after = { evalFailed: false, terminal: position.terminalAfter };
      } else {
        const evaluated = await evaluate(position.fenAfter);
        if (evaluated.reason === 'cancelled' || control.signal?.aborted) return { cancelled: true };
        after = evaluated;
      }

      const band = when?.tUs === undefined || when.tUs === null ? null : bandLookup(when.tUs);
      const metric = scoreMove(before, after, band, aligned.game.includeInStats);
      if (metric.blunder && metric.band === 'elevated') elevatedBlunderTimes.push(when?.tUs ?? null);
      metrics.push(metric);
      const rawThink = thinks[moveIndex] ?? null;
      timelineMoves.push({
        gameIndex: aligned.game.index,
        moveIndex,
        san: sans[moveIndex] ?? '',
        tUs: when?.tUs ?? null,
        cpl: metric.cpl,
        thinkSec: rawThink !== null && rawThink >= 0 ? rawThink : null,
        blunder: metric.blunder,
        mate: metric.mate,
        band: metric.band,
      });
    }
  }

  const failed = reasons.timeout + reasons.crash + reasons.engine + reasons.budget;
  return {
    cancelled: false,
    metrics,
    elevatedBlunderTimes,
    timelineMoves,
    engine: { depth: engine.depth ?? ENGINE_DEPTH, positions: total, scored: scoredPositions, failed, reasons },
  };
}

function countPositions(planned: readonly { positions: readonly MovePosition[] }[]): number {
  const fens = new Set<string>();
  for (const { positions } of planned) {
    for (const position of positions) {
      if (!position || position.illegal || !position.fenAfter) continue;
      fens.add(position.fenBefore);
      if (!position.terminalAfter) fens.add(position.fenAfter);
    }
  }
  return fens.size;
}

export function createBandLookup(
  samples: readonly PulseSample[],
  baseline: number,
): (tUs: number) => ReturnType<typeof bandFor> {
  const ordered = [...samples].sort((left, right) => left.tUs - right.tUs);
  return (tUs: number) => {
    let low = 0;
    let high = ordered.length - 1;
    let latest: PulseSample | undefined;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const candidate = ordered[middle];
      if (!candidate) break;
      if (candidate.tUs <= tUs) {
        latest = candidate;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (!latest || !isUsableSample(latest, CONFIDENCE_FLOOR)) return null;
    if (tUs > latest.tUs + SAMPLE_HOLD_US) return null;
    return bandFor(latest.bpm, baseline);
  };
}

export function elevatedClaim(
  samples: readonly PulseSample[],
  startUs: number,
  stopUs: number,
  baseline: number,
  blunderTimes: readonly (number | null)[],
): { elevatedMinutes: number; deltaBpm: number } | undefined {
  if (blunderTimes.length === 0 || blunderTimes.some((time) => time === null)) return undefined;
  const periods = elevatedPeriods(samples, startUs, stopUs, baseline);
  const hit = new Set<number>();
  for (const time of blunderTimes) {
    const index = periods.findIndex((period) => (time ?? -1) >= period.fromUs && (time ?? -1) <= period.toUs);
    if (index < 0) return undefined;
    hit.add(index);
    if (hit.size > 1) return undefined;
  }
  const period = periods[[...hit][0] ?? -1];
  if (!period) return undefined;
  return {
    elevatedMinutes: (period.toUs - period.fromUs) / 60_000_000,
    deltaBpm: Math.round(period.deltaBpm),
  };
}

function elevatedPeriods(
  samples: readonly PulseSample[],
  startUs: number,
  stopUs: number,
  baseline: number,
): { fromUs: number; toUs: number; deltaBpm: number }[] {
  const ordered = samples
    .filter((sample) => sample.tUs >= startUs && sample.tUs <= stopUs)
    .sort((left, right) => left.tUs - right.tUs);
  const periods: { fromUs: number; toUs: number; deltaBpm: number }[] = [];
  let current: { fromUs: number; toUs: number; deltaBpm: number } | undefined;
  for (let index = 0; index < ordered.length; index += 1) {
    const sample = ordered[index];
    if (!sample || !isUsableSample(sample, CONFIDENCE_FLOOR) || bandFor(sample.bpm, baseline) !== 'elevated') {
      current = undefined;
      continue;
    }
    const nextUs = index + 1 < ordered.length ? ordered[index + 1]?.tUs ?? stopUs : stopUs;
    const gap = nextUs - sample.tUs;
    const end = sample.tUs + (gap > 0 ? Math.min(gap, SAMPLE_HOLD_US) : 0);
    if (!current) {
      current = { fromUs: sample.tUs, toUs: end, deltaBpm: sample.bpm - baseline };
      periods.push(current);
    } else {
      current.toUs = end;
      current.deltaBpm = Math.max(current.deltaBpm, sample.bpm - baseline);
    }
    const next = ordered[index + 1];
    const continues =
      next !== undefined &&
      gap > 0 &&
      gap <= SAMPLE_HOLD_US &&
      isUsableSample(next, CONFIDENCE_FLOOR) &&
      bandFor(next.bpm, baseline) === 'elevated';
    if (!continues) current = undefined;
  }
  return periods;
}

function gapClause(gaps: readonly { afterIndex: number; beforeIndex: number; durationUs: number }[]): string | undefined {
  const gap = gaps.reduce<(typeof gaps)[number] | undefined>((best, current) => {
    if (!best || current.durationUs > best.durationUs) return current;
    return best;
  }, undefined);
  if (!gap) return undefined;
  const minutes = Math.round(gap.durationUs / 60_000_000);
  const seconds = Math.max(1, Math.round(gap.durationUs / 1_000_000));
  const waited =
    minutes >= 1
      ? `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
      : `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
  return `Between games ${gap.afterIndex + 1} and ${gap.beforeIndex + 1} you waited ${waited}.`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main(process.argv).then(
    (code) => process.exit(code),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : 'The report could not be built.';
      process.stderr.write(`${message}\n`);
      process.exit(1);
    },
  );
}
