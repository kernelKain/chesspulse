import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IpcMainInvokeEvent } from 'electron';
import {
  APP_ERRORS,
  AppError,
  deserializeAppError,
} from '../shared/errors.js';
import { guardIpcHandler } from './ipc-guard.js';

const event = {} as IpcMainInvokeEvent;

async function rejection(
  handler: (event: IpcMainInvokeEvent, payload: unknown) => unknown,
  fallback?: 'internal' | 'report_failed',
  reported: string[] = [],
): Promise<Error> {
  const guarded = guardIpcHandler(
    'cp:test',
    handler,
    fallback,
    (channel, error) => {
      reported.push(`${channel}: ${error instanceof Error ? error.message : 'unknown'}`);
    },
  );
  let caught: unknown;
  try {
    await guarded(event, {});
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error, 'the guarded handler must reject');
  return caught;
}

describe('guarded IPC handlers', () => {
  it('returns a successful value unchanged', async () => {
    const guarded = guardIpcHandler('cp:test', () => ({ ok: true }));
    assert.deepEqual(await guarded(event, {}), { ok: true });
  });

  it('passes a typed AppError through as its code', async () => {
    const message = await rejection(() => {
      throw new AppError('key_missing');
    });
    const decoded = deserializeAppError(message.message);
    assert.ok(decoded);
    assert.equal(decoded.code, 'key_missing');
    assert.equal(decoded.message, APP_ERRORS.key_missing.message);
  });

  it('reduces an unexpected throw to internal copy and logs the detail on this side', async () => {
    const reported: string[] = [];
    const message = await rejection(() => {
      throw new Error('ENOENT: /home/player/.local/share/chesspulse/sessions/secret');
    }, 'internal', reported);

    const decoded = deserializeAppError(message.message);
    assert.ok(decoded);
    assert.equal(decoded.code, 'internal');
    assert.ok(!message.message.includes('ENOENT'));
    assert.ok(!message.message.includes('/home/player'));
    assert.match(reported[0] ?? '', /ENOENT/);
  });

  it('uses the operation fallback rather than internal for an unknown throw', async () => {
    const message = await rejection(() => {
      throw new Error('alignment failed');
    }, 'report_failed');
    const decoded = deserializeAppError(message.message);
    assert.ok(decoded);
    assert.equal(decoded.code, 'report_failed');
    assert.equal(decoded.message, APP_ERRORS.report_failed.message);
  });

  it('does not accept a wire marker thrown as plain text as a real code', async () => {
    const message = await rejection(() => {
      throw new Error('chesspulse-error:key_missing');
    });
    const decoded = deserializeAppError(message.message);
    assert.ok(decoded);
    assert.equal(decoded.code, 'internal');
  });
});
