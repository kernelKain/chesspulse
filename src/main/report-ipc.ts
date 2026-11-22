// What: exposes local report building, progress, and cancellation over IPC.
// Why: the engine and stored session files stay in main; the renderer receives only validated results.
// Removed: the Report screen could not request a real report, see progress, or stop one.
import { ipcMain } from 'electron';
import {
  reportBuildRequestSchema,
  reportCancelRequestSchema,
  reportCancelResultSchema,
  reportProgressSchema,
  reportResultSchema,
} from '../shared/contracts.js';
import { buildReport } from './report.js';
import { withReportExclusion } from './report-lock.js';
import { defaultDataRoot } from './store.js';

export const REPORT_BUILD_CHANNEL = 'cp:report:build';
export const REPORT_PROGRESS_CHANNEL = 'cp:report:progress';
export const REPORT_CANCEL_CHANNEL = 'cp:report:cancel';

/** One active build per session; a second build for the same session replaces the handle. */
const activeBuilds = new Map<string, AbortController>();

export function registerReportHandler(dataRoot: () => string = defaultDataRoot): void {
  ipcMain.handle(REPORT_BUILD_CHANNEL, async (event, payload: unknown) => {
    const parsed = reportBuildRequestSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error('Choose a valid session and up to 20 PGNs under 2 MB.');
    }
    const { sessionId, pgns } = parsed.data;
    const controller = new AbortController();
    activeBuilds.set(sessionId, controller);
    try {
      // Shared exclusion also covers insight artifact reads; only one Stockfish build runs at once.
      const result = await withReportExclusion(() =>
        buildReport(dataRoot(), sessionId, pgns, undefined, {
          signal: controller.signal,
          onProgress: (progress) => {
            if (event.sender.isDestroyed()) return;
            const message = reportProgressSchema.safeParse({ sessionId, ...progress });
            if (message.success) event.sender.send(REPORT_PROGRESS_CHANNEL, message.data);
          },
        }),
      );
      return reportResultSchema.parse(result);
    } finally {
      if (activeBuilds.get(sessionId) === controller) activeBuilds.delete(sessionId);
    }
  });

  ipcMain.handle(REPORT_CANCEL_CHANNEL, (_event, payload: unknown) => {
    const parsed = reportCancelRequestSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error('Choose a session to cancel.');
    }
    const controller = activeBuilds.get(parsed.data.sessionId);
    if (!controller) return reportCancelResultSchema.parse({ cancelled: false });
    controller.abort();
    return reportCancelResultSchema.parse({ cancelled: true });
  });
}
