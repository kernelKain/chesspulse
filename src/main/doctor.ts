// What: one set of readiness checks shared by the CLI, the diagnostics bundle, and Setup.
// Why: a missing key, an engine that will not start, or an unwritable data folder should be named
//      before a session, with the same wording everywhere.
// Removed: the player would discover a broken install only after playing a 25-minute session.
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { readAiConfig, type AiConfigState } from './ai/config.js';
import { createEngine } from './engine.js';
import { loadEnvFile, readSensingKey, type EnvLoadResult } from './env.js';
import { defaultDataRoot } from './store.js';

export type DoctorStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface DoctorCheck {
  id: 'node' | 'env' | 'sensing-key' | 'camera' | 'engine' | 'data-dir' | 'ai';
  label: string;
  status: DoctorStatus;
  detail: string;
}

export interface DoctorReport {
  /** True when no check failed. Warnings and skips do not block the product. */
  ok: boolean;
  checks: DoctorCheck[];
  lines: string[];
}

export interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  envFile?: EnvLoadResult;
  dataRoot?: string;
  nodeVersion?: string;
  cameraCheck?: () => DoctorCheck | Promise<DoctorCheck>;
  engineProbe?: () => Promise<DoctorCheck>;
  writableProbe?: (directory: string) => Promise<boolean>;
  aiConfig?: AiConfigState;
}

/** Node 20 is the product floor; Electron's bundled Node is reported separately from the CLI host. */
export const MIN_NODE_MAJOR = 20;
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const envFile = options.envFile ?? loadEnvFile(path.join(process.cwd(), '.env'), env);
  const dataRoot = options.dataRoot ?? defaultDataRoot();
  const cameraCheck = options.cameraCheck ?? defaultCameraCheck;
  const engineProbe = options.engineProbe ?? probeEngine;
  const writableProbe = options.writableProbe ?? isWritableDirectory;
  const aiConfig = options.aiConfig ?? readAiConfig(env);

  const checks: DoctorCheck[] = [
    nodeCheck(options.nodeVersion ?? process.versions.node),
    envCheck(envFile),
    sensingKeyCheck(env),
    await cameraCheck(),
    await engineProbe(),
    await dataDirectoryCheck(dataRoot, writableProbe),
    aiCheck(aiConfig),
  ];
  return {
    ok: checks.every((check) => check.status !== 'fail'),
    checks,
    lines: checks.map((check) => `${check.status.toUpperCase()} ${check.label}: ${check.detail}`),
  };
}

function nodeCheck(version: string): DoctorCheck {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  const ok = Number.isInteger(major) && major >= MIN_NODE_MAJOR;
  return {
    id: 'node',
    label: 'Node',
    status: ok ? 'pass' : 'fail',
    detail: `v${version} (needs ${MIN_NODE_MAJOR} or newer).`,
  };
}

function envCheck(envFile: EnvLoadResult): DoctorCheck {
  if (!envFile.found) {
    return {
      id: 'env',
      label: '.env',
      status: 'warn',
      detail: 'Not found. Values already in the shell environment are still used.',
    };
  }
  const names = [...new Set(envFile.loadedKeys)].sort();
  return {
    id: 'env',
    label: '.env',
    status: 'pass',
    detail:
      names.length > 0
        ? `Found. Loaded names only: ${names.join(', ')}.`
        : 'Found. No new settings were loaded.',
  };
}

function sensingKeyCheck(env: NodeJS.ProcessEnv): DoctorCheck {
  const present = readSensingKey(env).length > 0;
  return {
    id: 'sensing-key',
    label: 'SmartSpectra key',
    status: present ? 'pass' : 'fail',
    detail: present
      ? 'Present (value not shown).'
      : 'Missing. Set SMARTSPECTRA_API_KEY in .env or the environment.',
  };
}

function defaultCameraCheck(): DoctorCheck {
  return {
    id: 'camera',
    label: 'Camera',
    status: 'skip',
    detail: 'Enumeration runs inside the app window; Setup shows the live result.',
  };
}

export async function probeEngine(): Promise<DoctorCheck> {
  const engine = createEngine({ depth: 1, timeoutMs: 5_000, maxRestarts: 0 });
  try {
    const result = await engine.evaluate(START_FEN);
    if (result.evalFailed) {
      return {
        id: 'engine',
        label: 'Stockfish',
        status: 'fail',
        detail: `No usable answer (${result.reason ?? 'unknown'}).`,
      };
    }
    return {
      id: 'engine',
      label: 'Stockfish',
      status: 'pass',
      detail: 'Answered the UCI handshake and scored the start position.',
    };
  } catch (error) {
    return {
      id: 'engine',
      label: 'Stockfish',
      status: 'fail',
      detail: `Could not start (${error instanceof Error ? error.message : 'unknown error'}).`,
    };
  } finally {
    await engine.close().catch(() => undefined);
  }
}

async function dataDirectoryCheck(
  directory: string,
  writableProbe: (directory: string) => Promise<boolean>,
): Promise<DoctorCheck> {
  const writable = await writableProbe(directory);
  return {
    id: 'data-dir',
    label: 'Data directory',
    status: writable ? 'pass' : 'fail',
    detail: writable ? `Writable at ${directory}.` : `Not writable at ${directory}.`,
  };
}

function aiCheck(config: AiConfigState): DoctorCheck {
  if (config.disabled) {
    return {
      id: 'ai',
      label: 'AI reading',
      status: 'warn',
      detail: `Off. ${config.reason}`,
    };
  }
  return {
    id: 'ai',
    label: 'AI reading',
    status: 'pass',
    detail: `Configured for ${config.config.provider}, model ${config.config.model}.`,
  };
}

async function isWritableDirectory(directory: string): Promise<boolean> {
  const probe = path.join(directory, `.doctor-${process.pid}-${randomBytes(4).toString('hex')}`);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(probe, 'ok\n', { mode: 0o600 });
    await unlink(probe);
    return true;
  } catch {
    return false;
  }
}
