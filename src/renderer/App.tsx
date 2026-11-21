import { useEffect, useRef, useState } from 'react';
import {
  coachMessageSchema,
  reportResultSchema,
  sampleBatchSchema,
  type CoachMessage,
  type PasteValidation,
  type PulseSample,
  type ReportResult,
  type SessionMeta,
  type ValidationMessage,
} from '../shared/contracts';
import { CONFIDENCE_FLOOR } from '../shared/sensing';
import { BandBars } from './BandBars';
import { CameraPreview } from './CameraPreview';
import { CoachLine } from './CoachLine';
import { GameList } from './GameList';
import { PasteScreen } from './PasteScreen';
import { SensingStrip } from './SensingStrip';
import { Timeline } from './Timeline';
import { VerdictLine } from './VerdictLine';

const TIME_CONTROLS = ['1+0', '3+2', '10+0'] as const;

type Phase = 'idle' | 'sensing' | 'stopped' | 'paste' | 'report';

export function App() {
  const [granted, setGranted] = useState(false);
  const [timeControl, setTimeControl] = useState<(typeof TIME_CONTROLS)[number]>('3+2');
  const [phase, setPhase] = useState<Phase>('idle');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [pasteSlots, setPasteSlots] = useState<string[]>([]);
  const [reportResult, setReportResult] = useState<ReportResult | null>(null);
  const [reportBuilding, setReportBuilding] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [samples, setSamples] = useState<PulseSample[]>([]);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [validation, setValidation] = useState<ValidationMessage | null>(null);
  const [sdkError, setSdkError] = useState<string | null>(null);
  const [betweenGames, setBetweenGames] = useState(false);
  const [gapPending, setGapPending] = useState(false);
  const [coachMessage, setCoachMessage] = useState<CoachMessage | null>(null);
  const [note, setNote] = useState('The camera stays off until you consent.');
  const [error, setError] = useState<string | null>(null);
  const bridge = window.chesspulse;
  const grantedNow = useRef(false);
  const startPending = useRef(false);
  const revokedDuringStart = useRef(false);
  const reportRequestSeq = useRef(0);
  const sessionIdRef = useRef<string | null>(null);

  function adoptSession(nextId: string): void {
    setBetweenGames(false);
    setGapPending(false);
    setCoachMessage(null);
    if (sessionIdRef.current === nextId) return;
    sessionIdRef.current = nextId;
    reportRequestSeq.current += 1;
    setSessionId(nextId);
    setError(null);
    setPasteSlots([]);
    setReportResult(null);
    setReportBuilding(false);
    setReportError(null);
    setSamples([]);
    setSelectedIndex(null);
    setValidation(null);
    setSdkError(null);
  }

  useEffect(() => {
    if (!bridge) return undefined;
    return bridge.onSamples((batch) => {
      const parsed = sampleBatchSchema.safeParse(batch);
      if (!parsed.success) return;
      setSamples((current) => [...current, ...parsed.data]);
      setSdkError((current) => (current === null ? current : null));
    });
  }, [bridge]);

  useEffect(() => {
    if (!bridge) return undefined;
    return bridge.onCoachMessage((message) => {
      const parsed = coachMessageSchema.safeParse(message);
      if (parsed.success) setCoachMessage(parsed.data);
    });
  }, [bridge]);

  useEffect(() => {
    if (!bridge) return undefined;
    return bridge.onValidation((message) => {
      setValidation(message);
      if (message.code === 0) setSdkError((current) => (current === null ? current : null));
    });
  }, [bridge]);

  useEffect(() => {
    if (!bridge) return undefined;
    return bridge.onSdkError((info) => {
      // Kept apart from operation errors, which no sensing event may clear.
      setSdkError(info.message);
      if (info.retryable) return;
      void (async () => {
        try {
          const meta = await bridge.stopSession();
          adoptSession(meta.id);
          setPhase('stopped');
          setNote(stoppedNote(meta));
        } catch {
          // The session may already be closed. The message above still stands.
          setPhase('stopped');
        } finally {
          // adoptSession clears session-scoped state, so the reason is restored after the stop.
          setSdkError(info.message);
        }
      })();
    });
  }, [bridge]);

  const status = error ?? sdkError ?? statusLine(phase, samples, note, validation);

  async function onConsent(): Promise<void> {
    if (!bridge) {
      setNote('This page is open outside the ChessPulse window. The camera stays off.');
      return;
    }
    const revoking = grantedNow.current;
    if (revoking && startPending.current) revokedDuringStart.current = true;
    let stopFailed = false;
    if (phase === 'sensing' || (revoking && startPending.current)) {
      try {
        const meta = await bridge.stopSession();
        adoptSession(meta.id);
        setError(null);
        setPhase('stopped');
        setNote(stoppedNote(meta));
      } catch {
        stopFailed = true;
        setError('The session could not be stopped.');
      }
    }
    try {
      const next = await bridge.setConsent(!grantedNow.current);
      if (!stopFailed) setError(null);
      grantedNow.current = next.granted;
      setGranted(next.granted);
      if (!next.granted) setNote('The camera stays off until you consent.');
      else setNote('Consent is on. The camera opens when you start sensing.');
    } catch {
      setNote('Consent could not be saved. The camera state is unchanged.');
    }
  }

  async function onStart(): Promise<void> {
    if (!bridge) {
      setNote('This page is open outside the ChessPulse window. The camera stays off.');
      return;
    }
    revokedDuringStart.current = false;
    startPending.current = true;
    try {
      const started = await bridge.startSession(timeControl);
      adoptSession(started.sessionId);
      if (revokedDuringStart.current || !grantedNow.current) {
        try {
          const meta = await bridge.stopSession();
          adoptSession(meta.id);
          setPhase('stopped');
          setNote(stoppedNote(meta));
        } catch {
          // Revocation already closed the session, or the start never opened one.
        }
        return;
      }
      setPhase('sensing');
      setNote('Waiting for a face.');
    } catch (caught: unknown) {
      if (!revokedDuringStart.current && grantedNow.current) {
        setError(ipcErrorText(caught, 'The session did not start. The camera stays off.'));
      }
    } finally {
      startPending.current = false;
    }
  }

  async function onStop(): Promise<void> {
    if (!bridge || phase !== 'sensing') return;
    try {
      const meta = await bridge.stopSession();
      adoptSession(meta.id);
      setError(null);
      setPhase('stopped');
      setNote(stoppedNote(meta));
    } catch {
      setError('The session could not be stopped.');
    }
  }

  async function onGapToggle(): Promise<void> {
    if (!bridge || phase !== 'sensing' || gapPending) return;
    setGapPending(true);
    setError(null);
    // A line from the previous gap must never appear during the next game. Clear before the call
    // so an immediate coach event for the new gap cannot be erased by its own response.
    setCoachMessage(null);
    try {
      const result = await bridge.setBetweenGames(!betweenGames);
      setBetweenGames(result.betweenGames);
    } catch (caught: unknown) {
      setError(ipcErrorText(caught, 'The game boundary could not be saved.'));
    } finally {
      setGapPending(false);
    }
  }

  async function onPasteContinue(pgns: string[], _validation: PasteValidation): Promise<void> {
    const seq = ++reportRequestSeq.current;
    setPasteSlots(pgns);
    setReportError(null);
    setReportResult(null);
    setPhase('report');
    if (!bridge || !sessionId) {
      setReportError('No stored session is available for this report.');
      return;
    }
    setReportBuilding(true);
    try {
      const raw = await bridge.buildReport(sessionId, pgns);
      if (seq !== reportRequestSeq.current) return;
      const parsed = reportResultSchema.safeParse(raw);
      if (!parsed.success) {
        setReportError('The report returned an unexpected shape.');
        return;
      }
      setReportResult(parsed.data);
    } catch (caught: unknown) {
      if (seq !== reportRequestSeq.current) return;
      setReportError(caught instanceof Error ? caught.message : 'The report could not be built.');
    } finally {
      if (seq === reportRequestSeq.current) setReportBuilding(false);
    }
  }

  if (phase === 'paste') {
    return (
      <main>
        <PasteScreen
          sessionId={sessionId}
          initialSlots={pasteSlots.length > 0 ? pasteSlots : undefined}
          onBack={(currentSlots) => {
            setPasteSlots(currentSlots);
            setPhase('stopped');
          }}
          onContinue={(pgns, validation) => {
            void onPasteContinue(pgns, validation);
          }}
        />
      </main>
    );
  }

  if (phase === 'report') {
    return (
      <main>
        <p className="label">ChessPulse · Report</p>
        {reportBuilding ? (
          <>
            <h1>Building report.</h1>
            <p aria-live="polite">Scoring positions locally with Stockfish…</p>
          </>
        ) : reportError ? (
          <>
            <h1>Report unavailable.</h1>
            <div className="refusal-panel" role="alert">
              <p>{reportError}</p>
            </div>
          </>
        ) : reportResult && reportResult.ok ? (
          <div className="report-layout">
            <VerdictLine report={reportResult} />
            <Timeline key={`ok-${reportResult.sessionId}`} result={reportResult} />
            <BandBars report={reportResult} />
            <GameList report={reportResult} />
          </div>
        ) : (
          <>
            <h1>{reportResult ? 'Review withheld.' : 'Session timeline.'}</h1>
            <Timeline key={`refusal-${sessionId ?? ''}`} result={reportResult} />
          </>
        )}
        <div className="actions">
          <button type="button" onClick={() => setPhase('paste')}>
            Edit pasted PGNs
          </button>
          <button type="button" onClick={() => setPhase('stopped')}>
            Back to session
          </button>
        </div>
      </main>
    );
  }

  return (
    <main>
      <p className="label">ChessPulse</p>
      <h1>{phase === 'sensing' ? 'Sensing.' : phase === 'stopped' ? 'Sensing stopped.' : 'Sensing has not started.'}</h1>
      {phase === 'sensing' ? <p className="indicator">Sensing</p> : null}
      <p aria-live="polite" role={error || sdkError ? 'alert' : undefined}>
        {status}
      </p>
      {granted ? <CameraPreview sensing={phase === 'sensing'} /> : null}
      <SensingStrip samples={samples} selectedIndex={selectedIndex} onSelect={setSelectedIndex} />
      {phase === 'sensing' && betweenGames ? <CoachLine message={coachMessage} /> : null}
      {phase === 'idle' ? (
        <div className="choices" role="group" aria-label="Time control">
          {TIME_CONTROLS.map((control) => (
            <button
              key={control}
              type="button"
              aria-pressed={control === timeControl}
              onClick={() => setTimeControl(control)}
            >
              {control}
            </button>
          ))}
        </div>
      ) : null}
      <div className="actions">
        {phase === 'stopped' ? (
          <button type="button" className="primary-btn" onClick={() => setPhase('paste')}>
            Paste PGNs
          </button>
        ) : null}
        {phase === 'sensing' ? (
          <>
            <button type="button" disabled={gapPending} onClick={() => void onGapToggle()}>
              {betweenGames ? 'Next game started' : 'Game ended'}
            </button>
            <button type="button" onClick={() => void onStop()}>
              Stop sensing
            </button>
          </>
        ) : (
          <button type="button" disabled={!granted} onClick={() => void onStart()}>
            Start sensing
          </button>
        )}
        <button type="button" aria-pressed={granted} onClick={() => void onConsent()}>
          {granted ? 'Revoke camera consent' : 'Allow the camera'}
        </button>
      </div>
    </main>
  );
}

