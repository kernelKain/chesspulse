// What: the first-run and Help explainer. One copy source, two heading levels.
// Why: the limits and the five-step process must be readable before the camera opens and again later.
// Removed: the first screen would be controls with no explanation, and Help would repeat stale copy.
import { useId } from 'react';
import {
  EXPLAINER_AI_NOTE,
  EXPLAINER_INTRO,
  EXPLAINER_NEVERS,
  EXPLAINER_STEPS,
  EXPLAINER_TITLE,
} from '../shared/onboarding.js';

export function Explainer({
  showProgress = false,
  headingLevel = 1,
}: {
  showProgress?: boolean;
  headingLevel?: 1 | 2;
}) {
  const baseId = useId();
  const howId = `${baseId}-how`;
  const neverId = `${baseId}-never`;

  return (
    <section className="explainer" aria-label="How ChessPulse works">
      {headingLevel === 1 ? (
        <h1 className="explainer-title">{EXPLAINER_TITLE}</h1>
      ) : (
        <h2 className="explainer-title">{EXPLAINER_TITLE}</h2>
      )}
      <p className="explainer-intro">{EXPLAINER_INTRO}</p>

      <section aria-labelledby={howId}>
        {headingLevel === 1 ? (
          <h2 id={howId}>How it works</h2>
        ) : (
          <h3 id={howId}>How it works</h3>
        )}
        <ol className="explainer-steps">
          {EXPLAINER_STEPS.map((step, index) => (
            <li
              key={step.title}
              aria-current={showProgress && index === 0 ? 'step' : undefined}
            >
              <strong>{step.title}</strong> {step.body}
              {showProgress && index === 0 ? <span className="here">You are here</span> : null}
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby={neverId}>
        {headingLevel === 1 ? (
          <h2 id={neverId}>What ChessPulse never does</h2>
        ) : (
          <h3 id={neverId}>What ChessPulse never does</h3>
        )}
        <ul className="explainer-nevers">
          {EXPLAINER_NEVERS.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="explainer-ai">{EXPLAINER_AI_NOTE}</p>
      </section>
    </section>
  );
}
