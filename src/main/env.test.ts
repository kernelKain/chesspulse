import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { loadEnvFile, readSensingKey } from './env.js';

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function envFile(text: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'chesspulse-env-'));
  roots.push(root);
  const file = path.join(root, '.env');
  writeFileSync(file, text);
  return file;
}

describe('loadEnvFile', () => {
  it('reports a missing file without throwing', () => {
    const result = loadEnvFile(path.join(tmpdir(), 'chesspulse-no-such-env'), {});
    assert.equal(result.found, false);
  });

  it('reads plain, quoted, and exported keys and skips noise', () => {
    const file = envFile(
      [
        '# local secrets',
        '',
        'SMARTSPECTRA_API_KEY="abc123"',
        "export CP_AI_PROVIDER='opencode'",
        'NOT A KEY LINE',
        '=no-name',
        'lowercase_key=ignored',
        'CP_AI_MODEL=gpt-5.6-luna # trailing text stays in the value',
      ].join('\n'),
    );
    const env: NodeJS.ProcessEnv = {};
    const result = loadEnvFile(file, env);
    if (!result.found) throw new Error('the .env file should have been found');
    assert.deepEqual(result.loadedKeys, ['SMARTSPECTRA_API_KEY', 'CP_AI_PROVIDER', 'CP_AI_MODEL']);
    assert.equal(env.SMARTSPECTRA_API_KEY, 'abc123');
    assert.equal(env.CP_AI_PROVIDER, 'opencode');
    assert.equal(env.CP_AI_MODEL, 'gpt-5.6-luna # trailing text stays in the value');
    assert.equal(env.lowercase_key, undefined);
  });

  it('keeps a value already exported by the shell', () => {
    const file = envFile('SMARTSPECTRA_API_KEY=from-file\nCP_AI_KEY=from-file\n');
    const env: NodeJS.ProcessEnv = { SMARTSPECTRA_API_KEY: 'from-shell', CP_AI_KEY: '' };
    const result = loadEnvFile(file, env);
    if (!result.found) throw new Error('the .env file should have been found');
    assert.deepEqual(result.loadedKeys, ['CP_AI_KEY']);
    assert.equal(env.SMARTSPECTRA_API_KEY, 'from-shell');
    assert.equal(env.CP_AI_KEY, 'from-file');
  });
});

describe('readSensingKey', () => {
  it('trims a configured key', () => {
    assert.equal(readSensingKey({ SMARTSPECTRA_API_KEY: '  key-value  ' }), 'key-value');
  });

  it('returns empty for a missing or blank key', () => {
    assert.equal(readSensingKey({}), '');
    assert.equal(readSensingKey({ SMARTSPECTRA_API_KEY: '   ' }), '');
  });
});
