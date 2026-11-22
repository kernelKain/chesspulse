// What: the per-game card on Paste, checked without Electron.
// Why: R6-02 asks for visual game cards; a change that falls back to one text line must fail a test.
// Removed: the card layout would be reviewed by eye only, and the clock state could vanish silently.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PasteGameSummary } from '../shared/contracts.js';
import { COPY } from './copy.js';
import { GameSummaryRow, PlayerQuestion } from './PasteScreen.js';

const played: PasteGameSummary = {
  white: 'Ada',
  black: 'Boris',
  result: '1-0',
  ending: 'checkmate',
  moveCount: 42,
  hasClocks: true,
  partialClocks: false,
  includeInStats: true,
  timeControl: '3+2',
};

function render(game: PasteGameSummary): string {
  return renderToStaticMarkup(createElement(GameSummaryRow, { game }));
}

describe('Paste game card', () => {
  it('shows result, ending, moves, clock state, and time control for a played game', () => {
    const html = render(played);
    assert.match(html, /class="game-card"/);
    assert.match(html, /Ada vs Boris/);
    assert.match(html, /class="game-card-result">1-0</);
    for (const label of [
      COPY.games.card.ending,
      COPY.games.card.moves,
      COPY.games.card.clock,
      COPY.games.card.timeControl,
    ]) {
      assert.ok(html.includes(`<dt>${label}</dt>`), `the card has no ${label} label`);
    }
    assert.match(html, /Checkmate/);
    assert.match(html, /42 plies/);
    assert.match(html, /Clocks OK/);
    assert.match(html, /3\+2/);
    assert.equal(html.includes(COPY.games.excluded), false);
  });

  it('marks a clockless game and keeps the exclusion badge', () => {
    const html = render({
      ...played,
      ending: 'aborted',
      hasClocks: false,
      includeInStats: false,
    });
    assert.match(html, /No clocks/);
    assert.match(html, /fact-warn/);
    assert.match(html, new RegExp(COPY.games.excluded));
    assert.match(html, /Aborted/);
  });

  it('asks which player you are when two names are in every game', () => {
    const html = renderToStaticMarkup(
      createElement(PlayerQuestion, { candidates: ['Ada', 'Nim'], selected: null, groupName: 'p', onChoose: () => undefined }),
    );
    assert.match(html, /<fieldset class="player-question"/);
    assert.ok(html.includes(`<legend>${COPY.games.player.legend}</legend>`));
    assert.equal((html.match(/type="radio"/g) ?? []).length, 3, 'two players plus "both"');
    assert.ok(html.includes(COPY.games.player.both));
    assert.ok(html.includes(COPY.games.player.required));
  });
  it('marks the chosen player and drops the reminder', () => {
    const html = renderToStaticMarkup(
      createElement(PlayerQuestion, {
        candidates: ['Ada', 'Nim'],
        selected: { kind: 'player', name: 'nim' },
        groupName: 'p',
        onChoose: () => undefined,
      }),
    );
    assert.match(html, /checked="" value="Nim"/);
    assert.equal((html.match(/checked=""/g) ?? []).length, 1);
    assert.equal(html.includes(COPY.games.player.required), false);
  });
  it('states who is counted without asking when only one name is shared', () => {
    const single = renderToStaticMarkup(
      createElement(PlayerQuestion, { candidates: ['Ada'], selected: null, groupName: 'p', onChoose: () => undefined }),
    );
    assert.ok(single.includes(COPY.games.player.single('Ada')));
    assert.equal(single.includes('type="radio"'), false);
    const none = renderToStaticMarkup(
      createElement(PlayerQuestion, { candidates: [], selected: null, groupName: 'p', onChoose: () => undefined }),
    );
    assert.ok(none.includes(COPY.games.player.none));
  });
  it('calls out partial clocks even though some moves have them', () => {
    const html = render({ ...played, partialClocks: true });
    assert.match(html, /Partial clocks/);
    assert.match(html, /fact-warn/);
  });
});
