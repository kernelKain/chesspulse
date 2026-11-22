// What: writes one session as a header plus append-only pulse samples.
// Why: the trace has to survive a restart, and a crash must not leave a half-written header.
// Removed: the report could not be rebuilt, and a sample could be stored as a video file.
import { createHash, randomBytes } from 'node:crypto';
import { open, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import {
  REPORT_SCHEMA_VERSION,
  SCHEMA_VERSION,
  pulseSampleSchema,
  reportBuildRequestSchema,
  reportSchema,
  sessionMetaSchema,
  type PulseSample,
  type Report,
  type SessionMeta,
} from '../shared/contracts.js';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const SESSION_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const MEDIA_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.bmp',
  '.mp4',
  '.webm',
  '.mov',
  '.mkv',
  '.avi',
  '.m4v',
]);

const sessionIndexSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    ids: z.array(z.string().regex(SESSION_ID)),
  })
  .strict();

const tails = new Map<string, Promise<void>>();
const tornSamples = new Set<string>();

/** Why a stored report could not be opened. The message stays player-facing; the kind picks copy. */
export class StoredReportError extends Error {
  constructor(
    readonly kind: 'missing' | 'stale' | 'newer' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'StoredReportError';
  }
}

export interface NewSession {
  startedAtEpochMs: number;
  startAnchor: SessionMeta['startAnchor'];
}

export function defaultDataRoot(): string {
  const configured = process.env.XDG_DATA_HOME;
  const base = configured && configured.trim().length > 0 ? configured : path.join(homedir(), '.local', 'share');
  return path.join(base, 'chesspulse');
}

export function createSessionId(epochMs: number, bytes: Uint8Array = randomBytes(10)): string {
  if (!Number.isSafeInteger(epochMs) || epochMs < 0 || epochMs > 0xffffffffffff) {
    throw new Error('Session time is out of range.');
  }
  if (bytes.byteLength !== 10) throw new Error('Session id needs 10 random bytes.');
  let random = 0n;
  for (const byte of bytes) random = (random << 8n) | BigInt(byte);
  return encodeBase32(BigInt(epochMs), 10) + encodeBase32(random, 16);
}

