import { useEffect, useRef, useState } from 'react';
import { COPY } from './copy';

export type InsightViewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'disabled'; reason: string }
  | { status: 'error'; message: string }
  | { status: 'ready'; text: string };

export function InsightPanel({
  state,
  onRequest,
  onCancel,
}: {
  state: InsightViewState;
  /** The provider comes from .env in the main process; the panel only sends the question. */
  onRequest: (text: string) => void;
  onCancel: () => void;
}) {
  const [question, setQuestion] = useState<string>(COPY.insight.prompt);
  const writeButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const loading = state.status === 'loading';

  useEffect(() => {
    if (loading || !restoreFocus.current) return;
    restoreFocus.current = false;
    const active = document.activeElement;
    // Cancel's removal releases focus to the document. A different target means the user moved on.
    if (active !== document.body && active !== document.documentElement && active !== writeButton.current) return;
    writeButton.current?.focus();
  }, [loading]);

  const liveText =
    state.status === 'idle'
      ? COPY.insight.idle
      : state.status === 'loading'
        ? COPY.insight.loading
        : state.status === 'disabled'
          ? state.reason
          : state.status === 'error'
            ? state.message
            : state.text;

  return (
    <section className="insight-panel" aria-labelledby="insight-title">
      <p className="label">{COPY.insight.label}</p>
      <h2 id="insight-title">{COPY.insight.title}</h2>
      <p className="inferred-label">{COPY.insight.inferredLabel}</p>

      <div className="insight-controls">
        <label>
          {COPY.insight.question}
          <textarea
            rows={3}
            maxLength={4000}
            value={question}
            disabled={loading}
            onChange={(event) => setQuestion(event.target.value)}
          />
        </label>
      </div>

      <div className="actions">
        <button ref={writeButton} type="button" disabled={loading || !question.trim()} onClick={() => onRequest(question.trim())} className="btn btn-secondary">
          {COPY.insight.write}
        </button>
        {loading ? (
          <button
            ref={cancelButton}
            type="button"
            onClick={() => {
              restoreFocus.current = document.activeElement === cancelButton.current;
              onCancel();
            }}
            className="btn btn-secondary"
          >
            {COPY.insight.cancel}
          </button>
        ) : null}
      </div>

      <p
        className={state.status === 'ready' ? 'insight-text' : state.status === 'error' ? 'insight-error' : 'insight-note'}
        role={state.status === 'error' ? 'alert' : undefined}
        aria-live="polite"
      >
        {liveText}
      </p>
    </section>
  );
}
