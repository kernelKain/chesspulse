import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PulseSample } from './contracts.js';
import {
  SAMPLE_HOLD_US,
  formatElapsedMs,
  limitWarning,
  occludedUs,
  signalQuality,
  signalStale,
  traceSegments,
} from './sensing.js';

function sample(tUs: number, confidence = 80, stable = true): PulseSample {
  return { tUs, bpm: 70, confidence, stable };
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

describe('signalQuality', () => {
  it('waits with no samples', () => {
    assert.deepEqual(signalQuality([]), {
      quality: 'waiting',
      label: 'Waiting for samples',
      usable: 0,
      total: 0,
    });
  });

  it('rates the trailing minute by usable-sample share', () => {
    const second = 1_000_000;
    const good = signalQuality(
      Array.from({ length: 10 }, (_item, index) => sample(index * second)),
    );
    assert.equal(good.quality, 'good');
    assert.equal(good.usable, 10);

    const weak = signalQuality([
      ...Array.from({ length: 6 }, (_item, index) => sample(index * second)),
      ...Array.from({ length: 4 }, (_item, index) => sample((6 + index) * second, 10)),
    ]);
    assert.equal(weak.quality, 'weak');

    const poor = signalQuality([
      ...Array.from({ length: 4 }, (_item, index) => sample(index * second)),
      ...Array.from({ length: 6 }, (_item, index) => sample((4 + index) * second, 10)),
    ]);
    assert.equal(poor.quality, 'poor');
    assert.match(poor.label, /lighting/);
  });

  it('ignores samples older than the window and unstable readings', () => {
    const second = 1_000_000;
    const result = signalQuality([
      sample(0),
      sample(second),
      sample(70 * second, 80, false),
    ]);
    assert.equal(result.total, 1);
    assert.equal(result.usable, 0);
    assert.equal(result.quality, 'poor');
  });
});

describe('signalStale', () => {
  it('treats no sample yet as waiting, not stale', () => {
    assert.equal(signalStale(null, 10_000), false);
  });

  it('goes stale after five quiet seconds', () => {
    assert.equal(signalStale(1_000, 5_999), false);
    assert.equal(signalStale(1_000, 6_001), true);
  });
});

describe('session clock', () => {
  it('formats elapsed time from minutes to hours', () => {
    assert.equal(formatElapsedMs(-1), '0:00');
    assert.equal(formatElapsedMs(0), '0:00');
    assert.equal(formatElapsedMs(65_000), '1:05');
    assert.equal(formatElapsedMs(3_661_000), '1:01:01');
  });

  it('warns only from 80 minutes and names the remaining time', () => {
    assert.equal(limitWarning(79 * 60_000), null);
    assert.equal(limitWarning(80 * 60_000), '10 minutes left before the 90-minute limit.');
    assert.equal(limitWarning(89 * 60_000 + 30_000), '1 minute left before the 90-minute limit.');
    assert.match(limitWarning(90 * 60_000) ?? '', /limit is reached/);
  });
});

describe('occludedUs', () => {
  it('counts a marked sample to the next sample, capped by the hold time', () => {
    const samples: PulseSample[] = [
      { ...sample(1_000_000), occluded: true },
      sample(2_000_000),
      { ...sample(4_000_000), occluded: true },
      sample(9_000_000),
    ];
    // 1 s to the next sample, then 5 s capped at the 1 s hold.
    assert.equal(occludedUs(samples, 10_000_000), 2 * SAMPLE_HOLD_US);
  });

  it('uses the session stop for a marked final sample', () => {
    const samples: PulseSample[] = [sample(1_000_000), { ...sample(2_000_000), occluded: true }];
    assert.equal(occludedUs(samples, 2_500_000), 500_000);
    assert.equal(occludedUs(samples, 9_000_000), SAMPLE_HOLD_US);
  });
});
