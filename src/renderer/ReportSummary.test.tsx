// What: the Review header markup and its narrow-window toggle, checked without Electron.
// Why: the header replaced a raw metadata line; a regression back to one paragraph must fail here.
// Removed: the headline, the labels, and the scope line would be reviewed by eye only.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Report } from '../shared/contracts.js';
import { COPY } from './copy.js';
import { mountDom } from './dom-harness.js';
import { ReportSummary, headlineText, scopeNote } from './ReportSummary.js';

const report: Report = {
  ok: true,
  schemaVersion: 1,
  sessionId: 'session-1',
  gamesDigest: 'a'.repeat(64),
  coveragePct: 50,
  baselineBpm: 70,
  verdict: 'One steady game.',
  settled: { band: 'settled', moves: 0, status: 'insufficient' },
  elevated: { band: 'elevated', moves: 0, status: 'insufficient' },
  engine: {
    depth: 8,
    positions: 10,
    scored: 7,
    failed: 3,
    reasons: { timeout: 3, crash: 0, engine: 0, budget: 0 },
  },
  alignmentMode: 'endtime',
  toleranceSec: 5,
  games: [],
  timeline: {
    startUs: 0,
    stopUs: 60_000_000,
    baselineBpm: 70,
    elevatedThresholdBpm: 80,
    samples: [],
    games: [],
    moves: [],
  },
};

describe('scope note', () => {
  it('names the counted player, or says why both sides were counted', () => {
    assert.equal(scopeNote({ playerScope: { kind: 'player', name: 'Ada' } }), COPY.verdict.scope.player('Ada'));
    assert.equal(scopeNote({ playerScope: { kind: 'all_moves', reason: 'ambiguous' } }), COPY.verdict.scope.ambiguous);
    assert.equal(
      scopeNote({ playerScope: { kind: 'all_moves', reason: 'no_common_name' } }),
      COPY.verdict.scope.noCommonName,
    );
  });

  it('tells an older report that it counted both sides', () => {
    assert.equal(scopeNote({}), COPY.verdict.scope.legacy);
  });
});

describe('ReportSummary markup', () => {
  it('opens with one h1 headline, then labelled facts, then the verdict and notes', () => {
    const html = renderToStaticMarkup(createElement(ReportSummary, { report }));
    assert.equal((html.match(/<h1/g) ?? []).length, 1);
    assert.match(html, new RegExp(`<h1 class="report-headline">${COPY.summary.headlines.no_scored}</h1>`));
    assert.ok(html.includes(`<dt>${COPY.summary.metrics.baseline.label}</dt><dd>70 bpm</dd>`));
    assert.ok(html.includes(`<dt>${COPY.summary.metrics.threshold.label}</dt><dd>80 bpm</dd>`));
    assert.ok(html.includes(`<dt>${COPY.summary.metrics.coverage.label}</dt><dd>50%</dd>`));
    assert.ok(html.includes(`<dt>${COPY.summary.metrics.settledAccuracy.label}</dt><dd>Insufficient</dd>`));
    assert.match(html, /<p>One steady game\.<\/p>/);
    assert.ok(html.includes(COPY.verdict.scope.legacy));
    assert.match(html, /3 positions timed out and were left out\./);
    assert.equal(html.includes('Baseline 70 bpm · Elevated'), false, 'the old metadata line is gone');
    const at = (marker: string) => html.indexOf(marker);
    assert.ok(at('class="report-headline"') < at('class="metric-rail"'), 'headline before the facts');
    assert.ok(at('class="metric-rail"') < at('class="report-verdict"'), 'facts before the verdict');
    assert.ok(at('class="report-verdict"') < at('class="report-notes"'), 'verdict before the notes');
  });

  it('states the time the face was covered when the session recorded it', () => {
    const html = renderToStaticMarkup(createElement(ReportSummary, { report: { ...report, occludedSec: 120 } }));
    assert.match(html, /Face or motion checks excluded 2 minutes of readings\./);
  });

  it('says "your" only when one player was scored', () => {
    assert.equal(headlineText('none_elevated', true), 'Your mistakes did not cluster during elevated pulse.');
    assert.equal(headlineText('none_elevated', false), 'Mistakes did not cluster during elevated pulse.');
  });
});

describe('ReportSummary interaction', () => {
  it('toggles the secondary facts and the explanations from the keyboard-reachable buttons', () => {
    const harness = mountDom(createElement(ReportSummary, { report }));
    try {
      const rail = harness.document.querySelector('.metric-rail');
      assert.equal(rail?.getAttribute('data-expanded'), 'false');
      const more = [...harness.document.querySelectorAll('button')].find((button) => button.textContent === COPY.summary.moreFacts);
      assert.ok(more);
      assert.equal(more.getAttribute('aria-expanded'), 'false');
      harness.click(more);
      assert.equal(rail?.getAttribute('data-expanded'), 'true');
      assert.equal(more.getAttribute('aria-expanded'), 'true');

      assert.equal(harness.document.querySelector('.metric-help'), null);
      const explain = [...harness.document.querySelectorAll('button')].find((button) => button.textContent === COPY.summary.explain);
      assert.ok(explain);
      harness.click(explain);
      const help = harness.document.querySelector('.metric-help');
      assert.ok(help);
      assert.equal(explain.getAttribute('aria-controls'), help.id);
      assert.ok(help.textContent?.includes(COPY.summary.metrics.baseline.help));
    } finally {
      harness.unmount();
    }
  });
});
