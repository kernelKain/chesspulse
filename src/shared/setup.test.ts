import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FramingChecks } from './framing.js';
import { keyStatusFromChecks, setupGate, type SetupGateInput } from './setup.js';

const readyFraming: FramingChecks = { face: 'pass', chest: 'pass', light: 'pass' };
const waitingFraming: FramingChecks = { face: 'unknown', chest: 'unknown', light: 'unknown' };

function input(overrides: Partial<SetupGateInput> = {}): SetupGateInput {
  return {
    consent: true,
    keyStatus: 'present',
    keyDetail: 'Present (value not shown).',
    preview: 'running',
    framing: readyFraming,
    ...overrides,
  };
}

describe('setup gate', () => {
  it('starts only when consent, the key, the preview, and all three checks pass', () => {
    assert.deepEqual(setupGate(input()), { canStart: true, reasons: [] });
  });

  it('names consent first', () => {
    const gate = setupGate(input({ consent: false }));
    assert.equal(gate.canStart, false);
    assert.deepEqual(gate.reasons, ['Allow the camera to continue.']);
  });

  it('waits while the key is being checked, then blocks when it is missing', () => {
    assert.match(setupGate(input({ keyStatus: 'loading' })).reasons[0], /Checking/);
    const missing = setupGate(
      input({
        keyStatus: 'missing',
        keyDetail: 'Missing. Set SMARTSPECTRA_API_KEY in .env or the environment.',
      }),
    );
    assert.equal(missing.canStart, false);
    assert.match(missing.reasons[0], /SMARTSPECTRA_API_KEY/);
  });

  it('falls back to a message with the variable name when the doctor detail is empty', () => {
    const gate = setupGate(input({ keyStatus: 'missing', keyDetail: '' }));
    assert.match(gate.reasons[0], /SMARTSPECTRA_API_KEY/);
  });

  it('blocks a failed key check and tells the player where to go', () => {
    const gate = setupGate(input({ keyStatus: 'error' }));
    assert.equal(gate.canStart, false);
    assert.match(gate.reasons[0], /Help/);
  });

  it('blocks while the preview starts and when it fails', () => {
    assert.match(setupGate(input({ preview: 'starting' })).reasons[0], /Starting/);
    assert.match(setupGate(input({ preview: 'idle' })).reasons[0], /Starting/);
    const failed = setupGate(input({ preview: 'error', previewError: 'Camera is busy.' }));
    assert.equal(failed.reasons[0], 'Camera is busy.');
  });

  it('does not start while any one framing check is unknown or failing', () => {
    const partial: FramingChecks = { face: 'pass', chest: 'pass', light: 'unknown' };
    const gate = setupGate(input({ framing: partial }));
    assert.equal(gate.canStart, false);
    assert.match(gate.reasons[0], /Framing/);
    assert.equal(setupGate(input({ framing: waitingFraming })).canStart, false);
  });
});

describe('keyStatusFromChecks', () => {
  it('maps the doctor key row, including a missing detail', () => {
    assert.deepEqual(
      keyStatusFromChecks([
        { id: 'sensing-key', status: 'pass', detail: 'Present (value not shown).' },
      ]),
      { status: 'present', detail: 'Present (value not shown).' },
    );
    assert.equal(
      keyStatusFromChecks([
        {
          id: 'sensing-key',
          status: 'fail',
          detail: 'Missing. Set SMARTSPECTRA_API_KEY in .env or the environment.',
        },
      ]).status,
      'missing',
    );
  });

  it('reports an error when the row is absent, and a fallback detail when it is empty', () => {
    assert.equal(keyStatusFromChecks([]).status, 'error');
    const missing = keyStatusFromChecks([{ id: 'sensing-key', status: 'fail', detail: '' }]);
    assert.equal(missing.status, 'missing');
    assert.match(missing.detail, /SMARTSPECTRA_API_KEY/);
  });
});
