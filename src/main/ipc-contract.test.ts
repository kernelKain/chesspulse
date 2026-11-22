import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IpcMainInvokeEvent } from 'electron';
import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  parseInvokePayload,
  type InvokeChannelKey,
} from '../shared/channels.js';
import {
  APP_ERRORS,
  AppError,
  deserializeAppError,
  isAppErrorCode,
} from '../shared/errors.js';
import { guardIpcHandler } from './ipc-guard.js';

const event = {} as IpcMainInvokeEvent;
const keys = Object.keys(INVOKE_CHANNELS) as InvokeChannelKey[];

const VALID: Record<InvokeChannelKey, unknown> = {
  consentSet: { granted: true },
  sessionStart: { timeControl: '3+2' },
  sessionStop: {},
  coachGap: { betweenGames: true },
  pasteValidate: { slots: [''] },
  reportBuild: { sessionId: 'session', pgns: [] },
  reportCancel: { sessionId: 'session' },
  insightRequest: { sessionId: 'session', provider: 'openai', text: 'What stood out?' },
  insightCancel: { sessionId: 'session' },
  diagnosticsCopy: {},
  sessionDelete: { sessionId: 'session' },
  reportExport: { sessionId: 'session' },
};

async function boundaryRejection(
  key: InvokeChannelKey,
  payload: unknown,
  calls: string[] = [],
): Promise<Error> {
  const entry = INVOKE_CHANNELS[key];
  const guarded = guardIpcHandler(
    entry.name,
    (_event, value) => {
      // The registry parses before it calls a handler; this models that order.
      const parsed = parseInvokePayload(key, value);
      calls.push(key);
      return parsed;
    },
    entry.fallback,
    () => undefined,
  );
  let caught: unknown;
  try {
    await guarded(event, payload);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error, `${key} must reject`);
  return caught;
}

describe('IPC channel contract', () => {
  it('has one unique, prefixed name per channel in both directions', () => {
    const names = [
      ...Object.values(INVOKE_CHANNELS).map((entry) => entry.name),
      ...Object.values(EVENT_CHANNELS),
    ];
    assert.equal(new Set(names).size, names.length);
    for (const name of names) assert.match(name, /^cp:[a-z0-9]+(?::[a-z0-9]+)*$/);
  });

  it('gives every invoke channel a known fallback code', () => {
    for (const key of keys) assert.ok(isAppErrorCode(INVOKE_CHANNELS[key].fallback), key);
  });

  it('accepts one valid payload per channel', () => {
    for (const key of keys) {
      const parsed = parseInvokePayload(key, VALID[key]);
      assert.equal(typeof parsed, 'object', key);
    }
  });

  it('treats an omitted stop payload as the empty object', () => {
    assert.deepEqual(parseInvokePayload('sessionStop', undefined), {});
  });

  it('rejects malformed input on every channel with one typed code before the handler runs', async () => {
    for (const key of keys) {
      const entry = INVOKE_CHANNELS[key];
      const payloads: unknown[] = [null, [], 'text', 42, { unexpected: true }];
      if (!entry.absentAsEmpty) payloads.push(undefined);
      for (const payload of payloads) {
        const calls: string[] = [];
        const message = await boundaryRejection(key, payload, calls);
        assert.equal(calls.length, 0, `${key} must reject before its handler`);
        const decoded = deserializeAppError(message.message);
        assert.ok(decoded, key);
        assert.equal(decoded.code, 'invalid_request', key);
        assert.equal(decoded.message, APP_ERRORS.invalid_request.message);
      }
    }
  });

  it('names the operation fallback in the table rather than at each call site', () => {
    assert.equal(INVOKE_CHANNELS.reportBuild.fallback, 'report_failed');
    assert.equal(INVOKE_CHANNELS.pasteValidate.fallback, 'pgn_invalid');
    assert.equal(INVOKE_CHANNELS.sessionStop.fallback, 'session_failed');
    assert.equal(INVOKE_CHANNELS.consentSet.fallback, 'internal');
  });

  it('does not let a handler see a payload the schema rejected', () => {
    assert.throws(
      () => parseInvokePayload('consentSet', { granted: 'yes' }),
      (error: unknown) => error instanceof AppError && error.code === 'invalid_request',
    );
  });
});
