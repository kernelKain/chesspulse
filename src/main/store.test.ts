import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { REPORT_SCHEMA_VERSION, type PulseSample, type Report } from '../shared/contracts.js';
import { requestInsight } from './ai/service.js';
import {
  appendSamples,
  createSession,
  createSessionId,
  deleteSession,
  digestGames,
  findMediaFiles,
  listSessions,
  readGames,
  readMeta,
  readReport,
  readSamples,
  saveGames,
  saveReport,
  saveReportArtifacts,
  type AtomicFileSystem,
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

function reportFor(sessionId: string, pgns: readonly string[]): Report {
  return {
    ok: true,
    schemaVersion: REPORT_SCHEMA_VERSION,
    sessionId,
    gamesDigest: digestGames(pgns),
    coveragePct: 80,
    baselineBpm: 70,
    verdict: 'Accuracy 71% settled.',
    settled: { band: 'settled', moves: 5, status: 'ok', accuracy: 71 },
    elevated: { band: 'elevated', moves: 0, status: 'insufficient' },
    engine: {
      depth: 12,
      positions: 0,
      scored: 0,
      failed: 0,
      reasons: { timeout: 0, crash: 0, engine: 0, budget: 0 },
    },
    alignmentMode: 'endtime',
    toleranceSec: 1,
    games: [],
    timeline: { startUs: 0, stopUs: 1000, baselineBpm: 70, elevatedThresholdBpm: 80, samples: [], games: [], moves: [] },
  };
}

function atomicProbe(options: {
  failSyncFor?: string;
  failRenameFor?: string;
  failWriteFor?: string;
  failCloseFor?: string;
  failRm?: boolean;
  failSyncOnCall?: number;
} = {}) {
  const events: string[] = [];
  const closes = new Map<number, number>();
  let nextHandleId = 0;
  let syncCalls = 0;
  const fs: AtomicFileSystem = {
    open: async (filePath, flags, mode) => {
      events.push(`open:${filePath}:${flags}`);
      const handleId = nextHandleId;
      nextHandleId += 1;
      closes.set(handleId, 0);
      const handle = await open(filePath, flags, mode);
      return {
        writeFile: async (body) => {
          events.push(`write:${filePath}`);
          if (options.failWriteFor && filePath.includes(options.failWriteFor)) {
            throw new Error('injected write failure');
          }
          await handle.writeFile(body);
        },
        sync: async () => {
          syncCalls += 1;
          events.push(`sync:${filePath}`);
          if (options.failSyncOnCall === syncCalls) {
            throw new Error('injected sync failure');
          }
          if (options.failSyncFor && filePath.includes(options.failSyncFor)) {
            throw new Error('injected sync failure');
          }
          await handle.sync();
        },
        close: async () => {
          events.push(`close:${filePath}`);
          closes.set(handleId, (closes.get(handleId) ?? 0) + 1);
          await handle.close();
          if (options.failCloseFor && filePath.includes(options.failCloseFor)) {
            throw new Error('injected close failure');
          }
        },
      };
    },
    rename: async (from, to) => {
      events.push(`rename:${from}->${to}`);
      if (options.failRenameFor && to.endsWith(options.failRenameFor)) {
        throw new Error('injected rename failure');
      }
      await rename(from, to);
    },
    rm: async (filePath, rmOptions) => {
      events.push(`rm:${filePath}`);
      if (options.failRm) throw new Error('injected remove failure');
      await rm(filePath, rmOptions);
    },
  };
  return { events, closes, fs };
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

  it('repairs a corrupt index and writes a valid replacement', async () => {
    const root = useRoot();
    const meta = await createSession(root, {
      startedAtEpochMs: anchor.epochMs,
      startAnchor: anchor,
    });
    const indexFile = path.join(root, 'sessions', 'index.json');
    await writeFile(indexFile, '{not json');
    assert.deepEqual(await listSessions(root), [meta.id]);
    const repaired = JSON.parse(await readFile(indexFile, 'utf8')) as { schemaVersion: number; ids: string[] };
    assert.equal(repaired.schemaVersion, 1);
    assert.deepEqual(repaired.ids, [meta.id]);
  });

  it('refuses a newer data index instead of rebuilding it', async () => {
    const root = useRoot();
    const meta = await createSession(root, {
      startedAtEpochMs: anchor.epochMs,
      startAnchor: anchor,
    });
    await writeFile(
      path.join(root, 'sessions', 'index.json'),
      JSON.stringify({ schemaVersion: 2, ids: [meta.id] }),
    );
    await assert.rejects(() => listSessions(root), /newer version/);
    await assert.rejects(() => deleteSession(root, meta.id), /newer version/);
    assert.deepEqual(await readMeta(root, meta.id).then((stored) => stored.id), meta.id);
  });

  it('deletes one session folder and rewrites the index from what remains', async () => {
    const root = useRoot();
    const first = await createSession(root, {
      startedAtEpochMs: anchor.epochMs,
      startAnchor: anchor,
    });
    const second = await createSession(
      root,
      { startedAtEpochMs: anchor.epochMs + 1, startAnchor: anchor },
      Uint8Array.from({ length: 10 }, () => 9),
    );
    assert.deepEqual(await listSessions(root), [first.id, second.id].sort());

    assert.equal(await deleteSession(root, first.id), true);
    assert.deepEqual(await listSessions(root), [second.id]);
    await assert.rejects(() => readMeta(root, first.id), /No session/);
    const index = JSON.parse(
      await readFile(path.join(root, 'sessions', 'index.json'), 'utf8'),
    ) as { ids: string[] };
    assert.deepEqual(index.ids, [second.id]);

    assert.equal(await deleteSession(root, first.id), false);
    await assert.rejects(() => deleteSession(root, '../escape'), /Session id is not valid/);
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
    const report = reportFor(meta.id, ['[Event "Test"]\n1. e4 e5']);
    await saveReport(root, meta.id, JSON.stringify(report));
    await saveGames(root, meta.id, ['[Event "Test"]\n1. e4 e5']);
    assert.deepEqual(await readReport(root, meta.id), report);
    assert.deepEqual(await readGames(root, meta.id), ['[Event "Test"]\n1. e4 e5']);

    const legacyReport = Object.fromEntries(
      Object.entries(report).filter(([key]) => key !== 'schemaVersion'),
    );
    await writeFile(path.join(root, 'sessions', meta.id, 'report.json'), JSON.stringify(legacyReport));
    await assert.rejects(() => readReport(root, meta.id), /older version.*Build the report again/);

    await writeFile(
      path.join(root, 'sessions', meta.id, 'report.json'),
      JSON.stringify({ ...report, schemaVersion: 2 }),
    );
    await assert.rejects(() => readReport(root, meta.id), /newer version.*Update the app/);

    const noDigest = Object.fromEntries(
      Object.entries(report).filter(([key]) => key !== 'gamesDigest'),
    );
    await writeFile(path.join(root, 'sessions', meta.id, 'report.json'), JSON.stringify(noDigest));
    await assert.rejects(() => readReport(root, meta.id), /report is not valid/);

    await writeFile(path.join(root, 'sessions', meta.id, 'report.json'), '{"ok":false}');
    await assert.rejects(() => readReport(root, meta.id), /report is not valid/);
  });

  it('uses unique temp files, stages both artifacts, closes once, and syncs each rename', async () => {
    const root = useRoot();
    const meta = await createSession(root, { startedAtEpochMs: anchor.epochMs, startAnchor: anchor });
    const pgns = ['[Event "Test"]\n1. e4 e5'];
    const report = reportFor(meta.id, pgns);
    const probe = atomicProbe();

    await saveReportArtifacts(root, meta.id, JSON.stringify(report), pgns, probe.fs);
    await saveReportArtifacts(root, meta.id, JSON.stringify(report), pgns, probe.fs);

    const tempWrites = probe.events.filter((event) => event.startsWith('write:') && event.endsWith('.tmp'));
    assert.equal(tempWrites.length, 4);
    assert.equal(new Set(tempWrites).size, 4);
    const firstRename = probe.events.findIndex((event) => event.startsWith('rename:'));
    assert.equal(probe.events.slice(0, firstRename).filter((event) => event.startsWith('write:')).length, 2);
    const renameTargets = probe.events
      .filter((event) => event.startsWith('rename:'))
      .map((event) => event.split('->').at(-1));
    assert.deepEqual(renameTargets, [
      path.join(root, 'sessions', meta.id, 'games.json'),
      path.join(root, 'sessions', meta.id, 'report.json'),
      path.join(root, 'sessions', meta.id, 'games.json'),
      path.join(root, 'sessions', meta.id, 'report.json'),
    ]);
    for (const count of probe.closes.values()) assert.equal(count, 1);
    const dir = path.join(root, 'sessions', meta.id);
    assert.equal(probe.events.filter((event) => event === `sync:${dir}`).length, 4);
    assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith('.tmp')), []);
  });

  it('removes staged temp files and preserves both old artifacts when the second temp write fails', async () => {
    const root = useRoot();
    const meta = await createSession(root, { startedAtEpochMs: anchor.epochMs, startAnchor: anchor });
    const oldPgns = ['[Event "Old"]\n1. e4 e5'];
    const newPgns = ['[Event "New"]\n1. d4 d5'];
    await saveReportArtifacts(root, meta.id, JSON.stringify(reportFor(meta.id, oldPgns)), oldPgns);
    const reportFile = path.join(root, 'sessions', meta.id, 'report.json');
    const gamesFile = path.join(root, 'sessions', meta.id, 'games.json');
    const reportBefore = await readFile(reportFile, 'utf8');
    const gamesBefore = await readFile(gamesFile, 'utf8');
    const probe = atomicProbe({ failSyncFor: 'report.json.' });

    await assert.rejects(
      saveReportArtifacts(root, meta.id, JSON.stringify(reportFor(meta.id, newPgns)), newPgns, probe.fs),
      /injected sync failure/,
    );

    assert.equal(await readFile(reportFile, 'utf8'), reportBefore);
    assert.equal(await readFile(gamesFile, 'utf8'), gamesBefore);
    assert.equal(probe.events.filter((event) => event.startsWith('rm:') && event.endsWith('.tmp')).length, 2);
    for (const count of probe.closes.values()) assert.equal(count, 1);
    assert.deepEqual((await readdir(path.join(root, 'sessions', meta.id))).filter((name) => name.endsWith('.tmp')), []);
  });

  it('keeps the new pair when only the report directory sync fails after its rename', async () => {
    const root = useRoot();
    const meta = await createSession(root, { startedAtEpochMs: anchor.epochMs, startAnchor: anchor });
    const oldPgns = ['[Event "Old"]\n1. e4 e5'];
    const newPgns = ['[Event "New"]\n1. d4 d5'];
    await saveReportArtifacts(root, meta.id, JSON.stringify(reportFor(meta.id, oldPgns)), oldPgns);
    const probe = atomicProbe({ failSyncOnCall: 4 });

    await assert.rejects(
      saveReportArtifacts(root, meta.id, JSON.stringify(reportFor(meta.id, newPgns)), newPgns, probe.fs),
      /injected sync failure/,
    );

    const storedReport = await readReport(root, meta.id);
    const storedGames = await readGames(root, meta.id);
    assert.deepEqual(storedGames, newPgns);
    assert.equal(storedReport.gamesDigest, digestGames(storedGames));
    assert.deepEqual((await readdir(path.join(root, 'sessions', meta.id))).filter((name) => name.endsWith('.tmp')), []);
  });

  it('preserves the staging error when every temp cleanup also fails', async () => {
    const root = useRoot();
    const meta = await createSession(root, { startedAtEpochMs: anchor.epochMs, startAnchor: anchor });
    const pgns = ['[Event "Test"]\n1. e4 e5'];
    const probe = atomicProbe({ failSyncFor: 'report.json.', failRm: true });

    await assert.rejects(
      saveReportArtifacts(root, meta.id, JSON.stringify(reportFor(meta.id, pgns)), pgns, probe.fs),
      /injected sync failure/,
    );

    assert.equal(probe.events.filter((event) => event.startsWith('rm:') && event.endsWith('.tmp')).length, 2);
    for (const count of probe.closes.values()) assert.equal(count, 1);
  });

  it('preserves the write error when closing the same handle also fails', async () => {
    const root = useRoot();
    const meta = await createSession(root, { startedAtEpochMs: anchor.epochMs, startAnchor: anchor });
    const pgns = ['[Event "Test"]\n1. e4 e5'];
    const probe = atomicProbe({ failWriteFor: 'games.json.', failCloseFor: 'games.json.' });

    await assert.rejects(
      saveReportArtifacts(root, meta.id, JSON.stringify(reportFor(meta.id, pgns)), pgns, probe.fs),
      /injected write failure/,
    );

    assert.equal(probe.events.filter((event) => event.startsWith('rm:') && event.endsWith('.tmp')).length, 1);
    for (const count of probe.closes.values()) assert.equal(count, 1);
  });

  it('detects a crash between renames and blocks AI with the mixed stored pair', async () => {
    const root = useRoot();
    const meta = await createSession(root, { startedAtEpochMs: anchor.epochMs, startAnchor: anchor });
    const oldPgns = ['[Event "Old"]\n1. e4 e5'];
    const newPgns = ['[Event "New"]\n1. d4 d5'];
    const oldReport = reportFor(meta.id, oldPgns);
    await saveReportArtifacts(root, meta.id, JSON.stringify(oldReport), oldPgns);
    const probe = atomicProbe({ failRenameFor: 'report.json' });

    await assert.rejects(
      saveReportArtifacts(root, meta.id, JSON.stringify(reportFor(meta.id, newPgns)), newPgns, probe.fs),
      /injected rename failure/,
    );

    const storedReport = await readReport(root, meta.id);
    const storedGames = await readGames(root, meta.id);
    // A failed report rename rolls the PGN file back to the previous coherent pair.
    assert.deepEqual(storedReport, oldReport);
    assert.deepEqual(storedGames, oldPgns);
    assert.equal(storedReport.gamesDigest, digestGames(storedGames));

    // A hand-edited PGN batch still produces a detectable mismatch.
    await saveGames(root, meta.id, newPgns);
    const mismatchedGames = await readGames(root, meta.id);
    assert.notEqual(storedReport.gamesDigest, digestGames(mismatchedGames));
    let calls = 0;
    await assert.rejects(
      requestInsight(
        { sessionId: meta.id, text: 'Review this session.' },
        storedReport,
        mismatchedGames,
        { CP_AI_KEY: 'test-secret', CP_AI_MODEL: 'test-model' },
        {
          fetch: async () => {
            calls += 1;
            return new Response('{}', { status: 500 });
          },
        },
      ),
      /Build the report again/,
    );
    assert.equal(calls, 0);
    assert.deepEqual((await readdir(path.join(root, 'sessions', meta.id))).filter((name) => name.endsWith('.tmp')), []);
  });

  it('rejects a session id that leaves the store', async () => {
    const root = useRoot();
    await assert.rejects(() => readMeta(root, '../secret'), /Session id is not valid/);
  });
});
