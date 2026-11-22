import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PulseSample, ReportResult, ValidationMessage } from './contracts.js';
import {
  currentSessionId,
  flowReducer,
  initialFlowState,
  sensingHint,
  statusFor,
  type FlowState,
} from './flow.js';

const refusal: ReportResult = {
  ok: false,
  reason: 'no_games',
  remedy: 'Paste at least one game.',
};

function atReview(): FlowState {
  return flowReducer(
    flowReducer(initialFlowState(), {
      type: 'sessionStarted',
      sessionId: 'session-1',
      startedAtEpochMs: 1_000,
    }),
    { type: 'sessionStopped', sessionId: 'session-1', notice: 'Stopped.' },
  );
}

function inGames(): FlowState {
  return flowReducer(atReview(), { type: 'openGames' });
}

function sample(overrides: Partial<PulseSample> = {}): PulseSample {
  return { tUs: 1_000_000, bpm: 70, confidence: 90, stable: true, ...overrides };
}

describe('flow reducer', () => {
  it('starts at Home with consent off', () => {
    const state = initialFlowState();
    assert.equal(state.screen, 'home');
    assert.equal(state.consent, false);
    assert.equal(state.session, null);
    assert.match(state.notice, /camera stays off/i);
  });

  it('restores consent and an open session after a reload', () => {
    const state = flowReducer(initialFlowState(), {
      type: 'hydrated',
      consent: true,
      session: { id: 'session-1', startedAtEpochMs: 1_000, betweenGames: true, markedGames: 1 },
    });
    assert.equal(state.screen, 'sensing');
    assert.equal(state.consent, true);
    assert.deepEqual(state.session, {
      id: 'session-1',
      startedAtEpochMs: 1_000,
      betweenGames: true,
      markedGames: 1,
    });
  });

  it('restores consent without pretending a closed session is live', () => {
    const state = flowReducer(initialFlowState(), {
      type: 'hydrated',
      consent: true,
      session: null,
    });
    assert.equal(state.screen, 'home');
    assert.equal(state.session, null);
    assert.equal(state.notice, 'Consent is on. The camera opens when you start sensing.');
  });

  it('never lets a late hydration reopen a session the page already finished or is reviewing', () => {
    const stopped = atReview();
    assert.equal(
      flowReducer(stopped, {
        type: 'hydrated',
        consent: true,
        session: { id: 'session-1', startedAtEpochMs: 1_000, betweenGames: false, markedGames: 0 },
      }),
      stopped,
    );
  });

  it('never lets a late hydration replace a session the page already adopted', () => {
    const started = flowReducer(initialFlowState(), {
      type: 'sessionStarted',
      sessionId: 'new-session',
      startedAtEpochMs: 2_000,
    });
    const state = flowReducer(started, {
      type: 'hydrated',
      consent: true,
      session: { id: 'old-session', startedAtEpochMs: 1_000, betweenGames: false, markedGames: 0 },
    });
    assert.equal(state, started);
  });

  it('adopts a session as Sensing and clears the previous draft and review', () => {
    const state = flowReducer(
      { ...inGames(), draft: ['pgn'], review: null },
      { type: 'sessionStarted', sessionId: 'session-2', startedAtEpochMs: 2_000 },
    );
    assert.equal(state.screen, 'sensing');
    assert.equal(state.session?.id, 'session-2');
    assert.deepEqual(state.draft, []);
    assert.equal(state.review, null);
  });

  it('stops into the session summary and keeps the id for the games screen', () => {
    const sensing = flowReducer(initialFlowState(), {
      type: 'sessionStarted',
      sessionId: 'session-1',
      startedAtEpochMs: 1_000,
    });
    const state = flowReducer(sensing, {
      type: 'sessionStopped',
      sessionId: 'session-1',
      notice: 'Baseline 70 bpm.',
    });
    assert.equal(state.screen, 'stopped');
    assert.equal(state.session, null);
    assert.equal(currentSessionId(state), 'session-1');
  });

  it('counts one marked game per transition into the gap and only while live', () => {
    const sensing = flowReducer(initialFlowState(), {
      type: 'sessionStarted',
      sessionId: 'session-1',
      startedAtEpochMs: 1_000,
    });
    const first = flowReducer(sensing, { type: 'gapChanged', betweenGames: true });
    const repeated = flowReducer(first, { type: 'gapChanged', betweenGames: true });
    const back = flowReducer(repeated, { type: 'gapChanged', betweenGames: false });
    const second = flowReducer(back, { type: 'gapChanged', betweenGames: true });
    assert.equal(first.session?.markedGames, 1);
    assert.equal(repeated.session?.markedGames, 1);
    assert.equal(back.session?.markedGames, 1);
    assert.equal(second.session?.markedGames, 2);
    assert.equal(flowReducer(atReview(), { type: 'gapChanged', betweenGames: true }).session, null);
  });

  it('returns from Help to the screen that opened it', () => {
    const sensing = flowReducer(initialFlowState(), {
      type: 'sessionStarted',
      sessionId: 'session-1',
      startedAtEpochMs: 1_000,
    });
    const help = flowReducer(sensing, { type: 'openHelp' });
    assert.equal(help.screen, 'help');
    assert.equal(help.helpReturn, 'sensing');
    assert.equal(flowReducer(help, { type: 'closeHelp' }).screen, 'sensing');

    const fromHome = flowReducer(initialFlowState(), { type: 'openHelp' });
    assert.equal(flowReducer(fromHome, { type: 'closeHelp' }).screen, 'home');
    assert.equal(flowReducer(fromHome, { type: 'openHelp' }), fromHome);

    const stopped = flowReducer(help, {
      type: 'sessionStopped',
      sessionId: 'session-1',
      notice: 'Stopped.',
    });
    assert.equal(stopped.helpReturn, null);
    assert.equal(stopped.screen, 'stopped');
  });

  it('dismisses the explainer once the player has seen it', () => {
    const dismissed = flowReducer(initialFlowState(), { type: 'explainerDismissed' });
    assert.equal(dismissed.explainerSeen, true);
    assert.equal(flowReducer(dismissed, { type: 'explainerDismissed' }), dismissed);
  });

  it('rejects Games before a session has stopped', () => {    const sensing = flowReducer(initialFlowState(), {
      type: 'sessionStarted',
      sessionId: 'session-1',
      startedAtEpochMs: 1_000,
    });
    assert.equal(flowReducer(sensing, { type: 'openGames' }), sensing);
    assert.equal(flowReducer(initialFlowState(), { type: 'openGames' }).screen, 'home');
  });

  it('opens Games only from Stopped or Review, and keeps the paste', () => {
    const stopped = atReview();
    assert.equal(flowReducer(stopped, { type: 'openGames' }).screen, 'games');

    const games = inGames();
    const pasted = flowReducer(games, { type: 'pasteChanged', slots: ['pgn'] });
    const review = flowReducer(pasted, {
      type: 'reportStarted',
      sessionId: 'session-1',
      slots: ['pgn'],
    });
    assert.equal(review.screen, 'review');
    assert.deepEqual(review.draft, ['pgn']);
    assert.equal(flowReducer(review, { type: 'openGames' }).screen, 'games');
    assert.deepEqual(flowReducer(review, { type: 'openGames' }).draft, ['pgn']);
  });

  it('shows progress only while a build is running', () => {
    const games = inGames();
    assert.equal(flowReducer(games, { type: 'reportProgress', scored: 1, total: 2 }), games);

    const building = flowReducer(games, {
      type: 'reportStarted',
      sessionId: 'session-1',
      slots: ['pgn'],
    });
    const progress = flowReducer(building, { type: 'reportProgress', scored: 1, total: 2 });
    assert.deepEqual(progress.review?.progress, { scored: 1, total: 2 });
    assert.equal(progress.review?.building, true);
  });

  it('turns a finished build into a review and a failure into an error on the review', () => {
    const games = inGames();
    const building = flowReducer(games, {
      type: 'reportStarted',
      sessionId: 'session-1',
      slots: ['pgn'],
    });
    const ready = flowReducer(building, { type: 'reportReady', result: refusal });
    assert.equal(ready.review?.result, refusal);
    assert.equal(ready.review?.building, false);
    assert.equal(ready.screen, 'review');

    const failed = flowReducer(building, { type: 'reportFailed', message: 'No.' });
    assert.equal(failed.review?.building, false);
    assert.equal(failed.review?.error, 'No.');
  });

  it('returns to the session summary from a review and refuses Review without a report', () => {
    const review = flowReducer(inGames(), {
      type: 'reportStarted',
      sessionId: 'session-1',
      slots: ['pgn'],
    });
    assert.equal(flowReducer(review, { type: 'openStopped' }).screen, 'stopped');
    const stopped = atReview();
    assert.equal(flowReducer(stopped, { type: 'openReview' }), stopped);
  });

  it('opens an earlier session at Review when it has a report and at Games otherwise', () => {
    const withReport = flowReducer(initialFlowState(), {
      type: 'openedSession',
      sessionId: 'old-1',
      report: refusal,
      games: ['pgn'],
    });
    assert.equal(withReport.screen, 'review');
    assert.equal(withReport.review?.result, refusal);
    assert.equal(withReport.session, null);

    const withoutReport = flowReducer(initialFlowState(), {
      type: 'openedSession',
      sessionId: 'old-2',
      report: null,
      games: [],
    });
    assert.equal(withoutReport.screen, 'games');
    assert.equal(withoutReport.review, null);
    assert.equal(currentSessionId(withoutReport), 'old-2');
  });

  it('deletes only the session currently shown, then returns Home', () => {
    const games = inGames();
    assert.equal(flowReducer(games, { type: 'sessionDeleted', sessionId: 'other' }), games);

    const deleted = flowReducer(games, { type: 'sessionDeleted', sessionId: 'session-1' });
    assert.equal(deleted.screen, 'home');
    assert.equal(deleted.stoppedSessionId, null);
    assert.deepEqual(deleted.draft, []);
    assert.equal(deleted.notice, 'Session deleted.');
  });

  it('keeps consent and urgent messages independent of the screen', () => {
    const state = flowReducer(initialFlowState(), { type: 'consentChanged', granted: true });
    assert.equal(state.consent, true);
    const failed = flowReducer(state, { type: 'error', message: 'Storage failed.' });
    assert.equal(flowReducer(failed, { type: 'clearError' }).error, null);
    assert.equal(flowReducer(failed, { type: 'consentChanged', granted: false }).error, 'Storage failed.');
  });
});

