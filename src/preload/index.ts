// What: the isolated preload. It exposes consent and session calls, and nothing else.
// Why: the page must not receive Node, files, or keys, and main checks every payload again.
// Removed: a later screen could not start or stop a session.
import { contextBridge, ipcRenderer } from 'electron';
import { EVENT_CHANNELS, INVOKE_CHANNELS } from '../shared/channels.js';
import { AppError, deserializeAppError, serializeAppError } from '../shared/errors.js';

/** Preload-side argument checks are programming errors, but they still leave as a typed code. */
function rejectInvalidRequest(): Promise<never> {
  return Promise.reject(new Error(serializeAppError(new AppError('invalid_request'))));
}

/**
 * Every rejection leaves this process as a typed code in the message.
 * contextBridge drops custom Error fields, so a code marker is the only transport that survives.
 */
async function invoke(channel: string, payload: unknown): Promise<unknown> {
  try {
    return await ipcRenderer.invoke(channel, payload);
  } catch (error) {
    const detail = error instanceof Error ? error.message : error;
    const appError = deserializeAppError(detail) ?? new AppError('internal', { cause: error });
    throw new Error(serializeAppError(appError));
  }
}

interface ConsentState {
  granted: boolean;
  cameraAllowed: boolean;
}

interface ValidationMessage {
  code: number;
  ts: number;
  hint: string;
}

interface SdkError {
  code: number;
  message: string;
  retryable: boolean;
}

interface PreviewFrame {
  width: number;
  height: number;
  light: number;
  rgba: Uint8Array;
}

interface CoachMessage {
  baselineBpm: number;
  recentBpm: number;
  deltaBpm: number;
  text: string;
}

interface SessionEnded {
  sessionId: string;
  reason: 'storage' | 'limit';
  message: string;
}

interface ReportProgress {
  sessionId: string;
  scored: number;
  total: number;
}

function readConsentState(value: unknown): ConsentState {
  if (typeof value !== 'object' || value === null) {
    throw new Error('The window returned an unexpected consent state.');
  }
  const record = value as { granted?: unknown; cameraAllowed?: unknown };
  if (typeof record.granted !== 'boolean' || typeof record.cameraAllowed !== 'boolean') {
    throw new Error('The window returned an unexpected consent state.');
  }
  return { granted: record.granted, cameraAllowed: record.cameraAllowed };
}

