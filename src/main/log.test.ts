import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { installSafeConsole, log, logError } from './log.js';

describe('safe logging', () => {
  it('does not throw when the console writer throws EPIPE', () => {
    const broken = {
      log: () => {
        throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
      },
      error: () => {
        throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
      },
    } as unknown as Console;
    installSafeConsole(broken);
    assert.doesNotThrow(() => log('a line'));
    assert.doesNotThrow(() => logError('a line'));
  });

  it('still writes when the console works', () => {
    const lines: unknown[][] = [];
    const working = {
      log: (...args: unknown[]) => lines.push(args),
      error: (...args: unknown[]) => lines.push(args),
    } as unknown as Console;
    installSafeConsole(working);
    log('sensing error 2');
    logError('camera gone');
    assert.deepEqual(lines, [['sensing error 2'], ['camera gone']]);
  });
});