describe('status priority', () => {
  const base = { error: null, sdkError: null, screen: 'sensing' as const, hint: null, notice: 'Note.' };

  it('puts an operation error above every other message', () => {
    const status = statusFor({ ...base, error: 'Operation.', sdkError: 'SDK.', hint: 'Hint.' });
    assert.deepEqual(status, { text: 'Operation.', tone: 'error', urgent: true });
  });

  it('puts a sensing error above a live hint', () => {
    const status = statusFor({ ...base, sdkError: 'SDK.', hint: 'Hint.' });
    assert.deepEqual(status, { text: 'SDK.', tone: 'error', urgent: true });
  });

  it('shows a live hint while sensing and falls back to the session note', () => {
    assert.equal(statusFor({ ...base, hint: 'Waiting.' }).text, 'Waiting.');
    assert.equal(statusFor({ ...base }).text, 'Note.');
  });

  it('does not show a sensing hint on another screen', () => {
    const status = statusFor({ ...base, screen: 'home', hint: 'Waiting.' });
    assert.equal(status.text, 'Note.');
    assert.equal(status.urgent, false);
  });
});

describe('sensing hint', () => {
  it('prefers the SDK hint when the SDK reports a problem', () => {
    const message: ValidationMessage = { code: 5, ts: 0, hint: 'Too dark.' };
    assert.equal(sensingHint([sample()], message), 'Too dark.');
  });

  it('reports waiting, validating, low confidence, then a steady reading', () => {
    assert.equal(sensingHint([], null), 'Waiting for a face.');
    assert.equal(sensingHint([sample({ stable: false, confidence: 10 })], null), 'Validating.');
    assert.equal(
      sensingHint(
        [sample(), sample({ tUs: 2_000_000, stable: false, confidence: 10 })],
        null,
      ),
      'Low confidence.',
    );
    assert.equal(sensingHint([sample()], { code: 0, ts: 0, hint: 'Measuring.' }), 'Sensing.');
  });
});
