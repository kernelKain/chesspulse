import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import type { PulseSample, Report } from '../shared/contracts.js';
import {
  appendSamples,
  createSession,
  createSessionId,
  findMediaFiles,
  listSessions,
  readGames,
  readMeta,
  readReport,
  readSamples,
  saveGames,
  saveReport,
} from './store.js';

function tempRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'chesspulse-store-'));
}

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function useRoot(): string {
  const root = tempRoot();
  roots.push(root);
  return root;
}

const anchor = { monoUs: 1_000, epochMs: 1_700_000_000_000 };
const random = Uint8Array.from({ length: 10 }, (_, index) => index + 1);

function sample(tUs: number): PulseSample {
  return { tUs, bpm: 72, confidence: 80, stable: true };
}

describe('session store', () => {
  it('keeps a sortable id and writes no media file', async () => {
    const root = useRoot();
    const earlier = createSessionId(anchor.epochMs, random);
    const later = createSessionId(anchor.epochMs + 1, random);
    assert.ok(earlier < later);

    const meta = await createSession(
      root,
      { startedAtEpochMs: anchor.epochMs, startAnchor: anchor },
      random,
    );
    assert.equal(meta.id, earlier);
    assert.equal(meta.stopReason, undefined);

    await appendSamples(root, meta.id, [sample(1_000), sample(2_000)]);
    assert.deepEqual(await readSamples(root, meta.id), [sample(1_000), sample(2_000)]);
    assert.deepEqual(await findMediaFiles(root), []);

    const names = await readdir(path.join(root, 'sessions', meta.id));
    assert.deepEqual(names.filter((name) => name.includes('.tmp')), []);
    const header = await readFile(path.join(root, 'sessions', meta.id, 'meta.json'), 'utf8');
    assert.equal(header.includes('"video"'), false);
  });

  it('writes a whole batch or nothing', async () => {
    const root = useRoot();
    const meta = await createSession(root, {
      startedAtEpochMs: anchor.epochMs,
      startAnchor: anchor,
    });
    await appendSamples(root, meta.id, [sample(10)]);
    const broken = [{ ...sample(20) }, { ...sample(30), confidence: 'high' }] as PulseSample[];
    await assert.rejects(() => appendSamples(root, meta.id, broken), /not a pulse sample/);
    assert.deepEqual(await readSamples(root, meta.id), [sample(10)]);
  });

  it('drops one incomplete trailing line and rejects a broken line', async () => {
    const root = useRoot();
    const meta = await createSession(root, {
      startedAtEpochMs: anchor.epochMs,
      startAnchor: anchor,
    });
    const file = path.join(root, 'sessions', meta.id, 'samples.ndjson');
    await writeFile(file, `${JSON.stringify(sample(1))}\n{"tUs":`);
    assert.deepEqual(await readSamples(root, meta.id), [sample(1)]);
    await writeFile(file, '{"tUs":');
    assert.deepEqual(await readSamples(root, meta.id), []);
    await writeFile(file, '{"not":"a sample"}\n');
    await assert.rejects(() => readSamples(root, meta.id), /not a pulse sample/);
  });

  it('names a newer header instead of guessing', async () => {
    const root = useRoot();
    const meta = await createSession(root, {
      startedAtEpochMs: anchor.epochMs,
      startAnchor: anchor,
    });
    const file = path.join(root, 'sessions', meta.id, 'meta.json');
    const stored = JSON.parse(await readFile(file, 'utf8')) as { schemaVersion: number };
    stored.schemaVersion = 2;
    await writeFile(file, JSON.stringify(stored));
    await assert.rejects(() => readMeta(root, meta.id), /written by a newer version/);
  });

  it('rebuilds the session index from the folders', async () => {
    const root = useRoot();
    const meta = await createSession(root, {
      startedAtEpochMs: anchor.epochMs,
      startAnchor: anchor,
    });
    await rm(path.join(root, 'sessions', 'index.json'));
    assert.deepEqual(await listSessions(root), [meta.id]);
  });

  it('refuses another batch when the sample file is marked for repair', async () => {
    const root = useRoot();
    const meta = await createSession(root, {
      startedAtEpochMs: anchor.epochMs,
      startAnchor: anchor,
    });
    await appendSamples(root, meta.id, [sample(10)]);
    const file = path.join(root, 'sessions', meta.id, 'samples.ndjson');
    const before = await readFile(file, 'utf8');
    await writeFile(path.join(root, 'sessions', meta.id, 'samples.ndjson.repair'), '');
    await assert.rejects(
      () => appendSamples(root, meta.id, [sample(20)]),
      /needs repair/,
    );
    assert.equal(await readFile(file, 'utf8'), before);
  });

  it('ignores a folder that has samples but no header', async () => {
    const root = useRoot();
    const id = createSessionId(anchor.epochMs, random);
    const dir = path.join(root, 'sessions', id);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'samples.ndjson'), '');
    assert.deepEqual(await listSessions(root), []);
  });

  it('reads only the stored validated report and original PGN text', async () => {
    const root = useRoot();
    const meta = await createSession(root, { startedAtEpochMs: anchor.epochMs, startAnchor: anchor });
    const report: Report = {
      ok: true,
      sessionId: meta.id,
      coveragePct: 80,
      baselineBpm: 70,
      verdict: 'Accuracy 71% settled.',
      settled: { band: 'settled', moves: 5, status: 'ok', accuracy: 71 },
      elevated: { band: 'elevated', moves: 0, status: 'insufficient' },
      alignmentMode: 'endtime',
      toleranceSec: 1,
      games: [],
      timeline: { startUs: 0, stopUs: 1000, baselineBpm: 70, elevatedThresholdBpm: 80, samples: [], games: [], moves: [] },
    };
    await saveReport(root, meta.id, JSON.stringify(report));
    await saveGames(root, meta.id, ['[Event "Test"]\n1. e4 e5']);
    assert.deepEqual(await readReport(root, meta.id), report);
    assert.deepEqual(await readGames(root, meta.id), ['[Event "Test"]\n1. e4 e5']);

    await writeFile(path.join(root, 'sessions', meta.id, 'report.json'), '{"ok":false}');
    await assert.rejects(() => readReport(root, meta.id), /report is not valid/);
  });

  it('rejects a session id that leaves the store', async () => {
    const root = useRoot();
    await assert.rejects(() => readMeta(root, '../secret'), /Session id is not valid/);
  });
});