contextBridge.exposeInMainWorld('chesspulse', {
  setConsent(granted: unknown): Promise<ConsentState> {
    if (typeof granted !== 'boolean') {
      return rejectInvalidRequest();
    }
    return invoke(INVOKE_CHANNELS.consentSet.name, { granted }).then(readConsentState);
  },
  startSession(timeControl: unknown): Promise<{ sessionId: string }> {
    if (typeof timeControl !== 'string') {
      return rejectInvalidRequest();
    }
    return invoke(INVOKE_CHANNELS.sessionStart.name, { timeControl }).then((value: unknown) => {
      if (typeof value !== 'object' || value === null || !('sessionId' in value) || typeof value.sessionId !== 'string') {
        throw new Error('The window returned an unexpected session.');
      }
      return { sessionId: value.sessionId };
    });
  },
  stopSession(): Promise<{ id: string }> {
    return invoke(INVOKE_CHANNELS.sessionStop.name, {}).then((value: unknown) => {
      if (
        typeof value !== 'object' ||
        value === null ||
        !('id' in value) ||
        typeof value.id !== 'string' ||
        !('schemaVersion' in value) ||
        value.schemaVersion !== 1
      ) {
        throw new Error('The window returned an unexpected session.');
      }
      return value as { id: string };
    });
  },
  onSamples(listener: (samples: unknown) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown): void => {
      try {
        listener(readBatch(value));
      } catch {
        // A bad batch is dropped. The stored trace is unchanged.
      }
    };
    ipcRenderer.on(EVENT_CHANNELS.samples, handler);
    return () => {
      ipcRenderer.removeListener(EVENT_CHANNELS.samples, handler);
    };
  },
  onValidation(listener: (message: ValidationMessage) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown): void => {
      try {
        listener(readValidation(value));
      } catch {
        // A bad hint is dropped. The strip keeps its own state.
      }
    };
    ipcRenderer.on(EVENT_CHANNELS.validation, handler);
    return () => {
      ipcRenderer.removeListener(EVENT_CHANNELS.validation, handler);
    };
  },
  onSdkError(listener: (error: SdkError) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown): void => {
      try {
        listener(readSdkError(value));
      } catch {
        // A bad error is dropped. The session controls still work.
      }
    };
    ipcRenderer.on(EVENT_CHANNELS.sdkError, handler);
    return () => {
      ipcRenderer.removeListener(EVENT_CHANNELS.sdkError, handler);
    };
  },
  onPreview(listener: (frame: PreviewFrame) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown): void => {
      try {
        listener(readPreview(value));
      } catch {
        // A bad frame is dropped. The next one is a fresh copy.
      }
    };
    ipcRenderer.on(EVENT_CHANNELS.preview, handler);
    return () => {
      ipcRenderer.removeListener(EVENT_CHANNELS.preview, handler);
    };
  },
  setBetweenGames(active: unknown): Promise<{ betweenGames: boolean }> {
    if (typeof active !== 'boolean') {
      return rejectInvalidRequest();
    }
    return invoke(INVOKE_CHANNELS.coachGap.name, { betweenGames: active }).then((value: unknown) => {
      if (
        typeof value !== 'object' ||
        value === null ||
        !('betweenGames' in value) ||
        typeof value.betweenGames !== 'boolean'
      ) {
        throw new Error('The window returned an unexpected game boundary.');
      }
      return { betweenGames: value.betweenGames };
    });
  },
  onCoachMessage(listener: (message: CoachMessage) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown): void => {
      try {
        listener(readCoachMessage(value));
      } catch {
        // A malformed message is dropped; no number from it reaches the page.
      }
    };
    ipcRenderer.on(EVENT_CHANNELS.coachMessage, handler);
    return () => {
      ipcRenderer.removeListener(EVENT_CHANNELS.coachMessage, handler);
    };
  },
  onSessionEnded(listener: (event: SessionEnded) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown): void => {
      try {
        listener(readSessionEnded(value));
      } catch {
        // A malformed terminal event is dropped; the session controls remain usable.
      }
    };
    ipcRenderer.on(EVENT_CHANNELS.sessionEnded, handler);
    return () => {
      ipcRenderer.removeListener(EVENT_CHANNELS.sessionEnded, handler);
    };
  },
  onReportProgress(listener: (progress: ReportProgress) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown): void => {
      try {
        listener(readReportProgress(value));
      } catch {
        // A malformed progress event is dropped. The build still resolves or rejects.
      }
    };
    ipcRenderer.on(EVENT_CHANNELS.reportProgress, handler);
    return () => {
      ipcRenderer.removeListener(EVENT_CHANNELS.reportProgress, handler);
    };
  },
  requestInsight(request: unknown): Promise<unknown> {
    if (typeof request !== 'object' || request === null) {
      return rejectInvalidRequest();
    }
    const value = request as { sessionId?: unknown; provider?: unknown; text?: unknown };
    if (
      typeof value.sessionId !== 'string' ||
      typeof value.provider !== 'string' ||
      typeof value.text !== 'string'
    ) {
      return rejectInvalidRequest();
    }
    return invoke(INVOKE_CHANNELS.insightRequest.name, request).then((result: unknown) => {
      if (typeof result !== 'object' || result === null || !('disabled' in result) || typeof result.disabled !== 'boolean') {
        throw new Error('The window returned an unexpected AI reading.');
      }
      return result;
    });
  },
  cancelInsight(sessionId: unknown): Promise<{ cancelled: boolean }> {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return rejectInvalidRequest();
    }
    return invoke(INVOKE_CHANNELS.insightCancel.name, { sessionId }).then((value: unknown) => {
      if (typeof value !== 'object' || value === null || !('cancelled' in value) || typeof value.cancelled !== 'boolean') {
        throw new Error('The window returned an unexpected cancellation.');
      }
      return { cancelled: value.cancelled };
    });
  },
  validatePgns(slots: unknown): Promise<unknown> {
    if (!Array.isArray(slots) || !slots.every((item) => typeof item === 'string')) {
      return rejectInvalidRequest();
    }
    return invoke(INVOKE_CHANNELS.pasteValidate.name, { slots }).then((value: unknown) => {
      if (typeof value !== 'object' || value === null || !('state' in value) || !('slots' in value)) {
        throw new Error('The window returned an unexpected paste validation.');
      }
      return value;
    });
  },
  buildReport(sessionId: unknown, pgns: unknown): Promise<unknown> {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return rejectInvalidRequest();
    }
    if (!Array.isArray(pgns) || !pgns.every((item) => typeof item === 'string')) {
      return rejectInvalidRequest();
    }
    return invoke(INVOKE_CHANNELS.reportBuild.name, { sessionId, pgns }).then((value: unknown) => {
      if (typeof value !== 'object' || value === null || !('ok' in value) || typeof value.ok !== 'boolean') {
        throw new Error('The window returned an unexpected report.');
      }
      return value;
    });
  },
  cancelReport(sessionId: unknown): Promise<{ cancelled: boolean }> {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return rejectInvalidRequest();
    }
    return invoke(INVOKE_CHANNELS.reportCancel.name, { sessionId }).then((value: unknown) => {
      if (typeof value !== 'object' || value === null || !('cancelled' in value) || typeof value.cancelled !== 'boolean') {
        throw new Error('The window returned an unexpected cancellation.');
      }
      return { cancelled: value.cancelled };
    });
  },
  copyDiagnostics(): Promise<{ copied: true }> {
    return invoke(INVOKE_CHANNELS.diagnosticsCopy.name, {}).then((value: unknown) => {
      if (typeof value !== 'object' || value === null || !('copied' in value) || value.copied !== true) {
        throw new Error('The window returned an unexpected diagnostics result.');
      }
      return { copied: true };
    });
  },
  deleteSession(sessionId: unknown): Promise<{ deleted: boolean }> {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return rejectInvalidRequest();
    }
    return invoke(INVOKE_CHANNELS.sessionDelete.name, { sessionId }).then((value: unknown) => {
      if (typeof value !== 'object' || value === null || !('deleted' in value) || typeof value.deleted !== 'boolean') {
        throw new Error('The window returned an unexpected deletion result.');
      }
      return { deleted: value.deleted };
    });
  },
  exportReport(
    sessionId: unknown,
  ): Promise<{ exported: false } | { exported: true; path: string }> {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return rejectInvalidRequest();
    }
    return invoke(INVOKE_CHANNELS.reportExport.name, { sessionId }).then((value: unknown) => {
      if (typeof value !== 'object' || value === null || !('exported' in value) || typeof value.exported !== 'boolean') {
        throw new Error('The window returned an unexpected export result.');
      }
      if (value.exported === false) return { exported: false };
      if (!('path' in value) || typeof value.path !== 'string' || value.path.length === 0) {
        throw new Error('The window returned an unexpected export result.');
      }
      return { exported: true, path: value.path };
    });
  },
});

