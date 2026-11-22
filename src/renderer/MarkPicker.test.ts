// What: the Review's mark question, checked without Electron.
// Why: R6-06 allows a mismatch to be answered; the screen must offer every mark and refuse a bad order.
// Removed: the picker would be reviewed by eye, and a wrong order could be submitted silently.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionMarkView } from '../shared/contracts.js';
import { COPY } from './copy.js';
import { MarkPicker } from './MarkPicker.js';

const marks: SessionMarkView[] = [
  { atUs: 60_000_000, kind: 'end', elapsedUs: 60_000_000 },
  { atUs: 90_000_000, kind: 'next', elapsedUs: 90_000_000 },
  { atUs: 150_000_000, kind: 'end', elapsedUs: 150_000_000 },
];

function render(gameCount = 2): string {
  return renderToStaticMarkup(
    createElement(MarkPicker, {
      gameCount,
      marks,
      onSubmit: () => undefined,
      onCancel: () => undefined,
    }),
  );
}

describe('MarkPicker markup', () => {
  it('asks one question per pasted game', () => {
    const html = render(2);
    assert.match(html, new RegExp(COPY.markChoice.title.replace('?', '\\?')));
    assert.equal((html.match(/<select/g) ?? []).length, 2);
    assert.match(html, /Game 1 ended at/);
    assert.match(html, /Game 2 ended at/);
  });

  it('lists every mark with its elapsed time and what it was', () => {
    const html = render(2);
    assert.match(html, /1:00 · Game ended/);
    assert.match(html, /1:30 · Next game started/);
    assert.match(html, /2:30 · Game ended/);
  });

  it('keeps the build disabled until the player answers', () => {
    const html = render(2);
    assert.match(html, new RegExp(`<button[^>]*disabled[^>]*>${COPY.markChoice.build}</button>`));
  });
});
