// What: stores the explicit consent flag and answers the page on one channel.
// Why: the camera permission handler reads this flag, and the page cannot set it by any other path.
// Removed: revoking consent would not reach the process that grants the camera.
import { ipcMain } from 'electron';
import { consentRequestSchema, consentStateSchema } from '../shared/contracts.js';
import { grantsMediaPermission } from './permission.js';

const CONSENT_CHANNEL = 'cp:consent:set';

let consentGranted = false;

export function currentConsent(): boolean {
  return consentGranted;
}

export function registerConsentHandler(appFileUrl: string): void {
  ipcMain.handle(CONSENT_CHANNEL, (event, payload: unknown) => {
    const parsed = consentRequestSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Consent was not a yes or no.');
    consentGranted = parsed.data.granted;
    return consentStateSchema.parse({
      granted: consentGranted,
      cameraAllowed: grantsMediaPermission({
        permission: 'media',
        requestingUrl: event.senderFrame?.url,
        appFileUrl,
        consentGranted,
        isMainFrame: true,
        mediaTypes: ['video'],
      }),
    });
  });
}
