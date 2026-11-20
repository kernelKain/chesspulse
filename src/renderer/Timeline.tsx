// What: hand-rolled SVG composite timeline with four encodings and four designed states.
// Why: pulse, CPL ticks, think-time dots, and game endings share one time axis without chart-library clutter.
// Removed: a player could not see pulse, moves, clocks, and endings aligned on one scale or inspect low-coverage gaps.
import { useId, useState, type KeyboardEvent } from 'react';
import type { ReportResult } from '../shared/contracts';
import {
  buildGameMiniViews,
  buildTimelineView,
  cplBarRatio,
  endingMark,
  formatElapsed,
  moveTableRows,
  sampleReadout,
  sampleTableRows,
  thinkTimeRatio,
  timeTicks,
  type GameMiniTimelineView,
  type TimelineViewModel,
} from '../shared/timeline';

const WIDTH = 920;
const HEIGHT = 340;
const LEFT = 56;
const RIGHT = 20;
const PLOT_W = WIDTH - LEFT - RIGHT;

const ENDING_Y = 26;
const THINK_TOP = 46;
const THINK_BOTTOM = 72;
const PULSE_TOP = 84;
const PULSE_BOTTOM = 228;
const CPL_TOP = 244;
const CPL_BOTTOM = 298;
const AXIS_Y = 314;

