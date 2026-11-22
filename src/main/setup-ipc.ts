// What: the doctor-backed readiness result Setup asks for once, before the camera opens.
// Why: the key row must match `npm run doctor` and the diagnostics bundle, not a second implementation.
// Removed: Setup would guess whether a key exists, and the CLI and page could disagree.
import { setupStatusSchema, type DoctorCheck } from '../shared/contracts.js';
import { runDoctor, type DoctorReport } from './doctor.js';
import type { EnvLoadResult } from './env.js';
import { registerInvokeChannel } from './ipc-registry.js';

export interface SetupHandlerOptions {
  env: NodeJS.ProcessEnv;
  envFile: EnvLoadResult;
  dataRoot: string;
  /** A test seam; production runs the same doctor as the CLI. */
  doctor?: () => Promise<DoctorReport>;
}

export function setupChecks(report: DoctorReport): DoctorCheck[] {
  return report.checks;
}

export function registerSetupHandler(options: SetupHandlerOptions): void {
  registerInvokeChannel('setupStatus', async () => {
    const report = await (options.doctor
      ? options.doctor()
      : runDoctor({
          env: options.env,
          envFile: options.envFile,
          dataRoot: options.dataRoot,
          // The live preview, not device enumeration, is Setup's camera check.
          cameraCheck: () => ({
            id: 'camera',
            label: 'Camera',
            status: 'skip',
            detail: 'Setup checks the live camera preview.',
          }),
        }));
    return setupStatusSchema.parse({ checks: setupChecks(report) });
  });
}
