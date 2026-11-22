// What: turns named environment variables into one validated provider configuration.
// Why: missing configuration disables only Layer 4; malformed URLs must never receive a key.
// Removed: a renderer or provider call would have to guess which credential and endpoint to use.
import { aiProviderSchema, type AiProvider } from '../../shared/contracts.js';

export interface AiConfiguration {
  provider: AiProvider;
  key: string;
  model: string;
  baseUrl: string;
}

export type AiConfigState =
  | { disabled: true; reason: string }
  | { disabled: false; config: AiConfiguration };

const DEFAULT_BASE_URL: Record<Exclude<AiProvider, 'custom'>, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  google: 'https://generativelanguage.googleapis.com/v1beta/models',
  opencode: 'https://opencode.ai/inference/openai/v1',
};

export function readAiConfig(env: NodeJS.ProcessEnv, requested?: AiProvider): AiConfigState {
  let provider = requested;
  if (!provider) {
    const parsed = aiProviderSchema.safeParse(env.CP_AI_PROVIDER?.trim() || 'openai');
    if (!parsed.success) {
      return { disabled: true, reason: 'CP_AI_PROVIDER must be openai, anthropic, google, opencode, or custom.' };
    }
    provider = parsed.data;
  }

  const key = env.CP_AI_KEY?.trim() ?? '';
  if (!key) return { disabled: true, reason: 'CP_AI_KEY is empty. The report is complete without it.' };
  const model = env.CP_AI_MODEL?.trim() ?? '';
  if (!model) return { disabled: true, reason: 'CP_AI_MODEL is missing. The AI reading stays off; the report is complete.' };

  // Only providers with an approved custom-endpoint mode may redirect the key.
  const configuredBase = provider === 'custom' || provider === 'opencode' ? env.CP_AI_BASE_URL?.trim() ?? '' : '';
  const baseUrl = configuredBase || (provider === 'custom' ? '' : DEFAULT_BASE_URL[provider]);
  if (!baseUrl) {
    return { disabled: true, reason: 'CP_AI_BASE_URL is required for a custom provider. The AI reading stays off.' };
  }
  try {
    const url = new URL(baseUrl);
    const loopbackHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !loopbackHttp) || url.username || url.password || url.search || url.hash) {
      throw new Error('unsupported URL');
    }
    return {
      disabled: false,
      config: { provider, key, model, baseUrl: baseUrl.replace(/\/+$/, '') },
    };
  } catch {
    return { disabled: true, reason: 'CP_AI_BASE_URL must be an http or https URL without credentials, query, or fragment.' };
  }
}
