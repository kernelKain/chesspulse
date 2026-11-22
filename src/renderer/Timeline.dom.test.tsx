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
      harness.render(createElement(Timeline, { result: report, focus: { sessionId: 's1', tUs: 31_000_000, seq: 1 } }));
      const frame = harness.document.querySelector('.timeline-frame');
      assert.equal(harness.document.activeElement, frame);
      const moment = harness.document.querySelector('.inspector-moment');
      assert.match(moment?.textContent ?? '', /Reading 3 of 4/, 'focusing the chart keeps the requested reading');
    } finally {
      harness.unmount();
    }
  });

  it('ignores a request for another session and does not replay an earlier request on mount', () => {
    const earlier = { sessionId: 's1', tUs: 31_000_000, seq: 4 };
    const harness = mountDom(createElement(Timeline, { result: report, focus: earlier }));
    try {
      assert.notEqual(harness.document.activeElement, harness.document.querySelector('.timeline-frame'));
      harness.render(createElement(Timeline, { result: report, focus: { sessionId: 'other', tUs: 11_000_000, seq: 5 } }));
      assert.notEqual(harness.document.activeElement, harness.document.querySelector('.timeline-frame'));
      assert.doesNotMatch(harness.document.querySelector('.inspector-moment')?.textContent ?? '', /Reading \d of 4/);
    } finally {
      harness.unmount();
    }
  });
});
