// What: the Review as three ordered stages — pulse, engine, reading — each with its own state.
// Why: R6-04 wants the three on one screen, and one failed stage must not hide the others.
// Removed: a refusal and an empty reading would look alike, and the page would be one long column.
import type { ReactNode } from 'react';
import type { StageId, StageView } from '../shared/stages.js';
import { COPY } from './copy';

export function ReviewStages({
  stages,
  bodies,
}: {
  stages: readonly StageView[];
  bodies: Partial<Record<StageId, ReactNode>>;
}) {
  return (
    <section className="stages" aria-label={COPY.stages.label}>
      {stages.map((stage) => {
        const body = stage.state === 'disabled' ? null : bodies[stage.id];
        return (
          <section key={stage.id} className="stage" data-state={stage.state} aria-labelledby={`stage-${stage.id}`}>
            <header className="stage-head">
              <h2 id={`stage-${stage.id}`}>
                {COPY.stages.heading(stage.index)} · {COPY.stages.titles[stage.id]}
              </h2>
              <span className={`stage-state state-${stage.state}`}>{COPY.stages.states[stage.state]}</span>
            </header>
            {body ? <div className="stage-body">{body}</div> : null}
            {!body && stage.reason ? (
              <p className="stage-reason">{COPY.stages.reasons[stage.reason]}</p>
            ) : null}
          </section>
        );
      })}
    </section>
  );
}
