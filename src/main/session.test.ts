import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import type { PulseSample } from '../shared/contracts.js';
import { createSession, readMeta, readSamples } from './store.js';
import {
  BASELINE_WINDOW_US,
  baselineFromSamples,
  coverageFromSamples,
  activeTimeControl,
  ingestSamples,
  MAX_SAMPLE_HOLD_US,
  recoverInterruptedSessions,
  setSampleSink,
  startSession,
  stopSession,
} from './session.js';

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function useRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'chesspulse-session-'));
  roots.push(root);
  return root;
}

const anchor = { monoUs: 0, epochMs: 1_700_000_000_000 };

function sample(tUs: number, bpm: number, confidence = 80, stable = true): PulseSample {
  return { tUs, bpm, confidence, stable };
}

describe('baselineFromSamples', () => {
  it('uses the median of the first minute and ignores a weak sample', () => {
    const samples = [
      sample(0, 60),
      sample(10_000_000, 80),
      sample(20_000_000, 100),
      sample(5_000_000, 40, 10),
      sample(BASELINE_WINDOW_US, 200),
    ];
    const baseline = baselineFromSamples(samples, 0);
    assert.equal(baseline?.baselineBpm, 80);
    assert.equal(baseline?.baselineWindow?.toUs, BASELINE_WINDOW_US);
  });

  it('stores a different baseline for a different first minute', () => {
    const calm = baselineFromSamples([sample(0, 60), sample(1_000, 62)], 0);
    const raised = baselineFromSamples([sample(0, 90), sample(1_000, 92)], 0);
    assert.equal(calm?.baselineBpm, 61);
    assert.equal(raised?.baselineBpm, 91);
    assert.notEqual(calm?.baselineBpm, raised?.baselineBpm);
  });
});

describe('coverageFromSamples', () => {
  it('lets a hole and a weak sample reduce coverage without becoming a zero pulse', () => {
    const start = 0;
    const stop = 4_000_000;
    const steady = [0, 1, 2, 3].map((second) => sample(second * 1_000_000, 70));
    const full = coverageFromSamples(steady, start, stop);
    assert.equal(full.pct, 100);

    const withWeak = [sample(0, 70), sample(1_000_000, 70, 10), sample(2_000_000, 70), sample(3_000_000, 70)];
    const weakened = coverageFromSamples(withWeak, start, stop);
    assert.equal(weakened.usableUs, 3_000_000);
    assert.equal(weakened.pct, 75);

    const withHole = [sample(0, 70), sample(3_000_000, 70)];
    const holed = coverageFromSamples(withHole, start, stop);
    assert.equal(holed.usableUs, MAX_SAMPLE_HOLD_US + 1_000_000);
    assert.ok(holed.pct < full.pct);
    assert.equal(withHole[1].bpm, 70);
  });
});

