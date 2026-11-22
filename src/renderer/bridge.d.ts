// What: the typed surface the page may call across the preload.
// Why: the renderer has no Node, and the main process checks every argument again.
// Removed: a screen could not tell the desktop process that consent or the session changed.
import type {
  SessionMarkView,
  AppState,
  CoachMessage,
  InsightConfig,
  InsightRequest,
  InsightResult,
  PasteValidation,
  PreviewFrame,
  PreviewStartResult,
  PreviewStopResult,
  PulseSample,
  ReportProgress,
  ReportResult,
  SdkError,
  SessionEnded,
  SessionListResult,
  SessionMeta,
  SessionOpenResult,
  SessionStarted,
  SetupStatus,
  ValidationMessage,
} from '../shared/contracts';

export interface ConsentState {
  granted: boolean;
  cameraAllowed: boolean;
}

export interface ChessPulseBridge {
  getAppState(): Promise<AppState>;
  getSetupStatus(): Promise<SetupStatus>;
  listSessions(): Promise<SessionListResult>;
  openSession(sessionId: string): Promise<SessionOpenResult>;
  startPreview(): Promise<PreviewStartResult>;
  stopPreview(): Promise<PreviewStopResult>;
  setConsent(granted: boolean): Promise<ConsentState>;
  startSession(timeControl: string): Promise<{ sessionId: string; startedAtEpochMs: number }>;
  stopSession(): Promise<SessionMeta>;
  onSamples(listener: (samples: PulseSample[]) => void): () => void;
  onValidation(listener: (message: ValidationMessage) => void): () => void;
  onSdkError(listener: (error: SdkError) => void): () => void;
  onPreview(listener: (frame: PreviewFrame) => void): () => void;
  setBetweenGames(active: boolean): Promise<{ betweenGames: boolean }>;
  onCoachMessage(listener: (message: CoachMessage) => void): () => void;
  onSessionEnded(listener: (event: SessionEnded) => void): () => void;
  onSessionStarted(listener: (event: SessionStarted) => void): () => void;
  requestInsight(request: InsightRequest): Promise<InsightResult>;
  cancelInsight(sessionId: string): Promise<{ cancelled: boolean }>;
  insightConfig(): Promise<InsightConfig>;
  validatePgns(slots: string[]): Promise<PasteValidation>;
  onReportProgress(listener: (progress: ReportProgress) => void): () => void;
  buildReport(
    sessionId: string,
    pgns: string[],
    gameEndMarks?: number[],
    playerName?: string,
  ): Promise<ReportResult>;
  sessionMarks(sessionId: string): Promise<{ marks: SessionMarkView[] }>;
  cancelReport(sessionId: string): Promise<{ cancelled: boolean }>;
  copyDiagnostics(): Promise<{ copied: true }>;
  deleteSession(sessionId: string): Promise<{ deleted: boolean }>;
  exportReport(sessionId: string): Promise<{ exported: false } | { exported: true; path: string }>;
}

declare global {
  interface Window {
    chesspulse?: ChessPulseBridge;
  }
}
