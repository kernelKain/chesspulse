// What: serves optional AI readings from the stored report and original PGNs.
// Why: the renderer never supplies grounding statistics, and one session has at most one active call.
// Removed: a stale or forged renderer payload could reach a provider without cancellation or an audit id.
import { randomUUID } from 'node:crypto';
import { ipcMain } from 'electron';
import {
  insightCancelRequestSchema,
  insightRequestSchema,
  insightResultSchema,
} from '../shared/contracts.js';
import { requestInsight } from './ai/service.js';
import { log, logError } from './log.js';
import { defaultDataRoot, readGames, readReport } from './store.js';

export const INSIGHT_REQUEST_CHANNEL = 'cp:insight:request';
export const INSIGHT_CANCEL_CHANNEL = 'cp:insight:cancel';

export function registerInsightHandler(dataRoot: () => string = defaultDataRoot, env: NodeJS.ProcessEnv = process.env): void {
  const active = new Map<string, AbortController>();

  ipcMain.handle(INSIGHT_REQUEST_CHANNEL, async (_event, payload: unknown) => {
    const parsed = insightRequestSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Choose a session, provider, and question under 4 KB.');
    if (active.has(parsed.data.sessionId)) throw new Error('An AI reading is already running for this session.');
    const requestId = randomUUID();
    const controller = new AbortController();
    active.set(parsed.data.sessionId, controller);
    try {
      const report = await readReport(dataRoot(), parsed.data.sessionId);
      const pgns = await readGames(dataRoot(), parsed.data.sessionId);
      const result = insightResultSchema.parse(
        await requestInsight(parsed.data, report, pgns, env, { signal: controller.signal }),
      );
      log(`[chesspulse] AI reading ${requestId} ${result.disabled ? 'disabled' : 'ready'}`);
      return result;
    } catch (error) {
      logError(`[chesspulse] AI reading ${requestId} failed`);
      throw error;
    } finally {
      if (active.get(parsed.data.sessionId) === controller) active.delete(parsed.data.sessionId);
    }
  });

  ipcMain.handle(INSIGHT_CANCEL_CHANNEL, (_event, payload: unknown) => {
    const parsed = insightCancelRequestSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Choose a session to cancel.');
    const controller = active.get(parsed.data.sessionId);
    controller?.abort();
    return { cancelled: controller !== undefined };
  });
}
