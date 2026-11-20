// What: the typed surface the page may call across the preload.
// Why: the renderer has no Node, and the main process checks every argument again.
// Removed: a screen could not tell the desktop process that consent or the session changed.
import type { SessionMeta } from '../shared/contracts';

export interface ConsentState {
  granted: boolean;
  cameraAllowed: boolean;
}

export interface ChessPulseBridge {
  setConsent(granted: boolean): Promise<ConsentState>;
  startSession(timeControl: string): Promise<{ sessionId: string }>;
  stopSession(): Promise<SessionMeta>;
}

declare global {
  interface Window {
    chesspulse?: ChessPulseBridge;
  }
}
