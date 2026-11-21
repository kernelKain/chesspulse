import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { Metrics } from '@smartspectra/node-sdk/messages';
import type { SessionAnchor, SessionEndReason } from '../shared/contracts.js';
import {
  startCapture,
  type CaptureSdk,
  type CaptureSdkEventMap,
} from './capture.js';
import {
  activeTimeControl,
  ingestSamples,
  startSession,
  stopSession,
} from './session.js';
import { createSessionStopper } from './session-stop.js';
import { createShutdownHooks, type ShutdownHooks } from './shutdown.js';
import { readMeta, readSamples } from './store.js';

class FakeSdk implements CaptureSdk {
  private readonly listeners = new Map<keyof CaptureSdkEventMap, Array<(...args: unknown[]) => void>>();

  on<K extends keyof CaptureSdkEventMap>(
    event: K,
    listener: (...args: CaptureSdkEventMap[K]) => void,
  ): this {
    const current = this.listeners.get(event) ?? [];
    current.push(listener as (...args: unknown[]) => void);
    this.listeners.set(event, current);
    return this;
  }

  useCamera(_selection: unknown): void {}

  start(): void {}

  async stopAsync(): Promise<void> {}

  async destroy(): Promise<void> {}

  emit<K extends keyof CaptureSdkEventMap>(event: K, ...args: CaptureSdkEventMap[K]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for the capture state.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function useRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'chesspulse-shutdown-'));
  roots.push(root);
  return root;
}

function metricsBuffer(anchor: SessionAnchor): Buffer {
  const timestamp = anchor.epochMs * 1000 + 5_000_000;
  return Buffer.from(
    Metrics.encode({
      cardio: {
        pulseRate: [{ timestamp, value: 62, confidence: 80, stable: true }],
      },
    }).finish(),
  );
}

type ShutdownTrigger = 'window close' | 'quit' | 'consent revocation';

function fireShutdown(hooks: ShutdownHooks, trigger: ShutdownTrigger): boolean {
  let prevented = false;
  if (trigger === 'window close') hooks.onWindowAllClosed();
  else if (trigger === 'consent revocation') hooks.onConsentRevoked();
  else hooks.onBeforeQuit({ preventDefault: () => { prevented = true; } });
  return prevented;
}

async function drainsBeforeHeader(trigger: ShutdownTrigger, pendingBuffer = false): Promise<void> {
  const root = useRoot();
  const anchor = { monoUs: 1_000_000, epochMs: 1_700_000_000_000 };
  const started = await startSession(root, anchor, '3+2');
  const sdk = new FakeSdk();
  const timeline: string[] = [];
  let releaseWrite: () => void = () => undefined;
  let markBatch: () => void = () => undefined;
  const writeGate = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const batchStarted = new Promise<void>((resolve) => {
    markBatch = resolve;
  });
  const capture = startCapture({
    apiKey: 'test-key',
    anchor,
    sdk,
    flushMs: pendingBuffer ? 60_000 : 0,
    events: {
      onSamples: async (samples) => {
        markBatch();
        await writeGate;
        await ingestSamples(root, samples);
        timeline.push('write-landed');
      },
      onValidation: () => undefined,
      onError: () => undefined,
      onPreview: () => undefined,
      onEnded: () => undefined,
    },
  });
  const stopper = createSessionStopper({
    stopCapture: () => capture.stop(),
    stopSession: (reason) => {
      timeline.push('header-closing');
      return stopSession(root, { monoUs: 7_000_000, epochMs: anchor.epochMs + 6_000 }, reason);
    },
    publish: () => undefined,
  });
  let stopping: ReturnType<typeof stopSession> | undefined;
  const hooks = createShutdownHooks({
    stop: () => {
      stopping = stopper.stop('user');
      return stopping;
    },
    hasActive: () => activeTimeControl(root) !== undefined,
    quit: () => {
      timeline.push('quit');
    },
  });
  sdk.emit('metrics', metricsBuffer(anchor));
  if (!pendingBuffer) await batchStarted;

  const prevented = fireShutdown(hooks, trigger);

  if (pendingBuffer) await batchStarted;
  assert.ok(stopping);
  assert.equal(prevented, trigger === 'quit');
  assert.equal(activeTimeControl(root), '3+2');
  assert.deepEqual(timeline, []);
  releaseWrite();
  await stopping;

  assert.deepEqual(timeline.slice(0, 2), ['write-landed', 'header-closing']);
  if (trigger === 'quit') {
    await Promise.resolve();
    assert.equal(timeline.at(-1), 'quit');
  }
  assert.equal((await readSamples(root, started.id)).length, 1);
  const stored = await readMeta(root, started.id);
  assert.equal(stored.stopReason, 'user');
  assert.equal(stored.coverage?.totalUs, 6_000_000);
  assert.equal((stored.coverage?.usableUs ?? 0) > 0, true);
  assert.equal(activeTimeControl(root), undefined);
}