export async function createSession(root: string, draft: NewSession, bytes?: Uint8Array): Promise<SessionMeta> {
  const id = createSessionId(draft.startedAtEpochMs, bytes ?? randomBytes(10));
  const meta = parseMeta({
    schemaVersion: SCHEMA_VERSION,
    id,
    startedAtEpochMs: draft.startedAtEpochMs,
    startAnchor: draft.startAnchor,
  });
  await exclusive(root, async () => {
    const dir = sessionDir(root, meta.id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const samples = await open(path.join(dir, 'samples.ndjson'), 'a', 0o600);
    await samples.close();
    await writeAtomic(path.join(dir, 'meta.json'), jsonText(meta));
    const ids = await readIndexIds(root);
    if (!ids.includes(meta.id)) await writeIndex(root, [...ids, meta.id].sort());
  });
  return meta;
}

export async function saveMeta(root: string, meta: SessionMeta): Promise<void> {
  const parsed = parseMeta(meta);
  await exclusive(root, async () => {
    const file = path.join(sessionDir(root, parsed.id), 'meta.json');
    try {
      await stat(file);
    } catch (error) {
      if (isEnoent(error)) throw new Error('No session with that id.');
      throw error;
    }
    await writeAtomic(file, jsonText(parsed));
  });
}

export async function appendSamples(root: string, sessionId: string, samples: readonly PulseSample[]): Promise<void> {
  const parsed = samples.map((sample, index) => {
    const result = pulseSampleSchema.safeParse(sample);
    if (!result.success) throw new Error(`Sample ${index + 1} is not a pulse sample.`);
    return result.data;
  });
  if (parsed.length === 0) return;
  const body = parsed.map((sample) => JSON.stringify(sample)).join('\n') + '\n';
  await exclusive(root, async () => {
    await assertSamplesAppendable(root, sessionId);
    const file = path.join(sessionDir(root, sessionId), 'samples.ndjson');
    try {
      await stat(file);
    } catch (error) {
      if (isEnoent(error)) throw new Error('No session with that id.');
      throw error;
    }
    const handle = await open(file, 'a', 0o600);
    try {
      const before = (await handle.stat()).size;
      try {
        await handle.writeFile(body);
        await handle.sync();
      } catch (error) {
        try {
          await handle.truncate(before);
          await handle.sync();
        } catch {
          await rememberTornSamples(root, sessionId);
          throw new Error('The sample file needs repair before more samples can be stored.');
        }
        throw error;
      }
    } finally {
      await handle.close();
    }
  });
}

export async function assertSamplesAppendable(root: string, sessionId: string): Promise<void> {
  const key = tornKey(root, sessionId);
  if (tornSamples.has(key)) {
    throw new Error('The sample file needs repair before more samples can be stored.');
  }
  try {
    await stat(path.join(sessionDir(root, sessionId), 'samples.ndjson.repair'));
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
  tornSamples.add(key);
  throw new Error('The sample file needs repair before more samples can be stored.');
}

export async function readMeta(root: string, sessionId: string): Promise<SessionMeta> {
  const file = path.join(sessionDir(root, sessionId), 'meta.json');
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (isEnoent(error)) throw new Error('No session with that id.');
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('The session header is not valid.');
  }
  assertCurrentVersion(value);
  const parsed = sessionMetaSchema.safeParse(value);
  if (!parsed.success) throw new Error('The session header is not valid.');
  if (parsed.data.id !== sessionId) throw new Error('The session header does not match its folder.');
  return parsed.data;
}

export interface AtomicFileHandle {
  writeFile(body: string): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface AtomicFileSystem {
  open(filePath: string, flags: string, mode?: number): Promise<AtomicFileHandle>;
  rename(from: string, to: string): Promise<void>;
  rm(filePath: string, options: { force: boolean }): Promise<void>;
}

const defaultAtomicFileSystem: AtomicFileSystem = { open, rename, rm };

// What: stages and saves the report and its exact PGN batch under one store exclusion.
// Why: both temp files must be durable before either artifact is replaced.
// Removed: independent saves could start a report replacement before the new PGN temp file existed.
export async function saveReportArtifacts(
  root: string,
  sessionId: string,
  text: string,
  pgns: readonly string[],
  fs: AtomicFileSystem = defaultAtomicFileSystem,
): Promise<void> {
  const parsed = reportBuildRequestSchema.safeParse({ sessionId, pgns });
  if (!parsed.success) throw new Error('The PGN batch is not valid.');
  await exclusive(root, async () => {
    const dir = sessionDir(root, sessionId);
    await stat(path.join(dir, 'meta.json'));
    const gamesFile = path.join(dir, 'games.json');
    const reportFile = path.join(dir, 'report.json');
    const pending = new Set<string>();
    try {
      const gamesTmp = await stageAtomic(gamesFile, jsonText(parsed.data.pgns), fs);
      pending.add(gamesTmp);
      const reportTmp = await stageAtomic(reportFile, text, fs);
      pending.add(reportTmp);
      await commitAtomic(gamesTmp, gamesFile, fs);
      pending.delete(gamesTmp);
      await commitAtomic(reportTmp, reportFile, fs);
      pending.delete(reportTmp);
    } catch (error) {
      await Promise.all([...pending].map((tmp) => removeAtomicTemp(tmp, fs)));
      throw error;
    }
  });
}

// What: hashes the exact ordered PGN batch as a JSON array.
// Why: report and PGN files are separate writes, so readers need proof that they belong together.
// Removed: a crash or hand edit could silently pair one report with different games.
export function digestGames(pgns: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(pgns), 'utf8').digest('hex');
}

export async function saveReport(root: string, sessionId: string, text: string): Promise<void> {
  await exclusive(root, async () => {
    const dir = sessionDir(root, sessionId);
    await stat(path.join(dir, 'meta.json'));
    await writeAtomic(path.join(dir, 'report.json'), text);
  });
}

export async function readReport(root: string, sessionId: string): Promise<Report> {
  const file = path.join(sessionDir(root, sessionId), 'report.json');
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (isEnoent(error)) throw new StoredReportError('missing', 'Build a report before requesting an AI reading.');
    throw new StoredReportError('invalid', 'The stored report is not valid.');
  }
  assertReportVersion(value);
  const parsed = reportSchema.safeParse(value);
  if (!parsed.success || parsed.data.sessionId !== sessionId) {
    throw new StoredReportError(
      'invalid',
      'The stored report is not valid or is stale. Build the report again before requesting AI.',
    );
  }
  return parsed.data;
}

