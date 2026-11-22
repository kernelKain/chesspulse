import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { installFileLog, installSafeConsole, log, logError, readRecentLogLines } from './log.js';

const roots: string[] = [];

async function newRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'chesspulse-log-'));
  roots.push(dir);
  return dir;
}

const quiet = {
  log: () => undefined,
  error: () => undefined,
} as unknown as Console;

// Installing twice on the same console would wrap the previous wrapper and write each line twice.
installSafeConsole(quiet);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('redacted file log', () => {
  it('removes known key values by value, in normal and error lines', async () => {
    const root = await newRoot();
    installFileLog({
      root,
      env: {
        SMARTSPECTRA_API_KEY: 'sk-live-abc123456789',
        CP_AI_KEY: 'ai-live-zzz999999',
      },
    });
    log('opening camera with sk-live-abc123456789');
    logError(new Error('request failed for ai-live-zzz999999'));
    log({ note: 'nested sk-live-abc123456789' });

    const text = await readFile(path.join(root, 'logs', 'chesspulse.log'), 'utf8');
    assert.ok(!text.includes('sk-live-abc123456789'));
    assert.ok(!text.includes('ai-live-zzz999999'));
    assert.match(text, /\[redacted\]/);
    assert.match(text, /opening camera/);
    assert.match(text, /^.* error .*request failed/m);

    const recent = readRecentLogLines(root, 100).join('\n');
    assert.ok(!recent.includes('sk-live-abc123456789'));
    assert.ok(!recent.includes('ai-live-zzz999999'));
  });

  it('keeps ordinary text and returns the requested newest lines in order', async () => {
    const root = await newRoot();
    installFileLog({ root, env: {} });
    log('first ordinary line');
    log('second ordinary line');
    log('third ordinary line');

    const recent = readRecentLogLines(root, 2);
    assert.equal(recent.length, 2);
    assert.match(recent[0], /second ordinary line$/);
    assert.match(recent[1], /third ordinary line$/);
  });

  it('rotates at the size cap and keeps reading across the old file', async () => {
    const root = await newRoot();
    const maxBytes = 260;
    installFileLog({ root, env: {}, maxBytes, keep: 2 });
    for (let index = 0; index < 40; index += 1) log(`line ${index} ${'x'.repeat(40)}`);

    const file = path.join(root, 'logs', 'chesspulse.log');
    assert.ok(existsSync(`${file}.1`));
    const size = (await stat(file)).size;
    assert.ok(size <= maxBytes + 120, `current file should stay near the cap, got ${size}`);
    const recent = readRecentLogLines(root, 500).join('\n');
    assert.match(recent, /line 39 /);
    assert.ok(!recent.includes('line 0 '), 'the size cap should have dropped the oldest lines');
    assert.ok(recent.split('\n').length < 40);
  });

  it('returns nothing when no log has been written', () => {
    assert.deepEqual(readRecentLogLines('/nonexistent-chesspulse-root', 10), []);
  });
});

describe('log redaction edge cases', () => {
  it('redacts the console line and JSON-escaped secret forms', async () => {
    const lines: string[] = [];
    const capture = {
      log: (line: string) => lines.push(line),
      error: (line: string) => lines.push(line),
    } as unknown as Console;
    installSafeConsole(capture);
    const root = await newRoot();
    installFileLog({ root, env: { CP_AI_KEY: 'ai-key-with-"quote"-and-\\slash' } });
    log('plain ai-key-with-"quote"-and-\\slash');
    log({ note: 'json ai-key-with-"quote"-and-\\slash' });

    const file = await readFile(path.join(root, 'logs', 'chesspulse.log'), 'utf8');
    assert.ok(!file.includes('ai-key-with-'));
    assert.ok(!file.includes('quote'));
    assert.ok(!lines.join('\n').includes('ai-key-with-'));
    assert.match(file, /\[redacted\]/);
  });

  it('keeps ordinary arguments when another value cannot be formatted', async () => {
    const root = await newRoot();
    installFileLog({ root, env: {} });
    const hostile = {
      toJSON: () => {
        throw new Error('cannot serialize');
      },
      toString: () => {
        throw new Error('cannot stringify');
      },
    };
    assert.doesNotThrow(() => log('ordinary message', hostile));
    const file = await readFile(path.join(root, 'logs', 'chesspulse.log'), 'utf8');
    assert.match(file, /ordinary message \[unloggable value\]/);
  });
});
