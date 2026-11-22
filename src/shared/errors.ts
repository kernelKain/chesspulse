// What: the closed set of failures the player can be told about, and their one message each.
// Why: Electron drops custom Error fields across IPC and contextBridge, so a code travels instead
//      of prose, and the page maps that code back to copy that no main-process error can overwrite.
// Removed: arbitrary internal text or model output could reach the page as an error message.

export const APP_ERROR_CODES = [
  'invalid_request',
  'consent_required',
  'key_missing',
  'camera_unavailable',
  'session_busy',
  'session_failed',
  'session_not_running',
  'storage_failed',
  'pgn_invalid',
  'report_failed',
  'report_missing',
  'report_stale',
  'report_newer',
  'ai_cancelled',
  'ai_rejected_key',
  'ai_rate_limited',
  'ai_unavailable',
  'ai_bad_response',
  'ai_ungrounded',
  'internal',
] as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

export interface AppErrorInfo {
  readonly code: AppErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

/** One player-facing sentence per code. This is the only file that writes them. */
export const APP_ERRORS: Record<AppErrorCode, { readonly message: string; readonly retryable: boolean }> = {
  invalid_request: {
    message: 'That action needs different details. Check the form and try again.',
    retryable: false,
  },
  consent_required: {
    message: 'The camera stays off until you consent.',
    retryable: false,
  },
  key_missing: {
    message: 'The SmartSpectra key is missing. Add SMARTSPECTRA_API_KEY to .env, then restart.',
    retryable: false,
  },
  camera_unavailable: {
    message: 'The camera could not start. Check that another app is not using it, then try again.',
    retryable: true,
  },
  session_busy: {
    message: 'A session or report is already running. Wait for it to finish, then try again.',
    retryable: true,
  },
  session_failed: {
    message: 'The session could not continue. Start a new one.',
    retryable: true,
  },
  session_not_running: {
    message: 'No session is running.',
    retryable: false,
  },
  storage_failed: {
    message: 'ChessPulse could not save to disk. Your previous report is unchanged. Check free space, then try again.',
    retryable: true,
  },
  pgn_invalid: {
    message: 'The pasted game could not be read. Check that the PGN came from chess.com.',
    retryable: false,
  },
  report_failed: {
    message: 'The report could not be built. Check the pasted games and try again. Any previous report is unchanged.',
    retryable: true,
  },
  report_missing: {
    message: 'There is no saved report for this session yet.',
    retryable: false,
  },
  report_stale: {
    message: 'The saved report is from an older version of ChessPulse. Build the report again.',
    retryable: false,
  },
  report_newer: {
    message: 'The saved report is from a newer version of ChessPulse. Update the app to read it.',
    retryable: false,
  },
  ai_cancelled: {
    message: 'The AI reading was cancelled. Nothing in this report depends on it.',
    retryable: false,
  },
  ai_rejected_key: {
    message: 'The AI provider rejected the key. Check CP_AI_KEY.',
    retryable: false,
  },
  ai_rate_limited: {
    message: 'The AI provider rate limit was reached. Try again later.',
    retryable: false,
  },
  ai_unavailable: {
    message: 'The AI provider is unavailable. Nothing in this report depends on it.',
    retryable: true,
  },
  ai_bad_response: {
    message: 'The AI provider returned a response ChessPulse cannot use. The report is unchanged.',
    retryable: false,
  },
  ai_ungrounded: {
    message: 'The AI reading made a claim ChessPulse cannot verify, so it was not shown. The report is unchanged.',
    retryable: false,
  },
  internal: {
    message: 'Something went wrong inside ChessPulse. Nothing stored was changed. Try again.',
    retryable: true,
  },
};

export function isAppErrorCode(value: unknown): value is AppErrorCode {
  return typeof value === 'string' && (APP_ERROR_CODES as readonly string[]).includes(value);
}

export function appErrorInfo(code: AppErrorCode): AppErrorInfo {
  return { code, ...APP_ERRORS[code] };
}

/** A failure that already carries a player-facing meaning. The message is never supplied ad hoc. */
export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly retryable: boolean;

  constructor(code: AppErrorCode, options: { cause?: unknown } = {}) {
    super(
      APP_ERRORS[code].message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'AppError';
    this.code = code;
    this.retryable = APP_ERRORS[code].retryable;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** Any throw becomes one typed error. An unknown failure keeps its detail as `cause`, never as copy. */
export function toAppError(value: unknown, fallback: AppErrorCode = 'internal'): AppError {
  return isAppError(value) ? value : new AppError(fallback, { cause: value });
}

const WIRE_PREFIX = 'chesspulse-error:';

/** The code, not the prose, is what crosses a process or context boundary. */
export function serializeAppError(error: AppError): string {
  return `${WIRE_PREFIX}${error.code}`;
}

/** Electron prefixes its own text, so the marker is found from the end of the message. */
export function deserializeAppError(message: unknown): AppError | null {
  if (typeof message !== 'string') return null;
  const at = message.lastIndexOf(WIRE_PREFIX);
  if (at < 0) return null;
  const code = message.slice(at + WIRE_PREFIX.length).trim();
  return isAppErrorCode(code) ? new AppError(code) : null;
}
