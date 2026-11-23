// What: the Move Quality section — an Overall tab, then one tab per game.
// Why: the old section was two band bars over a long game list, with no way to inspect one game.
//      Each tab now shows that view's stored facts, a computed comparison, and, for a game, its
//      largest losses with a link to the moment on the timeline.
// Removed: per-game accuracy, think time, and the largest mistakes would not be visible anywhere.
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Report } from '../shared/contracts';
import {
  gameQuality,
  overallQuality,
  type BandComparison,
  type GameQualityView,
  type OverallQualityView,
} from '../shared/quality';
import { endingMark } from '../shared/timeline';
import { BandBars } from './BandBars';
import { COPY } from './copy';

type Tab = 'overall' | number;

export interface MomentTarget {
  readonly gameIndex: number;
  readonly moveIndex: number;
  readonly tUs: number;
}

export function MoveQuality({
  report,
  onOpenMoment,
  onRebuild,
}: {
  report: Report;
  /** Selects the reading closest to the move on the timeline, names that move, and moves focus there. */
  onOpenMoment: (target: MomentTarget) => void;
  /** Opens the saved games so the player can rebuild the report. */
  onRebuild: () => void;
}) {
  const [tab, setTab] = useState<Tab>('overall');
  const tabRefs = useRef(new Map<Tab, HTMLButtonElement>());
  const baseId = useId();
  const tabs: Tab[] = ['overall', ...report.games.map((game) => game.index)];
  const tabId = (value: Tab) => `${baseId}-tab-${value}`;
  const panelId = `${baseId}-panel`;

  function choose(next: Tab, focus: boolean): void {
    setTab(next);
    if (focus) tabRefs.current.get(next)?.focus();
  }

  // Roving focus with automatic activation: arrows, Home, and End move to a tab and show it.
  function onTabKey(event: KeyboardEvent<HTMLButtonElement>): void {
    const current = tabs.indexOf(tab);
    const last = tabs.length - 1;
    const targets: Record<string, number> = {
      ArrowRight: current === last ? 0 : current + 1,
      ArrowLeft: current === 0 ? last : current - 1,
      Home: 0,
      End: last,
    };
    const target = targets[event.key];
    if (target === undefined) return;
    event.preventDefault();
    const next = tabs[target];
    if (next !== undefined) choose(next, true);
  }

  const overall = overallQuality(report);
  return (
    <div className="move-quality">
      <div className="quality-tabs" role="tablist" aria-label={COPY.quality.tabsLabel}>
        {tabs.map((value) => (
          <button
            key={String(value)}
            ref={(node) => {
              if (node) tabRefs.current.set(value, node);
              else tabRefs.current.delete(value);
            }}
            id={tabId(value)}
            type="button"
            role="tab"
            className="quality-tab"
            aria-selected={tab === value}
            aria-controls={panelId}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => choose(value, false)}
            onKeyDown={onTabKey}
          >
            {value === 'overall' ? COPY.quality.overall : COPY.quality.game(value + 1)}
          </button>
        ))}
      </div>
      <div className="quality-panel" role="tabpanel" id={panelId} aria-labelledby={tabId(tab)} tabIndex={0}>
        {overall.needsRebuild ? <RebuildNotice onRebuild={onRebuild} /> : null}
        {tab === 'overall' ? (
          <OverallPanel report={report} view={overall} onOpenGame={(index) => choose(index, true)} />
        ) : (
          <GamePanel view={gameQuality(report, tab)} onOpenMoment={onOpenMoment} />
        )}
      </div>
    </div>
  );
}

