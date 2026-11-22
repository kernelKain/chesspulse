import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReviewProgress } from './ReviewProgress.js';

describe('ReviewProgress markup', () => {
  it('shows scored-of-total progress and a Cancel control', () => {
    const html = renderToStaticMarkup(
      createElement(ReviewProgress, {
        progress: { scored: 34, total: 80 },
        cancelling: false,
        onCancel: () => undefined,
      }),
    );
    assert.match(html, /Scored 34 of 80 positions…/);
    assert.match(html, /<progress[^>]*value="34"[^>]*max="80"/);
    assert.match(html, />Cancel report</);
    assert.equal(html.includes('disabled'), false);
  });

  it('shows the local-scoring state before the first position', () => {
    const html = renderToStaticMarkup(
      createElement(ReviewProgress, {
        progress: null,
        cancelling: false,
        onCancel: () => undefined,
      }),
    );
    assert.match(html, /Scoring positions locally with Stockfish…/);
    assert.equal(html.includes('<progress'), false);
  });

  it('disables Cancel while the request is in flight', () => {
    const html = renderToStaticMarkup(
      createElement(ReviewProgress, {
        progress: { scored: 1, total: 2 },
        cancelling: true,
        onCancel: () => undefined,
      }),
    );
    assert.match(html, /<button[^>]*disabled[^>]*>Cancelling…<\/button>/);
  });
});
