// What: wraps one IPC handler so every failure leaves as a typed code.
// Why: a handler can throw anything; the page must never receive that text or a stack.
// Removed: raw "Error invoking remote method" text and internal diagnostics would reach the page.
import type { IpcMainInvokeEvent } from 'electron';
import {
  AppError,
  serializeAppError,
  toAppError,
  type AppErrorCode,
} from '../shared/errors.js';
import { logError } from './log.js';

export type IpcHandler = (event: IpcMainInvokeEvent, payload: unknown) => unknown | Promise<unknown>;
export type UnexpectedReporter = (channel: string, error: unknown) => void;

function reportUnexpected(channel: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : 'unknown error';
  logError(`[chesspulse] ${channel} failed: ${detail}`);
}

/**
 * Registers nothing and imports no Electron runtime, so the contract is testable in plain Node.
 * An AppError is passed through; anything else is reduced to `fallback` and logged on this side.
 */
export function guardIpcHandler(
  channel: string,
  handler: IpcHandler,
  fallback: AppErrorCode = 'internal',
  report: UnexpectedReporter = reportUnexpected,
): (event: IpcMainInvokeEvent, payload: unknown) => Promise<unknown> {
  return async (event, payload) => {
    try {
      return await handler(event, payload);
    } catch (error) {
      if (!(error instanceof AppError)) report(channel, error);
      throw new Error(serializeAppError(toAppError(error, fallback)));
    }
  };
}
