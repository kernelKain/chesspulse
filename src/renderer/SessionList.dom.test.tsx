import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import type { SessionSummary } from '../shared/contracts.js';
import { findButton, mountDom } from './dom-harness.js';
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
    durationMs: 1_000,
    coveragePct: 20,
    hasReport: false,
  },
];

function list(overrides: {
  onDelete?: (id: string) => void;
  onExport?: (id: string) => void;
  onOpen?: (id: string) => void;
} = {}) {
  return createElement(SessionList, {
    sessions,
    emptyMessage: 'No sessions yet.',
    onOpen: overrides.onOpen ?? (() => undefined),
    onDelete: overrides.onDelete ?? (() => undefined),
    onExport: overrides.onExport ?? (() => undefined),
  });
}

describe('SessionList interaction', () => {
  it('asks for confirmation and focuses Cancel before deleting', () => {
    let deleted = '';
    const harness = mountDom(list({ onDelete: (id) => { deleted = id; } }));
    harness.click(findButton(harness.document, 'Delete'));
    assert.match(harness.document.body.textContent ?? '', /Delete this session\?/);
    assert.equal(harness.document.activeElement?.textContent, 'Cancel');
    assert.equal(deleted, '');
    harness.click(findButton(harness.document, 'Cancel'));
    assert.equal(deleted, '');
    harness.unmount();
  });

  it('returns focus to the initiating Delete button when cancelled', () => {
    const harness = mountDom(list());
    const deleteButton = findButton(harness.document, 'Delete');
    harness.click(deleteButton);
    harness.click(findButton(harness.document, 'Cancel'));
    assert.equal(harness.document.activeElement?.textContent, 'Delete');
    harness.unmount();
  });

  it('deletes once confirmed', () => {
    let deleted = '';
    const harness = mountDom(list({ onDelete: (id) => { deleted = id; } }));
    harness.click(findButton(harness.document, 'Delete'));
    harness.click(findButton(harness.document, 'Delete'));
    assert.equal(deleted, 'session-one');
    harness.unmount();
  });

  it('does not open export for a session without a report', () => {
    const harness = mountDom(list());
    const exportButtons = [...harness.document.querySelectorAll('button')].filter(
      (button) => button.textContent?.trim() === 'Export',
    );
    assert.equal(exportButtons.length, 2);
    harness.click(exportButtons[1]);
    assert.equal(harness.document.querySelector('.session-confirm'), null);
    harness.unmount();
  });
});
