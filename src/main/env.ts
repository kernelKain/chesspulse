// What: fills missing process environment values from the repository .env file.
// Why: the SmartSpectra key lives in .env, and neither Electron nor Node reads that file on its own.
// Removed: a copied .env would be ignored and the camera would never receive its key.
import { readFileSync } from 'node:fs';

export type EnvLoadResult =
  | { found: true; path: string; loadedKeys: string[] }
  | { found: false; path: string };

const KEY = /^[A-Z_][A-Z0-9_]*$/;

export function loadEnvFile(filePath: string, env: NodeJS.ProcessEnv): EnvLoadResult {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return { found: false, path: filePath };
  }
  const loadedKeys: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const equals = body.indexOf('=');
    if (equals <= 0) continue;
    const key = body.slice(0, equals).trim();
    if (!KEY.test(key)) continue;
    // A value already exported by the shell wins over the file.
    if (env[key] !== undefined && env[key] !== '') continue;
    env[key] = unquote(body.slice(equals + 1).trim());
    loadedKeys.push(key);
  }
  return { found: true, path: filePath, loadedKeys };
}

export function readSensingKey(env: NodeJS.ProcessEnv): string {
  const value = env.SMARTSPECTRA_API_KEY;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
}

/**
 * Tries each path in order and loads the first file that exists.
 * Why: a packaged app cannot read `.env` from inside the asar, so it must also look beside the
 * executable and in the per-user config directory.
 */
export function loadEnvCandidates(files: readonly string[], env: NodeJS.ProcessEnv): EnvLoadResult {
  const candidates = files.filter((file) => file.length > 0);
  for (const file of candidates) {
    const result = loadEnvFile(file, env);
    if (result.found) return result;
  }
  return { found: false, path: candidates[0] ?? '' };
}

function unquote(value: string): string {
  const first = value[0];
  const last = value[value.length - 1];
  if (value.length >= 2 && (first === '"' || first === "'") && last === first) {
    return value.slice(1, -1);
  }
  return value;
}
