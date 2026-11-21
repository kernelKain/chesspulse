import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { groundInsight } from './grounding.js';

interface EvalFixture {
  name: string;
  stats: unknown;
  response: string;
  expected: string;
}

function fixture(name: string): EvalFixture {
  return JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures/ai', `${name}.json`), 'utf8')) as EvalFixture;
}

describe('AI grounding evaluation fixtures', () => {
  for (const name of ['normal', 'ambiguous', 'malformed']) {
    it(`accepts ${name} output without changing it`, () => {
      const item = fixture(name);
      assert.equal(groundInsight(item.stats, item.response), item.response);
    });
  }

  for (const name of ['adversarial', 'missing']) {
    it(`rejects ungrounded ${name} output`, () => {
      const item = fixture(name);
      assert.throws(() => groundInsight(item.stats, item.response), /introduced a number.*99/);
    });
  }
});

describe('groundInsight', () => {
  it('treats equivalent decimal formatting and exponents as grounded', () => {
    const stats = { accuracy: 71.0, moves: 1200, limit: 1000 };
    assert.equal(groundInsight(stats, 'Accuracy 71% across 1,200 moves; limit 1e3.'), 'Accuracy 71% across 1,200 moves; limit 1e3.');
  });

  it('rejects leading-dot decimals and invented exponents', () => {
    assert.throws(() => groundInsight({ baseline: 70 }, 'Accuracy .54%.'), /\.54/);
    assert.throws(() => groundInsight({ limit: 1000 }, 'Limit 1e4.'), /1e4/);
  });

  it('treats a trailing sentence comma as punctuation, not as part of the number', () => {
    const output = 'Baseline 70, then the game continued.';
    assert.equal(groundInsight({ baseline: 70 }, output), output);
  });

  it('separates range endpoints from unary minus without accepting a negative as positive', () => {
    const output = 'The range 70-80 stayed bounded.';
    assert.equal(groundInsight({ low: 70, high: 80 }, output), output);
    assert.throws(() => groundInsight({ baseline: 70 }, 'Baseline -70.'), /-70/);
  });

  it('rejects Unicode-negative and full-width numeric notation instead of ignoring it', () => {
    assert.equal(groundInsight({ baseline: 70 }, 'Baseline 70.'), 'Baseline 70.');
    assert.throws(() => groundInsight({ baseline: 70 }, 'Baseline −70.'), /unsupported numeric notation/i);
    assert.throws(() => groundInsight({ value: 99 }, 'Value ９９.'), /unsupported numeric notation/i);
  });

  it('rejects misplaced and repeated commas instead of reinterpreting the number', () => {
    assert.throws(() => groundInsight({ value: 71 }, 'Value 7,1.'), /malformed number.*7,1/);
    assert.throws(() => groundInsight({ value: 1200 }, 'Value 1,,200.'), /malformed number.*1,,200/);
  });

  it('compares oversized integers exactly instead of rounding them', () => {
    assert.equal(groundInsight({ id: 9007199254740992n }, 'ID 9007199254740992.'), 'ID 9007199254740992.');
    assert.throws(() => groundInsight({ id: 9007199254740992n }, 'ID 9007199254740993.'), /9007199254740993/);
    assert.throws(() => groundInsight({ id: '900719925474099312345678901234567890' }, 'ID 9e999999999999999999999.'), /9e999/);
  });
});
