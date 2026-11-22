import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { findBannedTerms, findCompetingTerms } from './copy-check.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

describe('copy check', () => {
  it('keeps internal labels out of the source', () => {
    assert.deepEqual(findBannedTerms(ROOT), []);
  });

  it('keeps one term per concept in the copy modules', () => {
    assert.deepEqual(findCompetingTerms(ROOT), []);
  });
});
