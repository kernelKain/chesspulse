import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import type { Refusal, Report } from '../shared/contracts.js';
import { mountDom } from './dom-harness.js';
import { Timeline } from './Timeline.js';

const refusal: Refusal = {
  ok: false,
  reason: 'low_coverage',
  measured: 20,
  threshold: 70,
  remedy: 'Sit facing the screen with a lamp in front of you.',
  trace: {
    startUs: 0,
    stopUs: 60_000_000,
    baselineBpm: 80,
    samples: [
      { tUs: 1_000_000, bpm: 78, confidence: 90, stable: true },
      { tUs: 2_000_000, bpm: 84, confidence: 88, stable: true },
    ],
  },
};

describe('Timeline key and inspector', () => {
  it('explains only the encodings a refused trace shows, beside the chart', () => {
    const harness = mountDom(createElement(Timeline, { result: refusal }));
    try {
      const key = harness.document.querySelector('[aria-label="Timeline key"]');
      assert.ok(key);
      assert.ok(key.closest('.timeline-inspector'), 'the key sits in the inspector beside the chart');
      const terms = [...key.querySelectorAll('dt')].map((node) => node.textContent);
      assert.deepEqual(terms, ['Pulse', 'Baseline', 'Gaps and faint dots']);
      assert.equal(harness.document.querySelector('.timeline-legend'), null, 'the old legend row is gone');
    } finally {
      harness.unmount();
    }
  });

  it('shows labelled facts for the reading the arrow keys select', () => {
    const harness = mountDom(createElement(Timeline, { result: refusal }));
    try {
      const frame = harness.document.querySelector('.timeline-frame');
      assert.ok(frame);
      assert.match(harness.document.querySelector('.inspector-moment')?.textContent ?? '', /press ← or →/);
      harness.keyDown(frame, 'ArrowRight');
      harness.keyDown(frame, 'ArrowRight');
      const moment = harness.document.querySelector('.inspector-moment');
      assert.ok(moment);
      assert.equal(moment.getAttribute('aria-live'), 'polite');
      const facts = Object.fromEntries(
        [...moment.querySelectorAll('.fact')].map((node) => [node.querySelector('dt')?.textContent, node.querySelector('dd')?.textContent]),
      );
      assert.equal(facts['Pulse'], '84 bpm');
      assert.equal(facts['Time in session'], '0:02');
      assert.equal(facts['Pulse range'], 'Not banded: coverage was too low');
      assert.match(moment.textContent ?? '', /Reading 2 of 2/);
      assert.equal((moment.textContent ?? '').includes('Sample '), false, 'no raw "Sample n/m" line');
    } finally {
      harness.unmount();
    }
  });
});

const report: Report = {
  ok: true,
  schemaVersion: 1,
  sessionId: 's1',
  gamesDigest: 'c'.repeat(64),
  coveragePct: 95,
  baselineBpm: 80,
  verdict: 'v.',
  settled: { band: 'settled', moves: 3, status: 'insufficient' },
  elevated: { band: 'elevated', moves: 0, status: 'insufficient' },
  engine: { depth: 12, positions: 0, scored: 0, failed: 0, reasons: { timeout: 0, crash: 0, engine: 0, budget: 0 } },
  alignmentMode: 'marks',
  toleranceSec: 0,
  games: [],
  timeline: {
    startUs: 0,
    stopUs: 60_000_000,
    baselineBpm: 80,
    elevatedThresholdBpm: 90,
    samples: [10, 20, 30, 40].map((sec) => ({ tUs: sec * 1_000_000, bpm: 80 + sec / 10, confidence: 95, stable: true })),
    games: [],
    moves: [],
  },
};

