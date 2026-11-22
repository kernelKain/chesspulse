import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { markChoiceNeeded, picksAreOrdered } from './marks.js';

const end = { kind: 'end' as const };
const next = { kind: 'next' as const };

describe('mark choice', () => {
  it('asks nothing when the marks already place every game', () => {
    assert.equal(markChoiceNeeded([end, next, end], 2), false);
    assert.equal(markChoiceNeeded([end], 1), false);
    assert.equal(markChoiceNeeded([end, end], 2), false);
  });

  it('accepts one fewer end than games, because the stop ends the last game', () => {
    assert.equal(markChoiceNeeded([end, next], 2), false);
  });

  it('asks when the ends are too many or too few', () => {
    assert.equal(markChoiceNeeded([end, end, end], 2), true);
    assert.equal(markChoiceNeeded([end], 3), true);
    assert.equal(markChoiceNeeded([next, next], 2), true);
  });

  it('does not ask when the session has no marks at all', () => {
    assert.equal(markChoiceNeeded([], 3), false);
    assert.equal(markChoiceNeeded([end], 0), false);
  });
});

describe('picked marks', () => {
  it('accepts a complete, increasing list', () => {
    assert.equal(picksAreOrdered([1_000, 2_000, 3_000]), true);
  });

  it('rejects a gap, a repeat, and a backwards pick', () => {
    assert.equal(picksAreOrdered([1_000, null, 3_000]), false);
    assert.equal(picksAreOrdered([2_000, 2_000]), false);
    assert.equal(picksAreOrdered([3_000, 1_000]), false);
  });
});
