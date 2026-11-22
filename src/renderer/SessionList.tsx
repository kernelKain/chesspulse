// What: the stored-session rows shared by Home and the Sessions screen.
// Why: opening, exporting, and deleting must be one set of controls, with the same labels and guards.
// Removed: history would be a dead list, and delete/export would have no confirmation.
import { useEffect, useId, useRef, useState } from 'react';
import type { SessionSummary } from '../shared/contracts.js';
import { COPY } from './copy';
import {
  coverageLabel,
  formatSessionDate,
  formatSessionDuration,
  reportPresenceLabel,
} from '../shared/session-list.js';

export interface SessionListProps {
  sessions: SessionSummary[];
  emptyMessage: string;
  unreadable?: number;
  onOpen(sessionId: string): void;
  onDelete(sessionId: string): void;
  onExport(sessionId: string): void;
  heading?: string;
}

export function SessionList({
  sessions,
  emptyMessage,
  unreadable = 0,
  onOpen,
  onDelete,
  onExport,
  heading = COPY.sessions.listHeading,
}: SessionListProps) {
  const [confirmation, setConfirmation] = useState<{
    id: string;
    kind: 'delete' | 'export';
  } | null>(null);

  if (sessions.length === 0 && unreadable === 0) {
    return <p className="empty-state">{emptyMessage}</p>;
  }

  return (
    <section className="session-list-section" aria-label={heading}>
      {unreadable > 0 ? (
        <p className="session-unreadable" role="status">
          {COPY.sessions.unreadable(unreadable)}
        </p>
      ) : null}
      <ol className="session-list">
        {sessions.map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            confirmation={confirmation?.id === session.id ? confirmation.kind : null}
            onOpen={() => onOpen(session.id)}
            onDelete={() => {
              setConfirmation(null);
              onDelete(session.id);
            }}
            onExport={() => {
              setConfirmation(null);
              onExport(session.id);
            }}
            onRequestDelete={() => setConfirmation({ id: session.id, kind: 'delete' })}
            onRequestExport={() => setConfirmation({ id: session.id, kind: 'export' })}
            onCancel={() => setConfirmation(null)}
          />
        ))}
      </ol>
    </section>
  );
}

function SessionRow({
  session,
  confirmation,
  onOpen,
  onDelete,
  onExport,
  onRequestDelete,
  onRequestExport,
  onCancel,
}: {
  session: SessionSummary;
  confirmation: 'delete' | 'export' | null;
  onOpen(): void;
  onDelete(): void;
  onExport(): void;
  onRequestDelete(): void;
  onRequestExport(): void;
  onCancel(): void;
}) {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const deleteRef = useRef<HTMLButtonElement | null>(null);
  const exportRef = useRef<HTMLButtonElement | null>(null);
  const previousConfirmation = useRef<'delete' | 'export' | null>(null);
  const date = new Date(session.startedAtEpochMs);
  const dateTime = Number.isNaN(date.getTime()) ? undefined : date.toISOString();

  useEffect(() => {
    if (confirmation) {
      previousConfirmation.current = confirmation;
      cancelRef.current?.focus();
    } else if (previousConfirmation.current) {
      const target =
        previousConfirmation.current === 'delete' ? deleteRef.current : exportRef.current;
      previousConfirmation.current = null;
      target?.focus();
    }
  }, [confirmation]);

  return (
    <li className="session-row card">
      <div className="session-row-main">
        <time className="session-date" dateTime={dateTime}>
          {formatSessionDate(session.startedAtEpochMs)}
        </time>
        <span className="session-detail">{formatSessionDuration(session.durationMs)}</span>
        <span className="session-detail">{coverageLabel(session.coveragePct)}</span>
        <span className={session.hasReport ? 'session-report' : 'session-report muted'}>
          {reportPresenceLabel(session.hasReport)}
        </span>
      </div>

      {confirmation ? (
        <div className="session-confirm" role="group" aria-labelledby={titleId}>
          <p id={titleId}>
            {confirmation === 'delete'
              ? COPY.sessions.deleteQuestion
              : COPY.sessions.exportQuestion}
          </p>
          <div className="actions">
            <button
              type="button"
              className={confirmation === 'delete' ? 'btn btn-danger' : 'btn btn-primary'}
              onClick={confirmation === 'delete' ? onDelete : onExport}
            >
              {confirmation === 'delete' ? COPY.sessions.delete : COPY.sessions.export}
            </button>
            <button type="button" ref={cancelRef} onClick={onCancel} className="btn btn-secondary">
              {COPY.common.actions.cancel}
            </button>
          </div>
        </div>
      ) : (
        <div className="session-actions">
          <button type="button" onClick={onOpen} className="btn btn-secondary">
            {COPY.sessions.open}
          </button>
          <button type="button" ref={exportRef} disabled={!session.hasReport} onClick={onRequestExport} className="btn btn-secondary">
            {COPY.sessions.export}
          </button>
          <button type="button" ref={deleteRef} onClick={onRequestDelete} className="btn btn-secondary">
            {COPY.sessions.delete}
          </button>
          {!session.hasReport ? (
            <span className="session-detail">{COPY.sessions.exportUnavailable}</span>
          ) : null}
        </div>
      )}
    </li>
  );
}
