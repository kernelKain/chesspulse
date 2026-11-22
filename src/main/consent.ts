// What: stores the explicit consent flag and answers the page on one channel.
// Why: the camera permission handler reads this flag, and the page cannot set it by any other path.
// Removed: revoking consent would not reach the process that grants the camera.
import { consentStateSchema } from '../shared/contracts.js';
import { registerInvokeChannel } from './ipc-registry.js';
import { grantsMediaPermission } from './permission.js';

let consentGranted = false;

export function currentConsent(): boolean {
  return consentGranted;
}

export interface ConsentHooks {
  /** Called after consent is withdrawn, so the process holding the camera can let go. */
  onRevoked?: () => void;
}

export interface ConsentOptions {
  appFileUrl: string;
  devOrigin?: string;
}

export function registerConsentHandler(options: ConsentOptions, hooks: ConsentHooks = {}): void {
  registerInvokeChannel('consentSet', (event, payload) => {
    const wasGranted = consentGranted;
    consentGranted = payload.granted;
    if (wasGranted && !consentGranted) {
      try {
        hooks.onRevoked?.();
      } catch {
        // The flag is already off; the page cannot re-open the camera through this path.
      }
    }
    return consentStateSchema.parse({
      granted: consentGranted,
      cameraAllowed: grantsMediaPermission({
        permission: 'media',
        requestingUrl: event.senderFrame?.url,
        appFileUrl: options.appFileUrl,
        devOrigin: options.devOrigin,
        consentGranted,
        isMainFrame: true,
        mediaTypes: ['video'],
      }),
    });
  });
}
