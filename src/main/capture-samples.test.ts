import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PulseSample, SessionAnchor } from '../shared/contracts.js';
import {
  SDK_ERROR,
  VALIDATION,
  latestPulseSample,
  newPulseSamples,
  sdkErrorMessage,
  codeAt,
  toPulseSample,
  validationMessage,
  validationText,
  withOcclusion,
} from './capture-samples.js';

const anchor: SessionAnchor = { monoUs: 1_000_000, epochMs: 1_700_000_000_000 };
const baseUs = anchor.epochMs * 1000;

function reading(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    value: 62.5,
    confidence: 87,
    stable: true,
    timestamp: baseUs + 5_000_000,
    ...overrides,
  };
}

function payload(...readings: unknown[]): unknown {
  return { cardio: { pulseRate: readings } };
}

describe('latestPulseSample', () => {
  it('takes the newest reading and puts it on the session clock', () => {
    const sample = latestPulseSample(payload(reading()), anchor, anchor.monoUs);
    assert.deepEqual(sample, { tUs: 6_000_000, bpm: 62.5, confidence: 87, stable: true });
  });

  it('keeps every new reading in a payload, in order', () => {
    const fresh = newPulseSamples(
      payload(
        reading({ timestamp: baseUs + 2_000_000, value: 61 }),
        reading({ timestamp: baseUs + 3_000_000, value: 63 }),
        reading({ timestamp: baseUs + 3_000_000, value: 64 }),
      ),
      anchor,
      anchor.monoUs,
    );
    assert.deepEqual(
      fresh.map((sample) => [sample.tUs, sample.bpm]),
      [
        [3_000_000, 61],
        [4_000_000, 63],
      ],
    );
  });

  it('keeps an out-of-order reading that is still newer than the last one stored', () => {
    const fresh = newPulseSamples(
      payload(
        reading({ timestamp: baseUs + 6_000_000, value: 70 }),
        reading({ timestamp: baseUs + 2_000_000, value: 61 }),
        reading({ timestamp: baseUs + 4_000_000, value: 65 }),
      ),
      anchor,
      1_500_000,
    );
    assert.deepEqual(
      fresh.map((sample) => [sample.tUs, sample.bpm]),
      [
        [3_000_000, 61],
        [5_000_000, 65],
        [7_000_000, 70],
      ],
    );
  });

  it('skips readings older than the last stored one', () => {
    const fresh = newPulseSamples(
      payload(
        reading({ timestamp: baseUs + 1_000_000 }),
        reading({ timestamp: baseUs + 6_000_000 }),
      ),
      anchor,
      5_000_000,
    );
    assert.deepEqual(fresh.map((sample) => sample.tUs), [7_000_000]);
  });

  it('accepts a protobufjs Long timestamp', () => {
    const timestamp = baseUs + 3_000_000;
    const sample = latestPulseSample(
      payload(reading({ timestamp: { toNumber: () => timestamp } })),
      anchor,
      anchor.monoUs,
    );
    assert.equal(sample?.tUs, 4_000_000);
  });

  it('keeps a weak sample so coverage, not deletion, records the gap', () => {
    const sample = latestPulseSample(
      payload(reading({ confidence: 12, stable: false })),
      anchor,
      anchor.monoUs,
    );
    assert.deepEqual(sample, { tUs: 6_000_000, bpm: 62.5, confidence: 12, stable: false });
  });

  it('returns null without a pulse series', () => {
    assert.equal(latestPulseSample(null, anchor, anchor.monoUs), null);
    assert.equal(latestPulseSample({}, anchor, anchor.monoUs), null);
    assert.equal(latestPulseSample({ cardio: {} }, anchor, anchor.monoUs), null);
    assert.equal(latestPulseSample(payload(), anchor, anchor.monoUs), null);
  });

  it('drops a value that cannot be a pulse', () => {
    assert.equal(toPulseSample(reading({ value: 0 }), anchor, anchor.monoUs), null);
    assert.equal(toPulseSample(reading({ value: 500 }), anchor, anchor.monoUs), null);
    assert.equal(toPulseSample(reading({ value: Number.NaN }), anchor, anchor.monoUs), null);
    assert.equal(toPulseSample(reading({ value: '62' }), anchor, anchor.monoUs), null);
  });

  it('drops a confidence outside the percentage range', () => {
    assert.equal(toPulseSample(reading({ confidence: 150 }), anchor, anchor.monoUs), null);
    assert.equal(toPulseSample(reading({ confidence: -1 }), anchor, anchor.monoUs), null);
  });

  it('drops a repeated, backward, or pre-session timestamp', () => {
    assert.equal(toPulseSample(reading(), anchor, 6_000_000), null);
    assert.equal(toPulseSample(reading({ timestamp: baseUs + 1_000_000 }), anchor, 6_000_000), null);
    assert.equal(toPulseSample(reading({ timestamp: baseUs - 1_000_000 }), anchor, anchor.monoUs), null);
  });

  it('drops an unusable timestamp', () => {
    assert.equal(toPulseSample(reading({ timestamp: 0 }), anchor, anchor.monoUs), null);
    assert.equal(toPulseSample(reading({ timestamp: 1.5 }), anchor, anchor.monoUs), null);
    assert.equal(toPulseSample(reading({ timestamp: null }), anchor, anchor.monoUs), null);
  });
});

