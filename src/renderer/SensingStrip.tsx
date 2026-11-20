import type { KeyboardEvent } from 'react';
import type { PulseSample } from '../shared/contracts';
import { BASELINE_WINDOW_US, traceSegments } from '../shared/sensing';

const Y_MIN = 40;
const Y_MAX = 180;
const WIDTH = 640;
const HEIGHT = 160;
const PAD = 16;

export function SensingStrip({
  samples,
  selectedIndex,
  onSelect,
}: {
  samples: PulseSample[];
  selectedIndex: number | null;
  onSelect: (index: number) => void;
}) {
  const ordered = [...samples].sort((left, right) => left.tUs - right.tUs);
  const latest = ordered[ordered.length - 1];
  const visible = latest
    ? ordered.filter((sample) => latest.tUs - sample.tUs <= BASELINE_WINDOW_US)
    : [];
  const shown = selectedIndex !== null ? samples[selectedIndex] : latest;
  const label = shown
    ? `${formatBpm(shown.bpm)} bpm, confidence ${shown.confidence}, ${shown.stable ? 'stable' : 'not stable'}`
    : 'Nothing recorded yet.';

  function onKey(event: KeyboardEvent<HTMLDivElement>): void {
    if (samples.length === 0) return;
    const current = selectedIndex ?? samples.length - 1;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      onSelect(Math.max(0, current - 1));
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      onSelect(Math.min(samples.length - 1, current + 1));
    }
  }

  return (
    <div
      className="strip"
      tabIndex={0}
      role="group"
      aria-roledescription="pulse trace"
      aria-label="Pulse trace"
      aria-describedby="strip-keys"
      onKeyDown={onKey}
    >
      <p id="strip-keys" className="hint">
        Left and right arrow keys move through samples.
      </p>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="presentation">
        <line className="axis" x1={PAD} y1={HEIGHT - PAD} x2={WIDTH - PAD} y2={HEIGHT - PAD} />
        {visible.length === 0 ? (
          <text className="empty" x={PAD} y={HEIGHT / 2}>
            Nothing recorded yet.
          </text>
        ) : (
          traceSegments(visible).map((segment) =>
            segment.length === 1 ? (
              <circle
                key={segment[0].tUs}
                cx={xOf(segment[0].tUs, visible)}
                cy={yOf(segment[0].bpm)}
                r={3}
              />
            ) : (
              <polyline key={segment[0].tUs} points={toPoints(segment, visible)} />
            ),
          )
        )}
        {shown && visible.some((sample) => sample.tUs === shown.tUs) ? (
          <circle cx={xOf(shown.tUs, visible)} cy={yOf(shown.bpm)} r={4} />
        ) : null}
      </svg>
      <p className="readout" aria-hidden="true">
        {shown ? formatBpm(shown.bpm) : '—'}
      </p>
      <p className="unit" aria-hidden="true">
        bpm
      </p>
      <p className="live" aria-live="polite">
        {label}
      </p>
    </div>
  );
}

function toPoints(segment: readonly PulseSample[], visible: readonly PulseSample[]): string {
  return segment.map((sample) => `${xOf(sample.tUs, visible).toFixed(1)},${yOf(sample.bpm).toFixed(1)}`).join(' ');
}

function xOf(tUs: number, visible: readonly PulseSample[]): number {
  const start = visible[0].tUs;
  const end = visible[visible.length - 1].tUs;
  if (end === start) return WIDTH / 2;
  return PAD + ((tUs - start) / (end - start)) * (WIDTH - PAD * 2);
}

function yOf(bpm: number): number {
  const clamped = Math.min(Y_MAX, Math.max(Y_MIN, bpm));
  return PAD + ((Y_MAX - clamped) / (Y_MAX - Y_MIN)) * (HEIGHT - PAD * 2);
}

function formatBpm(bpm: number): string {
  return Number.isInteger(bpm) ? String(bpm) : bpm.toFixed(1);
}
