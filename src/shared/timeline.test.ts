import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PulseSample, Refusal, Report } from './contracts.js';
import {
  alignmentConfidenceLabel,
  buildGameMiniViews,
  buildTimelineView,
  CPL_CAP,
  cplBarRatio,
  endingMark,
  engineCalibrationNote,
  engineFailureNote,
  formatElapsed,
  moveTableRows,
  sampleReadout,
  sampleStatusText,
  sampleTableRows,
  splitPulseRuns,
  THINK_CAP_SEC,
  thinkTimeRatio,
  timeTicks,
} from './timeline.js';

function sample(tSec: number, bpm: number, confidence = 80, stable = true): PulseSample {
  return { tUs: tSec * 1_000_000, bpm, confidence, stable };
}

function baseReport(overrides: Partial<Report> = {}): Report {
  return {
    ok: true,
    sessionId: '01TESTSESSION0000000000000',
    gamesDigest: 'a'.repeat(64),
    coveragePct: 92,
    baselineBpm: 70,
    verdict: '1 blunder, 1 of them while your pulse was elevated.',
    settled: { band: 'settled', moves: 6, status: 'ok', accuracy: 82 },
    elevated: { band: 'elevated', moves: 5, status: 'ok', accuracy: 58 },
    engine: {
      depth: 12,
      positions: 10,
      scored: 10,
      failed: 0,
      reasons: { timeout: 0, crash: 0, engine: 0, budget: 0 },
    },
    alignmentMode: 'endtime',
    toleranceSec: 1,
    games: [
      {
        index: 0,
        white: 'Ada',
        black: 'Nim',
        result: '1-0',
        ending: 'checkmate',
        includeInStats: true,
        moveCount: 1,
        blunders: 1,
        aligned: true,
        timeControl: '60',
      },
    ],
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
          mate: false,
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

    const crossed = baseReport();
    crossed.timeline.samples = [sample(9.2, 72), sample(11, 74)];
    crossed.timeline.games = [
      {
        index: 0,
        white: 'Ada',
        black: 'Nim',
        result: '1-0',
        ending: 'checkmate',
        includeInStats: true,
        startUs: 0,
        endUs: 10_000_000,
      },
      {
        index: 1,
        white: 'Nim',
        black: 'Ada',
        result: '0-1',
        ending: 'resignation',
        includeInStats: true,
        startUs: 10_000_000,
        endUs: 20_000_000,
      },
    ];
    crossed.timeline.moves = [
      {
        gameIndex: 0,
        moveIndex: 0,
        san: 'e4',
        tUs: 2_000_000,
        cpl: 10,
        thinkSec: 1,
        blunder: false,
        mate: false,
        band: 'settled',
      },
      {
        gameIndex: 1,
        moveIndex: 0,
        san: 'Nf3',
        tUs: 10_500_000,
        cpl: 20,
        thinkSec: 2,
        blunder: false,
        mate: false,
        band: 'settled',
      },
    ];
    const duringFirst = buildTimelineView(crossed);
    assert.match(sampleReadout(duringFirst, 0), /Game 1/);
    assert.doesNotMatch(sampleReadout(duringFirst, 0), /Nf3/);
    assert.match(sampleReadout(duringFirst, 1), /Game 2/);
    assert.match(sampleReadout(duringFirst, 1), /Nf3 \(20 cpl, 2 s think\)/);

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

  it('keeps the bpm axis ordered when every reading is below 35 or above 200', () => {
    const low = baseReport();
    low.baselineBpm = 20;
    low.timeline.baselineBpm = 20;
    low.timeline.elevatedThresholdBpm = 30;
    low.timeline.samples = [sample(0, 18), sample(1, 22)];
    const lowView = buildTimelineView(low);
    assert.equal(lowView.yMinBpm, 35);
    assert.equal(lowView.yMaxBpm, 55);

    const high = baseReport();
    high.baselineBpm = 250;
    high.timeline.baselineBpm = 250;
    high.timeline.elevatedThresholdBpm = 260;
    high.timeline.samples = [sample(0, 240), sample(1, 255)];
    const highView = buildTimelineView(high);
    assert.equal(highView.yMinBpm, 180);
    assert.equal(highView.yMaxBpm, 200);
  });
});

