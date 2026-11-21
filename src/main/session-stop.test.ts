import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SessionEndReason, SessionEnded, SessionMeta } from '../shared/contracts.js';
import { createSessionStopper } from './session-stop.js';
import type { SessionStopReason } from './session.js';

function meta(reason: NonNullable<SessionMeta['stopReason']>): SessionMeta {
  return {
    schemaVersion: 1,
    id: '01TESTSESSION0000000000000',
    startedAtEpochMs: 1_700_000_000_000,
    startAnchor: { monoUs: 0, epochMs: 1_700_000_000_000 },
    stopAnchor: { monoUs: 1_000_000, epochMs: 1_700_000_001_000 },
    stopReason: reason,
  };
}

function harness(captureReason?: SessionEndReason) {
  const publishes: SessionEnded[] = [];
  const stopReasons: SessionStopReason[] = [];
  let releaseCapture: () => void = () => undefined;
  let waitForCapture = false;
  const stopper = createSessionStopper({
    stopCapture: async () => {
      if (waitForCapture) await new Promise<void>((resolve) => { releaseCapture = resolve; });
      return captureReason;
    },
    stopSession: async (reason) => {
      stopReasons.push(reason);
      return meta(reason);
    },
    publish: (event) => {
      publishes.push(event);
    },
  });
  return {
    stopper,
    publishes,
    stopReasons,
    gateCapture: () => {
      waitForCapture = true;
    },
    releaseCapture: () => {
      releaseCapture();
    },
  };
}

describe('session stop orchestration', () => {
  it('publishes one storage event when capture reports a failed final write', async () => {
    const test = harness('storage');
    const stopped = await test.stopper.stop('user');

    assert.equal(stopped.stopReason, 'storage');
    assert.deepEqual(test.stopReasons, ['storage']);
    assert.equal(test.publishes.length, 1);
    assert.equal(test.publishes[0].reason, 'storage');
    assert.match(test.publishes[0].message, /could not be saved/);
  });

  it('publishes one limit event and nothing for a manual stop', async () => {
    const limited = harness();
    await limited.stopper.stop('limit');
    assert.deepEqual(limited.stopReasons, ['limit']);
    assert.deepEqual(limited.publishes.map((event) => event.reason), ['limit']);

    const manual = harness();
    await manual.stopper.stop('user');
    assert.deepEqual(manual.stopReasons, ['user']);
    assert.deepEqual(manual.publishes, []);
  });

  it('shares one finalization and publication across concurrent stop requests', async () => {
    const test = harness('storage');
    test.gateCapture();
    const first = test.stopper.stop('user');
    const second = test.stopper.stop('limit');

    assert.equal(first, second);
    test.releaseCapture();
    await first;

    assert.deepEqual(test.stopReasons, ['storage']);
    assert.equal(test.publishes.length, 1);
    assert.equal(test.stopper.active(), false);
  });
});
