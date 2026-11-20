// What: builds one report from a stored session and pasted PGNs, or refuses.
// Why: below the coverage gate the product must not print bands or a verdict.
// Removed: a thin trace would still produce a confident sentence.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { bandFor, ELEVATED_MARGIN_BPM } from './analysis/bands.js';
import { alignGames } from './analysis/align.js';
import { analyseMoves, scoreMove, verdictLine, type MoveMetric } from './analysis/metrics.js';
import { parsePgnBatch, thinkTimeSec } from './analysis/pgn.js';
import { positionsFromMoves } from './analysis/positions.js';
import { createEngine, type PositionEval } from './engine.js';
import { baselineFromSamples, coverageFromSamples, isUsableSample } from './session.js';
import { defaultDataRoot, deleteReport, readMeta, readSamples, saveReport } from './store.js';
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
}

export async function buildReport(
  root: string,
  sessionId: string,
  pgns: readonly string[],
  engine?: Evaluator,
): Promise<Report | Refusal> {
  const meta = await readMeta(root, sessionId);
  await deleteReport(root, sessionId);
  const samples = await readSamples(root, sessionId);
  const refusal = gate(meta, samples, pgns);
  if (refusal) return refusal;

  const parsed = parsePgnBatch(pgns);
  if (!parsed.ok) {
    if (parsed.reason === 'order') {
      return { ok: false, reason: 'order', remedy: parsed.remedy };
    }
    if (parsed.reason === 'no_games') {
      return { ok: false, reason: 'no_games', remedy: parsed.remedy };
    }
    throw new Error(parsed.message);
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
  const scorer = engine ?? createEngine();
  try {
    const scoredMoves = await scoreAlignedMoves(aligned.games, aligned.moveTimes, samples, baseline, scorer);
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
    const report = reportSchema.parse({
      ok: true,
      sessionId,
      coveragePct: coverage.pct,
      baselineBpm: baseline,
      verdict,
      settled: summary.settled,
      elevated: summary.elevated,
      alignmentMode: first?.alignment.mode ?? 'inferred',
      toleranceSec: first?.alignment.toleranceSec ?? 0,
      ...(aligned.banner ? { banner: aligned.banner } : {}),
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
    await saveReport(root, sessionId, JSON.stringify(report, null, 2) + '\n');
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
): Promise<{
  metrics: MoveMetric[];
  elevatedBlunderTimes: (number | null)[];
  timelineMoves: TimelineMove[];
}> {
  const cache = new Map<string, Promise<PositionEval>>();
  const evaluate = (fen: string): Promise<PositionEval> => {
    const cached = cache.get(fen);
    if (cached) return cached;
    const pending = engine.evaluate(fen);
    cache.set(fen, pending);
    return pending;
  };
  const metrics: MoveMetric[] = [];
  const elevatedBlunderTimes: (number | null)[] = [];
  const timelineMoves: TimelineMove[] = [];
  for (const aligned of games) {
    if (!aligned.game.includeInStats) continue;
    const sans = aligned.game.moves.map((move) => move.san);
    const thinks = thinkTimeSec(aligned.game);
    const positions = positionsFromMoves(sans);
    for (let moveIndex = 0; moveIndex < sans.length; moveIndex += 1) {
      const position = positions[moveIndex];
      if (!position || position.illegal || !position.fenAfter) {
        for (let rest = moveIndex; rest < sans.length; rest += 1) {
          const when = moveTimes.find((time) => time.gameIndex === aligned.game.index && time.moveIndex === rest);
          const rawThink = thinks[rest] ?? null;
          metrics.push({
            cpl: null,
            accuracy: null,
            blunder: false,
            band: null,
            includeInStats: true,
          });
          timelineMoves.push({
            gameIndex: aligned.game.index,
            moveIndex: rest,
            san: sans[rest] ?? '',
            tUs: when?.tUs ?? null,
            cpl: null,
            thinkSec: rawThink !== null && rawThink >= 0 ? rawThink : null,
            blunder: false,
            band: null,
          });
        }
        break;
      }
      const when = moveTimes.find((time) => time.gameIndex === aligned.game.index && time.moveIndex === moveIndex);
      const before = await evaluate(position.fenBefore);
      const after = await evaluate(position.fenAfter);
      const band = when?.tUs === undefined || when.tUs === null ? null : bandAt(samples, when.tUs, baseline);
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
        band: metric.band,
      });
    }
  }
  return { metrics, elevatedBlunderTimes, timelineMoves };
}

export function bandAt(samples: readonly PulseSample[], tUs: number, baseline: number): ReturnType<typeof bandFor> {
  let latest: PulseSample | undefined;
  for (const sample of samples) {
    if (sample.tUs <= tUs && (!latest || sample.tUs >= latest.tUs)) latest = sample;
  }
  if (!latest || !isUsableSample(latest, CONFIDENCE_FLOOR)) return null;
  if (tUs > latest.tUs + SAMPLE_HOLD_US) return null;
  return bandFor(latest.bpm, baseline);
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
  const waited = minutes >= 1 ? `${minutes} minutes` : `${Math.max(1, Math.round(gap.durationUs / 1_000_000))} seconds`;
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
