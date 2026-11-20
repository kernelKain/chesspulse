// What: the isolated preload. It exposes one consent call and nothing else.
// Why: the page must not receive Node, files, or keys, and main checks the payload again.
// Removed: a later screen could not tell the desktop process that consent changed.
import { contextBridge, ipcRenderer } from 'electron';

const CONSENT_CHANNEL = 'cp:consent:set';

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
});
