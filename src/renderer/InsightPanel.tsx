import { useEffect, useRef, useState } from 'react';
import type { AiProvider } from '../shared/contracts';

export type InsightViewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'disabled'; reason: string }
  | { status: 'error'; message: string }
  | { status: 'ready'; text: string };

const PROVIDERS: { value: AiProvider; label: string }[] = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'google', label: 'Google' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'custom', label: 'Custom OpenAI-compatible' },
];

export function InsightPanel({
  state,
  onRequest,
  onCancel,
}: {
  state: InsightViewState;
  onRequest: (provider: AiProvider, text: string) => void;
  onCancel: () => void;
}) {
  const [provider, setProvider] = useState<AiProvider>('openai');
  const [question, setQuestion] = useState('What should I understand from this session?');
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
      ? 'Nothing is sent until you choose Write reading.'
      : state.status === 'loading'
        ? 'Writing from the computed report…'
        : state.status === 'disabled'
          ? state.reason
          : state.status === 'error'
            ? state.message
            : state.text;

  return (
    <section className="insight-panel" aria-labelledby="insight-title">
      <p className="label">Layer 4 · Optional</p>
      <h2 id="insight-title">Reading</h2>
      <p className="inferred-label">INFERRED — written by a model from the numbers above. Not measured.</p>

      <div className="insight-controls">
        <label>
          Provider
          <select value={provider} disabled={loading} onChange={(event) => setProvider(event.target.value as AiProvider)}>
            {PROVIDERS.map((item) => (
              <option key={item.value} value={item.value}>{item.label}</option>
            ))}
          </select>
        </label>
        <label>
          Question
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
        <button ref={writeButton} type="button" disabled={loading || !question.trim()} onClick={() => onRequest(provider, question.trim())}>
          Write reading
        </button>
        {loading ? (
          <button
            ref={cancelButton}
            type="button"
            onClick={() => {
              restoreFocus.current = document.activeElement === cancelButton.current;
              onCancel();
            }}
          >
            Cancel
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
