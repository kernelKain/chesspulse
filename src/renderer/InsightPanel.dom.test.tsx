import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import type { InsightConfig, Report } from '../shared/contracts.js';
import { findButton, mountDom } from './dom-harness.js';
import { act } from 'react';
import { InsightPanel, QUESTION_MAX_BYTES, insightAside, questionBytes, type InsightViewState } from './InsightPanel.js';

/**
 * Sets a controlled textarea the way typing does, so React's onChange runs. react-dom loads before the
 * harness installs jsdom globals, so it falls back to its old-IE value polyfill, which watches the
 * focused element through `attachEvent` and reads changes on keyup. jsdom has no `attachEvent`, so the
 * test gives the element no-op hooks; the change itself is still detected by React.
 */
function setTextarea(harness: ReturnType<typeof mountDom>, box: HTMLTextAreaElement, value: string): void {
  const legacy = box as unknown as { attachEvent: () => void; detachEvent: () => void };
  legacy.attachEvent = () => undefined;
  legacy.detachEvent = () => undefined;
  const setter = Object.getOwnPropertyDescriptor(harness.window.HTMLTextAreaElement.prototype, 'value')?.set;
  act(() => {
    box.focus();
    setter?.call(box, value);
    box.dispatchEvent(new harness.window.Event('input', { bubbles: true }));
    box.dispatchEvent(new harness.window.KeyboardEvent('keyup', { bubbles: true }));
  });
}

const report: Report = {
  ok: true, schemaVersion: 1, sessionId: 's1', gamesDigest: 'a'.repeat(64), coveragePct: 90, baselineBpm: 80, verdict: 'v.',
  settled: { band: 'settled', moves: 3, status: 'insufficient' }, elevated: { band: 'elevated', moves: 0, status: 'insufficient' },
  engine: { depth: 12, positions: 0, scored: 0, failed: 0, reasons: { timeout: 0, crash: 0, engine: 0, budget: 0 } },
  alignmentMode: 'marks', toleranceSec: 0, games: [],
  timeline: { startUs: 0, stopUs: 1, baselineBpm: 80, elevatedThresholdBpm: 90, samples: [], games: [], moves: [] },
};
const configured: InsightConfig = { configured: true, provider: 'opencode', model: 'deepseek-v4.1-flash' };

function panel(state: InsightViewState, config: InsightConfig | null, sent: string[] = []) {
  return createElement(InsightPanel, { state, config, report, onRequest: (text: string) => sent.push(text), onCancel: () => undefined });
}

describe('AI Session Explainer panel', () => {
  it('fills the question from a suggestion without sending, and disables questions without data', () => {
    const sent: string[] = [];
    const harness = mountDom(panel({ status: 'idle' }, configured, sent));
    try {
      const chips = [...harness.document.querySelectorAll<HTMLButtonElement>('.insight-chip')];
      assert.equal(chips.length, 10);
      assert.equal(findButton(harness.document, 'Generate explanation').disabled, true, 'nothing to send yet');
      harness.click(chips[0]!);
      assert.equal(harness.document.querySelector('textarea')?.value, 'Explain the Pulse & Play Timeline in plain English.');
      assert.equal(chips[0]!.getAttribute('aria-pressed'), 'true');
      assert.deepEqual(sent, [], 'choosing a question sends nothing');
      const disabled = chips.filter((chip) => chip.disabled).map((chip) => chip.textContent);
      assert.equal(disabled.length, 3);
      assert.match(harness.document.querySelector('.insight-suggestions')?.textContent ?? '', /No break between games was marked\./);
      harness.click(findButton(harness.document, 'Generate explanation'));
      assert.deepEqual(sent, ['Explain the Pulse & Play Timeline in plain English.']);
      assert.match(harness.document.querySelector('.insight-sent')?.textContent ?? '', /never receives video, images, raw pulse samples, logs, or local file paths\. Your provider key from \.env is sent only to authenticate/);
    } finally {
      harness.unmount();
    }
  });

  it('blocks a question over the byte limit even when it is under the character limit', () => {
    const sent: string[] = [];
    const harness = mountDom(panel({ status: 'idle' }, configured, sent));
    try {
      const box = harness.document.querySelector('textarea');
      assert.ok(box);
      const text = 'क'.repeat(1500); // 1,500 characters, 4,500 UTF-8 bytes
      assert.ok(questionBytes(text) > QUESTION_MAX_BYTES && text.length < QUESTION_MAX_BYTES);
      setTextarea(harness, box, text);
      const generate = findButton(harness.document, 'Generate explanation');
      assert.equal(generate.disabled, true);
      assert.match(harness.document.querySelector('.insight-limit')?.textContent ?? '', /4,000-byte limit/);
      assert.equal(box.getAttribute('aria-invalid'), 'true');
      harness.click(generate);
      assert.deepEqual(sent, []);
    } finally {
      harness.unmount();
    }
  });

  it('explains missing configuration and keeps Generate off', () => {
    const harness = mountDom(panel({ status: 'idle' }, { configured: false, reason: 'No AI key configured.' }));
    try {
      assert.match(harness.document.querySelector('.insight-notice')?.textContent ?? '', /AI explanation is not configured.*No AI key configured\./s);
      harness.click(harness.document.querySelector<HTMLButtonElement>('.insight-chip')!);
      assert.equal(findButton(harness.document, 'Generate explanation').disabled, true);
    } finally {
      harness.unmount();
    }
  });

  it('titles a failure, offers Try again only when it can help, and keeps the last explanation', () => {
    const sent: string[] = [];
    const harness = mountDom(panel({ status: 'idle' }, configured, sent));
    try {
      harness.click(harness.document.querySelector<HTMLButtonElement>('.insight-chip')!);
      harness.click(findButton(harness.document, 'Generate explanation'));
      harness.render(panel({ status: 'ready', text: 'The pulse line stays near baseline.' }, configured, sent));
      assert.match(harness.document.querySelector('.insight-result')?.textContent ?? '', /INFERRED.*Explanation for: Explain the Pulse/s);
      harness.render(panel({ status: 'loading' }, configured, sent));
      assert.match(harness.document.querySelector('.insight-text')?.textContent ?? '', /stays near baseline/, 'kept while the next one runs');
      harness.render(panel({ status: 'error', code: 'ai_no_answer', message: 'No final answer.', retryable: true }, configured, sent));
      const alert = harness.document.querySelector('[role="alert"]');
      assert.match(alert?.textContent ?? '', /The model gave no final answer/);
      harness.click(findButton(harness.document, 'Try again'));
      assert.equal(sent.length, 2, 'retry is one explicit request');
      harness.render(panel({ status: 'error', code: 'ai_ungrounded', message: 'Withheld.', retryable: false }, configured, sent));
      assert.match(harness.document.querySelector('[role="alert"]')?.textContent ?? '', /ChessPulse withheld this explanation/);
      assert.equal([...harness.document.querySelectorAll('button')].some((button) => button.textContent === 'Try again'), false);
      harness.click(findButton(harness.document, 'Clear explanation'));
      assert.equal(harness.document.querySelector('.insight-result'), null);
    } finally {
      harness.unmount();
    }
  });

  it('labels the section with INFERRED and the provider and model, never a key', () => {
    assert.equal(insightAside(configured), 'INFERRED · OpenCode · deepseek-v4.1-flash');
    assert.equal(insightAside({ configured: false, reason: 'x' }), 'INFERRED · Not configured');
    assert.equal(insightAside(null), 'INFERRED');
  });
});
