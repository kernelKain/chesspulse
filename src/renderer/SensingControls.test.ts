import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SensingControls, type SensingControlsProps } from './SensingControls.js';

function render(overrides: Partial<SensingControlsProps> = {}): string {
  const props: SensingControlsProps = {
    elapsedLabel: '12:34',
    limitWarning: null,
    qualityLabel: 'Good signal',
    betweenGames: false,
    markedGames: 0,
    gapPending: false,
    confirmingStop: false,
    onGap: () => undefined,
    onRequestStop: () => undefined,
    onConfirmStop: () => undefined,
    onKeepSensing: () => undefined,
    ...overrides,
  };
  return renderToStaticMarkup(createElement(SensingControls, props));
}

describe('SensingControls markup', () => {
  it('shows the clock, quality, playing state, and marked-game count', () => {
    const html = render();
    assert.match(html, />12:34</);
    assert.match(html, /elapsed/);
    assert.match(html, /Good signal/);
    assert.match(html, /Playing/);
    assert.match(html, /0 games marked/);
    assert.match(html, />Game ended</);
  });

  it('shows the waiting state with the next-game action and the count', () => {
    const html = render({ betweenGames: true, markedGames: 3 });
    assert.match(html, /Game ended — waiting for the next game/);
    assert.match(html, /3 games marked/);
    assert.match(html, />Next game started</);
  });

  it('shows the 80-minute warning when present', () => {
    const html = render({
      limitWarning: '10 minutes left before the 90-minute limit.',
    });
    assert.match(html, /10 minutes left before the 90-minute limit\./);
  });

  it('asks for confirmation before stopping and offers Keep sensing', () => {
    const html = render({ confirmingStop: true });
    assert.match(html, /Stop this session\?/);
    assert.match(html, /You can(?:&apos;|&#x27;)t add to it later\./);
    assert.match(html, />Stop</);
    assert.match(html, /Keep sensing/);
    assert.equal(html.includes('Game ended'), false);
  });

  it('disables the gap button while a gap change is pending', () => {
    const html = render({ gapPending: true });
    assert.match(html, /<button[^>]*disabled[^>]*>Game ended<\/button>/);
  });
});
