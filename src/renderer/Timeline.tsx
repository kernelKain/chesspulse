// What: the Pulse & Play Timeline — one large SVG chart and an inspector beside it.
// Why: pulse, move loss, think time, and games share one clock. The chart gives pulse the most room
//      and labels each rail in words; the inspector explains the encodings and names every value of
//      the selected reading. The user could not read the old chart or its one-line readout.
// Removed: a player could not see pulse and moves aligned, or tell what a point on the chart meant.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { ReportResult } from '../shared/contracts';
import { COPY } from './copy';
import {
  bpmTicks,
  buildGameMiniViews,
  buildTimelineView,
  cplBarRatio,
  endingMark,
  formatElapsed,
  momentDetails,
  moveTableRows,
  nearestSampleIndex,
  sampleStatusText,
  sampleTableRows,
  separatePair,
  thinkTimeRatio,
  timeTicks,
  type GameMiniTimelineView,
  type MomentDetails,
  type TimelineViewModel,
} from '../shared/timeline';

/** Chart geometry in SVG units. The SVG scales to its column, so these are proportions. */
const WIDTH = 960;
const HEIGHT = 540;
const LEFT = 84;
/** Rail names sit in their own left column, clear of the bpm ticks that end at LEFT - 8. */
const LABEL_X = 6;
const RIGHT = 96;
const PLOT_W = WIDTH - LEFT - RIGHT;

const GAMES_TOP = 8;
const GAMES_BOTTOM = 34;
const PULSE_TOP = 48;
const PULSE_BOTTOM = 336;
const LOSS_TOP = 362;
const LOSS_BOTTOM = 432;
const THINK_TOP = 456;
const THINK_BOTTOM = 494;
const AXIS_Y = 514;

type Rect = { xOf: (tUs: number) => number; yOfBpm: (bpm: number) => number };

/**
 * A request from another section to show one moment. `seq` grows with each request, so asking for
 * the same move twice still selects it again.
 */
export interface TimelineFocus {
  readonly sessionId: string;
  readonly tUs: number;
  readonly seq: number;
}

