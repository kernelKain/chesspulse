import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  APP_ERRORS,
  APP_ERROR_CODES,
  AppError,
  appErrorInfo,
  deserializeAppError,
  isAppErrorCode,
  serializeAppError,
  toAppError,
} from './errors.js';

describe('typed app errors', () => {
  it('gives every code exactly one non-empty message and a retryable flag', () => {
    for (const code of APP_ERROR_CODES) {
      const entry = APP_ERRORS[code];
      assert.equal(typeof entry.message, 'string', code);
      assert.ok(entry.message.trim().length > 0, code);
      assert.equal(typeof entry.retryable, 'boolean', code);
      assert.deepEqual(appErrorInfo(code), {
        code,
        message: entry.message,
        retryable: entry.retryable,
      });
    }
  });

  it('round-trips every code through the wire marker', () => {
    for (const code of APP_ERROR_CODES) {
      const decoded = deserializeAppError(serializeAppError(new AppError(code)));
      assert.ok(decoded, code);
      assert.equal(decoded.code, code);
      assert.equal(decoded.message, APP_ERRORS[code].message);
      assert.equal(decoded.retryable, APP_ERRORS[code].retryable);
    }
  });

  it('reads the marker after the prefix Electron adds to a rejection', () => {
    const message = `Error invoking remote method 'cp:session:start': Error: ${serializeAppError(
      new AppError('key_missing'),
    )}`;
    const decoded = deserializeAppError(message);
    assert.ok(decoded);
    assert.equal(decoded.code, 'key_missing');
    assert.equal(decoded.message, APP_ERRORS.key_missing.message);
  });

  it('refuses unknown codes and plain messages', () => {
    assert.equal(deserializeAppError('chesspulse-error:made_up'), null);
    assert.equal(deserializeAppError('The camera stays off.'), null);
    assert.equal(deserializeAppError(undefined), null);
    assert.equal(isAppErrorCode('made_up'), false);
    assert.equal(isAppErrorCode('internal'), true);
  });

  it('keeps a known AppError and hides any other error text behind internal copy', () => {
    const known = new AppError('camera_unavailable');
    assert.equal(toAppError(known), known);

    const converted = toAppError(new Error('raw internal detail: /home/player/secret'));
    assert.equal(converted.code, 'internal');
    assert.equal(converted.message, APP_ERRORS.internal.message);
    assert.ok(!converted.message.includes('secret'));
    assert.ok(converted.cause instanceof Error);
    assert.match((converted.cause as Error).message, /secret/);
  });

  it('uses the requested fallback code for an unknown failure', () => {
    const converted = toAppError(new Error('cannot read /dev/sda'), 'storage_failed');
    assert.equal(converted.code, 'storage_failed');
    assert.equal(converted.message, APP_ERRORS.storage_failed.message);
    assert.ok(!converted.message.includes('/dev/sda'));
  });
});
