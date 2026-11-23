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
    const order = [COPY.stages.titles.pulse, COPY.stages.titles.engine, COPY.stages.titles.reading]
      .map((label) => label.replace('&', '&amp;'))
      .map((label) => html.indexOf(`>${label}</h2>`));
    assert.ok(order.every((at) => at >= 0), 'a section heading is missing');
    assert.deepEqual([...order].sort((left, right) => left - right), order);
    assert.equal(/Stage \d/.test(html), false, 'internal stage numbers are not shown');
    assert.ok(html.includes(COPY.stages.descriptions.engine));
  });
  it('shows a section aside in light text beside the state', () => {
    const html = renderToStaticMarkup(
      createElement(ReviewStages, {
        stages: [stage(1, 'pulse', 'ready', null), stage(2, 'engine', 'ready', null), stage(3, 'reading', 'ready', null)],
        bodies: { pulse: 'trace', engine: 'bands', reading: 'reading' },
        asides: { engine: COPY.stages.engineBadge('Stockfish', '19.0.1', 12) },
      }),
    );
    assert.match(html, /<span class="stage-aside">Stockfish 19\.0\.1 · depth 12 · runs locally<\/span>/);
    assert.equal((html.match(/stage-aside/g) ?? []).length, 1);
    assert.equal(COPY.stages.engineBadge('Stockfish', undefined, 12), 'Stockfish · depth 12 · local');
  });

  it('keeps the reading panel and its controls when the reading is disabled', () => {
    const html = renderToStaticMarkup(
      createElement(ReviewStages, {
        stages: [
          stage(1, 'pulse', 'ready', null),
          stage(2, 'engine', 'ready', null),
          stage(3, 'reading', 'disabled', 'no_key'),
        ],
        bodies: { pulse: 'trace', engine: 'bands', reading: 'selector' },
      }),
    );
    assert.match(html, />selector</);
    assert.match(html, /Disabled/);
    // The panel says why it is disabled; the generic line would repeat it badly.
    assert.equal(html.includes(COPY.stages.reasons.no_key), false);
  });

  it('shows the service detail instead of the generic reason when there is no body', () => {
    const html = renderToStaticMarkup(
      createElement(ReviewStages, {
        stages: [
          stage(1, 'pulse', 'ready', null),
          stage(2, 'engine', 'ready', null),
          { ...stage(3, 'reading', 'disabled', 'no_key'), detail: 'The custom endpoint is missing.' },
        ],
        bodies: { pulse: 'trace', engine: 'bands' },
      }),
    );
    assert.match(html, /The custom endpoint is missing\./);
    assert.equal(html.includes(COPY.stages.reasons.no_key), false);
  });

  it('names the pulse timeline as the reason the later sections are blocked', () => {
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
    // The pulse section carries the refusal panel, so it shows the body rather than a reason line.
    assert.match(html, /data-state="refused"/);
    assert.equal(html.includes(COPY.stages.reasons.low_coverage), false);
  });
});
