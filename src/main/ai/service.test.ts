import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { Report } from '../../shared/contracts.js';
import { requestInsight } from './service.js';

const ENV = { CP_AI_KEY: 'test-secret', CP_AI_MODEL: 'test-model' };
const REQUEST = { sessionId: 's1', provider: 'openai', text: 'Review this session.' };
const PGN = '[White "Untrusted"]\n1. e4 e5';
const REPORT: Report = {
  ok: true,
  sessionId: 's1',
  coveragePct: 80,
  baselineBpm: 70,
  verdict: 'Accuracy 71% settled.',
  settled: { band: 'settled', moves: 5, status: 'ok', accuracy: 71 },
  elevated: { band: 'elevated', moves: 0, status: 'insufficient' },
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

describe('requestInsight', () => {
  it('returns an honest disabled state without a key or network call', async () => {
    let calls = 0;
    const result = await requestInsight(REQUEST, REPORT, [PGN], {}, {
      fetch: async () => {
        calls += 1;
        return completion();
      },
    });
    assert.deepEqual(result, { disabled: true, reason: 'No AI key configured. Layers 1–3 are complete without it.' });
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
            text: () => new Promise<string>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(new DOMException('Timed out', 'AbortError')));
            }),
          } as Response;
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
