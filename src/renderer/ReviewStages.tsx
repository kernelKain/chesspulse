// What: the Review's three sections — Pulse & Play Timeline, Move Quality, AI Session Explainer.
// Why: R6-04 keeps the three on one screen, and one failed section must not hide the others. The
//      titles name what each section covers; internal stage numbers are not shown to the player.
// Removed: a refusal and an empty reading would look alike, and the page would be one long column.
import type { ReactNode } from 'react';
import type { StageId, StageView } from '../shared/stages.js';
import { COPY } from './copy';

export function ReviewStages({
  stages,
  bodies,
  asides = {},
}: {
  stages: readonly StageView[];
  bodies: Partial<Record<StageId, ReactNode>>;
  /** Light text on the right of a section heading, such as the engine that scored the moves. */
  asides?: Partial<Record<StageId, string>>;
}) {
  return (
    <div className="stages" role="group" aria-label={COPY.stages.label}>
      {stages.map((stage) => {
        // Only the pulse section can block the later ones. The explainer keeps its controls even
        // when it is disabled, so its body is never suppressed.
        const body =
          stage.id !== 'reading' && stage.state === 'disabled' ? null : bodies[stage.id];
        const aside = asides[stage.id];
        return (
          <section key={stage.id} className="stage" data-state={stage.state} aria-labelledby={`stage-${stage.id}`}>
            <header className="stage-head">
              <div className="stage-title">
                <h2 id={`stage-${stage.id}`}>{COPY.stages.titles[stage.id]}</h2>
                <p className="stage-description">{COPY.stages.descriptions[stage.id]}</p>
              </div>
              <div className="stage-meta">
                {aside ? <span className="stage-aside">{aside}</span> : null}
                <span className={`stage-state state-${stage.state}`}>{COPY.stages.states[stage.state]}</span>
              </div>
            </header>
            {body ? <div className="stage-body">{body}</div> : null}
            {!body && stage.reason ? (
              <p className="stage-reason">{stage.detail ?? COPY.stages.reasons[stage.reason]}</p>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
