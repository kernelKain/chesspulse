// What: turns one SmartSpectra payload into the numbers this app stores, and names SDK failures.
// Why: the SDK speaks epoch microseconds and protobuf; the session speaks one clock and five fields.
// Removed: a pulse could land at the wrong instant, and a failure would surface as a bare code.
import { z } from 'zod';
import {
  validationMessageSchema,
  type PulseSample,
  type SessionAnchor,
  type ValidationMessage,
} from '../shared/contracts.js';
import { VALIDATION, isOcclusionCode } from '../shared/framing.js';

/** Kept exported here for the existing capture tests; the codes themselves live in shared framing. */
export { VALIDATION };

/**
 * The SDK's integer codes, copied here so this module loads without the native binding.
 * Values are stable across SDK versions (docs/nodejs/api-reference).
 */
export const SDK_ERROR = {
  invalidState: 1,
  authenticationFailed: 2,
  configurationFailed: 3,
  creditExhausted: 4,
  networkError: 5,
  serverError: 6,
  inputUnavailable: 7,
  processingFailed: 8,
  frameConversionFailed: 9,
  nonMonotonicTimestamp: 10,
  timestampGap: 11,
  metricNotAuthorized: 13,
  sustainedLowFrameRate: 14,
} as const;


/** A pulse outside this range is a decoding mistake, not a reading. Kept narrow on purpose. */
const MIN_PULSE_BPM = 20;
const MAX_PULSE_BPM = 300;
const MAX_TEXT_LENGTH = 240;

const readingSchema = z.object({
  value: z.number().finite(),
  confidence: z.number().finite().min(0).max(100),
  stable: z.boolean(),
  timestamp: z.unknown(),
});

const VALIDATION_COPY: Record<number, string> = {
  [VALIDATION.ok]: 'Measuring.',
  [VALIDATION.noFaceFound]: 'Waiting for a face.',
  [VALIDATION.multipleFacesFound]: 'More than one face is in view.',
  [VALIDATION.faceNotCentered]: 'Center your face in the frame.',
  [VALIDATION.faceSizeOutOfRange]: 'Move so your face fills the frame.',
  [VALIDATION.tooDark]: 'Too dark. Add light in front of you.',
  [VALIDATION.tooBright]: 'Too bright. Reduce the light behind you.',
  [VALIDATION.chestNotVisible]: 'Sit back so your chest is in frame.',
  [VALIDATION.cameraTuning]: 'The camera is still adjusting.',
  [VALIDATION.frameRateTooLow]: 'The camera frame rate is too low.',
  [VALIDATION.excessiveMotion]: 'Too much movement. Hold still.',
  [VALIDATION.faceTooClose]: 'Move a little further from the camera.',
  [VALIDATION.faceTooFar]: 'Move a little closer to the camera.',
  [VALIDATION.faceTooHigh]: 'Lower your face into the frame.',
  [VALIDATION.faceTooLow]: 'Raise your face into the frame.',
  [VALIDATION.faceNotForward]: 'Face the camera.',
};

const SDK_ERROR_COPY: Record<number, string> = {
  [SDK_ERROR.invalidState]: 'The sensing pipeline was not ready. Start the session again.',
  [SDK_ERROR.authenticationFailed]: 'The SmartSpectra key was rejected. Check SMARTSPECTRA_API_KEY in .env.',
  [SDK_ERROR.configurationFailed]: 'The sensing configuration was rejected.',
  [SDK_ERROR.creditExhausted]: 'This SmartSpectra key has no measurement credit left.',
  [SDK_ERROR.networkError]: 'The network check for the sensing key failed. Try again when you are online.',
  [SDK_ERROR.serverError]: 'The sensing service is unavailable right now.',
  [SDK_ERROR.inputUnavailable]: 'No camera was available.',
  [SDK_ERROR.processingFailed]: 'The camera pipeline failed.',
  [SDK_ERROR.frameConversionFailed]: 'The camera frames could not be read.',
  [SDK_ERROR.nonMonotonicTimestamp]: 'The camera clock moved backwards.',
  [SDK_ERROR.timestampGap]: 'The camera stopped sending frames.',
  [SDK_ERROR.metricNotAuthorized]: 'This SmartSpectra key is not allowed to measure pulse.',
  [SDK_ERROR.sustainedLowFrameRate]: 'The camera frame rate stayed too low.',
};

/**
 * Every pulse reading in a decoded metrics payload that is newer than the last one stored.
 * Weak samples are kept: the raw trace keeps them and coverage is what falls.
 */
