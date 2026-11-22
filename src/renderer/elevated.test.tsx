// What: checks the elevated state keeps all three encodings, and that the palette has one
//       definition per colour role.
// Why: AGENTS §8 and D-13 require a non-colour encoding for "elevated". A refactor could drop the
//      hatch or the word and leave ember alone, and every check would still pass without this test.
// Removed: "elevated" would become colour-only, and a colour-blind player could not read the band.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import type { Report } from '../shared/contracts.js';
import { BandBars } from './BandBars.js';
import { COPY } from './copy.js';
import { mountDom } from './dom-harness.js';

const report: Report = {
  ok: true,
  schemaVersion: 1,
  sessionId: 'session-1',
  gamesDigest: 'a'.repeat(64),
  coveragePct: 82,
  baselineBpm: 70,
  verdict: 'One steady game.',
  settled: { band: 'settled', moves: 30, status: 'ok', accuracy: 71 },
  elevated: { band: 'elevated', moves: 12, status: 'ok', accuracy: 54 },
  engine: {
    depth: 8,
    positions: 42,
    scored: 40,
    failed: 2,
    reasons: { timeout: 2, crash: 0, engine: 0, budget: 0 },
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

function readCss(name: string): string {
  return fs.readFileSync(path.join(process.cwd(), 'src/renderer', name), 'utf8');
}

/** Rules whose selector names the elevated state, plus the legend swatch that stands for it. */
function elevatedRules(css: string): { selector: string; block: string }[] {
  const rules: { selector: string; block: string }[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim();
    if (/elevated/.test(selector) || selector === '.legend-hatch') {
      rules.push({ selector, block: match[2] });
    }
  }
  return rules;
}

describe('Elevated encoding', () => {
  it('fills the elevated bar with the hatch pattern and labels the same band', () => {
    const harness = mountDom(createElement(BandBars, { report }));
    try {
      const row = harness.document.querySelector('.band-row.band-elevated');
      assert.ok(row, 'the elevated band row is missing');
      assert.match(row.textContent ?? '', new RegExp(COPY.bands.elevated));

      const fill = row.querySelector('.band-fill-elevated');
      assert.ok(fill, 'the elevated bar is missing');
      const paint = /^url\(#(.+)\)$/.exec(fill.getAttribute('fill') ?? '');
      assert.ok(paint, 'the elevated bar does not reference a paint server');

      const pattern = harness.document.getElementById(paint[1]);
      assert.ok(pattern, `no element defines ${paint[1]}`);
      assert.equal(pattern.tagName.toLowerCase(), 'pattern');
      assert.equal(pattern.closest('svg'), row.querySelector('svg'), 'the pattern is not in this band');

      assert.ok(pattern.querySelector('rect.band-elevated-bg'), 'the hatch has no background');
      assert.ok(pattern.querySelector('line.band-elevated-hatch'), 'the hatch has no lines');
    } finally {
      harness.unmount();
    }
  });

  it('never colours an elevated rule with a role other than ember', () => {
    const tokenValues = new Map(
      [...readCss('tokens.css').matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [
        '--' + m[1],
        m[2].trim(),
      ]),
    );
    const isColourRole = (name: string) => /^(#|rgb|hsl)/.test(tokenValues.get(name) ?? '');
    const rules = elevatedRules(readCss('styles.css'));
    assert.ok(rules.length > 0, 'no elevated rules were found in styles.css');
    for (const { selector, block } of rules) {
      for (const ref of block.matchAll(/var\((--[a-z0-9-]+)\)/g)) {
        if (ref[1] === '--elevated') continue;
        assert.equal(isColourRole(ref[1]), false, `${selector} colours with ${ref[1]}`);
      }
      assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/, `${selector} hard-codes a hex colour`);
    }
  });

  it('defines every colour role the stylesheet references', () => {
    const tokens = readCss('tokens.css');
    const styles = readCss('styles.css');
    const defined = new Set([...tokens.matchAll(/--([a-z0-9-]+)\s*:/g)].map((m) => '--' + m[1]));
    const used = new Set([...styles.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]));
    const missing = [...used].filter((name) => !defined.has(name));
    assert.deepEqual(missing, [], 'styles.css uses roles that tokens.css does not define');
    assert.equal(defined.has('--accent'), false, '--accent is superseded by --pulse and --elevated');
  });
});
