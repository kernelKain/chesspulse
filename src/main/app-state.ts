// What: assembles the one state a reloaded page asks for.
// Why: consent and an open session live in main, and the page must not guess either after a reload.
// Removed: the Start button would stay disabled while main still holds consent and the camera.
import { appStateSchema, type AppSessionState, type AppState, type ConsentState } from '../shared/contracts.js';

export interface AppStateSources {
  consent(): ConsentState;
  session(): AppSessionState;
}

/** Pure seam so the reload contract is tested without Electron or a camera. */
export function readAppState(sources: AppStateSources): AppState {
  return appStateSchema.parse({
    consent: sources.consent(),
    session: sources.session(),
  });
}
