// What: the isolated preload. It exposes consent and session calls, and nothing else.
// Why: the page must not receive Node, files, or keys, and main checks every payload again.
// Removed: a later screen could not start or stop a session.
import { contextBridge, ipcRenderer } from 'electron';

const CONSENT_CHANNEL = 'cp:consent:set';
const SESSION_START_CHANNEL = 'cp:session:start';
const SESSION_STOP_CHANNEL = 'cp:session:stop';
const SAMPLE_CHANNEL = 'cp:sample:batch';
const VALIDATION_CHANNEL = 'cp:validation';
const SDK_ERROR_CHANNEL = 'cp:sdk:error';
const PREVIEW_CHANNEL = 'cp:preview';
const PASTE_VALIDATE_CHANNEL = 'cp:pgn:validate';
const REPORT_BUILD_CHANNEL = 'cp:report:build';

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
      return Promise.reject(new Error('Consent was not a yes or no.'));
    }
    return ipcRenderer.invoke(CONSENT_CHANNEL, { granted }).then(readConsentState);
  },
  startSession(timeControl: unknown): Promise<{ sessionId: string }> {
    if (typeof timeControl !== 'string') {
      return Promise.reject(new Error('Choose a time control before starting.'));
    }
    return ipcRenderer.invoke(SESSION_START_CHANNEL, { timeControl }).then((value: unknown) => {
      if (typeof value !== 'object' || value === null || !('sessionId' in value) || typeof value.sessionId !== 'string') {
        throw new Error('The window returned an unexpected session.');
      }
      return { sessionId: value.sessionId };
    });
  },
  stopSession(): Promise<{ id: string }> {
    return ipcRenderer.invoke(SESSION_STOP_CHANNEL, {}).then((value: unknown) => {
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
    ipcRenderer.on(SAMPLE_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(SAMPLE_CHANNEL, handler);
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
    ipcRenderer.on(VALIDATION_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(VALIDATION_CHANNEL, handler);
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
    ipcRenderer.on(SDK_ERROR_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(SDK_ERROR_CHANNEL, handler);
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
    ipcRenderer.on(PREVIEW_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(PREVIEW_CHANNEL, handler);
    };
  },
  validatePgns(slots: unknown): Promise<unknown> {
    if (!Array.isArray(slots) || !slots.every((item) => typeof item === 'string')) {
      return Promise.reject(new Error('Paste entries must be text.'));
    }
    return ipcRenderer.invoke(PASTE_VALIDATE_CHANNEL, { slots }).then((value: unknown) => {
      if (typeof value !== 'object' || value === null || !('state' in value) || !('slots' in value)) {
        throw new Error('The window returned an unexpected paste validation.');
      }
      return value;
    });
  },
  buildReport(sessionId: unknown, pgns: unknown): Promise<unknown> {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return Promise.reject(new Error('No session is selected for this report.'));
    }
    if (!Array.isArray(pgns) || !pgns.every((item) => typeof item === 'string')) {
      return Promise.reject(new Error('Paste entries must be text.'));
    }
    return ipcRenderer.invoke(REPORT_BUILD_CHANNEL, { sessionId, pgns }).then((value: unknown) => {
      if (typeof value !== 'object' || value === null || !('ok' in value) || typeof value.ok !== 'boolean') {
        throw new Error('The window returned an unexpected report.');
      }
      return value;
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
