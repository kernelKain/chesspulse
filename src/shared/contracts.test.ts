import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  consentRequestSchema,
  pasteValidationSchema,
  pgnValidateRequestSchema,
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

describe('consentRequestSchema', () => {
  it('rejects a consent payload that adds a field', () => {
    const parsed = consentRequestSchema.safeParse({ granted: true, video: true });
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

describe('pgnValidateRequestSchema', () => {
  it('rejects extra fields and non-string slots', () => {
    assert.equal(pgnValidateRequestSchema.safeParse({ slots: ['1. e4'], extra: true }).success, false);
    assert.equal(pgnValidateRequestSchema.safeParse({ slots: [123] }).success, false);
    assert.equal(pgnValidateRequestSchema.safeParse({ slots: [''] }).success, true);
  });
});

describe('pasteValidationSchema', () => {
  it('accepts an empty paste validation result and rejects extra fields', () => {
    const empty = {
      state: 'empty',
      order: 'none',
      clockless: false,
      canBuild: false,
      message: 'Paste chess.com PGNs oldest first.',
      summary: { total: 0, includedInStats: 0, aborted: 0, abandoned: 0 },
      slots: [{ slotIndex: 0, status: 'empty' }],
    };
    assert.equal(pasteValidationSchema.safeParse(empty).success, true);
    assert.equal(pasteValidationSchema.safeParse({ ...empty, demo: true }).success, false);
  });
});
