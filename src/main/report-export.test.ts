import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { REPORT_SCHEMA_VERSION, type Report } from '../shared/contracts.js';
import { reportAppError } from './report-errors.js';
import { buildReportExport, exportResult, writeReportExport } from './report-export.js';
import { StoredReportError } from './store.js';

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

function report(): Report {
  return {
    ok: true,
    schemaVersion: REPORT_SCHEMA_VERSION,
    sessionId: '01TESTSESSION0000000000000',
    gamesDigest: 'a'.repeat(64),
    coveragePct: 82,
    baselineBpm: 70,
    verdict: 'Two blunders, one while your pulse was elevated.',
    settled: { band: 'settled', moves: 6, status: 'ok', accuracy: 82 },
    elevated: { band: 'elevated', moves: 5, status: 'ok', accuracy: 58 },
    engine: {
      depth: 12,
      positions: 10,
      scored: 10,
      failed: 0,
      reasons: { timeout: 0, crash: 0, engine: 0, budget: 0 },
    },
    alignmentMode: 'endtime',
    toleranceSec: 1,
    games: [],
    timeline: {
      startUs: 0,
      stopUs: 1_000_000,
      baselineBpm: 70,
      elevatedThresholdBpm: 80,
      samples: [{ tUs: 500_000, bpm: 137, confidence: 80, stable: true }],
      games: [],
      moves: [],
    },
  };
}

describe('report export', () => {
  it('builds the documented wrapper and removes the pulse samples', () => {
    const exported = buildReportExport(report(), new Date('2026-11-22T10:00:00.000Z'));
    assert.equal(exported.format, 'chesspulse-report-export');
    assert.equal(exported.exportedAt, '2026-11-22T10:00:00.000Z');
    assert.equal(exported.note, 'This file contains no pulse samples.');
    assert.equal(exported.report.verdict, 'Two blunders, one while your pulse was elevated.');
    assert.equal('samples' in exported.report.timeline, false);
    assert.equal(exported.report.timeline.baselineBpm, 70);
    assert.equal(exported.report.timeline.moves.length, 0);
  });

  it('writes JSON that contains no pulse sample and leaves the stored report alone', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'chesspulse-export-'));
    roots.push(root);
    const destination = path.join(root, 'report.json');
    await writeFile(destination, 'old content');

    const input = report();
    await writeReportExport(input, destination, new Date('2026-11-22T10:00:00.000Z'));

    const text = await readFile(destination, 'utf8');
    const parsed = JSON.parse(text) as { report: { timeline: Record<string, unknown> } };
    assert.equal(text.includes('"bpm": 137'), false);
    assert.equal('samples' in parsed.report.timeline, false);
    assert.match(text, /"note": "This file contains no pulse samples\."/);
    assert.equal(input.timeline.samples.length, 1);
  });

  it('reports a cancelled save as not exported', () => {
    assert.deepEqual(exportResult(undefined), { exported: false });
    assert.deepEqual(exportResult('/tmp/report.json'), {
      exported: true,
      path: '/tmp/report.json',
    });
  });

  it('maps stored-report failures to their own player copy', () => {
    assert.equal(reportAppError(new StoredReportError('missing', 'x')).code, 'report_missing');
    assert.equal(reportAppError(new StoredReportError('stale', 'x')).code, 'report_stale');
    assert.equal(reportAppError(new StoredReportError('newer', 'x')).code, 'report_newer');
    assert.equal(reportAppError(new StoredReportError('invalid', 'x')).code, 'report_failed');
    assert.equal(reportAppError(new Error('disk gone')).code, 'report_failed');
  });
});
