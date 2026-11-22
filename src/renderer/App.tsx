import { useEffect, useReducer, useRef, useState } from 'react';
import {
  appStateSchema,
  coachMessageSchema,
  insightResultSchema,
  reportProgressSchema,
  reportResultSchema,
  sampleBatchSchema,
  sessionEndedSchema,
  sessionListResultSchema,
  sessionOpenResultSchema,
  sessionStartedSchema,
  setupStatusSchema,
  type AiProvider,
  type CoachMessage,
  type PasteValidation,
  type PulseSample,
  type SessionMeta,
  type SessionSummary,
  type ValidationMessage,
} from '../shared/contracts';
import {
  currentSessionId,
  flowReducer,
  initialFlowState,
  sensingHint,
  statusFor,
  type StatusLine,
} from '../shared/flow';
import { appErrorInfo } from '../shared/errors';
import {
  framingFromValidation,
  UNKNOWN_FRAMING,
} from '../shared/framing';
import {
  readExplainerSeen,
  rememberExplainerSeen,
  type PreferenceStore,
} from '../shared/onboarding';
import {
  formatElapsedMs,
  limitWarning,
  signalQuality,
  signalStale,
} from '../shared/sensing';
import {
  keyStatusFromChecks,
  setupGate,
  type KeyStatus,
  type PreviewStatus,
} from '../shared/setup';
import { BandBars } from './BandBars';
import { CameraOpenIndicator } from './CameraOpenIndicator';
import { CameraPreview } from './CameraPreview';
import { CoachLine } from './CoachLine';
import { Explainer } from './Explainer';
import { GameList } from './GameList';
import { InsightPanel, type InsightViewState } from './InsightPanel';
import { readIpcError } from './ipc-error';
import { PasteScreen } from './PasteScreen';
import { RefusalPanel } from './RefusalPanel';
import { ReviewProgress } from './ReviewProgress';
import { SensingControls } from './SensingControls';
import { SensingStrip } from './SensingStrip';
import { SessionList } from './SessionList';
import { SetupScreen } from './SetupScreen';
import { Timeline } from './Timeline';
import { VerdictLine } from './VerdictLine';

const TIME_CONTROLS = ['1+0', '3+2', '10+0'] as const;

