// What: session deletion and report export over IPC.
// Why: the player owns the data folder, and a shared report must not carry the pulse trace.
// Removed: there would be no in-app way to remove a session or hand a report to someone.
import { dialog } from 'electron';
import {
  reportExportResultSchema,
  sessionDeleteResultSchema,
  sessionListResultSchema,
  sessionOpenResultSchema,
} from '../shared/contracts.js';
import { AppError, toAppError } from '../shared/errors.js';
import { registerInvokeChannel } from './ipc-registry.js';
import { isReportBuilding } from './report-ipc.js';
import { reportAppError } from './report-errors.js';
import { withReportExclusion } from './report-lock.js';
import { exportResult, writeReportExport } from './report-export.js';
import { activeSessionState } from './session.js';
import { listSessionSummaries, openStoredSession } from './session-library.js';
import { defaultDataRoot, deleteSession, digestGames, readGames, readReport } from './store.js';

export function registerLibraryHandler(dataRoot: () => string = defaultDataRoot): void {
  registerInvokeChannel('sessionsList', async () =>
    sessionListResultSchema.parse(await listSessionSummaries(dataRoot())),
  );

  registerInvokeChannel('sessionOpen', async (_event, payload) =>
    sessionOpenResultSchema.parse(await openStoredSession(dataRoot(), payload.sessionId)),
  );

  registerInvokeChannel('sessionDelete', async (_event, payload) => {
    if (activeSessionState(dataRoot()).sessionId === payload.sessionId) {
      throw new AppError('session_busy');
    }
    if (isReportBuilding(payload.sessionId)) throw new AppError('session_busy');
    // The exclusion closes the race with a build that starts after the check: either the build
    // finishes first and is deleted, or it waits and then finds the session missing.
    const deleted = await withReportExclusion(() => deleteSession(dataRoot(), payload.sessionId));
    return sessionDeleteResultSchema.parse({ deleted });
  });

  registerInvokeChannel('reportExport', async (_event, payload) => {
    const report = await withReportExclusion(async () => {
      const current = await readReport(dataRoot(), payload.sessionId);
      const games = await readGames(dataRoot(), payload.sessionId).catch(() => null);
      if (games !== null && digestGames(games) !== current.gamesDigest) {
        throw new AppError('report_stale');
      }
      return current;
    }).catch((error: unknown) => {
      throw reportAppError(error);
    });
    const choice = await dialog.showSaveDialog({
      title: 'Export report',
      defaultPath: `chesspulse-report-${payload.sessionId}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
      message: 'The export contains no pulse samples.',
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (choice.canceled || !choice.filePath) {
      return reportExportResultSchema.parse(exportResult(undefined));
    }
    try {
      await writeReportExport(report, choice.filePath);
    } catch (error) {
      throw toAppError(error, 'storage_failed');
    }
    return reportExportResultSchema.parse(exportResult(choice.filePath));
  });
}

