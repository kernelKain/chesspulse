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
  // A finalized session whose automatic event still needs the page. A retry republishes this,
  // never finalizes again.
  let retained: { meta: SessionMeta; event: SessionEnded } | null = null;

  return {
    beginSession() {
      pendingReason = undefined;
      retained = null;
    },
    stop(reason) {
      if (inFlight) return inFlight;
      const run = (async () => {
        if (retained) {
          const { meta, event } = retained;
          seams.publish(event);
          retained = null;
          return meta;
        }
        const captureReason = await seams.stopCapture();
        const effectiveReason = captureReason ?? pendingReason ?? reason;
        if (effectiveReason === 'storage' || effectiveReason === 'limit') {
          pendingReason = effectiveReason;
        }
        const meta = await seams.stopSession(effectiveReason);
        pendingReason = undefined;
        if (effectiveReason === 'storage' || effectiveReason === 'limit') {
          const event = sessionEndedSchema.parse({
            sessionId: meta.id,
            reason: effectiveReason,
            message: SESSION_ENDED_COPY[effectiveReason],
          });
          // Retain until the page has actually received it; a throwing publish leaves this for retry.
          retained = { meta, event };
          seams.publish(event);
          retained = null;
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
