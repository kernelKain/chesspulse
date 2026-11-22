// What: exposes local report building, progress, and cancellation over IPC.
// Why: the engine and stored session files stay in main; the renderer receives only validated results.
// Removed: the Report screen could not request a real report, see progress, or stop one.
import {
  reportCancelResultSchema,
  reportProgressSchema,
  reportResultSchema,
} from '../shared/contracts.js';
import { EVENT_CHANNELS } from '../shared/channels.js';
import { AppError } from '../shared/errors.js';
import { registerInvokeChannel } from './ipc-registry.js';
import { buildReport } from './report.js';
import { withReportExclusion } from './report-lock.js';
import { defaultDataRoot } from './store.js';

interface ActiveBuild {
  controller: AbortController;
  /** Once true, the artifact commit has begun and a cancel request must not be acknowledged. */
  committing: boolean;
}

/** One active build per session. */
const activeBuilds = new Map<string, ActiveBuild>();

/** True while a report for this session is still owned by a build request. */
export function isReportBuilding(sessionId: string): boolean {
  return activeBuilds.has(sessionId);
}

export function registerReportHandler(dataRoot: () => string = defaultDataRoot): void {
  registerInvokeChannel('reportBuild', async (event, payload) => {
    const { sessionId, pgns } = payload;
    if (activeBuilds.has(sessionId)) throw new AppError('session_busy');
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
            if (message.success) event.sender.send(EVENT_CHANNELS.reportProgress, message.data);
          },
        }),
      );
      return reportResultSchema.parse(result);
    } finally {
      if (activeBuilds.get(sessionId) === build) activeBuilds.delete(sessionId);
    }
  });

  registerInvokeChannel('reportCancel', (_event, payload) => {
    const build = activeBuilds.get(payload.sessionId);
    if (!build) return reportCancelResultSchema.parse({ cancelled: false });
    // A commit already in progress is not cancellable; acknowledging it would lie about the artifact.
    if (build.committing) return reportCancelResultSchema.parse({ cancelled: false });
    build.controller.abort();
    return reportCancelResultSchema.parse({ cancelled: true });
  });
}
