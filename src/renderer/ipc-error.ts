// What: turns one failed bridge call into its single player-facing sentence.
// Why: Electron and contextBridge drop custom Error fields, so the code travels in the message.
// Removed: raw main-process text or model output could be printed as an error.
import {
  appErrorInfo,
  deserializeAppError,
  type AppErrorCode,
} from '../shared/errors';

export function readIpcError(caught: unknown, fallback: AppErrorCode = 'internal'): string {
  if (caught instanceof Error) {
    const appError = deserializeAppError(caught.message);
    if (appError) return appError.message;
  }
  return appErrorInfo(fallback).message;
}