/** True when a report file is present. The list does not parse it; opening does. */
export async function hasSavedReport(root: string, sessionId: string): Promise<boolean> {
  try {
    await stat(path.join(sessionDir(root, sessionId), 'report.json'));
    return true;
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

export async function saveGames(root: string, sessionId: string, pgns: readonly string[]): Promise<void> {
  const parsed = reportBuildRequestSchema.safeParse({ sessionId, pgns });
  if (!parsed.success) throw new Error('The PGN batch is not valid.');
  await exclusive(root, async () => {
    const dir = sessionDir(root, sessionId);
    await stat(path.join(dir, 'meta.json'));
    await writeAtomic(path.join(dir, 'games.json'), jsonText(parsed.data.pgns));
  });
}

export async function readGames(root: string, sessionId: string): Promise<string[]> {
  const file = path.join(sessionDir(root, sessionId), 'games.json');
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (isEnoent(error)) throw new Error('The original PGNs are missing. Build the report again before requesting AI.');
    throw new Error('The stored PGNs are not valid.');
  }
  const parsed = reportBuildRequestSchema.safeParse({ sessionId, pgns: value });
  if (!parsed.success) throw new Error('The stored PGNs are not valid.');
  return parsed.data.pgns;
}

export async function deleteReport(root: string, sessionId: string): Promise<void> {
  await exclusive(root, async () => {
    await rm(path.join(sessionDir(root, sessionId), 'report.json'), { force: true });
  });
}

// What: removes one session folder, then rebuilds the index from what remains.
// Why: a failed index write must leave a readable store, and a reader must not see a deleted id.
// Removed: deleting a session would leave a ghost row or a half-written index.
export async function deleteSession(root: string, sessionId: string): Promise<boolean> {
  const dir = sessionDir(root, sessionId);
  return exclusive(root, async () => {
    // Refuse a newer index before touching data; a missing or corrupt one is repaired here.
    await readIndexIds(root);
    let existed = true;
    try {
      await stat(dir);
    } catch (error) {
      if (isEnoent(error)) existed = false;
      else throw error;
    }
    if (existed) await rm(dir, { recursive: true, force: false });
    await writeIndex(root, await scanSessionIds(root));
    return existed;
  });
}

export async function readSamples(root: string, sessionId: string): Promise<PulseSample[]> {
  const file = path.join(sessionDir(root, sessionId), 'samples.ndjson');
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (isEnoent(error)) throw new Error('No session with that id.');
    throw error;
  }
  if (text.length === 0) return [];
  const complete = completeSampleText(text);
  if (complete.length === 0) return [];
  return complete.split('\n').map((line, index) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`Sample line ${index + 1} is not valid.`);
    }
    const parsed = pulseSampleSchema.safeParse(value);
    if (!parsed.success) throw new Error(`Sample line ${index + 1} is not a pulse sample.`);
    return parsed.data;
  });
}

export async function listSessions(root: string): Promise<string[]> {
  return exclusive(root, () => readIndexIds(root));
}

export async function findMediaFiles(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    const parent = entry.parentPath;
    found.push(path.relative(root, path.join(parent, entry.name)));
  }
  return found.sort();
}

function completeSampleText(text: string): string {
  if (!text.endsWith('\n')) {
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline === -1) return '';
    return text.slice(0, lastNewline);
  }
  return text.slice(0, -1);
}

function parseMeta(value: unknown): SessionMeta {
  assertCurrentVersion(value);
  const parsed = sessionMetaSchema.safeParse(value);
  if (!parsed.success) throw new Error('The session header is not valid.');
  return parsed.data;
}

function assertCurrentVersion(value: unknown, label = 'session'): void {
  if (typeof value !== 'object' || value === null || !('schemaVersion' in value)) return;
  const version = value.schemaVersion;
  if (typeof version === 'number' && version > SCHEMA_VERSION) {
    throw new Error(`This ${label} was written by a newer version of ChessPulse.`);
  }
}

function assertReportVersion(value: unknown): void {
  if (typeof value !== 'object' || value === null) {
    throw new StoredReportError('invalid', 'The stored report is not valid.');
  }
  const version = (value as { schemaVersion?: unknown }).schemaVersion;
  if (typeof version === 'number' && version > REPORT_SCHEMA_VERSION) {
    throw new StoredReportError(
      'newer',
      'This report was written by a newer version of ChessPulse. Update the app to read it.',
    );
  }
  if (version === REPORT_SCHEMA_VERSION) return;
  // A versionless object that still looks like a finished report is an older report, not junk.
  if ((value as { ok?: unknown }).ok !== true) {
    throw new StoredReportError('invalid', 'The stored report is not valid.');
  }
  throw new StoredReportError(
    'stale',
    'This report was written by an older version of ChessPulse. Build the report again from the pasted games.',
  );
}

