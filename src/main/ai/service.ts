// What: bounds one optional AI reading and applies the numeric grounding gate.
// Why: Layer 4 can fail or stay disabled without changing any locally computed report.
// Removed: forged PGN stats, raw traces, and ambiguous timeouts could reach or repeat a provider call.
import {
  insightRequestSchema,
  reportBuildRequestSchema,
  reportSchema,
  type InsightResult,
  type Report,
  type InsightConfig,
} from '../../shared/contracts.js';
import { reportTotals } from '../../shared/summary.js';
import { digestGames } from '../store.js';
import { gameQuality } from '../../shared/quality.js';
import { readAiConfig } from './config.js';
import { groundInsight } from './grounding.js';
import { AiProviderError, callProvider } from './providers.js';

interface InsightOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Opaque and stable for one report's questions; never the session folder name. */
  conversationId?: string;
}

/** What the panel may show about the configuration: provider and model, or why it is off. Never the key. */
export function insightConfigView(env: NodeJS.ProcessEnv): InsightConfig {
  const state = readAiConfig(env);
  if (state.disabled) return { configured: false, reason: state.reason };
  return { configured: true, provider: state.config.provider, model: state.config.model.slice(0, 120) };
}

export async function requestInsight(
  request: unknown,
  report: Report | null,
  pgns: readonly string[],
  env: NodeJS.ProcessEnv,
  options: InsightOptions = {},
): Promise<InsightResult> {
  const parsed = insightRequestSchema.safeParse(request);
  if (!parsed.success) throw new Error('The AI reading needs a session and a question under 4 KB.');
  const games = reportBuildRequestSchema.safeParse({ sessionId: parsed.data.sessionId, pgns });
  if (!games.success) throw new Error('The AI reading needs up to 20 PGNs under 2 MB.');
  if (report === null) throw new Error('No computed session data was supplied. The AI reading stays off.');
  const stored = reportSchema.safeParse(report);
  if (
    !stored.success
    || stored.data.sessionId !== parsed.data.sessionId
    || stored.data.gamesDigest !== digestGames(games.data.pgns)
  ) {
    throw new Error('The stored report and PGNs are stale or mismatched. Build the report again before requesting AI.');
  }
  // .env is the only source of the provider; the page cannot choose or override it.
  const configured = readAiConfig(env);
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
    const cancel = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    options.signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let output: string;
    try {
      if (options.signal?.aborted) throw new Error('cancelled');
      // The timer covers headers and response.text() inside callProvider.
      output = await callProvider(configured.config, prompt, fetchImpl, controller.signal, {
        ...(options.conversationId ? { conversationId: options.conversationId } : {}),
      });
    } catch (error) {
      const failure = options.signal?.aborted
        ? new AiProviderError('The AI reading was cancelled. Nothing in this report depends on it.', false, 'ai_cancelled')
        : providerFailure(error);
      if (!failure.retryable || attempt === 1) throw failure;
      continue;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
    }
    // Grounding is not a provider failure: never retry or disguise it as a network error.
    return {
      disabled: false,
      provider: configured.config.provider,
      // The player's name is grounded as a name: its digits are not report quantities.
      text: groundInsight(summary, output, stored.data.playerScope?.kind === 'player' ? [stored.data.playerScope.name] : []),
    };
  }
  throw new AiProviderError('The AI provider did not respond. Nothing in this report depends on it.', true, 'ai_unavailable');
}

/**
 * What: the numbers the model may cite, all computed locally and none taken from PGN text.
 * Why: the verdict states session totals ("14 blunders"); a live reading that repeated one was
 *      withheld because only per-game counts were listed. Totals and public game numbers fix that.
 * Removed: a correct reading that quoted the verdict's own total would be refused as ungrounded.
 */
export function computedSummary(report: Report): unknown {
  return {
    // Rounded as the report header prints them, so the model can only quote what the page shows.
    coveragePct: Math.round(report.coveragePct),
    baselineBpm: oneDecimal(report.baselineBpm),
    elevatedThresholdBpm: oneDecimal(report.timeline.elevatedThresholdBpm),
    settled: report.settled,
    elevated: report.elevated,
    alignmentMode: report.alignmentMode,
    toleranceSec: report.toleranceSec,
    totals: reportTotals(report),
    ...(report.longestGap
      ? {
          longestGap: {
            afterGameNumber: report.longestGap.afterIndex + 1,
            beforeGameNumber: report.longestGap.beforeIndex + 1,
            durationSec: report.longestGap.durationSec,
          },
        }
      : {}),
    ...(report.playerScope ? { playerScope: report.playerScope } : {}),
    engine: { name: report.engine.name ?? 'Stockfish', depth: report.engine.depth },
    games: report.games.map((game) => {
      // The same view Move Quality draws, so the model cites the labels the player sees.
      const view = gameQuality(report, game.index);
      return {
        gameNumber: game.index + 1,
        index: game.index,
        ending: game.ending,
        ...(game.playerSide ? { playerSide: game.playerSide } : {}),
        moveCount: game.moveCount,
        blunders: game.blunders,
        includeInStats: game.includeInStats,
        aligned: game.aligned,
        ...(game.summary ? { summary: game.summary } : {}),
        ...(view?.kind === 'ok'
          ? {
              ...(view.span ? { sessionSpan: view.span } : {}),
              largestLosses: view.losses.map((loss) => ({
                move: loss.label,
                moveNumber: Math.floor(loss.moveIndex / 2) + 1,
                cpl: loss.cpl,
                blunder: loss.blunder,
              })),
            }
          : {}),
      };
    }),
  };
}


/** One decimal place, as `formatNumber` in shared/summary.ts shows bpm. */
function oneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

function providerFailure(error: unknown): AiProviderError {
  if (error instanceof AiProviderError) return error;
  if (error instanceof Error && error.name === 'AbortError') {
    return new AiProviderError('The AI provider timed out. Nothing in this report depends on it.', false, 'ai_unavailable');
  }
  return new AiProviderError('The AI provider could not be reached. Nothing in this report depends on it.', true, 'ai_unavailable');
}
