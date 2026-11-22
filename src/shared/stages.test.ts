import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Refusal, Report } from './contracts.js';
import { reviewStages, type StageInput } from './stages.js';

const report: Report = {
  ok: true,
  schemaVersion: 1,
  sessionId: 'session-1',
  gamesDigest: 'a'.repeat(64),
  coveragePct: 82,
  baselineBpm: 70,
  verdict: 'One steady game.',
  settled: { band: 'settled', moves: 30, status: 'ok', accuracy: 71 },
  elevated: { band: 'elevated', moves: 12, status: 'ok', accuracy: 54 },
  engine: { depth: 8, positions: 42, scored: 40, failed: 2, reasons: { timeout: 2, crash: 0, engine: 0, budget: 0 } },
  alignmentMode: 'marks',
  toleranceSec: 0,
  games: [],
  timeline: { startUs: 0, stopUs: 60_000_000, baselineBpm: 70, elevatedThresholdBpm: 80, samples: [], games: [], moves: [] },
};

const refusal: Refusal = {
  ok: false,
  reason: 'low_coverage',
  measured: 40,
  threshold: 70,
  remedy: 'Sit facing the screen with a lamp in front of you.',
};

function stages(overrides: Partial<StageInput>) {
  return reviewStages({ result: report, building: false, failed: false, reading: 'ready', ...overrides });
}

describe('review stages', () => {
  it('returns pulse, engine, and reading in that order', () => {
    assert.deepEqual(
      stages({}).map((entry) => entry.id),
      ['pulse', 'engine', 'reading'],
    );
    assert.deepEqual(
      stages({}).map((entry) => entry.index),
      [1, 2, 3],
    );
  });

  it('marks every stage ready for a finished report with a reading', () => {
    for (const entry of stages({})) {
      assert.equal(entry.state, 'ready');
      assert.equal(entry.reason, null);
    }
  });

  it('blocks the engine and reading when stage 1 refused for coverage', () => {
    const [pulse, engine, reading] = stages({ result: refusal, reading: 'idle' });
    assert.equal(pulse.state, 'refused');
    assert.equal(pulse.reason, 'low_coverage');
    assert.equal(engine.state, 'disabled');
    assert.equal(engine.reason, 'blocked');
    assert.equal(reading.state, 'disabled');
    assert.equal(reading.reason, 'blocked');
  });

  it('keeps stages 1 and 2 ready when the reading has no key', () => {
    const [pulse, engine, reading] = stages({ reading: 'disabled' });
    assert.equal(pulse.state, 'ready');
    assert.equal(engine.state, 'ready');
    assert.equal(reading.state, 'disabled');
    assert.equal(reading.reason, 'no_key');
  });

  it('shows the reading as unavailable when the provider failed', () => {
    const reading = stages({ reading: 'error' })[2];
    assert.equal(reading.state, 'unavailable');
    assert.equal(reading.reason, 'ai_error');
  });

  it('shows the reading as waiting while it is being written', () => {
    const reading = stages({ reading: 'loading' })[2];
    assert.equal(reading.state, 'empty');
    assert.equal(reading.reason, 'writing');
  });

  it('shows an empty reading before anything was asked for', () => {
    const reading = stages({ reading: 'idle' })[2];
    assert.equal(reading.state, 'empty');
    assert.equal(reading.reason, 'not_written');
  });

  it('shows every stage as building while the report is being built', () => {
    for (const entry of stages({ result: null, building: true, reading: 'idle' })) {
      assert.equal(entry.state, 'empty');
      assert.equal(entry.reason, 'building');
    }
  });

  it('shows every stage as unavailable when the build failed', () => {
    for (const entry of stages({ result: null, building: false, failed: true, reading: 'idle' })) {
      assert.equal(entry.state, 'unavailable');
      assert.equal(entry.reason, 'report_failed');
    }
  });

  it('does not call an unbuilt report refused', () => {
    for (const entry of stages({ result: null, building: false, failed: false, reading: 'idle' })) {
      assert.notEqual(entry.state, 'refused');
      assert.equal(entry.reason, 'no_report');
    }
  });
});
