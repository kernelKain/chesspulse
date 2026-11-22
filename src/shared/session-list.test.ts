import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  coverageLabel,
  formatSessionDate,
  formatSessionDuration,
  reportPresenceLabel,
} from './session-list.js';

describe('session row labels', () => {
  it('formats duration and treats a missing duration honestly', () => {
    assert.equal(formatSessionDuration(65_000), '1:05 elapsed');
    assert.equal(formatSessionDuration(null), 'No duration');
  });

  it('formats coverage and treats a missing value honestly', () => {
    assert.equal(coverageLabel(75.4), '75% coverage');
    assert.equal(coverageLabel(0), '0% coverage');
    assert.equal(coverageLabel(null), 'No coverage');
  });

  it('names report presence without guessing', () => {
    assert.equal(reportPresenceLabel(true), 'Report saved');
    assert.equal(reportPresenceLabel(false), 'No report yet');
  });

  it('formats a real date and refuses a non-finite one', () => {
    const first = formatSessionDate(1_700_000_000_000);
    const second = formatSessionDate(1_700_003_600_000);
    assert.ok(first.length > 0);
    assert.notEqual(first, second);
    assert.equal(formatSessionDate(Number.NaN), 'Unknown date');
    assert.equal(formatSessionDate(1e20), 'Unknown date');
  });
});
