// What: opens and closes one session, then stores its baseline and coverage.
// Why: bands later compare against the player's own first minute, and a thin trace must count as thin.
// Removed: the header would have no baseline, and a gap would be treated as a normal pulse.
import path from 'node:path';
import { sessionStartRequestSchema, type PulseSample, type SessionAnchor, type SessionMeta } from '../shared/contracts.js';
import {
  BASELINE_WINDOW_US,
  CONFIDENCE_FLOOR,
  SAMPLE_HOLD_US,
  isUsableSample,
} from '../shared/sensing.js';
import {
  appendSamples,
  assertSamplesAppendable,
  createSession,
  listSessions,
  readMeta,
  readSamples,
  saveMeta,
} from './store.js';

export { BASELINE_WINDOW_US, CONFIDENCE_FLOOR, SAMPLE_HOLD_US as MAX_SAMPLE_HOLD_US };
export { isUsableSample };
export const MAX_SESSION_US = 90 * 60 * 1_000_000;

const sampleSinks = new Map<string, (samples: readonly PulseSample[]) => void>();

export type SessionStopReason = Exclude<NonNullable<SessionMeta['stopReason']>, 'crash'>;

export interface SessionLimitScheduler {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export interface SessionHooks {
  limitScheduler?: SessionLimitScheduler;
  onLimit?: () => void;
}

interface ActiveSession {
  id?: string;
  anchor: SessionAnchor;
  startedAtEpochMs: number;
  timeControl: string;
  state: 'starting' | 'running' | 'stopping';
  ingest: Promise<void>;
  stopped: Promise<SessionMeta>;
  resolveStopped: (meta: SessionMeta) => void;
  rejectStopped: (error: unknown) => void;
  stopRequest?: { anchor: SessionAnchor; reason: SessionStopReason };
  finishStop?: Promise<SessionMeta>;
  limitScheduler: SessionLimitScheduler;
  limitTimer?: unknown;
}

const active = new Map<string, ActiveSession>();

export function baselineFromSamples(
  samples: readonly PulseSample[],
  startUs: number,
  floor = CONFIDENCE_FLOOR,
): Pick<SessionMeta, 'baselineBpm' | 'baselineWindow'> | undefined {
  const toUs = startUs + BASELINE_WINDOW_US;
  const values = samples
    .filter((sample) => sample.tUs >= startUs && sample.tUs < toUs && isUsableSample(sample, floor))
    .map((sample) => sample.bpm);
  if (values.length === 0) return undefined;
  return {
    baselineBpm: median(values),
    baselineWindow: { fromUs: startUs, toUs },
  };
}

export function coverageFromSamples(
  samples: readonly PulseSample[],
  startUs: number,
  stopUs: number,
  floor = CONFIDENCE_FLOOR,
): NonNullable<SessionMeta['coverage']> {
  if (stopUs < startUs) throw new Error('The session clock moved backwards.');
  const totalUs = stopUs - startUs;
  const ordered = samples
    .filter((sample) => sample.tUs >= startUs && sample.tUs <= stopUs)
    .sort((a, b) => a.tUs - b.tUs);
  let usableUs = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    const sample = ordered[index];
    if (!isUsableSample(sample, floor)) continue;
    const nextUs = index + 1 < ordered.length ? ordered[index + 1].tUs : stopUs;
    const gap = nextUs - sample.tUs;
    if (gap <= 0) continue;
    usableUs += Math.min(gap, SAMPLE_HOLD_US);
  }
  if (usableUs > totalUs) usableUs = totalUs;
  const pct = totalUs === 0 ? 0 : (usableUs / totalUs) * 100;
  return { usableUs, totalUs, pct, confidenceFloor: floor };
}

