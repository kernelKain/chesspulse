// What: one camera preview that can run before a session, serialized with its own start/stop calls.
// Why: Setup needs live framing without storing samples, and dev StrictMode can start/stop in quick succession.
// Removed: framing would have no live image, and two overlapping native starts could fight for the camera.
import type { CaptureEvents } from './capture.js';
import type { SessionAnchor } from '../shared/contracts.js';

export interface PreviewCapture {
  stop(): Promise<unknown>;
}

export interface PreviewStartInput {
  apiKey: string;
  anchor: SessionAnchor;
  events: CaptureEvents;
}

export type PreviewStarter = (input: PreviewStartInput) => PreviewCapture;

export interface PreviewController {
  start(input: PreviewStartInput, guard?: () => void): Promise<void>;
  stop(): Promise<void>;
  active(): boolean;
}

export function createPreviewController(start: PreviewStarter): PreviewController {
  let current: PreviewCapture | null = null;
  let stopping = 0;
  let queue: Promise<unknown> = Promise.resolve();

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = queue.then(operation, operation);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return {
    start(input, guard) {
      return enqueue(async () => {
        if (current) return;
        // The guard runs inside the queue, after any pending stop and immediately before capture.
        guard?.();
        // startCapture is synchronous; a throw leaves `current` null and the queue usable.
        current = start(input);
      });
    },
    stop() {
      return enqueue(async () => {
        const capture = current;
        current = null;
        if (!capture) return;
        stopping += 1;
        try {
          await capture.stop();
        } catch {
          // The controller has already forgotten it. The SDK's destroy path releases the handle.
        } finally {
          stopping -= 1;
        }
      });
    },
    active() {
      // A stop in flight still owns the camera, so quitting must wait for it.
      return current !== null || stopping > 0;
    },
  };
}
