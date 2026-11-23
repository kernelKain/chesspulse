import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { REPORT_SCHEMA_VERSION, type Report } from '../../shared/contracts.js';
import { computedSummary, insightConfigView, requestInsight } from './service.js';

const ENV = { CP_AI_KEY: 'test-secret', CP_AI_MODEL: 'test-model' };
const REQUEST = { sessionId: 's1', text: 'Review this session.' };
const PGN = '[White "Untrusted"]\n1. e4 e5';

function digest(pgns: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(pgns), 'utf8').digest('hex');
}

const REPORT: Report = {
  ok: true,
  schemaVersion: REPORT_SCHEMA_VERSION,
  sessionId: 's1',
  gamesDigest: digest([PGN]),
  coveragePct: 80,
  baselineBpm: 70,
  verdict: 'Accuracy 71% settled.',
  settled: { band: 'settled', moves: 5, status: 'ok', accuracy: 71 },
  elevated: { band: 'elevated', moves: 0, status: 'insufficient' },
  engine: {
    depth: 12,
    positions: 0,
    scored: 0,
    failed: 0,
    reasons: { timeout: 0, crash: 0, engine: 0, budget: 0 },
  },
  alignmentMode: 'endtime',
  toleranceSec: 1,
  games: [],
  timeline: {
    startUs: 0,
    stopUs: 1000,
    baselineBpm: 70,
    elevatedThresholdBpm: 80,
    samples: [{ tUs: 0, bpm: 999, confidence: 80, stable: true }],
    games: [],
    moves: [],
  },
};
const OUTPUT = 'The settled accuracy was 71%.';

function completion(text = OUTPUT): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 });
}

describe('grounded session totals', () => {
  const moves = [
    { gameIndex: 0, moveIndex: 0, san: 'e4', tUs: 1, cpl: 300, thinkSec: 1, blunder: true, mate: false, scored: true, band: 'settled' as const },
    { gameIndex: 0, moveIndex: 2, san: 'Nf3', tUs: 2, cpl: 10, thinkSec: 1, blunder: false, mate: false, scored: true, band: 'elevated' as const },
    { gameIndex: 1, moveIndex: 1, san: 'e5', tUs: 3, cpl: 400, thinkSec: 1, blunder: true, mate: false, scored: true, band: 'elevated' as const },
    { gameIndex: 1, moveIndex: 3, san: 'Nc6', tUs: 4, cpl: null, thinkSec: 1, blunder: false, mate: false, scored: false, band: null },
  ];
  const game = (index: number, blunders: number) => ({
    index, white: 'Ada', black: 'Nim', result: '1-0', ending: 'resignation' as const,
    includeInStats: true, moveCount: 30, blunders, aligned: true,
  });
  // A report saved before totals existed: the verdict states a total the per-game rows do not.
  const legacy: Report = {
    ...REPORT,
    verdict: '2 blunders, 1 of them while your pulse was elevated.',
    games: [game(8, 1), game(9, 1)],
    timeline: { ...REPORT.timeline, moves },
  };

  it('counts totals for an older report from its stored moves', () => {
    const summary = computedSummary(legacy) as { totals: unknown; games: { gameNumber: number }[] };
    assert.deepEqual(summary.totals, { gamesIncluded: 2, scored: 3, unscored: 1, blunders: 2, elevatedBlunders: 1 });
    assert.deepEqual(summary.games.map((entry) => entry.gameNumber), [9, 10]);
  });

  it('prefers stored totals and names the longest break by public game numbers', () => {
    const summary = computedSummary({
      ...legacy,
      totals: { gamesIncluded: 2, scored: 60, unscored: 0, blunders: 14, elevatedBlunders: 0 },
      longestGap: { afterIndex: 8, beforeIndex: 9, durationSec: 60 },
    }) as { totals: { blunders: number }; longestGap: unknown };
    assert.equal(summary.totals.blunders, 14);
    assert.deepEqual(summary.longestGap, { afterGameNumber: 9, beforeGameNumber: 10, durationSec: 60 });
  });

  it('accepts a reading that repeats the verdict total and a public game number', async () => {
    const text = 'There were 2 blunders, 1 during elevated pulse. Game 10 is worth reviewing.';
    const result = await requestInsight(REQUEST, legacy, [PGN], ENV, { fetch: async () => completion(text) });
    assert.deepEqual(result, { disabled: false, provider: 'openai', text });
  });

  it('still withholds a number that is not computed anywhere', async () => {
    await assert.rejects(
      requestInsight(REQUEST, legacy, [PGN], ENV, { fetch: async () => completion('There were 37 blunders.') }),
      /introduced a number.*37/,
    );
  });
});

