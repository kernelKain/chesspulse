import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { AiProvider } from '../../shared/contracts.js';
import { readAiConfig } from './config.js';
import {
  CLIENT_USER_AGENT,
  MAX_OUTPUT_TOKENS,
  OPENCODE_MAX_OUTPUT_TOKENS,
  OPENCODE_REASONING_EFFORT,
  callProvider,
  type AiConfiguration,
} from './providers.js';

const INPUT = 'Computed summary: accuracy 71% settled.';
const OUTPUT = 'The settled accuracy was 71%.';

function configuration(provider: AiProvider): AiConfiguration {
  const result = readAiConfig(
    {
      CP_AI_KEY: 'test-secret',
      CP_AI_MODEL: 'test-model',
      CP_AI_BASE_URL: provider === 'custom' ? 'https://custom.example/v1' : undefined,
    },
    provider,
  );
  assert.equal(result.disabled, false);
  if (result.disabled) throw new Error('expected a provider configuration');
  return result.config;
}

function responseFor(provider: AiProvider): unknown {
  if (provider === 'anthropic') return { content: [{ type: 'text', text: OUTPUT }] };
  if (provider === 'google') return { candidates: [{ content: { parts: [{ text: OUTPUT }] } }] };
  return { choices: [{ message: { content: OUTPUT } }] };
}

