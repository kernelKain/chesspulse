import { useEffect, useRef, useState } from 'react';
import {
  reportResultSchema,
  sampleBatchSchema,
  type PasteValidation,
  type PulseSample,
  type ReportResult,
  type SessionMeta,
} from '../shared/contracts';
import { CONFIDENCE_FLOOR } from '../shared/sensing';
import { BandBars } from './BandBars';
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
  const [note, setNote] = useState('The camera stays off until you consent.');
  const [error, setError] = useState<string | null>(null);
  const bridge = window.chesspulse;
  const grantedNow = useRef(false);
  const startPending = useRef(false);
  const revokedDuringStart = useRef(false);
  const reportRequestSeq = useRef(0);

  useEffect(() => {
    if (!bridge) return undefined;
    return bridge.onSamples((batch) => {
      const parsed = sampleBatchSchema.safeParse(batch);
      if (!parsed.success) return;
      setSamples((current) => [...current, ...parsed.data]);
    });
  }, [bridge]);

  const status = error ?? statusLine(phase, samples, note);

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
        setSessionId(meta.id);
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
      else if (!next.cameraAllowed) {
        setNote('Consent is on. This page is not a local file, so the camera stays blocked.');
      } else setNote('The camera is allowed for this window.');
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
      reportRequestSeq.current += 1;
      setSessionId(started.sessionId);
      setError(null);
      setPasteSlots([]);
      setReportResult(null);
      setReportBuilding(false);
      setReportError(null);
      setSamples([]);
      setSelectedIndex(null);
      if (revokedDuringStart.current || !grantedNow.current) {
        try {
          const meta = await bridge.stopSession();
          setSessionId(meta.id);
          setPhase('stopped');
          setNote(stoppedNote(meta));
        } catch {
          // Revocation already closed the session, or the start never opened one.
        }
        return;
      }
      setPhase('sensing');
      setNote('Waiting for a face.');
    } catch {
      if (!revokedDuringStart.current && grantedNow.current) {
        setError('The session did not start. The camera stays off.');
      }
    } finally {
      startPending.current = false;
    }
  }

  async function onStop(): Promise<void> {
    if (!bridge || phase !== 'sensing') return;
    try {
      const meta = await bridge.stopSession();
      setSessionId(meta.id);
      setError(null);
      setPhase('stopped');
      setNote(stoppedNote(meta));
    } catch {
      setError('The session could not be stopped.');
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
      <p aria-live="polite">{status}</p>
      <SensingStrip samples={samples} selectedIndex={selectedIndex} onSelect={setSelectedIndex} />
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
          <button type="button" onClick={() => void onStop()}>
            Stop sensing
          </button>
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

function statusLine(phase: Phase, samples: PulseSample[], note: string): string {
  if (phase !== 'sensing') return note;
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
