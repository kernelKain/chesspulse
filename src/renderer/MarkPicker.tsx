// What: the Review's step for a session whose marks do not line up with the pasted games.
// Why: the player made the marks, so the player can say which one ended each game; no time is typed.
// Removed: a mismatched session would end in an error with no way to reach its report.
import { useId, useState } from 'react';
import type { SessionMarkView } from '../shared/contracts.js';
import { picksAreOrdered } from '../shared/marks.js';
import { formatElapsedMs } from '../shared/sensing.js';
import { COPY } from './copy';

export function MarkPicker({
  gameCount,
  marks,
  onSubmit,
  onCancel,
}: {
  gameCount: number;
  marks: readonly SessionMarkView[];
  onSubmit(ends: number[]): void;
  onCancel(): void;
}) {
  const baseId = useId();
  const [picks, setPicks] = useState<(number | null)[]>(() => Array.from({ length: gameCount }, () => null));
  const ordered = picksAreOrdered(picks);
  const ready = ordered && picks.every((pick) => pick !== null);

  function pick(index: number, value: string): void {
    const next = picks.map((item, at) => (at === index ? (value === '' ? null : Number(value)) : item));
    setPicks(next);
  }

  return (
    <section className="mark-picker" aria-labelledby={`${baseId}-heading`}>
      <p className="label">{COPY.markChoice.label}</p>
      <h1 id={`${baseId}-heading`}>{COPY.markChoice.title}</h1>
      <p>{COPY.markChoice.intro}</p>
      <ol className="mark-list">
        {picks.map((value, index) => {
          const fieldId = `${baseId}-game-${index}`;
          return (
            <li key={fieldId}>
              <label htmlFor={fieldId}>{COPY.markChoice.game(index)}</label>
              <select
                id={fieldId}
                value={value === null ? '' : String(value)}
                onChange={(event) => pick(index, event.target.value)}
              >
                <option value="">{COPY.markChoice.choose}</option>
                {marks.map((mark) => (
                  <option key={mark.atUs} value={mark.atUs}>
                    {COPY.markChoice.option(
                      formatElapsedMs(mark.elapsedUs / 1000),
                      mark.kind === 'end' ? COPY.markChoice.kindEnd : COPY.markChoice.kindNext,
                    )}
                  </option>
                ))}
              </select>
            </li>
          );
        })}
      </ol>
      {ordered ? null : (
        <p className="mark-order" role="alert">
          {COPY.markChoice.order}
        </p>
      )}
      <div className="actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!ready}
          onClick={() => {
            if (!ready) return;
            onSubmit(picks.filter((pick): pick is number => pick !== null));
          }}
        >
          {COPY.markChoice.build}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          {COPY.markChoice.cancel}
        </button>
      </div>
    </section>
  );
}
