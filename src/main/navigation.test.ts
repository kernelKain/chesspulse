import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { allowsNavigation } from './navigation.js';

const devUrl = 'http://127.0.0.1:5173';

describe('allowsNavigation', () => {
  it('allows another path on the development origin', () => {
    assert.equal(allowsNavigation('http://127.0.0.1:5173/index.html', devUrl), true);
  });

  it('denies a different port that shares the development prefix', () => {
    assert.equal(allowsNavigation('http://127.0.0.1:51730/', devUrl), false);
  });

  it('allows a local file when no development origin matches', () => {
    assert.equal(allowsNavigation('file:///tmp/chesspulse/index.html', devUrl), true);
  });

  it('denies a different host', () => {
    assert.equal(allowsNavigation('https://example.com/', devUrl), false);
  });
});