describe('session controller', () => {
  it('stores the baseline and keeps a weak sample in the file', async () => {
    const root = useRoot();
    await startSession(root, anchor, '3+2');
    assert.equal(activeTimeControl(root), '3+2');
    await ingestSamples(root, [
      sample(0, 60),
      sample(10_000_000, 80),
      sample(20_000_000, 100),
      sample(15_000_000, 40, 10),
    ]);
    const stopped = await stopSession(root, { monoUs: 30_000_000, epochMs: anchor.epochMs + 30_000 }, 'user');
    assert.equal(stopped.baselineBpm, 80);
    assert.equal(stopped.stopReason, 'user');
    assert.equal(stopped.coverage?.confidenceFloor, 50);
    assert.equal(stopped.coverage?.usableUs, 3_000_000);
    assert.equal(stopped.coverage?.pct, 10);
    assert.equal(activeTimeControl(root), undefined);
    const stored = await readSamples(root, stopped.id);
    assert.equal(stored.some((entry) => entry.confidence === 10), true);
  });

  it('refuses a second start and a batch past 90 minutes', async () => {
    const root = useRoot();
    await startSession(root, anchor, '3+2');
    await assert.rejects(() => startSession(root, anchor, '3+2'), /already running/);
    await assert.rejects(
      () => ingestSamples(root, [sample(90 * 60 * 1_000_000 + 1, 70)]),
      /90 minutes/,
    );
    const stopped = await stopSession(root, { monoUs: 1_000, epochMs: anchor.epochMs + 1 }, 'user');
    assert.equal((await readSamples(root, stopped.id)).length, 0);
  });

  it('rejects a second start while the first is still opening', async () => {
    const root = useRoot();
    const pending = startSession(root, anchor, '3+2');
    await assert.rejects(() => startSession(root, anchor, '10+0'), /already running/);
    await pending;
  });

  it('does not leave a session running when stop wins the start', async () => {
    const root = useRoot();
    const pending = startSession(root, anchor, '1+0');
    const stopped = stopSession(root, { monoUs: 5_000, epochMs: anchor.epochMs + 5 }, 'user');
    await assert.rejects(pending, /The session was stopped/);
    const meta = await stopped;
    assert.equal(meta.stopReason, 'user');
    assert.equal(activeTimeControl(root), undefined);
  });

  it('rejects new samples once stopping has begun', async () => {
    const root = useRoot();
    await startSession(root, anchor, '3+2');
    const stopping = stopSession(root, { monoUs: 1_000, epochMs: anchor.epochMs + 1 }, 'user');
    await assert.rejects(() => ingestSamples(root, [sample(0, 70)]), /No session is running/);
    await stopping;
  });

  it('keeps a stored batch when the sink throws', async () => {
    const root = useRoot();
    setSampleSink(root, () => {
      throw new Error('sink down');
    });
    try {
      const started = await startSession(root, anchor, '3+2');
      await ingestSamples(root, [sample(0, 70)]);
      assert.equal((await readSamples(root, started.id)).length, 1);
    } finally {
      setSampleSink(root, undefined);
    }
  });

  it('stores the batch from the moment it was submitted', async () => {
    const root = useRoot();
    const started = await startSession(root, anchor, '3+2');
    const seen: PulseSample[][] = [];
    setSampleSink(root, (batch) => {
      seen.push(batch.map((entry) => ({ ...entry })));
    });
    const submitted = sample(0, 70);
    const batch = [submitted];
    try {
      const pending = ingestSamples(root, batch);
      batch.push(sample(1_000, 90));
      submitted.bpm = 140;
      await pending;
      assert.deepEqual(await readSamples(root, started.id), [sample(0, 70)]);
      assert.deepEqual(seen, [[sample(0, 70)]]);
    } finally {
      setSampleSink(root, undefined);
    }
  });

  it('does not accept samples while the sample file needs repair', async () => {
    const root = useRoot();
    const started = await startSession(root, anchor, '3+2');
    await writeFile(path.join(root, 'sessions', started.id, 'samples.ndjson.repair'), '');
    await assert.rejects(() => ingestSamples(root, [sample(0, 70)]), /needs repair/);
    assert.deepEqual(await readSamples(root, started.id), []);
  });

  it('publishes a stored batch and skips a rejected one', async () => {
    const root = useRoot();
    const seen: PulseSample[][] = [];
    setSampleSink(root, (batch) => {
      seen.push([...batch]);
    });
    try {
      await startSession(root, anchor, '3+2');
      await ingestSamples(root, [sample(0, 70)]);
      assert.equal(seen.length, 1);
      assert.equal(seen[0][0].bpm, 70);
      const broken = [{ ...sample(1_000, 70), confidence: 'high' }] as unknown as PulseSample[];
      await assert.rejects(() => ingestSamples(root, broken), /not a pulse sample/);
      assert.equal(seen.length, 1);
    } finally {
      setSampleSink(root, undefined);
    }
  });

  it('recovers a later session when an earlier sample file cannot be read', async () => {
    const root = useRoot();
    const broken = await startSession(root, anchor, '1+0');
    await ingestSamples(root, [sample(0, 70)]);
    await writeFile(path.join(root, 'sessions', broken.id, 'samples.ndjson'), '{"not":"a sample"}\n');
    const later = await createSession(root, {
      startedAtEpochMs: anchor.epochMs + 60_000,
      startAnchor: { monoUs: 60_000_000, epochMs: anchor.epochMs + 60_000 },
    });
    const { recovered, failures } = await recoverInterruptedSessions(root);
    assert.deepEqual(failures.map((failure) => failure.id), [broken.id]);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].id, later.id);
    assert.equal(recovered[0].stopReason, 'crash');
    assert.equal((await readMeta(root, broken.id)).stopReason, undefined);
  });

  it('can stop again after finalization fails', async () => {
    const root = useRoot();
    const started = await startSession(root, anchor, '3+2');
    const file = path.join(root, 'sessions', started.id, 'meta.json');
    const header = await readFile(file, 'utf8');
    await writeFile(file, '{');
    const stopAnchor = { monoUs: 1_000, epochMs: anchor.epochMs + 1 };
    await assert.rejects(() => stopSession(root, stopAnchor, 'user'), /not valid/);
    await assert.rejects(() => ingestSamples(root, [sample(0, 70)]), /No session is running/);
    assert.equal(activeTimeControl(root), '3+2');
    await writeFile(file, header);
    const stopped = await stopSession(root, stopAnchor, 'user');
    assert.equal(stopped.stopReason, 'user');
    assert.equal(activeTimeControl(root), undefined);
  });

  it('closes an interrupted session as a crash', async () => {
    const root = useRoot();
    const started = await startSession(root, anchor, '1+0');
    await ingestSamples(root, [sample(0, 72), sample(2_000_000, 74)]);
    const recovered = (await recoverInterruptedSessions(root)).recovered;
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].id, started.id);
    assert.equal(recovered[0].stopReason, 'crash');
    assert.equal(recovered[0].baselineBpm, 73);
    await assert.rejects(() => stopSession(root, { monoUs: 3_000_000, epochMs: anchor.epochMs + 3_000 }, 'user'), /No session is running/);
  });
});
