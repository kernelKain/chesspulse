import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PulseSample } from './contracts.js';
import { SAMPLE_HOLD_US, traceSegments } from './sensing.js';

function sample(tUs: number, confidence = 80): PulseSample {
  return { tUs, bpm: 70, confidence, stable: true };
}

describe('traceSegments', () => {
  it('breaks the line at a hole and keeps a weak sample', () => {
    const later = 500_000 + SAMPLE_HOLD_US + 1;
    const segments = traceSegments([
      sample(later),
      sample(0),
      sample(500_000, 10),
      sample(later + 500_000),
    ]);
    assert.equal(segments.length, 2);
    assert.deepEqual(segments[0].map((entry) => entry.tUs), [0, 500_000]);
    assert.equal(segments[0][1].confidence, 10);
    assert.deepEqual(segments[1].map((entry) => entry.tUs), [later, later + 500_000]);
  });
});
