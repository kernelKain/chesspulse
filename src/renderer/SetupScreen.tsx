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
import { COPY } from './copy';
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
      ? COPY.setup.framingGood
      : framingHint ?? COPY.setup.framingWaiting;
  const keyText =
    keyStatus === 'present'
      ? COPY.setup.keyPresent
      : keyStatus === 'loading'
        ? COPY.setup.checkingKey
        : keyDetail;
  const previewNote =
    preview === 'error'
      ? previewError ?? COPY.setup.previewFailed
      : preview === 'starting'
        ? COPY.setup.previewStarting
        : null;

  return (
    <section className="setup-screen">
      <p className="label">{COPY.common.screenLabels.setup}</p>
      <h1>{COPY.setup.heading}</h1>
      <p>
        {COPY.setup.intro}
      </p>
      {alert}

      <section className="setup-section" aria-labelledby="setup-consent">
        <h2 id="setup-consent">{COPY.setup.consentHeading}</h2>
        <p>
          {consent ? COPY.setup.consentOn : COPY.setup.consentOff}
        </p>
        <button type="button" aria-pressed={consent} onClick={onConsent} className="btn btn-secondary">
          {consent ? COPY.setup.revokeCamera : COPY.setup.allowCamera}
        </button>
        <p className="setup-key">
          <strong>{COPY.setup.keyLabel}</strong> <span>{keyText}</span>
        </p>
      </section>

      <section className="setup-section" aria-labelledby="setup-framing">
        <h2 id="setup-framing">{COPY.setup.framingHeading}</h2>
        <p>{COPY.setup.framingBody}</p>
        {previewSlot}
        {previewNote ? <p className="framing-note">{previewNote}</p> : null}
        {preview === 'error' ? (
          <button type="button" onClick={onRetryPreview} className="btn btn-secondary">
            {COPY.setup.framingRetry}
          </button>
        ) : null}
        <ul className="framing-checks">
          <FramingRow label={COPY.setup.checks.face} state={framing.face} />
          <FramingRow label={COPY.setup.checks.chest} state={framing.chest} />
          <FramingRow label={COPY.setup.checks.light} state={framing.light} />
        </ul>
        <p className="framing-hint">{hint}</p>
      </section>

      <section className="setup-section" aria-labelledby="setup-time">
        <h2 id="setup-time">{COPY.setup.timeHeading}</h2>
        <div className="choices" role="group" aria-label={COPY.setup.timeControlLabel}>
          {timeControls.map((control) => (
            <button
              key={control}
              type="button"
              aria-pressed={control === timeControl}
              onClick={() => onTimeControl(control)}
             className="btn btn-secondary">
              {control}
            </button>
          ))}
        </div>
      </section>

      <div className="setup-start">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!gate.canStart || starting}
          onClick={onStart}
        >
          {starting ? COPY.setup.starting : COPY.setup.start}
        </button>
        {starting ? (
          <p className="setup-ready">{COPY.setup.startingNote}</p>
        ) : gate.canStart ? (
          <p className="setup-ready">{COPY.setup.ready}</p>
        ) : (
          <ul className="setup-reasons" aria-live="polite">
            {gate.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="actions">
        <button type="button" onClick={onBack} className="btn btn-secondary">
          {COPY.common.actions.backToHome}
        </button>
        <button type="button" onClick={onHelp} className="btn btn-secondary">
          {COPY.common.actions.help}
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