function statusLine(
  phase: Phase,
  samples: PulseSample[],
  note: string,
  validation: ValidationMessage | null,
): string {
  if (phase !== 'sensing') return note;
  if (validation && validation.code !== 0) return validation.hint;
  if (samples.length === 0) return 'Waiting for a face.';
  const latest = samples[samples.length - 1];
  if (!latest.stable || latest.confidence < CONFIDENCE_FLOOR) {
    return samples.some((sample) => sample.stable && sample.confidence >= CONFIDENCE_FLOOR)
      ? 'Low confidence.'
      : 'Validating.';
  }
  return 'Sensing.';
}

function stoppedNote(meta: SessionMeta): string {
  const baseline = meta.baselineBpm === undefined ? 'No baseline.' : `Baseline ${formatNumber(meta.baselineBpm)} bpm.`;
  const coverage = meta.coverage === undefined ? 'No coverage.' : `Coverage ${formatNumber(meta.coverage.pct)}%.`;
  return `${baseline} ${coverage}`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** Electron wraps a rejected invoke in "Error invoking remote method …: Error: ", which is not for the player. */
function ipcErrorText(caught: unknown, fallback: string): string {
  if (!(caught instanceof Error)) return fallback;
  const marker = 'Error: ';
  const at = caught.message.lastIndexOf(marker);
  const text = (at >= 0 ? caught.message.slice(at + marker.length) : caught.message).trim();
  return text.length > 0 && !text.startsWith('Error invoking remote method') ? text : fallback;
}
