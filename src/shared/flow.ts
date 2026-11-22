// What: the renderer's one navigation state machine and its status priority.
// Why: a reload, a late session event, and a screen change must land in one place, not in scattered state.
// Removed: two states could disagree about consent or which screen is open, and the urgent message could be hidden.
import type {
  PulseSample,
  ReportResult,
  ValidationMessage,
} from './contracts.js';
import { CONFIDENCE_FLOOR } from './sensing.js';

/** The screens in the §3.1 diagram. `setup`, `sessions` and `help` are filled in by later W4 steps. */
export const SCREENS = [
  'home',
  'setup',
  'sensing',
  'stopped',
  'games',
  'review',
  'sessions',
  'help',
] as const;

export type Screen = (typeof SCREENS)[number];
export type FlowTone = 'error' | 'note' | 'default';

export interface ActiveSessionState {
  id: string;
  startedAtEpochMs: number;
  betweenGames: boolean;
  /** Player-marked game boundaries in this session. The app never infers one. */
  markedGames: number;
}

export interface ReviewState {
  sessionId: string;
  result: ReportResult | null;
  building: boolean;
  error: string | null;
  progress: { scored: number; total: number } | null;
  cancelling: boolean;
}

export interface FlowState {
  screen: Screen;
  consent: boolean;
  session: ActiveSessionState | null;
  stoppedSessionId: string | null;
  /** The paste survives Games -> Review -> Games. It is cleared only by a new session. */
  draft: string[];
  review: ReviewState | null;
  explainerSeen: boolean;
  /** Where Help returns to. Help is a detour, not a replacement for the working screen. */
  helpReturn: Screen | null;
  notice: string;
  error: string | null;
  sdkError: string | null;
}

export type FlowEvent =
  | {
      type: 'hydrated';
      consent: boolean;
      session: {
        id: string;
        startedAtEpochMs: number;
        betweenGames: boolean;
        markedGames: number;
      } | null;
    }
  | { type: 'explainerDismissed' }
  | { type: 'consentChanged'; granted: boolean }
  | { type: 'sessionStarted'; sessionId: string; startedAtEpochMs: number }
  | { type: 'sessionStopped'; sessionId: string; notice: string }
  | { type: 'openHome' }
  | { type: 'openSetup' }
  | { type: 'openSessions' }
  | { type: 'openHelp' }
  | { type: 'closeHelp' }
  | { type: 'openStopped' }
  | { type: 'openGames' }
  | { type: 'openReview' }
  | { type: 'pasteChanged'; slots: string[] }
  | { type: 'reportStarted'; sessionId: string; slots: string[] }
  | { type: 'reportProgress'; scored: number; total: number }
  | { type: 'reportReady'; result: ReportResult }
  | { type: 'reportFailed'; message: string }
  | { type: 'reportCancelRequested' }
  | { type: 'reportCancelRejected' }
  | { type: 'gapChanged'; betweenGames: boolean }
  | { type: 'openedSession'; sessionId: string; report: ReportResult | null; games: string[] }
  | { type: 'sessionDeleted'; sessionId: string }
  | { type: 'notice'; message: string }
  | { type: 'error'; message: string }
  | { type: 'sdkError'; message: string }
  | { type: 'clearSdkError' }
  | { type: 'clearError' };

const CONSENT_OFF = 'The camera stays off until you consent.';
const CONSENT_ON = 'Consent is on. The camera opens when you start sensing.';

export function initialFlowState(explainerSeen = false): FlowState {
  return {
    screen: 'home',
    consent: false,
    session: null,
    stoppedSessionId: null,
    draft: [],
    review: null,
    explainerSeen,
    helpReturn: null,
    notice: CONSENT_OFF,
    error: null,
    sdkError: null,
  };
}

/** The session a screen may act on. Review keeps its own id after the live session is gone. */
export function currentSessionId(state: FlowState): string | null {
  return state.review?.sessionId ?? state.stoppedSessionId ?? state.session?.id ?? null;
}

/** Help returns only to a screen the current state can still render. */
function helpReturnScreen(state: FlowState): Screen {
  const target = state.helpReturn;
  if (!target || target === 'help') return 'home';
  if (target === 'sensing') return state.session ? 'sensing' : 'home';
  if (target === 'stopped') return state.stoppedSessionId ? 'stopped' : 'home';
  if (target === 'games' || target === 'review') return currentSessionId(state) ? target : 'home';
  return target;
}

function consentNotice(granted: boolean): string {
  return granted ? CONSENT_ON : CONSENT_OFF;
}

function activeSession(state: FlowState): ActiveSessionState | null {
  return state.session;
}

/**
 * Applies one event. A transition the diagram does not allow returns the same object, so no caller
 * can create a screen the state machine does not recognise.
 */
