import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import type { PulseSample } from '../shared/contracts.js';
import { SAMPLE_HOLD_US } from '../shared/sensing.js';
import { bandAt, buildReport, COVERAGE_GATE_PCT, elevatedClaim, formatResult } from './report.js';
import { ingestSamples, startSession, stopSession } from './session.js';

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function useRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'chesspulse-report-'));
  roots.push(root);
  return root;
}

const EPOCH = 1_700_000_000_000;

function sample(tUs: number, bpm = 70): PulseSample {
  return { tUs, bpm, confidence: 80, stable: true };
}

async function session(root: string, samples: PulseSample[], stopUs: number): Promise<string> {
  const started = await startSession(root, { monoUs: 0, epochMs: EPOCH }, '60');
  await ingestSamples(root, samples);
  await stopSession(root, { monoUs: stopUs, epochMs: EPOCH + stopUs / 1000 }, 'user');
  return started.id;
}

function pgnAt(endEpochMs: number): string {
  const end = new Date(endEpochMs);
  const pad = (value: number) => String(value).padStart(2, '0');
  const date = `${end.getUTCFullYear()}.${pad(end.getUTCMonth() + 1)}.${pad(end.getUTCDate())}`;
  const time = `${pad(end.getUTCHours())}:${pad(end.getUTCMinutes())}:${pad(end.getUTCSeconds())}`;
  return `[Event "Live Chess"]
[White "Ada"]
[Black "Nim"]
[Result "1-0"]
[TimeControl "60"]
[Termination "Ada won by checkmate"]
[EndDate "${date}"]
[EndTime "${time}"]

1. e4 {[%clk 0:00:50]} 1-0
`;
}

describe('bandAt', () => {
  it('uses the latest sample before the move and does not skip a weak one', () => {
    const earlier = sample(0, 90);
    const weak = { tUs: 500_000, bpm: 60, confidence: 10, stable: true };
    assert.equal(bandAt([earlier, weak], 500_000, 70), null);
    assert.equal(bandAt([earlier], 500_000, 70), 'elevated');
    assert.equal(bandAt([earlier], earlier.tUs + SAMPLE_HOLD_US, 70), 'elevated');
    assert.equal(bandAt([earlier], earlier.tUs + SAMPLE_HOLD_US + 1, 70), null);
  });

  it('omits a pooled duration when elevated blunders fall in separate stretches', () => {
    const calm = sample(0, 90);
    const later = sample(5_000_000, 100);
    assert.equal(elevatedClaim([calm, later], 0, 10_000_000, 70, [0, 5_000_000]), undefined);
    assert.deepEqual(elevatedClaim([calm, later], 0, 10_000_000, 70, [0]), {
      elevatedMinutes: SAMPLE_HOLD_US / 60_000_000,
      deltaBpm: 20,
    });
  });
});

describe('buildReport', () => {
  it('refuses a 40 percent trace and writes no report', async () => {
    const root = useRoot();
    const id = await session(
      root,
      [sample(0), sample(1_000_000), sample(2_000_000), sample(3_000_000)],
      10_000_000,
    );
    const result = await buildReport(root, id, [pgnAt(EPOCH + 10_000)]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'low_coverage');
    assert.equal(result.measured, 40);
    assert.equal(result.threshold, COVERAGE_GATE_PCT);
    assert.match(result.remedy, /lamp in front of you/);
    assert.equal('verdict' in result, false);
    assert.equal('settled' in result, false);
    await assert.rejects(readFile(path.join(root, 'sessions', id, 'report.json'), 'utf8'));
    assert.match(formatResult(result), /No report for this session/);
    assert.match(formatResult(result), /40%/);
  });

  it('prints the same verdict twice when coverage is enough', async () => {
    const root = useRoot();
    const samples = Array.from({ length: 10 }, (_unused, index) => sample(index * 1_000_000));
    const id = await session(root, samples, 10_000_000);
    const pgn = pgnAt(EPOCH + 10_000);
    const evaluator = {
      async evaluate(fen: string) {
        return { fen, depth: 8, evalFailed: false, scoreCp: 12, bestmove: 'e7e5' };
      },
      async close() {},
    };
    const first = await buildReport(root, id, [pgn], evaluator);
    const second = await buildReport(root, id, [pgn], evaluator);
    assert.equal(first.ok, true);
    assert.deepEqual(second, first);
    if (!first.ok) return;
    assert.match(first.verdict, /blunder/);
    const saved = JSON.parse(await readFile(path.join(root, 'sessions', id, 'report.json'), 'utf8')) as unknown;
    assert.deepEqual(saved, first);
    assert.equal(formatResult(first), `${first.verdict}\n`);
    assert.equal(first.banner, undefined);
    const withBanner = formatResult({ ...first, banner: 'No EndTime in this paste.' });
    assert.equal(withBanner, `${first.verdict}\nNo EndTime in this paste.\n`);
  });
});
