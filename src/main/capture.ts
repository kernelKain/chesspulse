// What: owns the one SmartSpectra measurement session in the main process.
// Why: the key and the native camera runtime must stay outside the page, which receives only numbers.
// Removed: nothing would open the camera, so a real session would store no pulse.
import {
  CameraSelection,
  ProcessingStatus,
  SmartSpectraErrorCode,
  SmartSpectraLogLevel,
  SmartSpectraSDK,
  cardioMetrics,
} from '@smartspectra/node-sdk';
import { decodeMetrics } from '@smartspectra/node-sdk/messages';
import type {
  PulseSample,
  PreviewFrame,
  SdkError,
  SessionAnchor,
  SessionEndReason,
  ValidationMessage,
} from '../shared/contracts.js';
import {
  newPulseSamples,
  sdkErrorMessage,
  validationMessage,
  withOcclusion,
  type ValidationInterval,
} from './capture-samples.js';
import { log } from './log.js';
import { downscaleRgbToRgba } from '../shared/preview.js';

/** Opt-in tracing for capture problems: `CHESSPULSE_DEBUG_SENSING=1 npm start`. */
const DEBUG = process.env.CHESSPULSE_DEBUG_SENSING === '1';

function debug(...parts: readonly unknown[]): void {
  if (DEBUG) log('[sensing]', ...parts);
}

/** Coalesce readings so the page and the store see roughly four batches a second. */
const FLUSH_MS = 250;
/** A blocked native stop must not hold the window hostage. */
const STOP_TIMEOUT_MS = 8_000;
/** destroy() also waits on an in-flight stopAsync, so it needs its own ceiling. */
const DESTROY_TIMEOUT_MS = 2_000;
/** A store write in flight must land before the session header is closed. */
const DRAIN_TIMEOUT_MS = 3_000;
/** The preview only has to show framing; this keeps the IPC copy small. */
const PREVIEW_WIDTH = 320;
/** About twelve preview frames a second is enough to aim with. */
const PREVIEW_INTERVAL_MS = 80;

export interface CaptureEvents {
  onSamples(samples: PulseSample[]): void | Promise<void>;
  onValidation(message: ValidationMessage): void;
  onError(error: SdkError): void;
  onPreview(frame: PreviewFrame): void;
  onEnded(reason: SessionEndReason): void;
}

export interface CaptureSdkEventMap {
  metrics: [buffer: Buffer];
  validationStatus: [code: number, timestampUs: number, hint: string];
  videoOutput: [buffer: Buffer, width: number, height: number, stride: number];
  error: [code: number, message: string, retryable: boolean];
  processingStatus: [status: number];
}

export interface CaptureSdk {
  on<K extends keyof CaptureSdkEventMap>(
    event: K,
    listener: (...args: CaptureSdkEventMap[K]) => void,
  ): unknown;
  useCamera(selection: unknown): void;
  start(): void;
  stopAsync(): Promise<void>;
  destroy(): Promise<void>;
}

export interface CaptureSession {
  stop(): Promise<SessionEndReason | undefined>;
}

