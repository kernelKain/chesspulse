import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  EXPLAINER_NEVERS,
  EXPLAINER_PREFERENCE_KEY,
  EXPLAINER_STEPS,
  readExplainerSeen,
  rememberExplainerSeen,
  type PreferenceStore,
} from './onboarding.js';

function memoryStore(initial: Record<string, string> = {}): PreferenceStore & { values: Record<string, string> } {
  const values = { ...initial };
  return {
    values,
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
    },
    setItem(key, value) {
      values[key] = value;
    },
  };
}

describe('first-run explainer copy', () => {
  it('has five numbered steps in the order Setup repeats', () => {
    assert.equal(EXPLAINER_STEPS.length, 5);
    for (const step of EXPLAINER_STEPS) {
      assert.ok(step.title.length > 0);
      assert.ok(step.body.length > 0);
    }
    assert.match(EXPLAINER_STEPS[0].title, /camera/i);
    assert.match(EXPLAINER_STEPS[3].body, /oldest first/i);
  });

  it('states the fair-play, medical, and local-only limits', () => {
    assert.equal(EXPLAINER_NEVERS.length, 3);
    assert.ok(EXPLAINER_NEVERS.some((line) => /rated game/i.test(line)));
    assert.ok(EXPLAINER_NEVERS.some((line) => /diagnose|medical/i.test(line)));
    assert.ok(EXPLAINER_NEVERS.some((line) => /upload/i.test(line)));
  });
});

describe('explainer preference', () => {
  it('treats a missing or different value as not seen', () => {
    assert.equal(readExplainerSeen(memoryStore()), false);
    assert.equal(readExplainerSeen(memoryStore({ [EXPLAINER_PREFERENCE_KEY]: 'false' })), false);
    assert.equal(readExplainerSeen(null), false);
  });

  it('remembers a dismissal and reads it back', () => {
    const store = memoryStore();
    assert.equal(rememberExplainerSeen(store), true);
    assert.equal(store.values[EXPLAINER_PREFERENCE_KEY], 'true');
    assert.equal(readExplainerSeen(store), true);
  });

  it('never throws when the store is unavailable', () => {
    const throwing: PreferenceStore = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
    };
    assert.equal(readExplainerSeen(throwing), false);
    assert.equal(rememberExplainerSeen(throwing), false);
  });
});
