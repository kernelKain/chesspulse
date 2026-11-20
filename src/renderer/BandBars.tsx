// What: renders accuracy by pulse band (settled vs elevated) with sample counts and non-colour hatching.
// Why: AC-12 requires sample counts and labelling thin bands as insufficient instead of plotting a number.
// Removed: the report would lack its core thesis comparison between settled and elevated play.
import { useId } from 'react';
import type { Report } from '../shared/contracts';

const BAR_WIDTH = 400;
const BAR_HEIGHT = 24;

export function BandBars({ report }: { report: Report }) {
  const hatchId = useId();
  const threshold = formatNumber(report.timeline.elevatedThresholdBpm);
  const rows = [
    {
      key: 'settled' as const,
      title: 'Settled',
      range: `< ${threshold} bpm`,
      summary: report.settled,
      elevated: false,
    },
    {
      key: 'elevated' as const,
      title: 'Elevated',
      range: `≥ ${threshold} bpm`,
      summary: report.elevated,
      elevated: true,
    },
  ];

  return (
    <section className="band-bars" aria-label="Accuracy by pulse band">
      <div className="band-header">
        <span className="timeline-title">Accuracy by band</span>
        <span className="band-note">Minimum 5 scored moves per band</span>
      </div>
      <div className="band-grid">
        {rows.map((row) => {
          const accuracy = row.summary.status === 'ok' ? row.summary.accuracy : null;
          const isOk = accuracy !== null;
          const fillWidth = accuracy !== null ? Math.max(0, Math.min(100, accuracy)) * (BAR_WIDTH / 100) : 0;
          const moveWord = row.summary.moves === 1 ? 'move' : 'moves';
          const barLabel = isOk
            ? `${row.title} accuracy ${accuracy} percent across ${row.summary.moves} scored ${moveWord}`
            : `${row.title} accuracy insufficient: ${row.summary.moves} scored ${moveWord}, minimum 5 required`;

          return (
            <div key={row.key} className={`band-row band-${row.key}`}>
              <div className="band-row-head">
                <div className="band-label-group">
                  <span className="band-name">{row.title}</span>
                  <span className="band-range">{row.range}</span>
                </div>
                <div className="band-value-group">
                  {isOk ? (
                    <span className="band-value">{accuracy}%</span>
                  ) : (
                    <span className="band-insufficient">Insufficient</span>
                  )}
                  <span className="band-count">
                    {row.summary.moves} scored {moveWord}
                  </span>
                </div>
              </div>

              <svg
                className="band-bar-svg"
                viewBox={`0 0 ${BAR_WIDTH} ${BAR_HEIGHT}`}
                role="img"
                aria-label={barLabel}
              >
                <defs>
                  {row.elevated ? (
                    <pattern
                      id={hatchId}
                      width="8"
                      height="8"
                      patternUnits="userSpaceOnUse"
                      patternTransform="rotate(45)"
                    >
                      <rect width="8" height="8" className="band-elevated-bg" />
                      <line x1="0" y1="0" x2="0" y2="8" className="band-elevated-hatch" />
                    </pattern>
                  ) : null}
                </defs>
                <rect
                  className={isOk ? 'band-track' : 'band-track band-track-insufficient'}
                  x={0.5}
                  y={0.5}
                  width={BAR_WIDTH - 1}
                  height={BAR_HEIGHT - 1}
                  rx={4}
                />
                {isOk && fillWidth > 0 ? (
                  <rect
                    className={row.elevated ? 'band-fill-elevated' : 'band-fill-settled'}
                    x={1}
                    y={1}
                    width={Math.max(2, fillWidth - 2)}
                    height={BAR_HEIGHT - 2}
                    rx={3}
                    fill={row.elevated ? `url(#${hatchId})` : undefined}
                  />
                ) : null}
              </svg>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