export function startCapture(input: {
  apiKey: string;
  anchor: SessionAnchor;
  events: CaptureEvents;
  sdk?: CaptureSdk;
  flushMs?: number;
  drainTimeoutMs?: number;
}): CaptureSession {
  const drainTimeoutMs = input.drainTimeoutMs ?? DRAIN_TIMEOUT_MS;
  const sdk = input.sdk ?? (new SmartSpectraSDK({
    apiKey: input.apiKey,
    // The whole cardio bundle, deliberately. Requesting PULSE_RATE alone produced no metrics at
    // all across full sessions, while the bundle produced a pulse series on this same machine.
    requestedMetrics: [...cardioMetrics],
    // Session summaries would leave the machine; ChessPulse is local-only.
    enableTelemetry: false,
    logLevel: SmartSpectraLogLevel.kWarning,
  }) as unknown as CaptureSdk);
  let pending: PulseSample[] = [];
  let lastTUs = input.anchor.monoUs;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  let stopping: Promise<SessionEndReason | undefined> | undefined;
  let terminalReported = false;
  let endedReported = false;
  let storageFailed = false;
  const writes = new Set<Promise<void>>();
  let lastPreviewAt = 0;
  let previewErrorReported = false;

  function flush(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (pending.length === 0) return;
    // Occlusion is decided here, not when the reading arrived: a validation code timestamped
    // before this reading may reach us after it, and the batch is still in hand.
    const batch = withOcclusion(pending, validationHistory);
    pending = [];
    let run: void | Promise<void>;
    try {
      run = input.events.onSamples(batch);
    } catch {
      reportEnded('storage');
      void Promise.resolve().then(() => shutdown());
      return;
    }
    if (!run || typeof run.then !== 'function') return;
    // Tracked so the stop path can wait for the tail to reach the store before the header closes.
    const write = run;
    writes.add(write);
    void write.then(
      () => {
        writes.delete(write);
      },
      () => {
        // A refused batch means the session is gone; release the camera with it.
        writes.delete(write);
        reportEnded('storage');
        void shutdown();
      },
    );
  }

  function emitError(error: SdkError): void {
    if (closed) return;
    if (!error.retryable) terminalReported = true;
    input.events.onError(error);
  }

  function reportEnded(reason: SessionEndReason): void {
    if (reason === 'storage') storageFailed = true;
    if (endedReported) return;
    endedReported = true;
    try {
      input.events.onEnded(reason);
    } catch {
      // The camera still shuts down; the session header records the stop independently.
    }
  }

  function shutdown(): Promise<SessionEndReason | undefined> {
    if (stopping) return stopping;
    closed = true;
    stopping = Promise.resolve().then(async () => {
      flush();
      try {
        await beforeDeadline(sdk.stopAsync(), STOP_TIMEOUT_MS);
      } catch {
        // The pipeline is already gone. destroy() below still releases the camera handle.
      }
      try {
        // destroy() awaits the same stopAsync promise when one is in flight, so it needs a ceiling too.
        await beforeDeadline(sdk.destroy(), DESTROY_TIMEOUT_MS);
      } catch {
        // Nothing is left to release.
      }
      if (writes.size > 0) {
        try {
          await beforeDeadline(
            Promise.allSettled([...writes]).then(() => undefined),
            drainTimeoutMs,
          );
        } catch {
          // The write did not confirm before the deadline. Finalize as a storage failure so a
          // late rejection cannot close the session with an earlier reason and lose the event.
          storageFailed = true;
          reportEnded('storage');
        }
      }
      return storageFailed ? 'storage' : undefined;
    });
    return stopping;
  }

  // Validation codes with the instant each started, so a reading is judged by its own timestamp
  // even when one coalesced batch spans a change. Pruned by time, not by count, so an interval
  // stays available while a reading that needs it can still be pending.
  const validationHistory: ValidationInterval[] = [];
  const HISTORY_US = 65_000_000;
  function rememberValidation(fromUs: number, code: number): void {
    validationHistory.push({ fromUs, code });
    if (validationHistory.length > 512) validationHistory.shift();
    const cutoff = fromUs - HISTORY_US;
    // Keep everything inside the window plus the last interval that started before it, so a late
    // reading older than the window still finds the code that was in force at its own timestamp.
    let baseline: ValidationInterval | null = null;
    for (const entry of validationHistory) {
      if (entry.fromUs < cutoff) baseline = entry;
    }
    if (baseline) {
      const kept = validationHistory.filter((entry) => entry.fromUs >= cutoff);
      kept.unshift(baseline);
      validationHistory.length = 0;
      validationHistory.push(...kept);
    }
  }
  /** A transition with no usable SDK timestamp still ends the previous interval; use now. */
  function validationNowUs(): number {
    const elapsedMs = Date.now() - input.anchor.epochMs;
    return Math.max(input.anchor.monoUs, input.anchor.monoUs + Math.round(elapsedMs * 1000));
  }

  sdk.on('metrics', (buffer) => {
    if (closed) return;
    let payload: unknown;
    try {
      payload = decodeMetrics(buffer);
    } catch (error) {
      debug('metrics decode failed', error instanceof Error ? error.message : error);
      return;
    }
    const fresh = newPulseSamples(payload, input.anchor, lastTUs);
    if (DEBUG) {
      const series = (payload as { cardio?: { pulseRate?: unknown[] } } | null)?.cardio?.pulseRate;
      const last = Array.isArray(series) ? series[series.length - 1] : undefined;
      debug(
        'metrics',
        { series: Array.isArray(series) ? series.length : 0, fresh: fresh.length, last, lastTUs },
      );
    }
    if (fresh.length === 0) return;
    lastTUs = fresh[fresh.length - 1].tUs;
    pending.push(...fresh);
    if (timer === undefined) timer = setTimeout(flush, input.flushMs ?? FLUSH_MS);
  });

  sdk.on('validationStatus', (code, timestampUs, hint) => {
    if (closed) return;
    debug('validation', code, JSON.stringify(hint));
    const message = validationMessage(code, timestampUs, hint, input.anchor);
    // The history follows the code, not the message: a transition the schema rejects still ends
    // the previous interval, or readings after it would stay marked as occluded.
    rememberValidation(message ? message.ts : validationNowUs(), code);
    if (message) input.events.onValidation(message);
  });

  sdk.on('videoOutput', (buffer, width, height, stride) => {
    if (closed) return;
    const now = Date.now();
    if (now - lastPreviewAt < PREVIEW_INTERVAL_MS) return;
    lastPreviewAt = now;
    try {
      input.events.onPreview(downscaleRgbToRgba(buffer, width, height, stride, PREVIEW_WIDTH));
    } catch (error) {
      if (previewErrorReported) return;
      previewErrorReported = true;
      debug('preview frame rejected', error instanceof Error ? error.message : error);
    }
  });

  sdk.on('error', (code, message, retryable) => {
    emitError({ code, message: sdkErrorMessage(code, message), retryable });
    if (!retryable) void shutdown();
  });

  sdk.on('processingStatus', (status) => {
    if (status !== ProcessingStatus.kError) return;
    // A retryable error may have been reported without a terminal one; the status is still terminal.
    if (!terminalReported) {
      emitError({
        code: SmartSpectraErrorCode.kProcessingFailed,
        message: sdkErrorMessage(SmartSpectraErrorCode.kProcessingFailed, ''),
        retryable: false,
      });
    }
    void shutdown();
  });

  // The SDK owns the camera. Feeding it frames from the page instead produced no metrics at all
  // on this machine, while this path measured a pulse series.
  sdk.useCamera(CameraSelection.default);
  try {
    sdk.start();
  } catch (error) {
    closed = true;
    void sdk.destroy().catch(() => undefined);
    throw new Error(sdkErrorMessage(errorCode(error), errorText(error)));
  }

  return { stop: shutdown };
}

function errorCode(error: unknown): number {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'number') return code;
  }
  return SmartSpectraErrorCode.kProcessingFailed;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : '';
}

function beforeDeadline(work: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The sensing pipeline did not stop in time.')), ms);
    timer.unref();
    work.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
