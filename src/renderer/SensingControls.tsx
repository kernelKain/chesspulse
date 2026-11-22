// What: the live sensing controls: elapsed time, limit warning, signal quality, gaps, and Stop.
// Why: a session needs one visible clock, one quality sentence, a player-marked game boundary,
//      and a confirmation before an irreversible stop.
// Removed: Stop would end a session on one mis-click, and the screen would show no time or quality.
import { useEffect, useId, useRef, type KeyboardEvent } from 'react';
import { COPY } from './copy';

export interface SensingControlsProps {
  elapsedLabel: string;
  limitWarning: string | null;
  qualityLabel: string;
  betweenGames: boolean;
  markedGames: number;
  gapPending: boolean;
  confirmingStop: boolean;
  onGap(): void;
  onRequestStop(): void;
  onConfirmStop(): void;
  onKeepSensing(): void;
}

export function SensingControls({
  elapsedLabel,
  limitWarning,
  qualityLabel,
  betweenGames,
  markedGames,
  gapPending,
  confirmingStop,
  onGap,
  onRequestStop,
  onConfirmStop,
  onKeepSensing,
}: SensingControlsProps) {
  const titleId = useId();
  const keepRef = useRef<HTMLButtonElement | null>(null);
  const stopButtonRef = useRef<HTMLButtonElement | null>(null);
  const wasConfirming = useRef(false);
  const games = COPY.sensing.marked(markedGames);

  useEffect(() => {
    if (confirmingStop) {
      wasConfirming.current = true;
      keepRef.current?.focus();
    } else if (wasConfirming.current) {
      wasConfirming.current = false;
      stopButtonRef.current?.focus();
    }
  }, [confirmingStop]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    onKeepSensing();
  }

  return (
    <section className="sensing-controls" aria-label={COPY.sensing.controlsLabel}>
      <div className="sensing-meta">
        <p className="sensing-clock">
          <span className="clock-value">{elapsedLabel}</span> {COPY.sensing.elapsed}
        </p>
        <p className="signal-quality">{qualityLabel}</p>
      </div>
      {limitWarning ? (
        <p className="limit-warning" role="status">
          {limitWarning}
        </p>
      ) : null}

      {confirmingStop ? (
        <div className="stop-confirm" role="group" aria-labelledby={titleId} onKeyDown={onKeyDown}>
          <h2 id={titleId}>{COPY.sensing.stopQuestion}</h2>
          <p>{COPY.sensing.stopBody}</p>
          <div className="actions">
            <button type="button" className="btn btn-primary" onClick={onConfirmStop}>
              {COPY.sensing.stop}
            </button>
            <button type="button" ref={keepRef} onClick={onKeepSensing} className="btn btn-secondary">
              {COPY.sensing.keepSensing}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="gap-row">
            <div>
              <p className="gap-state">
                {betweenGames ? COPY.sensing.waiting : COPY.sensing.playing}
              </p>
              <p className="gap-count">{games}</p>
            </div>
            <button type="button" disabled={gapPending} onClick={onGap} className="btn btn-secondary">
              {betweenGames ? COPY.sensing.nextGame : COPY.sensing.gameEnded}
            </button>
          </div>
          <button type="button" ref={stopButtonRef} onClick={onRequestStop} className="btn btn-secondary">
            {COPY.sensing.stopSensing}
          </button>
        </>
      )}
    </section>
  );
}
