import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { downscaleRgbToRgba } from './preview.js';
import {
  coachGapRequestSchema,
  coachMessageSchema,
  insightResultSchema,
  consentRequestSchema,
  previewFrameSchema,
  pasteValidationSchema,
  pgnValidateRequestSchema,
  pulseSampleSchema,
  refusalSchema,
  reportBuildRequestSchema,
  sessionEndedSchema,
  sessionStartedSchema,
  stopReasonSchema,
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

describe('session end contracts', () => {
  it('accepts stored storage and limit reasons but no unknown reason', () => {
    assert.equal(stopReasonSchema.safeParse('storage').success, true);
    assert.equal(stopReasonSchema.safeParse('limit').success, true);
    assert.equal(stopReasonSchema.safeParse('user').success, true);
    assert.equal(stopReasonSchema.safeParse('camera').success, false);
  });

  it('accepts only automatic-ended events with a player message', () => {
    const ended = {
      sessionId: '01TESTSESSION0000000000000',
      reason: 'storage',
      message: 'Sensing stopped because the pulse samples could not be saved.',
    };
    assert.deepEqual(sessionEndedSchema.parse(ended), ended);
    assert.equal(sessionEndedSchema.safeParse({ ...ended, reason: 'limit' }).success, true);
    assert.equal(sessionEndedSchema.safeParse({ ...ended, reason: 'user' }).success, false);
    assert.equal(sessionEndedSchema.safeParse({ ...ended, trace: [] }).success, false);
  });

  it('accepts a start event only with an id and a start time', () => {
    const started = { sessionId: '01TESTSESSION0000000000000', startedAtEpochMs: 1_700_000_000_000 };
    assert.deepEqual(sessionStartedSchema.parse(started), started);
    assert.equal(sessionStartedSchema.safeParse({ sessionId: started.sessionId }).success, false);
    assert.equal(
      sessionStartedSchema.safeParse({ ...started, startedAtEpochMs: 'now' }).success,
      false,
    );
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

describe('coach IPC contracts', () => {
  it('accepts computed coach numbers and rejects unvalidated fields', () => {
    const message = {
      baselineBpm: 70,
      recentBpm: 90,
      deltaBpm: 20,
      text: 'Pulse still +20 over baseline. Take a real break before the next game.',
    };
    assert.deepEqual(coachMessageSchema.parse(message), message);
    assert.equal(coachMessageSchema.safeParse({ ...message, rawPulse: [90] }).success, false);
    assert.equal(coachGapRequestSchema.safeParse({ betweenGames: true }).success, true);
    assert.equal(coachGapRequestSchema.safeParse({ betweenGames: 'yes' }).success, false);
    assert.equal(coachGapRequestSchema.safeParse({ betweenGames: true, liveGame: true }).success, false);
  });
});

describe('insightResultSchema', () => {
  it('separates untrusted narrative from disabled state and computed fields', () => {
    assert.equal(
      insightResultSchema.safeParse({ disabled: false, provider: 'openai', text: 'A grounded reading.' }).success,
      true,
    );
    assert.equal(insightResultSchema.safeParse({ disabled: true, reason: 'No key.' }).success, true);
    assert.equal(
      insightResultSchema.safeParse({ disabled: false, provider: 'openai', text: 'Reading.', accuracy: 99 }).success,
      false,
    );
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

describe('previewFrameSchema', () => {
  const frame = { width: 320, height: 180, light: 0.42, rgba: new Uint8Array(320 * 180 * 4) };

  it('accepts a bounded preview frame', () => {
    const parsed = previewFrameSchema.parse(frame);
    assert.equal(parsed.width, 320);
    assert.equal(parsed.light, 0.42);
    assert.equal(parsed.rgba.byteLength, 320 * 180 * 4);
  });

  it('accepts real converter output', () => {
    const source = new Uint8Array(4 * 2 * 3);
    const converted = downscaleRgbToRgba(source, 4, 2, 12, 32);
    assert.equal(previewFrameSchema.safeParse(converted).success, true);
  });

  it('rejects bytes that do not match the frame size', () => {
    assert.equal(previewFrameSchema.safeParse({ ...frame, rgba: new Uint8Array(4) }).success, false);
    assert.equal(
      previewFrameSchema.safeParse({ ...frame, rgba: new Uint8Array(320 * 180 * 4 + 4) }).success,
      false,
    );
  });

  it('rejects a fractional size, a light outside 0-1, or non-binary pixels', () => {
    assert.equal(previewFrameSchema.safeParse({ ...frame, width: 320.5 }).success, false);
    assert.equal(previewFrameSchema.safeParse({ ...frame, width: 4000 }).success, false);
    assert.equal(previewFrameSchema.safeParse({ ...frame, light: 1.5 }).success, false);
    assert.equal(previewFrameSchema.safeParse({ ...frame, rgba: [1, 2, 3] }).success, false);
    assert.equal(previewFrameSchema.safeParse({ width: 320, height: 180, light: 0.4 }).success, false);
  });
});
