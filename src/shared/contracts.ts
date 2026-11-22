// What: runtime schemas for every value that crosses a trust boundary.
// Why: the blueprint rejects coerced or extra fields instead of guessing.
// Removed: invalid samples, games, and refusals would be accepted as real data.
import { z } from 'zod';

/** Session files are readable only by a writer that stamps this version. */
export const SCHEMA_VERSION = 1;

/** Reports change shape independently of session headers, so they carry their own version. */
export const REPORT_SCHEMA_VERSION = 1;

const monoUsSchema = z.number().finite().nonnegative();

export const pulseSampleSchema = z
  .object({
    tUs: monoUsSchema,
    bpm: z.number().finite(),
    confidence: z.number().finite().min(0).max(100),
    stable: z.boolean(),
  })
  .strict();

export const sessionAnchorSchema = z
  .object({
    monoUs: monoUsSchema,
    epochMs: z.number().finite(),
  })
  .strict();

export const stopReasonSchema = z.enum(['user', 'sdkError', 'storage', 'limit', 'crash']);
export const sessionEndReasonSchema = z.enum(['storage', 'limit']);

export const sessionMetaSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    id: z.string().min(1),
    startedAtEpochMs: z.number().finite(),
    startAnchor: sessionAnchorSchema,
    stopAnchor: sessionAnchorSchema.optional(),
    baselineBpm: z.number().finite().optional(),
    baselineWindow: z
      .object({
        fromUs: monoUsSchema,
        toUs: monoUsSchema,
      })
      .strict()
      .optional(),
    coverage: z
      .object({
        usableUs: monoUsSchema,
        totalUs: monoUsSchema,
        pct: z.number().finite().min(0).max(100),
        confidenceFloor: z.number().finite(),
      })
      .strict()
      .optional(),
    // Absent while the session is still open. A crash must not look like a chosen stop.
    stopReason: stopReasonSchema.optional(),
  })
  .strict();

export const endingSchema = z.enum([
  'checkmate',
  'resignation',
  'timeout',
  'abandoned',
  'aborted',
  'unknown',
]);

export const pgnMoveSchema = z
  .object({
    san: z.string().min(1),
    clockSec: z.number().finite().nonnegative().optional(),
  })
  .strict();

export const pgnGameSchema = z
  .object({
    index: z.number().int().nonnegative(),
    white: z.string(),
    black: z.string(),
    result: z.string(),
    endTimeEpochMs: z.number().finite().optional(),
    startTimeEpochMs: z.number().finite().optional(),
    timeControl: z.string().optional(),
    moves: z.array(pgnMoveSchema),
    ending: endingSchema,
    includeInStats: z.boolean(),
  })
  .strict();

export const alignmentModeSchema = z.enum(['endtime', 'starttime', 'inferred']);

