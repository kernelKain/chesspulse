import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Refusal } from '../shared/contracts.js';
import { RefusalPanel } from './RefusalPanel.js';

const lowCoverage: Refusal = {
  ok: false,
  reason: 'low_coverage',
  measured: 20,
  threshold: 70,
  remedy: 'Sit facing the screen with a lamp in front of you.',
  trace: { startUs: 0, stopUs: 10_000_000, samples: [] },
};

const illegal: Refusal = {
  ok: false,
  reason: 'illegal_move',
  remedy: 'Game 2, move 23 (Nf6) is not legal from this position. Check that the PGN came from chess.com.',
};

describe('RefusalPanel markup', () => {
  it('shows the coverage reason, both numbers, and the remedy', () => {
    const html = renderToStaticMarkup(createElement(RefusalPanel, { refusal: lowCoverage }));
    assert.match(html, /Coverage was too low for a review\./);
    assert.match(html, /Coverage was 20%; a review needs 70%\./);
    assert.match(html, /Sit facing the screen with a lamp in front of you\./);
    assert.match(html, /role="alert"/);
  });

  it('shows an illegal-move reason and its exact remedy', () => {
    const html = renderToStaticMarkup(createElement(RefusalPanel, { refusal: illegal }));
    assert.match(html, /A move in the pasted games is illegal\./);
    assert.match(html, /Game 2, move 23 \(Nf6\) is not legal from this position\./);
    assert.equal(html.includes('Coverage was'), false);
  });
});
