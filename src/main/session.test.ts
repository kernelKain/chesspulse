import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
  isActiveSession,
  MAX_SAMPLE_HOLD_US,
  MAX_SESSION_US,
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

  it('refuses a second start while one is running', async () => {
    const root = useRoot();
    await startSession(root, anchor, '3+2');
    await assert.rejects(() => startSession(root, anchor, '3+2'), /already running/);
    const stopped = await stopSession(root, { monoUs: 1_000, epochMs: anchor.epochMs + 1 }, 'user');
    assert.equal((await readSamples(root, stopped.id)).length, 0);
  });

  it('identifies only the running session as active', async () => {
    const root = useRoot();
    const started = await startSession(root, anchor, '3+2');
    assert.equal(isActiveSession(root, started.id), true);
    assert.equal(isActiveSession(root, '01OTHER0000000000000000000'), false);
    await stopSession(root, { monoUs: 1_000, epochMs: anchor.epochMs + 1 }, 'user');
    assert.equal(isActiveSession(root, started.id), false);
  });

  it('leaves the 90-minute boundary to the timer instead of rejecting a sample batch', async () => {
    const root = useRoot();
    const started = await startSession(root, anchor, '3+2');
    await ingestSamples(root, [sample(MAX_SESSION_US + 1, 70)]);
    assert.equal((await readSamples(root, started.id)).length, 1);
    const stopped = await stopSession(
      root,
      { monoUs: MAX_SESSION_US + 1, epochMs: anchor.epochMs + MAX_SESSION_US / 1000 },
      'user',
    );
    assert.equal(stopped.stopReason, 'user');
  });

  it('arms the 90-minute limit at start and stores limit when it fires', async () => {
    const root = useRoot();
    let fire: () => void = () => undefined;
    let delayMs = 0;
    let cleared = 0;
    let stopping: ReturnType<typeof stopSession> | undefined;
    const started = await startSession(root, anchor, '3+2', {
      limitScheduler: {
        set: (callback, delay) => {
          fire = callback;
          delayMs = delay;
          return 1;
        },
        clear: () => {
          cleared += 1;
        },
      },
      onLimit: () => {
        stopping = stopSession(
          root,
          { monoUs: MAX_SESSION_US, epochMs: anchor.epochMs + MAX_SESSION_US / 1000 },
          'limit',
        );
      },
    });

    assert.equal(delayMs, MAX_SESSION_US / 1000);
    assert.equal(activeTimeControl(root), '3+2');
    fire();
    assert.ok(stopping);
    const meta = await stopping;
    assert.equal(meta.id, started.id);
    assert.equal(meta.stopReason, 'limit');
    assert.equal(meta.coverage?.totalUs, MAX_SESSION_US);
    assert.equal((await readSamples(root, meta.id)).length, 0);
    assert.equal(activeTimeControl(root), undefined);
    assert.equal(cleared, 0);
  });

  it('clears the limit timer when a player stop finalizes the session', async () => {
    const root = useRoot();
    let fire: () => void = () => undefined;
    let cleared = 0;
    let limitCalls = 0;
    await startSession(root, anchor, '3+2', {
      limitScheduler: {
        set: (callback) => {
          fire = callback;
          return 1;
        },
        clear: () => {
          cleared += 1;
        },
      },
      onLimit: () => {
        limitCalls += 1;
      },
    });

    const stopped = await stopSession(root, { monoUs: 1_000, epochMs: anchor.epochMs + 1 }, 'user');
    assert.equal(stopped.stopReason, 'user');
    assert.equal(cleared, 1);
    fire();
    assert.equal(limitCalls, 0);
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

  it('recovers the ingest tail after a rejected append and finalizes a storage stop', async () => {
    const root = useRoot();
    const started = await startSession(root, anchor, '3+2');
    const broken = [{ ...sample(0, 70), confidence: 'high' }] as unknown as PulseSample[];
    await assert.rejects(() => ingestSamples(root, broken), /not a pulse sample/);
    await ingestSamples(root, [sample(1_000_000, 74)]);

    const stopped = await stopSession(root, { monoUs: 2_000_000, epochMs: anchor.epochMs + 2_000 }, 'storage');

    assert.equal(stopped.id, started.id);
    assert.equal(stopped.stopReason, 'storage');
    assert.deepEqual(await readSamples(root, started.id), [sample(1_000_000, 74)]);
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

  it('can stop again after finalization fails and clears the limit timer', async () => {
    const root = useRoot();
    let cleared = 0;
    const started = await startSession(root, anchor, '3+2', {
      limitScheduler: {
        set: () => 1,
        clear: () => {
          cleared += 1;
        },
      },
    });
    const file = path.join(root, 'sessions', started.id, 'meta.json');
    const header = await readFile(file, 'utf8');
    await writeFile(file, '{');
    const stopAnchor = { monoUs: 1_000, epochMs: anchor.epochMs + 1 };
    await assert.rejects(() => stopSession(root, stopAnchor, 'user'), /not valid/);
    assert.equal(cleared, 1);
    await assert.rejects(() => ingestSamples(root, [sample(0, 70)]), /No session is running/);
    assert.equal(activeTimeControl(root), '3+2');
    await writeFile(file, header);
    const stopped = await stopSession(root, stopAnchor, 'user');
    assert.equal(stopped.stopReason, 'user');
    assert.equal(cleared, 1);
    assert.equal(activeTimeControl(root), undefined);
  });

  it('recovers a killed sensing process as a crash with coverage', async () => {
    const root = useRoot();
    const script = path.join(root, 'crash-child.cjs');
    await writeFile(
      script,
      `const { startSession, ingestSamples } = require(${JSON.stringify(path.join(__dirname, 'session.js'))});\n` +
        `const root = ${JSON.stringify(root)};\n` +
        '(async () => {\n' +
        "  await startSession(root, { monoUs: 0, epochMs: 1700000000000 }, '3+2');\n" +
        '  await ingestSamples(root, [\n' +
        '    { tUs: 0, bpm: 70, confidence: 80, stable: true },\n' +
        '    { tUs: 1000000, bpm: 72, confidence: 80, stable: true },\n' +
        '    { tUs: 3000000, bpm: 74, confidence: 80, stable: true },\n' +
        '  ]);\n' +
        "  process.kill(process.pid, 'SIGKILL');\n" +
        '})().catch((error) => { console.error(error); process.exit(1); });\n',
    );
    const child = spawn(process.execPath, [script], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    let timer: NodeJS.Timeout | undefined;
    const exited = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`The crash child did not exit in time. stderr: ${stderr}`));
        }, 10_000);
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({ code, signal }));
      },
    ).finally(() => {
      if (timer) clearTimeout(timer);
    });
    assert.equal(exited.signal, 'SIGKILL', `child exited with code ${exited.code}: ${stderr}`);

    const { recovered, failures } = await recoverInterruptedSessions(root);

    assert.deepEqual(failures, []);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].stopReason, 'crash');
    assert.equal(recovered[0].coverage?.totalUs, 3_000_000);
    assert.equal(recovered[0].coverage?.usableUs, 2_000_000);
    assert.equal((recovered[0].coverage?.pct ?? 100) < 100, true);
    assert.equal((await readSamples(root, recovered[0].id)).length, 3);
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
