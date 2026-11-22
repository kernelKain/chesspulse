import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import type { InsightConfig, Report } from '../shared/contracts.js';
import { findButton, mountDom } from './dom-harness.js';
import { InsightPanel, insightAside, type InsightViewState } from './InsightPanel.js';

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
      assert.match(harness.document.querySelector('.insight-sent')?.textContent ?? '', /never receives video, images, raw pulse samples, API keys/);
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
