import { useEffect, useRef, useState } from 'react';
import {
  sampleBatchSchema,
  type PasteValidation,
  type PulseSample,
  type SessionMeta,
} from '../shared/contracts';
import { CONFIDENCE_FLOOR } from '../shared/sensing';
import { PasteScreen } from './PasteScreen';
import { SensingStrip } from './SensingStrip';

const TIME_CONTROLS = ['1+0', '3+2', '10+0'] as const;

type Phase = 'idle' | 'sensing' | 'stopped' | 'paste';

export function App() {
  const [granted, setGranted] = useState(false);
  const [timeControl, setTimeControl] = useState<(typeof TIME_CONTROLS)[number]>('3+2');
  const [phase, setPhase] = useState<Phase>('idle');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [pasteSlots, setPasteSlots] = useState<string[]>([]);
  const [samples, setSamples] = useState<PulseSample[]>([]);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [note, setNote] = useState('The camera stays off until you consent.');
  const [error, setError] = useState<string | null>(null);
  const bridge = window.chesspulse;
  const grantedNow = useRef(false);
  const startPending = useRef(false);
  const revokedDuringStart = useRef(false);

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
      setSessionId(started.sessionId);
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
      setError(null);
      setPasteSlots([]);
      setSamples([]);
      setSelectedIndex(null);
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

  function onPasteContinue(pgns: string[], validation: PasteValidation): void {
    setPasteSlots(pgns);
    setPhase('stopped');
    const count = `${validation.summary.total} ${validation.summary.total === 1 ? 'game' : 'games'}`;
    setNote(`${count} validated and ready for the report view.`);
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
          onContinue={onPasteContinue}
        />
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
