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

describe('Timeline legend and keyboard readout', () => {
  it('shows a text legend for every chart encoding', () => {
    const harness = mountDom(createElement(Timeline, { result: refusal }));
    const legend = harness.document.querySelector('[aria-label="Timeline key"]');
    assert.ok(legend);
    const text = legend.textContent ?? '';
    for (const label of ['Pulse', 'Move error (CPL)', 'Think time', 'Elevated pulse', 'Game ending']) {
      assert.match(text, new RegExp(label.replace(/[()]/g, '\\$&')));
    }
    assert.ok(harness.document.querySelector('.legend-hatch'));
    harness.unmount();
  });

  it('steps the sample readout with the arrow keys', () => {
    const harness = mountDom(createElement(Timeline, { result: refusal }));
    const frame = harness.document.querySelector('.timeline-frame');
    assert.ok(frame);
    harness.keyDown(frame, 'ArrowRight');
    harness.keyDown(frame, 'ArrowRight');
    const readout = harness.document.querySelector('.timeline-readout')?.textContent ?? '';
    assert.match(readout, /84(\.\d)? bpm/);
    harness.unmount();
  });
});