async function readIndexIds(root: string): Promise<string[]> {
  const indexFile = path.join(root, 'sessions', 'index.json');
  let value: unknown;
  let parsedJson = true;
  try {
    value = JSON.parse(await readFile(indexFile, 'utf8'));
  } catch {
    // A missing or unreadable index is rebuilt from the session folders.
    parsedJson = false;
  }
  if (parsedJson) {
    // A newer index must be refused, not silently replaced by this version's view of the folders.
    assertCurrentVersion(value, 'data index');
    const parsed = sessionIndexSchema.safeParse(value);
    if (parsed.success && (await indexMatchesDisk(root, parsed.data.ids))) return parsed.data.ids;
  }
  const ids = await scanSessionIds(root);
  await writeIndex(root, ids);
  return ids;
}

async function indexMatchesDisk(root: string, ids: readonly string[]): Promise<boolean> {
  const scanned = await scanSessionIds(root);
  return scanned.length === ids.length && scanned.every((id, index) => id === ids[index]);
}

async function scanSessionIds(root: string): Promise<string[]> {
  const sessions = path.join(root, 'sessions');
  let entries;
  try {
    entries = await readdir(sessions, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SESSION_ID.test(entry.name)) continue;
    try {
      await stat(path.join(sessions, entry.name, 'meta.json'));
      ids.push(entry.name);
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
  }
  return ids.sort();
}

async function writeIndex(root: string, ids: readonly string[]): Promise<void> {
  const sessions = path.join(root, 'sessions');
  await mkdir(sessions, { recursive: true, mode: 0o700 });
  await writeAtomic(path.join(sessions, 'index.json'), jsonText({ schemaVersion: SCHEMA_VERSION, ids }));
}

async function rememberTornSamples(root: string, sessionId: string): Promise<void> {
  tornSamples.add(tornKey(root, sessionId));
  try {
    const marker = await open(path.join(sessionDir(root, sessionId), 'samples.ndjson.repair'), 'wx', 0o600);
    await marker.close();
  } catch {
    // This process still refuses further batches through tornSamples.
  }
}

function tornKey(root: string, sessionId: string): string {
  return `${path.resolve(root)}\0${sessionId}`;
}

function sessionDir(root: string, sessionId: string): string {
  if (!SESSION_ID.test(sessionId)) throw new Error('Session id is not valid.');
  const sessions = path.resolve(root, 'sessions');
  const dir = path.resolve(sessions, sessionId);
  if (!dir.startsWith(sessions + path.sep)) throw new Error('Session id is not valid.');
  return dir;
}

async function writeAtomic(
  filePath: string,
  body: string,
  fs: AtomicFileSystem = defaultAtomicFileSystem,
): Promise<void> {
  let tmp: string | undefined;
  try {
    tmp = await stageAtomic(filePath, body, fs);
    await commitAtomic(tmp, filePath, fs);
  } catch (error) {
    if (tmp) await removeAtomicTemp(tmp, fs);
    throw error;
  }
}

async function stageAtomic(filePath: string, body: string, fs: AtomicFileSystem): Promise<string> {
  const tmp = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await fs.open(tmp, 'w', 0o600);
  try {
    await closeAfter(handle, async () => {
      await handle.writeFile(body);
      await handle.sync();
    });
  } catch (error) {
    await removeAtomicTemp(tmp, fs);
    throw error;
  }
  return tmp;
}

async function commitAtomic(tmp: string, filePath: string, fs: AtomicFileSystem): Promise<void> {
  await fs.rename(tmp, filePath);
  const directory = await fs.open(path.dirname(filePath), 'r');
  await closeAfter(directory, () => directory.sync());
}

async function closeAfter(handle: AtomicFileHandle, operation: () => Promise<void>): Promise<void> {
  let failed = false;
  let failure: unknown;
  try {
    await operation();
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    await handle.close();
  } catch (error) {
    if (!failed) {
      failed = true;
      failure = error;
    }
  }
  if (failed) throw failure;
}

// Cleanup is best-effort so a secondary rm failure never hides the causal storage error.
async function removeAtomicTemp(tmp: string, fs: AtomicFileSystem): Promise<void> {
  try {
    await fs.rm(tmp, { force: true });
  } catch {
    // The original write, sync, close, or rename error is more useful to the caller.
  }
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

function encodeBase32(value: bigint, chars: number): string {
  let out = '';
  for (let shift = (chars - 1) * 5; shift >= 0; shift -= 5) {
    out += ALPHABET[Number((value >> BigInt(shift)) & 31n)];
  }
  return out;
}

function exclusive<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(root);
  const previous = tails.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  tails.set(key, run.then(() => undefined, () => undefined));
  return run;
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
