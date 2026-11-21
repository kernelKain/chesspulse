import type { CoachMessage } from '../shared/contracts';

export function CoachLine({ message }: { message: CoachMessage | null }) {
  return (
    <section className="coach-panel" aria-label="Between games">
      <p className="label">Between games</p>
      <p className={message ? 'coach-message' : 'coach-quiet'} aria-live="polite">
        {message?.text ?? 'Nothing to say yet.'}
      </p>
      {message ? (
        <p className="coach-numbers">
          Baseline {formatNumber(message.baselineBpm)} bpm · Last-minute median {formatNumber(message.recentBpm)} bpm
        </p>
      ) : null}
    </section>
  );
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
