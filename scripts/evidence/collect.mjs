// What: collects the evidence around a real run without copying pulse samples, PGNs, or secrets.
// Why: H-31 needs a dated, reproducible record of coverage, stop reason, and report presence, and
//      the raw files contain personal data that should not travel with a screenshot folder.
// Removed: "it worked" would have no artifact, and the easy alternative is copying the whole
//          session folder into `docs/`.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
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

function run(command, args, options = {}) {
  try {
    return {
      ok: true,
      text: execFileSync(command, args, {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        ...options,
      }).trim(),
    };
  } catch (error) {
    return { ok: false, text: `${error.stdout ?? ''}${error.stderr ?? ''}`.trim() };
  }
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function defaultDataRoot() {
  const base = process.env.XDG_DATA_HOME
    ? process.env.XDG_DATA_HOME
    : path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'chesspulse');
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function sessionSummary(root, id) {
  const directory = path.join(root, 'sessions', id);
  if (!existsSync(directory)) throw new Error(`Session ${id} is not in ${directory}.`);
  const meta = readJson(path.join(directory, 'meta.json'));
  const reportFile = path.join(directory, 'report.json');
  const report = existsSync(reportFile) ? readJson(reportFile) : null;
  const durationMs =
    meta.stopAnchor?.epochMs !== undefined
      ? meta.stopAnchor.epochMs - meta.startedAtEpochMs
      : null;
  return {
    id,
    startedAt: new Date(meta.startedAtEpochMs).toISOString(),
    durationMs,
    coveragePct: meta.coverage?.pct ?? null,
    baselineBpm: meta.baselineBpm ?? null,
    stopReason: meta.stopReason ?? null,
    files: {
      samples: existsSync(path.join(directory, 'samples.ndjson')),
      games: existsSync(path.join(directory, 'games.json')),
      report: report !== null,
    },
    report: report
      ? {
          ok: report.ok,
          verdict: report.verdict ?? null,
          coveragePct: report.coveragePct ?? null,
          alignmentMode: report.alignmentMode ?? null,
          toleranceSec: report.toleranceSec ?? null,
          games: Array.isArray(report.games) ? report.games.length : null,
          engine: report.engine ?? null,
        }
      : null,
  };
}

function check(summary, options) {
  const results = [];
  if (options.expectedCoverage !== undefined) {
    const wanted = options.expectedCoverage;
    const actual = summary.coveragePct;
    results.push({
      check: `coverage >= ${wanted}%`,
      status: actual !== null && actual >= wanted ? 'PASS' : 'FAIL',
      detail: actual === null ? 'No coverage recorded.' : `${actual.toFixed(2)}% recorded.`,
    });
    results.push({
      check: 'report saved and valid',
      status: summary.report?.ok === true ? 'PASS' : 'FAIL',
      detail: summary.report ? `report.ok=${summary.report.ok}` : 'No report.json.',
    });
  }
  if (options['expect-limit']) {
    results.push({
      check: 'automatic limit stop',
      status: summary.stopReason === 'limit' ? 'PASS' : 'FAIL',
      detail: `stopReason=${summary.stopReason ?? 'none'}`,
    });
    const minMs = Math.max(60_000, limitMinutes * 60_000 * 0.5);
    const maxMs = limitMinutes * 60_000 + 120_000;
    const inWindow =
      summary.durationMs !== null && summary.durationMs >= minMs && summary.durationMs <= maxMs;
    results.push({
      check: `stopped inside the ${Math.round(minMs / 60_000)}–${Math.round(maxMs / 60_000)} minute test window`,
      status: inWindow ? 'PASS' : 'FAIL',
      detail: summary.durationMs === null ? 'No duration.' : `${Math.round(summary.durationMs / 1000)}s.`,
    });
  }
  return results;
}

function writeRunsheet(directory, stamp, label) {
  const lines = [
    `# Evidence run ${stamp}`,
    '',
    `Label: ${label ?? 'unlabelled'}`,
    '',
    'Screenshots to add beside this file (no video, no camera frames):',
    '',
    '- `01-review.png` — verdict, timeline, bands, and games from the real report.',
    '- `02-ai-reading.png` — the optional `INFERRED` panel, if used.',
    '- `03-limit-warning.png` — the short-limit build warning.',
    '- `04-limit-stopped.png` — the automatic stop message.',
    '- `05-appimage-clean.png` — the packaged app on the clean profile/machine.',
    '',
    'Do not add: `samples.ndjson`, `games.json`, `report.json`, `.env`, or anything containing a key.',
    '',
  ];
  writeFileSync(path.join(directory, 'RUNSHEET.md'), lines.join('\n'));
}

const options = parseArgs(process.argv.slice(2));

function fail(message) {
  console.error(message);
  process.exit(1);
}

const hasCoverageExpectation = options['expect-coverage'] !== undefined;
const hasLimitExpectation = options['expect-limit'] === true;
if ((hasCoverageExpectation || hasLimitExpectation) && !options.session) {
  fail('An expectation flag needs --session <id>. Metadata-only collection is available without one.');
}
let expectedCoverage;
if (hasCoverageExpectation) {
  if (options['expect-coverage'] === true) {
    fail('--expect-coverage needs an explicit number, for example 70.');
  }
  expectedCoverage = Number(options['expect-coverage']);
  if (!Number.isFinite(expectedCoverage) || expectedCoverage <= 0 || expectedCoverage > 100) {
    fail('--expect-coverage must be a finite number between 0 and 100.');
  }
}
const limitMinutes = Number(options['limit-minutes'] ?? 2);
if (!Number.isInteger(limitMinutes) || limitMinutes < 1 || limitMinutes > 90) {
  fail('--limit-minutes must be a whole number between 1 and 90.');
}
options.expectedCoverage = expectedCoverage;
options.limitMinutes = limitMinutes;

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const directory = path.resolve(
  options.out ?? path.join(ROOT, 'docs', 'evidence', `${stamp}${options.label ? `-${options.label}` : ''}`),
);
mkdirSync(directory, { recursive: true });

const head = run('git', ['rev-parse', 'HEAD']);
const status = run('git', ['status', '--porcelain']);
const electron = existsSync(path.join(ROOT, 'node_modules', 'electron', 'package.json'))
  ? readJson(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version
  : 'not installed';
const appVersion = readJson(path.join(ROOT, 'package.json')).version;
const appImages = existsSync(path.join(ROOT, 'release'))
  ? readdirSync(path.join(ROOT, 'release')).filter((name) => name.endsWith('.AppImage'))
  : [];

const environment = [
  `Collected: ${new Date().toISOString()}`,
  `Git: ${head.text || 'unknown'} (${status.text ? 'working tree has changes' : 'clean'})`,
  `App version: ${appVersion}`,
  `Node: ${process.version}`,
  `Electron: ${electron}`,
  `Platform: ${process.platform} ${process.arch} ${os.release()}`,
  `Data root: ${options['data-root'] ?? defaultDataRoot()}`,
  '',
  ...appImages.flatMap((name) => {
    const file = path.join(ROOT, 'release', name);
    return [
      `AppImage: ${name}`,
      `  bytes: ${statSync(file).size}`,
      `  sha256: ${sha256(file)}`,
    ];
  }),
  '',
];
writeFileSync(path.join(directory, 'environment.txt'), environment.join('\n'));

const doctor = spawnSync('npm', ['run', 'doctor'], {
  cwd: ROOT,
  encoding: 'utf8',
  timeout: 120_000,
});
writeFileSync(
  path.join(directory, 'doctor.txt'),
  `exit=${doctor.status ?? 'unknown'}\n${doctor.stdout ?? ''}${doctor.stderr ?? ''}`,
);

writeRunsheet(directory, stamp, options.label);

let failed = false;
if (options.session) {
  const summary = sessionSummary(
    path.resolve(options['data-root'] ?? defaultDataRoot()),
    String(options.session),
  );
  writeFileSync(path.join(directory, 'session.json'), `${JSON.stringify(summary, null, 2)}\n`);
  const results = check(summary, options);
  writeFileSync(
    path.join(directory, 'result.txt'),
    results.length > 0
      ? `${results.map((entry) => `${entry.status} ${entry.check}: ${entry.detail}`).join('\n')}\n`
      : 'No expectation flags passed; this run records the session only.\n',
  );
  for (const entry of results) console.log(`${entry.status} ${entry.check}: ${entry.detail}`);
  failed = results.some((entry) => entry.status === 'FAIL');
  console.log(`Session ${summary.id}: ${summary.coveragePct?.toFixed?.(2) ?? 'no'}% coverage, ${summary.stopReason ?? 'no reason'}, ${summary.files.report ? 'report saved' : 'no report'}.`);
}

console.log(`Evidence written to ${directory}`);
if (failed) process.exitCode = 1;
