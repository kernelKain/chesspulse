import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionSummary } from '../shared/contracts.js';
import { ExampleSessions } from './ExampleSessions.js';

const passed: SessionSummary = {
  id: 'example-passed',
  startedAtEpochMs: 1_700_000_000_000,
  durationMs: 1_339_000,
  coveragePct: 88.2,
  hasReport: true,
};
const refused: SessionSummary = {
  id: 'example-refused',
  startedAtEpochMs: 1_700_003_600_000,
  durationMs: 1_011_000,
  coveragePct: 9.3,
  hasReport: false,
};

function render(sessions: SessionSummary[]): string {
  return renderToStaticMarkup(createElement(ExampleSessions, { sessions, onOpen: () => undefined }));
}

describe('ExampleSessions', () => {
  it('renders nothing when no examples ship', () => {
    assert.equal(render([]), '');
  });

  it('names each outcome in words, not only colour', () => {
    const html = render([passed, refused]);
    assert.match(html, /example-built[\s\S]*Passed the coverage gate/);
    assert.match(html, /example-withheld[\s\S]*Failed the coverage gate/);
    assert.match(html, /88% coverage/);
    assert.match(html, /9% coverage/);
    assert.match(html, /Report saved/);
    assert.match(html, /No report yet/);
  });

  it('offers Open only, never Delete or Export', () => {
    const html = render([passed, refused]);
    assert.equal(html.match(/>Open</g)?.length, 2);
    assert.doesNotMatch(html, />Delete</);
    assert.doesNotMatch(html, />Export</);
    assert.match(html, /Read-only example/);
  });
});
