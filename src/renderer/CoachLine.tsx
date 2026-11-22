import type { CoachMessage } from '../shared/contracts';
import { COPY } from './copy';

export function CoachLine({ message }: { message: CoachMessage | null }) {
  return (
    <section className="coach-panel" aria-label={COPY.coach.label}>
      <p className="label">{COPY.coach.label}</p>
      <p className={message ? 'coach-message' : 'coach-quiet'} aria-live="polite">
        {message?.text ?? COPY.coach.quiet}
      </p>
      {message ? (
        <p className="coach-numbers">
          {COPY.coach.numbers(formatNumber(message.baselineBpm), formatNumber(message.recentBpm))}
        </p>
      ) : null}
    </section>
  );
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
