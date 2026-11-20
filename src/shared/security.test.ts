import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

  it('matches the policy Vite injects', async () => {
    const viteCopy = (await import(pathToFileURL(path.join(__dirname, '../../src/shared/security.mjs')).href)) as {
      contentSecurityPolicy: () => string;
    };
    const compiled = (await import(pathToFileURL(path.join(__dirname, 'security.js')).href)) as {
      contentSecurityPolicy: () => string;
    };
    assert.equal(viteCopy.contentSecurityPolicy(), policy);
    assert.equal(compiled.contentSecurityPolicy(), policy);
  });

  it('leaves a placeholder for the build to replace', () => {
    const html = readFileSync(path.join(__dirname, '../../src/renderer/index.html'), 'utf8');
    assert.match(html, /__CHESSPULSE_CSP__/);
  });
});