const defaultLimitScheduler: SessionLimitScheduler = {
  set(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return timer;
  },
  clear(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

export async function startSession(
  root: string,
  anchor: SessionAnchor,
  timeControl: string,
  hooks: SessionHooks = {},
): Promise<SessionMeta> {
  const parsed = sessionStartRequestSchema.safeParse({ timeControl });
  if (!parsed.success) throw new Error('Choose a time control before starting.');
  const key = path.resolve(root);
  if (active.has(key)) throw new Error('A session is already running.');
  const reservation = reserve(anchor, parsed.data.timeControl, hooks.limitScheduler ?? defaultLimitScheduler);
  active.set(key, reservation);
  let stoppedEarly = false;
  try {
    const meta = await createSession(root, {
      startedAtEpochMs: anchor.epochMs,
      startAnchor: anchor,
    });
    if (reservation.state === 'stopping' && reservation.stopRequest) {
      const saved = await finalize(root, meta, reservation.stopRequest.anchor, reservation.stopRequest.reason);
      if (active.get(key) === reservation) active.delete(key);
      reservation.resolveStopped(saved);
      stoppedEarly = true;
      throw new Error('The session was stopped.');
    }
    reservation.id = meta.id;
    reservation.state = 'running';
    armLimitTimer(key, reservation, hooks.onLimit);
    return meta;
  } catch (error) {
    if (!stoppedEarly && active.get(key) === reservation) active.delete(key);
    if (!stoppedEarly) reservation.rejectStopped(error);
    throw error;
  }
}

export async function ingestSamples(root: string, samples: readonly PulseSample[]): Promise<void> {
  const current = requireActive(root);
  const batch = snapshotSamples(samples);
  await assertSamplesAppendable(root, current.id);
  const run = current.ingest.then(() => commitSamples(root, current.id, batch));
  current.ingest = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function setSampleSink(
  root: string,
  sink: ((samples: readonly PulseSample[]) => void) | undefined,
): void {
  const key = path.resolve(root);
  if (sink) sampleSinks.set(key, sink);
  else sampleSinks.delete(key);
}

export async function stopSession(
  root: string,
  stopAnchor: SessionAnchor,
  reason: SessionStopReason,
): Promise<SessionMeta> {
  const key = path.resolve(root);
  const current = active.get(key);
  if (!current) throw new Error('No session is running.');
  if (current.state === 'starting') {
    current.state = 'stopping';
    current.stopRequest = { anchor: stopAnchor, reason };
    return current.stopped;
  }
  const sessionId = current.id;
  if (!sessionId) throw new Error('No session is running.');
  if (current.state === 'running') current.state = 'stopping';
  else if (current.state !== 'stopping') throw new Error('No session is running.');
  return beginStop(root, key, current, sessionId, stopAnchor, reason);
}

function beginStop(
  root: string,
  key: string,
  current: ActiveSession,
  sessionId: string,
  stopAnchor: SessionAnchor,
  reason: SessionStopReason,
): Promise<SessionMeta> {
  if (current.finishStop) return current.finishStop;
  const run = (async () => {
    try {
      await current.ingest;
      const meta = await readMeta(root, sessionId);
      const saved = await finalize(root, meta, stopAnchor, reason);
      clearLimitTimer(current);
      if (active.get(key) === current) active.delete(key);
      return saved;
    } catch (error) {
      clearLimitTimer(current);
      current.finishStop = undefined;
      throw error;
    }
  })();
  current.finishStop = run;
  return run;
}

export interface SessionRecoveryFailure {
  id: string;
  message: string;
}

export async function recoverInterruptedSessions(root: string): Promise<{
  recovered: SessionMeta[];
  failures: SessionRecoveryFailure[];
}> {
  const ids = await listSessions(root);
  const recovered: SessionMeta[] = [];
  const failures: SessionRecoveryFailure[] = [];
  for (const id of ids) {
    try {
      const meta = await readMeta(root, id);
      if (meta.stopReason) continue;
      const samples = await readSamples(root, id);
      const lastUs = samples.reduce((max, sample) => Math.max(max, sample.tUs), meta.startAnchor.monoUs);
      const stopAnchor = {
        monoUs: lastUs,
        epochMs: meta.startAnchor.epochMs + Math.round((lastUs - meta.startAnchor.monoUs) / 1000),
      };
      recovered.push(await finalize(root, meta, stopAnchor, 'crash'));
    } catch (error) {
      failures.push({
        id,
        message: error instanceof Error ? error.message : 'The session could not be recovered.',
      });
    }
  }
  const key = path.resolve(root);
  const current = active.get(key);
  if (current && recovered.some((meta) => meta.id === current.id)) active.delete(key);
  return { recovered, failures };
}

async function finalize(
  root: string,
  meta: SessionMeta,
  stopAnchor: SessionAnchor,
  reason: NonNullable<SessionMeta['stopReason']>,
): Promise<SessionMeta> {
  const samples = await readSamples(root, meta.id);
  const baseline = baselineFromSamples(samples, meta.startAnchor.monoUs);
  const coverage = coverageFromSamples(samples, meta.startAnchor.monoUs, stopAnchor.monoUs);
  await saveMeta(root, {
    ...meta,
    ...baseline,
    stopAnchor,
    stopReason: reason,
    coverage,
  });
  return readMeta(root, meta.id);
}

export function activeTimeControl(root: string): string | undefined {
  return active.get(path.resolve(root))?.timeControl;
}

export function hasActiveSession(root: string): boolean {
  return active.has(path.resolve(root));
}

export interface ActiveSessionState {
  active: boolean;
  sessionId: string | null;
  startedAtEpochMs: number | null;
}

/**
 * What a reloaded page may adopt. A session that is still starting or already stopping has no
 * stable id for the page, so it is reported closed and the page starts at Home.
 */
export function activeSessionState(root: string): ActiveSessionState {
  const current = active.get(path.resolve(root));
  if (!current || current.state !== 'running' || !current.id) {
    return { active: false, sessionId: null, startedAtEpochMs: null };
  }
  return {
    active: true,
    sessionId: current.id,
    startedAtEpochMs: current.startedAtEpochMs,
  };
}

/** True only while this exact id is the active, running session. */
export function isActiveSession(root: string, sessionId: string): boolean {
  const current = active.get(path.resolve(root));
  return current?.state === 'running' && current.id === sessionId;
}

function reserve(
  anchor: SessionAnchor,
  timeControl: string,
  limitScheduler: SessionLimitScheduler,
): ActiveSession {
  let resolveStopped: (meta: SessionMeta) => void = () => undefined;
  let rejectStopped: (error: unknown) => void = () => undefined;
  const stopped = new Promise<SessionMeta>((resolve, reject) => {
    resolveStopped = resolve;
    rejectStopped = reject;
  });
  stopped.catch(() => undefined);
  return {
    anchor,
    startedAtEpochMs: anchor.epochMs,
    timeControl,
    state: 'starting',
    ingest: Promise.resolve(),
    stopped,
    resolveStopped,
    rejectStopped,
    limitScheduler,
  };
}

function armLimitTimer(key: string, current: ActiveSession, onLimit: (() => void) | undefined): void {
  current.limitTimer = current.limitScheduler.set(() => {
    current.limitTimer = undefined;
    if (active.get(key) !== current || current.state !== 'running') return;
    try {
      onLimit?.();
    } catch {
      // The next explicit stop still closes the session; a timer callback must not crash main.
    }
  }, MAX_SESSION_US / 1000);
}

function clearLimitTimer(current: ActiveSession): void {
  if (current.limitTimer === undefined) return;
  current.limitScheduler.clear(current.limitTimer);
  current.limitTimer = undefined;
}

async function commitSamples(root: string, sessionId: string, samples: readonly PulseSample[]): Promise<void> {
  await appendSamples(root, sessionId, samples);
  try {
    sampleSinks.get(path.resolve(root))?.(samples);
  } catch {
    // The batch is already in the file. The caller must not treat this as a reason to append it again.
  }
}

function snapshotSamples(samples: readonly PulseSample[]): PulseSample[] {
  return samples.map((sample) => ({
    tUs: sample.tUs,
    bpm: sample.bpm,
    confidence: sample.confidence,
    stable: sample.stable,
  }));
}

function requireActive(root: string): ActiveSession & { id: string } {
  const current = active.get(path.resolve(root));
  if (!current || current.state !== 'running' || !current.id) throw new Error('No session is running.');
  return current as ActiveSession & { id: string };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}
