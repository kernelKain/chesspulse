import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PasteSlot } from '../shared/contracts.js';
import { SlotBadge, SlotError } from './PasteValidation.js';

const illegal: PasteSlot = {
  slotIndex: 1,
  status: 'invalid',
  message:
    'Game 2, move 23 (Nf6) is not legal from this position. Check that the PGN came from chess.com.',
};

describe('per-game paste error markup', () => {
  it('renders the illegal move with its game, move, and SAN', () => {
    const html = renderToStaticMarkup(createElement(SlotError, { id: 'slot-error', slot: illegal }));
    assert.match(html, /role="alert"/);
    assert.match(html, /id="slot-error"/);
    assert.match(html, /Game 2, move 23 \(Nf6\) is not legal from this position\./);
  });

  it('renders the invalid badge and nothing for a valid slot', () => {
    assert.match(renderToStaticMarkup(createElement(SlotBadge, { slot: illegal })), /Invalid/);
    const valid: PasteSlot = {
      slotIndex: 0,
      status: 'valid',
      game: {
        white: 'A',
        black: 'B',
        result: '1-0',
        ending: 'checkmate',
        moveCount: 4,
        hasClocks: true,
        partialClocks: false,
        includeInStats: true,
      },
    };
    assert.equal(renderToStaticMarkup(createElement(SlotError, { slot: valid })), '');
  });
});