describe('validationMessage', () => {
  it('converts the epoch timestamp and keeps the SDK hint', () => {
    const message = validationMessage(VALIDATION.tooDark, baseUs + 2_000_000, '  Too dark.  ', anchor);
    assert.deepEqual(message, { code: VALIDATION.tooDark, ts: 3_000_000, hint: 'Too dark.' });
  });

  it('falls back to its own copy when the SDK sends no hint', () => {
    const message = validationMessage(VALIDATION.noFaceFound, baseUs + 2_000_000, '', anchor);
    assert.equal(message?.hint, 'Waiting for a face.');
  });

  it('ignores an unusable timestamp', () => {
    assert.equal(validationMessage(VALIDATION.tooDark, 0, 'Too dark.', anchor), null);
  });
});

describe('validationText', () => {
  it('trims a long hint to a readable length', () => {
    const text = validationText(VALIDATION.ok, 'x'.repeat(400));
    assert.equal(text.length, 240);
    assert.ok(text.endsWith('…'));
  });

  it('names an unknown code honestly', () => {
    assert.equal(validationText(999, ''), 'Measuring.');
  });
});

describe('sdkErrorMessage', () => {
  it('maps the failures the player actually meets', () => {
    assert.match(sdkErrorMessage(SDK_ERROR.authenticationFailed, ''), /SMARTSPECTRA_API_KEY/);
    assert.match(sdkErrorMessage(SDK_ERROR.inputUnavailable, ''), /No camera/);
    assert.match(sdkErrorMessage(SDK_ERROR.networkError, ''), /network/);
    assert.match(sdkErrorMessage(SDK_ERROR.creditExhausted, ''), /credit/);
    assert.match(sdkErrorMessage(SDK_ERROR.metricNotAuthorized, ''), /pulse/);
  });

  it('keeps the SDK detail for an unmapped code', () => {
    assert.equal(sdkErrorMessage(99, 'Something specific.'), 'Something specific. (sensing code 99)');
    assert.equal(sdkErrorMessage(99, ''), 'Sensing stopped unexpectedly (code 99).');
  });
});

describe('occlusion marking', () => {
  const samples: PulseSample[] = [
    { tUs: 1_000_000, bpm: 70, confidence: 80, stable: true },
    { tUs: 2_000_000, bpm: 72, confidence: 80, stable: true },
  ];

  it('marks every reading taken while a face or motion code was active', () => {
    for (const code of [VALIDATION.noFaceFound, VALIDATION.excessiveMotion, VALIDATION.faceTooClose]) {
      const marked = withOcclusion(samples, [{ fromUs: 0, code }]);
      assert.equal(marked.length, 2);
      assert.ok(marked.every((sample) => sample.occluded === true));
      assert.equal(marked[0]?.bpm, 70);
    }
  });

  it('leaves readings alone for measuring, lighting, and posture codes', () => {
    for (const code of [VALIDATION.ok, VALIDATION.tooDark, VALIDATION.tooBright]) {
      const unchanged = withOcclusion(samples, [{ fromUs: 0, code }]);
      assert.ok(unchanged.every((sample) => sample.occluded === undefined));
    }
  });

  it('judges each reading by its own timestamp when a batch crosses a change', () => {
    const sequence = [
      { fromUs: 0, code: VALIDATION.ok },
      { fromUs: 1_500_000, code: VALIDATION.noFaceFound },
    ];
    const marked = withOcclusion(samples, sequence);
    assert.equal(marked[0]?.occluded, undefined);
    assert.equal(marked[1]?.occluded, true);
    assert.equal(codeAt(sequence, 1_000_000), VALIDATION.ok);
    assert.equal(codeAt(sequence, 1_500_000), VALIDATION.noFaceFound);
    assert.equal(codeAt([], 1_000_000), VALIDATION.ok);
  });

  it('does not mutate the samples it was given', () => {
    withOcclusion(samples, [{ fromUs: 0, code: VALIDATION.noFaceFound }]);
    assert.equal(samples[0]?.occluded, undefined);
  });
});
