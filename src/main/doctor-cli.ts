// What: `npm run doctor` — prints the readiness checks a player or a support thread needs.
// Why: the same checks feed Setup and the diagnostics bundle, so the terminal cannot disagree.
// Removed: a broken install would be discovered only after a session.
import path from 'node:path';
import { runDoctor } from './doctor.js';
import { loadEnvFile } from './env.js';
import { defaultDataRoot } from './store.js';

export async function main(): Promise<number> {
  const envFile = process.env.CHESSPULSE_ENV_FILE ?? path.join(process.cwd(), '.env');
  const loaded = loadEnvFile(envFile, process.env);
  const report = await runDoctor({
    env: process.env,
    envFile: loaded,
    dataRoot: defaultDataRoot(),
  });
  process.stdout.write(`${report.lines.join('\n')}\n`);
  return report.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : 'The doctor could not run.';
      process.stderr.write(`${message}\n`);
      process.exit(1);
    },
  );
}