export function Timeline({ result }: { result: ReportResult | null }) {
  const view = buildTimelineView(result);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [mode, setMode] = useState<'chart' | 'table'>('chart');
  const hatchId = useId();
  const keysHintId = useId();

  const activeIndex =
    view.samples.length === 0
      ? null
      : selectedIndex === null
        ? null
        : Math.min(view.samples.length - 1, Math.max(0, selectedIndex));

  function stepSample(delta: -1 | 1): void {
    if (view.samples.length === 0) return;
    const base = activeIndex ?? (delta > 0 ? -1 : view.samples.length);
    setSelectedIndex(Math.min(view.samples.length - 1, Math.max(0, base + delta)));
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (view.samples.length === 0) return;
    const current = activeIndex ?? 0;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setSelectedIndex(Math.max(0, current - 1));
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      setSelectedIndex(Math.min(view.samples.length - 1, current + 1));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setSelectedIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setSelectedIndex(view.samples.length - 1);
    }
  }

  const readoutText =
    view.samples.length === 0
      ? 'Nothing recorded yet.'
      : activeIndex !== null
        ? sampleReadout(view, activeIndex)
        : `Focus timeline and use left or right arrow keys to step through ${view.samples.length} samples.`;

  const xOf = (tUs: number): number => {
    if (view.stopUs <= view.startUs) return LEFT;
    const ratio = (tUs - view.startUs) / (view.stopUs - view.startUs);
    return LEFT + Math.min(1, Math.max(0, ratio)) * PLOT_W;
  };

  const yOfBpm = (bpm: number): number => {
    const span = view.yMaxBpm - view.yMinBpm;
    if (span <= 0) return (PULSE_TOP + PULSE_BOTTOM) / 2;
    const clamped = Math.min(view.yMaxBpm, Math.max(view.yMinBpm, bpm));
    return PULSE_TOP + ((view.yMaxBpm - clamped) / span) * (PULSE_BOTTOM - PULSE_TOP);
  };

  const selectedSample = activeIndex !== null ? view.samples[activeIndex] : undefined;
  const moveRows = mode === 'table' ? moveTableRows(view) : [];
  const sampleRows = mode === 'table' ? sampleTableRows(view) : [];
  const miniViews =
    mode === 'chart' && view.state !== 'low_coverage' && view.games.length > 0
      ? buildGameMiniViews(view)
      : [];
  const hasMiniStack = miniViews.length > 0;

  return (
    <section className={`timeline timeline-${view.state}`} aria-label="Session timeline">
      <div className="timeline-header">
        <div className="timeline-header-left">
          <span className="timeline-title">Timeline</span>
          {view.samples.length > 0 ? (
            <div className="view-toggle" role="group" aria-label="Timeline view">
              <button
                type="button"
                className="small-btn"
                aria-pressed={mode === 'chart'}
                onClick={() => setMode('chart')}
              >
                Chart
              </button>
              <button
                type="button"
                className="small-btn"
                aria-pressed={mode === 'table'}
                onClick={() => setMode('table')}
              >
                Table
              </button>
            </div>
          ) : null}
        </div>
        {view.confidenceLabel ? (
          <span className="timeline-confidence">{view.confidenceLabel}</span>
        ) : view.state === 'low_coverage' ? (
          <span className="timeline-confidence tone-warn">Low coverage · raw trace only</span>
        ) : null}
      </div>

      {view.state === 'low_confidence' && view.banner ? (
        <div className="timeline-banner tone-warn" role="status">
          {view.banner}
        </div>
      ) : null}

      {mode === 'table' && view.samples.length > 0 ? (
        <TimelineTables view={view} moveRows={moveRows} sampleRows={sampleRows} />
      ) : (
        <>
          <div className={hasMiniStack ? 'timeline-wide' : undefined}>
            <div
              className="timeline-frame"
              tabIndex={0}
              role="group"
              aria-roledescription="session timeline"
              aria-label="Pulse, move error, think time, and game endings"
              aria-describedby={keysHintId}
              onKeyDown={onKeyDown}
              onFocus={() => {
                if (selectedIndex === null && view.samples.length > 0) setSelectedIndex(0);
              }}
            >
              <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="presentation">
                <defs>
                  <pattern
                    id={hatchId}
                    width="8"
                    height="8"
                    patternUnits="userSpaceOnUse"
                    patternTransform="rotate(45)"
                  >
                    <line x1="0" y1="0" x2="0" y2="8" className="elevated-hatch-line" />
                  </pattern>
                </defs>

                {view.state === 'empty' ? (
                  <EmptySvg />
                ) : (
                  <>
                    <GameBands view={view} xOf={xOf} />

                    {view.state !== 'low_coverage' && view.elevatedThresholdBpm !== undefined ? (
                      <ElevatedZone
                        hatchId={hatchId}
                        thresholdBpm={view.elevatedThresholdBpm}
                        yOfBpm={yOfBpm}
                      />
                    ) : null}

                    {view.baselineBpm !== undefined ? (
                      <BaselineHairline baselineBpm={view.baselineBpm} yOfBpm={yOfBpm} />
                    ) : null}

                    <RailGuides showChessRails={view.state !== 'low_coverage'} view={view} yOfBpm={yOfBpm} />

                    {view.state !== 'low_coverage' ? (
                      <>
                        <EndingRail view={view} xOf={xOf} />
                        <ThinkRail view={view} xOf={xOf} />
                        <CplRail view={view} xOf={xOf} />
                      </>
                    ) : null}

                    <PulseLayer view={view} xOf={xOf} yOfBpm={yOfBpm} />

                    <TimeAxis view={view} xOf={xOf} />

                    {selectedSample ? (
                      <g className="timeline-cursor">
                        <line
                          x1={xOf(selectedSample.tUs)}
                          y1={THINK_TOP}
                          x2={xOf(selectedSample.tUs)}
                          y2={CPL_BOTTOM}
                        />
                        <circle
                          cx={xOf(selectedSample.tUs)}
                          cy={yOfBpm(selectedSample.bpm)}
                          r={4.5}
                        />
                      </g>
                    ) : null}
                  </>
                )}
              </svg>
            </div>

            <div className="readout-bar">
              <p id={keysHintId} className="timeline-readout" aria-live="polite">
                {readoutText}
              </p>
              {view.samples.length > 0 ? (
                <div className="readout-controls" role="group" aria-label="Step through samples">
                  <button
                    type="button"
                    className="small-btn"
                    disabled={activeIndex !== null && activeIndex <= 0}
                    onClick={() => stepSample(-1)}
                  >
                    Previous sample
                  </button>
                  <button
                    type="button"
                    className="small-btn"
                    disabled={activeIndex !== null && activeIndex >= view.samples.length - 1}
                    onClick={() => stepSample(1)}
                  >
                    Next sample
                  </button>
                </div>
              ) : null}
            </div>
          </div>

          {hasMiniStack ? (
            <div className="timeline-mini-stack" aria-label="Per-game timelines">
              {miniViews.map((mini) => (
                <MiniGameTimeline
                  key={mini.game.index}
                  mini={mini}
                  sessionStartUs={view.startUs}
                />
              ))}
            </div>
          ) : null}
        </>
      )}

      {view.state === 'low_coverage' && view.refusal ? (
        <div className="refusal-panel" role="alert">
          <h2>No report for this session.</h2>
          {view.refusal.measured !== undefined && view.refusal.threshold !== undefined ? (
            <p className="refusal-metric">
              Coverage was {view.refusal.measured}%; a review needs {view.refusal.threshold}%.
            </p>
          ) : null}
          <p>{view.refusal.remedy}</p>
        </div>
      ) : null}
    </section>
  );
}

