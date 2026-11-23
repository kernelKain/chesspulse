import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { GroundingError, groundInsight } from './grounding.js';

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

  for (const name of ['diagnostic', 'medical', 'mental-state']) {
    it(`rejects diagnostic or mental-state ${name} output`, () => {
      const item = fixture(name);
      assert.throws(() => groundInsight(item.stats, item.response), /diagnostic or mental-state/);
    });
  }

  for (const name of ['pulse-language', 'tilted-position']) {
    it(`accepts ${name} without a claim`, () => {
      const item = fixture(name);
      assert.equal(groundInsight(item.stats, item.response), item.response);
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

  it('rejects a state claim even when every number is grounded', () => {
    assert.throws(
      () => groundInsight({ baselineBpm: 70 }, 'You were anxious about the 70 bpm baseline.'),
      /diagnostic or mental-state/,
    );
  });

  it('rejects present-tense and contracted mental-state claims', () => {
    for (const text of ['You are stressed.', "You're stressed.", 'You seem anxious.', 'You stay focused.', 'You feel stressed.', 'You feel very tired.', 'You seem frustrated.', 'You seem **frustrated**.', 'You were *nervous*.']) {
      assert.throws(() => groundInsight({}, text), /diagnostic or mental-state/);
    }
  });

  it('rejects a direct claim split by a newline or tab', () => {
    assert.throws(
      () => groundInsight({ baselineBpm: 70 }, 'You\nare stressed about the 70 bpm baseline.'),
      /diagnostic or mental-state/,
    );
    assert.throws(
      () => groundInsight({ baselineBpm: 70 }, 'You\tfelt anxious about the 70 bpm baseline.'),
      /diagnostic or mental-state/,
    );
  });

  it('keeps measured pulse text across a newline unchanged', () => {
    const output = 'Baseline\n70 bpm.';
    assert.equal(groundInsight({ baselineBpm: 70 }, output), output);
  });

  it('rejects a named-disease diagnosis without the general vocabulary', () => {
    assert.throws(() => groundInsight({}, 'You have diabetes.'), /diagnostic or mental-state/);
    assert.throws(() => groundInsight({}, 'You have insomnia.'), /diagnostic or mental-state/);
    assert.throws(() => groundInsight({}, 'You are suffering from burnout.'), /diagnostic or mental-state/);
    assert.equal(
      groundInsight({ baselineBpm: 70 }, 'Your pulse was 70 bpm.'),
      'Your pulse was 70 bpm.',
    );
  });
});

describe('direct-claim modifiers and measured heart rate', () => {
  it('rejects a degree word between the verb and the state adjective', () => {
    for (const text of [
      'You were very stressed.',
      "You're a bit anxious.",
      'You seemed really tired.',
      'You felt extremely overwhelmed.',
    ]) {
      assert.throws(() => groundInsight({}, text), /diagnostic or mental-state/);
    }
  });

  it('allows a grounded heart-rate measurement while still rejecting diagnostic use', () => {
    assert.equal(
      groundInsight({ baselineBpm: 72 }, 'Your baseline heart rate was 72.'),
      'Your baseline heart rate was 72.',
    );
    assert.throws(
      () => groundInsight({ baselineBpm: 72 }, 'Your heart disease explains the 72.'),
      /diagnostic or mental-state/,
    );
    assert.throws(
      () => groundInsight({ baselineBpm: 72 }, 'Your hypertensive response explains the 72.'),
      /diagnostic or mental-state/,
    );
    assert.throws(
      () =>
        groundInsight(
          { baselineBpm: 72 },
          'Your pulse was 72 bpm and you were nervous about the position.',
        ),
      /diagnostic or mental-state/,
    );
  });
});

describe('groundInsight chess notation and names', () => {
  const stats = { blunders: 3, largestLosses: [{ move: '14… Rc8', moveNumber: 14, cpl: 909 }] };
  it('accepts a move followed by sentence punctuation', () => {
    for (const text of ['The largest loss was 14… Rc8.', 'After 14… Rc8, it lost 909.', 'Then exd5; 3 blunders.']) {
      assert.equal(groundInsight(stats, text), text);
    }
  });
  it('still checks a decimal or an exponent that only looks like a square', () => {
    assert.throws(() => groundInsight(stats, 'It lost e4.5 points.'), GroundingError);
    assert.throws(() => groundInsight({ value: 1 }, 'About 1e8 positions.'), GroundingError, 'the 8 of 1e8 is not a square');
    assert.equal(groundInsight({ value: 1e8 }, 'About 1e8 positions.'), 'About 1e8 positions.');
  });
  it('does not let a square inside a word escape the check', () => {
    assert.throws(() => groundInsight(stats, 'Code abc5 applies.'), GroundingError);
  });
  it('grounds a numeric username as a name, not a quantity', () => {
    const named = { ...stats, playerScope: { kind: 'player', name: 'Oikawa9999' } };
    const text = 'Oikawa9999 made 3 blunders.';
    assert.equal(groundInsight(named, text, ['Oikawa9999']), text);
    assert.throws(
      () => groundInsight(named, 'Oikawa9999 lost 9999 centipawns.', ['Oikawa9999']),
      /introduced a number.*9999/,
      'the name does not put 9999 on the allowlist',
    );
  });
});