describe('timeline helpers', () => {
  it('caps CPL and think-time ratios and formats endings and timestamps', () => {
    assert.equal(cplBarRatio(null), 0);
    assert.equal(cplBarRatio(CPL_CAP * 4), 1);
    assert.equal(cplBarRatio(CPL_CAP / 2), 0.5);
    assert.equal(thinkTimeRatio(THINK_CAP_SEC * 2), 1);
    assert.equal(formatElapsed(125_000_000, 0), '2:05');
    assert.equal(sampleStatusText(sample(0, 84), 80), 'elevated');
    assert.equal(sampleStatusText(sample(0, 70), 80), 'settled');
    assert.equal(sampleStatusText(sample(0, 70, 20, false), 80), 'low confidence (20)');
    assert.equal(sampleStatusText(sample(0, 70), undefined), 'raw trace, bands withheld');
    assert.deepEqual(endingMark('resignation'), { glyph: '✕', label: 'resignation' });
    assert.deepEqual(endingMark('timeout'), { glyph: '⏱', label: 'timeout' });
    assert.deepEqual(endingMark('checkmate'), { glyph: '♚', label: 'mate' });
    assert.deepEqual(endingMark('abandoned'), { glyph: '⊘', label: 'abandoned' });
    assert.equal(
      alignmentConfidenceLabel({ alignmentMode: 'inferred', toleranceSec: 18 }),
      'Inferred from paste order (±18 s)',
    );
  });

  it('produces table rows for moves and samples, marking gaps and withholding bands on refusal', () => {
    const aligned = buildTimelineView(baseReport());
    const moves = moveTableRows(aligned);
    assert.equal(moves.length, 1);
    assert.deepEqual(moves[0], {
      gameLabel: 'G1',
      time: '0:02',
      san: 'e4',
      pulseBpm: '84 bpm',
      band: 'Elevated',
      cpl: '140 cp',
      think: '4.5 s',
      note: 'Blunder',
    });

    const refusalView = buildTimelineView({
      ok: false,
      reason: 'low_coverage',
      measured: 40,
      threshold: 70,
      remedy: 'Sit facing a lamp.',
      trace: {
        startUs: 0,
        stopUs: 10_000_000,
        samples: [sample(0, 70), sample(4, 92), sample(5, 68, 20, true)],
      },
    });
    assert.deepEqual(moveTableRows(refusalView), []);
    const samples = sampleTableRows(refusalView);
    assert.equal(samples.length, 3);
    assert.equal(samples[0]?.status, 'Raw (bands withheld)');
    assert.equal(samples[1]?.gapBeforeSec, 4);
    assert.equal(samples[1]?.status, 'Raw (bands withheld)');
    assert.equal(samples[2]?.status, 'Low confidence');
  });

  it('shows a mate move without a centipawn value', () => {
    const report = baseReport();
    const original = report.timeline.moves[0];
    assert.ok(original);
    report.timeline.moves[0] = { ...original, cpl: null, mate: true, blunder: false };
    const view = buildTimelineView(report);
    const row = moveTableRows(view)[0];
    assert.equal(row?.cpl, 'Mate');
    assert.equal(row?.note, 'Mate');
    assert.match(sampleReadout(view, 2), /e4 \(mate, 4\.5 s think\)/);
  });

  it('states the engine depth and its calibration limit', () => {
    assert.equal(
      engineCalibrationNote({
        depth: 12,
        positions: 10,
        scored: 10,
        failed: 0,
        reasons: { timeout: 0, crash: 0, engine: 0, budget: 0 },
      }),
      'Engine depth 12. Speed is checked on fixtures; move accuracy is not calibrated against your games.',
    );
  });

  it('states why engine positions were left out', () => {
    assert.equal(
      engineFailureNote({
        depth: 12,
        positions: 10,
        scored: 10,
        failed: 0,
        reasons: { timeout: 0, crash: 0, engine: 0, budget: 0 },
      }),
      null,
    );
    assert.equal(
      engineFailureNote({
        depth: 12,
        positions: 10,
        scored: 7,
        failed: 3,
        reasons: { timeout: 3, crash: 0, engine: 0, budget: 0 },
      }),
      '3 positions timed out and were left out.',
    );
    const mixed = engineFailureNote({
      depth: 12,
      positions: 10,
      scored: 6,
      failed: 4,
      reasons: { timeout: 2, crash: 1, engine: 0, budget: 1 },
    });
    assert.match(mixed ?? '', /2 positions timed out/);
    assert.match(mixed ?? '', /1 position hit a worker failure/);
    assert.match(mixed ?? '', /1 position ran out of the time budget/);
    assert.match(mixed ?? '', /4 positions were left out/);
  });

  it('builds stacked per-game mini-timeline views sharing the session bpm scale', () => {
    const view = buildTimelineView(baseReport());
    const minis = buildGameMiniViews(view);
    assert.equal(minis.length, 1);
    assert.equal(minis[0]?.game.index, 0);
    assert.equal(minis[0]?.ending.glyph, '♚');
    assert.equal(minis[0]?.spanLabel, '0:00 – 0:30');
    assert.equal(minis[0]?.yMinBpm, view.yMinBpm);
    assert.equal(minis[0]?.yMaxBpm, view.yMaxBpm);
    assert.equal(minis[0]?.moves.length, 1);
    assert.equal(minis[0]?.usableRuns.length, 2);

    const refusalView = buildTimelineView({
      ok: false,
      reason: 'low_coverage',
      measured: 30,
      threshold: 70,
      remedy: 'Sit facing a lamp.',
      trace: { startUs: 0, stopUs: 10_000_000, samples: [sample(0, 70)] },
    });
    assert.deepEqual(buildGameMiniViews(refusalView), []);
  });

  it('omits a nearby interior time tick so the endpoint label does not overlap', () => {
    const closeEnd = timeTicks(0, 905 * 1_000_000);
    assert.deepEqual(
      closeEnd.map((t) => t / 1_000_000),
      [0, 300, 600, 905],
    );
    const spacedEnd = timeTicks(0, 1000 * 1_000_000);
    assert.deepEqual(
      spacedEnd.map((t) => t / 1_000_000),
      [0, 300, 600, 900, 1000],
    );
  });
});
