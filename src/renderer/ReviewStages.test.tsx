// What: the Review's three stage panels, checked without Electron.
// Why: R6-04 fixes the order (pulse, engine, reading), and a blocked stage must say who blocked it.
// Removed: the order and the disabled reasons would be reviewed by eye only.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { StageView } from '../shared/stages.js';
import { COPY } from './copy.js';
import { ReviewStages } from './ReviewStages.js';

function stage(
  index: 1 | 2 | 3,
  id: StageView['id'],
  state: StageView['state'],
  reason: StageView['reason'],
): StageView {
  return { index, id, state, reason };
}

describe('ReviewStages markup', () => {
  it('renders the three stages in order with their names', () => {
    const html = renderToStaticMarkup(
      createElement(ReviewStages, {
        stages: [
          stage(1, 'pulse', 'ready', null),
          stage(2, 'engine', 'ready', null),
          stage(3, 'reading', 'ready', null),
        ],
        bodies: { pulse: 'trace', engine: 'bands', reading: 'reading' },
      }),
    );
    const order = ['Stage 1 · Pulse', 'Stage 2 · Engine', 'Stage 3 · Reading'].map((label) =>
      html.indexOf(label),
    );
    assert.ok(order.every((at) => at >= 0), 'a stage heading is missing');
    assert.deepEqual([...order].sort((left, right) => left - right), order);
  });

  it('shows a disabled reading with its reason and no body', () => {
    const html = renderToStaticMarkup(
      createElement(ReviewStages, {
        stages: [
          stage(1, 'pulse', 'ready', null),
          stage(2, 'engine', 'ready', null),
          stage(3, 'reading', 'disabled', 'no_key'),
        ],
        bodies: { pulse: 'trace', engine: 'bands', reading: 'reading' },
      }),
    );
    assert.match(html, new RegExp(COPY.stages.reasons.no_key));
    assert.equal(html.includes('>reading<'), false);
  });

  it('names Stage 1 as the reason the later stages are blocked', () => {
    const html = renderToStaticMarkup(
      createElement(ReviewStages, {
        stages: [
          stage(1, 'pulse', 'refused', 'low_coverage'),
          stage(2, 'engine', 'disabled', 'blocked'),
          stage(3, 'reading', 'disabled', 'blocked'),
        ],
        bodies: { pulse: 'refusal' },
      }),
    );
    assert.equal((html.match(new RegExp(COPY.stages.reasons.blocked, 'g')) ?? []).length, 2);
    // Stage 1 carries the refusal panel, so it shows the body rather than a reason line.
    assert.match(html, /data-state="refused"/);
    assert.equal(html.includes(COPY.stages.reasons.low_coverage), false);
  });
});
