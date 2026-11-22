import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readAppState } from './app-state.js';

describe('readAppState', () => {
  it('reports consent and a live session so a reload can resume the sensing screen', () => {
    const state = readAppState({
      consent: () => ({ granted: true, cameraAllowed: true }),
      session: () => ({
        active: true,
        sessionId: 'session-1',
        startedAtEpochMs: 1_000,
        betweenGames: true,
        markedGames: 2,
      }),
    });
    assert.equal(state.consent.granted, true);
    assert.equal(state.session.active, true);
    assert.equal(state.session.sessionId, 'session-1');
    assert.equal(state.session.betweenGames, true);
  });

  it('reports consent without inventing a session', () => {
    const state = readAppState({
      consent: () => ({ granted: true, cameraAllowed: true }),
      session: () => ({
        active: false,
        sessionId: null,
        startedAtEpochMs: null,
        betweenGames: false,
        markedGames: 0,
      }),
    });
    assert.equal(state.session.active, false);
    assert.equal(state.session.sessionId, null);
  });

  it('refuses a self-contradictory session snapshot', () => {
    assert.throws(() =>
      readAppState({
        consent: () => ({ granted: false, cameraAllowed: false }),
        session: () => ({
          active: false,
          sessionId: 'session-1',
          startedAtEpochMs: 1_000,
          betweenGames: false,
          markedGames: 0,
        }),
      }),
    );
  });
});