export function newPulseSamples(
  payload: unknown,
  anchor: SessionAnchor,
  lastTUs: number,
): PulseSample[] {
  const series = pulseSeries(payload);
  if (!series) return [];
  // The floor stays at lastTUs rather than advancing with each reading: a payload whose samples
  // arrive out of order would otherwise lose an earlier-but-new reading. Ordering is restored
  // below, and a repeated timestamp keeps the first reading, as before.
  const collected: PulseSample[] = [];
  for (const raw of series) {
    const sample = toPulseSample(raw, anchor, lastTUs);
    if (sample) collected.push(sample);
  }
  // A stable sort keeps payload order among equal timestamps, so the first reading wins.
  collected.sort((left, right) => left.tUs - right.tUs);
  const fresh: PulseSample[] = [];
  for (const sample of collected) {
    const previous = fresh[fresh.length - 1];
    if (previous && previous.tUs === sample.tUs) continue;
    fresh.push(sample);
  }
  return fresh;
}

/** The newest pulse reading in a decoded metrics payload. Kept for callers that want only one. */
export function latestPulseSample(
  payload: unknown,
  anchor: SessionAnchor,
  lastTUs: number,
): PulseSample | null {
  const fresh = newPulseSamples(payload, anchor, lastTUs);
  return fresh.length > 0 ? fresh[fresh.length - 1] : null;
}

/** One validation code and the instant it started, on the same clock as the readings. */
export interface ValidationInterval {
  readonly fromUs: number;
  readonly code: number;
}

/** The code in force at a reading's own timestamp, not at the time the batch arrived. */
export function codeAt(intervals: readonly ValidationInterval[], tUs: number): number {
  let code: number = VALIDATION.ok;
  let from = -Infinity;
  for (const interval of intervals) {
    if (interval.fromUs <= tUs && interval.fromUs >= from) {
      code = interval.code;
      from = interval.fromUs;
    }
  }
  return code;
}

/**
 * What: marks each reading taken while the face could not be measured.
 * Why: R6-07 keeps the sample in the raw file but must not count it as measured time, and a
 *      coalesced metrics batch can straddle a validation change, so the code is chosen per reading.
 * Removed: coverage and the baseline would treat an occluded stretch as a calm pulse, or mark a
 *      whole batch with a code that was only true for part of it.
 */
export function withOcclusion(
  samples: readonly PulseSample[],
  intervals: readonly ValidationInterval[],
): PulseSample[] {
  return samples.map((sample) =>
    isOcclusionCode(codeAt(intervals, sample.tUs)) ? { ...sample, occluded: true } : sample,
  );
}

export function toPulseSample(
  raw: unknown,
  anchor: SessionAnchor,
  lastTUs: number,
): PulseSample | null {
  const parsed = readingSchema.safeParse(raw);
  if (!parsed.success) return null;
  if (parsed.data.value < MIN_PULSE_BPM || parsed.data.value > MAX_PULSE_BPM) return null;
  const timestamp = epochUs(parsed.data.timestamp);
  if (timestamp === null) return null;
  const tUs = anchor.monoUs + (timestamp - anchor.epochMs * 1000);
  if (!Number.isSafeInteger(tUs) || tUs < anchor.monoUs || tUs <= lastTUs) return null;
  return {
    tUs,
    bpm: parsed.data.value,
    confidence: parsed.data.confidence,
    stable: parsed.data.stable,
  };
}

export function validationMessage(
  code: number,
  timestampUs: number,
  hint: string,
  anchor: SessionAnchor,
): ValidationMessage | null {
  const timestamp = epochUs(timestampUs);
  if (timestamp === null) return null;
  const tUs = anchor.monoUs + (timestamp - anchor.epochMs * 1000);
  if (!Number.isSafeInteger(tUs) || tUs < 0) return null;
  return validationMessageSchema.parse({ code, ts: tUs, hint: validationText(code, hint) });
}

export function validationText(code: number, hint: string): string {
  const trimmed = typeof hint === 'string' ? hint.trim() : '';
  if (trimmed.length > 0) return truncate(trimmed);
  return VALIDATION_COPY[code] ?? 'Measuring.';
}

export function sdkErrorMessage(code: number, detail: string): string {
  const copy = SDK_ERROR_COPY[code];
  if (copy) return copy;
  const trimmed = typeof detail === 'string' ? truncate(detail.trim()) : '';
  return trimmed.length > 0
    ? `${trimmed} (sensing code ${code})`
    : `Sensing stopped unexpectedly (code ${code}).`;
}

function pulseSeries(payload: unknown): unknown[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const cardio = (payload as { cardio?: unknown }).cardio;
  if (typeof cardio !== 'object' || cardio === null) return null;
  const series = (cardio as { pulseRate?: unknown }).pulseRate;
  if (!Array.isArray(series) || series.length === 0) return null;
  return series;
}

/** protobufjs hands int64 back as a Long, so accept a number or anything with toNumber(). */
function epochUs(value: unknown): number | null {
  if (typeof value === 'number') return isEpochUs(value) ? value : null;
  if (typeof value === 'object' && value !== null) {
    const toNumber = (value as { toNumber?: unknown }).toNumber;
    if (typeof toNumber === 'function') {
      const converted = (toNumber as () => unknown).call(value);
      if (typeof converted === 'number' && isEpochUs(converted)) return converted;
    }
  }
  return null;
}

function isEpochUs(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function truncate(text: string): string {
  return text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH - 1)}…` : text;
}
