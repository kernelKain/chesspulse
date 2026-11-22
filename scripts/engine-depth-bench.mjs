#!/usr/bin/env node
// What: scores every fixture position at depths 6, 8, and 12 and reports timing and blunder-flag drift.
// Why: S36's raise-to-12 rule is fixed before the run, so the depth decision is measured, not an opinion.
// Removed: a depth change would be judged by feel, and fixture speed would be confused with accuracy.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createEngine, ENGINE_DEPTH } = require('../dist-electron/main/engine.js');
const { parsePgn } = require('../dist-electron/main/analysis/pgn.js');
const { positionsFromMoves } = require('../dist-electron/main/analysis/positions.js');
const { scoreMove } = require('../dist-electron/main/analysis/metrics.js');

const DEPTHS = [6, 8, 12];
const BASELINE_DEPTH = 8;
const CANDIDATE_DEPTH = 12;
/** Decided before the run: only raise to 12 when both limits hold. */
const RULE_MAX_MEAN_MS = 400;
const RULE_MAX_CHANGE_PCT = 5;
const FIXTURE_DIR = path.join(process.cwd(), 'tests/fixtures/pgn');

async function main() {
  const files = (await readdir(FIXTURE_DIR))
    .filter((name) => name.endsWith('.pgn'))
    .sort();
  const games = [];
  for (const [index, name] of files.entries()) {
    const text = await readFile(path.join(FIXTURE_DIR, name), 'utf8');
    const parsed = parsePgn(text, index);
    if (!parsed.ok) throw new Error(`${name}: ${parsed.message}`);
    games.push(parsed.game);
  }

  const { fens, moves, plies } = collectPositions(games);
  if (fens.length === 0) throw new Error('No fixture positions were found.');

  const measured = [];
  for (const depth of DEPTHS) {
    const result = await measure(fens, depth);
    measured.push({ depth, ...result, flags: blunderFlags(moves, result.results) });
  }

  const byDepth = new Map(measured.map((entry) => [entry.depth, entry]));
  const baseline = byDepth.get(BASELINE_DEPTH);
  const candidate = byDepth.get(CANDIDATE_DEPTH);
  if (!baseline || !candidate) throw new Error('Depths 8 and 12 are required.');

  const eightToTwelve = changes(baseline.flags, candidate.flags);
  const sixToEight = changes(byDepth.get(6)?.flags ?? [], baseline.flags);
  const failures = measured.reduce((total, entry) => total + entry.failures, 0);
  const passes =
    failures === 0 &&
    candidate.meanMs <= RULE_MAX_MEAN_MS &&
    eightToTwelve.pct <= RULE_MAX_CHANGE_PCT;

  console.log('Fixture engine-depth benchmark (S36)');
  console.log(
    `Fixtures: ${files.length} files, ${games.length} games, ${plies} plies, ${fens.length} unique positions`,
  );
  console.log('');
  console.log('depth  warm-up  mean ms   p95 ms   total s   failed');
  for (const entry of measured) {
    const warmup = entry.warmupFailed ? `failed:${entry.warmupReason ?? 'unknown'}` : 'ok';
    console.log(
      `${String(entry.depth).padEnd(6)} ${warmup.padEnd(8)} ${entry.meanMs.toFixed(1).padStart(7)} ${entry.p95Ms
        .toFixed(1)
        .padStart(8)} ${(entry.totalMs / 1000).toFixed(2).padStart(8)} ${String(entry.failures).padStart(8)}`,
    );
  }
  console.log('');
  console.log(`Blunder flags changing, 6 → 8:  ${formatChange(sixToEight)}`);
  console.log(`Blunder flags changing, 8 → 12: ${formatChange(eightToTwelve)}`);
  console.log('');
  console.log(
    `Rule: raise ${BASELINE_DEPTH} → ${CANDIDATE_DEPTH} only if depth-${CANDIDATE_DEPTH} mean ≤ ${RULE_MAX_MEAN_MS} ms and ${BASELINE_DEPTH} → ${CANDIDATE_DEPTH} changes ≤ ${RULE_MAX_CHANGE_PCT}%.`,
  );
  console.log(`Current ENGINE_DEPTH: ${ENGINE_DEPTH}`);
  if (failures > 0) {
    console.log(`Decision: INCONCLUSIVE (${failures} timed evaluations failed).`);
  } else if (candidate.warmupFailed) {
    console.log(
      `Decision: INCONCLUSIVE (depth-${CANDIDATE_DEPTH} warm-up failed: ${candidate.warmupReason ?? 'unknown'}).`,
    );
  } else if (passes) {
    console.log(`Decision: ${ENGINE_DEPTH === CANDIDATE_DEPTH ? `KEEP ${CANDIDATE_DEPTH}` : `RAISE TO ${CANDIDATE_DEPTH}`}`);
  } else {
    console.log(`Decision: ${ENGINE_DEPTH === CANDIDATE_DEPTH ? `REVERT TO ${BASELINE_DEPTH}` : `KEEP ${BASELINE_DEPTH}`}`);
  }
  console.log('Limit: fixtures measure speed and stability, not accuracy. Real-game accuracy calibration stays open.');
}

