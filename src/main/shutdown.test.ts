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
    test.hooks.onWindowAllClosed();
    test.hooks.onConsentRevoked();
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

  it('does not block a quit when no session or stop is active', () => {
    const test = harness(false);
    let prevented = 0;
    test.hooks.onBeforeQuit({ preventDefault: () => { prevented += 1; } });
    assert.equal(prevented, 0);
    assert.deepEqual(test.events, []);
  });
});
