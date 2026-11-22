// What: the one table of channels that cross the main/renderer boundary, with their input schema.
// Why: a channel registered by name alone can drift from its payload; both directions read this file.
// Removed: a new channel could skip validation, or the preload and main could disagree on a name.
import { z } from 'zod';
import {
  coachGapRequestSchema,
  consentRequestSchema,
  emptyRequestSchema,
  insightCancelRequestSchema,
  insightRequestSchema,
  pgnValidateRequestSchema,
  reportBuildRequestSchema,
  reportCancelRequestSchema,
  reportExportRequestSchema,
  sessionDeleteRequestSchema,
  sessionOpenRequestSchema,
  sessionStartRequestSchema,
  sessionStopRequestSchema,
} from './contracts.js';
import { AppError, type AppErrorCode } from './errors.js';

export interface InvokeChannelEntry {
  readonly name: `cp:${string}`;
  readonly request: z.ZodType;
  /** The code used when a handler fails for a reason it did not classify. */
  readonly fallback: AppErrorCode;
  /** A caller may omit the payload and mean an empty object (the stop channel). */
  readonly absentAsEmpty: boolean;
}

export const INVOKE_CHANNELS = {
  appStateGet: {
    name: 'cp:app:state',
    request: emptyRequestSchema,
    fallback: 'internal',
    absentAsEmpty: true,
  },
  setupStatus: {
    name: 'cp:setup:status',
    request: emptyRequestSchema,
    fallback: 'internal',
    absentAsEmpty: true,
  },
  previewStart: {
    name: 'cp:preview:start',
    request: emptyRequestSchema,
    fallback: 'camera_unavailable',
    absentAsEmpty: true,
  },
  previewStop: {
    name: 'cp:preview:stop',
    request: emptyRequestSchema,
    fallback: 'internal',
    absentAsEmpty: true,
  },
  consentSet: {
    name: 'cp:consent:set',
    request: consentRequestSchema,
    fallback: 'internal',
    absentAsEmpty: false,
  },
  sessionStart: {
    name: 'cp:session:start',
    request: sessionStartRequestSchema,
    fallback: 'internal',
    absentAsEmpty: false,
  },
  sessionStop: {
    name: 'cp:session:stop',
    request: sessionStopRequestSchema,
    fallback: 'session_failed',
    absentAsEmpty: true,
  },
  coachGap: {
    name: 'cp:coach:gap',
    request: coachGapRequestSchema,
    fallback: 'session_failed',
    absentAsEmpty: false,
  },
  pasteValidate: {
    name: 'cp:pgn:validate',
    request: pgnValidateRequestSchema,
    fallback: 'pgn_invalid',
    absentAsEmpty: false,
  },
  reportBuild: {
    name: 'cp:report:build',
    request: reportBuildRequestSchema,
    fallback: 'report_failed',
    absentAsEmpty: false,
  },
  reportCancel: {
    name: 'cp:report:cancel',
    request: reportCancelRequestSchema,
    fallback: 'internal',
    absentAsEmpty: false,
  },
  insightRequest: {
    name: 'cp:insight:request',
    request: insightRequestSchema,
    fallback: 'internal',
    absentAsEmpty: false,
  },
  insightCancel: {
    name: 'cp:insight:cancel',
    request: insightCancelRequestSchema,
    fallback: 'internal',
    absentAsEmpty: false,
  },
  diagnosticsCopy: {
    name: 'cp:diagnostics:copy',
    request: emptyRequestSchema,
    fallback: 'internal',
    absentAsEmpty: true,
  },
  sessionDelete: {
    name: 'cp:session:delete',
    request: sessionDeleteRequestSchema,
    fallback: 'internal',
    absentAsEmpty: false,
  },
  sessionsList: {
    name: 'cp:sessions:list',
    request: emptyRequestSchema,
    fallback: 'internal',
    absentAsEmpty: true,
  },
  sessionOpen: {
    name: 'cp:session:open',
    request: sessionOpenRequestSchema,
    fallback: 'internal',
    absentAsEmpty: false,
  },
  reportExport: {
    name: 'cp:report:export',
    request: reportExportRequestSchema,
    fallback: 'report_failed',
    absentAsEmpty: false,
  },
} as const satisfies Record<string, InvokeChannelEntry>;

/** Events are main to renderer only; they carry no request schema. */
export const EVENT_CHANNELS = {
  samples: 'cp:sample:batch',
  validation: 'cp:validation',
  sdkError: 'cp:sdk:error',
  preview: 'cp:preview',
  coachMessage: 'cp:coach:message',
  sessionStarted: 'cp:session:started',
  sessionEnded: 'cp:session:ended',
  reportProgress: 'cp:report:progress',
} as const;

export type InvokeChannelKey = keyof typeof INVOKE_CHANNELS;
export type InvokeChannelName = (typeof INVOKE_CHANNELS)[InvokeChannelKey]['name'];
export type EventChannelName = (typeof EVENT_CHANNELS)[keyof typeof EVENT_CHANNELS];
export type InvokePayload<K extends InvokeChannelKey> =
  (typeof INVOKE_CHANNELS)[K]['request'] extends z.ZodType<infer T> ? T : never;

/** The only place an invoke payload is parsed. A rejected payload never reaches a handler. */
export function parseInvokePayload<K extends InvokeChannelKey>(key: K, payload: unknown): InvokePayload<K> {
  const entry = INVOKE_CHANNELS[key];
  const input = payload === undefined && entry.absentAsEmpty ? {} : payload;
  const parsed = entry.request.safeParse(input);
  if (!parsed.success) throw new AppError('invalid_request');
  return parsed.data as InvokePayload<K>;
}