describe('provider adapters', () => {
  for (const provider of ['openai', 'anthropic', 'google', 'opencode', 'custom'] as const) {
    it(`builds and reads a ${provider} request`, async () => {
      let request: { url: string; init: RequestInit } | undefined;
      const fetchStub: typeof fetch = async (url, init) => {
        request = { url: String(url), init: init ?? {} };
        return new Response(JSON.stringify(responseFor(provider)), { status: 200 });
      };

      assert.equal(await callProvider(configuration(provider), INPUT, fetchStub), OUTPUT);
      assert.ok(request);
      const headers = request.init.headers as Record<string, string>;
      const body = JSON.parse(String(request.init.body)) as Record<string, unknown>;
      assert.equal(body.model, provider === 'google' ? undefined : 'test-model');
      assert.equal(JSON.stringify(body).includes('test-secret'), false);
      assert.equal(JSON.stringify(body).includes(INPUT), true);
      assert.equal(JSON.stringify(body).includes('untrusted data'), true);
      assert.equal(request.init.redirect, 'error');
      assert.equal(headers['user-agent'], CLIENT_USER_AGENT);
      // Only OpenCode is asked for low effort; other presets keep their provider defaults.
      assert.equal(body.reasoning_effort, provider === 'opencode' ? OPENCODE_REASONING_EFFORT : undefined);
      if (provider === 'openai') {
        assert.equal(body.max_completion_tokens, MAX_OUTPUT_TOKENS);
        assert.equal(body.max_tokens, undefined);
      } else if (provider === 'opencode' || provider === 'custom') {
        assert.equal(body.max_tokens, provider === 'opencode' ? OPENCODE_MAX_OUTPUT_TOKENS : MAX_OUTPUT_TOKENS);
        assert.equal(body.max_completion_tokens, undefined);
      }

      if (provider === 'anthropic') {
        assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
        assert.equal(headers['x-api-key'], 'test-secret');
        assert.equal(headers['anthropic-version'], '2023-06-01');
      } else if (provider === 'google') {
        assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent');
        assert.equal(headers['x-goog-api-key'], 'test-secret');
      } else {
        const base = provider === 'openai' ? 'https://api.openai.com/v1' : provider === 'opencode' ? 'https://opencode.ai/inference/openai/v1' : 'https://custom.example/v1';
        assert.equal(request.url, `${base}/chat/completions`);
        assert.equal(headers.Authorization, 'Bearer test-secret');
      }
    });
  }

  it('sends x-opencode-session to OpenCode only, and only when a conversation id is supplied', async () => {
    const seen: Record<string, string>[] = [];
    const fetchStub: typeof fetch = async (_url, init) => {
      seen.push(init?.headers as Record<string, string>);
      return new Response(JSON.stringify(responseFor('openai')), { status: 200 });
    };
    await callProvider(configuration('opencode'), INPUT, fetchStub, undefined, { conversationId: 'conv-1' });
    await callProvider(configuration('opencode'), INPUT, fetchStub);
    await callProvider(configuration('custom'), INPUT, fetchStub, undefined, { conversationId: 'conv-1' });
    assert.equal(seen[0]?.['x-opencode-session'], 'conv-1');
    assert.equal(seen[1]?.['x-opencode-session'], undefined);
    assert.equal(seen[2]?.['x-opencode-session'], undefined);
  });

  it('pins the user agent to the package version', () => {
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as { name: string; version: string };
    assert.equal(CLIENT_USER_AGENT, `${pkg.name}/${pkg.version}`);
  });

  it('maps each status to its own code and keeps only a safe diagnostic', async () => {
    const cases: [number, string, string][] = [
      [401, 'ai_rejected_key', 'authentication_error'],
      [403, 'ai_not_permitted', 'EntitlementError'],
      [404, 'ai_request_rejected', 'NotFoundError'],
      [400, 'ai_request_rejected', 'MissingSessionID'],
      [429, 'ai_rate_limited', 'rate_limit_error'],
    ];
    for (const [status, code, type] of cases) {
      const fetchStub: typeof fetch = async () =>
        new Response(JSON.stringify({ error: { type, message: 'secret-looking provider text' } }), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      await assert.rejects(callProvider(configuration('opencode'), INPUT, fetchStub), (error: unknown) => {
        assert.equal((error as { code?: string }).code, code, `status ${status}`);
        assert.equal((error as { diagnostic?: string }).diagnostic, `status=${status} type=${type}`);
        assert.equal(String(error).includes('secret-looking'), false);
        return true;
      });
    }
  });

  it('reads at most 4 KB of an error body, even from one oversized chunk', async () => {
    let reads = 0;
    let cancels = 0;
    const huge = new TextEncoder().encode(`{"error":{"type":"EntitlementError"},"pad":"${'x'.repeat(200_000)}"}`);
    const response = {
      ok: false,
      status: 403,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: {
        getReader: () => ({
          read: async () => {
            reads += 1;
            return { done: false, value: huge };
          },
          cancel: async () => {
            cancels += 1;
          },
        }),
      },
    } as unknown as Response;
    await assert.rejects(callProvider(configuration('opencode'), INPUT, async () => response), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'ai_not_permitted');
      // The truncated body is not JSON, so no type is kept; the status still names the failure.
      assert.equal((error as { diagnostic?: string }).diagnostic, 'status=403');
      return true;
    });
    assert.equal(reads, 1);
    assert.equal(cancels, 1);
  });

  it('decodes a small error body split across chunks', async () => {
    const bytes = new TextEncoder().encode('{"error":{"type":"MissingSessionID"}}');
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.subarray(0, 10));
          controller.enqueue(bytes.subarray(10));
          controller.close();
        },
      }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
    await assert.rejects(callProvider(configuration('opencode'), INPUT, async () => response), (error: unknown) => {
      assert.equal((error as { diagnostic?: string }).diagnostic, 'status=400 type=MissingSessionID');
      return true;
    });
  });

  it('drops a provider error type that is not a plain identifier', async () => {
    const fetchStub: typeof fetch = async () =>
      new Response(JSON.stringify({ error: { type: 'bad type <script>' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    await assert.rejects(callProvider(configuration('openai'), INPUT, fetchStub), (error: unknown) => {
      assert.equal((error as { diagnostic?: string }).diagnostic, 'status=400');
      return true;
    });
  });

  it('calls an empty answer that ran out of budget "no answer", not unreadable', async () => {
    const fetchStub: typeof fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }), { status: 200 });
    await assert.rejects(callProvider(configuration('opencode'), INPUT, fetchStub), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'ai_no_answer');
      assert.equal((error as { diagnostic?: string }).diagnostic, 'empty finish=length');
      return true;
    });
  });

  it('cancels an error body without replacing the mapped status error', async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({
      cancel() {
        cancelled = true;
        return Promise.reject(new Error('cancellation failed'));
      },
    }), { status: 401 });
    await assert.rejects(callProvider(configuration('openai'), INPUT, async () => response), /rejected the key/);
    assert.equal(cancelled, true);
  });

  it('cancels a successful response stream as soon as it exceeds 100000 bytes', async () => {
    let reads = 0;
    let cancels = 0;
    const chunk = new TextEncoder().encode('é'.repeat(30_000));
    const response = {
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            reads += 1;
            return { done: false, value: chunk };
          },
          cancel: async () => {
            cancels += 1;
          },
        }),
      },
      text: async () => 'x'.repeat(100_001),
    } as Response;
    await assert.rejects(callProvider(configuration('openai'), INPUT, async () => response), /unreadable response/);
    assert.equal(reads, 2);
    assert.equal(cancels, 1);
  });

  it('rejects a malformed provider payload without exposing its contents', async () => {
    const fetchStub: typeof fetch = async () => new Response('{"unexpected":true}', { status: 200 });
    await assert.rejects(callProvider(configuration('openai'), INPUT, fetchStub), (error: unknown) => {
      assert.equal(error instanceof Error ? error.message : '', 'The AI provider returned an unreadable response.');
      assert.equal(String(error).includes('unexpected'), false);
      return true;
    });
  });

  it('reports a reasoning-only reply as an explicit error, not an unreadable response', async () => {
    const bodies = [
      { choices: [{ message: { content: null, reasoning: 'thought' } }] },
      { choices: [{ message: { content: null, reasoning_content: 'thought' } }] },
      { choices: [{ message: { content: '   ', reasoning_content: 'thought' } }] },
    ];
    for (const body of bodies) {
      const fetchStub: typeof fetch = async () => new Response(JSON.stringify(body), { status: 200 });
      await assert.rejects(
        callProvider(configuration('openai'), INPUT, fetchStub),
        /reasoning but no final answer/,
      );
    }
  });

  it('prefers a refusal over reasoning metadata and ignores null reasoning fields', async () => {
    const refusal: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: null, refusal: 'I cannot help.', reasoning_content: 'thought' } }],
        }),
        { status: 200 },
      );
    await assert.rejects(callProvider(configuration('openai'), INPUT, refusal), /refused the request/);

    const empty: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: null, reasoning: null, reasoning_content: null } }],
        }),
        { status: 200 },
      );
    await assert.rejects(callProvider(configuration('openai'), INPUT, empty), /no answer text/);
  });
});