describe('provider comes from .env only', () => {
  it('refuses a request that tries to name its own provider', async () => {
    let calls = 0;
    await assert.rejects(
      requestInsight({ ...REQUEST, provider: 'anthropic' }, REPORT, [PGN], ENV, {
        fetch: async () => {
          calls += 1;
          return completion();
        },
      }),
      /a session and a question/,
    );
    assert.equal(calls, 0);
  });

  it('uses CP_AI_PROVIDER and sends the OpenCode session header', async () => {
    let request: { url: string; headers: Record<string, string> } | undefined;
    const result = await requestInsight(
      REQUEST,
      REPORT,
      [PGN],
      { ...ENV, CP_AI_PROVIDER: 'opencode', CP_AI_BASE_URL: 'https://opencode.ai/inference/go/v1' },
      {
        conversationId: '3f2b8c4e-0000-4000-8000-000000000000',
        fetch: async (url, init) => {
          request = { url: String(url), headers: init?.headers as Record<string, string> };
          return completion();
        },
      },
    );
    assert.equal(result.disabled === false && result.provider, 'opencode');
    assert.equal(request?.url, 'https://opencode.ai/inference/go/v1/chat/completions');
    assert.equal(request?.headers['x-opencode-session'], '3f2b8c4e-0000-4000-8000-000000000000');
    assert.match(request?.headers['user-agent'] ?? '', /^chesspulse\//);
  });

  it('names a MissingSessionID refusal instead of calling it an unusable response', async () => {
    await assert.rejects(
      requestInsight(REQUEST, REPORT, [PGN], { ...ENV, CP_AI_PROVIDER: 'opencode' }, {
        fetch: async () =>
          new Response(JSON.stringify({ type: 'error', error: { type: 'MissingSessionID', message: 'x' } }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          }),
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'ai_request_rejected');
        assert.equal((error as { diagnostic?: string }).diagnostic, 'status=400 type=MissingSessionID');
        return true;
      },
    );
  });
});

describe('requestInsight', () => {
  it('returns an honest disabled state without a key or network call', async () => {
    let calls = 0;
    const result = await requestInsight(REQUEST, REPORT, [PGN], {}, {
      fetch: async () => {
        calls += 1;
        return completion();
      },
    });
    assert.deepEqual(result, { disabled: true, reason: 'CP_AI_KEY is empty. The report is complete without it.' });
    assert.equal(calls, 0);
  });

  it('refuses missing computed input and oversized questions before calling a provider', async () => {
    let calls = 0;
    const fetchStub: typeof fetch = async () => {
      calls += 1;
      return completion();
    };
    await assert.rejects(requestInsight(REQUEST, null, [PGN], ENV, { fetch: fetchStub }), /No computed session data/);
    await assert.rejects(requestInsight({ ...REQUEST, text: 'x'.repeat(4001) }, REPORT, [PGN], ENV, { fetch: fetchStub }), /AI reading needs/);
    assert.equal(calls, 0);
  });

  it('rejects PGNs that do not match the report digest before calling a provider', async () => {
    let calls = 0;
    const report = { ...REPORT, gamesDigest: digest([PGN]) };

    await assert.rejects(
      requestInsight(REQUEST, report, ['[Event "Different"]\n1. d4 d5'], ENV, {
        fetch: async () => {
          calls += 1;
          return completion();
        },
      }),
      /Build the report again/,
    );
    assert.equal(calls, 0);
  });

  it('treats a report without a games digest as stale and makes no provider call', async () => {
    let calls = 0;
    const legacyReport = Object.fromEntries(
      Object.entries(REPORT).filter(([key]) => key !== 'gamesDigest'),
    ) as Report;

    await assert.rejects(
      requestInsight(REQUEST, legacyReport, [PGN], ENV, {
        fetch: async () => {
          calls += 1;
          return completion();
        },
      }),
      /Build the report again/,
    );
    assert.equal(calls, 0);
  });

  it('sends PGN and computed stats but never the raw pulse trace', async () => {
    let body = '';
    await requestInsight(REQUEST, REPORT, [PGN], ENV, {
      fetch: async (_url, init) => {
        body = String(init?.body);
        return completion();
      },
    });
    const messages = (JSON.parse(body) as { messages: { content: string }[] }).messages;
    const prompt = messages[messages.length - 1].content;
    assert.equal(prompt.includes(PGN), true);
    assert.equal(prompt.includes('"coveragePct":80'), true);
    assert.equal(prompt.includes('999'), false);
    assert.equal(prompt.includes('"samples"'), false);
  });

  it('does not ground against PGN-derived player, result, or time-control fields', async () => {
    const report: Report = {
      ...REPORT,
      games: [{
        index: 0,
        white: '99',
        black: '100',
        result: '99-0',
        ending: 'unknown',
        includeInStats: true,
        moveCount: 2,
        blunders: 0,
        aligned: true,
        timeControl: '99+99',
      }],
    };
    await assert.rejects(
      requestInsight(REQUEST, report, [PGN], ENV, { fetch: async () => completion('Player 99 won.') }),
      /introduced a number.*99/,
    );
  });

  it('cancels before a provider call when the reading is already aborted', async () => {
    let calls = 0;
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      requestInsight(REQUEST, REPORT, [PGN], ENV, {
        signal: controller.signal,
        fetch: async () => {
          calls += 1;
          return completion();
        },
      }),
      /cancelled/,
    );
    assert.equal(calls, 0);
  });

  it('retries one 500 and grounds the successful response', async () => {
    let calls = 0;
    const result = await requestInsight(REQUEST, REPORT, [PGN], ENV, {
      fetch: async () => {
        calls += 1;
        return calls === 1 ? new Response('failure', { status: 500 }) : completion();
      },
    });
    assert.deepEqual(result, { disabled: false, provider: 'openai', text: OUTPUT });
    assert.equal(calls, 2);
  });

  it('does not retry a rejected key or an ungrounded response', async () => {
    let keyCalls = 0;
    await assert.rejects(
      requestInsight(REQUEST, REPORT, [PGN], ENV, {
        fetch: async () => {
          keyCalls += 1;
          return new Response('no', { status: 401 });
        },
      }),
      /rejected the key/,
    );
    assert.equal(keyCalls, 1);

    let groundingCalls = 0;
    await assert.rejects(
      requestInsight(REQUEST, REPORT, [PGN], ENV, {
        fetch: async () => {
          groundingCalls += 1;
          return completion('Accuracy fell to 54%.');
        },
      }),
      /introduced a number/,
    );
    assert.equal(groundingCalls, 1);
  });

  it('surfaces a reasoning-only reply as an explicit error without retrying', async () => {
    let calls = 0;
    await assert.rejects(
      requestInsight(REQUEST, REPORT, [PGN], ENV, {
        fetch: async () => {
          calls += 1;
          return new Response(
            JSON.stringify({ choices: [{ message: { content: null, reasoning_content: 'thought' } }] }),
            { status: 200 },
          );
        },
      }),
      /reasoning but no final answer/,
    );
    assert.equal(calls, 1);
  });

  it('does not repeat a call whose headers time out', async () => {
    let calls = 0;
    await assert.rejects(
      requestInsight(REQUEST, REPORT, [PGN], ENV, {
        timeoutMs: 5,
        fetch: (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          calls += 1;
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('Timed out', 'AbortError')));
          });
        },
      }),
      /timed out/,
    );
    assert.equal(calls, 1);
  });

  it('keeps the timeout active while the response body stalls', async () => {
    let calls = 0;
    await assert.rejects(
      requestInsight(REQUEST, REPORT, [PGN], ENV, {
        timeoutMs: 5,
        fetch: async (_url, init) => {
          calls += 1;
          return {
            ok: true,
            body: {
              getReader: () => ({
                read: () => new Promise<never>((_resolve, reject) => {
                  init?.signal?.addEventListener('abort', () => reject(new DOMException('Timed out', 'AbortError')));
                }),
              }),
            },
          } as unknown as Response;
        },
      }),
      /timed out/,
    );
    assert.equal(calls, 1);
  });

  it('stops after the provider-failure fixture retries once and times out', async () => {
    const fixture = JSON.parse(
      readFileSync(path.join(process.cwd(), 'tests/fixtures/ai/provider-failure.json'), 'utf8'),
    ) as { sequence: string[] };
    let calls = 0;
    await assert.rejects(
      requestInsight(REQUEST, REPORT, [PGN], ENV, {
        timeoutMs: 5,
        fetch: (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          const action = fixture.sequence[calls];
          calls += 1;
          if (action === '500') return Promise.resolve(new Response('failure', { status: 500 }));
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('Timed out', 'AbortError')));
          });
        },
      }),
      /timed out/,
    );
    assert.equal(calls, 2);
  });
});

