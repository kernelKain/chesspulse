// What: the AI Session Explainer — ten suggested questions, a question box, what is sent, and the
//      model's explanation labelled INFERRED.
// Why: the old panel had one free-text box and one generic error line. The player now picks or writes
//      a question, sees what leaves the computer before sending, and gets a titled reason for each
//      failure. Nothing is sent until they choose Generate explanation.
// Removed: the player could not tell what the model receives, or why an explanation failed.
import { useEffect, useId, useRef, useState } from 'react';
import type { InsightConfig, Report } from '../shared/contracts';
import { QUESTION_KEYS, unavailableQuestions } from '../shared/explainer';
import { COPY } from './copy';

export type InsightViewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'disabled'; reason: string }
  | { status: 'error'; code: string; message: string; retryable: boolean }
  | { status: 'ready'; text: string };

export function InsightPanel({
  state,
  config,
  report,
  onRequest,
  onCancel,
}: {
  state: InsightViewState;
  /** What .env selected, read once from main. `null` while it loads or if the read failed. */
  config: InsightConfig | null;
  report: Report;
  /** The provider comes from .env in the main process; the panel only sends the question. */
  onRequest: (text: string) => void;
  onCancel: () => void;
}) {
  const copy = COPY.insight;
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<{ question: string; text: string } | null>(null);
  const sent = useRef('');
  const writeButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const questionId = useId();
  const hintId = useId();
  const loading = state.status === 'loading';
  const notConfigured = config?.configured === false;
  const missing = unavailableQuestions(report);

  // The last explanation stays on screen while the next question is edited or sent.
  useEffect(() => {
    if (state.status === 'ready') setAnswer({ question: sent.current, text: state.text });
  }, [state]);

  useEffect(() => {
    if (loading || !restoreFocus.current) return;
    restoreFocus.current = false;
    const active = document.activeElement;
    // Cancel's removal releases focus to the document. A different target means the user moved on.
    if (active !== document.body && active !== document.documentElement && active !== writeButton.current) return;
    writeButton.current?.focus();
  }, [loading]);

  function send(text: string): void {
    sent.current = text;
    onRequest(text);
  }

  const status =
    state.status === 'loading'
      ? copy.loading
      : state.status === 'disabled'
        ? state.reason
        : state.status === 'idle' && !notConfigured
          ? copy.idle
          : '';

  return (
    <div className="insight-panel">
      {notConfigured ? (
        <div className="insight-notice" role="note">
          <h3>{copy.notConfiguredTitle}</h3>
          <p>{copy.notConfiguredBody}</p>
          <p className="insight-notice-detail">{config.reason}</p>
        </div>
      ) : null}

      <div className="insight-suggestions" role="group" aria-labelledby={`${questionId}-suggest`} aria-describedby={hintId}>
        <h3 id={`${questionId}-suggest`}>{copy.suggestionsLabel}</h3>
        <p id={hintId} className="insight-hint">
          {copy.suggestionsHint}
        </p>
        <ul className="insight-chips">
          {QUESTION_KEYS.map((key) => {
            const text = copy.questions[key];
            const reason = missing[key];
            return (
              <li key={key}>
                <button
                  type="button"
                  className="insight-chip"
                  aria-pressed={question === text}
                  disabled={loading || reason !== undefined}
                  onClick={() => setQuestion(text)}
                >
                  {text}
                </button>
                {reason ? <span className="insight-chip-reason">{copy.unavailable[reason]}</span> : null}
              </li>
            );
          })}
        </ul>
      </div>

      <label className="insight-question" htmlFor={questionId}>
        {copy.question}
      </label>
      <textarea
        id={questionId}
        rows={3}
        maxLength={4000}
        value={question}
        placeholder={copy.placeholder}
        disabled={loading}
        onChange={(event) => setQuestion(event.target.value)}
      />

      <div className="insight-sent">
        <h3>{copy.sentTitle}</h3>
        <p>{copy.sentBody}</p>
      </div>

      <div className="actions">
        <button
          ref={writeButton}
          type="button"
          disabled={loading || notConfigured || !question.trim()}
          onClick={() => send(question.trim())}
          className="btn btn-primary"
        >
          {copy.write}
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
            {copy.cancel}
          </button>
        ) : null}
        {state.status === 'error' && state.retryable && sent.current ? (
          <button type="button" onClick={() => send(sent.current)} className="btn btn-secondary">
            {copy.retry}
          </button>
        ) : null}
        {answer && !loading ? (
          <button type="button" onClick={() => setAnswer(null)} className="btn btn-quiet">
            {copy.clear}
          </button>
        ) : null}
      </div>

      <p className="insight-note" aria-live="polite">
        {status}
      </p>

      {state.status === 'error' ? (
        <div className="insight-error" role="alert">
          <h3>{copy.errorTitles[state.code] ?? copy.errorTitleFallback}</h3>
          <p>{state.message}</p>
        </div>
      ) : null}

      {answer ? (
        <div className="insight-result">
          <p className="inferred-label">{copy.inferredLabel}</p>
          <p className="insight-answer-for">{copy.answerFor(answer.question)}</p>
          {/* Model text is untrusted: React renders it as text, never as HTML. */}
          <p className="insight-text">{answer.text}</p>
        </div>
      ) : null}
    </div>
  );
}

/** The light line beside the section title: INFERRED, then the provider and model, never the key. */
export function insightAside(config: InsightConfig | null): string {
  const copy = COPY.insight;
  if (!config) return copy.inferred;
  if (!config.configured) return `${copy.inferred} · ${copy.notConfiguredLine}`;
  return `${copy.inferred} · ${copy.providerLine(copy.providers[config.provider], config.model)}`;
}
