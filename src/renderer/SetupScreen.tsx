// What: Setup's consent, key, framing, time-control, and Start gate in one screen.
// Why: the player must fix the exact blocking check before a session, and no "start anyway" may exist.
// Removed: a disabled Start with no reason, and framing advice that lived only in the README.
import type { ReactNode } from 'react';
import {
  framingReady,
  framingStatusText,
  type FramingChecks,
} from '../shared/framing.js';
import type { KeyStatus, PreviewStatus, SetupGate } from '../shared/setup.js';
export interface SetupScreenProps {
  consent: boolean;
  keyStatus: KeyStatus;
  keyDetail: string;
  framing: FramingChecks;
  framingHint: string | null;
  preview: PreviewStatus;
  previewError: string | null;
  starting?: boolean;
  previewSlot: ReactNode;
  alert?: ReactNode;
  timeControls: readonly string[];
  timeControl: string;
  gate: SetupGate;
  onConsent(): void;
  onTimeControl(control: string): void;
  onStart(): void;
  onRetryPreview(): void;
  onBack(): void;
  onHelp(): void;
}

export function SetupScreen({
  consent,
  keyStatus,
  keyDetail,
  framing,
  framingHint,
  preview,
  previewError,
  starting = false,
  previewSlot,
  alert,
  timeControls,
  timeControl,
  gate,
  onConsent,
  onTimeControl,
  onStart,
  onRetryPreview,
  onBack,
  onHelp,
}: SetupScreenProps) {
  const ready = framingReady(framing);
  const hint =
    ready
      ? 'Framing looks good.'
      : framingHint ?? 'Waiting for the camera to report framing.';
  const keyText =
    keyStatus === 'present'
      ? 'Present (value not shown).'
      : keyStatus === 'loading'
        ? 'Checking…'
        : keyDetail;
  const previewNote =
    preview === 'error'
      ? previewError ?? 'The camera preview could not start.'
      : preview === 'starting'
        ? 'Starting the camera preview…'
        : null;

  return (
    <section className="setup-screen">
      <p className="label">ChessPulse · Setup</p>
      <h1>Set up your session.</h1>
      <p>
        ChessPulse checks your consent, the SmartSpectra key, your framing, and the time control
        before a session. Nothing is recorded; only pulse numbers are stored on this computer.
      </p>
      {alert}

      <section className="setup-section" aria-labelledby="setup-consent">
        <h2 id="setup-consent">1. Consent and key</h2>
        <p>
          {consent
            ? 'Revoking consent releases the camera and stops an open session.'
            : 'The camera stays off until you press Allow the camera. Nothing is recorded.'}
        </p>
        <button type="button" aria-pressed={consent} onClick={onConsent}>
          {consent ? 'Revoke camera consent' : 'Allow the camera'}
        </button>
        <p className="setup-key">
          <strong>SmartSpectra key:</strong> <span>{keyText}</span>
        </p>
      </section>

      <section className="setup-section" aria-labelledby="setup-framing">
        <h2 id="setup-framing">2. Framing</h2>
        <p>
          Sit so you are the only face in view and your upper chest is visible. A lamp in front of
          you is the usual fix for a dark room.
        </p>
        {previewSlot}
        {previewNote ? <p className="framing-note">{previewNote}</p> : null}
        {preview === 'error' ? (
          <button type="button" onClick={onRetryPreview}>
            Try the preview again
          </button>
        ) : null}
        <ul className="framing-checks">
          <FramingRow label="One face in view" state={framing.face} />
          <FramingRow label="Upper chest visible" state={framing.chest} />
          <FramingRow label="Enough light" state={framing.light} />
        </ul>
        <p className="framing-hint">{hint}</p>
      </section>

      <section className="setup-section" aria-labelledby="setup-time">
        <h2 id="setup-time">3. Time control</h2>
        <div className="choices" role="group" aria-label="Time control">
          {timeControls.map((control) => (
            <button
              key={control}
              type="button"
              aria-pressed={control === timeControl}
              onClick={() => onTimeControl(control)}
            >
              {control}
            </button>
          ))}
        </div>
      </section>

      <div className="setup-start">
        <button
          type="button"
          className="primary-btn"
          disabled={!gate.canStart || starting}
          onClick={onStart}
        >
          {starting ? 'Starting…' : 'Start sensing'}
        </button>
        {starting ? (
          <p className="setup-ready">Starting the session…</p>
        ) : gate.canStart ? (
          <p className="setup-ready">All checks pass. Start when you are ready.</p>
        ) : (
          <ul className="setup-reasons" aria-live="polite">
            {gate.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="actions">
        <button type="button" onClick={onBack}>
          Back to Home
        </button>
        <button type="button" onClick={onHelp}>
          Help
        </button>
      </div>
    </section>
  );
}

function FramingRow({
  label,
  state,
}: {
  label: string;
  state: FramingChecks[keyof FramingChecks];
}) {
  return (
    <li>
      <span>{label}</span>
      <span className={`check-state state-${state}`}>{framingStatusText(state)}</span>
    </li>
  );
}
