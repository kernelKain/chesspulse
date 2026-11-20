// What: builds one report from a stored session and pasted PGNs, or refuses.
// Why: below the coverage gate the product must not print bands or a verdict.
// Removed: a thin trace would still produce a confident sentence.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { bandFor } from './analysis/bands.js';
import { alignGames } from './analysis/align.js';
import { analyseMoves, scoreMove, verdictLine, type MoveMetric } from './analysis/metrics.js';
import { parsePgnBatch } from './analysis/pgn.js';
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
  const samples = await readSamples(root, sessionId);
  const refusal = gate(meta, samples, pgns);
  if (refusal) {
    await deleteReport(root, sessionId);
    return refusal;
  }

  const parsed = parsePgnBatch(pgns);
  if (!parsed.ok) {
    await deleteReport(root, sessionId);
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
    await deleteReport(root, sessionId);
    return { ok: false, reason: 'no_trace', remedy: 'Stop the session before building a report.' };
  }
  const aligned = alignGames(parsed.games, { startAnchor: meta.startAnchor, stopAnchor: stop }, samples);
  if (!aligned.ok) {
    await deleteReport(root, sessionId);
    throw new Error(aligned.banner);
  }

  const baseline = meta.baselineBpm ?? baselineFromSamples(samples, meta.startAnchor.monoUs)?.baselineBpm;
  if (baseline === undefined) {
    await deleteReport(root, sessionId);
    throw new Error('No baseline was recorded, so bands were not computed.');
  }

  const owned = engine === undefined;
  const scorer = engine ?? createEngine();
  try {
    const moves = await scoreAlignedMoves(aligned.games, aligned.moveTimes, samples, baseline, scorer);
    const summary = analyseMoves(moves);
    const moment = elevatedMoment(samples, meta.startAnchor.monoUs, stop.monoUs, baseline);
    const verdict = verdictLine(summary, {
      elevatedMinutes: moment.minutes,
      deltaBpm: moment.deltaBpm,
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
    });
    await saveReport(root, sessionId, JSON.stringify(report, null, 2) + '\n');
    return report;
  } finally {
    if (owned) await scorer.close();
  }
}

export function formatResult(result: Report | Refusal): string {
  if (result.ok) return `${result.verdict}\n`;
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
  if (samples.length === 0 || !meta.stopAnchor) {
    return { ok: false, reason: 'no_trace', remedy: 'Stop the session before building a report.' };
  }
  if (pgns.length === 0) {
    return { ok: false, reason: 'no_games', remedy: 'Paste at least one game.' };
  }
  const coverage = coverageFromSamples(samples, meta.startAnchor.monoUs, meta.stopAnchor.monoUs);
  if (coverage.totalUs === 0) {
    return { ok: false, reason: 'no_trace', remedy: 'Stop the session before building a report.' };
  }
  if (coverage.pct < COVERAGE_GATE_PCT) {
    return {
      ok: false,
      reason: 'low_coverage',
      measured: Math.round(coverage.pct),
      threshold: COVERAGE_GATE_PCT,
      remedy: LOW_COVERAGE_REMEDY,
    };
  }
  return null;
}

async function scoreAlignedMoves(
  games: readonly { game: { index: number; moves: { san: string }[]; includeInStats: boolean } }[],
  moveTimes: readonly { gameIndex: number; moveIndex: number; tUs: number | null }[],
  samples: readonly PulseSample[],
  baseline: number,
  engine: Evaluator,
): Promise<MoveMetric[]> {
  const cache = new Map<string, Promise<PositionEval>>();
  const evaluate = (fen: string): Promise<PositionEval> => {
    const cached = cache.get(fen);
    if (cached) return cached;
    const pending = engine.evaluate(fen);
    cache.set(fen, pending);
    return pending;
  };
  const metrics: MoveMetric[] = [];
  for (const aligned of games) {
    const sans = aligned.game.moves.map((move) => move.san);
    const positions = positionsFromMoves(sans);
    for (let moveIndex = 0; moveIndex < positions.length; moveIndex += 1) {
      const position = positions[moveIndex];
      if (!position || position.illegal || !position.fenAfter) {
        metrics.push({
          cpl: null,
          accuracy: null,
          blunder: false,
          band: null,
          includeInStats: aligned.game.includeInStats,
        });
        break;
      }
      const when = moveTimes.find((time) => time.gameIndex === aligned.game.index && time.moveIndex === moveIndex);
      const before = await evaluate(position.fenBefore);
      const after = await evaluate(position.fenAfter);
      const band = when?.tUs === undefined || when.tUs === null ? null : bandAt(samples, when.tUs, baseline);
      metrics.push(scoreMove(before, after, band, aligned.game.includeInStats));
    }
  }
  return metrics;
}

function bandAt(samples: readonly PulseSample[], tUs: number, baseline: number): ReturnType<typeof bandFor> {
  let chosen: PulseSample | undefined;
  for (const sample of samples) {
    if (!isUsableSample(sample, CONFIDENCE_FLOOR)) continue;
    if (sample.tUs <= tUs && tUs <= sample.tUs + SAMPLE_HOLD_US && (!chosen || sample.tUs >= chosen.tUs)) {
      chosen = sample;
    }
  }
  if (!chosen) return null;
  return bandFor(chosen.bpm, baseline);
}

function elevatedMoment(
  samples: readonly PulseSample[],
  startUs: number,
  stopUs: number,
  baseline: number,
): { minutes: number; deltaBpm: number } {
  const ordered = samples
    .filter((sample) => sample.tUs >= startUs && sample.tUs <= stopUs)
    .sort((left, right) => left.tUs - right.tUs);
  let usableUs = 0;
  let delta = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    const sample = ordered[index];
    if (!sample || !isUsableSample(sample, CONFIDENCE_FLOOR)) continue;
    if (bandFor(sample.bpm, baseline) !== 'elevated') continue;
    const nextUs = index + 1 < ordered.length ? ordered[index + 1]?.tUs ?? stopUs : stopUs;
    const gap = nextUs - sample.tUs;
    if (gap <= 0) continue;
    usableUs += Math.min(gap, SAMPLE_HOLD_US);
    delta = Math.max(delta, sample.bpm - baseline);
  }
  return { minutes: Math.round(usableUs / 60_000_000), deltaBpm: Math.round(delta) };
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
