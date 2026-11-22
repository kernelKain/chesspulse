import {
  sessionEndedSchema,
  type SessionEndReason,
  type SessionEnded,
  type SessionMeta,
} from '../shared/contracts.js';
import type { SessionStopReason } from './session.js';

export interface SessionStopSeams {
  stopCapture(): Promise<SessionEndReason | undefined>;
  stopSession(reason: SessionStopReason): Promise<SessionMeta>;
  publish(event: SessionEnded): void;
}

export interface SessionStopper {
  beginSession(): void;
  stop(reason: SessionStopReason): Promise<SessionMeta>;
  active(): boolean;
}

const SESSION_ENDED_COPY: Record<SessionEndReason, string> = {
  storage: 'Sensing stopped because the pulse samples could not be saved. The session was closed.',
  limit: 'Sensing stopped at the 90-minute limit. The session was closed.',
};

// What: runs camera teardown, session finalization, and one automatic-ended publication as one operation.
// Why: concurrent user, SDK, storage, and limit stops must share one reason and one visible event.
// Removed: a second caller could finalize again or publish a different terminal reason.
export function createSessionStopper(seams: SessionStopSeams): SessionStopper {
  let inFlight: Promise<SessionMeta> | null = null;
  let pendingReason: SessionEndReason | undefined;

  return {
    beginSession() {
      pendingReason = undefined;
    },
    stop(reason) {
      if (inFlight) return inFlight;
      const run = (async () => {
        const captureReason = await seams.stopCapture();
        const effectiveReason = captureReason ?? pendingReason ?? reason;
        if (effectiveReason === 'storage' || effectiveReason === 'limit') {
          pendingReason = effectiveReason;
        }
        const meta = await seams.stopSession(effectiveReason);
        pendingReason = undefined;
        if (effectiveReason === 'storage' || effectiveReason === 'limit') {
          seams.publish(
            sessionEndedSchema.parse({
              sessionId: meta.id,
              reason: effectiveReason,
              message: SESSION_ENDED_COPY[effectiveReason],
            }),
          );
        }
        return meta;
      })();
      inFlight = run.finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    active() {
      return inFlight !== null;
    },
  };
}
