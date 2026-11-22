// What: serves optional AI readings from the stored report and original PGNs.
// Why: the renderer never supplies grounding statistics, and one session has at most one active call.
// Removed: a stale or forged renderer payload could reach a provider without cancellation or an audit id.
import { randomUUID } from 'node:crypto';
import { insightResultSchema } from '../shared/contracts.js';
import { AppError, toAppError } from '../shared/errors.js';
import { requestInsight } from './ai/service.js';
import { AiProviderError } from './ai/providers.js';
import { GroundingError } from './ai/grounding.js';
import { registerInvokeChannel } from './ipc-registry.js';
import { log, logError } from './log.js';
import { reportAppError } from './report-errors.js';
import { withReportExclusion } from './report-lock.js';
import { defaultDataRoot, readGames, readReport } from './store.js';

export function registerInsightHandler(dataRoot: () => string = defaultDataRoot, env: NodeJS.ProcessEnv = process.env): void {
  const active = new Map<string, AbortController>();
  // One random id per report for this app run. OpenCode Go routes a conversation by it; a session
  // folder name would tell the provider when the session was recorded, so it is never sent.
  const conversations = new Map<string, string>();
  const conversationFor = (sessionId: string): string => {
    const known = conversations.get(sessionId);
    if (known) return known;
    const created = randomUUID();
    conversations.set(sessionId, created);
    return created;
  };

  registerInvokeChannel('insightRequest', async (_event, payload) => {
    if (active.has(payload.sessionId)) throw new AppError('session_busy');
    const requestId = randomUUID();
    const controller = new AbortController();
    active.set(payload.sessionId, controller);
    try {
      const artifacts = await readArtifacts(dataRoot(), payload.sessionId, controller.signal).catch(
        (error: unknown) => {
          throw reportAppError(error);
        },
      );
      // Provider and grounding failures carry their own meaning; anything else is a report fault.
      const result = insightResultSchema.parse(
        await requestInsight(payload, artifacts.report, artifacts.pgns, env, {
          signal: controller.signal,
          conversationId: conversationFor(payload.sessionId),
        }).catch(
          (error: unknown) => {
            if (error instanceof AppError) throw error;
            if (error instanceof AiProviderError) throw new AppError(error.code, { cause: error });
            if (error instanceof GroundingError) throw new AppError('ai_ungrounded', { cause: error });
            throw toAppError(error, 'report_failed');
          },
        ),
      );
      log(`[chesspulse] AI reading ${requestId} ${result.disabled ? 'disabled' : 'ready'}`);
      return result;
    } catch (error) {
      logError(`[chesspulse] AI reading ${requestId} failed: ${describeFailure(error)}`);
      throw error;
    } finally {
      if (active.get(payload.sessionId) === controller) active.delete(payload.sessionId);
    }
  });

  registerInvokeChannel('insightCancel', (_event, payload) => {
    const controller = active.get(payload.sessionId);
    controller?.abort();
    return { cancelled: controller !== undefined };
  });
}

/** The code and the provider's safe diagnostic (status and error type), never a body or a key. */
function describeFailure(error: unknown): string {
  if (error instanceof AppError) {
    const cause = error.cause;
    const diagnostic = cause instanceof AiProviderError && cause.diagnostic ? ` (${cause.diagnostic})` : '';
    return `${error.code}${diagnostic}`;
  }
  return error instanceof Error ? error.message : 'unknown error';
}

function readArtifacts(
  root: string,
  sessionId: string,
  signal: AbortSignal,
): Promise<{ report: Awaited<ReturnType<typeof readReport>>; pgns: string[] }> {
  return withReportExclusion(async () => ({
    report: await readReport(root, sessionId),
    pgns: await readGames(root, sessionId),
  }), signal);
}
