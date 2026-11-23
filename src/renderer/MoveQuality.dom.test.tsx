import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import type { Report, ReportGame } from '../shared/contracts.js';
import { findButton, mountDom } from './dom-harness.js';
import { MoveQuality } from './MoveQuality.js';

const counted = (index: number, overrides: Partial<ReportGame> = {}): ReportGame => ({
  index,
  white: 'Ada',
  black: `Opp${index}`,
  result: '0-1',
  ending: 'resignation',
  includeInStats: true,
  moveCount: 40,
  blunders: 1,
  aligned: true,
  playerSide: 'black',
  timeControl: '180+2',
  summary: {
    scored: 20,
    unscored: 0,
    overall: { moves: 20, status: 'ok', accuracy: 86 },
    settled: { band: 'settled', moves: 15, status: 'ok', accuracy: 88 },
    elevated: { band: 'elevated', moves: 5, status: 'ok', accuracy: 88 },
    blunders: 1,
    elevatedBlunders: 0,
    avgThinkSec: 4.2,
    largestLosses: [{ moveIndex: 13, cpl: 350, blunder: true }],
  },
  ...overrides,
});

const report = (games: ReportGame[], extra: Partial<Report> = {}): Report => ({
  ok: true,
  schemaVersion: 1,
  sessionId: 's1',
  gamesDigest: 'b'.repeat(64),
  coveragePct: 90,
  baselineBpm: 80,
  verdict: 'v.',
  settled: { band: 'settled', moves: 30, status: 'ok', accuracy: 88 },
  elevated: { band: 'elevated', moves: 3, status: 'insufficient' },
  engine: { depth: 12, positions: 0, scored: 0, failed: 0, reasons: { timeout: 0, crash: 0, engine: 0, budget: 0 } },
  alignmentMode: 'marks',
  toleranceSec: 0,
  totals: { gamesIncluded: 1, scored: 20, unscored: 0, blunders: 1, elevatedBlunders: 0 },
  games,
  timeline: {
    startUs: 0,
    stopUs: 900_000_000,
    baselineBpm: 80,
    elevatedThresholdBpm: 90,
    samples: [],
    games: games.map((game) => ({
      index: game.index,
      white: game.white,
      black: game.black,
      result: game.result,
      ending: game.ending,
      includeInStats: game.includeInStats,
      startUs: 60_000_000,
      endUs: 600_000_000,
    })),
    moves: [
      { gameIndex: 0, moveIndex: 13, san: 'Qh4', tUs: 300_000_000, cpl: 350, thinkSec: 2, blunder: true, mate: false, scored: true, band: 'settled' },
    ],
  },
  ...extra,
});

const facts = (root: ParentNode) =>
  Object.fromEntries(
    [...root.querySelectorAll('.quality-facts .fact')].map((node) => [node.querySelector('dt')?.textContent, node.querySelector('dd')?.textContent]),
  );

const noop = () => undefined;

describe('Move Quality tabs', () => {
  it('opens on Overall with session facts and the computed comparison', () => {
    const harness = mountDom(createElement(MoveQuality, { report: report([counted(0)]), onOpenMoment: noop, onRebuild: noop }));
    try {
      const tabs = [...harness.document.querySelectorAll('[role="tab"]')];
      assert.deepEqual(tabs.map((tab) => tab.textContent), ['Overall', 'Game 1']);
      assert.deepEqual(tabs.map((tab) => tab.getAttribute('aria-selected')), ['true', 'false']);
      assert.deepEqual(tabs.map((tab) => tab.getAttribute('tabindex')), ['0', '-1']);
      const panel = harness.document.querySelector('[role="tabpanel"]');
      assert.equal(panel?.getAttribute('aria-labelledby'), tabs[0]?.id);
      assert.equal(facts(harness.document)['Blunders'], '1');
      assert.match(panel?.textContent ?? '', /not enough scored moves in both pulse ranges/);
      assert.equal(harness.document.querySelector('.quality-rebuild'), null);
    } finally {
      harness.unmount();
    }
  });

  it('moves between tabs with the arrow keys and focuses the chosen tab', () => {
    const harness = mountDom(
      createElement(MoveQuality, { report: report([counted(0), counted(1)]), onOpenMoment: noop, onRebuild: noop }),
    );
    try {
      const overall = harness.document.querySelector('[role="tab"]');
      assert.ok(overall);
      harness.keyDown(overall, 'ArrowRight');
      const selected = harness.document.querySelector('[role="tab"][aria-selected="true"]');
      assert.equal(selected?.textContent, 'Game 1');
      assert.equal(harness.document.activeElement, selected);
      harness.keyDown(selected!, 'End');
      assert.equal(harness.document.activeElement?.textContent, 'Game 2');
      harness.keyDown(harness.document.activeElement!, 'ArrowRight');
      assert.equal(harness.document.activeElement?.textContent, 'Overall', 'wraps from the last tab to the first');
    } finally {
      harness.unmount();
    }
  });

  it('shows a game panel with labelled facts and opens its largest loss on the timeline', () => {
    const opened: { gameIndex: number; moveIndex: number; tUs: number }[] = [];
    const harness = mountDom(
      createElement(MoveQuality, { report: report([counted(0)]), onOpenMoment: (target: { gameIndex: number; moveIndex: number; tUs: number }) => opened.push(target), onRebuild: noop }),
    );
    try {
      harness.click(findButton(harness.document, 'Open game'));
      const values = facts(harness.document);
      assert.equal(values['Side played'], 'Black');
      assert.equal(values['Time control'], '180+2');
      assert.equal(values['Session span'], '1:00 to 10:00');
      assert.equal(values['Overall accuracy'], '86%');
      assert.equal(values['Average think time'], '4.2 s');
      const panel = harness.document.querySelector('[role="tabpanel"]');
      assert.match(panel?.textContent ?? '', /Accuracy was the same in both pulse ranges\./);
      const loss = harness.document.querySelector('.quality-loss');
      assert.match(loss?.textContent ?? '', /7… Qh4/);
      assert.match(loss?.textContent ?? '', /350 cp lost/);
      assert.match(loss?.textContent ?? '', /Blunder/, 'the blunder is named in words, not only by colour');
      harness.click(findButton(harness.document, 'Open on timeline'));
      assert.deepEqual(opened, [{ gameIndex: 0, moveIndex: 13, tUs: 300_000_000 }]);
    } finally {
      harness.unmount();
    }
  });

  it('asks an older report to be rebuilt instead of showing invented game numbers', () => {
    let rebuilt = 0;
    const legacy = report([counted(0, { summary: undefined })], { totals: undefined });
    const harness = mountDom(
      createElement(MoveQuality, { report: legacy, onOpenMoment: noop, onRebuild: () => (rebuilt += 1) }),
    );
    try {
      assert.match(harness.document.querySelector('.quality-rebuild')?.textContent ?? '', /Rebuild for game-by-game details/);
      harness.click(findButton(harness.document, 'Open game'));
      assert.equal(facts(harness.document)['Overall accuracy'], undefined, 'no per-game accuracy without a stored summary');
      harness.click(findButton(harness.document, 'Rebuild report'));
      assert.equal(rebuilt, 1);
    } finally {
      harness.unmount();
    }
  });
});
