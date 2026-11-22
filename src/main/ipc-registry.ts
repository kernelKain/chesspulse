// What: registers one invoke channel from the shared table.
// Why: the channel name, input schema, and fallback code must come from one place.
// Removed: a handler could be wired to a name the preload never calls, or skip its schema.
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import {
  INVOKE_CHANNELS,
  parseInvokePayload,
  type InvokeChannelKey,
  type InvokePayload,
} from '../shared/channels.js';
import { guardIpcHandler } from './ipc-guard.js';
import { isAuthorizedSender } from './ipc-sender.js';
import { AppError } from '../shared/errors.js';

export type RegisteredHandler<K extends InvokeChannelKey> = (
  event: IpcMainInvokeEvent,
  payload: InvokePayload<K>,
) => unknown | Promise<unknown>;

export function registerInvokeChannel<K extends InvokeChannelKey>(
  key: K,
  handler: RegisteredHandler<K>,
): void {
  const entry = INVOKE_CHANNELS[key];
  ipcMain.handle(
    entry.name,
    guardIpcHandler(
      entry.name,
      (event, payload) => {
        if (!isAuthorizedSender(event)) throw new AppError('invalid_request');
        return handler(event, parseInvokePayload(key, payload));
      },
      entry.fallback,
    ),
  );
}
