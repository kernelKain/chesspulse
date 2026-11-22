// What: session deletion and report export over IPC.
// Why: the player owns the data folder, and a shared report must not carry the pulse trace.
// Removed: there would be no in-app way to remove a session or hand a report to someone.
import { dialog } from 'electron';
import {
  reportExportResultSchema,
  sessionDeleteResultSchema,
} from '../shared/contracts.js';
import { toAppError } from '../shared/errors.js';
import { registerInvokeChannel } from './ipc-registry.js';
import { reportAppError } from './report-errors.js';
import { exportResult, writeReportExport } from './report-export.js';
import { defaultDataRoot, deleteSession, readReport } from './store.js';

export function registerLibraryHandler(dataRoot: () => string = defaultDataRoot): void {
  registerInvokeChannel('sessionDelete', async (_event, payload) => {
    const deleted = await deleteSession(dataRoot(), payload.sessionId);
    return sessionDeleteResultSchema.parse({ deleted });
  });

  registerInvokeChannel('reportExport', async (_event, payload) => {
    const report = await readReport(dataRoot(), payload.sessionId).catch((error: unknown) => {
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