function readBatch(value: unknown): Array<{ tUs: number; bpm: number; confidence: number; stable: boolean }> {
  if (!Array.isArray(value)) throw new Error('The window returned an unexpected sample.');
  return value.map((item) => {
    if (typeof item !== 'object' || item === null) throw new Error('The window returned an unexpected sample.');
    const record = item as { tUs?: unknown; bpm?: unknown; confidence?: unknown; stable?: unknown };
    if (
      typeof record.tUs !== 'number' ||
      typeof record.bpm !== 'number' ||
      typeof record.confidence !== 'number' ||
      typeof record.stable !== 'boolean'
    ) {
      throw new Error('The window returned an unexpected sample.');
    }
    return { tUs: record.tUs, bpm: record.bpm, confidence: record.confidence, stable: record.stable };
  });
}

function readValidation(value: unknown): ValidationMessage {
  if (typeof value !== 'object' || value === null) {
    throw new Error('The window returned an unexpected sensing hint.');
  }
  const record = value as { code?: unknown; ts?: unknown; hint?: unknown };
  if (typeof record.code !== 'number' || typeof record.ts !== 'number' || typeof record.hint !== 'string') {
    throw new Error('The window returned an unexpected sensing hint.');
  }
  return { code: record.code, ts: record.ts, hint: record.hint };
}

