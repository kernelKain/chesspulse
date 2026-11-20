// What: hand-rolled SVG composite timeline with four encodings and four designed states.
// Why: pulse, CPL ticks, think-time dots, and game endings share one time axis without chart-library clutter.
// Removed: a player could not see pulse, moves, clocks, and endings aligned on one scale or inspect low-coverage gaps.
import { useId, useState, type KeyboardEvent } from 'react';
import type { ReportResult } from '../shared/contracts';
import {
  buildTimelineView,
  cplBarRatio,
  endingMark,
  formatElapsed,
  sampleReadout,
  thinkTimeRatio,
  timeTicks,
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
  const hatchId = useId();
  const keysHintId = useId();

  const activeIndex =
    view.samples.length === 0
      ? null
      : selectedIndex === null
        ? null
        : Math.min(view.samples.length - 1, Math.max(0, selectedIndex));

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

  return (
    <section className={`timeline timeline-${view.state}`} aria-label="Session timeline">
      <div className="timeline-header">
        <span className="timeline-title">Timeline</span>
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

      <p id={keysHintId} className="timeline-readout" aria-live="polite">
        {readoutText}
      </p>

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
