// What: console writes that cannot take the process down, plus a capped, redacted file log.
// Why: a launcher whose stdout has closed makes `console.log` throw EPIPE, and a player cannot send
//      a terminal history when a failure needs explaining. Secrets are removed by value, not shape.
// Removed: closing the terminal would kill a session, and no support log could be shared.
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

type Writer = (...args: readonly unknown[]) => void;
type Level = 'info' | 'error';

interface FileSink {
  file: string;
  dir: string;
  maxBytes: number;
  keep: number;
}

const LOG_NAME = 'chesspulse.log';
const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_KEEP = 2;
const SECRET_NAME = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD)$/i;
const REDACTED = '[redacted]';

let out: Writer = console.log.bind(console);
let err: Writer = console.error.bind(console);
let sink: FileSink | null = null;
let secrets: string[] = [];
const installedConsoles = new WeakSet<Console>();

/** Replaces the console writers so a broken pipe is a dropped line, not a crash. */
export function installSafeConsole(target: Console = console): void {
  // Re-installing on the same object would wrap the previous wrapper and duplicate every line.
  if (installedConsoles.has(target)) return;
  installedConsoles.add(target);
  out = target.log.bind(target);
  err = target.error.bind(target);
  target.log = (...args: readonly unknown[]): void => {
    write(out, args, 'info');
  };
  target.error = (...args: readonly unknown[]): void => {
    write(err, args, 'error');
  };
}

export interface FileLogOptions {
  /** The data root, not the log directory. The log lives under `<root>/logs`. */
  root: string;
  env: NodeJS.ProcessEnv;
  maxBytes?: number;
  /** Rotated files to keep. The current file is separate. */
  keep?: number;
}

/**
 * Starts appending to `<dataRoot>/logs/chesspulse.log`. A failure to create the directory leaves
 * console logging working and the app running; a log file is useful, never required.
 */
export function installFileLog(options: FileLogOptions): void {
  const dir = path.join(options.root, 'logs');
  const maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES);
  const keep = positiveInteger(options.keep, DEFAULT_KEEP);
  // Console redaction must work even when the file sink cannot be created.
  secrets = collectSecrets(options.env);
  sink = null;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    return;
  }
  sink = { dir, file: path.join(dir, LOG_NAME), maxBytes, keep };
}

export function log(...args: readonly unknown[]): void {
  write(out, args, 'info');
}

export function logError(...args: readonly unknown[]): void {
  write(err, args, 'error');
}

/**
 * The last lines across the current and rotated files, oldest first, redacted again on read.
 * Diagnostics never reads session files or PGNs, so this is the only content it can carry.
 */
export function readRecentLogLines(root: string, limit = 100): string[] {
  const dir = path.join(root, 'logs');
  const keep = sink?.keep ?? DEFAULT_KEEP;
  const names: string[] = [];
  for (let index = keep; index >= 1; index -= 1) names.push(`${LOG_NAME}.${index}`);
  names.push(LOG_NAME);
  const lines: string[] = [];
  for (const name of names) {
    try {
      const text = readFileSync(path.join(dir, name), 'utf8');
      for (const line of text.split(/\r?\n/)) {
        if (line.length > 0) lines.push(redact(line));
      }
    } catch {
      // A missing or unreadable rotated file contributes nothing.
    }
  }
  const capped = Math.max(1, Math.floor(limit));
  return lines.slice(-capped);
}

function write(writer: Writer, args: readonly unknown[], level: Level): void {
  const line = formatArgs(args);
  try {
    writer(line);
  } catch {
    // stdout or stderr is gone. Losing a log line beats losing the session.
  }
  append(level, line);
}

/** Console and file receive the same redacted text, so a copied terminal is safe too. */
function formatArgs(args: readonly unknown[]): string {
  try {
    return redact(args.map(describe).join(' '));
  } catch {
    return '[unloggable message]';
  }
}

function append(level: Level, message: string): void {
  const current = sink;
  if (!current) return;
  const prefix = `${new Date().toISOString()} ${level} `;
  const suffix = '\n';
  const room = Math.max(
    0,
    current.maxBytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix),
  );
  const text = `${prefix}${truncateUtf8(message, room)}${suffix}`;
  try {
    if (!rotateIfNeeded(current, Buffer.byteLength(text))) return;
    appendFileSync(current.file, text, { mode: 0o600 });
  } catch {
    // A full disk or a read-only home must not interrupt a measurement.
  }
}

/** Keeps one record inside the cap; the marker is omitted only when the cap is smaller than it. */
function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const marker = '…[truncated]';
  const suffix = Buffer.byteLength(marker) < maxBytes ? marker : '';
  const budget = maxBytes - Buffer.byteLength(suffix);
  let out = '';
  let used = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (used + size > budget) break;
    out += character;
    used += size;
  }
  return out + suffix;
}

function rotateIfNeeded(current: FileSink, incomingBytes: number): boolean {
  let size: number;
  try {
    size = statSync(current.file).size;
  } catch {
    return true;
  }
  if (size + incomingBytes <= current.maxBytes) return true;
  for (let index = current.keep; index >= 1; index -= 1) {
    const to = `${current.file}.${index}`;
    const from = index === 1 ? current.file : `${current.file}.${index - 1}`;
    try {
      rmSync(to, { force: true });
    } catch {
      // Replacing an old rotated file is best effort.
    }
    try {
      renameSync(from, to);
    } catch {
      // The current file must move for the cap to hold. Older gaps are tolerable.
      if (index === 1) return false;
    }
  }
  return true;
}

/** Secret values are collected from the environment and replaced literally, longest first. */
function collectSecrets(env: NodeJS.ProcessEnv): string[] {
  const found = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (!SECRET_NAME.test(name) || typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length >= 6) found.add(trimmed);
  }
  for (const name of ['SMARTSPECTRA_API_KEY', 'CP_AI_KEY']) {
    const value = env[name];
    if (typeof value === 'string' && value.trim().length > 0) found.add(value.trim());
  }
  return [...found].sort((a, b) => b.length - a.length);
}

function redact(text: string): string {
  let result = text;
  for (const secret of secrets) {
    const escaped = jsonEscaped(secret);
    for (const form of new Set([secret, escaped])) {
      if (form.length === 0) continue;
      if (result.includes(form)) result = result.split(form).join(REDACTED);
    }
  }
  return result;
}

/** The representation a secret takes inside a JSON string, without the surrounding quotes. */
function jsonEscaped(value: string): string {
  try {
    return JSON.stringify(value).slice(1, -1);
  } catch {
    return value;
  }
}

function describe(value: unknown): string {
  if (typeof value === 'string') return redact(value);
  if (value instanceof Error) return redact(value.stack ?? `${value.name}: ${value.message}`);
  try {
    const json = JSON.stringify(value, (_key, item) =>
      typeof item === 'string' ? redact(item) : item,
    );
    if (json !== undefined) return json;
  } catch {
    // Circular, BigInt, or a throwing toJSON: fall through to String.
  }
  try {
    return redact(String(value));
  } catch {
    return '[unloggable value]';
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}
