import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionSummary } from '../shared/contracts.js';
import { SessionList } from './SessionList.js';

const sessions: SessionSummary[] = [
  {
    id: 'session-one',
    startedAtEpochMs: 1_700_000_000_000,
    durationMs: 65_000,
    coveragePct: 75.4,
    hasReport: true,
  },
  {
    id: 'session-two',
    startedAtEpochMs: 1_700_003_600_000,
    durationMs: null,
    coveragePct: null,
    hasReport: false,
  },
];

function render(overrides: {
  sessions?: SessionSummary[];
  emptyMessage?: string;
  unreadable?: number;
} = {}): string {
  return renderToStaticMarkup(
    createElement(SessionList, {
      sessions: overrides.sessions ?? sessions,
      emptyMessage: overrides.emptyMessage ?? 'No sessions yet.',
      unreadable: overrides.unreadable ?? 0,
      onOpen: () => undefined,
      onDelete: () => undefined,
      onExport: () => undefined,
    }),
  );
}

describe('SessionList markup', () => {
  it('shows date, duration, coverage, report presence, and actions', () => {
    const html = render();
    assert.match(html, /1:05 elapsed/);
    assert.match(html, /75% coverage/);
    assert.match(html, /Report saved/);
    assert.match(html, /No duration/);
    assert.match(html, /No coverage/);
    assert.match(html, /No report yet/);
    assert.equal((html.match(/>Open</g) ?? []).length, 2);
    assert.equal((html.match(/>Delete</g) ?? []).length, 2);
  });

  it('disables Export without a report and says why', () => {
    const html = render();
    assert.equal((html.match(/>Export</g) ?? []).length, 2);
    assert.match(html, /<button[^>]*disabled[^>]*>Export<\/button>/);
    assert.match(html, /Export is available after a report is built\./);
  });

  it('shows the empty message when there is nothing to list', () => {
    const html = render({ sessions: [], emptyMessage: 'No sessions yet. Start one from Home.' });
    assert.match(html, /No sessions yet\. Start one from Home\./);
  });

  it('counts unreadable sessions without hiding the healthy rows', () => {
    const html = render({ unreadable: 1 });
    assert.match(html, /1 saved session could not be read\./);
    assert.match(html, /Report saved/);
  });
});