describe('grounded move labels and config view', () => {
  const PGN2 = '[White "Ada"]\n1. e4 e5';
  const withGame: Report = {
    ...REPORT,
    gamesDigest: digest([PGN2]),
    games: [{
      index: 0, white: 'Ada', black: 'Nim', result: '1-0', ending: 'resignation', includeInStats: true,
      moveCount: 30, blunders: 1, aligned: true, playerSide: 'black',
      summary: {
        scored: 15, unscored: 0, overall: { moves: 15, status: 'ok', accuracy: 84 },
        settled: { band: 'settled', moves: 15, status: 'ok', accuracy: 84 },
        elevated: { band: 'elevated', moves: 0, status: 'insufficient' },
        blunders: 1, elevatedBlunders: 0, avgThinkSec: 3.5,
        largestLosses: [{ moveIndex: 27, cpl: 909, blunder: true }],
      },
    }],
    timeline: {
      ...REPORT.timeline,
      stopUs: 600_000_000,
      games: [{ index: 0, white: 'Ada', black: 'Nim', result: '1-0', ending: 'resignation', includeInStats: true, startUs: 60_000_000, endUs: 300_000_000 }],
      moves: [{ gameIndex: 0, moveIndex: 27, san: 'Rc8', tUs: 200_000_000, cpl: 909, thinkSec: 4, blunder: true, mate: false, scored: true, band: 'settled' }],
    },
  };

  it('gives the model the move labels and session span Move Quality shows', () => {
    const summary = computedSummary(withGame) as { games: { largestLosses: unknown; sessionSpan: unknown; playerSide: string }[] };
    assert.deepEqual(summary.games[0]?.largestLosses, [{ move: '14… Rc8', moveNumber: 14, cpl: 909, blunder: true }]);
    assert.deepEqual(summary.games[0]?.sessionSpan, { start: '1:00', end: '5:00' });
    assert.equal(summary.games[0]?.playerSide, 'black');
  });

  it('accepts a cited move label, treating its square as notation, and still refuses a new quantity', async () => {
    const text = 'In Game 1, 14… Rc8 lost 909 centipawns, the largest change; after exd5 the position held.';
    const result = await requestInsight(REQUEST, withGame, [PGN2], ENV, { fetch: async () => completion(text) });
    assert.deepEqual(result, { disabled: false, provider: 'openai', text });
    await assert.rejects(
      requestInsight(REQUEST, withGame, [PGN2], ENV, { fetch: async () => completion('14… Rc8 lost 7 points.') }),
      /introduced a number.*7/,
    );
  });

  it('grounds the scoped player name as a name in a live request', async () => {
    const named: Report = { ...withGame, playerScope: { kind: 'player', name: 'Ada2024' } };
    const ok = 'Ada2024 lost 909 centipawns on 14… Rc8.';
    assert.deepEqual(await requestInsight(REQUEST, named, [PGN2], ENV, { fetch: async () => completion(ok) }), {
      disabled: false, provider: 'openai', text: ok,
    });
    await assert.rejects(
      requestInsight(REQUEST, named, [PGN2], ENV, { fetch: async () => completion('Ada2024 had 2024 blunders.') }),
      /introduced a number.*2024/,
    );
  });

  it('rounds coverage and bpm as the report header prints them', () => {
    const summary = computedSummary({
      ...withGame,
      coveragePct: 88.17310816317546,
      baselineBpm: 81.39413452148438,
      timeline: { ...withGame.timeline, elevatedThresholdBpm: 91.39413452148438 },
    }) as { coveragePct: number; baselineBpm: number; elevatedThresholdBpm: number };
    assert.deepEqual([summary.coveragePct, summary.baselineBpm, summary.elevatedThresholdBpm], [88, 81.4, 91.4]);
  });

  it('names the provider and model for the panel and never the key', () => {
    const view = insightConfigView({ CP_AI_PROVIDER: 'opencode', CP_AI_KEY: 'sk-secret-value', CP_AI_MODEL: 'deepseek-v4.1-flash' });
    assert.deepEqual(view, { configured: true, provider: 'opencode', model: 'deepseek-v4.1-flash' });
    assert.equal(JSON.stringify(view).includes('sk-secret-value'), false);
    const off = insightConfigView({});
    assert.equal(off.configured, false);
  });
});