function OverallPanel({
  report,
  view,
  onOpenGame,
}: {
  report: Report;
  view: OverallQualityView;
  onOpenGame: (index: number) => void;
}) {
  const copy = COPY.quality;
  return (
    <>
      <div className="quality-grid">
        <div className="quality-main">
          <BandBars report={report} />
        </div>
        <aside className="quality-side">
          <h3>{copy.sessionFacts}</h3>
          <Facts
            items={[
              [copy.scored, String(view.totals.scored)],
              [copy.notScored, String(view.totals.unscored)],
              [copy.blunders, String(view.totals.blunders)],
              [copy.duringElevated, String(view.totals.elevatedBlunders)],
              [copy.gamesIncluded, String(view.totals.gamesIncluded)],
              [copy.gamesExcluded, String(view.gamesExcluded)],
            ]}
          />
          <h3>{copy.supports}</h3>
          <p className="quality-sentence">{comparisonText(view.comparison)}</p>
          <p className="quality-sentence">{copy.blunderSplit(view.totals.blunders, view.totals.elevatedBlunders)}</p>
        </aside>
      </div>
      {view.rows.length > 0 ? (
        <section className="quality-games" aria-label={copy.comparisonTitle}>
          <div className="quality-games-head">
            <h3>{copy.comparisonTitle}</h3>
            <span className="band-note">{copy.comparisonHint}</span>
          </div>
          <ol className="quality-game-list">
            {view.rows.map((row) => (
              <li key={row.index} className={row.included ? 'quality-game' : 'quality-game quality-game-excluded'}>
                <span className="quality-game-number">{copy.game(row.number)}</span>
                <span className="quality-game-players">{copy.players(row.white, row.black)}</span>
                <span className="quality-game-result">{row.result}</span>
                <span className="quality-game-detail">
                  {!row.included ? copy.rowExcluded : !row.placed ? copy.rowUnplaced : copy.rowAccuracy(row.accuracy)}
                </span>
                <span className="quality-game-detail">
                  {row.blunders !== null ? copy.rowBlunders(row.blunders) : ''}
                </span>
                <button
                  type="button"
                  className="btn btn-quiet btn-small"
                  aria-label={`${copy.openGame} ${row.number}`}
                  onClick={() => onOpenGame(row.index)}
                >
                  {copy.openGame}
                </button>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </>
  );
}

function GamePanel({
  view,
  onOpenMoment,
}: {
  view: GameQualityView | null;
  onOpenMoment: (target: MomentTarget) => void;
}) {
  const copy = COPY.quality;
  if (!view) return null;
  const { game } = view;
  const ending = endingMark(game.ending);
  const facts: [string, ReactNode][] = [
    [copy.result, game.result],
    [
      copy.ending,
      <>
        <span aria-hidden="true">{ending.glyph}</span> {ending.label}
      </>,
    ],
    [copy.sidePlayed, game.playerSide ? copy.sides[game.playerSide] : copy.sideUnknown],
    [copy.timeControl, game.timeControl ?? copy.noTimeControl],
  ];
  const heading = (
    <div className="quality-game-head">
      <h3>{copy.gameSummary}</h3>
      <p className="quality-game-players">{copy.players(game.white, game.black)}</p>
    </div>
  );

  if (view.kind === 'excluded') {
    return (
      <div className="quality-grid">
        <div className="quality-main">
          {heading}
          <Facts items={facts} />
        </div>
        <aside className="quality-side">
          <h3>{copy.excludedTitle}</h3>
          <p className="quality-sentence">{copy.excludedBody(ending.label, view.placed)}</p>
        </aside>
      </div>
    );
  }
  if (view.kind === 'unplaced') {
    return (
      <div className="quality-grid">
        <div className="quality-main">
          {heading}
          <Facts items={facts} />
        </div>
        <aside className="quality-side">
          <h3>{copy.unplacedTitle}</h3>
          <p className="quality-sentence">{copy.unplacedBody}</p>
        </aside>
      </div>
    );
  }
  if (view.kind === 'needs_rebuild') {
    return (
      <div className="quality-main">
        {heading}
        <Facts items={facts} />
      </div>
    );
  }

  const { summary } = view;
  facts.push([copy.sessionSpan, view.span ? copy.span(view.span.start, view.span.end) : copy.notPlaced]);
  const band = (value: typeof summary.settled) =>
    value.status === 'ok'
      ? `${copy.accuracyValue(value.accuracy)} · ${copy.moves(value.moves)}`
      : `${copy.tooFew} · ${copy.moves(value.moves)}`;
  return (
    <div className="quality-grid">
      <div className="quality-main">
        {heading}
        <Facts items={facts} />
        <h3>{copy.gameAccuracy}</h3>
        <Facts
          items={[
            [
              copy.overallAccuracy,
              summary.overall.status === 'ok' ? copy.accuracyValue(summary.overall.accuracy) : copy.tooFew,
            ],
            [copy.settledAccuracy, band(summary.settled)],
            [copy.elevatedAccuracy, band(summary.elevated)],
            [copy.scored, String(summary.scored)],
            [copy.notScored, String(summary.unscored)],
            [copy.blunders, String(summary.blunders)],
            [copy.averageThink, summary.avgThinkSec !== null ? copy.seconds(summary.avgThinkSec) : copy.noClock],
          ]}
        />
        <h3>{copy.lossesTitle}</h3>
        {view.losses.length === 0 ? (
          <p className="quality-sentence">{copy.lossesNone}</p>
        ) : (
          <ol className="quality-losses">
            {view.losses.map((loss) => {
              const at = loss.tUs;
              return (
                <li key={loss.moveIndex} className="quality-loss">
                  <span className="quality-loss-move">{loss.label}</span>
                  <span className="quality-loss-cpl">{copy.loss(loss.cpl)}</span>
                  {/* The word is the encoding; the warning colour only repeats it. */}
                  {loss.blunder ? <span className="quality-loss-tag">{copy.blunderTag}</span> : <span />}
                  {at !== null ? (
                    <button
                      type="button"
                      className="btn btn-quiet btn-small"
                      aria-label={copy.openOnTimelineLabel(loss.label)}
                      onClick={() => onOpenMoment({ gameIndex: game.index, moveIndex: loss.moveIndex, tUs: at })}
                    >
                      {copy.openOnTimeline}
                    </button>
                  ) : (
                    <span className="quality-game-detail">{copy.notPlaced}</span>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>
      <aside className="quality-side">
        <h3>{copy.supports}</h3>
        <p className="quality-sentence">{comparisonText(view.comparison)}</p>
        <p className="quality-sentence">{copy.blunderSplit(summary.blunders, summary.elevatedBlunders)}</p>
      </aside>
    </div>
  );
}

function RebuildNotice({ onRebuild }: { onRebuild: () => void }) {
  return (
    <div className="quality-rebuild" role="note">
      <h3>{COPY.quality.rebuildTitle}</h3>
      <p>{COPY.quality.rebuildBody}</p>
      <button type="button" className="btn btn-secondary btn-small" onClick={onRebuild}>
        {COPY.quality.rebuildAction}
      </button>
    </div>
  );
}

function Facts({ items }: { items: readonly (readonly [string, ReactNode])[] }) {
  return (
    <dl className="quality-facts">
      {items.map(([label, value]) => (
        <div key={label} className="fact">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function comparisonText(comparison: BandComparison): string {
  const lines = COPY.quality.comparison;
  switch (comparison.kind) {
    case 'same':
    case 'insufficient':
      return lines[comparison.kind];
    case 'settled_higher':
    case 'elevated_higher':
      return lines[comparison.kind](comparison.difference);
  }
}
