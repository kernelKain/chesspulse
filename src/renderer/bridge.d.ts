// What: the typed surface the page may call across the preload.
// Why: the renderer has no Node, and the main process checks every argument again.
// Removed: a screen could not tell the desktop process that consent or the session changed.
import type {
  CoachMessage,
  InsightRequest,
  InsightResult,
  PasteValidation,
  PreviewFrame,
  PulseSample,
  ReportResult,
  SdkError,
  SessionEnded,
  SessionMeta,
  ValidationMessage,
} from '../shared/contracts';

export interface ConsentState {
  granted: boolean;
  cameraAllowed: boolean;
}

export interface ChessPulseBridge {
  setConsent(granted: boolean): Promise<ConsentState>;
  startSession(timeControl: string): Promise<{ sessionId: string }>;
  stopSession(): Promise<SessionMeta>;
  onSamples(listener: (samples: PulseSample[]) => void): () => void;
  onValidation(listener: (message: ValidationMessage) => void): () => void;
  onSdkError(listener: (error: SdkError) => void): () => void;
  onPreview(listener: (frame: PreviewFrame) => void): () => void;
  setBetweenGames(active: boolean): Promise<{ betweenGames: boolean }>;
  onCoachMessage(listener: (message: CoachMessage) => void): () => void;
  onSessionEnded(listener: (event: SessionEnded) => void): () => void;
  requestInsight(request: InsightRequest): Promise<InsightResult>;
  cancelInsight(sessionId: string): Promise<{ cancelled: boolean }>;
  validatePgns(slots: string[]): Promise<PasteValidation>;
  buildReport(sessionId: string, pgns: string[]): Promise<ReportResult>;
}

declare global {
  interface Window {
    chesspulse?: ChessPulseBridge;
  }
}