export function flowReducer(state: FlowState, event: FlowEvent): FlowState {
  switch (event.type) {
    case 'hydrated': {
      if (state.session || state.stoppedSessionId || state.review) return state;
      return {
        ...state,
        consent: event.consent,
        session: event.session
          ? {
              id: event.session.id,
              startedAtEpochMs: event.session.startedAtEpochMs,
              betweenGames: event.session.betweenGames,
              markedGames: event.session.markedGames,
            }
          : null,
        stoppedSessionId: event.session ? null : state.stoppedSessionId,
        screen: event.session ? 'sensing' : state.screen,
        notice: event.session ? 'Waiting for a face.' : consentNotice(event.consent),
      };
    }

    case 'explainerDismissed':
      return state.explainerSeen ? state : { ...state, explainerSeen: true };

    case 'consentChanged':
      return {
        ...state,
        consent: event.granted,
        notice: consentNotice(event.granted),
      };

    case 'sessionStarted':
      return {
        ...state,
        screen: 'sensing',
        session: {
          id: event.sessionId,
          startedAtEpochMs: event.startedAtEpochMs,
          betweenGames: false,
          markedGames: 0,
        },
        stoppedSessionId: null,
        draft: [],
        review: null,
        helpReturn: null,
        error: null,
        notice: 'Waiting for a face.',
      };

    case 'sessionStopped':
      return {
        ...state,
        screen: 'stopped',
        session: null,
        stoppedSessionId: event.sessionId,
        review: null,
        helpReturn: null,
        notice: event.notice,
      };

    case 'openHome':
      return { ...state, screen: 'home' };

    case 'openSetup':
      return { ...state, screen: 'setup' };

    case 'openSessions':
      return { ...state, screen: 'sessions' };

    case 'openHelp':
      if (state.screen === 'help') return state;
      return { ...state, screen: 'help', helpReturn: state.screen };

    case 'closeHelp':
      if (state.screen !== 'help') return state;
      return { ...state, screen: helpReturnScreen(state), helpReturn: null };

    case 'openStopped':
      if (!state.stoppedSessionId) return state;
      return { ...state, screen: 'stopped' };

    case 'openGames':
      if (state.screen !== 'stopped' && state.screen !== 'review') return state;
      if (!currentSessionId(state)) return state;
      return { ...state, screen: 'games' };

    case 'openReview':
      if (state.screen !== 'stopped') return state;
      if (!state.review?.result) return state;
      return { ...state, screen: 'review' };

    case 'pasteChanged':
      return { ...state, draft: event.slots };

    case 'reportStarted':
      return {
        ...state,
        screen: 'review',
        draft: event.slots,
        review: {
          sessionId: event.sessionId,
          result: null,
          building: true,
          error: null,
          progress: null,
          cancelling: false,
        },
      };

    case 'reportProgress':
      if (!state.review?.building) return state;
      return {
        ...state,
        review: { ...state.review, progress: { scored: event.scored, total: event.total } },
      };

    case 'reportReady':
      if (!state.review) return state;
      return {
        ...state,
        review: {
          ...state.review,
          result: event.result,
          building: false,
          error: null,
          progress: null,
          cancelling: false,
        },
      };

    case 'reportFailed':
      if (!state.review) return state;
      return {
        ...state,
        review: {
          ...state.review,
          building: false,
          error: event.message,
          progress: null,
          cancelling: false,
        },
      };

    case 'reportCancelRequested':
      if (!state.review?.building || state.review.cancelling) return state;
      return { ...state, review: { ...state.review, cancelling: true } };

    case 'reportCancelRejected':
      if (!state.review) return state;
      return { ...state, review: { ...state.review, cancelling: false } };

    case 'gapChanged': {
      const session = activeSession(state);
      if (!session) return state;
      const markedGames =
        session.markedGames + (event.betweenGames && !session.betweenGames ? 1 : 0);
      return {
        ...state,
        session: { ...session, betweenGames: event.betweenGames, markedGames },
      };
    }

    case 'openedSession':
      return {
        ...state,
        screen: event.report ? 'review' : 'games',
        session: null,
        stoppedSessionId: event.sessionId,
        draft: event.games,
        helpReturn: null,
        review: event.report
          ? {
              sessionId: event.sessionId,
              result: event.report,
              building: false,
              error: null,
              progress: null,
              cancelling: false,
            }
          : null,
        error: null,
      };

    case 'sessionDeleted':
      if (state.stoppedSessionId !== event.sessionId && state.review?.sessionId !== event.sessionId) {
        return state;
      }
      return {
        ...state,
        screen: 'home',
        stoppedSessionId: null,
        draft: [],
        review: null,
        helpReturn: null,
        notice: 'Session deleted.',
      };

    case 'notice':
      return { ...state, notice: event.message };

    case 'error':
      return { ...state, error: event.message };

    case 'sdkError':
      return { ...state, sdkError: event.message };

    case 'clearSdkError':
      return state.sdkError === null ? state : { ...state, sdkError: null };

    case 'clearError':
      return { ...state, error: null };
  }
}

export interface StatusInput {
  error: string | null;
  sdkError: string | null;
  screen: Screen;
  hint: string | null;
  notice: string;
}

export interface StatusLine {
  text: string;
  tone: FlowTone;
  urgent: boolean;
}

/**
 * One status region. An operation error outranks a sensing error, which outranks a live hint; the
 * session note is last. Nothing here is written by a screen that happens to render later.
 */
export function statusFor(input: StatusInput): StatusLine {
  if (input.error) return { text: input.error, tone: 'error', urgent: true };
  if (input.sdkError) return { text: input.sdkError, tone: 'error', urgent: true };
  if (input.screen === 'sensing' && input.hint) {
    return { text: input.hint, tone: 'note', urgent: false };
  }
  return { text: input.notice, tone: 'default', urgent: false };
}

/** The live sensing sentence. It always says something while the camera is measuring. */
export function sensingHint(
  samples: readonly PulseSample[],
  validation: ValidationMessage | null,
): string | null {
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