function readPreview(value: unknown): PreviewFrame {
  if (typeof value !== 'object' || value === null) {
    throw new Error('The window returned an unexpected camera frame.');
  }
  const record = value as { width?: unknown; height?: unknown; light?: unknown; rgba?: unknown };
  if (
    typeof record.width !== 'number' ||
    typeof record.height !== 'number' ||
    typeof record.light !== 'number' ||
    !(record.rgba instanceof Uint8Array) ||
    record.rgba.byteLength !== record.width * record.height * 4
  ) {
    throw new Error('The window returned an unexpected camera frame.');
  }
  return { width: record.width, height: record.height, light: record.light, rgba: record.rgba };
}

function readCoachMessage(value: unknown): CoachMessage {
  if (typeof value !== 'object' || value === null) {
    throw new Error('The window returned an unexpected coach line.');
  }
  const record = value as { baselineBpm?: unknown; recentBpm?: unknown; deltaBpm?: unknown; text?: unknown };
  if (
    typeof record.baselineBpm !== 'number' ||
    typeof record.recentBpm !== 'number' ||
    typeof record.deltaBpm !== 'number' ||
    typeof record.text !== 'string'
  ) {
    throw new Error('The window returned an unexpected coach line.');
  }
  return {
    baselineBpm: record.baselineBpm,
    recentBpm: record.recentBpm,
    deltaBpm: record.deltaBpm,
    text: record.text,
  };
}

function readSessionEnded(value: unknown): SessionEnded {  if (typeof value !== 'object' || value === null) {
    throw new Error('The window returned an unexpected session end.');
  }
  const record = value as { sessionId?: unknown; reason?: unknown; message?: unknown };
  if (
    typeof record.sessionId !== 'string' ||
    (record.reason !== 'storage' && record.reason !== 'limit') ||
    typeof record.message !== 'string'
  ) {
    throw new Error('The window returned an unexpected session end.');
  }
  return { sessionId: record.sessionId, reason: record.reason, message: record.message };
}

function readReportProgress(value: unknown): ReportProgress {
  if (typeof value !== 'object' || value === null) {
    throw new Error('The window returned unexpected report progress.');
  }
  const record = value as { sessionId?: unknown; scored?: unknown; total?: unknown };
  if (
    typeof record.sessionId !== 'string' ||
    typeof record.scored !== 'number' ||
    typeof record.total !== 'number'
  ) {
    throw new Error('The window returned unexpected report progress.');
  }
  return { sessionId: record.sessionId, scored: record.scored, total: record.total };
}

function readSdkError(value: unknown): SdkError {
  if (typeof value !== 'object' || value === null) {
    throw new Error('The window returned an unexpected sensing error.');
  }
  const record = value as { code?: unknown; message?: unknown; retryable?: unknown };
  if (
    typeof record.code !== 'number' ||
    typeof record.message !== 'string' ||
    typeof record.retryable !== 'boolean'
  ) {
    throw new Error('The window returned an unexpected sensing error.');
  }
  return { code: record.code, message: record.message, retryable: record.retryable };
}
