// What: runtime schemas for every value that crosses a trust boundary.
// Why: the blueprint rejects coerced or extra fields instead of guessing.
// Removed: invalid samples, games, and refusals would be accepted as real data.
import { z } from 'zod';

/** Session files are readable only by a writer that stamps this version. */
export const SCHEMA_VERSION = 1;

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

export const stopReasonSchema = z.enum(['user', 'sdkError', 'crash']);

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
    reason: z.enum(['low_coverage', 'order', 'no_trace', 'no_games']),
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
    sessionId: z.string().min(1),
    coveragePct: z.number().finite().min(0).max(100),
    baselineBpm: z.number().finite(),
    verdict: z.string().min(1),
    settled: bandSummarySchema,
    elevated: bandSummarySchema,
    alignmentMode: alignmentModeSchema,
    toleranceSec: z.number().finite().nonnegative(),
    banner: z.string().min(1).optional(),
    games: z.array(reportGameSchema),
    timeline: timelineDataSchema,
  })
  .strict();

export const reportResultSchema = z.discriminatedUnion('ok', [reportSchema, refusalSchema]);

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
  })
  .strict();

export const sessionStopRequestSchema = z.object({}).strict();

export const sampleBatchSchema = z.array(pulseSampleSchema);

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

export const insightRequestSchema = z
  .object({
    sessionId: z.string().min(1),
    provider: aiProviderSchema,
    text: z.string(),
  })
  .strict();

export const insightDisabledSchema = z
  .object({
    disabled: z.literal(true),
    reason: z.string().min(1),
  })
  .strict();

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
export type PasteGameSummary = z.infer<typeof pasteGameSummarySchema>;
export type PasteSlot = z.infer<typeof pasteSlotSchema>;
export type PasteState = z.infer<typeof pasteStateSchema>;
export type PasteValidation = z.infer<typeof pasteValidationSchema>;
