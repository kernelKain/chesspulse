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
  sessionMarksResultSchema,
  sessionStartedSchema,
  setupStatusSchema,
  type AiProvider,
  type CoachMessage,
  type PasteValidation,
  type PulseSample,
  type SessionMarkView,
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
import logoUrl from './assets/logo.svg?url';
import { COPY } from './copy';
import { CameraOpenIndicator } from './CameraOpenIndicator';
import { CameraPreview } from './CameraPreview';
import { CoachLine } from './CoachLine';
import { Explainer } from './Explainer';
import { GameList } from './GameList';
import { InsightPanel, type InsightViewState } from './InsightPanel';
import { openKeyboardHelp } from './KeyboardHelp';
import { MarkPicker } from './MarkPicker';
import { ReviewStages } from './ReviewStages';
import { readIpcError } from './ipc-error';
import { markChoiceNeeded, tooFewMarks } from '../shared/marks';
import { reviewStages } from '../shared/stages';
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
    detail: COPY.setup.checkingKey,
  });
  const [preview, setPreview] = useState<PreviewStatus>('idle');
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLight, setPreviewLight] = useState<number | null>(null);
  /** Set when the player's own marks cannot place the pasted games; the Review asks which ended each. */
  const [markChoice, setMarkChoice] = useState<{
    sessionId: string;
    pgns: string[];
    marks: SessionMarkView[];
  } | null>(null);
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
  const openSessionSeq = useRef(0);
  const stoppedSessionRef = useRef<string | null>(null);
  const hydrationSeq = useRef(0);
  const previewSeq = useRef(0);
  const consentQueue = useRef<Promise<void>>(Promise.resolve());

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
    openSessionSeq.current += 1;
    stoppedSessionRef.current = null;
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
    stoppedSessionRef.current = nextId;
    openSessionSeq.current += 1;
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
    // Capture the generation before the read. A consent action that lands while it is in flight
    // is newer than the snapshot, so its reply must be ignored rather than undoing the action.
    const seq = hydrationSeq.current;
    void bridge
      .getAppState()
      .then((raw) => {
        if (seq !== hydrationSeq.current) return;
        const parsed = appStateSchema.safeParse(raw);
        if (!parsed.success) return;
        const { consent, session } = parsed.data;
        grantedNow.current = consent.granted;
        if (
          session.active &&
          session.sessionId &&
          session.startedAtEpochMs !== null &&
          !terminalSessionRef.current &&
          !stoppedSessionRef.current
        ) {
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
      setPreviewLight(null);
      // Forget this visit's key result, so returning to Setup does not blink the camera
      // between a stale "present" and the fresh doctor answer.
      setSetupKey({ status: 'loading', detail: COPY.setup.checkingKey });
      return undefined;
    }
    if (!bridge) {
      setSetupKey({
        status: 'error',
        detail: COPY.errors.outsideWindow,
      });
      return undefined;
    }
    let alive = true;
    setSetupKey({ status: 'loading', detail: COPY.setup.checkingKey });
    setPreview('idle');
    setPreviewError(null);
    setValidation(null);
    void bridge
      .getSetupStatus()
      .then((raw) => {
        if (!alive) return;
        const parsed = setupStatusSchema.safeParse(raw);
        if (!parsed.success) {
          setSetupKey({ status: 'error', detail: COPY.errors.keyUnexpected });
          return;
        }
        setSetupKey(keyStatusFromChecks(parsed.data.checks));
      })
      .catch(() => {
        if (alive) setSetupKey({ status: 'error', detail: COPY.errors.keyCheckFailed });
      });
    return () => {
      alive = false;
    };
  }, [flow.screen, bridge]);

  // The camera preview exists only on Setup, only after consent, and only once the key is known.
  // Its cleanup runs on every path that leaves Setup, so no screen retains a live camera.
  useEffect(() => {
    if (flow.screen !== 'setup' || !bridge || !flow.consent || setupKey.status !== 'present') {
      // The previous effect's cleanup owns the stop and clears the state only after release.
      return undefined;
    }
    const seq = ++previewSeq.current;
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
      void bridge
        .stopPreview()
        .then(() => {
          if (previewSeq.current === seq) setPreview('idle');
        })
        .catch(() => {
          // Release was not confirmed. Keep the running state so Help still shows the camera.
        });
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
              // Teardown was not confirmed. Keep the sensing controls so the player can retry
              // instead of hiding a camera that may still be open.
              dispatch({
                type: 'error',
                message: COPY.errors.stopFailedRetry,
              });
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
      if (
        sessionIdRef.current &&
        sessionIdRef.current !== parsed.data.sessionId &&
        screenRef.current === 'sensing'
      ) {
        return;
      }
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
      if (stoppedSessionRef.current === parsed.data.sessionId) return;
      if (supersededSessions.current.has(parsed.data.sessionId)) return;
      if (!grantedNow.current) return;
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
    // The mark question replaces the loading view without changing screen or building, so its
    // arrival and its removal both move focus to the heading that now stands in its place.
  }, [flow.screen, flow.explainerSeen, flow.review?.building, Boolean(markChoice)]);

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
    ? COPY.errors.noRecentSignal
    : quality.label;
  const status = statusFor({
    error: flow.error,
    sdkError: flow.sdkError,
    screen: flow.screen,
    hint: sensingHint(samples, validation),
    notice: flow.notice,
  });

  function onConsent(): Promise<void> {
    if (!bridge) {
      dispatch({
        type: 'notice',
        message: COPY.errors.outsideWindowCamera,
      });
      return Promise.resolve();
    }
    hydrationSeq.current += 1;
    const run = consentQueue.current.then(async () => {
      const revoking = grantedNow.current;
      if (revoking && startPending.current) revokedDuringStart.current = true;
      let stopFailed = false;
      let stopSucceeded = false;
      if (screenRef.current === 'sensing' || (revoking && startPending.current)) {
        try {
          const meta = await bridge.stopSession();
          stopSucceeded = true;
          settleSession(meta.id, stoppedNote(meta));
          dispatch({ type: 'clearError' });
        } catch {
          stopFailed = true;
          dispatch({ type: 'error', message: COPY.errors.stopFailed });
        }
      }
      try {
        const next = await bridge.setConsent(!grantedNow.current);
        if (!stopFailed) dispatch({ type: 'clearError' });
        grantedNow.current = next.granted;
        dispatch({ type: 'consentChanged', granted: next.granted });
      } catch {
        dispatch({
          type: 'error',
          message:
            stopSucceeded && !stopFailed
              ? COPY.errors.consentChangeNotSaved
              : COPY.errors.consentNotSaved,
        });
      }
    });
    consentQueue.current = run.catch(() => undefined);
    return run;
  }

  async function onStart(): Promise<void> {
    if (!bridge || flow.screen !== 'setup' || !gate.canStart || startPending.current) return;
    revokedDuringStart.current = false;
    startPending.current = true;
    setStarting(true);
    const seq = openSessionSeq.current;
    try {
      const started = await bridge.startSession(timeControl);
      // A terminal event or a different live session may have arrived before this reply.
      if (terminalSessionRef.current === started.sessionId) return;
      if (seq !== openSessionSeq.current) return;
      if (sessionIdRef.current && sessionIdRef.current !== started.sessionId && screenRef.current === 'sensing') {
        return;
      }
      adoptSession(started.sessionId, started.startedAtEpochMs);
      if (revokedDuringStart.current || !grantedNow.current) {
        try {
          const meta = await bridge.stopSession();
          settleSession(meta.id, stoppedNote(meta));
        } catch {
          // Consent revocation has normally finalized the session already, so stopSession
          // rejects. The screen must not keep claiming it is sensing a session that is gone.
          settleSession(started.sessionId, COPY.errors.stoppedAfterConsent);
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
      // The sessionEnded event may already have settled this session and a report may have started.
      if (terminalSessionRef.current === meta.id || sessionIdRef.current !== meta.id) return;
      settleSession(meta.id, stoppedNote(meta));
      dispatch({ type: 'clearError' });
    } catch {
      dispatch({ type: 'error', message: COPY.errors.stopFailed });
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
          message: COPY.errors.insightUnexpected,
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

  async function onPasteContinue(
    pgns: string[],
    _validation?: PasteValidation,
    gameEndMarks?: number[],
  ): Promise<void> {
    if (!sessionId) {
      dispatch({ type: 'error', message: COPY.errors.noStoredSession });
      return;
    }
    if (bridge) void bridge.cancelInsight(sessionId).catch(() => undefined);
    resetInsight();
    const seq = ++reportRequestSeq.current;
    dispatch({ type: 'reportStarted', sessionId, slots: pgns });
    if (!bridge) {
      dispatch({ type: 'reportFailed', message: COPY.errors.outsideWindow, sessionId });
      return;
    }
    try {
      if (!gameEndMarks) {
        const answers = sessionMarksResultSchema.safeParse(await bridge.sessionMarks(sessionId));
        if (seq !== reportRequestSeq.current) return;
        if (!answers.success) {
          dispatch({ type: 'reportFailed', message: COPY.errors.reportUnexpected, sessionId });
          return;
        }
        if (tooFewMarks(answers.data.marks, pgns.length)) {
          dispatch({ type: 'reportFailed', message: COPY.markChoice.tooFew, sessionId });
          return;
        }
        if (markChoiceNeeded(answers.data.marks, pgns.length)) {
          setMarkChoice({ sessionId, pgns, marks: answers.data.marks });
          return;
        }
      }
      const raw = await bridge.buildReport(sessionId, pgns, gameEndMarks);
      if (seq !== reportRequestSeq.current) return;
      const parsed = reportResultSchema.safeParse(raw);
      if (!parsed.success) {
        dispatch({ type: 'reportFailed', message: COPY.errors.reportUnexpected, sessionId });
        return;
      }
      dispatch({ type: 'reportReady', result: parsed.data });
    } catch (caught: unknown) {
      if (seq !== reportRequestSeq.current) return;
      dispatch({ type: 'reportFailed', message: readIpcError(caught, 'report_failed'), sessionId });
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
        message: COPY.errors.diagnosticsUnavailable,
      });
      return;
    }
    try {
      await bridge.copyDiagnostics();
      dispatch({ type: 'clearError' });
      dispatch({
        type: 'notice',
        message: COPY.errors.diagnosticsCopied,
      });
    } catch (caught: unknown) {
      dispatch({ type: 'error', message: readIpcError(caught, 'internal') });
    }
  }

  async function onOpenSession(sessionId: string): Promise<void> {
    if (!bridge) return;
    if (flow.session) {
      dispatch({ type: 'error', message: COPY.errors.stopBeforeOpening });
      return;
    }
    const seq = ++openSessionSeq.current;
    try {
      const raw = await bridge.openSession(sessionId);
      if (seq !== openSessionSeq.current) return;
      const parsed = sessionOpenResultSchema.safeParse(raw);
      if (!parsed.success) {
        dispatch({ type: 'error', message: COPY.errors.unexpectedSession });
        return;
      }
      // A pending mark question belongs to the session it was asked for, never to this one.
      setMarkChoice(null);
      // A build from the previous review must not land on the newly opened session.
      if (flow.review?.building) {
        void bridge.cancelReport(flow.review.sessionId).catch(() => undefined);
      }
      resetInsight();
      reportRequestSeq.current += 1;
      sessionIdRef.current = sessionId;
      terminalSessionRef.current = null;
      stoppedSessionRef.current = null;
      setSamples([]);
      setSelectedIndex(null);
      setLastSampleAtMs(null);
      setValidation(null);
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
      if (seq === openSessionSeq.current) {
        dispatch({ type: 'error', message: readIpcError(caught, 'report_failed') });
      }
    }
  }

  async function onDeleteSession(sessionId: string): Promise<void> {
    if (!bridge) return;
    try {
      const result = await bridge.deleteSession(sessionId);
      dispatch({ type: 'sessionDeleted', sessionId });
      dispatch({
        type: 'notice',
        message: result.deleted ? COPY.common.notices.sessionDeleted : COPY.common.notices.sessionGone,
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
        message: result.exported ? COPY.common.notices.exported(result.path) : COPY.common.notices.exportCancelled,
      });
    } catch (caught: unknown) {
      dispatch({ type: 'error', message: readIpcError(caught, 'report_failed') });
    }
  }

  if (flow.screen === 'home' && !flow.explainerSeen) {
    return (
      <main>
        <BrandLine />
        {flow.session ? <p className="indicator">{COPY.camera.sensing}</p> : null}
        <div className="explainer-panel">
          <Explainer showProgress />
        </div>
        <StatusRegion status={status} />
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={() => dismissExplainer(true)}>
            {COPY.common.actions.startSetup}
          </button>
          <button type="button" onClick={() => dismissExplainer(false)} className="btn btn-secondary">
            {COPY.common.actions.skipForNow}
          </button>
        </div>
      </main>
    );
  }

  if (flow.screen === 'help') {
    return (
      <>
        <CameraOpenIndicator
          sensing={Boolean(flow.session)}
          preview={preview === 'running' || preview === 'starting'}
        />
        <main>
          <p className="label">{COPY.common.screenLabels.help}</p>
          <h1>{COPY.common.actions.help}</h1>
          <StatusRegion status={status} />
          <Explainer headingLevel={2} />
          <div className="actions">
            <button type="button" className="btn btn-primary" onClick={() => void onCopyDiagnostics()}>
              {COPY.common.actions.copyDiagnostics}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => openKeyboardHelp()}
            >
              {COPY.common.actions.keyboardShortcuts}
            </button>
            <button type="button" onClick={() => dispatch({ type: 'closeHelp' })} className="btn btn-secondary">
              {COPY.common.actions.back}
            </button>
          </div>
        </main>
      </>
    );
  }

  if (flow.screen === 'home') {
    return (
      <main>
        <header className="home-hero">
          <div className="home-hero-text">
            <BrandLine />
            <h1>{COPY.home.heading}</h1>
            <p>{COPY.home.intro}</p>
          </div>
          <BoardTile />
        </header>
        <StatusRegion status={status} />
        <div className="actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => dispatch({ type: 'openSetup' })}
          >
            {COPY.common.actions.startSession}
          </button>
          <button type="button" onClick={() => dispatch({ type: 'openSessions' })} className="btn btn-secondary">
            {COPY.common.actions.allSessions}
          </button>
          <button type="button" onClick={() => dispatch({ type: 'openHelp' })} className="btn btn-secondary">
            {COPY.common.actions.help}
          </button>
        </div>
        <section className="recent-sessions" aria-labelledby="recent-sessions-heading">
          <h2 id="recent-sessions-heading">{COPY.home.recentHeading}</h2>
          {library.status === 'idle' || library.status === 'loading' ? (
            <p className="loading-state">{COPY.common.loading}</p>
          ) : library.status === 'error' ? (
            <>
              <p>{COPY.common.readError}</p>
              <button type="button" onClick={() => setLibraryNonce((nonce) => nonce + 1)} className="btn btn-secondary">
                {COPY.common.actions.tryAgain}
              </button>
            </>
          ) : (
            <SessionList
              sessions={library.sessions.slice(0, 3)}
              heading={COPY.home.recentHeading}
              emptyMessage={COPY.sessions.emptyRecent}
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
        <p className="label">{COPY.common.screenLabels.sessions}</p>
        <h1>{COPY.sessions.heading}</h1>
        <StatusRegion status={status} />
        {library.status === 'idle' || library.status === 'loading' ? (
          <p className="loading-state">{COPY.common.loading}</p>
        ) : library.status === 'error' ? (
          <>
            <p>{COPY.common.readError}</p>
            <button type="button" onClick={() => setLibraryNonce((nonce) => nonce + 1)} className="btn btn-secondary">
              {COPY.common.actions.tryAgain}
            </button>
          </>
        ) : (
          <SessionList
            sessions={library.sessions}
            heading={COPY.common.actions.allSessions}
            emptyMessage={COPY.sessions.empty}
            unreadable={library.unreadable}
            onOpen={(id) => void onOpenSession(id)}
            onDelete={(id) => void onDeleteSession(id)}
            onExport={(id) => void onExportSession(id)}
          />
        )}
        <div className="actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => dispatch({ type: 'openSetup' })}
          >
            {COPY.common.actions.startSession}
          </button>
          <button type="button" onClick={() => dispatch({ type: 'openHome' })} className="btn btn-secondary">
            {COPY.common.actions.backToHome}
          </button>
          <button type="button" onClick={() => dispatch({ type: 'openHelp' })} className="btn btn-secondary">
            {COPY.common.actions.help}
          </button>
        </div>
      </main>
    );
  }

  if (flow.screen === 'setup') {
    const previewSlot =
      flow.consent && setupKey.status === 'present' && preview === 'running' ? (
        <CameraPreview active guide lightText={false} onLight={setPreviewLight} />
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
            light={previewLight}
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

  if (flow.screen === 'review' && markChoice && markChoice.sessionId === sessionId) {
    return (
      <main>
        <MarkPicker
          gameCount={markChoice.pgns.length}
          marks={markChoice.marks}
          onSubmit={(ends) => {
            const chosen = markChoice;
            setMarkChoice(null);
            // The picker was opened for one session; its PGNs and marks must never reach another.
            if (chosen.sessionId !== sessionId) return;
            void onPasteContinue(chosen.pgns, undefined, ends);
          }}
          onCancel={() => {
            setMarkChoice(null);
            dispatch({ type: 'openGames' });
          }}
        />
      </main>
    );
  }

  if (flow.screen === 'review') {
    const review = flow.review;
    const result = review?.result ?? null;
    const stages = reviewStages({
      result,
      building: Boolean(review?.building),
      failed: Boolean(review?.error),
      reading: insightState.status,
      // The service's own reason distinguishes a missing model from a missing key.
      readingDetail:
        insightState.status === 'disabled'
          ? insightState.reason
          : insightState.status === 'error'
            ? insightState.message
            : undefined,
    });
    const bodies = result?.ok
      ? {
          pulse: <Timeline key={`pulse-${result.sessionId}`} result={result} />,
          engine: (
            <>
              <BandBars report={result} />
              <GameList report={result} />
            </>
          ),
          reading: (
            <InsightPanel
              state={insightState}
              onRequest={(provider, text) => void onInsightRequest(provider, text)}
              onCancel={() => void onInsightCancel()}
            />
          ),
        }
      : result
        ? {
            pulse: (
              <>
                <RefusalPanel refusal={result} />
                <Timeline key={`refusal-${sessionId ?? ''}`} result={result} />
              </>
            ),
          }
        : {};
    return (
      <main>
        <p className="label">{COPY.common.screenLabels.report}</p>
        {status.tone === 'error' ? <StatusRegion status={status} /> : null}
        {review?.building ? (
          <>
            <h1>{COPY.review.building}</h1>
            <ReviewProgress
              progress={review.progress}
              cancelling={review.cancelling}
              onCancel={() => void onCancelReport()}
            />
          </>
        ) : review?.error ? (
          <>
            <h1>{COPY.review.unavailable}</h1>
            <div className="refusal-panel inline-alert" role="alert">
              <p>{review.error}</p>
            </div>
          </>
        ) : result?.ok ? (
          <VerdictLine report={result} />
        ) : (
          <h1>{result ? COPY.review.withheld : COPY.review.timelineOnly}</h1>
        )}
        <ReviewStages stages={stages} bodies={bodies} />
        <div className="actions">
          <button type="button" onClick={() => dispatch({ type: 'openGames' })} className="btn btn-secondary">
            {COPY.review.editGames}
          </button>
          <button type="button" onClick={() => dispatch({ type: 'openStopped' })} className="btn btn-secondary">
            {COPY.common.actions.backToSession}
          </button>
          <button type="button" onClick={() => dispatch({ type: 'openHome' })} className="btn btn-secondary">
            {COPY.common.actions.home}
          </button>
          <button type="button" onClick={() => dispatch({ type: 'openHelp' })} className="btn btn-secondary">
            {COPY.common.actions.help}
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
        <p className="label">{COPY.common.chessPulse}</p>
        <h1>{sensing ? COPY.sensing.heading : COPY.sensing.stoppedHeading}</h1>
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
            <button type="button" className="btn btn-primary" onClick={() => dispatch({ type: 'openGames' })}>
              {COPY.sensing.pastePgns}
            </button>
          ) : null}
          {!sensing ? (
            <button type="button" onClick={() => dispatch({ type: 'openHome' })} className="btn btn-secondary">
              {COPY.common.actions.home}
            </button>
          ) : null}
          <button type="button" aria-pressed={flow.consent} onClick={() => void onConsent()} className="btn btn-secondary">
            {flow.consent ? COPY.setup.revokeCamera : COPY.setup.allowCamera}
          </button>
          <button type="button" onClick={() => dispatch({ type: 'openHelp' })} className="btn btn-secondary">
            {COPY.common.actions.help}
          </button>
        </div>
      </main>
    </>
  );
}

function reportErrorCopy(kind: 'stale' | 'newer' | 'invalid'): string {
  if (kind === 'stale') return appErrorInfo('report_stale').message;
  if (kind === 'newer') return appErrorInfo('report_newer').message;
  return COPY.errors.reportInvalid;
}

function BrandLine() {
  // What: the mark and the product name on the two first screens.
  // Why: the image is decorative, so it carries an empty alt and the word stays real text.
  // Removed: the first screen would be a word with no mark, which is what R6-01 asked to change.
  return (
    <p className="label brand-line">
      <img className="brand-mark" src={logoUrl} alt="" draggable={false} />
      <span>{COPY.common.chessPulse}</span>
    </p>
  );
}

function BoardTile() {
  // What: one decorative board square, tilted, with the pulse line across it.
  // Why: R6-03 asks for 3D where it helps; this is the only 3D element and it is on Home only.
  // Removed: the first screen loses the chess half of the brand. The report keeps a flat chart.
  return (
    <div className="board-tile" aria-hidden="true">
      <div className="board-tile-face">
        <svg className="board-tile-pulse" viewBox="0 0 120 120" preserveAspectRatio="none" focusable="false">
          <polyline className="tile-pulse-under" points="6,66 34,66 42,42 50,92 58,54 64,66 114,66" />
          <polyline className="tile-pulse" points="6,66 34,66 42,42 50,92 58,54 64,66 114,66" />
        </svg>
      </div>
    </div>
  );
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
  const baseline =
    meta.baselineBpm === undefined
      ? COPY.errors.noBaseline
      : COPY.errors.baseline(formatNumber(meta.baselineBpm));
  const coverage =
    meta.coverage === undefined
      ? COPY.errors.noCoverage
      : COPY.errors.coverage(formatNumber(meta.coverage.pct));
  return `${baseline} ${coverage}`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