/** Reading the page's own storage must never be able to stop the page from rendering. */
function preferenceStore(): PreferenceStore | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function App() {
  const [flow, dispatch] = useReducer(flowReducer, undefined, () =>
    initialFlowState(readExplainerSeen(preferenceStore())),
  );
  const [timeControl, setTimeControl] = useState<(typeof TIME_CONTROLS)[number]>('3+2');
  const [gapPending, setGapPending] = useState(false);
  const [samples, setSamples] = useState<PulseSample[]>([]);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [validation, setValidation] = useState<ValidationMessage | null>(null);
  const [coachMessage, setCoachMessage] = useState<CoachMessage | null>(null);
  const [insightState, setInsightState] = useState<InsightViewState>({ status: 'idle' });
  const [setupKey, setSetupKey] = useState<{ status: KeyStatus; detail: string }>({
    status: 'loading',
    detail: 'Checking…',
  });
  const [preview, setPreview] = useState<PreviewStatus>('idle');
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [starting, setStarting] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [lastSampleAtMs, setLastSampleAtMs] = useState<number | null>(null);
  const [library, setLibrary] = useState<{
    status: 'idle' | 'loading' | 'ready' | 'error';
    sessions: SessionSummary[];
    unreadable: number;
  }>({ status: 'idle', sessions: [], unreadable: 0 });
  const [libraryNonce, setLibraryNonce] = useState(0);
  const bridge = window.chesspulse;
  const grantedNow = useRef(false);
  const startPending = useRef(false);
  const revokedDuringStart = useRef(false);
  const reportRequestSeq = useRef(0);
  const insightRequestSeq = useRef(0);
  const sessionIdRef = useRef<string | null>(null);
  const terminalSessionRef = useRef<string | null>(null);
  const supersededSessions = useRef<Set<string>>(new Set());
  const screenRef = useRef(flow.screen);
  const librarySeq = useRef(0);

  function resetInsight(): void {
    insightRequestSeq.current += 1;
    setInsightState({ status: 'idle' });
  }

  function adoptSession(nextId: string, startedAtEpochMs: number): void {
    resetInsight();
    setCoachMessage(null);
    if (sessionIdRef.current === nextId) return;
    if (sessionIdRef.current) supersededSessions.current.add(sessionIdRef.current);
    sessionIdRef.current = nextId;
    terminalSessionRef.current = null;
    reportRequestSeq.current += 1;
    // The error handler runs before the screen effect, so the ref must move with the session.
    screenRef.current = 'sensing';
    dispatch({ type: 'sessionStarted', sessionId: nextId, startedAtEpochMs });
    setSamples([]);
    setSelectedIndex(null);
    setValidation(null);
    setLastSampleAtMs(null);
  }

  function settleSession(nextId: string, notice: string): void {
    resetInsight();
    setCoachMessage(null);
    if (sessionIdRef.current && sessionIdRef.current !== nextId) {
      supersededSessions.current.add(sessionIdRef.current);
    }
    sessionIdRef.current = nextId;
    reportRequestSeq.current += 1;
    screenRef.current = 'stopped';
    dispatch({ type: 'sessionStopped', sessionId: nextId, notice });
  }

  function dismissExplainer(startSetup: boolean): void {
    rememberExplainerSeen(preferenceStore());
    dispatch({ type: 'explainerDismissed' });
    if (startSetup) dispatch({ type: 'openSetup' });
  }

  // What: one load-time read of main's consent and live-session state.
  // Why: a reloaded page must not render consent off while main still holds it, nor forget a session.
  useEffect(() => {
    if (!bridge) return;
    void bridge
      .getAppState()
      .then((raw) => {
        const parsed = appStateSchema.safeParse(raw);
        if (!parsed.success) return;
        const { consent, session } = parsed.data;
        grantedNow.current = consent.granted;
        if (session.active && session.sessionId && session.startedAtEpochMs !== null) {
          sessionIdRef.current = session.sessionId;
          terminalSessionRef.current = null;
        }
        dispatch({
          type: 'hydrated',
          consent: consent.granted,
          session:
            session.active && session.sessionId && session.startedAtEpochMs !== null
              ? {
                  id: session.sessionId,
                  startedAtEpochMs: session.startedAtEpochMs,
                  betweenGames: session.betweenGames,
                  markedGames: session.markedGames,
                }
              : null,
        });
      })
      .catch(() => {
        // A failed state read leaves the page in its honest default: camera off, Home.
      });
  }, [bridge]);

  // The consent switch follows the reducer even when main changes it behind the page.
  useEffect(() => {
    grantedNow.current = flow.consent;
  }, [flow.consent]);

  useEffect(() => {
    screenRef.current = flow.screen;
  }, [flow.screen]);

  // The clock is the page's display only; the stored header and the main-process timer remain the
  // authority for duration and the 90-minute stop.
  useEffect(() => {
    if (!flow.session) return undefined;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [flow.session?.id]);

  useEffect(() => {
    setConfirmingStop(false);
  }, [flow.session?.id, flow.screen]);

  // Home and Sessions read the stored library. A reload or a delete refreshes it; a late response
  // from a previous visit is ignored by the sequence.
  useEffect(() => {
    if (flow.screen !== 'home' && flow.screen !== 'sessions') return;
    if (!bridge) {
      setLibrary({ status: 'error', sessions: [], unreadable: 0 });
      return;
    }
    const seq = ++librarySeq.current;
    setLibrary((current) => ({ ...current, status: 'loading' }));
    void bridge
      .listSessions()
      .then((raw) => {
        if (seq !== librarySeq.current) return;
        const parsed = sessionListResultSchema.safeParse(raw);
        if (!parsed.success) {
          setLibrary({ status: 'error', sessions: [], unreadable: 0 });
          return;
        }
        setLibrary({
          status: 'ready',
          sessions: parsed.data.sessions,
          unreadable: parsed.data.unreadable,
        });
      })
      .catch(() => {
        if (seq === librarySeq.current) {
          setLibrary({ status: 'error', sessions: [], unreadable: 0 });
        }
      });
  }, [flow.screen, bridge, libraryNonce]);

  // Setup asks the doctor once per visit. The key row is the same check the CLI prints.
  useEffect(() => {
    if (flow.screen !== 'setup') {
      setPreview('idle');
      setPreviewError(null);
      // Forget this visit's key result, so returning to Setup does not blink the camera
      // between a stale "present" and the fresh doctor answer.
      setSetupKey({ status: 'loading', detail: 'Checking…' });
      return undefined;
    }
    if (!bridge) {
      setSetupKey({
        status: 'error',
        detail: 'This page is open outside the ChessPulse window.',
      });
      return undefined;
    }
    let alive = true;
    setSetupKey({ status: 'loading', detail: 'Checking…' });
    setPreview('idle');
    setPreviewError(null);
    setValidation(null);
    void bridge
      .getSetupStatus()
      .then((raw) => {
        if (!alive) return;
        const parsed = setupStatusSchema.safeParse(raw);
        if (!parsed.success) {
          setSetupKey({ status: 'error', detail: 'The key check returned an unexpected result.' });
          return;
        }
        setSetupKey(keyStatusFromChecks(parsed.data.checks));
      })
      .catch(() => {
        if (alive) setSetupKey({ status: 'error', detail: 'The key check could not run.' });
      });
    return () => {
      alive = false;
    };
  }, [flow.screen, bridge]);

  // The camera preview exists only on Setup, only after consent, and only once the key is known.
  // Its cleanup runs on every path that leaves Setup, so no screen retains a live camera.
  useEffect(() => {
    if (flow.screen !== 'setup' || !bridge || !flow.consent || setupKey.status !== 'present') {
      // Keep the status honest when consent or the key removes the preview.
      if (flow.screen === 'setup' && (preview === 'running' || preview === 'starting')) {
        setPreview('idle');
      }
      return undefined;
    }
    let alive = true;
    setPreview('starting');
    setPreviewError(null);
    setValidation(null);
    void bridge
      .startPreview()
      .then(() => {
        if (alive) setPreview('running');
      })
      .catch((caught: unknown) => {
        if (!alive) return;
        setPreview('error');
        setPreviewError(readIpcError(caught, 'camera_unavailable'));
      });
    return () => {
      alive = false;
      void bridge.stopPreview().catch(() => undefined);
    };
  }, [flow.screen, flow.consent, setupKey.status, previewAttempt, bridge]);

  useEffect(() => {
    if (!bridge) return undefined;
    return bridge.onSamples((batch) => {
      const parsed = sampleBatchSchema.safeParse(batch);
      if (!parsed.success) return;
      if (parsed.data.length > 0) setLastSampleAtMs(Date.now());
      setSamples((current) => [...current, ...parsed.data]);
      dispatch({ type: 'clearSdkError' });
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
      if (message.code === 0) dispatch({ type: 'clearSdkError' });
    });
  }, [bridge]);

  useEffect(() => {
    if (!bridge) return undefined;
    return bridge.onSdkError((info) => {
      // Kept apart from operation errors, which no sensing event may clear.
      dispatch({ type: 'sdkError', message: info.message });
      if (!info.retryable) {
        // A terminal error during the start invoke belongs to the session being opened, not the
        // preview that main has already released.
        if (screenRef.current === 'setup' && !startPending.current) {
          setPreview('error');
          setPreviewError(info.message);
        } else {
          void (async () => {
            try {
              const meta = await bridge.stopSession();
              settleSession(meta.id, stoppedNote(meta));
            } catch {
              // The session may already be closed. The message above still stands, and the screen
              // must not keep claiming it is sensing.
              if (sessionIdRef.current) {
                dispatch({
                  type: 'sessionStopped',
                  sessionId: sessionIdRef.current,
                  notice: 'The session stopped after a sensing error.',
                });
              } else {
                dispatch({ type: 'openStopped' });
              }
            }
          })();
        }
      }
    });
  }, [bridge]);

  useEffect(() => {
    if (!bridge) return undefined;
    return bridge.onSessionEnded((event) => {
      const parsed = sessionEndedSchema.safeParse(event);
      if (!parsed.success) return;
      // A late event from a session the page has already replaced must not switch the screen back.
      if (supersededSessions.current.has(parsed.data.sessionId)) return;
      settleSession(parsed.data.sessionId, parsed.data.message);
      terminalSessionRef.current = parsed.data.sessionId;
      dispatch({ type: 'clearError' });
    });
  }, [bridge]);

  useEffect(() => {
    if (!bridge) return undefined;
    return bridge.onSessionStarted((event) => {
      const parsed = sessionStartedSchema.safeParse(event);
      if (!parsed.success) return;
      if (terminalSessionRef.current === parsed.data.sessionId) return;
      if (supersededSessions.current.has(parsed.data.sessionId)) return;
      // A page that already adopted a different live session must not switch to a late start event.
      if (sessionIdRef.current && sessionIdRef.current !== parsed.data.sessionId) return;
      // The event means main opened a session, which requires consent. Set both before the
      // session, so a reload that missed the invoke reply does not show an off consent switch.
      grantedNow.current = true;
      dispatch({ type: 'consentChanged', granted: true });
      adoptSession(parsed.data.sessionId, parsed.data.startedAtEpochMs);
    });
  }, [bridge]);

  useEffect(() => {
    if (!bridge) return undefined;
    return bridge.onReportProgress((progress) => {
      const parsed = reportProgressSchema.safeParse(progress);
      if (!parsed.success || parsed.data.sessionId !== sessionIdRef.current) return;
      dispatch({
        type: 'reportProgress',
        scored: parsed.data.scored,
        total: parsed.data.total,
      });
    });
  }, [bridge]);

  // Focus follows the screen and the first-run explanation, so a click never leaves it on removed
  // content. A finished or failed report also replaces the heading, so it moves there too.
  useEffect(() => {
    const heading = document.querySelector<HTMLElement>('main h1');
    if (!heading) return;
    heading.tabIndex = -1;
    heading.focus();
  }, [flow.screen, flow.explainerSeen, flow.review?.building]);

  const sessionId = currentSessionId(flow);
  const framing = validation ? framingFromValidation(validation.code) : UNKNOWN_FRAMING;
  const gate = setupGate({
    consent: flow.consent,
    keyStatus: setupKey.status,
    keyDetail: setupKey.detail,
    preview,
    previewError,
    framing,
  });
  const elapsedMs = flow.session ? Math.max(0, nowMs - flow.session.startedAtEpochMs) : 0;
  const quality = signalQuality(samples);
  const qualityLabel = signalStale(lastSampleAtMs, nowMs)
    ? 'No recent signal — check the camera'
    : quality.label;
  const status = statusFor({
    error: flow.error,
    sdkError: flow.sdkError,
    screen: flow.screen,
    hint: sensingHint(samples, validation),
    notice: flow.notice,
  });

  async function onConsent(): Promise<void> {
    if (!bridge) {
      dispatch({
        type: 'notice',
        message: 'This page is open outside the ChessPulse window. The camera stays off.',
      });
      return;
    }
    const revoking = grantedNow.current;
    if (revoking && startPending.current) revokedDuringStart.current = true;
    let stopFailed = false;
    if (flow.screen === 'sensing' || (revoking && startPending.current)) {
      try {
        const meta = await bridge.stopSession();
        settleSession(meta.id, stoppedNote(meta));
        dispatch({ type: 'clearError' });
      } catch {
        stopFailed = true;
        dispatch({ type: 'error', message: 'The session could not be stopped.' });
      }
    }
    try {
      const next = await bridge.setConsent(!grantedNow.current);
      if (!stopFailed) dispatch({ type: 'clearError' });
      grantedNow.current = next.granted;
      dispatch({ type: 'consentChanged', granted: next.granted });
    } catch {
      dispatch({
        type: 'notice',
        message: 'Consent could not be saved. The camera state is unchanged.',
      });
    }
  }

  async function onStart(): Promise<void> {
    if (!bridge || flow.screen !== 'setup' || !gate.canStart || startPending.current) return;
    revokedDuringStart.current = false;
    startPending.current = true;
    setStarting(true);
    try {
      const started = await bridge.startSession(timeControl);
      adoptSession(started.sessionId, started.startedAtEpochMs);
      // A terminal event may have arrived before the start response completed.
      if (terminalSessionRef.current === started.sessionId) return;
      if (revokedDuringStart.current || !grantedNow.current) {
        try {
          const meta = await bridge.stopSession();
          settleSession(meta.id, stoppedNote(meta));
        } catch {
          // Consent revocation has normally finalized the session already, so stopSession
          // rejects. The screen must not keep claiming it is sensing a session that is gone.
          settleSession(started.sessionId, 'The session stopped after consent was withdrawn.');
        }
        return;
      }
    } catch (caught: unknown) {
      if (!revokedDuringStart.current && grantedNow.current) {
        dispatch({ type: 'error', message: readIpcError(caught, 'session_failed') });
        // Main released the preview before the failed start. Rebuild it so Setup is usable again.
        setPreview('idle');
        setPreviewAttempt((attempt) => attempt + 1);
      }
    } finally {
      startPending.current = false;
      setStarting(false);
    }
  }

  async function onStop(): Promise<void> {
    if (!bridge || flow.screen !== 'sensing') return;
    try {
      const meta = await bridge.stopSession();
      settleSession(meta.id, stoppedNote(meta));
      dispatch({ type: 'clearError' });
    } catch {
      dispatch({ type: 'error', message: 'The session could not be stopped.' });
    }
  }

  async function onGapToggle(): Promise<void> {
    if (!bridge || flow.screen !== 'sensing' || gapPending || !flow.session) return;
    setGapPending(true);
    dispatch({ type: 'clearError' });
    // A line from the previous gap must never appear during the next game. Clear before the call
    // so an immediate coach event for the new gap cannot be erased by its own response.
    setCoachMessage(null);
    try {
      const result = await bridge.setBetweenGames(!flow.session.betweenGames);
      dispatch({ type: 'gapChanged', betweenGames: result.betweenGames });
    } catch (caught: unknown) {
      dispatch({ type: 'error', message: readIpcError(caught, 'session_failed') });
    } finally {
      setGapPending(false);
    }
  }

  async function onInsightRequest(provider: AiProvider, text: string): Promise<void> {
    if (!bridge || !sessionId) return;
    const seq = ++insightRequestSeq.current;
    setInsightState({ status: 'loading' });
    try {
      const raw = await bridge.requestInsight({ sessionId, provider, text });
      if (seq !== insightRequestSeq.current) return;
      const parsed = insightResultSchema.safeParse(raw);
      if (!parsed.success) {
        setInsightState({
          status: 'error',
          message: 'The reading returned an unexpected shape. The report is unchanged.',
        });
      } else if (parsed.data.disabled) {
        setInsightState({ status: 'disabled', reason: parsed.data.reason });
      } else {
        setInsightState({ status: 'ready', text: parsed.data.text });
      }
    } catch (caught: unknown) {
      if (seq !== insightRequestSeq.current) return;
      setInsightState({
        status: 'error',
        message: readIpcError(caught, 'ai_unavailable'),
      });
    }
  }

  async function onInsightCancel(): Promise<void> {
    if (!bridge || !sessionId) return;
    insightRequestSeq.current += 1;
    setInsightState({ status: 'idle' });
    try {
      await bridge.cancelInsight(sessionId);
    } catch {
      // The timeout still bounds the call; its result is ignored after the sequence change.
    }
  }

  async function onPasteContinue(pgns: string[], _validation: PasteValidation): Promise<void> {
    if (!sessionId) {
      dispatch({ type: 'error', message: 'No stored session is available for this report.' });
      return;
    }
    if (bridge) void bridge.cancelInsight(sessionId).catch(() => undefined);
    resetInsight();
    const seq = ++reportRequestSeq.current;
    dispatch({ type: 'reportStarted', sessionId, slots: pgns });
    if (!bridge) {
      dispatch({ type: 'reportFailed', message: 'This page is open outside the ChessPulse window.' });
      return;
    }
    try {
      const raw = await bridge.buildReport(sessionId, pgns);
      if (seq !== reportRequestSeq.current) return;
      const parsed = reportResultSchema.safeParse(raw);
      if (!parsed.success) {
        dispatch({ type: 'reportFailed', message: 'The report returned an unexpected shape.' });
        return;
      }
      dispatch({ type: 'reportReady', result: parsed.data });
    } catch (caught: unknown) {
      if (seq !== reportRequestSeq.current) return;
      dispatch({ type: 'reportFailed', message: readIpcError(caught, 'report_failed') });
    }
  }

  async function onCancelReport(): Promise<void> {
    if (!bridge || !sessionId || !flow.review?.building || flow.review.cancelling) return;
    const seq = reportRequestSeq.current;
    dispatch({ type: 'reportCancelRequested' });
    try {
      const result = await bridge.cancelReport(sessionId);
      if (seq !== reportRequestSeq.current) return;
      if (!result.cancelled) dispatch({ type: 'reportCancelRejected' });
    } catch {
      // Let the player retry if the cancel request never reached main.
      if (seq === reportRequestSeq.current) dispatch({ type: 'reportCancelRejected' });
    }
  }

  async function onCopyDiagnostics(): Promise<void> {
    if (!bridge) {
      dispatch({
        type: 'notice',
        message: 'This page is open outside the ChessPulse window. Diagnostics are unavailable.',
      });
      return;
    }
    try {
      await bridge.copyDiagnostics();
      dispatch({ type: 'clearError' });
      dispatch({
        type: 'notice',
        message: 'Diagnostics copied. They contain no games, pulse samples, or keys.',
      });
    } catch (caught: unknown) {
      dispatch({ type: 'error', message: readIpcError(caught, 'internal') });
    }
  }

  async function onOpenSession(sessionId: string): Promise<void> {
    if (!bridge) return;
    if (flow.session) {
      dispatch({ type: 'error', message: 'Stop the current session before opening another.' });
      return;
    }
    try {
      const raw = await bridge.openSession(sessionId);
      const parsed = sessionOpenResultSchema.safeParse(raw);
      if (!parsed.success) {
        dispatch({ type: 'error', message: 'The saved session returned an unexpected shape.' });
        return;
      }
      // A build from the previous review must not land on the newly opened session.
      if (flow.review?.building) {
        void bridge.cancelReport(flow.review.sessionId).catch(() => undefined);
      }
      resetInsight();
      reportRequestSeq.current += 1;
      sessionIdRef.current = sessionId;
      terminalSessionRef.current = null;
      dispatch({
        type: 'openedSession',
        sessionId,
        report: parsed.data.report,
        games: parsed.data.games,
      });
      if (parsed.data.reportError) {
        dispatch({ type: 'notice', message: reportErrorCopy(parsed.data.reportError) });
      }
    } catch (caught: unknown) {
      dispatch({ type: 'error', message: readIpcError(caught, 'report_failed') });
    }
  }

  async function onDeleteSession(sessionId: string): Promise<void> {
    if (!bridge) return;
    try {
      const result = await bridge.deleteSession(sessionId);
      dispatch({ type: 'sessionDeleted', sessionId });
      dispatch({
        type: 'notice',
        message: result.deleted ? 'Session deleted.' : 'That session was already gone.',
      });
      setLibraryNonce((nonce) => nonce + 1);
    } catch (caught: unknown) {
      dispatch({ type: 'error', message: readIpcError(caught, 'storage_failed') });
    }
  }

  async function onExportSession(sessionId: string): Promise<void> {
    if (!bridge) return;
    try {
      const result = await bridge.exportReport(sessionId);
      dispatch({
        type: 'notice',
        message: result.exported
          ? `Report exported to ${result.path}. It contains no pulse samples.`
          : 'Export cancelled. Nothing was written.',
      });
    } catch (caught: unknown) {
      dispatch({ type: 'error', message: readIpcError(caught, 'report_failed') });
    }
  }

  if (flow.screen === 'home' && !flow.explainerSeen) {
    return (
      <main>
        <p className="label">ChessPulse</p>
        {flow.session ? <p className="indicator">Sensing</p> : null}
        <Explainer showProgress />
        <StatusRegion status={status} />
        <div className="actions">
          <button type="button" className="primary-btn" onClick={() => dismissExplainer(true)}>
            Start setup
          </button>
          <button type="button" onClick={() => dismissExplainer(false)}>
            Skip for now
          </button>
        </div>
      </main>
    );
  }

  if (flow.screen === 'help') {
    return (
      <>
        <CameraOpenIndicator sensing={Boolean(flow.session)} preview={false} />
        <main>
          <p className="label">ChessPulse · Help</p>
          <h1>Help</h1>
          <StatusRegion status={status} />
          <Explainer headingLevel={2} />
          <div className="actions">
            <button type="button" className="primary-btn" onClick={() => void onCopyDiagnostics()}>
              Copy diagnostics
            </button>
            <button type="button" onClick={() => dispatch({ type: 'closeHelp' })}>
              Back
            </button>
          </div>
        </main>
      </>
    );
  }

  if (flow.screen === 'home') {
    return (
      <main>
        <p className="label">ChessPulse</p>
        <h1>Ready when you are.</h1>
        <StatusRegion status={status} />
        <p>
          Start a session, play on chess.com, then paste your games to see your pulse next to your
          moves. Nothing is recorded during play.
        </p>
        <div className="actions">
          <button
            type="button"
            className="primary-btn"
            onClick={() => dispatch({ type: 'openSetup' })}
          >
            Start a session
          </button>
          <button type="button" onClick={() => dispatch({ type: 'openSessions' })}>
            All sessions
          </button>
          <button type="button" onClick={() => dispatch({ type: 'openHelp' })}>
            Help
          </button>
        </div>
        <section className="recent-sessions" aria-labelledby="recent-sessions-heading">
          <h2 id="recent-sessions-heading">Recent sessions</h2>
          {library.status === 'idle' || library.status === 'loading' ? (
            <p>Loading saved sessions…</p>
          ) : library.status === 'error' ? (
            <>
              <p>Saved sessions could not be read.</p>
              <button type="button" onClick={() => setLibraryNonce((nonce) => nonce + 1)}>
                Try again
              </button>
            </>
          ) : (
            <SessionList
              sessions={library.sessions.slice(0, 3)}
              heading="Recent sessions"
              emptyMessage="No saved sessions yet. Start one above."
              unreadable={library.unreadable}
              onOpen={(id) => void onOpenSession(id)}
              onDelete={(id) => void onDeleteSession(id)}
              onExport={(id) => void onExportSession(id)}
            />
          )}
        </section>
      </main>
    );
  }

  if (flow.screen === 'sessions') {
    return (
      <main>
        <p className="label">ChessPulse · Sessions</p>
        <h1>Sessions</h1>
        <StatusRegion status={status} />
        {library.status === 'idle' || library.status === 'loading' ? (
          <p>Loading saved sessions…</p>
        ) : library.status === 'error' ? (
          <>
            <p>Saved sessions could not be read.</p>
            <button type="button" onClick={() => setLibraryNonce((nonce) => nonce + 1)}>
              Try again
            </button>
          </>
        ) : (
          <SessionList
            sessions={library.sessions}
            heading="All sessions"
            emptyMessage="No sessions yet. Start one from Home."
            unreadable={library.unreadable}
            onOpen={(id) => void onOpenSession(id)}
            onDelete={(id) => void onDeleteSession(id)}
            onExport={(id) => void onExportSession(id)}
          />
        )}
        <div className="actions">
          <button
            type="button"
            className="primary-btn"
            onClick={() => dispatch({ type: 'openSetup' })}
          >
            Start a session
          </button>
          <button type="button" onClick={() => dispatch({ type: 'openHome' })}>
            Back to Home
          </button>
          <button type="button" onClick={() => dispatch({ type: 'openHelp' })}>
            Help
          </button>
        </div>
      </main>
    );
  }

  if (flow.screen === 'setup') {
    const previewSlot =
      flow.consent && setupKey.status === 'present' && preview === 'running' ? (
        <CameraPreview active guide />
      ) : null;
    return (
      <>
        <CameraOpenIndicator
          sensing={false}
          preview={preview === 'running' || preview === 'starting'}
        />
        <main>
          <SetupScreen
            consent={flow.consent}
            keyStatus={setupKey.status}
            keyDetail={setupKey.detail}
            framing={framing}
            framingHint={validation && validation.code !== 0 ? validation.hint : null}
            preview={preview}
            previewError={previewError}
            starting={starting}
            previewSlot={previewSlot}
            alert={status.tone === 'error' ? <StatusRegion status={status} /> : null}
            timeControls={TIME_CONTROLS}
            timeControl={timeControl}
            gate={gate}
            onConsent={() => void onConsent()}
            onTimeControl={(control) => setTimeControl(control as typeof timeControl)}
            onStart={() => void onStart()}
            onRetryPreview={() => setPreviewAttempt((attempt) => attempt + 1)}
            onBack={() => dispatch({ type: 'openHome' })}
            onHelp={() => dispatch({ type: 'openHelp' })}
          />
        </main>
      </>
    );
  }

  if (flow.screen === 'games') {
    return (
      <main>
        {status.tone === 'error' ? <StatusRegion status={status} /> : null}
        <PasteScreen
          initialSlots={flow.draft.length > 0 ? flow.draft : undefined}
          onBack={(currentSlots) => {
            dispatch({ type: 'pasteChanged', slots: currentSlots });
            dispatch({ type: 'openStopped' });
          }}
          onContinue={(pgns, validation) => {
            void onPasteContinue(pgns, validation);
          }}
          onHelp={() => dispatch({ type: 'openHelp' })}
          onSlotsChange={(slots) => dispatch({ type: 'pasteChanged', slots })}
        />
      </main>
    );
  }

  if (flow.screen === 'review') {
    const review = flow.review;
    return (
      <main>
        <p className="label">ChessPulse · Report</p>
        {status.tone === 'error' ? <StatusRegion status={status} /> : null}
        {review?.building ? (
          <>
            <h1>Building report.</h1>
            <ReviewProgress
              progress={review.progress}
              cancelling={review.cancelling}
              onCancel={() => void onCancelReport()}
            />
          </>
        ) : review?.error ? (
          <>
            <h1>Report unavailable.</h1>
            <div className="refusal-panel" role="alert">
              <p>{review.error}</p>
            </div>
          </>
        ) : review?.result?.ok ? (
          <div className="report-layout">
            <VerdictLine report={review.result} />
            <Timeline key={`ok-${review.result.sessionId}`} result={review.result} />
            <BandBars report={review.result} />
            <GameList report={review.result} />
            <InsightPanel
              state={insightState}
              onRequest={(provider, text) => void onInsightRequest(provider, text)}
              onCancel={() => void onInsightCancel()}
            />
          </div>
        ) : (
          <>
            <h1>{review?.result ? 'Review withheld.' : 'Session timeline.'}</h1>
            {review?.result && !review.result.ok ? (
              <RefusalPanel refusal={review.result} />
            ) : null}
            <Timeline key={`refusal-${sessionId ?? ''}`} result={review?.result ?? null} />
          </>
        )}
        <div className="actions">
          <button type="button" onClick={() => dispatch({ type: 'openGames' })}>
            Edit pasted PGNs
          </button>
          <button type="button" onClick={() => dispatch({ type: 'openStopped' })}>
            Back to session
          </button>
          <button type="button" onClick={() => dispatch({ type: 'openHome' })}>
            Home
          </button>
          <button type="button" onClick={() => dispatch({ type: 'openHelp' })}>
            Help
          </button>
        </div>
      </main>
    );
  }

  const sensing = flow.screen === 'sensing';
  return (
    <>
      <CameraOpenIndicator sensing={sensing} preview={false} />
      <main>
        <p className="label">ChessPulse</p>
        <h1>{sensing ? 'Sensing.' : 'Sensing stopped.'}</h1>
        <StatusRegion status={status} />
        {sensing && flow.consent ? <CameraPreview active /> : null}
        <SensingStrip samples={samples} selectedIndex={selectedIndex} onSelect={setSelectedIndex} />
        {sensing && flow.session?.betweenGames ? <CoachLine message={coachMessage} /> : null}
        {sensing && flow.session ? (
          <SensingControls
            elapsedLabel={formatElapsedMs(elapsedMs)}
            limitWarning={limitWarning(elapsedMs)}
            qualityLabel={qualityLabel}
            betweenGames={flow.session.betweenGames}
            markedGames={flow.session.markedGames}
            gapPending={gapPending}
            confirmingStop={confirmingStop}
            onGap={() => void onGapToggle()}
            onRequestStop={() => setConfirmingStop(true)}
            onConfirmStop={() => {
              setConfirmingStop(false);
              void onStop();
            }}
            onKeepSensing={() => setConfirmingStop(false)}
          />
        ) : null}
        <div className="actions">
          {!sensing ? (
            <button type="button" className="primary-btn" onClick={() => dispatch({ type: 'openGames' })}>
              Paste PGNs
            </button>
          ) : null}
          {!sensing ? (
            <button type="button" onClick={() => dispatch({ type: 'openHome' })}>
              Home
            </button>
          ) : null}
          <button type="button" aria-pressed={flow.consent} onClick={() => void onConsent()}>
            {flow.consent ? 'Revoke camera consent' : 'Allow the camera'}
          </button>
          <button type="button" onClick={() => dispatch({ type: 'openHelp' })}>
            Help
          </button>
        </div>
      </main>
    </>
  );
}

function reportErrorCopy(kind: 'stale' | 'newer' | 'invalid'): string {
  if (kind === 'stale') return appErrorInfo('report_stale').message;
  if (kind === 'newer') return appErrorInfo('report_newer').message;
  return 'The saved report is not valid. The games are open; build the report again.';
}

function StatusRegion({ status }: { status: StatusLine }) {
  // One node, one priority order. `role="alert"` is not swapped in, because assistive tech does
  // not reliably re-announce an element whose role changes; the live level carries urgency.
  return (
    <p className="status-line" role="status" aria-live={status.urgent ? 'assertive' : 'polite'}>
      {status.text}
    </p>
  );
}

function stoppedNote(meta: SessionMeta): string {
  const baseline = meta.baselineBpm === undefined ? 'No baseline.' : `Baseline ${formatNumber(meta.baselineBpm)} bpm.`;
  const coverage = meta.coverage === undefined ? 'No coverage.' : `Coverage ${formatNumber(meta.coverage.pct)}%.`;
  return `${baseline} ${coverage}`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
