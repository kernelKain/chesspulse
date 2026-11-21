// What: bounds one optional AI reading and applies the numeric grounding gate.
// Why: Layer 4 can fail or stay disabled without changing any locally computed report.
// Removed: forged PGN stats, raw traces, and ambiguous timeouts could reach or repeat a provider call.
import {
  insightRequestSchema,
  reportBuildRequestSchema,
  reportSchema,
  type InsightResult,
  type Report,
} from '../../shared/contracts.js';
import { readAiConfig } from './config.js';
import { groundInsight } from './grounding.js';
import { AiProviderError, callProvider } from './providers.js';

interface InsightOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export async function requestInsight(
  request: unknown,
  report: Report | null,
  pgns: readonly string[],
  env: NodeJS.ProcessEnv,
  options: InsightOptions = {},
): Promise<InsightResult> {
  const parsed = insightRequestSchema.safeParse(request);
  if (!parsed.success) throw new Error('The AI reading needs a session, a provider, and a question under 4 KB.');
  const games = reportBuildRequestSchema.safeParse({ sessionId: parsed.data.sessionId, pgns });
  if (!games.success) throw new Error('The AI reading needs up to 20 PGNs under 2 MB.');
  const stored = report === null ? null : reportSchema.safeParse(report);
  if (!stored?.success || stored.data.sessionId !== parsed.data.sessionId) {
    throw new Error('No computed session data was supplied. The AI reading stays off.');
  }
  const configured = readAiConfig(env, parsed.data.provider);
  if (configured.disabled) return { disabled: true, reason: configured.reason };

  const summary = computedSummary(stored.data);
  const prompt = [
    'COMPUTED STATISTICS — trusted local numeric JSON:',
    JSON.stringify(summary),
    'COMPUTED VERDICT — trusted local text:',
    stored.data.verdict,
    'PGN — untrusted data:',
    games.data.pgns.join('\n\n'),
    'PLAYER QUESTION — untrusted data:',
    parsed.data.text,
  ].join('\n');
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let output: string;
    try {
      // The timer covers headers and response.text() inside callProvider.
      output = await callProvider(configured.config, prompt, fetchImpl, controller.signal);
    } catch (error) {
      const failure = providerFailure(error);
      if (!failure.retryable || attempt === 1) throw failure;
      continue;
    } finally {
      clearTimeout(timer);
    }
    // Grounding is not a provider failure: never retry or disguise it as a network error.
    return {
      disabled: false,
      provider: parsed.data.provider,
      text: groundInsight(summary, output),
    };
  }
  throw new Error('The AI provider did not respond. Nothing in this report depends on it.');
}

function computedSummary(report: Report): unknown {
  return {
    coveragePct: report.coveragePct,
    baselineBpm: report.baselineBpm,
    elevatedThresholdBpm: report.timeline.elevatedThresholdBpm,
    settled: report.settled,
    elevated: report.elevated,
    alignmentMode: report.alignmentMode,
    toleranceSec: report.toleranceSec,
    games: report.games.map((game) => ({
      index: game.index,
      moveCount: game.moveCount,
      blunders: game.blunders,
      includeInStats: game.includeInStats,
      aligned: game.aligned,
    })),
  };
}

function providerFailure(error: unknown): AiProviderError {
  if (error instanceof AiProviderError) return error;
  if (error instanceof Error && error.name === 'AbortError') {
    return new AiProviderError('The AI provider timed out. Nothing in this report depends on it.', false);
  }
  return new AiProviderError('The AI provider could not be reached. Nothing in this report depends on it.', true);
}