export const alignedGameSchema = z
  .object({
    game: pgnGameSchema,
    startUs: monoUsSchema,
    endUs: monoUsSchema,
    alignment: z
      .object({
        mode: alignmentModeSchema,
        toleranceSec: z.number().finite().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const lowCoverageTraceSchema = z
  .object({
    startUs: monoUsSchema,
    stopUs: monoUsSchema,
    baselineBpm: z.number().finite().optional(),
    samples: z.array(pulseSampleSchema),
  })
  .strict();

export const refusalSchema = z
  .object({
    ok: z.literal(false),
    reason: z.enum(['low_coverage', 'order', 'no_trace', 'no_games', 'illegal_move', 'cancelled']),
    measured: z.number().finite().optional(),
    threshold: z.number().finite().optional(),
    remedy: z.string().min(1),
    trace: lowCoverageTraceSchema.optional(),
  })
  .strict();

export const timelineGameSchema = z
  .object({
    index: z.number().int().nonnegative(),
    white: z.string(),
    black: z.string(),
    result: z.string(),
    ending: endingSchema,
    includeInStats: z.boolean(),
    startUs: monoUsSchema,
    endUs: monoUsSchema,
  })
  .strict();

export const timelineMoveSchema = z
  .object({
    gameIndex: z.number().int().nonnegative(),
    moveIndex: z.number().int().nonnegative(),
    san: z.string().min(1),
    tUs: monoUsSchema.nullable(),
    cpl: z.number().finite().nonnegative().nullable(),
    thinkSec: z.number().finite().nonnegative().nullable(),
    blunder: z.boolean(),
    mate: z.boolean(),
    scored: z.boolean(),
    band: z.enum(['settled', 'elevated']).nullable(),
  })
  .strict();

export const timelineDataSchema = z
  .object({
    startUs: monoUsSchema,
    stopUs: monoUsSchema,
    baselineBpm: z.number().finite(),
    elevatedThresholdBpm: z.number().finite(),
    samples: z.array(pulseSampleSchema),
    games: z.array(timelineGameSchema),
    moves: z.array(timelineMoveSchema),
  })
  .strict();

export const reportGameSchema = z
  .object({
    index: z.number().int().nonnegative(),
    white: z.string(),
    black: z.string(),
    result: z.string(),
    ending: endingSchema,
    includeInStats: z.boolean(),
    moveCount: z.number().int().nonnegative(),
    blunders: z.number().int().nonnegative(),
    aligned: z.boolean(),
    timeControl: z.string().optional(),
  })
  .strict();

const bandSummarySchema = z.discriminatedUnion('status', [
  z
    .object({
      band: z.enum(['settled', 'elevated']),
      moves: z.number().int().nonnegative(),
      status: z.literal('insufficient'),
    })
    .strict(),
  z
    .object({
      band: z.enum(['settled', 'elevated']),
      moves: z.number().int().nonnegative(),
      status: z.literal('ok'),
      accuracy: z.number().finite(),
    })
    .strict(),
]);

/** A finished review. A refusal is a different object and never carries these fields. */
export const reportSchema = z
  .object({
    ok: z.literal(true),
    schemaVersion: z.literal(REPORT_SCHEMA_VERSION),
    sessionId: z.string().min(1),
    gamesDigest: z.string().regex(/^[0-9a-f]{64}$/),
    coveragePct: z.number().finite().min(0).max(100),
    baselineBpm: z.number().finite(),
    verdict: z.string().min(1),
    settled: bandSummarySchema,
    elevated: bandSummarySchema,
    engine: z
      .object({
        depth: z.number().int().positive(),
        positions: z.number().int().nonnegative(),
        scored: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        reasons: z
          .object({
            timeout: z.number().int().nonnegative(),
            crash: z.number().int().nonnegative(),
            engine: z.number().int().nonnegative(),
            budget: z.number().int().nonnegative(),
          })
          .strict(),
      })
      .strict(),
    alignmentMode: alignmentModeSchema,
    toleranceSec: z.number().finite().nonnegative(),
    banner: z.string().min(1).optional(),
    games: z.array(reportGameSchema),
    timeline: timelineDataSchema,
  })
  .strict();

export const reportResultSchema = z.discriminatedUnion('ok', [reportSchema, refusalSchema]);

/** A shared report omits the pulse trace and says so in the file. */
export const exportedReportSchema = reportSchema.extend({
  timeline: timelineDataSchema.omit({ samples: true }),
});

export const reportExportSchema = z
  .object({
    format: z.literal('chesspulse-report-export'),
    exportedAt: z.string().min(1),
    note: z.literal('This file contains no pulse samples.'),
    report: exportedReportSchema,
  })
  .strict();

export const aiProviderSchema = z.enum([
  'openai',
  'anthropic',
  'google',
  'opencode',
  'custom',
]);

/** IPC payloads. Names match the blueprint channel table. */
export const sessionStartRequestSchema = z
  .object({
    timeControl: z.string().min(1),
  })
  .strict();

export const sessionStartResultSchema = z
  .object({
    sessionId: z.string().min(1),
    startedAtEpochMs: z.number().finite(),
  })
  .strict();

export const emptyRequestSchema = z.object({}).strict();
export const sessionStopRequestSchema = emptyRequestSchema;

/** The diagnostics bundle is written to the clipboard in main; the page only learns it worked. */
export const diagnosticsResultSchema = z
  .object({
    copied: z.literal(true),
  })
  .strict();

export const sampleBatchSchema = z.array(pulseSampleSchema);

/** A preview frame: a small RGBA bitmap plus the brightness it was measured at. */
export const previewFrameSchema = z
  .object({
    width: z.number().int().min(2).max(1920),
    height: z.number().int().min(2).max(1080),
    light: z.number().finite().min(0).max(1),
    rgba: z.custom<Uint8Array>((value) => value instanceof Uint8Array, 'Expected RGBA bytes'),
  })
  .strict()
  .refine((frame) => frame.rgba.byteLength === frame.width * frame.height * 4, {
    message: 'The preview bytes do not match the frame size.',
    path: ['rgba'],
  });

export const validationMessageSchema = z
  .object({
    code: z.number().int(),
    ts: monoUsSchema,
    hint: z.string(),
  })
  .strict();

export const sdkErrorSchema = z
  .object({
    code: z.number().int(),
    message: z.string(),
    retryable: z.boolean(),
  })
  .strict();

/** An automatic stop that the page must show; manual and crash stops use the session header. */
export const sessionEndedSchema = z
  .object({
    sessionId: z.string().min(1),
    reason: sessionEndReasonSchema,
    message: z.string().min(1),
  })
  .strict();

/** Published once capture is open, so a reload during startup can still adopt the session. */
export const sessionStartedSchema = z
  .object({
    sessionId: z.string().min(1),
    startedAtEpochMs: z.number().finite(),
  })
  .strict();

/** A locally computed coach line. It carries no raw trace and no inferred health state. */
export const coachMessageSchema = z
  .object({
    baselineBpm: z.number().finite(),
    recentBpm: z.number().finite(),
    deltaBpm: z.number().finite().nonnegative(),
    text: z.string().min(1),
  })
  .strict();

/** The player alone marks this boundary; the app never infers that a live game has ended. */
export const coachGapRequestSchema = z
  .object({
    betweenGames: z.boolean(),
  })
  .strict();

const PASTE_BYTE_LIMIT = 2_000_000;

export const reportBuildRequestSchema = z
  .object({
    sessionId: z.string().min(1),
    pgns: z.array(z.string()).max(20),
  })
  .strict()
  .refine(
    (value) => new TextEncoder().encode(value.pgns.join('\n')).length <= PASTE_BYTE_LIMIT,
    { message: 'PGN paste exceeds 2 MB' },
  );

export const reportProgressSchema = z
  .object({
    sessionId: z.string().min(1),
    scored: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  })
  .strict();

export const reportCancelRequestSchema = z
  .object({
    sessionId: z.string().min(1),
  })
  .strict();

export const reportCancelResultSchema = z
  .object({
    cancelled: z.boolean(),
  })
  .strict();

export const reportExportRequestSchema = z
  .object({
    sessionId: z.string().min(1),
  })
  .strict();

export const reportExportResultSchema = z.discriminatedUnion('exported', [
  z
    .object({
      exported: z.literal(false),
    })
    .strict(),
  z
    .object({
      exported: z.literal(true),
      path: z.string().min(1),
    })
    .strict(),
]);

export const sessionDeleteRequestSchema = z
  .object({
    sessionId: z.string().min(1),
  })
  .strict();

export const sessionOpenRequestSchema = z
  .object({
    sessionId: z.string().min(1),
  })
  .strict();

export const sessionSummarySchema = z
  .object({
    id: z.string().min(1),
    startedAtEpochMs: z.number().finite(),
    durationMs: z.number().finite().nonnegative().nullable(),
    coveragePct: z.number().finite().min(0).max(100).nullable(),
    hasReport: z.boolean(),
  })
  .strict();

export const sessionListResultSchema = z
  .object({
    sessions: z.array(sessionSummarySchema),
    unreadable: z.number().int().nonnegative(),
  })
  .strict();

export const sessionReportErrorSchema = z.enum(['stale', 'newer', 'invalid']);

export const sessionOpenResultSchema = z
  .object({
    report: reportSchema.nullable(),
    reportError: sessionReportErrorSchema.nullable(),
    games: z.array(z.string()),
  })
  .strict();

export const sessionDeleteResultSchema = z
  .object({
    deleted: z.boolean(),
  })
  .strict();

export const insightRequestSchema = z
  .object({
    sessionId: z.string().min(1),
    provider: aiProviderSchema,
    text: z.string().min(1).max(4000).refine((text) => new TextEncoder().encode(text).length <= 4000),
  })
  .strict();

export const insightCancelRequestSchema = z
  .object({
    sessionId: z.string().min(1),
  })
  .strict();

export const insightDisabledSchema = z
  .object({
    disabled: z.literal(true),
    reason: z.string().min(1),
  })
  .strict();

/** Model output is untrusted narrative, never a computed report field. */
export const insightSchema = z
  .object({
    disabled: z.literal(false),
    provider: aiProviderSchema,
    text: z.string().min(1),
  })
  .strict();

export const insightResultSchema = z.discriminatedUnion('disabled', [insightSchema, insightDisabledSchema]);

/** Main-process consent. The page cannot open the camera by omitting this. */
export const consentRequestSchema = z
  .object({
    granted: z.boolean(),
  })
  .strict();

export const consentStateSchema = z
  .object({
    granted: z.boolean(),
    cameraAllowed: z.boolean(),
  })
  .strict();

/** What a reloaded page needs to rebuild its screen without asking the player to consent again. */
export const appSessionStateSchema = z
  .object({
    active: z.boolean(),
    sessionId: z.string().min(1).nullable(),
    startedAtEpochMs: z.number().finite().nullable(),
    betweenGames: z.boolean(),
    markedGames: z.number().int().nonnegative(),
  })
  .strict()
  .refine(
    (value) =>
      value.active
        ? value.sessionId !== null && value.startedAtEpochMs !== null
        : value.sessionId === null && value.startedAtEpochMs === null && value.markedGames === 0,
    { message: 'An active session has an id and start time; a closed one has neither and no marks.' },
  );

export const appStateSchema = z
  .object({
    consent: consentStateSchema,
    session: appSessionStateSchema,
  })
  .strict();

/** The doctor result Setup reuses; only the key row is shown before a session. */
export const doctorCheckSchema = z
  .object({
    id: z.enum(['node', 'env', 'sensing-key', 'camera', 'engine', 'data-dir', 'ai']),
    label: z.string().min(1),
    status: z.enum(['pass', 'warn', 'fail', 'skip']),
    detail: z.string().min(1),
  })
  .strict();

export const setupStatusSchema = z
  .object({
    checks: z.array(doctorCheckSchema),
  })
  .strict();

export const previewStartResultSchema = z
  .object({
    started: z.boolean(),
  })
  .strict();

export const previewStopResultSchema = z
  .object({
    stopped: z.boolean(),
  })
  .strict();

const IPC_PASTE_BYTE_LIMIT = 4_000_000;

export const pgnValidateRequestSchema = z
  .object({
    slots: z.array(z.string()).max(25),
  })
  .strict()
  .refine(
    (value) => new TextEncoder().encode(value.slots.join('\n')).length <= IPC_PASTE_BYTE_LIMIT,
    { message: 'PGN paste exceeds the IPC size limit.' },
  );

const pasteGameSummarySchema = z
  .object({
    white: z.string(),
    black: z.string(),
    result: z.string(),
    ending: endingSchema,
    moveCount: z.number().int().nonnegative(),
    hasClocks: z.boolean(),
    partialClocks: z.boolean(),
    includeInStats: z.boolean(),
    timeControl: z.string().optional(),
  })
  .strict();

export const pasteSlotSchema = z.discriminatedUnion('status', [
  z
    .object({
      slotIndex: z.number().int().nonnegative(),
      status: z.literal('empty'),
    })
    .strict(),
  z
    .object({
      slotIndex: z.number().int().nonnegative(),
      status: z.literal('valid'),
      game: pasteGameSummarySchema,
    })
    .strict(),
  z
    .object({
      slotIndex: z.number().int().nonnegative(),
      status: z.literal('order_error'),
      game: pasteGameSummarySchema,
      message: z.string().min(1),
    })
    .strict(),
  z
    .object({
      slotIndex: z.number().int().nonnegative(),
      status: z.literal('invalid'),
      message: z.string().min(1),
    })
    .strict(),
]);

export const pasteStateSchema = z.enum([
  'empty',
  'partial',
  'out_of_order',
  'clockless',
  'valid',
  'invalid',
]);

export const pasteValidationSchema = z
  .object({
    state: pasteStateSchema,
    order: z.enum(['none', 'checked', 'unverified', 'invalid']),
    clockless: z.boolean(),
    canBuild: z.boolean(),
    message: z.string().min(1),
    summary: z
      .object({
        total: z.number().int().nonnegative(),
        includedInStats: z.number().int().nonnegative(),
        aborted: z.number().int().nonnegative(),
        abandoned: z.number().int().nonnegative(),
      })
      .strict(),
    slots: z.array(pasteSlotSchema),
  })
  .strict();

export type ConsentState = z.infer<typeof consentStateSchema>;
export type AppSessionState = z.infer<typeof appSessionStateSchema>;
export type AppState = z.infer<typeof appStateSchema>;
export type DoctorCheck = z.infer<typeof doctorCheckSchema>;
export type SetupStatus = z.infer<typeof setupStatusSchema>;
export type PreviewStartResult = z.infer<typeof previewStartResultSchema>;
export type PreviewStopResult = z.infer<typeof previewStopResultSchema>;
export type PulseSample = z.infer<typeof pulseSampleSchema>;
export type SessionAnchor = z.infer<typeof sessionAnchorSchema>;
export type SessionMeta = z.infer<typeof sessionMetaSchema>;
export type PgnGame = z.infer<typeof pgnGameSchema>;
export type AlignedGame = z.infer<typeof alignedGameSchema>;
export type LowCoverageTrace = z.infer<typeof lowCoverageTraceSchema>;
export type Refusal = z.infer<typeof refusalSchema>;
export type TimelineGame = z.infer<typeof timelineGameSchema>;
export type TimelineMove = z.infer<typeof timelineMoveSchema>;
export type TimelineData = z.infer<typeof timelineDataSchema>;
export type ReportGame = z.infer<typeof reportGameSchema>;
export type Report = z.infer<typeof reportSchema>;
export type ReportResult = z.infer<typeof reportResultSchema>;
export type ReportExport = z.infer<typeof reportExportSchema>;
export type ReportProgress = z.infer<typeof reportProgressSchema>;
export type ReportExportResult = z.infer<typeof reportExportResultSchema>;
export type SessionDeleteResult = z.infer<typeof sessionDeleteResultSchema>;
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export type SessionListResult = z.infer<typeof sessionListResultSchema>;
export type SessionReportError = z.infer<typeof sessionReportErrorSchema>;
export type SessionOpenResult = z.infer<typeof sessionOpenResultSchema>;
export type PasteGameSummary = z.infer<typeof pasteGameSummarySchema>;
export type PasteSlot = z.infer<typeof pasteSlotSchema>;
export type PasteState = z.infer<typeof pasteStateSchema>;
export type PasteValidation = z.infer<typeof pasteValidationSchema>;
export type ValidationMessage = z.infer<typeof validationMessageSchema>;
export type SdkError = z.infer<typeof sdkErrorSchema>;
export type DiagnosticsResult = z.infer<typeof diagnosticsResultSchema>;
export type SessionEndReason = z.infer<typeof sessionEndReasonSchema>;
export type SessionEnded = z.infer<typeof sessionEndedSchema>;
export type SessionStarted = z.infer<typeof sessionStartedSchema>;
export type CoachMessage = z.infer<typeof coachMessageSchema>;
export type AiProvider = z.infer<typeof aiProviderSchema>;
export type InsightRequest = z.infer<typeof insightRequestSchema>;
export type Insight = z.infer<typeof insightSchema>;
export type InsightDisabled = z.infer<typeof insightDisabledSchema>;
export type InsightResult = z.infer<typeof insightResultSchema>;
export type PreviewFrame = z.infer<typeof previewFrameSchema>;
