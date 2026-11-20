import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  pulseSampleSchema,
  refusalSchema,
  reportBuildRequestSchema,
} from './contracts.js';

const sample = {
  tUs: 1000,
  bpm: 72,
  confidence: 80,
  stable: true,
};

describe('pulseSampleSchema', () => {
  it('accepts a numeric sample', () => {
    assert.deepEqual(pulseSampleSchema.parse(sample), sample);
  });

  it('rejects a string where a number is required', () => {
    const parsed = pulseSampleSchema.safeParse({ ...sample, bpm: '72' });
    assert.equal(parsed.success, false);
  });

  it('rejects a field that is not in the contract', () => {
    const parsed = pulseSampleSchema.safeParse({ ...sample, video: true });
    assert.equal(parsed.success, false);
  });
});

describe('refusalSchema', () => {
  it('rejects a successful flag on a refusal', () => {
    const parsed = refusalSchema.safeParse({
      ok: true,
      reason: 'low_coverage',
      remedy: 'Record a longer session.',
    });
    assert.equal(parsed.success, false);
  });
});

describe('reportBuildRequestSchema', () => {
  it('rejects more than 20 games', () => {
    const parsed = reportBuildRequestSchema.safeParse({
      sessionId: 's1',
      pgns: Array.from({ length: 21 }, () => '1. e4'),
    });
    assert.equal(parsed.success, false);
  });
});
