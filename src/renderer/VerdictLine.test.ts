import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Report } from '../shared/contracts.js';
import { VerdictLine } from './VerdictLine.js';

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

describe('VerdictLine markup', () => {
  it('states the time the face was covered when the session recorded it', () => {
    const html = renderToStaticMarkup(createElement(VerdictLine, { report: { ...report, occludedSec: 120 } }));
    assert.match(html, /Hand or object over face for 2 minutes\./);
  });

  it('opens Review with the verdict, coverage, and the number of unscored positions', () => {
    const html = renderToStaticMarkup(createElement(VerdictLine, { report }));
    assert.match(html, /<h1[^>]*>One steady game\.<\/h1>/);
    assert.match(html, /Coverage 50%/);
    assert.match(html, /3 positions timed out and were left out\./);
  });
});
