import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createShutdownHooks } from './shutdown.js';

function harness(hasActive: boolean) {
  const events: string[] = [];
  let releaseStop: () => void = () => undefined;
  const stopGate = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });
  const hooks = createShutdownHooks({
    stop: async () => {
      events.push('stop');
      await stopGate;
    },
    hasActive: () => hasActive,
    quit: () => {
      events.push('quit');
    },
  });
  return { hooks, events, releaseStop };
}

describe('shutdown hooks', () => {
  it('routes window close and consent revocation through the stop path', () => {
    const test = harness(true);
    test.hooks.beginStart();
    assert.equal(test.hooks.captureAllowed(), true);
    test.hooks.onWindowAllClosed();
    assert.equal(test.hooks.captureAllowed(), false);
    test.hooks.onConsentRevoked();
    assert.equal(test.hooks.captureAllowed(), false);
    test.hooks.beginStart();
    assert.equal(test.hooks.captureAllowed(), true);
    assert.deepEqual(test.events, ['stop', 'stop']);
  });

  it('prevents quit while active, stops first, and quits afterward', async () => {
    const test = harness(true);
    let prevented = 0;
    test.hooks.onBeforeQuit({ preventDefault: () => { prevented += 1; } });

    assert.equal(prevented, 1);
    assert.deepEqual(test.events, ['stop']);
    test.releaseStop();
    for (let turn = 0; turn < 20 && !test.events.includes('quit'); turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(test.events, ['stop', 'quit']);
  });

  it('blocks repeated quit requests until the pending shutdown settles', async () => {
    const test = harness(true);
    let prevented = 0;
    test.hooks.onBeforeQuit({ preventDefault: () => { prevented += 1; } });
    test.hooks.onBeforeQuit({ preventDefault: () => { prevented += 1; } });

    assert.equal(prevented, 2);
    assert.deepEqual(test.events, ['stop']);
    test.releaseStop();
    for (let turn = 0; turn < 20 && !test.events.includes('quit'); turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(test.events, ['stop', 'quit']);
  });

  it('keeps the app alive and retries when stop rejects', async () => {
    let attempts = 0;
    const events: string[] = [];
    const hooks = createShutdownHooks({
      stop: async () => {
        attempts += 1;
        events.push('stop');
        if (attempts === 1) throw new Error('teardown failed');
      },
      hasActive: () => true,
      quit: () => {
        events.push('quit');
      },
    });
    let prevented = 0;
    hooks.onBeforeQuit({ preventDefault: () => { prevented += 1; } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ['stop']);
    assert.equal(prevented, 1);

    hooks.onBeforeQuit({ preventDefault: () => { prevented += 1; } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ['stop', 'stop', 'quit']);
    assert.equal(prevented, 2);
  });

  it('does not block a quit when no session or stop is active', () => {
    const test = harness(false);
    let prevented = 0;
    test.hooks.onBeforeQuit({ preventDefault: () => { prevented += 1; } });
    assert.equal(prevented, 0);
    assert.deepEqual(test.events, []);
  });
});