function TimelineTables({
  view,
  moveRows,
  sampleRows,
}: {
  view: TimelineViewModel;
  moveRows: ReturnType<typeof moveTableRows>;
  sampleRows: ReturnType<typeof sampleTableRows>;
}) {
  return (
    <div className="timeline-tables">
      {moveRows.length > 0 ? (
        <div className="table-wrap">
          <table className="data-table">
            <caption>Moves aligned to the session timeline ({moveRows.length})</caption>
            <thead>
              <tr>
                <th scope="col">Game</th>
                <th scope="col">Time</th>
                <th scope="col">Move</th>
                <th scope="col">Pulse</th>
                <th scope="col">Band</th>
                <th scope="col">CPL</th>
                <th scope="col">Think</th>
                <th scope="col">Note</th>
              </tr>
            </thead>
            <tbody>
              {moveRows.map((row, idx) => (
                <tr key={`${row.gameLabel}-${idx}`} className={row.band === 'Elevated' ? 'row-elevated' : undefined}>
                  <td>{row.gameLabel}</td>
                  <td>{row.time}</td>
                  <td>{row.san}</td>
                  <td>{row.pulseBpm}</td>
                  <td>{row.band}</td>
                  <td>{row.cpl}</td>
                  <td>{row.think}</td>
                  <td>{row.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="table-wrap">
        <table className="data-table">
          <caption>
            {view.state === 'low_coverage'
              ? `Raw pulse samples (${sampleRows.length}, bands withheld)`
              : `Pulse samples (${sampleRows.length})`}
          </caption>
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Pulse</th>
              <th scope="col">Confidence</th>
              <th scope="col">Band / status</th>
              <th scope="col">Gap before</th>
            </tr>
          </thead>
          <tbody>
            {sampleRows.map((row, idx) => (
              <tr key={`${row.time}-${idx}`} className={row.status === 'Elevated' ? 'row-elevated' : undefined}>
                <td>{row.time}</td>
                <td>{row.bpm}</td>
                <td>{row.confidence}</td>
                <td>{row.status}</td>
                <td>{row.gapBeforeSec !== null ? `${row.gapBeforeSec} s gap` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EmptySvg() {
  return (
    <g>
      <line className="axis-line" x1={LEFT} y1={AXIS_Y} x2={LEFT + PLOT_W} y2={AXIS_Y} />
      <text className="axis-tick" x={LEFT} y={AXIS_Y + 16}>
        0:00
      </text>
      <text className="empty-caption" x={LEFT} y={(PULSE_TOP + PULSE_BOTTOM) / 2}>
        Nothing recorded yet.
      </text>
    </g>
  );
}

function GameBands({
  view,
  xOf,
}: {
  view: TimelineViewModel;
  xOf: (tUs: number) => number;
}) {
  return (
    <g className="game-bands">
      {view.games.map((game, idx) => {
        const x1 = xOf(game.startUs);
        const x2 = Math.max(x1 + 2, xOf(game.endUs));
        return (
          <g key={game.index}>
            <rect
              className={idx % 2 === 0 ? 'game-band-even' : 'game-band-odd'}
              x={x1}
              y={THINK_TOP}
              width={x2 - x1}
              height={CPL_BOTTOM - THINK_TOP}
            />
            <text className="game-band-label" x={Math.min(x1 + 6, LEFT + PLOT_W - 24)} y={THINK_TOP + 12}>
              G{game.index + 1}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function ElevatedZone({
  hatchId,
  thresholdBpm,
  yOfBpm,
}: {
  hatchId: string;
  thresholdBpm: number;
  yOfBpm: (bpm: number) => number;
}) {
  const y = yOfBpm(thresholdBpm);
  const zoneHeight = Math.max(0, y - PULSE_TOP);
  return (
    <g className="elevated-zone">
      {zoneHeight > 0 ? (
        <rect
          x={LEFT}
          y={PULSE_TOP}
          width={PLOT_W}
          height={zoneHeight}
          fill={`url(#${hatchId})`}
        />
      ) : null}
      <line className="threshold-line" x1={LEFT} y1={y} x2={LEFT + PLOT_W} y2={y} />
      <text className="threshold-label" x={LEFT + PLOT_W} y={Math.max(PULSE_TOP + 10, y - 5)} textAnchor="end">
        Elevated ≥ {formatBpm(thresholdBpm)} bpm
      </text>
    </g>
  );
}

function BaselineHairline({
  baselineBpm,
  yOfBpm,
}: {
  baselineBpm: number;
  yOfBpm: (bpm: number) => number;
}) {
  const y = yOfBpm(baselineBpm);
  return (
    <g className="baseline-guide">
      <line className="baseline-line" x1={LEFT} y1={y} x2={LEFT + PLOT_W} y2={y} />
      <text className="baseline-label" x={LEFT + 4} y={Math.min(PULSE_BOTTOM - 4, y + 13)}>
        Baseline {formatBpm(baselineBpm)} bpm
      </text>
    </g>
  );
}

function RailGuides({
  showChessRails,
  view,
  yOfBpm,
}: {
  showChessRails: boolean;
  view: TimelineViewModel;
  yOfBpm: (bpm: number) => number;
}) {
  const yTicks = [view.yMinBpm, Math.round((view.yMinBpm + view.yMaxBpm) / 2), view.yMaxBpm];
  return (
    <g className="rail-guides">
      {yTicks.map((bpm) => (
        <g key={bpm}>
          <line className="grid-line" x1={LEFT} y1={yOfBpm(bpm)} x2={LEFT + PLOT_W} y2={yOfBpm(bpm)} />
          <text className="y-tick" x={LEFT - 8} y={yOfBpm(bpm) + 4} textAnchor="end">
            {bpm}
          </text>
        </g>
      ))}
      <text className="rail-label" x={LEFT - 8} y={PULSE_TOP - 4} textAnchor="end">
        bpm
      </text>
      {showChessRails ? (
        <>
          <text className="rail-label" x={LEFT - 8} y={THINK_TOP + 14} textAnchor="end">
            think
          </text>
          <line className="rail-sep" x1={LEFT} y1={THINK_BOTTOM + 4} x2={LEFT + PLOT_W} y2={THINK_BOTTOM + 4} />
          <text className="rail-label" x={LEFT - 8} y={CPL_BOTTOM - 2} textAnchor="end">
            CPL
          </text>
          <line className="rail-sep" x1={LEFT} y1={CPL_BOTTOM} x2={LEFT + PLOT_W} y2={CPL_BOTTOM} />
        </>
      ) : null}
    </g>
  );
}

function EndingRail({
  view,
  xOf,
}: {
  view: TimelineViewModel;
  xOf: (tUs: number) => number;
}) {
  return (
    <g className="ending-rail">
      {view.games.map((game) => {
        const mark = endingMark(game.ending);
        const x = Math.min(LEFT + PLOT_W - 14, Math.max(LEFT + 14, xOf(game.endUs)));
        const anchor = x > LEFT + PLOT_W - 96 ? 'end' : 'middle';
        return (
          <g key={game.index} className="ending-mark">
            <title>
              Game {game.index + 1}: {mark.label} ({game.result})
            </title>
            <line className="ending-stem" x1={xOf(game.endUs)} y1={ENDING_Y + 6} x2={xOf(game.endUs)} y2={THINK_TOP} />
            <text x={x} y={ENDING_Y} textAnchor={anchor}>
              <tspan className="ending-glyph">{mark.glyph}</tspan>
              <tspan className="ending-word"> {mark.label}</tspan>
            </text>
          </g>
        );
      })}
    </g>
  );
}

function ThinkRail({
  view,
  xOf,
}: {
  view: TimelineViewModel;
  xOf: (tUs: number) => number;
}) {
  return (
    <g className="think-rail">
      {view.moves.map((move) => {
        if (move.tUs === null || move.thinkSec === null) return null;
        const ratio = thinkTimeRatio(move.thinkSec);
        const x = xOf(move.tUs);
        const y = THINK_BOTTOM - ratio * (THINK_BOTTOM - THINK_TOP - 4) - 2;
        return (
          <circle
            key={`${move.gameIndex}-${move.moveIndex}`}
            className="think-dot"
            cx={x}
            cy={y}
            r={2 + ratio * 1.5}
          >
            <title>
              G{move.gameIndex + 1} · {move.san} · {move.thinkSec} s think
            </title>
          </circle>
        );
      })}
    </g>
  );
}

function CplRail({
  view,
  xOf,
}: {
  view: TimelineViewModel;
  xOf: (tUs: number) => number;
}) {
  const maxH = CPL_BOTTOM - CPL_TOP;
  return (
    <g className="cpl-rail">
      {view.moves.map((move) => {
        if (move.tUs === null) return null;
        const x = xOf(move.tUs);
        if (move.cpl === null) {
          return (
            <circle
              key={`${move.gameIndex}-${move.moveIndex}`}
              className="cpl-unscored"
              cx={x}
              cy={CPL_BOTTOM - 2}
              r={1.5}
            >
              <title>
                G{move.gameIndex + 1} · {move.san} · unscored
              </title>
            </circle>
          );
        }
        const height = Math.max(3, cplBarRatio(move.cpl) * maxH);
        const topY = CPL_BOTTOM - height;
        return (
          <g key={`${move.gameIndex}-${move.moveIndex}`}>
            <title>
              G{move.gameIndex + 1} · {move.san} · {Math.round(move.cpl)} cpl
              {move.blunder ? ' (blunder)' : ''}
            </title>
            <line
              className={move.blunder ? 'cpl-tick cpl-blunder' : 'cpl-tick'}
              x1={x}
              y1={CPL_BOTTOM}
              x2={x}
              y2={topY}
            />
            {move.blunder ? (
              <polygon
                className="cpl-blunder-cap"
                points={`${x},${topY - 4} ${x + 3.5},${topY} ${x},${topY + 4} ${x - 3.5},${topY}`}
              />
            ) : null}
          </g>
        );
      })}
    </g>
  );
}

function PulseLayer({
  view,
  xOf,
  yOfBpm,
}: {
  view: TimelineViewModel;
  xOf: (tUs: number) => number;
  yOfBpm: (bpm: number) => number;
}) {
  const desaturated = view.state === 'low_coverage';
  return (
    <g className="pulse-layer">
      {view.usableRuns.map((run, idx) => {
        const cls = desaturated
          ? 'pulse-line pulse-desaturated'
          : run.kind === 'elevated'
            ? 'pulse-line pulse-elevated'
            : 'pulse-line pulse-settled';
        if (run.points.length === 1 && run.points[0]) {
          return (
            <circle
              key={`pt-${idx}-${run.points[0].tUs}`}
              className={desaturated ? 'pulse-dot pulse-desaturated' : run.kind === 'elevated' ? 'pulse-dot pulse-elevated' : 'pulse-dot pulse-settled'}
              cx={xOf(run.points[0].tUs)}
              cy={yOfBpm(run.points[0].bpm)}
              r={run.kind === 'elevated' && !desaturated ? 3.5 : 2.5}
            />
          );
        }
        const points = run.points
          .map((sample) => `${xOf(sample.tUs).toFixed(1)},${yOfBpm(sample.bpm).toFixed(1)}`)
          .join(' ');
        return <polyline key={`run-${idx}-${run.points[0]?.tUs ?? idx}`} className={cls} points={points} />;
      })}
      {view.weakSamples.map((sample) => (
        <circle
          key={`weak-${sample.tUs}`}
          className="pulse-weak"
          cx={xOf(sample.tUs)}
          cy={yOfBpm(sample.bpm)}
          r={2.5}
        >
          <title>
            {formatElapsed(sample.tUs, view.startUs)} · {formatBpm(sample.bpm)} bpm · confidence {sample.confidence}
          </title>
        </circle>
      ))}
    </g>
  );
}

function TimeAxis({
  view,
  xOf,
}: {
  view: TimelineViewModel;
  xOf: (tUs: number) => number;
}) {
  const ticks = timeTicks(view.startUs, view.stopUs);
  return (
    <g className="time-axis">
      <line className="axis-line" x1={LEFT} y1={AXIS_Y} x2={LEFT + PLOT_W} y2={AXIS_Y} />
      {ticks.map((tUs, idx) => {
        const x = xOf(tUs);
        const anchor = idx === 0 ? 'start' : idx === ticks.length - 1 ? 'end' : 'middle';
        return (
          <g key={tUs}>
            <line className="axis-tick-mark" x1={x} y1={AXIS_Y} x2={x} y2={AXIS_Y + 4} />
            <text className="axis-tick" x={x} y={AXIS_Y + 16} textAnchor={anchor}>
              {formatElapsed(tUs, view.startUs)}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function formatBpm(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

const MINI_W = 540;
const MINI_H = 192;
const MINI_LEFT = 40;
const MINI_RIGHT = 12;
const MINI_PLOT_W = MINI_W - MINI_LEFT - MINI_RIGHT;
const MINI_THINK_TOP = 14;
const MINI_THINK_BOTTOM = 32;
const MINI_PULSE_TOP = 40;
const MINI_PULSE_BOTTOM = 126;
const MINI_CPL_TOP = 136;
const MINI_CPL_BOTTOM = 172;

function MiniGameTimeline({
  mini,
  sessionStartUs,
}: {
  mini: GameMiniTimelineView;
  sessionStartUs: number;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const hatchId = useId();
  const active =
    mini.samples.length === 0 || selected === null
      ? null
      : Math.min(mini.samples.length - 1, Math.max(0, selected));

  function onKey(event: KeyboardEvent<HTMLDivElement>): void {
    if (mini.samples.length === 0) return;
    const current = active ?? 0;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setSelected(Math.max(0, current - 1));
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      setSelected(Math.min(mini.samples.length - 1, current + 1));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setSelected(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setSelected(mini.samples.length - 1);
    }
  }

  const xOf = (tUs: number): number => {
    if (mini.stopUs <= mini.startUs) return MINI_LEFT;
    const ratio = (tUs - mini.startUs) / (mini.stopUs - mini.startUs);
    return MINI_LEFT + Math.min(1, Math.max(0, ratio)) * MINI_PLOT_W;
  };

  const yOf = (bpm: number): number => {
    const span = mini.yMaxBpm - mini.yMinBpm;
    if (span <= 0) return (MINI_PULSE_TOP + MINI_PULSE_BOTTOM) / 2;
    const clamped = Math.min(mini.yMaxBpm, Math.max(mini.yMinBpm, bpm));
    return MINI_PULSE_TOP + ((mini.yMaxBpm - clamped) / span) * (MINI_PULSE_BOTTOM - MINI_PULSE_TOP);
  };

  const players =
    mini.game.white || mini.game.black
      ? `${mini.game.white || 'Unknown'} vs ${mini.game.black || 'Unknown'}`
      : 'Players unnamed';
  const currentSample = active !== null ? mini.samples[active] : undefined;
  const readout =
    mini.samples.length === 0
      ? 'No pulse samples during this game.'
      : currentSample
        ? `${formatElapsed(currentSample.tUs, sessionStartUs)} · ${formatBpm(currentSample.bpm)} bpm`
        : `${mini.samples.length} samples · use arrow keys to step`;

  return (
    <article className="mini-card">
      <div className="mini-header">
        <span className="mini-title">
          G{mini.game.index + 1} · {players}
        </span>
        <span className="mini-ending">
          <span aria-hidden="true">{mini.ending.glyph}</span> {mini.ending.label} · {mini.game.result} · {mini.spanLabel}
        </span>
      </div>
      <div
        className="timeline-frame mini-frame"
        tabIndex={0}
        role="group"
        aria-label={`Game ${mini.game.index + 1} timeline`}
        onKeyDown={onKey}
        onFocus={() => {
          if (selected === null && mini.samples.length > 0) setSelected(0);
        }}
      >
        <svg viewBox={`0 0 ${MINI_W} ${MINI_H}`} role="presentation">
          <defs>
            <pattern
              id={hatchId}
              width="8"
              height="8"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <line x1="0" y1="0" x2="0" y2="8" className="elevated-hatch-line" />
            </pattern>
          </defs>
          {mini.elevatedThresholdBpm !== undefined ? (
            <>
              <rect
                x={MINI_LEFT}
                y={MINI_PULSE_TOP}
                width={MINI_PLOT_W}
                height={Math.max(0, yOf(mini.elevatedThresholdBpm) - MINI_PULSE_TOP)}
                fill={`url(#${hatchId})`}
              />
              <line
                className="threshold-line"
                x1={MINI_LEFT}
                y1={yOf(mini.elevatedThresholdBpm)}
                x2={MINI_LEFT + MINI_PLOT_W}
                y2={yOf(mini.elevatedThresholdBpm)}
              />
            </>
          ) : null}
          {mini.baselineBpm !== undefined ? (
            <line
              className="baseline-line"
              x1={MINI_LEFT}
              y1={yOf(mini.baselineBpm)}
              x2={MINI_LEFT + MINI_PLOT_W}
              y2={yOf(mini.baselineBpm)}
            />
          ) : null}
          <text className="y-tick" x={MINI_LEFT - 6} y={MINI_PULSE_TOP + 4} textAnchor="end">
            {mini.yMaxBpm}
          </text>
          <text className="y-tick" x={MINI_LEFT - 6} y={MINI_PULSE_BOTTOM} textAnchor="end">
            {mini.yMinBpm}
          </text>
          <line className="rail-sep" x1={MINI_LEFT} y1={MINI_CPL_BOTTOM} x2={MINI_LEFT + MINI_PLOT_W} y2={MINI_CPL_BOTTOM} />
          {mini.moves.map((move) => {
            if (move.tUs === null || move.thinkSec === null) return null;
            const ratio = thinkTimeRatio(move.thinkSec);
            return (
              <circle
                key={`mt-${move.moveIndex}`}
                className="think-dot"
                cx={xOf(move.tUs)}
                cy={MINI_THINK_BOTTOM - ratio * (MINI_THINK_BOTTOM - MINI_THINK_TOP - 2) - 1}
                r={2}
              />
            );
          })}
          {mini.moves.map((move) => {
            if (move.tUs === null) return null;
            const x = xOf(move.tUs);
            if (move.cpl === null) {
              return <circle key={`mc-${move.moveIndex}`} className="cpl-unscored" cx={x} cy={MINI_CPL_BOTTOM - 2} r={1.5} />;
            }
            const h = Math.max(3, cplBarRatio(move.cpl) * (MINI_CPL_BOTTOM - MINI_CPL_TOP));
            return (
              <line
                key={`mc-${move.moveIndex}`}
                className={move.blunder ? 'cpl-tick cpl-blunder' : 'cpl-tick'}
                x1={x}
                y1={MINI_CPL_BOTTOM}
                x2={x}
                y2={MINI_CPL_BOTTOM - h}
              />
            );
          })}
          {mini.usableRuns.map((run, idx) => {
            const cls = run.kind === 'elevated' ? 'pulse-line pulse-elevated' : 'pulse-line pulse-settled';
            if (run.points.length === 1 && run.points[0]) {
              return (
                <circle
                  key={`mp-${idx}`}
                  className={run.kind === 'elevated' ? 'pulse-dot pulse-elevated' : 'pulse-dot pulse-settled'}
                  cx={xOf(run.points[0].tUs)}
                  cy={yOf(run.points[0].bpm)}
                  r={3}
                />
              );
            }
            const pts = run.points.map((s) => `${xOf(s.tUs).toFixed(1)},${yOf(s.bpm).toFixed(1)}`).join(' ');
            return <polyline key={`mr-${idx}`} className={cls} points={pts} />;
          })}
          {mini.weakSamples.map((s) => (
            <circle key={`mw-${s.tUs}`} className="pulse-weak" cx={xOf(s.tUs)} cy={yOf(s.bpm)} r={2.5} />
          ))}
          {currentSample ? (
            <g className="timeline-cursor">
              <line x1={xOf(currentSample.tUs)} y1={MINI_THINK_TOP} x2={xOf(currentSample.tUs)} y2={MINI_CPL_BOTTOM} />
              <circle cx={xOf(currentSample.tUs)} cy={yOf(currentSample.bpm)} r={4} />
            </g>
          ) : null}
          <text className="axis-tick" x={MINI_LEFT} y={MINI_H - 4} textAnchor="start">
            {formatElapsed(mini.startUs, sessionStartUs)}
          </text>
          <text className="axis-tick" x={MINI_LEFT + MINI_PLOT_W} y={MINI_H - 4} textAnchor="end">
            {formatElapsed(mini.stopUs, sessionStartUs)}
          </text>
        </svg>
      </div>
      <p className="timeline-readout mini-readout" aria-live="polite">
        {readout}
      </p>
    </article>
  );
}
