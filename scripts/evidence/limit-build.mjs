// What: builds a throwaway copy of the current working tree with a short session limit.
// Why: H-31 needs a real automatic limit stop, but waiting 90 minutes is not a test. The copy never
//      edits the repository, reuses `node_modules`, and keeps its data in a separate folder.
// Removed: the limit test would require hand-editing three source files and remembering to undo it.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      options[key] = true;
    } else {
      options[key] = next;
      index += 1;
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const minutes = Number(options.minutes ?? 2);
const buildDir = path.resolve(options.out ?? path.join(ROOT, 'docs', 'evidence', 'limit-build'));
const dataDir = `${buildDir}-data`;
const rootInsideBuild = path.relative(buildDir, ROOT);
const buildContainsRepository =
  rootInsideBuild === '' || (!rootInsideBuild.startsWith('..') && !path.isAbsolute(rootInsideBuild));
if (buildContainsRepository) {
  console.error(`Refusing to use ${buildDir}: it is the repository or one of its parents.`);
  process.exit(1);
}

if (options.clean) {
  rmSync(buildDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
  console.log(`Removed ${buildDir} and ${dataDir}.`);
  process.exit(0);
}

if (!Number.isInteger(minutes) || minutes < 2 || minutes > 10) {
  console.error('Pass --minutes between 2 and 10.');
  process.exit(1);
}

function replaceExactly(file, before, after) {
  const full = path.join(buildDir, file);
  const text = readFileSync(full, 'utf8');
  if (text.split(before).length - 1 !== 1) {
    throw new Error(`Expected one occurrence in ${file}: ${before}`);
  }
  writeFileSync(full, text.replace(before, after));
}

rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT })
  .toString()
  .split('\0')
  .filter(Boolean);
for (const file of tracked) {
  const source = path.join(ROOT, file);
  // `git ls-files` includes staged deletions; a copy of the working tree must skip them.
  if (!existsSync(source)) continue;
  const target = path.join(buildDir, file);
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(source, target);
}
symlinkSync(path.join(ROOT, 'node_modules'), path.join(buildDir, 'node_modules'), 'dir');

const warningMinutes = Math.max(1, minutes - 1);
replaceExactly(
  'src/main/session.ts',
  'export const MAX_SESSION_US = 90 * 60 * 1_000_000;',
  `export const MAX_SESSION_US = ${minutes} * 60 * 1_000_000;`,
);
replaceExactly(
  'src/shared/sensing.ts',
  'export const SESSION_WARNING_MS = 80 * 60 * 1_000;',
  `export const SESSION_WARNING_MS = ${warningMinutes} * 60 * 1_000;`,
);
replaceExactly(
  'src/shared/sensing.ts',
  'export const SESSION_LIMIT_MS = 90 * 60 * 1_000;',
  `export const SESSION_LIMIT_MS = ${minutes} * 60 * 1_000;`,
);
replaceExactly(
  'src/shared/sensing.ts',
  "'The 90-minute limit is reached. ChessPulse is stopping the session.'",
  `'The ${minutes}-minute test limit is reached. ChessPulse is stopping the session.'`,
);
replaceExactly(
  'src/shared/sensing.ts',
  'left before the 90-minute limit.',
  `left before the ${minutes}-minute test limit.`,
);
replaceExactly(
  'src/main/session-stop.ts',
  'Sensing stopped at the 90-minute limit. The session was closed.',
  `Sensing stopped at the ${minutes}-minute test limit. The session was closed.`,
);

execFileSync('npm', ['run', 'build'], { cwd: buildDir, stdio: 'inherit' });

const envFile = path.join(ROOT, '.env');
console.log('');
console.log(`Short-limit build ready in ${buildDir} (${minutes} minutes, warning at ${warningMinutes}).`);
console.log('Launch it with a separate data folder:');
console.log('');
console.log(
  `  CHESSPULSE_ENV_FILE=${JSON.stringify(envFile)} \\\n` +
    `  XDG_DATA_HOME=${JSON.stringify(path.join(dataDir, 'data'))} \\\n` +
    `  XDG_CONFIG_HOME=${JSON.stringify(path.join(dataDir, 'config'))} \\\n` +
    `  ${JSON.stringify(path.join(buildDir, 'node_modules', '.bin', 'electron'))} ${JSON.stringify(buildDir)}`,
);
console.log('');
console.log('After the run:');
console.log(`  node scripts/evidence/collect.mjs --session <id> --data-root ${JSON.stringify(path.join(dataDir, 'data', 'chesspulse'))} --expect-limit --limit-minutes ${minutes} --label limit`);
console.log(`  node scripts/evidence/limit-build.mjs --clean --out ${JSON.stringify(buildDir)}`);
