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

interface ActiveBuild {
  controller: AbortController;
  /** Once true, the artifact commit has begun and a cancel request must not be acknowledged. */
  committing: boolean;
}

/** One active build per session. */
const activeBuilds = new Map<string, ActiveBuild>();

export function registerReportHandler(dataRoot: () => string = defaultDataRoot): void {
  ipcMain.handle(REPORT_BUILD_CHANNEL, async (event, payload: unknown) => {
    const parsed = reportBuildRequestSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error('Choose a valid session and up to 20 PGNs under 2 MB.');
    }
    const { sessionId, pgns } = parsed.data;
    if (activeBuilds.has(sessionId)) {
      throw new Error('A report build is already running for this session.');
    }
    const build: ActiveBuild = { controller: new AbortController(), committing: false };
    activeBuilds.set(sessionId, build);
    try {
      // Shared exclusion also covers insight artifact reads; only one Stockfish build runs at once.
      const result = await withReportExclusion(() =>
        buildReport(dataRoot(), sessionId, pgns, undefined, {
          signal: build.controller.signal,
          onCommitStart: () => {
            build.committing = true;
          },
          onProgress: (progress) => {
            if (event.sender.isDestroyed()) return;
            const message = reportProgressSchema.safeParse({ sessionId, ...progress });
            if (message.success) event.sender.send(REPORT_PROGRESS_CHANNEL, message.data);
          },
        }),
      );
      return reportResultSchema.parse(result);
    } finally {
      if (activeBuilds.get(sessionId) === build) activeBuilds.delete(sessionId);
    }
  });

  ipcMain.handle(REPORT_CANCEL_CHANNEL, (_event, payload: unknown) => {
    const parsed = reportCancelRequestSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error('Choose a session to cancel.');
    }
    const build = activeBuilds.get(parsed.data.sessionId);
    if (!build) return reportCancelResultSchema.parse({ cancelled: false });
    // A commit already in progress is not cancellable; acknowledging it would lie about the artifact.
    if (build.committing) return reportCancelResultSchema.parse({ cancelled: false });
    build.controller.abort();
    return reportCancelResultSchema.parse({ cancelled: true });
  });
}