describe('Timeline focus request', () => {
  it('selects the reading nearest a requested moment and moves focus to the chart', () => {
    const harness = mountDom(createElement(Timeline, { result: report, focus: null }));
    try {
      harness.render(createElement(Timeline, { result: report, focus: { sessionId: 's1', tUs: 31_000_000, gameIndex: 0, moveIndex: 0, seq: 1 } }));
      const frame = harness.document.querySelector('.timeline-frame');
      assert.equal(harness.document.activeElement, frame);
      const moment = harness.document.querySelector('.inspector-moment');
      assert.match(moment?.textContent ?? '', /Reading 3 of 4/, 'focusing the chart keeps the requested reading');
    } finally {
      harness.unmount();
    }
  });

  it('ignores a request for another session and does not replay an earlier request on mount', () => {
    const earlier = { sessionId: 's1', tUs: 31_000_000, gameIndex: 0, moveIndex: 0, seq: 4 };
    const harness = mountDom(createElement(Timeline, { result: report, focus: earlier }));
    try {
      assert.notEqual(harness.document.activeElement, harness.document.querySelector('.timeline-frame'));
      harness.render(createElement(Timeline, { result: report, focus: { sessionId: 'other', tUs: 11_000_000, gameIndex: 0, moveIndex: 0, seq: 5 } }));
      assert.notEqual(harness.document.activeElement, harness.document.querySelector('.timeline-frame'));
      assert.doesNotMatch(harness.document.querySelector('.inspector-moment')?.textContent ?? '', /Reading \d of 4/);
    } finally {
      harness.unmount();
    }
  });
});

describe('Timeline focus keeps the requested move', () => {
  const move = (moveIndex: number, san: string, tUs: number) => ({
    gameIndex: 0, moveIndex, san, tUs, cpl: 40, thinkSec: 1, blunder: false, mate: false, scored: true, band: 'settled' as const,
  });
  // Readings every second from 29 s. Two moves share 31.0 s (a premove), and 7… Qh4 sits between readings.
  const withMoves: Report = {
    ...report,
    games: [{ index: 0, white: 'Ada', black: 'Nim', result: '1-0', ending: 'resignation', includeInStats: true, moveCount: 20, blunders: 0, aligned: true }],
    timeline: {
      ...report.timeline,
      samples: [29, 30, 31, 32].map((sec) => ({ tUs: sec * 1_000_000, bpm: 80, confidence: 95, stable: true })),
      games: [{ index: 0, white: 'Ada', black: 'Nim', result: '1-0', ending: 'resignation', includeInStats: true, startUs: 0, endUs: 60_000_000 }],
      moves: [move(12, 'Nf3', 31_000_000), move(13, 'Qh4', 30_600_000), move(14, 'g3', 31_000_000)],
    },
  };
  const nearestMove = (harness: ReturnType<typeof mountDom>) =>
    [...harness.document.querySelectorAll('.inspector-moment .fact')]
      .find((node) => node.querySelector('dt')?.textContent === 'Nearest move')
      ?.querySelector('dd')?.textContent;

  it('names the requested move at an exact reading and between readings, then the nearest move after a step', () => {
    const harness = mountDom(createElement(Timeline, { result: withMoves, focus: null }));
    try {
      // Exact: 8. g3 is at 31.0 s, the same reading as 7. Nf3, which nearest-move would pick first.
      harness.render(createElement(Timeline, { result: withMoves, focus: { sessionId: 's1', tUs: 31_000_000, gameIndex: 0, moveIndex: 14, seq: 1 } }));
      assert.match(harness.document.querySelector('.inspector-moment')?.textContent ?? '', /Reading 3 of 4/);
      assert.equal(nearestMove(harness), '8. g3');
      // Offset: 7… Qh4 at 30.6 s selects the 31 s reading, whose nearest move is a different one.
      harness.render(createElement(Timeline, { result: withMoves, focus: { sessionId: 's1', tUs: 30_600_000, gameIndex: 0, moveIndex: 13, seq: 2 } }));
      assert.match(harness.document.querySelector('.inspector-moment')?.textContent ?? '', /Reading 3 of 4/);
      assert.equal(nearestMove(harness), '7… Qh4');
      // Stepping returns to the nearest move for each reading.
      const frame = harness.document.querySelector('.timeline-frame');
      assert.ok(frame);
      harness.keyDown(frame, 'ArrowLeft');
      harness.keyDown(frame, 'ArrowRight');
      assert.equal(nearestMove(harness), '7. Nf3');
    } finally {
      harness.unmount();
    }
  });
});
