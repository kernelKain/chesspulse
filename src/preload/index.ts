// What: the isolated preload. It exposes consent and session calls, and nothing else.
// Why: the page must not receive Node, files, or keys, and main checks every payload again.
// Removed: a later screen could not start or stop a session.
import { contextBridge, ipcRenderer } from 'electron';

const CONSENT_CHANNEL = 'cp:consent:set';
const SESSION_START_CHANNEL = 'cp:session:start';
const SESSION_STOP_CHANNEL = 'cp:session:stop';

interface ConsentState {
  granted: boolean;
  cameraAllowed: boolean;
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
});
