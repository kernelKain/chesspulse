import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AiProvider } from '../../shared/contracts.js';
import { readAiConfig } from './config.js';
import { callProvider, type AiConfiguration } from './providers.js';

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
      if (provider === 'custom') {
        assert.equal(body.max_tokens, 500);
        assert.equal(body.max_completion_tokens, undefined);
      } else if (provider === 'openai' || provider === 'opencode') {
        assert.equal(body.max_completion_tokens, 500);
        assert.equal(body.max_tokens, undefined);
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
});

describe('readAiConfig', () => {
  it('stays disabled without a key and names the missing custom base URL', () => {
    assert.deepEqual(readAiConfig({}, 'openai'), {
      disabled: true,
      reason: 'No AI key configured. Layers 1–3 are complete without it.',
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
