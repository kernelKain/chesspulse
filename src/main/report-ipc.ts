// What: exposes local report building over IPC (`cp:report:build`) with strict schema checks.
// Why: the engine and stored session files stay in main; the renderer receives only validated results.
// Removed: the Report screen could not request a real report or refusal from a stored session.
import { ipcMain } from 'electron';
import { reportBuildRequestSchema, reportResultSchema } from '../shared/contracts.js';
import { buildReport } from './report.js';
import { defaultDataRoot } from './store.js';

export const REPORT_BUILD_CHANNEL = 'cp:report:build';

export function registerReportHandler(dataRoot: () => string = defaultDataRoot): void {
  ipcMain.handle(REPORT_BUILD_CHANNEL, async (_event, payload: unknown) => {
    const parsed = reportBuildRequestSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error('Choose a valid session and up to 20 PGNs under 2 MB.');
    }
    const result = await buildReport(dataRoot(), parsed.data.sessionId, parsed.data.pgns);
    return reportResultSchema.parse(result);
  });
}
