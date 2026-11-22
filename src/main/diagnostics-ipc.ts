// What: builds the support summary and places it on the clipboard.
// Why: the player can share one text block without sharing a session folder or a screenshot.
// Removed: a failure would have no safe, complete context to send.
import { app, clipboard } from 'electron';
import { diagnosticsResultSchema } from '../shared/contracts.js';
import { DIAGNOSTICS_LOG_LINES, buildDiagnostics } from './diagnostics.js';
import { registerInvokeChannel } from './ipc-registry.js';
import { readRecentLogLines } from './log.js';
import { defaultDataRoot } from './store.js';

export interface DiagnosticsOptions {
  /** S43 supplies the doctor result; the fallback keeps the bundle honest if it is unavailable. */
  doctorLines?: () => readonly string[] | Promise<readonly string[]>;
}

export function registerDiagnosticsHandler(
  dataRoot: () => string = defaultDataRoot,
  options: DiagnosticsOptions = {},
): void {
  registerInvokeChannel('diagnosticsCopy', async () => {
    const doctor = options.doctorLines ? await options.doctorLines() : ['Not run.'];
    const text = buildDiagnostics({
      appVersion: app.getVersion(),
      electron: process.versions.electron ?? 'unknown',
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      doctor,
      logLines: readRecentLogLines(dataRoot(), DIAGNOSTICS_LOG_LINES),
    });
    clipboard.writeText(text);
    return diagnosticsResultSchema.parse({ copied: true });
  });
}