describe('shutdown drain', () => {
  it('drains the final batch before the header closes on window close', async () => {
    await drainsBeforeHeader('window close');
  });

  it('drains the final batch before the header closes on quit', async () => {
    await drainsBeforeHeader('quit');
  });

  it('drains the final batch before the header closes on consent revocation', async () => {
    await drainsBeforeHeader('consent revocation');
  });

  it('flushes a buffered batch before the header closes on window close', async () => {
    await drainsBeforeHeader('window close', true);
  });
});

describe('capture terminal reporting', () => {
  it('reports one storage end when the sample write rejects', async () => {
    const sdk = new FakeSdk();
    const ended: SessionEndReason[] = [];
    const anchor = { monoUs: 1_000_000, epochMs: 1_700_000_000_000 };
    let sampleBatches = 0;
    const capture = startCapture({
      apiKey: 'test-key',
      anchor,
      sdk,
      flushMs: 0,
      events: {
        onSamples: async () => {
          sampleBatches += 1;
          throw new Error('disk full');
        },
        onValidation: () => undefined,
        onError: () => undefined,
        onPreview: () => undefined,
        onEnded: (reason) => {
          ended.push(reason);
        },
      },
    });
    const timestamp = anchor.epochMs * 1000 + 5_000_000;
    const buffer = Buffer.from(
      Metrics.encode({
        cardio: {
          pulseRate: [{ timestamp, value: 62, confidence: 80, stable: true }],
        },
      }).finish(),
    );

    sdk.emit('metrics', buffer);
    await waitFor(() => ended.length > 0);
    await capture.stop();

    assert.equal(sampleBatches, 1);
    assert.deepEqual(ended, ['storage']);
  });

  it('returns storage when the final in-flight write rejects during shutdown', async () => {
    const sdk = new FakeSdk();
    const ended: SessionEndReason[] = [];
    const anchor = { monoUs: 1_000_000, epochMs: 1_700_000_000_000 };
    let rejectWrite: (error: Error) => void = () => undefined;
    let startedWrite: () => void = () => undefined;
    const writeStarted = new Promise<void>((resolve) => {
      startedWrite = resolve;
    });
    const capture = startCapture({
      apiKey: 'test-key',
      anchor,
      sdk,
      flushMs: 0,
      events: {
        onSamples: () =>
          new Promise<void>((_resolve, reject) => {
            rejectWrite = reject;
            startedWrite();
          }),
        onValidation: () => undefined,
        onError: () => undefined,
        onPreview: () => undefined,
        onEnded: (reason) => {
          ended.push(reason);
        },
      },
    });
    const timestamp = anchor.epochMs * 1000 + 5_000_000;
    const buffer = Buffer.from(
      Metrics.encode({
        cardio: {
          pulseRate: [{ timestamp, value: 62, confidence: 80, stable: true }],
        },
      }).finish(),
    );

    sdk.emit('metrics', buffer);
    await writeStarted;
    const stopping = capture.stop();
    rejectWrite(new Error('disk full'));
    const reason = await stopping;

    assert.equal(reason, 'storage');
    assert.deepEqual(ended, ['storage']);
  });
});
