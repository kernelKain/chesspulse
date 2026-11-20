import { useState } from 'react';

function consentNote(granted: boolean, cameraAllowed: boolean): string {
  if (!granted) return 'The camera stays off until you consent.';
  if (!cameraAllowed) {
    return 'Consent is on. This page is not a local file, so the camera stays blocked.';
  }
  return 'The camera is allowed for this window. Sensing has not started.';
}

export function App() {
  const [granted, setGranted] = useState(false);
  const [note, setNote] = useState(consentNote(false, false));

  async function onConsent(): Promise<void> {
    const bridge = window.chesspulse;
    if (!bridge) {
      setNote('This page is open outside the ChessPulse window. The camera stays off.');
      return;
    }
    try {
      const next = await bridge.setConsent(!granted);
      setGranted(next.granted);
      setNote(consentNote(next.granted, next.cameraAllowed));
    } catch {
      setNote('Consent could not be saved. The camera state is unchanged.');
    }
  }

  return (
    <main>
      <p className="label">ChessPulse</p>
      <h1>Sensing has not started.</h1>
      <p aria-live="polite">{note}</p>
      <button type="button" aria-pressed={granted} onClick={() => void onConsent()}>
        {granted ? 'Revoke camera consent' : 'Allow the camera'}
      </button>
    </main>
  );
}