describe('readAiConfig', () => {
  it('stays disabled without a key and names the missing custom base URL', () => {
    assert.deepEqual(readAiConfig({}, 'openai'), {
      disabled: true,
      reason: 'CP_AI_KEY is empty. The report is complete without it.',
    });
    const custom = readAiConfig({ CP_AI_KEY: 'key', CP_AI_MODEL: 'model' }, 'custom');
    assert.equal(custom.disabled, true);
    if (custom.disabled) assert.match(custom.reason, /CP_AI_BASE_URL/);
  });

  it('does not apply a custom or OpenCode base URL to a different provider', () => {
    const result = readAiConfig(
      { CP_AI_KEY: 'key', CP_AI_MODEL: 'model', CP_AI_BASE_URL: 'https://other.example/v1' },
      'openai',
    );
    assert.equal(result.disabled, false);
    if (!result.disabled) assert.equal(result.config.baseUrl, 'https://api.openai.com/v1');
  });

  it('rejects plaintext remote HTTP but permits a loopback provider', () => {
    const remote = readAiConfig(
      { CP_AI_KEY: 'key', CP_AI_MODEL: 'model', CP_AI_BASE_URL: 'http://provider.example/v1' },
      'custom',
    );
    assert.equal(remote.disabled, true);
    const local = readAiConfig(
      { CP_AI_KEY: 'key', CP_AI_MODEL: 'model', CP_AI_BASE_URL: 'http://127.0.0.1:11434/v1' },
      'custom',
    );
    assert.equal(local.disabled, false);
  });

  it('rejects a non-http base URL rather than sending it a key', () => {
    const result = readAiConfig(
      { CP_AI_KEY: 'key', CP_AI_MODEL: 'model', CP_AI_BASE_URL: 'file:///tmp/key' },
      'custom',
    );
    assert.equal(result.disabled, true);
    if (result.disabled) assert.match(result.reason, /http(s)?/);
  });
});
