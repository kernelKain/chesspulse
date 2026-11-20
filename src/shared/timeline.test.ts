import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PulseSample, Refusal, Report } from './contracts.js';
import {
  alignmentConfidenceLabel,
  buildTimelineView,
  CPL_CAP,
  cplBarRatio,
  endingMark,
  formatElapsed,
  sampleReadout,
  splitPulseRuns,
  THINK_CAP_SEC,
  thinkTimeRatio,
} from './timeline.js';

function sample(tSec: number, bpm: number, confidence = 80, stable = true): PulseSample {
  return { tUs: tSec * 1_000_000, bpm, confidence, stable };
}

function baseReport(overrides: Partial<Report> = {}): Report {
  return {
    ok: true,
    sessionId: '01TESTSESSION0000000000000',
    coveragePct: 92,
    baselineBpm: 70,
    verdict: '1 blunder, 1 of them while your pulse was elevated.',
    settled: { band: 'settled', moves: 6, status: 'ok', accuracy: 82 },
    elevated: { band: 'elevated', moves: 5, status: 'ok', accuracy: 58 },
    alignmentMode: 'endtime',
    toleranceSec: 1,
    timeline: {
      startUs: 0,
      stopUs: 60_000_000,
      baselineBpm: 70,
      elevatedThresholdBpm: 80,
      samples: [sample(0, 70), sample(1, 72), sample(2, 84), sample(3, 86)],
      games: [
        {
          index: 0,
          white: 'Ada',
          black: 'Nim',
          result: '1-0',
          ending: 'checkmate',
          includeInStats: true,
          startUs: 0,
          endUs: 30_000_000,
        },
      ],
      moves: [
        {
          gameIndex: 0,
          moveIndex: 0,
          san: 'e4',
          tUs: 2_000_000,
          cpl: 140,
          thinkSec: 4.5,
          blunder: true,
          band: 'elevated',
        },
      ],
    },
    ...overrides,
  };
}

describe('splitPulseRuns', () => {
  it('breaks runs across gaps and weak samples and separates elevated stretches', () => {
    const samples = [
      sample(0, 70),
      sample(1, 74),
      sample(2, 84), // crosses threshold 80
      sample(3, 86),
      sample(4, 65, 20, true), // weak sample: kept raw, breaks usable run
      sample(5, 72),
      sample(10, 82), // 5-second hole: must not bridge
    ];
    const { usableRuns, weakSamples } = splitPulseRuns(samples, 80);
    assert.equal(weakSamples.length, 1);
    assert.equal(weakSamples[0]?.tUs, 4_000_000);
    assert.equal(usableRuns.length, 4);
    assert.equal(usableRuns[0]?.kind, 'settled');
    assert.equal(usableRuns[0]?.points.length, 2);
    assert.equal(usableRuns[1]?.kind, 'elevated');
    // Boundary sample at t=1 is shared so crossing the threshold has no artificial hole.
    assert.equal(usableRuns[1]?.points[0]?.tUs, 1_000_000);
    assert.equal(usableRuns[1]?.points[2]?.tUs, 3_000_000);
    assert.equal(usableRuns[2]?.kind, 'settled');
    assert.equal(usableRuns[2]?.points.length, 1);
    assert.equal(usableRuns[3]?.kind, 'elevated');
    assert.equal(usableRuns[3]?.points.length, 1);
  });
});

describe('buildTimelineView', () => {
  it('returns the empty state when there is no report', () => {
    const view = buildTimelineView(null);
    assert.equal(view.state, 'empty');
    assert.equal(view.samples.length, 0);
    assert.equal(sampleReadout(view, 0), 'Nothing recorded yet.');
  });

  it('returns low_coverage with desaturated raw trace and no elevated threshold', () => {
    const refusal: Refusal = {
      ok: false,
      reason: 'low_coverage',
      measured: 41,
      threshold: 70,
      remedy: 'Sit facing the screen with a lamp in front of you.',
      trace: {
        startUs: 0,
        stopUs: 10_000_000,
        baselineBpm: 70,
        samples: [sample(0, 70), sample(1, 95), sample(5, 72)],
      },
    };
    const view = buildTimelineView(refusal);
    assert.equal(view.state, 'low_coverage');
    assert.equal(view.elevatedThresholdBpm, undefined);
    assert.equal(view.games.length, 0);
    assert.equal(view.moves.length, 0);
    // All usable runs stay 'settled' (desaturated) because bands are withheld on refusal.
    assert.ok(view.usableRuns.every((run) => run.kind === 'settled'));
    assert.equal(view.usableRuns.length, 2); // gap between 1s and 5s preserved
    assert.match(sampleReadout(view, 1), /bands withheld/);
  });

  it('returns aligned for EndTime reports and low_confidence when a banner or non-EndTime mode is present', () => {
    const aligned = buildTimelineView(baseReport());
    assert.equal(aligned.state, 'aligned');
    assert.equal(aligned.confidenceLabel, 'Aligned from EndTime (±1 s)');
    assert.match(sampleReadout(aligned, 2), /elevated/);
    assert.match(sampleReadout(aligned, 2), /e4 \(140 cpl, 4.5 s think, blunder\)/);

    const lowConf = buildTimelineView(
      baseReport({
        alignmentMode: 'starttime',
        toleranceSec: 90,
        banner: 'No `EndTime` in these PGNs. Games were placed from start times only — expect ±90 s of drift.',
      }),
    );
    assert.equal(lowConf.state, 'low_confidence');
    assert.equal(lowConf.confidenceLabel, 'Aligned from start time (±90 s)');
    assert.match(lowConf.banner ?? '', /±90 s/);
  });
});

describe('timeline helpers', () => {
  it('caps CPL and think-time ratios and formats endings and timestamps', () => {
    assert.equal(cplBarRatio(null), 0);
    assert.equal(cplBarRatio(CPL_CAP * 4), 1);
    assert.equal(cplBarRatio(CPL_CAP / 2), 0.5);
    assert.equal(thinkTimeRatio(THINK_CAP_SEC * 2), 1);
    assert.equal(formatElapsed(125_000_000, 0), '2:05');
    assert.deepEqual(endingMark('resignation'), { glyph: '✕', label: 'resignation' });
    assert.deepEqual(endingMark('timeout'), { glyph: '⏱', label: 'timeout' });
    assert.deepEqual(endingMark('checkmate'), { glyph: '♚', label: 'mate' });
    assert.deepEqual(endingMark('abandoned'), { glyph: '⊘', label: 'abandoned' });
    assert.equal(
      alignmentConfidenceLabel({ alignmentMode: 'inferred', toleranceSec: 18 }),
      'Inferred from paste order (±18 s)',
    );
  });
});
