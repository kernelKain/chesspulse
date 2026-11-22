import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import type { Refusal } from '../shared/contracts.js';
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
