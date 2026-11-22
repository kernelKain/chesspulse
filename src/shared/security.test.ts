import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { contentSecurityPolicy } from './security.js';

describe('contentSecurityPolicy', () => {
  const policy = contentSecurityPolicy();

  it('allows the SDK worker blob and nothing off-origin', () => {
    assert.match(policy, /worker-src 'self' blob:/);
    assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval|https:|127\.0\.0\.1/);
    assert.match(policy, /default-src 'self'/);
    assert.match(policy, /connect-src 'self'/);
  });

  it('compiles to the same policy the source declares', async () => {
    const compiled = (await import(pathToFileURL(path.join(__dirname, 'security.js')).href)) as {
      contentSecurityPolicy: (development?: boolean) => string;
    };
    assert.equal(compiled.contentSecurityPolicy(), policy);
    assert.equal(compiled.contentSecurityPolicy(true), contentSecurityPolicy(true));
    assert.match(compiled.contentSecurityPolicy(true), /script-src 'self' 'unsafe-inline'/);
    assert.doesNotMatch(compiled.contentSecurityPolicy(true), /style-src 'self' 'unsafe-inline'/);
  });

  it('keeps Vite on the one TypeScript source', () => {
    const config = readFileSync(path.join(__dirname, '../../vite.config.mts'), 'utf8');
    assert.match(config, /from '\.\/src\/shared\/security\.ts'/);
    assert.doesNotMatch(config, /security\.mjs/);
    assert.equal(existsSync(path.join(__dirname, '../../src/shared/security.mjs')), false);
  });

  it('leaves a placeholder for the build to replace', () => {
    const html = readFileSync(path.join(__dirname, '../../src/renderer/index.html'), 'utf8');
    assert.match(html, /__CHESSPULSE_CSP__/);
  });
});