function collectPositions(games) {
  const fens = new Set();
  const moves = [];
  let plies = 0;
  for (const game of games) {
    const sans = game.moves.map((move) => move.san);
    const positions = positionsFromMoves(sans);
    for (let moveIndex = 0; moveIndex < sans.length; moveIndex += 1) {
      const position = positions[moveIndex];
      if (!position || position.illegal || !position.fenAfter) {
        throw new Error(`Game ${game.index + 1}, move ${moveIndex + 1} is illegal in the fixtures.`);
      }
      plies += 1;
      fens.add(position.fenBefore);
      if (!position.terminalAfter) fens.add(position.fenAfter);
      moves.push({
        before: position.fenBefore,
        after: position.fenAfter,
        terminal: position.terminalAfter,
      });
    }
  }
  return { fens: [...fens], moves, plies };
}

async function measure(fens, depth) {
  const engine = createEngine({ depth });
  const results = new Map();
  const times = [];
  let failures = 0;
  let warmupFailed = false;
  let warmupReason;
  try {
    // The warm-up pays for worker startup and the UCI handshake; it is deliberately not timed.
    const warmup = await engine.evaluate(fens[0]);
    warmupFailed = warmup.evalFailed;
    warmupReason = warmup.reason;
    for (const fen of fens) {
      const started = process.hrtime.bigint();
      const result = await engine.evaluate(fen);
      times.push(Number(process.hrtime.bigint() - started) / 1e6);
      results.set(fen, result);
      if (result.evalFailed) failures += 1;
    }
  } finally {
    await engine.close();
  }
  const totalMs = times.reduce((total, value) => total + value, 0);
  return {
    results,
    failures,
    warmupFailed,
    warmupReason,
    totalMs,
    meanMs: times.length === 0 ? 0 : totalMs / times.length,
    p95Ms: percentile(times, 0.95),
  };
}

function blunderFlags(moves, results) {
  return moves.map((move) => {
    const before = results.get(move.before);
    const after = move.terminal
      ? { evalFailed: false, terminal: move.terminal }
      : results.get(move.after);
    if (!before || !after) throw new Error('A fixture position was not evaluated.');
    return scoreMove(before, after, null, true).blunder;
  });
}

function changes(left, right) {
  let changed = 0;
  const total = Math.min(left.length, right.length);
  for (let index = 0; index < total; index += 1) {
    if (left[index] !== right[index]) changed += 1;
  }
  return { changed, total, pct: total === 0 ? 0 : (changed / total) * 100 };
}

function formatChange(entry) {
  return `${entry.changed}/${entry.total} (${entry.pct.toFixed(1)}%)`;
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(ordered.length - 1, Math.max(0, Math.ceil(fraction * ordered.length) - 1));
  return ordered[index] ?? 0;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
