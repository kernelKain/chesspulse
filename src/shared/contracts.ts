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

export const refusalSchema = z
  .object({
    ok: z.literal(false),
    reason: z.enum(['low_coverage', 'order', 'no_trace', 'no_games']),
    measured: z.number().finite().optional(),
    threshold: z.number().finite().optional(),
    remedy: z.string().min(1),
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
  })
  .strict();

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

export type PulseSample = z.infer<typeof pulseSampleSchema>;
export type SessionAnchor = z.infer<typeof sessionAnchorSchema>;
export type SessionMeta = z.infer<typeof sessionMetaSchema>;
export type PgnGame = z.infer<typeof pgnGameSchema>;
export type AlignedGame = z.infer<typeof alignedGameSchema>;
export type Refusal = z.infer<typeof refusalSchema>;
