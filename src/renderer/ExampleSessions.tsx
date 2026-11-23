// What: the read-only example sessions on Home, each marked with the coverage gate's outcome.
// Why: a first-time player can open one session that passed the gate and one that failed it, and
//      see what each looks like, before setting up a camera.
// Removed: the examples would mix into Recent sessions, offer Delete, and give no hint of outcome.
import type { SessionSummary } from '../shared/contracts.js';
import {
  type ExampleOutcome,
  coverageLabel,
  exampleOutcome,
  formatSessionDate,
  formatSessionDuration,
  reportPresenceLabel,
} from '../shared/session-list.js';
import { COPY } from './copy';

export interface ExampleSessionsProps {
  sessions: SessionSummary[];
  onOpen(sessionId: string): void;
}

const OUTCOME_LABEL: Record<ExampleOutcome, string> = {
  built: COPY.sessions.example.built,
  withheld: COPY.sessions.example.withheld,
  pending: COPY.sessions.example.pending,
};

const OUTCOME_DETAIL: Record<ExampleOutcome, string> = {
  built: COPY.sessions.example.builtDetail,
  withheld: COPY.sessions.example.withheldDetail,
  pending: COPY.sessions.example.pendingDetail,
};

export function ExampleSessions({ sessions, onOpen }: ExampleSessionsProps) {
  if (sessions.length === 0) return null;
  return (
    <section className="example-sessions" aria-labelledby="example-sessions-heading">
      <h2 id="example-sessions-heading">{COPY.home.examplesHeading}</h2>
      <p className="example-sessions-intro">{COPY.home.examplesIntro}</p>
      <ol className="session-list">
        {sessions.map((session) => (
          <ExampleRow key={session.id} session={session} onOpen={() => onOpen(session.id)} />
        ))}
      </ol>
    </section>
  );
}

function ExampleRow({ session, onOpen }: { session: SessionSummary; onOpen(): void }) {
  const outcome = exampleOutcome(session);
  const date = new Date(session.startedAtEpochMs);
  const dateTime = Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  return (
    <li className={`session-row card example-row example-${outcome}`}>
      {/* The outcome is carried by the word and the icon; the colour only repeats it. */}
      <p className="example-outcome">
        <span className="example-outcome-icon" aria-hidden="true">
          {outcome === 'built' ? '✓' : outcome === 'withheld' ? '✕' : '•'}
        </span>
        {OUTCOME_LABEL[outcome]}
      </p>
      <div className="session-row-main">
        <time className="session-date" dateTime={dateTime}>
          {formatSessionDate(session.startedAtEpochMs)}
        </time>
        <span className="session-detail">{formatSessionDuration(session.durationMs)}</span>
        <span className="session-detail">{coverageLabel(session.coveragePct)}</span>
        <span className="session-detail">{reportPresenceLabel(session.hasReport)}</span>
      </div>
      <p className="session-detail example-detail">{OUTCOME_DETAIL[outcome]}</p>
      <div className="session-actions">
        <button type="button" onClick={onOpen} className="btn btn-secondary">
          {COPY.sessions.open}
        </button>
        <span className="session-detail">{COPY.sessions.example.readOnly}</span>
      </div>
    </li>
  );
}