export function Timeline({ result, focus = null }: { result: ReportResult | null; focus?: TimelineFocus | null }) {
  const view = buildTimelineView(result);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [mode, setMode] = useState<'chart' | 'table'>('chart');
  const hatchId = useId();
  const keysHintId = useId();
  const frameRef = useRef<HTMLDivElement>(null);
  // A request made before this chart mounted (an earlier visit to the Review) is not replayed.
  const appliedSeq = useRef(focus?.seq ?? 0);
  const pendingFocus = useRef(false);
  const sessionId = result?.ok ? result.sessionId : null;

  useEffect(() => {
    if (!focus || focus.seq === appliedSeq.current) return;
    appliedSeq.current = focus.seq;
    if (focus.sessionId !== sessionId) return;
    const index = nearestSampleIndex(view.samples, focus.tUs);
    if (index === null) return;
    pendingFocus.current = true;
    setMode('chart');
    setSelectedIndex(index);
  }, [focus, sessionId, view.samples]);

  // Moves focus once per request, after the chart is drawn: in table mode the frame only exists
  // after the switch renders. Later renders leave focus where the player put it.
  useEffect(() => {
    const frame = frameRef.current;
    if (!pendingFocus.current || !frame) return;
    pendingFocus.current = false;
    frame.focus();
    frame.scrollIntoView?.({ block: 'center' });
  });

  const activeIndex =
    view.samples.length === 0 || selectedIndex === null
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
    const last = view.samples.length - 1;
    const keys: Record<string, number> = {
      ArrowLeft: Math.max(0, current - 1),
      ArrowRight: Math.min(last, current + 1),
      Home: 0,
      End: last,
    };
    const next = keys[event.key];
    if (next === undefined) return;
    event.preventDefault();
    setSelectedIndex(next);
  }

  const geometry: Rect = {
    xOf: (tUs) => {
      if (view.stopUs <= view.startUs) return LEFT;
      const ratio = (tUs - view.startUs) / (view.stopUs - view.startUs);
      return LEFT + Math.min(1, Math.max(0, ratio)) * PLOT_W;
    },
    yOfBpm: (bpm) => {
      const span = view.yMaxBpm - view.yMinBpm;
      if (span <= 0) return (PULSE_TOP + PULSE_BOTTOM) / 2;
      const clamped = Math.min(view.yMaxBpm, Math.max(view.yMinBpm, bpm));
      return PULSE_TOP + ((view.yMaxBpm - clamped) / span) * (PULSE_BOTTOM - PULSE_TOP);
    },
  };

  const selectedSample = activeIndex !== null ? view.samples[activeIndex] : undefined;
  const moment = activeIndex !== null ? momentDetails(view, activeIndex) : null;
  const chessRails = view.state !== 'low_coverage' && view.state !== 'empty';
  const moveRows = mode === 'table' ? moveTableRows(view) : [];
  const sampleRows = mode === 'table' ? sampleTableRows(view) : [];
  const miniViews = mode === 'chart' && chessRails && view.games.length > 0 ? buildGameMiniViews(view) : [];

  return (
    <section className={`timeline timeline-${view.state}`} aria-label={COPY.timeline.label}>
      <div className="timeline-header">
        <div className="timeline-header-left">
          {view.samples.length > 0 ? (
            <div className="view-toggle" role="group" aria-label={COPY.timeline.viewLabel}>
              <button type="button" className="btn btn-quiet btn-small" aria-pressed={mode === 'chart'} onClick={() => setMode('chart')}>
                {COPY.timeline.chart}
              </button>
              <button type="button" className="btn btn-quiet btn-small" aria-pressed={mode === 'table'} onClick={() => setMode('table')}>
                {COPY.timeline.table}
              </button>
            </div>
          ) : null}
        </div>
        {view.confidenceLabel ? (
          <span className="timeline-confidence">{view.confidenceLabel}</span>
        ) : view.state === 'low_coverage' ? (
          <span className="timeline-confidence tone-warn">{COPY.timeline.lowCoverage}</span>
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
          <div className={miniViews.length > 0 ? 'timeline-wide timeline-layout' : 'timeline-layout'}>
            <div className="timeline-main">
              <div
                ref={frameRef}
                className="timeline-frame"
                tabIndex={0}
                role="group"
                aria-roledescription="session timeline"
                aria-label={COPY.timeline.chartAria}
                aria-describedby={keysHintId}
                onKeyDown={onKeyDown}
                onFocus={() => {
                  // Functional update: a focus that follows "Open on timeline" keeps the chosen reading.
                  if (view.samples.length > 0) setSelectedIndex((current) => current ?? 0);
                }}
              >
                <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="presentation">
                  <defs>
                    <pattern id={hatchId} width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                      <line x1="0" y1="0" x2="0" y2="8" className="elevated-hatch-line" />
                    </pattern>
                  </defs>
                  {view.state === 'empty' ? (
                    <EmptySvg />
                  ) : (
                    <>
                      {chessRails ? <GameBands view={view} geometry={geometry} /> : null}
                      <PulseGrid view={view} geometry={geometry} />
                      {chessRails && view.elevatedThresholdBpm !== undefined ? (
                        <rect
                          className="elevated-zone"
                          x={LEFT}
                          y={PULSE_TOP}
                          width={PLOT_W}
                          height={Math.max(0, geometry.yOfBpm(view.elevatedThresholdBpm) - PULSE_TOP)}
                          fill={`url(#${hatchId})`}
                        />
                      ) : null}
                      <ReferenceLines view={view} geometry={geometry} showThreshold={chessRails} />
                      <PulseLayer view={view} geometry={geometry} />
                      {chessRails ? (
                        <>
                          <LossRail view={view} geometry={geometry} />
                          <ThinkRail view={view} geometry={geometry} />
                        </>
                      ) : null}
                      <RailLabels chessRails={chessRails} />
                      <TimeAxis view={view} geometry={geometry} />
                      {selectedSample ? (
                        <g className="timeline-cursor">
                          <line
                            x1={geometry.xOf(selectedSample.tUs)}
                            y1={chessRails ? GAMES_TOP : PULSE_TOP}
                            x2={geometry.xOf(selectedSample.tUs)}
                            y2={chessRails ? THINK_BOTTOM : PULSE_BOTTOM}
                          />
                          <circle cx={geometry.xOf(selectedSample.tUs)} cy={geometry.yOfBpm(selectedSample.bpm)} r={5} />
                        </g>
                      ) : null}
                    </>
                  )}
                </svg>
              </div>

              <div className="readout-bar">
                <p id={keysHintId} className="timeline-hint">
                  {view.samples.length === 0 ? COPY.strip.empty : COPY.timeline.keysHint}
                </p>
                {view.samples.length > 0 ? (
                  <div className="readout-controls" role="group" aria-label={COPY.timeline.stepAria}>
                    <button
                      type="button"
                      className="btn btn-secondary btn-small"
                      disabled={activeIndex !== null && activeIndex <= 0}
                      onClick={() => stepSample(-1)}
                    >
                      {COPY.timeline.previous}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-small"
                      disabled={activeIndex !== null && activeIndex >= view.samples.length - 1}
                      onClick={() => stepSample(1)}
                    >
                      {COPY.timeline.next}
                    </button>
                  </div>
                ) : null}
              </div>
            </div>

            <TimelineInspector moment={moment} chessRails={chessRails} />
          </div>

          {miniViews.length > 0 ? (
            <div className="timeline-mini-stack" aria-label={COPY.timeline.perGame}>
              {miniViews.map((mini) => (
                <MiniGameTimeline key={mini.game.index} mini={mini} sessionStartUs={view.startUs} />
              ))}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

/**
 * What: the panel beside the chart — the selected reading's facts, then the key.
 * Why: the user asked for explanations beside the chart rather than on it, so the chart stays clean.
 */
export function TimelineInspector({ moment, chessRails }: { moment: MomentDetails | null; chessRails: boolean }) {
  const items = COPY.timeline.key.items;
  const keyItems = chessRails
    ? [items.pulse, items.elevated, items.baseline, items.gaps, items.loss, items.think, items.games]
    : [items.pulse, items.baseline, items.gaps];
  return (
    <aside className="timeline-inspector">
      {/* Wide window: the panel is as tall as the chart and scrolls; it is focusable so it scrolls by keyboard. */}
      <div className="inspector-scroll" tabIndex={0} aria-label={COPY.timeline.inspectorLabel}>
      <section className="inspector-moment" aria-live="polite">
        <h3>{COPY.timeline.moment.title}</h3>
        {moment ? <MomentFacts moment={moment} /> : <p className="inspector-idle">{COPY.timeline.keysHint}</p>}
      </section>
      <section className="inspector-key" aria-label={COPY.timeline.key.label}>
        <h3>{COPY.timeline.key.title}</h3>
        <dl>
          {keyItems.map((item) => (
            <div key={item.term} className="key-row">
              <dt>{item.term}</dt>
              <dd>{item.text}</dd>
            </div>
          ))}
        </dl>
      </section>
      </div>
    </aside>
  );
}

function MomentFacts({ moment }: { moment: MomentDetails }) {
  const labels = COPY.timeline.moment.labels;
  const copy = COPY.timeline.moment;
  const move = moment.move;
  return (
    <>
      <p className="inspector-position">{copy.position(moment.position, moment.total)}</p>
      <dl className="moment-facts">
        <Fact label={labels.time} value={moment.time} />
        <Fact label={labels.pulse} value={moment.bpm} strong />
        <Fact label={labels.range} value={copy.ranges[moment.range]} className={`fact-wide range-${moment.range}`} />
        <Fact label={labels.signal} value={copy.signal(moment.confidence, moment.counted)} />
        <Fact label={labels.game} value={moment.game ? copy.game(moment.game.number, moment.game.players) : copy.noGame} className="fact-wide" />
        <Fact label={labels.move} value={move ? move.label : copy.noMove} strong={Boolean(move)} />
        {move ? (
          <>
            <Fact
              label={labels.loss}
              value={move.loss === 'unscored' ? copy.unscored : move.loss === 'mate' ? copy.mate : copy.loss(move.cpl ?? 0)}
            />
            <Fact label={labels.think} value={move.thinkSec === null ? copy.noClock : copy.think(formatBpm(move.thinkSec))} />
            {move.loss !== 'unscored' ? (
              <Fact label={labels.rule} value={move.blunder ? copy.blunder : copy.notBlunder} className={move.blunder ? 'fact-wide rule-blunder' : 'fact-wide'} />
            ) : null}
          </>
        ) : null}
      </dl>
    </>
  );
}

function Fact({ label, value, strong, className }: { label: string; value: string; strong?: boolean; className?: string }) {
  return (
    <div className={className ? `fact ${className}` : 'fact'}>
      <dt>{label}</dt>
      <dd className={strong ? 'fact-strong' : undefined}>{value}</dd>
    </div>
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
            <caption>{COPY.timeline.captions.moves(moveRows.length)}</caption>
            <thead>
              <tr>
                <th scope="col">{COPY.timeline.headers.game}</th>
                <th scope="col">{COPY.timeline.headers.time}</th>
                <th scope="col">{COPY.timeline.headers.move}</th>
                <th scope="col">{COPY.timeline.headers.pulse}</th>
                <th scope="col">{COPY.timeline.headers.band}</th>
                <th scope="col">{COPY.timeline.headers.cpl}</th>
                <th scope="col">{COPY.timeline.headers.think}</th>
                <th scope="col">{COPY.timeline.headers.note}</th>
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
              ? COPY.timeline.captions.rawSamples(sampleRows.length)
              : COPY.timeline.captions.samples(sampleRows.length)}
          </caption>
          <thead>
            <tr>
              <th scope="col">{COPY.timeline.headers.time}</th>
              <th scope="col">{COPY.timeline.headers.pulse}</th>
              <th scope="col">{COPY.timeline.headers.confidence}</th>
              <th scope="col">{COPY.timeline.headers.bandStatus}</th>
              <th scope="col">{COPY.timeline.headers.gap}</th>
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
      <text className="empty-caption" x={LEFT + PLOT_W / 2} y={(PULSE_TOP + PULSE_BOTTOM) / 2} textAnchor="middle">
        {COPY.strip.empty}
      </text>
    </g>
  );
}

/** One shaded span per placed game, through every rail, labelled when the span has room. */
function GameBands({ view, geometry }: { view: TimelineViewModel; geometry: Rect }) {
  return (
    <g className="game-bands">
      {view.games.map((game, idx) => {
        const x1 = geometry.xOf(game.startUs);
        const x2 = Math.max(x1 + 2, geometry.xOf(game.endUs));
        const width = x2 - x1;
        const mark = endingMark(game.ending);
        const label = width >= 46 ? `G${game.index + 1} ${mark.glyph}` : width >= 24 ? `G${game.index + 1}` : '';
        return (
          <g key={game.index}>
            <title>
              Game {game.index + 1}: {mark.label} ({game.result})
            </title>
            <rect
              className={idx % 2 === 0 ? 'game-band-even' : 'game-band-odd'}
              x={x1}
              y={GAMES_TOP}
              width={width}
              height={THINK_BOTTOM - GAMES_TOP}
            />
            <rect className="game-chip" x={x1 + 1} y={GAMES_TOP} width={Math.max(0, width - 2)} height={GAMES_BOTTOM - GAMES_TOP} rx={3} />
            {label ? (
              <text className="game-band-label" x={x1 + width / 2} y={GAMES_BOTTOM - 8} textAnchor="middle">
                {label}
              </text>
            ) : null}
          </g>
        );
      })}
    </g>
  );
}

function PulseGrid({ view, geometry }: { view: TimelineViewModel; geometry: Rect }) {
  return (
    <g className="rail-guides">
      {bpmTicks(view.yMinBpm, view.yMaxBpm).map((bpm) => (
        <g key={bpm}>
          <line className="grid-line" x1={LEFT} y1={geometry.yOfBpm(bpm)} x2={LEFT + PLOT_W} y2={geometry.yOfBpm(bpm)} />
          <text className="y-tick" x={LEFT - 8} y={geometry.yOfBpm(bpm) + 4} textAnchor="end">
            {bpm}
          </text>
        </g>
      ))}
    </g>
  );
}

/** Baseline and threshold lines, labelled in the right margin and never on top of each other. */
function ReferenceLines({ view, geometry, showThreshold }: { view: TimelineViewModel; geometry: Rect; showThreshold: boolean }) {
  const baselineY = view.baselineBpm !== undefined ? geometry.yOfBpm(view.baselineBpm) : null;
  const thresholdY = showThreshold && view.elevatedThresholdBpm !== undefined ? geometry.yOfBpm(view.elevatedThresholdBpm) : null;
  let [thresholdLabelY, baselineLabelY] = [thresholdY ?? 0, baselineY ?? 0];
  if (thresholdY !== null && baselineY !== null) {
    [thresholdLabelY, baselineLabelY] = separatePair(thresholdY, baselineY, 16, PULSE_TOP + 6, PULSE_BOTTOM - 2);
  }
  const labelX = LEFT + PLOT_W + 8;
  return (
    <g className="reference-lines">
      {thresholdY !== null && view.elevatedThresholdBpm !== undefined ? (
        <>
          <line className="threshold-line" x1={LEFT} y1={thresholdY} x2={LEFT + PLOT_W} y2={thresholdY} />
          <text className="threshold-label" x={labelX} y={thresholdLabelY + 4}>
            {COPY.timeline.lineLabels.elevated(formatBpm(view.elevatedThresholdBpm))}
          </text>
        </>
      ) : null}
      {baselineY !== null && view.baselineBpm !== undefined ? (
        <>
          <line className="baseline-line" x1={LEFT} y1={baselineY} x2={LEFT + PLOT_W} y2={baselineY} />
          <text className="baseline-label" x={labelX} y={baselineLabelY + 4}>
            {COPY.timeline.lineLabels.baseline(formatBpm(view.baselineBpm))}
          </text>
        </>
      ) : null}
    </g>
  );
}

/** Rail names in words on the left, and the scale each chess rail uses. */
function RailLabels({ chessRails }: { chessRails: boolean }) {
  const rails = COPY.timeline.rails;
  return (
    <g className="rail-labels">
      <text className="rail-label rail-label-strong" x={LABEL_X} y={(PULSE_TOP + PULSE_BOTTOM) / 2 - 4}>
        {rails.pulse}
      </text>
      <text className="rail-label" x={LABEL_X} y={(PULSE_TOP + PULSE_BOTTOM) / 2 + 13}>
        {rails.bpm}
      </text>
      {chessRails ? (
        <>
          <text className="rail-label rail-label-strong" x={LABEL_X} y={GAMES_BOTTOM - 8}>
            {rails.games}
          </text>
          <text className="rail-label rail-label-strong" x={LABEL_X} y={(LOSS_TOP + LOSS_BOTTOM) / 2 + 4}>
            {rails.loss}
          </text>
          <text className="rail-scale" x={LEFT + PLOT_W + 8} y={LOSS_TOP + 10}>
            {rails.lossCap}
          </text>
          <text className="rail-scale" x={LEFT + PLOT_W + 8} y={LOSS_BOTTOM}>
            {rails.zero}
          </text>
          <line className="rail-sep" x1={LEFT} y1={LOSS_BOTTOM} x2={LEFT + PLOT_W} y2={LOSS_BOTTOM} />
          <text className="rail-label rail-label-strong" x={LABEL_X} y={(THINK_TOP + THINK_BOTTOM) / 2 + 4}>
            {rails.think}
          </text>
          <text className="rail-scale" x={LEFT + PLOT_W + 8} y={THINK_TOP + 8}>
            {rails.thinkCap}
          </text>
          <line className="rail-sep" x1={LEFT} y1={THINK_BOTTOM} x2={LEFT + PLOT_W} y2={THINK_BOTTOM} />
        </>
      ) : null}
    </g>
  );
}

function ThinkRail({ view, geometry }: { view: TimelineViewModel; geometry: Rect }) {
  return (
    <g className="think-rail">
      {view.moves.map((move) => {
        if (move.tUs === null || move.thinkSec === null) return null;
        const ratio = thinkTimeRatio(move.thinkSec);
        return (
          <circle
            key={`${move.gameIndex}-${move.moveIndex}`}
            className="think-dot"
            cx={geometry.xOf(move.tUs)}
            cy={THINK_BOTTOM - 3 - ratio * (THINK_BOTTOM - THINK_TOP - 6)}
            r={1.8 + ratio * 1.6}
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

function LossRail({ view, geometry }: { view: TimelineViewModel; geometry: Rect }) {
  const maxH = LOSS_BOTTOM - LOSS_TOP;
  return (
    <g className="cpl-rail">
      {view.moves.map((move) => {
        if (move.tUs === null) return null;
        const x = geometry.xOf(move.tUs);
        const key = `${move.gameIndex}-${move.moveIndex}`;
        if (!move.scored) {
          return (
            <circle key={key} className="cpl-unscored" cx={x} cy={LOSS_BOTTOM - 2} r={1.5}>
              <title>
                G{move.gameIndex + 1} · {move.san} · not scored
              </title>
            </circle>
          );
        }
        if (move.mate) {
          return (
            <circle key={key} className="cpl-mate" cx={x} cy={LOSS_BOTTOM - 5} r={3}>
              <title>
                G{move.gameIndex + 1} · {move.san} · mate{move.blunder ? ' (blunder)' : ''}
              </title>
            </circle>
          );
        }
        const height = Math.max(2, cplBarRatio(move.cpl ?? 0) * maxH);
        const topY = LOSS_BOTTOM - height;
        return (
          <g key={key}>
            <title>
              G{move.gameIndex + 1} · {move.san} · {Math.round(move.cpl ?? 0)} cp{move.blunder ? ' (blunder)' : ''}
            </title>
            <line className={move.blunder ? 'cpl-tick cpl-blunder' : 'cpl-tick'} x1={x} y1={LOSS_BOTTOM} x2={x} y2={topY} />
            {move.blunder ? (
              <polygon className="cpl-blunder-cap" points={`${x},${topY - 5} ${x + 4},${topY} ${x},${topY + 5} ${x - 4},${topY}`} />
            ) : null}
          </g>
        );
      })}
    </g>
  );
}

function PulseLayer({ view, geometry }: { view: TimelineViewModel; geometry: Rect }) {
  const desaturated = view.state === 'low_coverage';
  const kindClass = (kind: 'settled' | 'elevated') =>
    desaturated ? 'pulse-desaturated' : kind === 'elevated' ? 'pulse-elevated' : 'pulse-settled';
  return (
    <g className="pulse-layer">
      {view.usableRuns.map((run, idx) => {
        const first = run.points[0];
        if (run.points.length === 1 && first) {
          return (
            <circle
              key={`pt-${idx}-${first.tUs}`}
              className={`pulse-dot ${kindClass(run.kind)}`}
              cx={geometry.xOf(first.tUs)}
              cy={geometry.yOfBpm(first.bpm)}
              r={2.5}
            />
          );
        }
        const points = run.points
          .map((sample) => `${geometry.xOf(sample.tUs).toFixed(1)},${geometry.yOfBpm(sample.bpm).toFixed(1)}`)
          .join(' ');
        return <polyline key={`run-${idx}-${first?.tUs ?? idx}`} className={`pulse-line ${kindClass(run.kind)}`} points={points} />;
      })}
      {view.weakSamples.map((sample) => (
        <circle key={`weak-${sample.tUs}`} className="pulse-weak" cx={geometry.xOf(sample.tUs)} cy={geometry.yOfBpm(sample.bpm)} r={1.6}>
          <title>
            {formatElapsed(sample.tUs, view.startUs)} · {formatBpm(sample.bpm)} bpm · not counted (confidence {sample.confidence})
          </title>
        </circle>
      ))}
    </g>
  );
}

function TimeAxis({ view, geometry }: { view: TimelineViewModel; geometry: Rect }) {
  const ticks = timeTicks(view.startUs, view.stopUs);
  return (
    <g className="time-axis">
      <line className="axis-line" x1={LEFT} y1={AXIS_Y - 10} x2={LEFT + PLOT_W} y2={AXIS_Y - 10} />
      {ticks.map((tUs, idx) => {
        const x = geometry.xOf(tUs);
        const anchor = idx === 0 ? 'start' : idx === ticks.length - 1 ? 'end' : 'middle';
        return (
          <g key={tUs}>
            <line className="axis-tick-mark" x1={x} y1={AXIS_Y - 10} x2={x} y2={AXIS_Y - 6} />
            <text className="axis-tick" x={x} y={AXIS_Y + 8} textAnchor={anchor}>
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
      ? `${mini.game.white || COPY.timeline.mini.unknown} vs ${mini.game.black || COPY.timeline.mini.unknown}`
      : COPY.timeline.mini.unnamed;
  const currentSample = active !== null ? mini.samples[active] : undefined;
  const readout =
    mini.samples.length === 0
      ? COPY.timeline.mini.noSamples
      : currentSample
        ? `${formatElapsed(currentSample.tUs, sessionStartUs)} · ${formatBpm(currentSample.bpm)} bpm · ${sampleStatusText(currentSample, mini.elevatedThresholdBpm)}`
        : COPY.timeline.mini.samples(mini.samples.length);

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
        aria-label={COPY.timeline.gameTimeline(mini.game.index)}
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
            if (!move.scored) {
              return <circle key={`mc-${move.moveIndex}`} className="cpl-unscored" cx={x} cy={MINI_CPL_BOTTOM - 2} r={1.5} />;
            }
            if (move.mate) {
              return <circle key={`mc-${move.moveIndex}`} className="cpl-mate" cx={x} cy={MINI_CPL_BOTTOM - 5} r={2.5} />;
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
